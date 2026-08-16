"""Golden tests for frame decode + adaptive sampling (plan MI1.2, MI4.1).

The MI1.1 sampler golden was deferred until a decode path existed; it lives here.
A synthetic :data:`~framepilot_engine.visual_indexing.BytesRunner` returns canned
9x8 grids keyed off the ``-ss`` timestamp in the ffmpeg argv, so the whole
sample→hash→span fold runs deterministically without ffmpeg: a static shot
collapses to one span, a scene cut splits, and drifting content splits within a
scene.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest

from framepilot_engine import visual_indexing
from framepilot_engine.visual_indexing import (
    BytesRunner,
    FrameExtractionError,
    extract_keyframe_jpeg,
    grid_from_bytes,
    sample_asset,
)

_MEDIA = Path("/sandbox/clip.mp4")

# Two 9x8 grayscale grids with maximal dHash distance: a left→right ramp hashes
# to all-zero bits (never left>right), its reverse to all-one bits (hamming 64,
# far past the dedupe threshold), so they reliably start distinct spans.
_FLAT = bytes([0, 10, 20, 30, 40, 50, 60, 70, 80] * 8)
_OTHER = bytes([80, 70, 60, 50, 40, 30, 20, 10, 0] * 8)


def _runner(grids: dict[float, bytes]) -> BytesRunner:
    """A bytes runner that returns the canned grid for the argv's ``-ss`` time.

    ``-ss`` is omitted from the argv at t=0 (a still-image demuxer quirk on
    ffmpeg 8.1 — see ``_seek_args``), so a missing flag means t=0.0.
    """

    def run(argv: Sequence[str]) -> bytes:
        args = list(argv)
        t = float(args[args.index("-ss") + 1]) if "-ss" in args else 0.0
        return grids[t]

    return run


# --- grid reshape ---------------------------------------------------------------


def test_grid_from_bytes_reshapes_row_major() -> None:
    grid = grid_from_bytes(_FLAT)
    assert len(grid) == 8
    assert all(len(row) == 9 for row in grid)
    assert grid[0] == [0, 10, 20, 30, 40, 50, 60, 70, 80]


def test_grid_from_bytes_rejects_wrong_length() -> None:
    with pytest.raises(FrameExtractionError, match="72 grayscale bytes"):
        grid_from_bytes(b"\x00" * 71)


# --- sampling golden ------------------------------------------------------------


def test_static_shot_collapses_to_one_span() -> None:
    # 3s clip, no cuts → candidates [0, 1, 2]; identical grids → one span.
    grids = {0.0: _FLAT, 1.0: _FLAT, 2.0: _FLAT}
    spans = sample_asset(
        _MEDIA, duration_seconds=3.0, scene_cuts=[], runner=_runner(grids), ffmpeg="ffmpeg"
    )
    assert len(spans) == 1
    assert (spans[0].t0, spans[0].t1) == (0.0, 3.0)
    assert spans[0].frame_count == 3


def test_scene_cut_always_splits_even_on_identical_frames() -> None:
    # Cut at 1.5 → candidates [0, 1, 1.5, 2.5]; identical grids, but the boundary
    # forces a new span so a hit never straddles a cut.
    grids = {0.0: _FLAT, 1.0: _FLAT, 1.5: _FLAT, 2.5: _FLAT}
    spans = sample_asset(
        _MEDIA, duration_seconds=3.0, scene_cuts=[1.5], runner=_runner(grids), ffmpeg="ffmpeg"
    )
    assert [(s.t0, s.t1, s.scene_index) for s in spans] == [
        (0.0, 1.5, 0),
        (1.5, 3.0, 1),
    ]


def test_content_drift_splits_within_a_scene() -> None:
    # No cuts; the frame at t=2 is far from the span keyframe → a second span.
    grids = {0.0: _FLAT, 1.0: _FLAT, 2.0: _OTHER}
    spans = sample_asset(
        _MEDIA, duration_seconds=3.0, scene_cuts=[], runner=_runner(grids), ffmpeg="ffmpeg"
    )
    assert [(s.t0, s.t1) for s in spans] == [(0.0, 2.0), (2.0, 3.0)]


def test_image_is_a_single_zero_length_span() -> None:
    grids = {0.0: _OTHER}
    spans = sample_asset(
        _MEDIA,
        duration_seconds=0.0,
        scene_cuts=[],
        is_image=True,
        runner=_runner(grids),
        ffmpeg="ffmpeg",
    )
    assert len(spans) == 1
    assert (spans[0].t0, spans[0].t1) == (0.0, 0.0)
    # The photo was hashed, so a swapped file re-indexes (phash != 0).
    assert spans[0].phash != 0


def test_seek_args_omits_ss_at_zero_but_keeps_it_for_a_real_seek() -> None:
    """ffmpeg 8.1's ``image2`` demuxer returns 0 frames for ANY ``-ss`` before
    ``-i`` — including ``-ss 0`` — verified against a real still image; the
    identical command with ``-ss`` omitted decodes correctly. Still images
    always sample at t=0.0, so this must be dropped there but still emitted
    for a genuine (nonzero) video seek, where fast input-seeking matters.
    """
    assert visual_indexing._seek_args(0.0) == []
    assert visual_indexing._seek_args(0) == []
    assert visual_indexing._seek_args(1.5) == ["-ss", "1.5"]


def test_image_grid_extraction_never_emits_ss(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: an image-sampling argv must never include ``-ss``, since a
    still image always samples at t=0.0 — where ``-ss`` breaks decoding.
    """
    seen: list[list[str]] = []

    def runner(argv: Sequence[str]) -> bytes:
        seen.append(list(argv))
        return _OTHER

    sample_asset(
        _MEDIA, duration_seconds=0.0, scene_cuts=[], is_image=True, runner=runner, ffmpeg="ffmpeg"
    )
    assert len(seen) == 1
    assert "-ss" not in seen[0]


# --- keyframe extraction --------------------------------------------------------


def test_extract_keyframe_jpeg_returns_bytes() -> None:
    data = extract_keyframe_jpeg(
        _MEDIA, 1.0, runner=lambda argv: b"\xff\xd8jpeg", ffmpeg="ffmpeg"
    )
    assert data == b"\xff\xd8jpeg"


def test_extract_keyframe_jpeg_at_t0_omits_ss() -> None:
    """A keyframe requested at t=0.0 (an image's only frame) must not emit
    ``-ss`` either — the same ffmpeg 8.1 still-image quirk as grid extraction.
    """
    seen: list[list[str]] = []

    def runner(argv: Sequence[str]) -> bytes:
        seen.append(list(argv))
        return b"\xff\xd8jpeg"

    extract_keyframe_jpeg(_MEDIA, 0.0, runner=runner, ffmpeg="ffmpeg")
    assert "-ss" not in seen[0]


def test_extract_keyframe_jpeg_errors_on_empty_output() -> None:
    with pytest.raises(FrameExtractionError, match="no keyframe"):
        extract_keyframe_jpeg(_MEDIA, 1.0, runner=lambda argv: b"", ffmpeg="ffmpeg")


# --- default transport resolution (no injection) --------------------------------


def test_defaults_fall_back_to_real_ffmpeg_helpers(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no injected ffmpeg/runner, the module reaches for find_ffmpeg + run_bytes."""
    calls: list[list[str]] = []

    def fake_run_bytes(argv: Sequence[str], *, timeout: float | None = None) -> bytes:
        calls.append(list(argv))
        return _FLAT

    monkeypatch.setattr(visual_indexing, "find_ffmpeg", lambda: "ffmpeg-bin")
    monkeypatch.setattr(visual_indexing, "run_bytes", fake_run_bytes)

    spans = sample_asset(_MEDIA, duration_seconds=0.0, scene_cuts=[], is_image=True)
    assert len(spans) == 1
    assert calls and calls[0][0] == "ffmpeg-bin"

    monkeypatch.setattr(visual_indexing, "run_bytes", lambda argv, *, timeout=None: b"jpeg")
    assert extract_keyframe_jpeg(_MEDIA, 0.0) == b"jpeg"
