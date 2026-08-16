"""Tests for the brain JSON sidecar export/import (plan B0.3).

The headline property: sidecars are deterministic and the brain is
rebuildable — delete ``brain.sqlite``, import the sidecars into a fresh
store, re-export, and the bytes are identical.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from framepilot_engine.brain import BrainError, BrainStore, Provenance
from framepilot_engine.brain.sidecars import (
    SIDECAR_SCHEMA_VERSION,
    export_all_sidecars,
    export_asset_sidecar,
    import_sidecars,
    sidecar_path,
)
from framepilot_engine.safety import PathTraversalError


def fixed_clock(
    start: datetime | None = None, step_seconds: float = 1.0
) -> Callable[[], datetime]:
    """A deterministic clock that advances by ``step_seconds`` per call."""
    state = {"now": start or datetime(2026, 7, 14, 12, 0, 0, tzinfo=UTC)}

    def _clock() -> datetime:
        current = state["now"]
        state["now"] = current + timedelta(seconds=step_seconds)
        return current

    return _clock


@pytest.fixture
def brain_dir(tmp_path: Path) -> Path:
    d = tmp_path / ".framepilot-derived" / "proj_1"
    d.mkdir(parents=True)
    return d


def populate(store: BrainStore) -> None:
    """Write a representative slice of every exported row kind."""
    store.upsert_asset(
        "asset_1", path="media/a.mp4", content_sha256="c0ffee", probe={"durationSeconds": 9.5}
    )
    store.upsert_asset("asset_2", path="media/b.wav")
    store.record_analysis(
        "asset_1",
        kind="silence",
        depth="quick",
        params_hash="h1",
        result={"ranges": [[0.0, 1.25]]},
        tool="ffmpeg-silencedetect@8",
    )
    store.write_field(
        "asset", "asset_1", "label", "intro take", source=Provenance.HUMAN, actor="user"
    )
    store.write_field(
        "asset", "asset_1", "shotType", "wide", source=Provenance.MODEL, actor="claude"
    )
    store.record_frame("asset_1", ts_seconds=3.0, path="frames/asset_1/3.jpg")


def test_export_writes_canonical_json(brain_dir: Path) -> None:
    with BrainStore.open(brain_dir / "brain.sqlite", clock=fixed_clock()) as store:
        populate(store)
        path = export_asset_sidecar(store, brain_dir, "asset_1")
    assert path == brain_dir / "sidecars" / "asset_1" / "analysis.json"
    text = path.read_text(encoding="utf-8")
    assert text.endswith("\n")
    document = json.loads(text)
    assert document["schemaVersion"] == SIDECAR_SCHEMA_VERSION
    assert document["asset"]["contentSha256"] == "c0ffee"
    assert document["analysis"][0]["kind"] == "silence"
    assert {f["field"] for f in document["fields"]} == {"label", "shotType"}
    assert document["frames"][0]["tsSeconds"] == 3.0
    # Canonical: sorted keys make bytes deterministic.
    assert text == json.dumps(document, sort_keys=True, ensure_ascii=False, indent=2) + "\n"
    # Atomic: no temp files left behind.
    assert list(path.parent.glob(".analysis.json.*")) == []


def test_export_is_deterministic_across_calls(brain_dir: Path) -> None:
    with BrainStore.open(brain_dir / "brain.sqlite", clock=fixed_clock()) as store:
        populate(store)
        first = export_asset_sidecar(store, brain_dir, "asset_1").read_bytes()
        second = export_asset_sidecar(store, brain_dir, "asset_1").read_bytes()
    assert first == second


def test_export_unknown_asset_raises(brain_dir: Path) -> None:
    with (
        BrainStore.open(brain_dir / "brain.sqlite", clock=fixed_clock()) as store,
        pytest.raises(BrainError, match="not in the brain"),
    ):
        export_asset_sidecar(store, brain_dir, "ghost")


def test_export_failure_leaves_no_temp_file(
    brain_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A crash mid-write must not leave a truncated temp sidecar behind."""
    from framepilot_engine.brain import sidecars as sidecars_module

    def _boom(_sidecar: object) -> str:
        raise OSError("disk full")

    monkeypatch.setattr(sidecars_module, "_canonical_document", _boom)
    with BrainStore.open(brain_dir / "brain.sqlite", clock=fixed_clock()) as store:
        store.upsert_asset("asset_1", path="a.mp4")
        with pytest.raises(OSError, match="disk full"):
            export_asset_sidecar(store, brain_dir, "asset_1")
    parent = brain_dir / "sidecars" / "asset_1"
    assert not (parent / "analysis.json").exists()
    assert list(parent.glob(".analysis.json.*")) == []


def test_sidecar_path_rejects_traversal_asset_id(brain_dir: Path) -> None:
    with pytest.raises(PathTraversalError):
        sidecar_path(brain_dir, "../../../etc")


def test_rebuild_roundtrip_is_byte_identical(brain_dir: Path) -> None:
    """Plan B0.3 acceptance: delete brain → rebuild from sidecars → identical bytes."""
    db = brain_dir / "brain.sqlite"
    with BrainStore.open(db, clock=fixed_clock()) as store:
        populate(store)
        originals = {p: p.read_bytes() for p in export_all_sidecars(store, brain_dir)}
    assert len(originals) == 2

    db.unlink()  # the brain is a derived cache; deleting it loses time, not truth
    with BrainStore.open(db, clock=fixed_clock(datetime(2030, 1, 1, tzinfo=UTC))) as rebuilt:
        assert import_sidecars(rebuilt, brain_dir) == 2
        # Restored verbatim: original timestamps and provenance survive.
        asset = rebuilt.get_asset("asset_1")
        assert asset is not None and asset.created_at.startswith("2026-07-14")
        label = rebuilt.get_field("asset", "asset_1", "label")
        assert label is not None and label.source is Provenance.HUMAN
        # No changelog is fabricated by a rebuild.
        assert rebuilt.changelog() == []
        for path, original in originals.items():
            export_asset_sidecar(rebuilt, brain_dir, path.parent.name)
            assert path.read_bytes() == original


def test_import_skips_invalid_files_and_newer_schema(
    brain_dir: Path, caplog: pytest.LogCaptureFixture
) -> None:
    db = brain_dir / "brain.sqlite"
    with BrainStore.open(db, clock=fixed_clock()) as store:
        populate(store)
        export_all_sidecars(store, brain_dir)

    # Corrupt one sidecar and version-bump the other beyond this engine.
    corrupt = brain_dir / "sidecars" / "asset_1" / "analysis.json"
    corrupt.write_text("{not json", encoding="utf-8")
    newer_path = brain_dir / "sidecars" / "asset_2" / "analysis.json"
    newer = json.loads(newer_path.read_text(encoding="utf-8"))
    newer["schemaVersion"] = SIDECAR_SCHEMA_VERSION + 1
    newer_path.write_text(json.dumps(newer), encoding="utf-8")

    db.unlink()
    with BrainStore.open(db, clock=fixed_clock()) as rebuilt:
        with caplog.at_level("WARNING", logger="framepilot_engine.brain.sidecars"):
            assert import_sidecars(rebuilt, brain_dir) == 0
        assert rebuilt.list_assets() == []
    messages = " ".join(r.message for r in caplog.records)
    assert "invalid brain sidecar" in messages
    assert "newer than this engine" in messages


def test_import_with_no_sidecars_dir_returns_zero(brain_dir: Path) -> None:
    with BrainStore.open(brain_dir / "brain.sqlite", clock=fixed_clock()) as store:
        assert import_sidecars(store, brain_dir) == 0


def test_import_skips_symlink_escaping_sandbox(brain_dir: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "analysis.json").write_text("{}", encoding="utf-8")
    link_dir = brain_dir / "sidecars" / "evil"
    link_dir.parent.mkdir(parents=True, exist_ok=True)
    link_dir.symlink_to(outside, target_is_directory=True)
    with BrainStore.open(brain_dir / "brain.sqlite", clock=fixed_clock()) as store:
        assert import_sidecars(store, brain_dir) == 0
