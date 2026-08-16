"""Each tracker must follow a moving subject and refuse to follow a wrong one.

The scripted backend simulates a subject on a known trajectory, so these tests
assert real agreement between the reported boxes and where the subject actually
is — plus negative controls proving a plausible-but-wrong trajectory does not
pass as a match. Pixel-level proof against decoded media is the separate
``decoded_media`` job.
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
    region_request,
)

from framepilot_tracking_lite.policy import run_tracker
from framepilot_tracking_lite.protocol import TrackingRequest, TrackingSample
from framepilot_tracking_lite.runtime import build_tracker
from framepilot_tracking_lite.trackers.point import MAX_ROUND_TRIP_PIXELS

FRAMES = 12


def track(backend: ScriptedBackend, request: TrackingRequest) -> list[TrackingSample]:
    source = backend.open_frames(
        request.media.absolute_path, request.media.first_frame, request.media.last_frame_exclusive
    )
    tracker = build_tracker(request, backend, source.width, source.height)
    return list(run_tracker(request, source, tracker, should_cancel=lambda: False))


def centre(sample: TrackingSample) -> tuple[float, float]:
    return (
        (sample.box.x + sample.box.width / 2) * WIDTH,
        (sample.box.y + sample.box.height / 2) * HEIGHT,
    )


# --- point ---------------------------------------------------------------


def test_point_track_follows_the_real_subject_trajectory() -> None:
    backend = ScriptedBackend(trajectory=linear_trajectory(3.0, 1.5))
    request = point_request(media=media_handle(0, FRAMES))
    samples = track(backend, request)
    assert len(samples) == FRAMES
    start = centre(samples[0])
    for index, sample in enumerate(samples):
        expected = (start[0] + 3.0 * index, start[1] + 1.5 * index)
        assert centre(sample) == pytest.approx(expected, abs=0.75)
        assert sample.confidence > 0.9
        assert not sample.occluded


def test_point_track_does_not_match_a_wrong_trajectory() -> None:
    """Negative control: the same track must fail a plausible but incorrect path."""
    backend = ScriptedBackend(trajectory=linear_trajectory(3.0, 1.5))
    samples = track(backend, point_request(media=media_handle(0, FRAMES)))
    start = centre(samples[0])
    wrong = [(start[0] - 3.0 * index, start[1] + 4.0 * index) for index in range(FRAMES)]
    disagreement = max(
        abs(centre(sample)[0] - wrong[index][0]) for index, sample in enumerate(samples)
    )
    assert disagreement > 10.0


def test_point_flow_error_lowers_confidence_without_inventing_a_position() -> None:
    backend = ScriptedBackend(flow_errors={3: 20.0})
    samples = track(backend, point_request(media=media_handle(0, 5)))
    assert samples[3].confidence == pytest.approx(0.5, abs=0.01)
    assert samples[2].confidence > 0.9


def test_point_round_trip_disagreement_reports_no_measurement() -> None:
    backend = ScriptedBackend(round_trip_errors={2: MAX_ROUND_TRIP_PIXELS + 5.0})
    samples = track(backend, point_request(media=media_handle(0, 5)))
    # Frame 2 could not be measured, so the last known box is held, not advanced.
    assert samples[2].occluded is True
    assert samples[2].confidence == 0.0
    assert samples[2].box == samples[1].box


def test_point_boxes_stay_inside_the_frame_at_the_edge() -> None:
    backend = ScriptedBackend(trajectory=linear_trajectory(60.0, 0.0))
    samples = track(backend, point_request(media=media_handle(0, FRAMES)))
    for sample in samples:
        assert sample.box.x >= 0.0
        assert sample.box.x + sample.box.width <= 1.0
        assert sample.box.width > 0.0


# --- region --------------------------------------------------------------


def test_region_track_follows_the_subject_and_reports_measured_appearance() -> None:
    backend = ScriptedBackend(trajectory=linear_trajectory(2.0, 0.0), appearance={4: 0.62})
    samples = track(backend, region_request(media=media_handle(0, FRAMES)))
    assert samples[0].confidence == 1.0
    assert samples[4].confidence == pytest.approx(0.62)
    assert not samples[4].occluded
    drift = centre(samples[5])[0] - centre(samples[0])[0]
    assert drift == pytest.approx(10.0, abs=0.75)


def test_region_appearance_collapse_is_reported_as_an_unmeasured_frame() -> None:
    backend = ScriptedBackend(appearance={3: 0.01})
    samples = track(backend, region_request(media=media_handle(0, 6)))
    assert samples[3].confidence == 0.0
    assert samples[3].occluded is True
    assert samples[3].box == samples[2].box


def test_region_tracker_failure_is_not_converted_into_a_confident_lock() -> None:
    backend = ScriptedBackend(lost_frames={2})
    samples = track(backend, region_request(media=media_handle(0, 6)))
    assert samples[2].confidence == 0.0
    assert samples[2].occluded is True


# --- planar --------------------------------------------------------------


def test_planar_track_projects_the_requested_quad_through_the_homography() -> None:
    backend = ScriptedBackend(trajectory=linear_trajectory(4.0, 2.0))
    samples = track(backend, planar_request(media=media_handle(0, FRAMES)))
    assert len(samples) == FRAMES
    for index, sample in enumerate(samples):
        expected = (centre(samples[0])[0] + 4.0 * index, centre(samples[0])[1] + 2.0 * index)
        assert centre(sample) == pytest.approx(expected, abs=0.75)
    assert samples[-1].confidence > 0.9


def test_planar_confidence_falls_with_the_inlier_ratio() -> None:
    # Four of nine correspondences drift onto something else at frame 2.
    backend = ScriptedBackend(outlier_frames={2: 4})
    samples = track(backend, planar_request(media=media_handle(0, 5)))
    assert samples[2].confidence == pytest.approx(5 / 9, abs=0.01)


def test_planar_refuses_to_report_a_plane_below_the_inlier_floor() -> None:
    backend = ScriptedBackend(outlier_frames={2: 6})
    samples = track(backend, planar_request(media=media_handle(0, 5)))
    assert samples[2].confidence == 0.0
    assert samples[2].occluded is True


def test_planar_requires_four_correspondences_to_initialize() -> None:
    backend = ScriptedBackend(features=[(10.0, 10.0), (20.0, 20.0), (30.0, 30.0)])
    with pytest.raises(Exception) as error:
        track(backend, planar_request(media=media_handle(0, 5)))
    assert getattr(error.value, "code", None) == "target_lost"


def test_planar_feature_order_is_stable_regardless_of_detection_order() -> None:
    unsorted_features = [(200.0, 120.0), (120.0, 200.0), (160.0, 160.0), (140.0, 180.0)]
    first = track(
        ScriptedBackend(features=list(unsorted_features)),
        planar_request(media=media_handle(0, 5)),
    )
    second = track(
        ScriptedBackend(features=list(reversed(unsorted_features))),
        planar_request(media=media_handle(0, 5)),
    )
    assert [sample.box for sample in first] == [sample.box for sample in second]
