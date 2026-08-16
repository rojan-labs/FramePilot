"""Point tracking by pyramidal Lucas–Kanade optical flow.

Confidence is derived from two independent measured quantities rather than the
tracker's boolean status:

* the backend's patch matching error, and
* a forward–backward consistency check (track forward, then re-track the result
  backwards; a good correspondence returns to where it started).

Forward–backward disagreement is the classic detector of occlusion and of flow
that has slid onto a different object, so a large disagreement produces *no
measurement* rather than a low-confidence guess.
"""

from __future__ import annotations

from typing import Final

from ..backend import Frame, TrackingBackend
from ..geometry import Point, clamp, distance, point_to_box
from ..policy import Measurement, Tracker
from ..protocol import NormalizedBox, NormalizedPoint

#: Square patch, in pixels, that the reported box represents. Matches the flow window.
POINT_PATCH_PIXELS: Final = 21.0
#: Flow error at or above which the correspondence carries no confidence.
MAX_FLOW_ERROR: Final = 40.0
#: Forward–backward round-trip distance, in pixels, treated as a lost correspondence.
MAX_ROUND_TRIP_PIXELS: Final = 2.0


class PointTracker(Tracker):
    def __init__(
        self, backend: TrackingBackend, point: NormalizedPoint, width: int, height: int
    ) -> None:
        self._backend = backend
        self._width = width
        self._height = height
        self._point: Point = (point.x * width, point.y * height)
        self._previous: Frame | None = None

    def initialize(self, frame: Frame) -> Measurement:
        self._previous = frame
        # The requested point is the host's own instruction, so frame one is a
        # perfect-confidence observation by definition.
        return Measurement(box=self._box(self._point), confidence=1.0)

    def update(self, frame: Frame) -> Measurement:
        previous = self._previous
        if previous is None:  # pragma: no cover - driver always initializes first
            return Measurement(box=None, confidence=0.0)
        forward = self._backend.optical_flow(previous, frame, [self._point])
        self._previous = frame
        if not forward or not forward[0].ok:
            return Measurement(box=None, confidence=0.0)
        candidate = forward[0]
        backward = self._backend.optical_flow(frame, previous, [candidate.point])
        if not backward or not backward[0].ok:
            return Measurement(box=None, confidence=0.0)
        round_trip = distance(self._point, backward[0].point)
        if round_trip > MAX_ROUND_TRIP_PIXELS:
            return Measurement(box=None, confidence=0.0)
        self._point = candidate.point
        error_confidence = 1.0 - clamp(candidate.error / MAX_FLOW_ERROR, 0.0, 1.0)
        round_trip_confidence = 1.0 - clamp(round_trip / MAX_ROUND_TRIP_PIXELS, 0.0, 1.0)
        return Measurement(
            box=self._box(self._point), confidence=error_confidence * round_trip_confidence
        )

    def _box(self, point: Point) -> NormalizedBox:
        return point_to_box(point, POINT_PATCH_PIXELS, self._width, self._height)
