"""Region tracking by discriminative correlation filter (CSRT) with measured confidence.

OpenCV's CSRT ``update`` returns only a boolean, which says nothing about *how
well* the region still matches. Mapping that boolean to a confidence would be a
fabricated number, so the backend additionally measures normalized appearance
similarity between the current patch and the initialization template, and that
measurement is the confidence reported to the host.

A region that drifts onto background therefore degrades honestly (falling
confidence, then the occluded flag) instead of reporting a confident lock.
"""

from __future__ import annotations

from typing import Final

from ..backend import Frame, RegionUpdate, TrackingBackend
from ..backend import RegionTracker as BackendRegionTracker
from ..geometry import box_to_pixels, clamp, normalize_box
from ..policy import Measurement, Tracker
from ..protocol import NormalizedBox

#: Appearance similarity under which the patch is no longer considered a measurement.
MIN_APPEARANCE: Final = 0.05


class RegionTracker(Tracker):
    def __init__(
        self, backend: TrackingBackend, region: NormalizedBox, width: int, height: int
    ) -> None:
        self._backend = backend
        self._region = region
        self._width = width
        self._height = height
        self._tracker: BackendRegionTracker | None = None

    def initialize(self, frame: Frame) -> Measurement:
        self._tracker = self._backend.create_region_tracker(
            frame, box_to_pixels(self._region, self._width, self._height)
        )
        return Measurement(box=self._region, confidence=1.0)

    def update(self, frame: Frame) -> Measurement:
        tracker = self._tracker
        if tracker is None:  # pragma: no cover - driver always initializes first
            return Measurement(box=None, confidence=0.0)
        return self._measure(tracker.update(frame))

    def _measure(self, update: RegionUpdate) -> Measurement:
        appearance = clamp(update.appearance, 0.0, 1.0)
        if update.box_pixels is None or appearance < MIN_APPEARANCE:
            return Measurement(box=None, confidence=0.0)
        x, y, box_width, box_height = update.box_pixels
        if box_width <= 0.0 or box_height <= 0.0:
            return Measurement(box=None, confidence=0.0)
        return Measurement(
            box=normalize_box(x, y, box_width, box_height, self._width, self._height),
            confidence=appearance,
        )
