"""Tests for the Project Brain store (plan B0.1) and provenance rules (B0.2).

The store is a deterministic core module (100% coverage required): every
timestamp goes through the injectable clock and every branch — including the
honest-unavailable degradations — is exercised here without any real media.
"""

from __future__ import annotations

import random
import sqlite3
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from framepilot_engine.brain import (
    BrainError,
    BrainSchemaError,
    BrainStore,
    JobState,
    Provenance,
    brain_dir_for,
    brain_status,
    open_brain,
)
from framepilot_engine.brain import migrations as brain_migrations
from framepilot_engine.brain.migrations import (
    SCHEMA_VERSION,
    current_version,
    ensure_fts_tables,
    fts5_available,
    migrate,
)
from framepilot_engine.safety import PathTraversalError


def fixed_clock(start: datetime | None = None, step_seconds: float = 1.0) -> Callable[[], datetime]:
    """A deterministic clock that advances by ``step_seconds`` per call."""
    state = {"now": start or datetime(2026, 7, 14, 12, 0, 0, tzinfo=UTC)}

    def _clock() -> datetime:
        current = state["now"]
        state["now"] = current + timedelta(seconds=step_seconds)
        return current

    return _clock


@pytest.fixture
def store(tmp_path: Path) -> Iterator[BrainStore]:
    with BrainStore.open(tmp_path / "brain.sqlite", clock=fixed_clock()) as s:
        yield s


# --- open / create / migrate (B0.1) ------------------------------------------


def test_open_creates_db_in_wal_mode_at_schema_version(tmp_path: Path) -> None:
    store = BrainStore.open(tmp_path / "sub" / "brain.sqlite", clock=fixed_clock())
    assert store.path.exists()
    mode = store._conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode == "wal"
    assert current_version(store._conn) == SCHEMA_VERSION
    store.close()
    store.close()  # idempotent


def test_default_clock_produces_utc_iso_timestamps(tmp_path: Path) -> None:
    with BrainStore.open(tmp_path / "brain.sqlite") as store:  # real clock
        row = store.upsert_asset("a1", path="a.mp4")
    parsed = datetime.fromisoformat(row.created_at)
    assert parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0)


def test_reopen_is_a_noop_migration(tmp_path: Path) -> None:
    path = tmp_path / "brain.sqlite"
    BrainStore.open(path, clock=fixed_clock()).close()
    with BrainStore.open(path, clock=fixed_clock()) as store:
        assert current_version(store._conn) == SCHEMA_VERSION


def test_newer_schema_version_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "brain.sqlite"
    BrainStore.open(path, clock=fixed_clock()).close()
    conn = sqlite3.connect(path)
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
    conn.close()
    with pytest.raises(BrainSchemaError, match="newer than this engine"):
        BrainStore.open(path, clock=fixed_clock())


def test_open_maps_sqlite_errors_to_brain_error(tmp_path: Path) -> None:
    path = tmp_path / "brain.sqlite"
    path.write_text("this is not a sqlite database, it is a text file")
    with pytest.raises(BrainError, match="Failed to open brain database"):
        BrainStore.open(path, clock=fixed_clock())


def test_open_brain_derives_sandboxed_path(tmp_path: Path) -> None:
    with open_brain(tmp_path, "proj_1", clock=fixed_clock()) as store:
        assert store.path == tmp_path / ".framepilot-derived" / "proj_1" / "brain.sqlite"
        assert store.path.exists()


def test_brain_dir_rejects_traversal_project_id(tmp_path: Path) -> None:
    with pytest.raises(PathTraversalError):
        brain_dir_for(tmp_path, "../../etc")


def test_fts5_availability_probe_and_tables(store: BrainStore) -> None:
    # CPython's bundled SQLite on our runtimes ships FTS5; the degraded branch
    # is covered separately by monkeypatching the probe.
    assert store.fts_available is True
    tables = {
        r[0]
        for r in store._conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
        ).fetchall()
    }
    assert {"transcript_fts", "markers_fts"} <= tables


def test_fts5_unavailable_degrades_honestly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(brain_migrations, "fts5_available", lambda _conn: False)
    with BrainStore.open(tmp_path / "brain.sqlite", clock=fixed_clock()) as store:
        assert store.fts_available is False
        assert store.status().fts5_available is False


def test_fts5_probe_reports_false_when_module_missing(tmp_path: Path) -> None:
    conn = sqlite3.connect(tmp_path / "probe.sqlite")

    class _Failing:
        def execute(self, sql: str) -> sqlite3.Cursor:  # duck-typed shim for the probe
            if "fts5" in sql:
                raise sqlite3.OperationalError("no such module: fts5")
            return conn.execute(sql)

    assert fts5_available(_Failing()) is False  # type: ignore[arg-type]
    assert ensure_fts_tables(_Failing()) is False  # type: ignore[arg-type]
    conn.close()


def test_migrate_is_forward_only_and_reports_version(tmp_path: Path) -> None:
    conn = sqlite3.connect(tmp_path / "raw.sqlite")
    assert migrate(conn) == SCHEMA_VERSION
    assert migrate(conn) == SCHEMA_VERSION  # already current: no-op
    conn.close()


# --- assets -------------------------------------------------------------------


def test_upsert_asset_insert_then_update_preserves_created_at(store: BrainStore) -> None:
    created = store.upsert_asset("a1", path="media/clip.mp4", content_sha256="abc")
    assert created.created_at == created.updated_at
    updated = store.upsert_asset(
        "a1", path="media/clip.mp4", content_sha256="def", probe={"durationSeconds": 3.5}
    )
    assert updated.created_at == created.created_at
    assert updated.updated_at > created.updated_at
    assert updated.content_sha256 == "def"
    assert updated.probe == {"durationSeconds": 3.5}


def test_get_asset_missing_returns_none(store: BrainStore) -> None:
    assert store.get_asset("nope") is None


def test_list_assets_is_ordered_by_id(store: BrainStore) -> None:
    store.upsert_asset("b", path="b.mp4")
    store.upsert_asset("a", path="a.mp4")
    assert [a.id for a in store.list_assets()] == ["a", "b"]


# --- analysis results ----------------------------------------------------------


def test_record_and_list_analysis_with_filters(store: BrainStore) -> None:
    store.upsert_asset("a1", path="a.mp4")
    row = store.record_analysis(
        "a1",
        kind="silence",
        depth="quick",
        params_hash="h1",
        result={"ranges": [[0.0, 1.5]]},
        tool="ffmpeg-silencedetect@8",
    )
    assert row.source is Provenance.MACHINE
    store.record_analysis(
        "a1", kind="scenes", depth="standard", params_hash="h2", result={}, tool="t"
    )
    assert len(store.list_analysis()) == 2
    assert len(store.list_analysis("a1", kind="silence")) == 1
    assert store.list_analysis("other") == []
    assert store.list_analysis(kind="scenes")[0].kind == "scenes"


def test_record_analysis_same_key_upserts(store: BrainStore) -> None:
    store.upsert_asset("a1", path="a.mp4")
    store.record_analysis(
        "a1", kind="silence", depth="quick", params_hash="h", result={"v": 1}, tool="t"
    )
    store.record_analysis(
        "a1", kind="silence", depth="quick", params_hash="h", result={"v": 2}, tool="t"
    )
    rows = store.list_analysis("a1")
    assert len(rows) == 1
    assert rows[0].result == {"v": 2}


def test_get_analysis_cache_lookup(store: BrainStore) -> None:
    store.upsert_asset("a1", path="a.mp4")
    store.record_analysis(
        "a1", kind="silence", depth="quick", params_hash="h", result={"v": 1}, tool="t"
    )
    hit = store.get_analysis("a1", kind="silence", params_hash="h")
    assert hit is not None and hit.result == {"v": 1}
    # Any component of the key differing is a miss.
    assert store.get_analysis("a1", kind="silence", params_hash="other") is None
    assert store.get_analysis("a1", kind="scenes", params_hash="h") is None
    assert store.get_analysis("a2", kind="silence", params_hash="h") is None


def test_get_analysis_ignores_depth_deterministically(store: BrainStore) -> None:
    # The same computation recorded under two tiers serves one deterministic row.
    store.upsert_asset("a1", path="a.mp4")
    store.record_analysis(
        "a1", kind="silence", depth="quick", params_hash="h", result={"v": 1}, tool="t"
    )
    store.record_analysis(
        "a1", kind="silence", depth="deep", params_hash="h", result={"v": 1}, tool="t"
    )
    hit = store.get_analysis("a1", kind="silence", params_hash="h")
    assert hit is not None and hit.depth == "deep"  # ORDER BY depth


# --- provenance-guarded fields (B0.2) -------------------------------------------


def test_write_field_appends_changelog_with_old_value(store: BrainStore) -> None:
    first = store.write_field(
        "asset", "a1", "label", "sunset", source=Provenance.MACHINE, actor="probe@1"
    )
    assert first.written is True and first.conflict is None
    second = store.write_field(
        "asset", "a1", "label", "beach sunset", source=Provenance.MODEL, actor="claude"
    )
    assert second.written is True
    log = store.changelog("asset", "a1")
    assert [(e.old_value, e.new_value) for e in log] == [
        (None, "sunset"),
        ("sunset", "beach sunset"),
    ]
    assert log[1].source is Provenance.MODEL


def test_machine_cannot_overwrite_human(store: BrainStore) -> None:
    store.write_field("asset", "a1", "label", "my dog", source=Provenance.HUMAN, actor="user")
    refused = store.write_field(
        "asset", "a1", "label", "a dog", source=Provenance.MACHINE, actor="tool"
    )
    assert refused.written is False
    assert refused.conflict is not None
    assert refused.conflict.existing_source is Provenance.HUMAN
    assert refused.conflict.attempted_source is Provenance.MACHINE
    # The refused write left value and changelog untouched.
    field = store.get_field("asset", "a1", "label")
    assert field is not None and field.value == "my dog"
    assert len(store.changelog("asset", "a1")) == 1


def test_model_cannot_overwrite_human_but_human_can(store: BrainStore) -> None:
    store.write_field("asset", "a1", "label", "v1", source=Provenance.HUMAN, actor="user")
    assert (
        store.write_field("asset", "a1", "label", "v2", source=Provenance.MODEL, actor="m").written
        is False
    )
    replaced = store.write_field(
        "asset", "a1", "label", "v3", source=Provenance.HUMAN, actor="user"
    )
    assert replaced.written is True
    field = store.get_field("asset", "a1", "label")
    assert field is not None and field.value == "v3"


def test_get_field_missing_and_list_fields_filters(store: BrainStore) -> None:
    assert store.get_field("asset", "a1", "nope") is None
    store.write_field("asset", "a1", "f1", 1, source=Provenance.MACHINE, actor="t")
    store.write_field("frame", "fr1", "f2", 2, source=Provenance.MACHINE, actor="t")
    assert len(store.list_fields()) == 2
    assert [f.field for f in store.list_fields("asset")] == ["f1"]
    assert [f.field for f in store.list_fields("frame", "fr1")] == ["f2"]
    assert store.changelog() and len(store.changelog("asset")) == 1


def test_provenance_property_randomized_sequences(tmp_path: Path) -> None:
    """Property (B0.2): after any write sequence, a human value survives every
    non-human write attempt, and the changelog records exactly the accepted writes."""
    rng = random.Random(1234)
    for round_no in range(20):
        with BrainStore.open(tmp_path / f"prop_{round_no}.sqlite", clock=fixed_clock()) as store:
            expected_value: object | None = None
            expected_source: Provenance | None = None
            accepted = 0
            for i in range(rng.randint(1, 30)):
                source = rng.choice(list(Provenance))
                result = store.write_field("asset", "a1", "label", i, source=source, actor="prop")
                should_accept = (
                    expected_source is not Provenance.HUMAN or source is Provenance.HUMAN
                )
                assert result.written is should_accept
                if should_accept:
                    expected_value, expected_source = i, source
                    accepted += 1
            field = store.get_field("asset", "a1", "label")
            assert field is not None
            assert field.value == expected_value
            assert field.source is expected_source
            assert len(store.changelog("asset", "a1")) == accepted


# --- jobs journal ----------------------------------------------------------------


def test_job_lifecycle_and_listing(store: BrainStore) -> None:
    job = store.create_job("j1", kind="analyze", payload={"assetId": "a1"})
    assert job.state is JobState.QUEUED and job.progress == 0.0
    running = store.update_job("j1", state=JobState.RUNNING, progress=0.5)
    assert running.state is JobState.RUNNING and running.progress == 0.5
    failed = store.update_job("j1", state=JobState.FAILED, error="ffmpeg exploded")
    assert failed.error == "ffmpeg exploded"
    store.create_job("j2", kind="analyze", payload={})
    assert [j.id for j in store.list_jobs()] == ["j1", "j2"]
    assert [j.id for j in store.list_jobs(state=JobState.QUEUED)] == ["j2"]


def test_update_unknown_job_raises(store: BrainStore) -> None:
    with pytest.raises(BrainError, match="No brain job"):
        store.update_job("ghost", state=JobState.DONE)


def test_update_job_advances_resumable_cursor_in_payload(store: BrainStore) -> None:
    store.create_job("batch", kind="analyze-batch", payload={"assetIds": ["a", "b"], "cursor": 0})
    # A slice advances the cursor; state/progress default to their current values.
    after_first = store.update_job(
        "batch", progress=0.5, payload={"assetIds": ["a", "b"], "cursor": 1}
    )
    assert after_first.payload["cursor"] == 1 and after_first.state is JobState.QUEUED
    # Omitting payload leaves the persisted cursor untouched.
    running = store.update_job("batch", state=JobState.RUNNING)
    assert running.payload["cursor"] == 1 and running.state is JobState.RUNNING


def test_mark_interrupted_flags_only_non_terminal_jobs(store: BrainStore) -> None:
    store.create_job("q", kind="analyze", payload={})
    store.create_job("r", kind="analyze", payload={})
    store.update_job("r", state=JobState.RUNNING)
    store.create_job("d", kind="analyze", payload={})
    store.update_job("d", state=JobState.DONE)
    assert store.mark_interrupted_jobs() == 2
    assert {j.id for j in store.list_jobs(state=JobState.INTERRUPTED)} == {"q", "r"}
    done = store.get_job("d")
    assert done is not None and done.state is JobState.DONE
    assert store.get_job("ghost") is None


# --- frames ----------------------------------------------------------------------


def test_record_and_list_frames(store: BrainStore) -> None:
    store.upsert_asset("a1", path="a.mp4")
    store.record_frame("a1", ts_seconds=2.0, path="frames/a1/2.jpg")
    store.record_frame("a1", ts_seconds=1.0, path="frames/a1/1.jpg")
    frames = store.list_frames("a1")
    assert [f.ts_seconds for f in frames] == [1.0, 2.0]
    assert frames[0].purpose == "vision"
    assert len(store.list_frames()) == 2
    assert store.list_frames("other") == []


# --- status / brain_status ---------------------------------------------------------


def test_status_reports_counts(store: BrainStore) -> None:
    store.upsert_asset("a1", path="a.mp4")
    store.record_analysis("a1", kind="silence", depth="quick", params_hash="h", result={}, tool="t")
    status = store.status()
    assert status.available and status.exists
    assert status.schema_version == SCHEMA_VERSION
    assert status.counts["assets"] == 1
    assert status.counts["analysis_results"] == 1
    assert status.counts["embeddings"] == 0


def test_brain_status_without_projects_root_is_unavailable() -> None:
    status = brain_status(None, "p1")
    assert status.available is False and status.exists is False
    assert status.reason is not None and "projects_root" in status.reason


def test_brain_status_traversal_project_id_is_unavailable(tmp_path: Path) -> None:
    status = brain_status(tmp_path, "../../etc")
    assert status.available is False
    assert status.reason is not None and "escapes sandbox" in status.reason


def test_brain_status_missing_file_reports_not_exists(tmp_path: Path) -> None:
    status = brain_status(tmp_path, "p1")
    assert status.available is False and status.exists is False
    assert status.reason is not None and "does not exist" in status.reason


def test_brain_status_healthy_and_corrupt(tmp_path: Path) -> None:
    with open_brain(tmp_path, "p1", clock=fixed_clock()) as store:
        store.upsert_asset("a1", path="a.mp4")
    healthy = brain_status(tmp_path, "p1")
    assert healthy.available is True and healthy.counts["assets"] == 1

    db = brain_dir_for(tmp_path, "p2") / "brain.sqlite"
    db.parent.mkdir(parents=True)
    db.write_text("corrupt")
    broken = brain_status(tmp_path, "p2")
    assert broken.available is False and broken.exists is True
    assert broken.reason is not None
