"""Deterministic measurement, occlusion and target-loss policy.

This module owns the worker's honesty contract. A tracker reports what it
measured; this driver decides how that becomes protocol samples:

* A real measurement is always emitted at its measured position, with its
  measured confidence, flagged ``occluded`` when confidence falls under the
  occlusion threshold.
* When a tracker has **no** measurement, the last known box is held in place with
  ``occluded=True`` and ``confidence=0.0``. The box is frozen, never extrapolated:
  the worker never invents motion it did not observe.
* Holding is bounded. Past :data:`MAX_HELD_FRAMES` consecutive unmeasured frames
  the request fails with the typed ``target_lost`` code naming the last measured
  frame, instead of returning a long plausible-looking fabrication.

Smoothing is deliberately **not** applied here. The host owns smoothing, gap and
correction-limit policy so it can be reasoned about, versioned and inverted
alongside the timeline operation; the worker stays a measurement device.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Final

from .backend import Frame, FrameSource
from .protocol import NormalizedBox, ProtocolError, TrackingRequest, TrackingSample

#: Below this measured confidence a sample is truthful but flagged occluded/unreliable.
OCCLUSION_CONFIDENCE: Final = 0.35
#: Consecutive frames without any measurement before the request fails as target_lost.
MAX_HELD_FRAMES: Final = 15


@dataclass(frozen=True, slots=True)
class Measurement:
    """One tracker observation. ``box is None`` means *nothing was measured*."""

    box: NormalizedBox | None
    confidence: float


class Tracker:
    """A per-capability measurement device driven frame by frame."""

    def initialize(self, frame: Frame) -> Measurement:  # pragma: no cover - interface
        raise NotImplementedError

    def update(self, frame: Frame) -> Measurement:  # pragma: no cover - interface
        raise NotImplementedError


class TargetLostError(ProtocolError):
    def __init__(self, last_measured_frame: int | None, held_frames: int) -> None:
        where = (
            "before any frame could be measured"
            if last_measured_frame is None
            else f"after frame {last_measured_frame}"
        )
        super().__init__(
            "target_lost",
            f"tracking target lost {where}; no measurement for {held_frames} consecutive frames.",
            # A different range or a re-specified target can succeed, so the host
            # may retry with new input — this is not a transient infrastructure fault.
            retryable=False,
        )
        self.last_measured_frame = last_measured_frame


def run_tracker(
    request: TrackingRequest,
    source: FrameSource,
    tracker: Tracker,
    *,
    should_cancel: Callable[[], bool],
) -> Iterator[TrackingSample]:
    """Drive ``tracker`` across the approved frame range, yielding ordered samples.

    Cancellation is checked between frames so a long track stops promptly without
    leaving a half-formed terminal message.
    """
    first_frame = request.media.first_frame
    frame_index = first_frame
    last_box: NormalizedBox | None = None
    last_measured_frame: int | None = None
    held_frames = 0

    while frame_index < request.media.last_frame_exclusive:
        if should_cancel():
            raise ProtocolError("cancelled", "tracking cancelled by the host.")
        frame = source.read()
        if frame is None:
            break
        measurement = (
            tracker.initialize(frame) if frame_index == first_frame else tracker.update(frame)
        )
        if measurement.box is not None:
            last_box = measurement.box
            last_measured_frame = frame_index
            held_frames = 0
            confidence = min(max(measurement.confidence, 0.0), 1.0)
            yield TrackingSample(
                frame=frame_index,
                box=measurement.box,
                confidence=confidence,
                occluded=confidence < OCCLUSION_CONFIDENCE,
            )
        else:
            held_frames += 1
            if last_box is None or held_frames > MAX_HELD_FRAMES:
                raise TargetLostError(last_measured_frame, held_frames)
            yield TrackingSample(
                frame=frame_index, box=last_box, confidence=0.0, occluded=True
            )
        frame_index += 1

    if last_measured_frame is None:
        raise ProtocolError(
            "media_unreadable",
            "no frame of the approved range could be decoded for tracking.",
        )
