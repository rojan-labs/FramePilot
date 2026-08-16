"""Visual vector-store seam over ``brain.sqlite`` (plan MI2.3, decision D4).

WHY: "find footage that looks like X" needs indexed nearest-neighbour search
over the visual embeddings (plan ``MEDIA-INTELLIGENCE.md``). This module is the
**seam**, not a particular backend: one search API (:class:`VisualVectorStore`)
over two interchangeable implementations —

- **sqlite-vec** (``vec0`` virtual table) for indexed KNN at desktop scale, when
  the native extension loads into the brain connection.
- **brute-force cosine** (:func:`~framepilot_engine.brain.embeddings.cosine_top_k`
  over the durable ``visual_vectors`` rows) otherwise.

The durable BLOB rows in ``visual_vectors`` (written by :class:`BrainStore`) are
the rebuildable source of truth; the ``vec0`` index is **derived** from them and
can be dropped and rebuilt at will (plan MI7.2). Loadability is a property of the
runtime, not the file — exactly like FTS5 — so extension loading is lazy and
**never raises**: a load failure logs its reason and the search degrades to
brute force (plan D4). Startup stays cheap because nothing here runs until the
first index/search call.

Score convention: BOTH backends return **cosine similarity** in ``[-1, 1]``
where higher is more similar, so later reciprocal-rank fusion (MI5) treats them
identically. Stored index vectors and query vectors are L2-normalized, so the
vec0 Euclidean distance ``d`` maps exactly to cosine via ``1 - d²/2`` (see
:func:`_distance_to_similarity`).
"""

from __future__ import annotations

import logging
import sqlite3
import sys
from collections.abc import Sequence
from pathlib import Path

import numpy as np
from pydantic import BaseModel, Field

from framepilot_engine.brain.embeddings import cosine_top_k, pack_vector
from framepilot_engine.brain.models import VisualVectorRow
from framepilot_engine.brain.store import BrainStore

_log = logging.getLogger(__name__)

__all__ = [
    "BACKEND_BRUTE_FORCE",
    "BACKEND_SQLITE_VEC",
    "VisualHit",
    "VisualVectorStore",
    "vec_available",
]

#: The derived ``vec0`` KNN index and its rowid↔span-key mapping. ``vec0`` keys
#: rows by an integer rowid, so the map recovers the real span key from a hit.
_INDEX_TABLE = "visual_vec_idx"
_MAP_TABLE = "visual_vec_map"

#: Max keys per targeted metadata/rowid lookup batch. Each ``visual_spans`` row
#: value binds 4 params, so 200 keys = 800 bound variables — well under SQLite's
#: default ``SQLITE_MAX_VARIABLE_NUMBER`` (999 on old builds, 32766 since 3.32),
#: so the point-lookup batching stays safe on every runtime we ship on. On the
#: hot (unfiltered) path k <= 50 fits in a single batch; only the filtered
#: fetch-all path (already O(n) by construction) spans multiple batches.
_LOOKUP_CHUNK = 200

BACKEND_SQLITE_VEC = "sqlite-vec"
BACKEND_BRUTE_FORCE = "brute-force"

#: Span key: ``(asset_id, model, sampler_version, t0)`` — the PK shared by
#: ``visual_spans`` and ``visual_vectors``.
_SpanKey = tuple[str, str, int, float]


class VisualHit(BaseModel):
    """One vector-search result: a time span and its similarity to the query.

    ``score`` is cosine similarity (higher = more similar) for both backends, so
    hits can be fused across recall sources without a per-backend rescale (MI5).
    ``t1``/``scene_index`` come from the hit's ``visual_spans`` row.
    """

    asset_id: str = Field(alias="assetId")
    t0: float = Field(description="Span start in seconds (inclusive).")
    t1: float = Field(description="Span end in seconds (exclusive).")
    scene_index: int = Field(alias="sceneIndex")
    score: float = Field(description="Cosine similarity in [-1, 1]; higher is more similar.")

    model_config = {"populate_by_name": True}


def _load_sqlite_vec(conn: sqlite3.Connection) -> None:
    """Load the ``vec0`` extension, tolerating PyInstaller's frozen layout.

    ``sqlite_vec.load`` resolves the native lib relative to the package
    ``__file__`` (``dirname(__file__)/vec0``). The desktop packaging (plan
    MI2.4) stages the lib into the bundle's ``sqlite_vec/`` dir precisely so
    that default resolution keeps working when frozen. But loadable-extension
    delivery varies per OS/PyInstaller version — if the lib is ever relocated
    to the bundle root instead, ``load`` would miss it. So when the package
    path fails **inside a frozen bundle** (``sys._MEIPASS`` set), retry against
    the lib's likely locations under the bundle dir before giving up.

    In dev (unfrozen) this is a strict no-op: without ``_MEIPASS`` the original
    error propagates unchanged, so :func:`vec_available` still degrades honestly
    to brute force (plan D4). ``conn.load_extension`` appends the platform
    suffix itself, so the candidates are passed without one — matching what
    ``sqlite_vec.load`` does.
    """
    import sqlite_vec

    try:
        sqlite_vec.load(conn)
        return
    except sqlite3.Error:
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass is None:
            raise  # not frozen: the package's own path is authoritative
    bundle = Path(meipass)
    for candidate in (bundle / "sqlite_vec" / "vec0", bundle / "vec0"):
        try:
            conn.load_extension(str(candidate))
            return
        except sqlite3.Error:
            continue
    # Nothing resolved under the bundle either; re-raise via the package path so
    # the caller (vec_available) records a real reason and falls back to brute
    # force rather than swallowing the failure.
    conn.load_extension(sqlite_vec.loadable_path())


def vec_available(conn: sqlite3.Connection) -> tuple[bool, str | None]:
    """Probe whether ``sqlite-vec`` can be loaded into ``conn`` (probe-and-degrade).

    Mirrors :func:`framepilot_engine.brain.migrations.fts5_available`: the result
    is ``(True, None)`` when the ``vec0`` module is usable, or ``(False, reason)``
    when it is not — this function **never raises**. Once loaded, the module
    stays registered on the connection, so repeat calls short-circuit on the
    cheap ``vec_version()`` probe instead of re-loading.

    Failure modes handled: extension loading compiled out of this SQLite build
    (``AttributeError`` — no ``enable_load_extension`` — or a ``sqlite3.Error``
    when it is disabled), and the wheel missing/broken (``ImportError``).
    """
    try:
        conn.execute("SELECT vec_version()").fetchone()
        return True, None  # already loaded on this connection
    except sqlite3.OperationalError:
        pass  # function not registered yet — try to load the extension below
    try:
        conn.enable_load_extension(True)
        _load_sqlite_vec(conn)
        conn.enable_load_extension(False)
        conn.execute("SELECT vec_version()").fetchone()
        return True, None
    except (AttributeError, ImportError, sqlite3.Error) as exc:
        reason = f"{type(exc).__name__}: {exc}".strip(": ") or type(exc).__name__
        _log.info(
            "visual vector index: sqlite-vec unavailable (%s); using brute-force fallback", reason
        )
        return False, reason


def _pack_unit(vector: Sequence[float]) -> bytes:
    """L2-normalize then pack as little-endian float32 — the vec0 index format.

    Normalizing both stored and query vectors is what lets Euclidean distance
    stand in for cosine similarity (see module docstring).
    """
    arr = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    if norm > 0.0:
        arr = arr / norm
    return arr.astype("<f4").tobytes()


def _distance_to_similarity(distance: float) -> float:
    """Map a vec0 L2 distance between unit vectors to cosine similarity.

    ``‖a-b‖² = 2(1 - cos)`` for unit vectors, so ``cos = 1 - d²/2``. This keeps
    the vec0 score on the same scale as the brute-force cosine, so fusion (MI5)
    and the parity guarantee both hold.
    """
    return 1.0 - (distance * distance) / 2.0


def _in_time_range(t0: float, t1: float, start: float, end: float) -> bool:
    """Whether a span ``[t0, t1)`` intersects the closed query range ``[start, end]``.

    A point/image span (``t1 <= t0``) is kept when its single instant lies in the
    range; a real span is kept when the half-open interval overlaps it.
    """
    if t1 <= t0:
        return start <= t0 <= end
    return t0 <= end and t1 > start


class VisualVectorStore:
    """One KNN search API over the sqlite-vec index or the brute-force fallback.

    Constructed from an open :class:`BrainStore`: durable vector rows are written
    and read through the store (the rebuildable source of truth), while the
    derived ``vec0`` index is maintained directly on the store's connection.
    """

    def __init__(self, store: BrainStore) -> None:
        self._store = store
        self._conn = store._conn

    def backend(self) -> str:
        """Which backend a search would use right now (for ``/brain/visual/status``)."""
        available, _ = vec_available(self._conn)
        return BACKEND_SQLITE_VEC if available else BACKEND_BRUTE_FORCE

    def ensure_index(self, dim: int) -> bool:
        """Create the ``vec0`` index + rowid map for ``dim``-wide vectors (idempotent).

        :returns: True when the index exists after the call; False when
            sqlite-vec is unavailable (the caller then relies on brute force).
        :raises ValueError: On a non-positive dimension.
        """
        if dim <= 0:
            raise ValueError(f"dim must be > 0, got {dim}.")
        available, _ = vec_available(self._conn)
        if not available:
            return False
        with self._conn:
            # dim is a trusted positive int; vec0 needs it as a literal (DDL
            # cannot be parameterized).
            self._conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS {_INDEX_TABLE} "
                f"USING vec0(embedding float[{dim}])"
            )
            self._conn.execute(
                f"CREATE TABLE IF NOT EXISTS {_MAP_TABLE} ("
                " rowid INTEGER PRIMARY KEY,"
                " asset_id TEXT NOT NULL,"
                " model TEXT NOT NULL,"
                " sampler_version INTEGER NOT NULL,"
                " t0 REAL NOT NULL,"
                " UNIQUE (asset_id, model, sampler_version, t0))"
            )
        return True

    def upsert(self, rows: list[VisualVectorRow]) -> int:
        """Write durable vector rows AND the derived vec0 index (when available).

        Durable rows are always written (they rebuild the index); the vec0 index
        is updated only when sqlite-vec loads. Re-upserting a key replaces its
        indexed vector in place, so a re-index never leaves stale neighbours.

        :returns: The number of rows written.
        """
        self._store.upsert_visual_vectors(rows)
        if not rows:
            return 0
        available, _ = vec_available(self._conn)
        if available:
            self.ensure_index(rows[0].dim)
            with self._conn:
                for row in rows:
                    self._index_row(row)
        return len(rows)

    def search(
        self,
        query_vector: Sequence[float],
        k: int,
        *,
        asset_ids: Sequence[str] | None = None,
        time_range: tuple[float, float] | None = None,
    ) -> list[VisualHit]:
        """Top-``k`` most-similar spans to ``query_vector`` (backend-transparent).

        Filtering (by asset and/or time range) and final ordering are applied
        identically regardless of backend, so the two paths return the same
        top-k on the same data (the parity guarantee). When filters are present
        the ranked candidate set is taken in full before filtering so a filter
        can never starve the result below ``k``.

        :param k: Maximum hits; ``<= 0`` returns ``[]``.
        :param asset_ids: Restrict to these assets, if given.
        :param time_range: ``(start, end)`` seconds; keep spans overlapping it.
        """
        if k <= 0:
            return []
        allowed = set(asset_ids) if asset_ids is not None else None
        has_filters = allowed is not None or time_range is not None
        scored = self._scored_candidates(query_vector, k, fetch_all=has_filters)
        # Resolve span metadata for ONLY the candidate keys via targeted PK point
        # lookups, not a full ``visual_spans`` materialization: on the unfiltered
        # hot path that is O(k) (k <= 50) instead of O(n) (MI7.1). Keys with no
        # ``visual_spans`` row are simply absent from the map, so the skip below
        # still drops a "hit without span metadata" exactly as before.
        span_meta = self._span_meta_for([key for key, _ in scored])

        hits: list[VisualHit] = []
        for key, score in scored:
            meta = span_meta.get(key)
            if meta is None:
                continue  # a vector without its span (FK makes this unreachable)
            asset_id, _, _, t0 = key
            t1, scene_index = meta
            if allowed is not None and asset_id not in allowed:
                continue
            if time_range is not None and not _in_time_range(t0, t1, *time_range):
                continue
            hits.append(
                VisualHit(asset_id=asset_id, t0=t0, t1=t1, scene_index=scene_index, score=score)
            )
        # Deterministic, backend-independent order: similarity desc, then key.
        hits.sort(key=lambda h: (-h.score, h.asset_id, h.t0))
        return hits[:k]

    # -- backend selection -------------------------------------------------------

    def _scored_candidates(
        self, query_vector: Sequence[float], k: int, *, fetch_all: bool
    ) -> list[tuple[_SpanKey, float]]:
        available, _ = vec_available(self._conn)
        if available and self._index_ready():
            return self._vec_candidates(query_vector, k, fetch_all=fetch_all)
        return self._brute_candidates(query_vector, k, fetch_all=fetch_all)

    def _vec_candidates(
        self, query_vector: Sequence[float], k: int, *, fetch_all: bool
    ) -> list[tuple[_SpanKey, float]]:
        count = int(self._conn.execute(f"SELECT COUNT(*) FROM {_INDEX_TABLE}").fetchone()[0])
        limit = count if fetch_all else min(k, count)
        if limit <= 0:
            return []
        knn = self._conn.execute(
            f"SELECT rowid, distance FROM {_INDEX_TABLE} WHERE embedding MATCH ? AND k = ?",
            (_pack_unit(query_vector), limit),
        ).fetchall()
        # Recover span keys for ONLY the KNN hit rowids (an indexed point lookup
        # per rowid), not a full ``_MAP_TABLE`` scan: O(k) on the hot path
        # (MI7.1). An orphan index rowid has no map row, so it is absent here and
        # skipped below — the pre-existing "orphan index rowid" behaviour.
        rowid_to_key = self._rowid_keys([int(r["rowid"]) for r in knn])
        candidates: list[tuple[_SpanKey, float]] = []
        for row in knn:
            key = rowid_to_key.get(int(row["rowid"]))
            if key is not None:
                candidates.append((key, _distance_to_similarity(float(row["distance"]))))
        return candidates

    def _brute_candidates(
        self, query_vector: Sequence[float], k: int, *, fetch_all: bool
    ) -> list[tuple[_SpanKey, float]]:
        rows = self._store.list_visual_vectors()
        if not rows:
            return []
        limit = len(rows) if fetch_all else k
        # Index position is the cosine_top_k key; mapped back to the span key.
        packed = [(str(i), pack_vector(row.vector)) for i, row in enumerate(rows)]
        ranked = cosine_top_k(query_vector, packed, limit)
        candidates: list[tuple[_SpanKey, float]] = []
        for idx, score in ranked:
            row = rows[int(idx)]
            key = (row.asset_id, row.model, row.sampler_version, row.t0)
            candidates.append((key, score))
        return candidates

    # -- helpers -----------------------------------------------------------------

    def _index_ready(self) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (_INDEX_TABLE,)
        ).fetchone()
        return row is not None

    def _span_meta_for(self, keys: Sequence[_SpanKey]) -> dict[_SpanKey, tuple[float, int]]:
        """Resolve ``(t1, scene_index)`` for exactly ``keys`` via PK point lookups.

        Uses the ``visual_spans`` primary key ``(asset_id, model, sampler_version,
        t0)`` through a row-value ``IN`` (SQLite indexes it — see the module note),
        batched so the bound-variable count stays bounded. Keys with no matching
        span row are omitted, so the caller skips them (the "hit without span
        metadata" edge case) exactly as the former full scan did.
        """
        meta: dict[_SpanKey, tuple[float, int]] = {}
        for key, (t1, scene_index) in self._batched_pk_lookup(
            keys,
            "SELECT asset_id, model, sampler_version, t0, t1, scene_index FROM visual_spans",
        ):
            meta[key] = (float(t1), int(scene_index))
        return meta

    def _rowid_keys(self, rowids: Sequence[int]) -> dict[int, _SpanKey]:
        """Map ONLY ``rowids`` to their span keys via ``_MAP_TABLE`` PK point lookups.

        A rowid absent from ``_MAP_TABLE`` (an orphan vec0 index row) is omitted,
        so the caller skips it — the pre-existing "orphan index rowid" behaviour.
        """
        mapping: dict[int, _SpanKey] = {}
        unique = list(dict.fromkeys(int(r) for r in rowids))
        for start in range(0, len(unique), _LOOKUP_CHUNK):
            chunk = unique[start : start + _LOOKUP_CHUNK]
            placeholders = ",".join("?" * len(chunk))
            rows = self._conn.execute(
                f"SELECT rowid, asset_id, model, sampler_version, t0 FROM {_MAP_TABLE}"
                f" WHERE rowid IN ({placeholders})",
                chunk,
            ).fetchall()
            for r in rows:
                mapping[int(r["rowid"])] = (
                    r["asset_id"],
                    r["model"],
                    r["sampler_version"],
                    r["t0"],
                )
        return mapping

    def _batched_pk_lookup(
        self, keys: Sequence[_SpanKey], select: str
    ) -> list[tuple[_SpanKey, tuple[float, int]]]:
        """Run ``select`` filtered to the span ``keys`` in bounded row-value batches.

        ``select`` must project the four PK columns first, then the two payload
        columns (``t1``, ``scene_index``). Returns ``(key, (t1, scene_index))``
        pairs for the keys that exist; missing keys are simply absent.
        """
        results: list[tuple[_SpanKey, tuple[float, int]]] = []
        unique = list(dict.fromkeys(keys))
        for start in range(0, len(unique), _LOOKUP_CHUNK):
            chunk = unique[start : start + _LOOKUP_CHUNK]
            values = ",".join(["(?, ?, ?, ?)"] * len(chunk))
            params: list[object] = [field for key in chunk for field in key]
            rows = self._conn.execute(
                f"{select} WHERE (asset_id, model, sampler_version, t0) IN (VALUES {values})",
                params,
            ).fetchall()
            for r in rows:
                key: _SpanKey = (
                    r["asset_id"],
                    r["model"],
                    r["sampler_version"],
                    r["t0"],
                )
                results.append((key, (r["t1"], r["scene_index"])))
        return results

    def _index_row(self, row: VisualVectorRow) -> None:
        """Insert/replace one vector in the vec0 index, keeping its rowid stable."""
        key = (row.asset_id, row.model, row.sampler_version, row.t0)
        existing = self._conn.execute(
            f"SELECT rowid FROM {_MAP_TABLE}"
            " WHERE asset_id = ? AND model = ? AND sampler_version = ? AND t0 = ?",
            key,
        ).fetchone()
        if existing is not None:
            rowid = int(existing["rowid"])
            self._conn.execute(f"DELETE FROM {_INDEX_TABLE} WHERE rowid = ?", (rowid,))
        else:
            cursor = self._conn.execute(
                f"INSERT INTO {_MAP_TABLE} (asset_id, model, sampler_version, t0)"
                " VALUES (?, ?, ?, ?)",
                key,
            )
            assert cursor.lastrowid is not None  # just inserted
            rowid = int(cursor.lastrowid)
        self._conn.execute(
            f"INSERT INTO {_INDEX_TABLE} (rowid, embedding) VALUES (?, ?)",
            (rowid, _pack_unit(row.vector)),
        )
