"""Occlusion, hold and target-loss policy: the worker's honesty contract."""

from __future__ import annotations

import pytest
from conftest import ScriptedBackend, media_handle, point_request

from framepilot_tracking_lite.policy import (
    MAX_HELD_FRAMES,
    OCCLUSION_CONFIDENCE,
    Measurement,
    TargetLostError,
    Tracker,
    run_tracker,
)
from framepilot_tracking_lite.protocol import NormalizedBox, ProtocolError

BOX = NormalizedBox(x=0.4, y=0.4, width=0.1, height=0.1)
MOVED = NormalizedBox(x=0.5, y=0.4, width=0.1, height=0.1)


class ScriptedTracker(Tracker):
    """Replays a caller-supplied measurement script, one entry per frame."""

    def __init__(self, measurements: list[Measurement]) -> None:
        self._measurements = measurements
        self._index = 0

    def initialize(self, frame: object) -> Measurement:
        return self.update(frame)

    def update(self, frame: object) -> Measurement:
        measurement = self._measurements[min(self._index, len(self._measurements) - 1)]
        self._index += 1
        return measurement


def drive(measurements: list[Measurement], frames: int, cancel_after: int | None = None) -> list:
    backend = ScriptedBackend()
    request = point_request(media=media_handle(0, frames))
    source = backend.open_frames(request.media.absolute_path, 0, frames)
    seen = 0

    def should_cancel() -> bool:
        nonlocal seen
        if cancel_after is None:
            return False
        cancel = seen >= cancel_after
        seen += 1
        return cancel

    return list(
        run_tracker(request, source, ScriptedTracker(measurements), should_cancel=should_cancel)
    )


def test_measured_samples_keep_their_measured_position_and_confidence() -> None:
    script = [Measurement(box=BOX, confidence=0.9), Measurement(box=MOVED, confidence=0.8)]
    samples = drive(script, 2)
    assert [sample.frame for sample in samples] == [0, 1]
    assert samples[1].box == MOVED
    assert samples[1].confidence == pytest.approx(0.8)
    assert not any(sample.occluded for sample in samples)


def test_low_confidence_measurements_are_flagged_occluded_but_still_reported() -> None:
    low = OCCLUSION_CONFIDENCE / 2
    script = [Measurement(box=BOX, confidence=0.9), Measurement(box=MOVED, confidence=low)]
    samples = drive(script, 2)
    assert samples[1].occluded is True
    # The measurement is real, so it is reported where it was measured.
    assert samples[1].box == MOVED
    assert samples[1].confidence == pytest.approx(low)


def test_an_unmeasured_frame_freezes_the_last_box_rather_than_continuing_motion() -> None:
    script = [Measurement(box=BOX, confidence=1.0), Measurement(box=None, confidence=0.0)]
    samples = drive(script, 4)
    held = samples[1:]
    assert all(sample.box == BOX for sample in held), "a held frame must not invent new motion"
    assert all(sample.occluded and sample.confidence == 0.0 for sample in held)


def test_holding_is_bounded_and_then_fails_as_target_lost() -> None:
    script = [Measurement(box=BOX, confidence=1.0), Measurement(box=None, confidence=0.0)]
    with pytest.raises(TargetLostError) as error:
        drive(script, MAX_HELD_FRAMES + 5)
    assert error.value.code == "target_lost"
    assert error.value.last_measured_frame == 0
    assert "after frame 0" in error.value.detail


def test_a_target_that_was_never_measured_fails_immediately() -> None:
    with pytest.raises(TargetLostError, match="before any frame could be measured"):
        drive([Measurement(box=None, confidence=0.0)], 5)


def test_cancellation_stops_between_frames() -> None:
    script = [Measurement(box=BOX, confidence=1.0)]
    with pytest.raises(ProtocolError) as error:
        drive(script, 10, cancel_after=3)
    assert error.value.code == "cancelled"


def test_undecodable_media_never_produces_a_track() -> None:
    backend = ScriptedBackend(decodable_frames=0)
    request = point_request(media=media_handle(0, 5))
    source = backend.open_frames(request.media.absolute_path, 0, 5)
    with pytest.raises(ProtocolError) as error:
        list(
            run_tracker(
                request,
                source,
                ScriptedTracker([Measurement(box=BOX, confidence=1.0)]),
                should_cancel=lambda: False,
            )
        )
    assert error.value.code == "media_unreadable"
