"""Decoded-frame hashes and locked-frame comparison for the desktop host (BR4.13)."""

from __future__ import annotations

import hashlib
import subprocess
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


# --- BR4.12 M3: hardened ffmpeg, busy, deadline, bounds, no paths in errors --------------------


def test_every_decode_is_hardened(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from framepilot_engine.media import untrusted

    matte = _matte(tmp_path, levels=[10, 20])
    seen: list[list[str]] = []
    real_run = subprocess.run

    def spy(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        seen.append(list(argv))
        return real_run(argv, **kwargs)  # type: ignore[call-overload,no-any-return]

    monkeypatch.setattr(subprocess, "run", spy)
    frame_hashes_by_index(matte, [1])
    frame_hashes_by_pts(matte, [video_timing(matte).pts[0]], "gray")
    # This module's own calls: the container gate and every decode. (The pts listing that follows
    # the gate is the export's shared reader, reached only once the container is allowed.)
    own = [argv for argv in seen if "framehash" in argv or "format=format_name" in argv]
    assert any("format=format_name" in argv for argv in own)
    for argv in own:
        joined = " ".join(argv)
        assert "-protocol_whitelist file" in joined
        assert "-format_whitelist" in joined
    decodes = [argv for argv in seen if "framehash" in argv]
    assert decodes
    for argv in decodes:
        joined = " ".join(argv)
        assert f"-max_pixels {untrusted.MAX_PIXELS}" in joined
        assert f"-threads {untrusted.DECODE_THREADS}" in joined
        # matte.mkv is always read with the Matroska demuxer, never probed into something else.
        forced = [i for i in range(len(argv) - 1) if argv[i] == "-f" and argv[i + 1] == "matroska"]
        assert forced and forced[0] < argv.index("-i")


def test_a_playlist_renamed_to_a_video_extension_cannot_open_another_file(tmp_path: Path) -> None:
    source = _matte(tmp_path / "real", levels=[10, 20])
    renamed = tmp_path / "clip.mp4"
    renamed.write_text(f"ffconcat version 1.0\nfile '{source}'\n", encoding="utf-8")
    with pytest.raises(FrameHashError):
        frame_hashes_by_pts(renamed, [0])
    playlist = tmp_path / "clip2.mov"
    playlist.write_text(f"#EXTM3U\n#EXTINF:1,\n{source}\n#EXT-X-ENDLIST\n", encoding="utf-8")
    with pytest.raises(FrameHashError):
        frame_hashes_by_pts(playlist, [0])


def test_routes_answer_busy_while_one_check_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading

    import framepilot_engine.service as service

    matte = _matte(tmp_path / "p", levels=[10])
    entered = threading.Event()
    release = threading.Event()

    def slow(*_args: object, **_kwargs: object) -> list[str | None]:
        entered.set()
        release.wait(5)
        return [None]

    monkeypatch.setattr(service, "frame_hashes_by_pts", slow)
    client = _client(tmp_path)
    results: list[int] = []
    worker = threading.Thread(
        target=lambda: results.append(
            client.post(
                "/mattes/frame-hashes", json={"input_path": str(matte), "pts": [0]}
            ).status_code
        )
    )
    worker.start()
    assert entered.wait(5)
    busy = client.post("/mattes/frame-hashes", json={"input_path": str(matte), "pts": [0]})
    assert busy.status_code == 503
    release.set()
    worker.join(5)
    assert results == [200]


def test_routes_enforce_a_total_deadline_and_int64_bounds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import framepilot_engine.service as service

    matte = _matte(tmp_path / "p", levels=[10, 20])
    client = _client(tmp_path)
    monkeypatch.setattr(service, "MATTE_ROUTE_DEADLINE_SECONDS", -1.0)
    monkeypatch.setattr(service, "MATTE_DEADLINE_PER_PTS_SECONDS", 0.0)
    monkeypatch.setattr(service, "MATTE_DEADLINE_PER_FRAME_SECONDS", 0.0)
    timed_out = client.post("/mattes/frame-hashes", json={"input_path": str(matte), "pts": [0]})
    assert timed_out.status_code == 504
    locked = client.post(
        "/mattes/locked-frames",
        json={"matte_path": str(matte), "expected": [{"index": 0, "sha256": "a" * 64}]},
    )
    assert locked.status_code == 504
    assert (
        client.post(
            "/mattes/frame-hashes", json={"input_path": str(matte), "pts": [2**60]}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/mattes/locked-frames",
            json={"matte_path": str(matte), "expected": [{"index": 2**40, "sha256": "a" * 64}]},
        ).status_code
        == 422
    )


def test_route_errors_never_echo_a_path(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    secret = tmp_path / "Client Secret Film" / "matte.mkv"
    _matte(secret.parent)
    garbage = root / "matte.mkv"
    garbage.write_bytes(b"\x1aE\xdf\xa3 not really matroska")
    client = _client(root)
    for body in (
        client.post("/mattes/frame-hashes", json={"input_path": str(secret), "pts": [0]}).text,
        client.post(
            "/mattes/locked-frames",
            json={"matte_path": str(garbage), "expected": [{"index": 0, "sha256": "a" * 64}]},
        ).text,
        client.post("/mattes/frame-hashes", json={"input_path": str(garbage), "pts": [0]}).text,
    ):
        assert "Client Secret Film" not in body
        assert str(tmp_path) not in body


def test_deadline_grows_with_the_work_and_is_capped() -> None:
    import framepilot_engine.service as service

    base = service.matte_route_deadline()
    assert service.matte_route_deadline(pts_count=18) == base + 18 * 30.0
    # A two-hour 30 fps matte locked near its end still gets time to decode forward to it.
    assert service.matte_route_deadline(highest_frame=216_000) >= base + 216_000 * 0.05
    assert service.matte_route_deadline(highest_frame=10**9) == service.MATTE_DEADLINE_MAX_SECONDS
