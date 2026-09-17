"""Decoded-frame hashes and locked-frame comparison for the desktop host (BR4.13)."""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from framepilot_engine.config import Settings
from framepilot_engine.render.frame_hashes import (
    FrameHashError,
    compare_locked_frames,
    frame_hashes_by_index,
    frame_hashes_by_pts,
)
from framepilot_engine.render.mattes import MATTE_FILE
from framepilot_engine.render.pts_reader import video_timing
from framepilot_engine.service import create_app
from tests.matte_fixtures import encode_ffv1, level_frames


def _pixels_sha(level: int, width: int = 64, height: int = 36) -> str:
    return hashlib.sha256(np.full((height, width), level, dtype=np.uint8).tobytes()).hexdigest()


def _matte(directory: Path, count: int = 6, levels: list[int] | None = None) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / MATTE_FILE
    frames = (
        level_frames(count)
        if levels is None
        else [np.full((36, 64), level, dtype=np.uint8) for level in levels]
    )
    encode_ffv1(path, frames, "gray", "gray")
    return path


def test_hashes_by_index_equal_raw_pixel_sha(tmp_path: Path) -> None:
    matte = _matte(tmp_path, levels=[10, 20, 30, 40])
    assert frame_hashes_by_index(matte, [3, 1]) == [_pixels_sha(40), _pixels_sha(20)]
    with pytest.raises(FrameHashError):
        frame_hashes_by_index(matte, [9])
    with pytest.raises(ValueError):
        frame_hashes_by_index(matte, [-1])


def test_hashes_by_pts_are_exact_and_none_for_absent_frames(tmp_path: Path) -> None:
    matte = _matte(tmp_path, levels=[10, 20, 30, 40])
    timing = video_timing(matte)
    hashes = frame_hashes_by_pts(matte, [timing.pts[2], timing.pts[0], timing.pts[2] + 1], "gray")
    assert hashes[0] == _pixels_sha(30)
    assert hashes[1] == _pixels_sha(10)
    assert hashes[2] is None


def test_compare_locked_frames_against_inputs_and_previous(tmp_path: Path) -> None:
    previous = _matte(tmp_path / "prev", levels=[10, 20, 30])
    new = _matte(tmp_path / "new", levels=[11, 20, 30])
    result = compare_locked_frames(
        new, [(1, _pixels_sha(20)), (0, _pixels_sha(10))], previous, [(2, 2), (0, 0)]
    )
    assert result.expected == [True, False]
    assert result.carried == [True, False]
    with pytest.raises(ValueError):
        compare_locked_frames(new, [], None, [(0, 0)])


def _client(root: Path) -> TestClient:
    return TestClient(create_app(Settings(projects_root=root)))


def test_routes_hash_and_compare_inside_the_projects_root(tmp_path: Path) -> None:
    matte = _matte(
        tmp_path / "project" / ".framepilot-derived" / "mattes" / ("a" * 64), levels=[10, 20]
    )
    client = _client(tmp_path)
    timing = video_timing(matte)
    resp = client.post(
        "/mattes/frame-hashes",
        json={"input_path": str(matte), "pts": [timing.pts[1]], "pixel_format": "gray"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"hashes": [_pixels_sha(20)]}
    resp = client.post(
        "/mattes/locked-frames",
        json={"matte_path": str(matte), "expected": [{"index": 0, "sha256": _pixels_sha(10)}]},
    )
    assert resp.json() == {"expected": [True], "carried": []}


def test_routes_refuse_escapes_other_files_and_oversized_requests(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = _matte(tmp_path / "outside")
    client = _client(root)
    assert (
        client.post(
            "/mattes/frame-hashes", json={"input_path": str(outside), "pts": [0]}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/mattes/frame-hashes",
            json={"input_path": str(root / "../outside/matte.mkv"), "pts": [0]},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/mattes/frame-hashes", json={"input_path": str(root / "x.mp4"), "pts": [0]}
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/mattes/frame-hashes",
            json={"input_path": str(root / "x.mp4"), "pts": list(range(257))},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/mattes/frame-hashes", json={"input_path": "x", "pts": [0], "extra": 1}
        ).status_code
        == 422
    )
    other = root / "notes.txt"
    other.write_text("x")
    assert client.post("/mattes/locked-frames", json={"matte_path": str(other)}).status_code == 400
    inside = _matte(root / "m")
    assert (
        client.post(
            "/mattes/locked-frames",
            json={"matte_path": str(inside), "carried": [{"index": 0, "previous_index": 0}]},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/mattes/locked-frames",
            json={"matte_path": str(inside), "expected": [{"index": 0, "sha256": "zz"}]},
        ).status_code
        == 422
    )


def test_routes_refuse_without_a_projects_root(tmp_path: Path) -> None:
    matte = _matte(tmp_path)
    client = TestClient(create_app(Settings(projects_root=None)))
    assert (
        client.post("/mattes/frame-hashes", json={"input_path": str(matte), "pts": [0]}).status_code
        == 503
    )
