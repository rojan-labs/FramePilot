"""Project Brain store — open/create + typed reads/writes over ``brain.sqlite``.

WHY (plan B0.1): analysis was recomputed and discarded every session. The store
persists what the substrate learns, under the invariants in
:mod:`framepilot_engine.brain`: derived-and-rebuildable (never canonical),
single-writer (this sidecar process), sandbox-contained, provenance-tracked.

Design notes:

- **WAL mode** so the sidecar's request handlers can read while a write is in
  flight; the single-writer invariant means we never contend across processes.
- **Injectable clock** (``Clock``) so every timestamp-bearing write is
  deterministic under test — this is a 100%-coverage core module.
- **Canonical JSON** (sorted keys, compact separators) for every JSON column,
  so byte-level determinism holds end-to-end (the sidecar-export rebuild test
  in B0.3 depends on it).
- ``sqlite3`` is stdlib: no new dependency on either side of the process
  boundary (plan §2 ASK-items — resolved up front).
"""

from __future__ import annotations

import json
import logging
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from framepilot_engine.brain.embeddings import pack_vector, unpack_vector
from framepilot_engine.brain.fts import SupportsMarker, fts_match_expression
from framepilot_engine.brain.migrations import (
    BrainSchemaError,
    current_version,
    ensure_fts_tables,
    migrate,
)
from framepilot_engine.brain.models import (
    AnalysisResultRow,
    AssetRow,
    BrainStatus,
    EmbeddingRow,
    FieldChangeRow,
    FieldConflict,
    FieldRow,
    FrameRow,
    JobRow,
    JobState,
    Provenance,
    SearchHit,
    SearchHitType,
    TranscriptUtterance,
    VisualCaptionRow,
    VisualSpanRow,
    VisualVectorRow,
    WriteFieldResult,
)
from framepilot_engine.safety import PathTraversalError, resolve_within

_log = logging.getLogger(__name__)

__all__ = [
    "BrainError",
    "BrainSchemaError",
    "BrainStore",
    "brain_dir_for",
    "brain_status",
    "open_brain",
]

DERIVED_DIR_NAME = ".framepilot-derived"
BRAIN_FILENAME = "brain.sqlite"

# Returns the current UTC time; injected in tests for deterministic timestamps.
Clock = Callable[[], datetime]


class BrainError(Exception):
    """Base class for brain-store failures. Always carries an actionable message."""


def _default_clock() -> datetime:
    return datetime.now(UTC)


def _canonical_json(value: Any) -> str:
    """Serialize to canonical JSON: sorted keys, compact, unicode preserved."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def brain_dir_for(projects_root: Path, project_id: str) -> Path:
    """The sandbox-checked derived directory that owns a project's brain.

    ``project_id`` comes from callers (IPC/HTTP) and is untrusted: routing it
    through :func:`resolve_within` rejects traversal like ``../../etc``.
    """
    return resolve_within(projects_root, str(Path(DERIVED_DIR_NAME) / project_id))


class BrainStore:
    """Typed access to one project's ``brain.sqlite``.

    Construct via :func:`open_brain` (sandboxed path derivation) or
    :meth:`BrainStore.open` (explicit path, used by tests and the rebuild
    route). Usable as a context manager; :meth:`close` is idempotent.
    """

    def __init__(self, conn: sqlite3.Connection, db_path: Path, *, clock: Clock) -> None:
        self._conn = conn
        self._db_path = db_path
        self._clock = clock
        self._fts_available = ensure_fts_tables(conn)

    # -- lifecycle -------------------------------------------------------------

    @classmethod
    def open(cls, db_path: Path, *, clock: Clock | None = None) -> BrainStore:
        """Open (creating/migrating as needed) the brain database at ``db_path``.

        :raises BrainSchemaError: If the file was written by a newer engine.
        :raises BrainError: If SQLite cannot open/migrate the file.
        """
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(db_path)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA foreign_keys = ON")
            # Service routes run in a threadpool, so two requests can hold their own
            # connection to this file at once. WAL lets them read concurrently; a
            # second *writer* has to wait, and the default is to fail immediately
            # rather than wait at all. Five seconds turns a lost race into a pause.
            conn.execute("PRAGMA busy_timeout = 5000")
            migrate(conn)
        except BrainSchemaError:
            conn.close()
            raise
        except sqlite3.Error as exc:
            conn.close()
            raise BrainError(f"Failed to open brain database at {db_path}: {exc}") from exc
        return cls(conn, db_path, clock=clock or _default_clock)

    def close(self) -> None:
        """Close the underlying connection (idempotent)."""
        self._conn.close()

    def __enter__(self) -> BrainStore:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    @property
    def path(self) -> Path:
        """Filesystem path of the open ``brain.sqlite``."""
        return self._db_path

    @property
    def fts_available(self) -> bool:
        """Whether this runtime's SQLite build supports FTS5 (plan B0.5)."""
        return self._fts_available

    def _now(self) -> str:
        return self._clock().isoformat()

    # -- status ----------------------------------------------------------------

    def status(self) -> BrainStatus:
        """Health/capability report for ``GET /brain/status`` (plan B0.4)."""
        counts = {
            table: int(self._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in (
                "assets",
                "analysis_results",
                "fields",
                "field_changelog",
                "jobs",
                "frames",
                "embeddings",
            )
        }
        return BrainStatus(
            available=True,
            exists=True,
            path=str(self._db_path),
            schema_version=current_version(self._conn),
            fts5_available=self._fts_available,
            counts=counts,
        )

    # -- assets ------------------------------------------------------------------

    def upsert_asset(
        self,
        asset_id: str,
        *,
        path: str,
        content_sha256: str | None = None,
        probe: dict[str, Any] | None = None,
    ) -> AssetRow:
        """Insert or update an asset row, preserving ``created_at`` on update."""
        now = self._now()
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO assets (id, path, content_sha256, probe, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    path = excluded.path,
                    content_sha256 = excluded.content_sha256,
                    probe = excluded.probe,
                    updated_at = excluded.updated_at
                """,
                (
                    asset_id,
                    path,
                    content_sha256,
                    _canonical_json(probe) if probe is not None else None,
                    now,
                    now,
                ),
            )
        row = self.get_asset(asset_id)
        assert row is not None  # just written
        return row

    def get_asset(self, asset_id: str) -> AssetRow | None:
        """Fetch one asset row by id, or ``None``."""
        raw = self._conn.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        return _asset_from(raw) if raw is not None else None

    def list_assets(self) -> list[AssetRow]:
        """All asset rows, ordered by id for deterministic output."""
        rows = self._conn.execute("SELECT * FROM assets ORDER BY id").fetchall()
        return [_asset_from(r) for r in rows]

    def restore_asset(self, row: AssetRow) -> None:
        """Write an asset row verbatim (timestamps included) — sidecar import only."""
        with self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO assets VALUES (?, ?, ?, ?, ?, ?)",
                (
                    row.id,
                    row.path,
                    row.content_sha256,
                    _canonical_json(row.probe) if row.probe is not None else None,
                    row.created_at,
                    row.updated_at,
                ),
            )

    # -- analysis results --------------------------------------------------------

    def record_analysis(
        self,
        asset_id: str,
        *,
        kind: str,
        depth: str,
        params_hash: str,
        result: dict[str, Any],
        tool: str,
        source: Provenance = Provenance.MACHINE,
    ) -> AnalysisResultRow:
        """Persist (upsert) one analysis result; the cache key is the PK (B1.3)."""
        now = self._now()
        with self._conn:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO analysis_results
                    (asset_id, kind, depth, params_hash, result, source, tool, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (asset_id, kind, depth, params_hash, _canonical_json(result), source, tool, now),
            )
        return AnalysisResultRow(
            asset_id=asset_id,
            kind=kind,
            depth=depth,
            params_hash=params_hash,
            result=result,
            source=source,
            tool=tool,
            created_at=now,
        )

    def get_analysis(
        self, asset_id: str, *, kind: str, params_hash: str
    ) -> AnalysisResultRow | None:
        """Cache lookup for one analysis result (plan B1.3).

        ``params_hash`` already encodes the analyzer version, its effective
        parameters, and the source content hash (see
        :func:`framepilot_engine.analysis.tiers.analysis_params_hash`), so a
        hit here means "same analyzer, same params, same bytes" — safe to
        serve without re-running ffmpeg/whisper.
        """
        # depth is not part of the lookup: the same analyzer with the same
        # params over the same bytes computes the same result whichever tier
        # requested it. ORDER BY keeps a multi-tier duplicate deterministic.
        raw = self._conn.execute(
            "SELECT * FROM analysis_results"
            " WHERE asset_id = ? AND kind = ? AND params_hash = ?"
            " ORDER BY depth, created_at LIMIT 1",
            (asset_id, kind, params_hash),
        ).fetchone()
        return _analysis_from(raw) if raw is not None else None

    def list_analysis(
        self, asset_id: str | None = None, *, kind: str | None = None
    ) -> list[AnalysisResultRow]:
        """Analysis rows, optionally filtered, in deterministic key order."""
        clauses: list[str] = []
        params: list[str] = []
        if asset_id is not None:
            clauses.append("asset_id = ?")
            params.append(asset_id)
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._conn.execute(
            f"SELECT * FROM analysis_results {where} ORDER BY asset_id, kind, depth, params_hash",
            params,
        ).fetchall()
        return [_analysis_from(r) for r in rows]

    def restore_analysis(self, row: AnalysisResultRow) -> None:
        """Write an analysis row verbatim — sidecar import only."""
        with self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO analysis_results VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    row.asset_id,
                    row.kind,
                    row.depth,
                    row.params_hash,
                    _canonical_json(row.result),
                    row.source,
                    row.tool,
                    row.created_at,
                ),
            )

    # -- provenance-guarded fields (plan B0.2) -------------------------------------

    def write_field(
        self,
        entity_type: str,
        entity_id: str,
        field: str,
        value: Any,
        *,
        source: Provenance,
        actor: str,
    ) -> WriteFieldResult:
        """Write one field value under the human-wins provenance rule.

        A ``machine``/``model`` write over an existing ``human`` value is
        REFUSED and returned as a typed :class:`FieldConflict` — human input is
        never silently overwritten (davinci ``field_changelog`` rule). Every
        successful write appends to ``field_changelog``.
        """
        existing = self.get_field(entity_type, entity_id, field)
        if (
            existing is not None
            and existing.source is Provenance.HUMAN
            and source is not Provenance.HUMAN
        ):
            conflict = FieldConflict(
                entity_type=entity_type,
                entity_id=entity_id,
                field=field,
                existing_source=existing.source,
                attempted_source=source,
                message=(
                    f"Refusing to overwrite human-set {entity_type}.{field} on "
                    f"{entity_id!r} with a {source} value. Human values are only "
                    "replaced by explicit human edits."
                ),
            )
            _log.warning("%s", conflict.message)
            return WriteFieldResult(written=False, conflict=conflict)

        now = self._now()
        value_json = _canonical_json(value)
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO fields (entity_type, entity_id, field, value, source,
                                    actor, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(entity_type, entity_id, field) DO UPDATE SET
                    value = excluded.value,
                    source = excluded.source,
                    actor = excluded.actor,
                    updated_at = excluded.updated_at
                """,
                (entity_type, entity_id, field, value_json, source, actor, now),
            )
            self._conn.execute(
                """
                INSERT INTO field_changelog (entity_type, entity_id, field, old_value,
                                             new_value, source, actor, ts)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entity_type,
                    entity_id,
                    field,
                    _canonical_json(existing.value) if existing is not None else None,
                    value_json,
                    source,
                    actor,
                    now,
                ),
            )
        written = FieldRow(
            entity_type=entity_type,
            entity_id=entity_id,
            field=field,
            value=value,
            source=source,
            actor=actor,
            updated_at=now,
        )
        return WriteFieldResult(written=True, field=written)

    def get_field(self, entity_type: str, entity_id: str, field: str) -> FieldRow | None:
        """Fetch the current value of one field, or ``None``."""
        raw = self._conn.execute(
            "SELECT * FROM fields WHERE entity_type = ? AND entity_id = ? AND field = ?",
            (entity_type, entity_id, field),
        ).fetchone()
        return _field_from(raw) if raw is not None else None

    def list_fields(
        self, entity_type: str | None = None, entity_id: str | None = None
    ) -> list[FieldRow]:
        """Current field values, optionally scoped to an entity, in key order."""
        clauses: list[str] = []
        params: list[str] = []
        if entity_type is not None:
            clauses.append("entity_type = ?")
            params.append(entity_type)
        if entity_id is not None:
            clauses.append("entity_id = ?")
            params.append(entity_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._conn.execute(
            f"SELECT * FROM fields {where} ORDER BY entity_type, entity_id, field",
            params,
        ).fetchall()
        return [_field_from(r) for r in rows]

    def restore_field(self, row: FieldRow) -> None:
        """Write a field row verbatim (no changelog append) — sidecar import only.

        Deliberately bypasses :meth:`write_field`'s human-wins rule: a rebuild
        must reproduce the exported rows byte-identically, including their
        ``source``, which the provenance guard would refuse. The trust assumption
        this rests on: ``sidecars/`` is engine-written, inside the sandbox, and
        derived — never a channel anything else feeds. If a sidecar ever becomes
        importable from an untrusted source, this is a provenance-laundering path
        (claim ``source='human'`` and no later model write can be overruled), and
        it must gain a guard at that point.
        """
        with self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO fields VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    row.entity_type,
                    row.entity_id,
                    row.field,
                    _canonical_json(row.value),
                    row.source,
                    row.actor,
                    row.updated_at,
                ),
            )

    def changelog(
        self, entity_type: str | None = None, entity_id: str | None = None
    ) -> list[FieldChangeRow]:
        """The append-only provenance ledger, oldest first."""
        clauses: list[str] = []
        params: list[str] = []
        if entity_type is not None:
            clauses.append("entity_type = ?")
            params.append(entity_type)
        if entity_id is not None:
            clauses.append("entity_id = ?")
            params.append(entity_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._conn.execute(
            f"SELECT * FROM field_changelog {where} ORDER BY seq", params
        ).fetchall()
        return [
            FieldChangeRow(
                entity_type=r["entity_type"],
                entity_id=r["entity_id"],
                field=r["field"],
                old_value=json.loads(r["old_value"]) if r["old_value"] is not None else None,
                new_value=json.loads(r["new_value"]),
                source=Provenance(r["source"]),
                actor=r["actor"],
                ts=r["ts"],
            )
            for r in rows
        ]

    # -- jobs journal (plan B0.1 table; durable runner lands in B5.1) --------------

    def create_job(self, job_id: str, *, kind: str, payload: dict[str, Any]) -> JobRow:
        """Journal a new job in ``queued`` state."""
        now = self._now()
        with self._conn:
            self._conn.execute(
                "INSERT INTO jobs (id, kind, state, progress, payload, created_at, updated_at)"
                " VALUES (?, ?, ?, 0.0, ?, ?, ?)",
                (job_id, kind, JobState.QUEUED, _canonical_json(payload), now, now),
            )
        job = self.get_job(job_id)
        assert job is not None  # just written
        return job

    def update_job(
        self,
        job_id: str,
        *,
        state: JobState | None = None,
        progress: float | None = None,
        error: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> JobRow:
        """Advance a job's journaled state/progress/payload.

        ``payload`` carries the job's resumable cursor (plan B5.1/B5.2): a
        chunked batch persists its advanced cursor here after each slice so a
        later call (or a restart) picks up exactly where it left off. Only the
        arguments given are changed; the rest keep their current values.

        :raises BrainError: If the job does not exist.
        """
        job = self.get_job(job_id)
        if job is None:
            raise BrainError(f"No brain job {job_id!r} to update.")
        with self._conn:
            self._conn.execute(
                "UPDATE jobs SET state = ?, progress = ?, error = ?, payload = ?,"
                " updated_at = ? WHERE id = ?",
                (
                    state if state is not None else job.state,
                    progress if progress is not None else job.progress,
                    error if error is not None else job.error,
                    _canonical_json(payload if payload is not None else job.payload),
                    self._now(),
                    job_id,
                ),
            )
        updated = self.get_job(job_id)
        assert updated is not None
        return updated

    def get_job(self, job_id: str) -> JobRow | None:
        """Fetch one journaled job by id, or ``None``."""
        raw = self._conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _job_from(raw) if raw is not None else None

    def list_jobs(self, *, state: JobState | None = None) -> list[JobRow]:
        """Journaled jobs, optionally filtered by state, oldest first."""
        if state is not None:
            rows = self._conn.execute(
                "SELECT * FROM jobs WHERE state = ? ORDER BY created_at, id", (state,)
            ).fetchall()
        else:
            rows = self._conn.execute("SELECT * FROM jobs ORDER BY created_at, id").fetchall()
        return [_job_from(r) for r in rows]

    def mark_interrupted_jobs(self) -> int:
        """Flag non-terminal jobs as ``interrupted`` (sidecar restart, plan B5.1).

        :returns: How many jobs were flagged.
        """
        with self._conn:
            cursor = self._conn.execute(
                "UPDATE jobs SET state = ?, updated_at = ? WHERE state IN (?, ?)",
                (JobState.INTERRUPTED, self._now(), JobState.QUEUED, JobState.RUNNING),
            )
        return cursor.rowcount

    # -- frames (plan B0.1 table; vision protocol lands in B4) ---------------------

    def record_frame(
        self, asset_id: str, *, ts_seconds: float, path: str, purpose: str = "vision"
    ) -> FrameRow:
        """Register one extracted frame image for an asset."""
        with self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO frames (asset_id, ts_seconds, path, purpose)"
                " VALUES (?, ?, ?, ?)",
                (asset_id, ts_seconds, path, purpose),
            )
        return FrameRow(asset_id=asset_id, ts_seconds=ts_seconds, path=path, purpose=purpose)

    def list_frames(self, asset_id: str | None = None) -> list[FrameRow]:
        """Registered frames, optionally for one asset, in deterministic order."""
        if asset_id is not None:
            rows = self._conn.execute(
                "SELECT * FROM frames WHERE asset_id = ? ORDER BY asset_id, ts_seconds, purpose",
                (asset_id,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM frames ORDER BY asset_id, ts_seconds, purpose"
            ).fetchall()
        return [_frame_from(r) for r in rows]

    def restore_frame(self, row: FrameRow) -> None:
        """Write a frame row verbatim — sidecar import only."""
        with self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO frames VALUES (?, ?, ?, ?)",
                (row.asset_id, row.ts_seconds, row.path, row.purpose),
            )

    # -- embeddings (plan B3.2) ------------------------------------------------------

    def replace_embeddings(self, model: str, rows: list[EmbeddingRow]) -> int:
        """Replace ALL stored embeddings for one model (plan B3.2).

        Drop-and-rebuild for the same reason as the FTS tables: embeddings are
        an index over canonical data, so each ingest mirrors the document
        exactly — a deleted utterance can never linger as a stale neighbor.
        Other models' vectors are untouched (spaces never mix).
        """
        with self._conn:
            self._conn.execute("DELETE FROM embeddings WHERE model = ?", (model,))
            self._conn.executemany(
                "INSERT INTO embeddings (owner_type, owner_id, model, dim, vector, payload)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (
                        row.owner_type,
                        row.owner_id,
                        model,
                        row.dim,
                        pack_vector(row.vector),
                        _canonical_json(row.payload) if row.payload is not None else None,
                    )
                    for row in rows
                ],
            )
        return len(rows)

    def list_embeddings(self, model: str, *, owner_type: str | None = None) -> list[EmbeddingRow]:
        """Stored embeddings for one model, in deterministic key order."""
        clauses = ["model = ?"]
        params: list[str] = [model]
        if owner_type is not None:
            clauses.append("owner_type = ?")
            params.append(owner_type)
        rows = self._conn.execute(
            f"SELECT * FROM embeddings WHERE {' AND '.join(clauses)} ORDER BY owner_type, owner_id",
            params,
        ).fetchall()
        return [_embedding_from(r) for r in rows]

    # -- full-text search (plan B2.1/B2.2) ------------------------------------------

    def reindex_transcript(
        self, utterances: list[TranscriptUtterance], *, asset_id: str = ""
    ) -> bool:
        """Replace the transcript FTS index with ``utterances`` (plan B2.1).

        Drop-and-rebuild, not merge: the FTS tables are an *index over the
        canonical project document* (invariant 1), so each ingest mirrors the
        document exactly — a word deleted from the transcript can never linger
        as a stale hit. ``asset_id`` is empty for the project-level transcript
        (its times are timeline seconds, not tied to one source asset).

        :returns: False (no-op) when this runtime's SQLite lacks FTS5.
        """
        if not self._fts_available:
            return False
        with self._conn:
            self._conn.execute("DELETE FROM transcript_fts")
            self._conn.executemany(
                'INSERT INTO transcript_fts (asset_id, start, "end", text) VALUES (?, ?, ?, ?)',
                [(asset_id, u.start, u.end, u.text) for u in utterances],
            )
        return True

    def reindex_markers(self, markers: list[SupportsMarker]) -> bool:
        """Replace the markers FTS index from the project's markers (plan B2.1).

        Unlabeled markers are indexed with an empty label so a marker-count
        query stays honest; see :meth:`reindex_transcript` for the
        drop-and-rebuild rationale.

        :returns: False (no-op) when this runtime's SQLite lacks FTS5.
        """
        if not self._fts_available:
            return False
        with self._conn:
            self._conn.execute("DELETE FROM markers_fts")
            self._conn.executemany(
                "INSERT INTO markers_fts (marker_id, time, label) VALUES (?, ?, ?)",
                [(m.id, m.time, m.label or "") for m in markers],
            )
        return True

    def search_transcript(self, query: str, *, limit: int = 20) -> list[SearchHit]:
        """FTS match over indexed transcript utterances, best-ranked first (B2.2).

        The untrusted query is reduced to quoted terms by
        :func:`~framepilot_engine.brain.fts.fts_match_expression` — MATCH-grammar
        injection is structurally impossible (plan B7.2). Empty/unsearchable
        queries and FTS5-less runtimes return no hits.
        """
        match = fts_match_expression(query)
        if not match or not self._fts_available:
            return []
        rows = self._conn.execute(
            'SELECT asset_id, start, "end",'
            " snippet(transcript_fts, 3, '[', ']', '…', 12) AS snip,"
            " bm25(transcript_fts) AS rank"
            " FROM transcript_fts WHERE transcript_fts MATCH ? ORDER BY rank LIMIT ?",
            (match, limit),
        ).fetchall()
        return [
            SearchHit(
                type=SearchHitType.TRANSCRIPT,
                asset_id=r["asset_id"] or None,
                start=float(r["start"]),
                end=float(r["end"]),
                snippet=r["snip"],
                score=-float(r["rank"]),
            )
            for r in rows
        ]

    def search_markers(self, query: str, *, limit: int = 20) -> list[SearchHit]:
        """FTS match over indexed marker labels, best-ranked first (B2.2)."""
        match = fts_match_expression(query)
        if not match or not self._fts_available:
            return []
        rows = self._conn.execute(
            "SELECT marker_id, time,"
            " snippet(markers_fts, 2, '[', ']', '…', 12) AS snip,"
            " bm25(markers_fts) AS rank"
            " FROM markers_fts WHERE markers_fts MATCH ? ORDER BY rank LIMIT ?",
            (match, limit),
        ).fetchall()
        return [
            SearchHit(
                type=SearchHitType.MARKER,
                marker_id=r["marker_id"],
                start=float(r["time"]),
                end=float(r["time"]),
                snippet=r["snip"],
                score=-float(r["rank"]),
            )
            for r in rows
        ]

    def search_assets(self, query: str, *, limit: int = 20) -> list[SearchHit]:
        """Substring match over asset ids/paths in the ``assets`` table (B2.2).

        Not FTS (file names are short identifiers, not prose): every query
        token must appear in the id or path, case-insensitively. LIKE wildcards
        in the tokens are escaped so they match literally. Available even
        without FTS5. Hits score 0.0 — below any bm25-ranked FTS hit.
        """
        tokens = [t.strip('"') for t in fts_match_expression(query).split()]
        if not tokens:
            return []
        clause = " AND ".join("(id LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')" for _ in tokens)
        params: list[str] = []
        for token in tokens:
            escaped = token.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
            params.extend([f"%{escaped}%", f"%{escaped}%"])
        rows = self._conn.execute(
            f"SELECT id, path FROM assets WHERE {clause} ORDER BY id LIMIT ?",
            (*params, limit),
        ).fetchall()
        return [
            SearchHit(
                type=SearchHitType.ASSET,
                asset_id=r["id"],
                snippet=r["path"],
                score=0.0,
            )
            for r in rows
        ]

    def reindex_captions(self, captions: list[VisualCaptionRow], *, asset_id: str = "") -> bool:
        """Replace one asset's caption FTS rows with ``captions`` (plan MI3.2).

        Drop-and-rebuild *per asset* (unlike the project-wide transcript index):
        each asset's captions are derived from its own media, so re-indexing one
        asset must not disturb another's hits. The delete is scoped to
        ``asset_id``; rows are inserted under each caption's own ``asset_id``
        (the callers pass one asset's captions, so the two agree).

        :returns: False (no-op) when this runtime's SQLite lacks FTS5.
        """
        if not self._fts_available:
            return False
        with self._conn:
            self._conn.execute("DELETE FROM captions_fts WHERE asset_id = ?", (asset_id,))
            self._conn.executemany(
                "INSERT INTO captions_fts (asset_id, scene_index, t0, t1, text)"
                " VALUES (?, ?, ?, ?, ?)",
                [(c.asset_id, c.scene_index, c.t0, c.t1, c.text) for c in captions],
            )
        return True

    def search_captions(self, query: str, *, limit: int = 20) -> list[SearchHit]:
        """FTS match over indexed VLM captions, best-ranked first (plan MI3.2).

        Mirrors :meth:`search_transcript`: the untrusted query is reduced to
        quoted terms (MATCH-grammar injection is structurally impossible), and
        empty/unsearchable queries or FTS5-less runtimes return no hits. Hits
        carry the caption span's asset-time ``start``/``end`` and its
        ``asset_id`` so visual fusion (MI5) can place them on the timeline.
        """
        match = fts_match_expression(query)
        if not match or not self._fts_available:
            return []
        rows = self._conn.execute(
            "SELECT asset_id, t0, t1,"
            " snippet(captions_fts, 4, '[', ']', '…', 12) AS snip,"
            " bm25(captions_fts) AS rank"
            " FROM captions_fts WHERE captions_fts MATCH ? ORDER BY rank LIMIT ?",
            (match, limit),
        ).fetchall()
        return [
            SearchHit(
                type=SearchHitType.CAPTION,
                asset_id=r["asset_id"] or None,
                start=float(r["t0"]),
                end=float(r["t1"]),
                snippet=r["snip"],
                score=-float(r["rank"]),
            )
            for r in rows
        ]

    # -- visual index (plan MI2.2) --------------------------------------------------

    def upsert_visual_spans(self, rows: list[VisualSpanRow]) -> int:
        """Insert or update visual spans by their PK (idempotent — plan §3.1).

        Re-upserting a span key updates it in place (a re-index over the same
        bytes never duplicates rows). ``created_at`` is stamped from the store's
        clock — one ingest timestamp for the batch.

        :returns: The number of rows written.
        """
        now = self._now()
        with self._conn:
            self._conn.executemany(
                """
                INSERT INTO visual_spans
                    (asset_id, model, sampler_version, t0, t1, scene_index,
                     keyframe_t, phash, content_hash, frame_count, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(asset_id, model, sampler_version, t0) DO UPDATE SET
                    t1 = excluded.t1,
                    scene_index = excluded.scene_index,
                    keyframe_t = excluded.keyframe_t,
                    phash = excluded.phash,
                    content_hash = excluded.content_hash,
                    frame_count = excluded.frame_count,
                    created_at = excluded.created_at
                """,
                [
                    (
                        row.asset_id,
                        row.model,
                        row.sampler_version,
                        row.t0,
                        row.t1,
                        row.scene_index,
                        row.keyframe_t,
                        str(row.phash),  # 64-bit dHash stored as decimal TEXT
                        row.content_hash,
                        row.frame_count,
                        now,
                    )
                    for row in rows
                ],
            )
        return len(rows)

    def list_visual_spans(
        self, asset_id: str | None = None, model: str | None = None
    ) -> list[VisualSpanRow]:
        """Visual spans, optionally filtered, in deterministic key order."""
        clauses: list[str] = []
        params: list[str] = []
        if asset_id is not None:
            clauses.append("asset_id = ?")
            params.append(asset_id)
        if model is not None:
            clauses.append("model = ?")
            params.append(model)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._conn.execute(
            f"SELECT * FROM visual_spans {where} ORDER BY asset_id, model, sampler_version, t0",
            params,
        ).fetchall()
        return [_visual_span_from(r) for r in rows]

    def existing_visual_span_keys(
        self, asset_id: str, content_hash: str, model: str, sampler_version: int
    ) -> set[float]:
        """The ``t0`` keys already indexed for an asset's CURRENT bytes (§3.1).

        Only spans whose stored ``content_hash`` matches count as "already
        indexed": a changed asset (new hash) reports no existing keys and
        re-indexes wholesale, while an interrupted job resumes by skipping the
        ``t0`` values this returns.
        """
        rows = self._conn.execute(
            "SELECT t0 FROM visual_spans"
            " WHERE asset_id = ? AND content_hash = ? AND model = ? AND sampler_version = ?",
            (asset_id, content_hash, model, sampler_version),
        ).fetchall()
        return {float(r["t0"]) for r in rows}

    def upsert_visual_vectors(self, rows: list[VisualVectorRow]) -> int:
        """Insert or update durable packed vectors by their span key (idempotent).

        These BLOB rows are the rebuildable source of truth for the vector index;
        the ``sqlite-vec`` ``vec0`` index (plan MI2.3) is derived from them.

        :returns: The number of rows written.
        """
        with self._conn:
            self._conn.executemany(
                """
                INSERT INTO visual_vectors (asset_id, model, sampler_version, t0, dim, vector)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(asset_id, model, sampler_version, t0) DO UPDATE SET
                    dim = excluded.dim,
                    vector = excluded.vector
                """,
                [
                    (
                        row.asset_id,
                        row.model,
                        row.sampler_version,
                        row.t0,
                        row.dim,
                        pack_vector(row.vector),
                    )
                    for row in rows
                ],
            )
        return len(rows)

    def list_visual_vectors(
        self, asset_id: str | None = None, model: str | None = None
    ) -> list[VisualVectorRow]:
        """Durable visual vectors, optionally filtered, in deterministic key order."""
        clauses: list[str] = []
        params: list[str] = []
        if asset_id is not None:
            clauses.append("asset_id = ?")
            params.append(asset_id)
        if model is not None:
            clauses.append("model = ?")
            params.append(model)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self._conn.execute(
            f"SELECT * FROM visual_vectors {where} ORDER BY asset_id, model, sampler_version, t0",
            params,
        ).fetchall()
        return [_visual_vector_from(r) for r in rows]

    def upsert_visual_captions(self, rows: list[VisualCaptionRow]) -> int:
        """Insert or update per-scene captions by their PK (idempotent).

        ``created_at`` is stamped from the store's clock. ``source`` provenance
        is written verbatim (``'model'`` for VLM captions — plan §3.3).

        :returns: The number of rows written.
        """
        now = self._now()
        with self._conn:
            self._conn.executemany(
                """
                INSERT INTO visual_captions
                    (asset_id, scene_index, t0, t1, text, source, model, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(asset_id, scene_index, t0) DO UPDATE SET
                    t1 = excluded.t1,
                    text = excluded.text,
                    source = excluded.source,
                    model = excluded.model,
                    created_at = excluded.created_at
                """,
                [
                    (
                        row.asset_id,
                        row.scene_index,
                        row.t0,
                        row.t1,
                        row.text,
                        str(row.source),
                        row.model,
                        now,
                    )
                    for row in rows
                ],
            )
        return len(rows)

    def list_visual_captions(self, asset_id: str | None = None) -> list[VisualCaptionRow]:
        """Visual captions, optionally for one asset, in deterministic key order."""
        if asset_id is not None:
            rows = self._conn.execute(
                "SELECT * FROM visual_captions WHERE asset_id = ?"
                " ORDER BY asset_id, scene_index, t0",
                (asset_id,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM visual_captions ORDER BY asset_id, scene_index, t0"
            ).fetchall()
        return [_visual_caption_from(r) for r in rows]

    def delete_visual_asset(self, asset_id: str) -> None:
        """Drop an asset's entire visual index (spans, vectors, captions).

        Used before a re-index (§3.1): the visual index is derived, so wiping
        and rebuilding it is always safe. Children are deleted first so the
        delete holds regardless of foreign-key cascade support.
        """
        with self._conn:
            self._conn.execute("DELETE FROM visual_vectors WHERE asset_id = ?", (asset_id,))
            self._conn.execute("DELETE FROM visual_captions WHERE asset_id = ?", (asset_id,))
            self._conn.execute("DELETE FROM visual_spans WHERE asset_id = ?", (asset_id,))

    def visual_indexed_asset_ids(self) -> set[str]:
        """Ids of the assets the BUILT-IN visual index has at least one span for.

        Used by ``GET /brain/visual/status`` to union built-in coverage with
        TwelveLabs coverage: a project can legitimately be prepared by both at
        once (stills on the built-in path, footage on the hosted one), and
        counting only one of them under-reports coverage forever.
        """
        rows = self._conn.execute("SELECT DISTINCT asset_id FROM visual_spans").fetchall()
        return {str(r["asset_id"]) for r in rows}

    def visual_index_counts(self) -> dict[str, int]:
        """Coverage counters for ``GET /brain/visual/status`` (plan MI4.3).

        ``assets`` is the number of distinct assets with at least one span.
        """

        def total(table: str) -> int:
            return int(self._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])

        assets = int(
            self._conn.execute("SELECT COUNT(DISTINCT asset_id) FROM visual_spans").fetchone()[0]
        )
        return {
            "spans": total("visual_spans"),
            "vectors": total("visual_vectors"),
            "captions": total("visual_captions"),
            "assets": assets,
        }


# -- row mappers -----------------------------------------------------------------


def _asset_from(r: sqlite3.Row) -> AssetRow:
    return AssetRow(
        id=r["id"],
        path=r["path"],
        content_sha256=r["content_sha256"],
        probe=json.loads(r["probe"]) if r["probe"] is not None else None,
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


def _analysis_from(r: sqlite3.Row) -> AnalysisResultRow:
    return AnalysisResultRow(
        asset_id=r["asset_id"],
        kind=r["kind"],
        depth=r["depth"],
        params_hash=r["params_hash"],
        result=json.loads(r["result"]),
        source=Provenance(r["source"]),
        tool=r["tool"],
        created_at=r["created_at"],
    )


def _field_from(r: sqlite3.Row) -> FieldRow:
    return FieldRow(
        entity_type=r["entity_type"],
        entity_id=r["entity_id"],
        field=r["field"],
        value=json.loads(r["value"]),
        source=Provenance(r["source"]),
        actor=r["actor"],
        updated_at=r["updated_at"],
    )


def _job_from(r: sqlite3.Row) -> JobRow:
    return JobRow(
        id=r["id"],
        kind=r["kind"],
        state=JobState(r["state"]),
        progress=r["progress"],
        payload=json.loads(r["payload"]),
        error=r["error"],
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


def _embedding_from(r: sqlite3.Row) -> EmbeddingRow:
    return EmbeddingRow(
        owner_type=r["owner_type"],
        owner_id=r["owner_id"],
        model=r["model"],
        dim=r["dim"],
        vector=unpack_vector(r["vector"]),
        payload=json.loads(r["payload"]) if r["payload"] is not None else None,
    )


def _frame_from(r: sqlite3.Row) -> FrameRow:
    return FrameRow(
        asset_id=r["asset_id"],
        ts_seconds=r["ts_seconds"],
        path=r["path"],
        purpose=r["purpose"],
    )


def _visual_span_from(r: sqlite3.Row) -> VisualSpanRow:
    return VisualSpanRow(
        asset_id=r["asset_id"],
        model=r["model"],
        sampler_version=r["sampler_version"],
        t0=r["t0"],
        t1=r["t1"],
        scene_index=r["scene_index"],
        keyframe_t=r["keyframe_t"],
        phash=int(r["phash"]),  # decimal TEXT → full 64-bit int
        content_hash=r["content_hash"],
        frame_count=r["frame_count"],
        created_at=r["created_at"],
    )


def _visual_vector_from(r: sqlite3.Row) -> VisualVectorRow:
    return VisualVectorRow(
        asset_id=r["asset_id"],
        model=r["model"],
        sampler_version=r["sampler_version"],
        t0=r["t0"],
        dim=r["dim"],
        vector=unpack_vector(r["vector"]),
    )


def _visual_caption_from(r: sqlite3.Row) -> VisualCaptionRow:
    return VisualCaptionRow(
        asset_id=r["asset_id"],
        scene_index=r["scene_index"],
        t0=r["t0"],
        t1=r["t1"],
        text=r["text"],
        source=Provenance(r["source"]),
        model=r["model"],
        created_at=r["created_at"],
    )


# -- module-level entry points -----------------------------------------------------


def open_brain(projects_root: Path, project_id: str, *, clock: Clock | None = None) -> BrainStore:
    """Open (creating as needed) the brain for one project, inside the sandbox.

    :raises framepilot_engine.safety.PathTraversalError: If ``project_id``
        escapes the projects root.
    :raises BrainSchemaError: If the brain was written by a newer engine.
    :raises BrainError: On any other SQLite open/migrate failure.
    """
    db_path = brain_dir_for(projects_root, project_id) / BRAIN_FILENAME
    return BrainStore.open(db_path, clock=clock)


def brain_status(projects_root: Path | None, project_id: str) -> BrainStatus:
    """Report a project brain's status WITHOUT creating it (``GET /brain/status``).

    Honest-unavailable (plan B0.5): a missing sandbox root, a traversal-escaping
    project id, or an unopenable/newer-schema file all come back as
    ``available=False`` with a reason — never an exception, never a fabricated
    "healthy" report.
    """
    if projects_root is None:
        return BrainStatus(
            available=False,
            exists=False,
            reason=(
                "projects_root is not configured (set FRAMEPILOT_PROJECTS_ROOT); "
                "the brain lives under the sandboxed derived directory."
            ),
        )
    try:
        db_path = brain_dir_for(projects_root, project_id) / BRAIN_FILENAME
    except PathTraversalError as exc:  # untrusted project_id
        return BrainStatus(available=False, exists=False, reason=str(exc))
    if not db_path.exists():
        return BrainStatus(
            available=False,
            exists=False,
            path=str(db_path),
            reason="brain.sqlite does not exist yet; it is created on first write.",
        )
    try:
        with BrainStore.open(db_path) as store:
            return store.status()
    except (BrainError, BrainSchemaError) as exc:
        return BrainStatus(available=False, exists=True, path=str(db_path), reason=str(exc))
