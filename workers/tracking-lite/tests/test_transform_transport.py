"""MK7.2: the plane, the extra points and the direction a mask track actually needs.

Protocol v1 carried an axis-aligned box per frame, which cannot express rotation, scale or
perspective — so a mask track built from boxes could only ever translate. These tests cover the
three additive things that changed, each of which a tracked mask depends on:

* the planar tracker reports its measured homography, normalized, alongside the box;
* a point request follows the path's vertices in the same flow pass (one decode, not one per
  vertex), and a vertex whose correspondence is lost holds its last measured position;
* a reverse request walks the approved range from its last frame back to its first, because a
  backward track's features are detected on the frame the mask was drawn on.

The scripted backend is a real geometric simulation (see ``conftest``), so these assert measured
agreement rather than plumbing.
"""

from __future__ import annotations

import pytest
from conftest import (
    HEIGHT,
    WIDTH,
    ScriptedBackend,
    linear_trajectory,
    media_handle,
    planar_request,
    point_request,
)

from framepilot_tracking_lite.geometry import normalized_homography
from framepilot_tracking_lite.policy import run_tracker
from framepilot_tracking_lite.protocol import NormalizedPoint, TrackingRequest, TrackingSample
from framepilot_tracking_lite.runtime import ReversedFrameSource, build_tracker

FRAMES = 8


def track(backend: ScriptedBackend, request: TrackingRequest) -> list[TrackingSample]:
    source = backend.open_frames(
        request.media.absolute_path, request.media.first_frame, request.media.last_frame_exclusive
    )
    tracker = build_tracker(request, backend, source.width, source.height)
    return list(run_tracker(request, source, tracker, should_cancel=lambda: False))


# --- the plane ------------------------------------------------------------


def test_planar_samples_carry_the_measured_transform() -> None:
    backend = ScriptedBackend(trajectory=linear_trajectory(3.0, 1.5))
    samples = track(backend, planar_request(media=media_handle(0, FRAMES)))
    assert samples[0].transform == (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
    for index, sample in enumerate(samples[1:], start=1):
        assert sample.transform is not None
        # The scripted fit is a translation; in normalized coordinates the offsets are the
        # pixel offsets divided by the frame size, and nothing else moves.
        assert sample.transform[2] == 3.0 * index / WIDTH
        assert sample.transform[5] == 1.5 * index / HEIGHT
        assert sample.transform[0] == 1.0
        assert sample.transform[4] == 1.0


def test_a_point_track_reports_no_plane() -> None:
    """A single point is not a plane, and the host must never treat it as one."""
    samples = track(ScriptedBackend(), point_request(media=media_handle(0, 4)))
    assert all(sample.transform is None for sample in samples)


def test_the_normalized_homography_is_the_pixel_one_in_unit_coordinates() -> None:
    matrix = ((1.5, 0.25, 40.0), (-0.5, 1.25, -20.0), (0.0001, 0.0002, 1.0))
    normalized = normalized_homography(matrix, 200, 100)
    # A point at the centre must land in the same place under both, up to the unit scaling.
    px, py = 80.0, 60.0
    denominator = matrix[2][0] * px + matrix[2][1] * py + matrix[2][2]
    expected = (
        (matrix[0][0] * px + matrix[0][1] * py + matrix[0][2]) / denominator / 200,
        (matrix[1][0] * px + matrix[1][1] * py + matrix[1][2]) / denominator / 100,
    )
    ux, uy = px / 200, py / 100
    w = normalized[6] * ux + normalized[7] * uy + normalized[8]
    got = (
        (normalized[0] * ux + normalized[1] * uy + normalized[2]) / w,
        (normalized[3] * ux + normalized[4] * uy + normalized[5]) / w,
    )
    assert abs(got[0] - expected[0]) < 1e-12
    assert abs(got[1] - expected[1]) < 1e-12


# --- the path's vertices --------------------------------------------------


VERTICES = (
    NormalizedPoint(x=0.2, y=0.2),
    NormalizedPoint(x=0.8, y=0.2),
    NormalizedPoint(x=0.8, y=0.8),
)


def test_extra_points_follow_the_subject_in_one_decode() -> None:
    backend = ScriptedBackend(trajectory=linear_trajectory(2.0, -1.0))
    samples = track(backend, point_request(media=media_handle(0, FRAMES), points=VERTICES))
    assert len(backend.opened) == 1
    for index, sample in enumerate(samples):
        assert sample.points is not None
        assert len(sample.points) == len(VERTICES)
        for vertex, tracked in zip(VERTICES, sample.points, strict=True):
            assert abs(tracked.x * WIDTH - (vertex.x * WIDTH + 2.0 * index)) < 1e-9
            assert abs(tracked.y * HEIGHT - (vertex.y * HEIGHT - 1.0 * index)) < 1e-9


def test_a_shape_frame_is_only_as_confident_as_its_worst_vertex() -> None:
    # Every vertex patch verifies 60 % at frame 2: 0.6² — a frame the host has to flag, however
    # sure the primary point's own flow is.
    backend = ScriptedBackend(agreement={2: 0.6})
    samples = track(backend, point_request(media=media_handle(0, 4), points=VERTICES))
    assert samples[2].confidence == pytest.approx(0.36, abs=1e-9)
    assert samples[1].confidence == pytest.approx(1.0, abs=1e-9)


def test_shape_vertices_are_registered_against_the_reference_frame() -> None:
    backend = ScriptedBackend()
    track(backend, point_request(media=media_handle(0, 3), points=VERTICES))
    # One registration per vertex per frame, each against frame 0, starting with the affine
    # patch (it verifies at once, so no larger patch is tried).
    assert backend.alignments == [(0, frame, "affine", 2) for frame in (1, 2) for _ in VERTICES]


def test_a_request_without_extra_points_reports_none() -> None:
    samples = track(ScriptedBackend(), point_request(media=media_handle(0, 3)))
    assert all(sample.points is None for sample in samples)


def test_a_held_frame_repeats_the_last_measured_geometry() -> None:
    """An unmeasured frame must not invent motion — it repeats what was last seen."""
    backend = ScriptedBackend(trajectory=linear_trajectory(2.0, 0.0), lost_frames={3})
    samples = track(backend, point_request(media=media_handle(0, 6), points=VERTICES))
    held = samples[3]
    assert held.occluded and held.confidence == 0.0
    assert held.points == samples[2].points


# --- the direction --------------------------------------------------------


def test_a_reverse_request_walks_the_range_backwards() -> None:
    backend = ScriptedBackend()
    request = point_request(media=media_handle(10, 20), reverse=True)
    source = ReversedFrameSource(
        lambda first, last: backend.open_frames(request.media.absolute_path, first, last),
        request.media.first_frame,
        request.media.last_frame_exclusive,
        chunk=4,
    )
    tracker = build_tracker(request, backend, source.width, source.height)
    samples = list(run_tracker(request, source, tracker, should_cancel=lambda: False))
    assert [sample.frame for sample in samples] == list(range(19, 9, -1))
    # The first sample is the reference frame — the one the mask was drawn on.
    assert samples[0].confidence == 1.0


def test_a_reverse_source_never_opens_outside_the_approved_range() -> None:
    backend = ScriptedBackend()
    source = ReversedFrameSource(
        lambda first, last: backend.open_frames("/approved/project/media/shot.mp4", first, last),
        10,
        20,
        chunk=3,
    )
    while source.read() is not None:
        pass
    for opened in backend.opened:
        assert opened.first_frame >= 10
        assert opened.last_frame_exclusive <= 20


def test_a_reverse_source_bounds_what_it_holds_in_memory() -> None:
    backend = ScriptedBackend()
    source = ReversedFrameSource(
        lambda first, last: backend.open_frames("/approved/project/media/shot.mp4", first, last),
        0,
        100,
        chunk=8,
    )
    source.read()
    # One chunk minus the frame just handed out; never the whole range.
    assert len(source._buffer) < 8
