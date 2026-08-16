"""Forward-only schema migrations for ``brain.sqlite`` (plan B0.1).

WHY: the brain must evolve without ever corrupting or silently reinterpreting
existing data, mirroring the discipline of ``timeline-schema/migrations.ts``:
migrations are **forward-only**, each one is a pure function of the connection,
and the schema version lives in SQLite's ``PRAGMA user_version`` so it travels
with the file itself. A file written by a *newer* engine is rejected (we cannot
know its shape) — never downgraded.

FTS5 tables are created outside the numbered migrations by
:func:`ensure_fts_tables`, because FTS5 availability is a property of the
*runtime's* SQLite build, not of the database file: the same brain must open
cleanly on a build without FTS5 (search degrades, nothing breaks — plan B0.5).
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable

Migration = Callable[[sqlite3.Connection], None]


def _migrate_v1(conn: sqlite3.Connection) -> None:
    """v1: the core tables from plan B0.1.

    ``embeddings`` is created now but stays unused until B3 (embedder seam),
    so the file format doesn't churn when similarity search lands. JSON
    columns hold canonical JSON text produced by the store (sorted keys).
    """
    conn.executescript(
        """
        CREATE TABLE assets (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            content_sha256 TEXT,
            probe TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE analysis_results (
            asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            depth TEXT NOT NULL,
            params_hash TEXT NOT NULL,
            result TEXT NOT NULL,
            source TEXT NOT NULL,
            tool TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (asset_id, kind, depth, params_hash)
        );

        CREATE TABLE fields (
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            field TEXT NOT NULL,
            value TEXT NOT NULL,
            source TEXT NOT NULL,
            actor TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (entity_type, entity_id, field)
        );

        CREATE TABLE field_changelog (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            field TEXT NOT NULL,
            old_value TEXT,
            new_value TEXT NOT NULL,
            source TEXT NOT NULL,
            actor TEXT NOT NULL,
            ts TEXT NOT NULL
        );

        CREATE TABLE jobs (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
            progress REAL NOT NULL DEFAULT 0.0,
            payload TEXT NOT NULL DEFAULT '{}',
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE frames (
            asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            ts_seconds REAL NOT NULL,
            path TEXT NOT NULL,
            purpose TEXT NOT NULL DEFAULT 'vision',
            PRIMARY KEY (asset_id, ts_seconds, purpose)
        );

        CREATE TABLE embeddings (
            owner_type TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            model TEXT NOT NULL,
            dim INTEGER NOT NULL,
            vector BLOB NOT NULL,
            PRIMARY KEY (owner_type, owner_id, model)
        );
        """
    )


def _migrate_v2(conn: sqlite3.Connection) -> None:
    """v2 (plan B3.2): embeddings rows carry a JSON ``payload``.

    A vector alone cannot become a search hit — the payload holds what the hit
    needs (utterance times + text, or an asset digest) so ``find_similar``
    never has to re-derive it from the canonical document at query time.
    """
    conn.execute("ALTER TABLE embeddings ADD COLUMN payload TEXT")


def _migrate_v3(conn: sqlite3.Connection) -> None:
    """v3 (plan MI2.2): the visual-index tables for media intelligence.

    Three PLAIN tables — deliberately **not** the ``sqlite-vec`` ``vec0`` virtual
    table. Loadable-extension availability is a property of the runtime, not the
    file (like FTS5 in :func:`ensure_fts_tables`), so the durable rows must open
    on any build; the ``vec0`` index is owned and gated by
    :mod:`framepilot_engine.brain.vector_store` (plan MI2.3) and rebuilt from
    ``visual_vectors`` when the extension loads.

    - ``visual_spans``: one row per embedded time span (§3.1). PK
      ``(asset_id, model, sampler_version, t0)``; ``content_hash`` carries the
      source-bytes digest so a changed asset re-indexes and an unchanged one is
      skipped. ``phash`` is the keyframe dHash stored as TEXT — a full 64-bit
      value JSON/JS ``Number`` cannot hold.
    - ``visual_vectors``: the durable packed embedding per span, foreign-keyed
      onto ``visual_spans`` so deleting a span drops its vector.
    - ``visual_captions``: per-scene VLM captions (§3.3) with ``source``
      provenance (default ``'model'``) and the producing ``model`` id.
    """
    conn.executescript(
        """
        CREATE TABLE visual_spans (
            asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            model TEXT NOT NULL,
            sampler_version INTEGER NOT NULL,
            t0 REAL NOT NULL,
            t1 REAL NOT NULL,
            scene_index INTEGER NOT NULL,
            keyframe_t REAL NOT NULL,
            phash TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            frame_count INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (asset_id, model, sampler_version, t0)
        );

        CREATE TABLE visual_vectors (
            asset_id TEXT NOT NULL,
            model TEXT NOT NULL,
            sampler_version INTEGER NOT NULL,
            t0 REAL NOT NULL,
            dim INTEGER NOT NULL,
            vector BLOB NOT NULL,
            PRIMARY KEY (asset_id, model, sampler_version, t0),
            FOREIGN KEY (asset_id, model, sampler_version, t0)
                REFERENCES visual_spans (asset_id, model, sampler_version, t0)
                ON DELETE CASCADE
        );

        CREATE TABLE visual_captions (
            asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
            scene_index INTEGER NOT NULL,
            t0 REAL NOT NULL,
            t1 REAL NOT NULL,
            text TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'model',
            model TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (asset_id, scene_index, t0)
        );
        """
    )


# Ordered, append-only. MIGRATIONS[n] upgrades a database at user_version n to
# n + 1. Never reorder or edit a shipped entry — append a new one.
MIGRATIONS: tuple[Migration, ...] = (_migrate_v1, _migrate_v2, _migrate_v3)

SCHEMA_VERSION = len(MIGRATIONS)


class BrainSchemaError(Exception):
    """The brain file's schema version cannot be handled by this engine."""


def current_version(conn: sqlite3.Connection) -> int:
    """Read the schema version stored in the database file."""
    row = conn.execute("PRAGMA user_version").fetchone()
    return int(row[0])


def migrate(conn: sqlite3.Connection) -> int:
    """Bring a connection's database up to :data:`SCHEMA_VERSION` (forward-only).

    Each pending migration runs in its own transaction so a failure leaves the
    file at the last consistent version, never half-migrated.

    :returns: The (new) schema version.
    :raises BrainSchemaError: If the file was written by a newer engine.
    """
    version = current_version(conn)
    if version > SCHEMA_VERSION:
        raise BrainSchemaError(
            f"brain.sqlite has schema version {version}, newer than this engine's "
            f"{SCHEMA_VERSION}. Update FramePilot, or delete the brain (it is a "
            "derived cache) to let this engine rebuild it."
        )
    for next_version in range(version, SCHEMA_VERSION):
        with conn:  # one transaction per migration step
            MIGRATIONS[next_version](conn)
            # PRAGMA cannot be parameterized; next_version + 1 is a trusted int.
            conn.execute(f"PRAGMA user_version = {next_version + 1}")
    return SCHEMA_VERSION


def fts5_available(conn: sqlite3.Connection) -> bool:
    """Probe whether this runtime's SQLite build ships the FTS5 module.

    Capability-checked at open (plan B0.5) so search features degrade honestly
    on builds without FTS5 instead of failing mid-query.
    """
    try:
        conn.execute("CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(x)")
    except sqlite3.OperationalError:
        return False
    conn.execute("DROP TABLE temp._fts5_probe")
    return True


def ensure_fts_tables(conn: sqlite3.Connection) -> bool:
    """Create the contentless FTS5 indexes when the runtime supports them.

    ``transcript_fts``/``markers_fts`` are *indexes over canonical project
    data* (rebuilt from ``project.fp.json`` — invariant 1), so their absence on
    an FTS5-less build loses search, never truth. Ingestion lands in B2.1.

    ``captions_fts`` (plan MI3.2) indexes per-scene VLM captions — *derived*
    data (``source='model'``), rebuilt by re-indexing the media, not from the
    canonical document. Same degradation contract: no FTS5 ⇒ no caption search,
    nothing breaks.

    :returns: True when the FTS tables exist after the call.
    """
    if not fts5_available(conn):
        return False
    with conn:
        conn.executescript(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts
                USING fts5(asset_id UNINDEXED, start UNINDEXED, "end" UNINDEXED, text);
            CREATE VIRTUAL TABLE IF NOT EXISTS markers_fts
                USING fts5(marker_id UNINDEXED, time UNINDEXED, label);
            CREATE VIRTUAL TABLE IF NOT EXISTS captions_fts
                USING fts5(asset_id UNINDEXED, scene_index UNINDEXED,
                           t0 UNINDEXED, t1 UNINDEXED, text);
            """
        )
    return True
