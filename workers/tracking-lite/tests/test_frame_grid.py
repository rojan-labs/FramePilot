"""Decoded frames land on the REQUEST's frame grid, not the file's.

The host numbers frames on the project frame rate; it does not know the file's.
Request frame ``n`` is source time ``n / fps``. These tests encode each file
frame's own index into its brightness, decode through the real OpenCV reader,
and require the frame on screen at each grid time — for files faster and slower
than the grid — plus a range that stops honestly at the end of the media.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

pytest.importorskip("cv2", reason="decoded-media proof requires the `cv` extra")

import cv2
import numpy as np

from framepilot_tracking_lite.opencv_backend import DecodedFrame, OpenCvBackend

pytestmark = pytest.mark.decoded_media

WIDTH, HEIGHT = 64, 48
STEP = 5


def _write(path: Path, fps: float, count: int) -> Path:
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, (WIDTH, HEIGHT))
    assert writer.isOpened()
    for index in range(count):
        writer.write(np.full((HEIGHT, WIDTH, 3), index * STEP, dtype=np.uint8))
    writer.release()
    return path


def _file_indices(
    path: Path, first: int, last: int, fps: float | None
) -> list[int]:
    source = OpenCvBackend().open_frames(str(path), first, last, fps)
    indices: list[int] = []
    try:
        while (frame := source.read()) is not None:
            assert isinstance(frame, DecodedFrame)
            indices.append(round(float(frame.gray.mean()) / STEP))
    finally:
        source.close()
    return indices


def test_a_faster_file_is_sampled_at_the_grid_times(tmp_path: Path) -> None:
    path = _write(tmp_path / "sixty.avi", 60.0, 50)
    # Grid frames 10..24 at 30 fps are 0.333s..0.8s: file frames 20..48 at 60 fps.
    assert _file_indices(path, 10, 25, 30.0) == [2 * n for n in range(10, 25)]


def test_a_slower_file_holds_the_frame_on_screen(tmp_path: Path) -> None:
    path = _write(tmp_path / "fifteen.avi", 15.0, 30)
    assert _file_indices(path, 10, 20, 30.0) == [n // 2 for n in range(10, 20)]


def test_the_range_stops_at_the_end_of_the_media(tmp_path: Path) -> None:
    path = _write(tmp_path / "short.avi", 30.0, 20)
    assert _file_indices(path, 15, 40, 30.0) == [15, 16, 17, 18, 19]


def test_without_a_grid_rate_the_file_index_is_used(tmp_path: Path) -> None:
    path = _write(tmp_path / "legacy.avi", 60.0, 20)
    assert _file_indices(path, 5, 8, None) == [5, 6, 7]


# --- variable-frame-rate: the file has no single nominal fps -------------


def _write_from(path: Path, fps: float, start: int, count: int) -> Path:
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (WIDTH, HEIGHT))
    assert writer.isOpened()
    for offset in range(count):
        index = start + offset
        writer.write(np.full((HEIGHT, WIDTH, 3), index * STEP, dtype=np.uint8))
    writer.release()
    return path


def _build_vfr_fixture(tmp_path: Path) -> Path:
    """A 30fps segment (15 frames) followed by a 15fps segment (15 frames), spliced
    so the combined file's real per-frame timestamps are genuinely piecewise —
    30 then 15 fps — rather than one nominal rate. `ffmpeg`'s concat filter with
    `-fps_mode vfr` keeps each input's own frame timing instead of resampling to a
    constant rate, and MJPEG-in-Matroska preserves that timing on readback.
    """
    seg1 = tmp_path / "seg1.mp4"
    seg2 = tmp_path / "seg2.mp4"
    _write_from(seg1, 30.0, start=0, count=15)
    _write_from(seg2, 15.0, start=15, count=15)
    out = tmp_path / "vfr.mkv"
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(seg1),
            "-i",
            str(seg2),
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1:a=0[outv]",
            "-map",
            "[outv]",
            "-fps_mode",
            "vfr",
            "-c:v",
            "mjpeg",
            "-q:v",
            "2",
            str(out),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return out


def _probe_real_timestamps(path: Path) -> list[tuple[int, float]]:
    """Ground truth: every real decoded frame's own (index, presentation seconds),
    read straight off the file with no grid involved."""
    capture = cv2.VideoCapture(str(path))
    truth: list[tuple[int, float]] = []
    try:
        while True:
            ok, frame = capture.read()
            if not ok or frame is None:
                break
            index = round(float(frame.mean()) / STEP)
            seconds = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            truth.append((index, seconds))
    finally:
        capture.release()
    return truth


def _expected_hold_sequence(
    truth: list[tuple[int, float]], grid_fps: float, count: int
) -> list[tuple[int, float]]:
    """What a correct grid-fps reader must return: for each grid time n/grid_fps,
    the most recent real frame at or before that time (a plain "as of" join
    against the ground-truth timestamps)."""
    expected: list[tuple[int, float]] = []
    cursor = 0
    for n in range(count):
        target = n / grid_fps
        while cursor + 1 < len(truth) and truth[cursor + 1][1] <= target + 1e-6:
            cursor += 1
        if truth[cursor][1] > target + 1e-6:
            break
        expected.append(truth[cursor])
    return expected


def test_variable_frame_rate_is_sampled_by_real_timestamp_not_nominal_index(
    tmp_path: Path,
) -> None:
    """The old sampler walked file frames one-by-one and compared their ORDINAL
    against `target_seconds * file_fps`, using cv2's single nominal fps for the
    whole file. A VFR file has no single nominal fps, so that comparison silently
    samples the wrong instant once playback crosses into the slower segment. The
    fix compares each decoded frame's own presentation timestamp instead, which is
    what this test pins down against an independently probed ground truth.
    """
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg is not available to build the VFR fixture")
    path = _build_vfr_fixture(tmp_path)
    truth = _probe_real_timestamps(path)
    assert len(truth) == 30, "fixture must decode to 15 + 15 real frames"
    # The real per-frame gaps are piecewise 1/30 then 1/15 even though the
    # container reports a single nominal fps for the whole file — that single
    # number is exactly what the old index-counting sampler trusted.
    assert truth[1][1] - truth[0][1] == pytest.approx(1 / 30.0, abs=1e-3)
    assert truth[-1][1] - truth[-2][1] == pytest.approx(1 / 15.0, abs=1e-3)

    grid_fps = 20.0
    request_count = 24
    expected = _expected_hold_sequence(truth, grid_fps, request_count)

    source = OpenCvBackend().open_frames(str(path), 0, request_count, grid_fps)
    actual: list[int] = []
    try:
        while (frame := source.read()) is not None:
            assert isinstance(frame, DecodedFrame)
            actual.append(round(float(frame.gray.mean()) / STEP))
    finally:
        source.close()

    assert actual == [index for index, _seconds in expected]
    frame_tolerance = 1e-3  # absorbs float rounding in the encoder/decoder round trip
    for n, (_index, seconds) in enumerate(expected):
        target = n / grid_fps
        local_frame_seconds = 1 / 30.0 if target < 0.5 else 1 / 15.0
        assert -frame_tolerance <= target - seconds < local_frame_seconds + frame_tolerance
