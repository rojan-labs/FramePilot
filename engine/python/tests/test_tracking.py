"""Tests for the object-tracking seam (PRD §6.4, plan Phase 5)."""

from __future__ import annotations

import pytest

from framepilot_engine.effects.tracking import (
    AUTO_ENGINES,
    Box,
    Keyframed,
    ManualTracker,
    ObjectTracker,
    TrackerUnavailableError,
    boxes_to_keyframes,
    get_tracker,
    tracked_box_at,
)
from framepilot_engine.timeline.models import Effect, Keyframe

REGION = Box(x=0.3, y=0.3, width=0.2, height=0.2)
SAMPLES = [Keyframed(time=0.0, box=REGION), Keyframed(time=1.0, box=REGION)]


def test_manual_tracker_holds_region_without_corrections() -> None:
    track = ManualTracker().track(REGION, SAMPLES)
    assert [k.box for k in track] == [REGION, REGION]
    assert [k.time for k in track] == [0.0, 1.0]


def test_manual_tracker_interpolates_corrections() -> None:
    tracker = ManualTracker(
        corrections=(
            Keyframed(time=0.0, box=Box(0.0, 0.0, 0.2, 0.2)),
            Keyframed(time=2.0, box=Box(1.0, 1.0, 0.2, 0.2)),
        )
    )
    mid = tracker.track(REGION, [Keyframed(time=1.0, box=REGION)])[0].box
    assert mid.x == pytest.approx(0.5)
    assert mid.y == pytest.approx(0.5)


def test_manual_tracker_holds_outside_correction_range() -> None:
    tracker = ManualTracker(
        corrections=(
            Keyframed(time=1.0, box=Box(0.1, 0.1, 0.2, 0.2)),
            Keyframed(time=2.0, box=Box(0.4, 0.4, 0.2, 0.2)),
        )
    )
    before = tracker.track(REGION, [Keyframed(time=0.0, box=REGION)])[0].box
    after = tracker.track(REGION, [Keyframed(time=5.0, box=REGION)])[0].box
    assert before.x == pytest.approx(0.1)  # held at first correction
    assert after.x == pytest.approx(0.4)  # held at last correction


def test_manual_tracker_handles_zero_span_corrections() -> None:
    tracker = ManualTracker(
        corrections=(
            Keyframed(time=1.0, box=Box(0.1, 0.1, 0.2, 0.2)),
            Keyframed(time=1.0, box=Box(0.9, 0.9, 0.2, 0.2)),
            Keyframed(time=3.0, box=Box(0.9, 0.9, 0.2, 0.2)),
        )
    )
    # A query strictly inside avoids the endpoint holds and exercises the bracket.
    box = tracker.track(REGION, [Keyframed(time=2.0, box=REGION)])[0].box
    assert 0.1 <= box.x <= 0.9


def test_get_tracker_manual_is_available_and_is_an_object_tracker() -> None:
    tracker = get_tracker("manual")
    assert isinstance(tracker, ObjectTracker)
    assert isinstance(tracker, ManualTracker)


@pytest.mark.parametrize("engine", [*sorted(AUTO_ENGINES), "something-else"])
def test_get_tracker_rejects_unavailable_engines(engine: str) -> None:
    with pytest.raises(TrackerUnavailableError) as exc:
        get_tracker(engine)
    assert exc.value.engine == engine


def test_boxes_to_keyframes_emits_four_props_per_sample() -> None:
    track = [Keyframed(time=0.0, box=Box(0.1, 0.2, 0.3, 0.4))]
    kfs = boxes_to_keyframes(track, id_prefix="trk")
    assert {k.property for k in kfs} == {"x", "y", "width", "height"}
    assert {k.value for k in kfs} == {0.1, 0.2, 0.3, 0.4}
    assert all(k.id.startswith("trk__") for k in kfs)


def test_tracked_box_at_reads_keyframes() -> None:
    track = [
        Keyframed(time=0.0, box=Box(0.0, 0.0, 0.2, 0.2)),
        Keyframed(time=2.0, box=Box(1.0, 0.0, 0.2, 0.2)),
    ]
    effect = Effect(
        id="t",
        type="object_track",
        params={"target": "object"},
        keyframes=boxes_to_keyframes(track, id_prefix="trk"),
    )
    box = tracked_box_at(effect, 1.0)
    assert box is not None
    assert box.x == pytest.approx(0.5)  # interpolated across the track
    assert box.width == pytest.approx(0.2)


def test_tracked_box_at_returns_none_without_a_positional_track() -> None:
    effect = Effect(id="t", type="object_track", params={"target": "face"}, keyframes=[])
    assert tracked_box_at(effect, 0.5) is None
    # Partial data (only x) is also treated as "no track".
    partial = Effect(
        id="t",
        type="object_track",
        params={},
        keyframes=[Keyframe(id="x", time=0.0, property="x", value=0.1)],
    )
    assert tracked_box_at(partial, 0.0) is None
