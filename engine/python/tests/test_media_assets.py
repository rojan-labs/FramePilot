"""Tests for the sandboxed asset indexer (media.assets)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from framepilot_engine.media.assets import index_assets


def test_index_resolves_existing_asset(tmp_project_dir: Path) -> None:
    (tmp_project_dir / "media").mkdir()
    asset = tmp_project_dir / "media" / "intro.mp4"
    asset.write_bytes(b"\x00")

    index = index_assets(
        [{"id": "a1", "path": "media/intro.mp4", "kind": "video"}], tmp_project_dir
    )
    entry = index.by_id("a1")
    assert entry is not None
    assert entry.ok and entry.within_sandbox and entry.exists
    assert entry.kind == "video"
    assert entry.resolved_path == str(asset.resolve())
    assert index.ok and index.missing == []


def test_index_flags_missing_file(tmp_project_dir: Path) -> None:
    index = index_assets([{"id": "a1", "path": "media/gone.mp4"}], tmp_project_dir)
    entry = index.by_id("a1")
    assert entry is not None
    assert entry.within_sandbox and not entry.exists and not entry.ok
    assert entry.error == "Asset file does not exist."
    assert index.missing == [entry] and not index.ok


def test_index_flags_path_traversal(tmp_project_dir: Path) -> None:
    index = index_assets([{"id": "evil", "path": "../../etc/passwd"}], tmp_project_dir)
    entry = index.by_id("evil")
    assert entry is not None
    assert not entry.within_sandbox and not entry.ok
    assert entry.resolved_path is None
    assert entry.error is not None and "escapes sandbox" in entry.error


def test_by_id_returns_none_for_unknown(tmp_project_dir: Path) -> None:
    index = index_assets([], tmp_project_dir)
    assert index.by_id("missing") is None
    assert index.ok  # vacuously true with no assets


def test_index_probes_when_requested(
    tmp_project_dir: Path, media_factory: Callable[..., Path], require_ffprobe: None
) -> None:
    generated = media_factory("indexed.mp4", seconds=1.0)
    asset_path = tmp_project_dir / "indexed.mp4"
    asset_path.write_bytes(generated.read_bytes())

    index = index_assets([{"id": "a1", "path": "indexed.mp4"}], tmp_project_dir, probe=True)
    entry = index.by_id("a1")
    assert entry is not None and entry.media is not None
    assert entry.media.has_video


def test_index_skips_probe_for_missing_even_if_requested(tmp_project_dir: Path) -> None:
    index = index_assets([{"id": "a1", "path": "nope.mp4"}], tmp_project_dir, probe=True)
    entry = index.by_id("a1")
    assert entry is not None and entry.media is None
