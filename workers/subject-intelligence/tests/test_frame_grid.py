"""Decoded frames land on the REQUEST's frame grid, not the file's.

The host numbers frames on the project frame rate; it does not know the file's.
Request frame ``n`` is source time ``n / fps``. Each file frame's own index is
encoded in its brightness and decoded through the real reader, which must return
the frame on screen at each grid time for files faster and slower than the grid.
Needs only OpenCV, not the pinned models.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("cv2", reason="the decoded-media tier needs the cv extra")

import cv2
import numpy as np

from framepilot_subject_intelligence.opencv_backend import _VideoFrameSource

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


def _file_indices(path: Path, first: int, last: int, fps: float | None) -> list[int]:
    source = _VideoFrameSource(cv2, str(path), first, last, fps)
    indices: list[int] = []
    try:
        while (frame := source.read()) is not None:
            indices.append(round(float(frame.mean()) / STEP))
    finally:
        source.close()
    return indices


def test_a_faster_file_is_sampled_at_the_grid_times(tmp_path: Path) -> None:
    path = _write(tmp_path / "sixty.avi", 60.0, 50)
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
