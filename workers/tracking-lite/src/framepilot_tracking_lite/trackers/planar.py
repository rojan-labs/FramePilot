"""Planar tracking by feature correspondence plus homography.

Features are detected once inside the requested quad and then tracked frame to
frame with Lucas–Kanade flow. Each frame, a homography is fitted from the
**initial** feature positions to their current positions, so the reported plane
is always anchored to the requested quad rather than accumulating frame-to-frame
drift, and the requested corners are projected through it.

Confidence combines the two facts the estimate actually provides: the inlier
ratio of the robust fit, and the residual flow error of the surviving features.
Fewer than :data:`MIN_CORRESPONDENCES` survivors, or a failed fit, yields no
measurement — a plane cannot be honestly reported from an under-determined
system.

Protocol v1 carries axis-aligned boxes only, so the projected quad is reported as
its bounding box. Full corner transport is a v2 protocol change, tracked in C4.
"""

from __future__ import annotations

from typing import Final

from ..backend import Frame, TrackingBackend
from ..geometry import Point, apply_homography, bounding_box, clamp, to_pixels
from ..policy import Measurement, Tracker
from ..protocol import NormalizedPoint

#: A homography needs four correspondences; below that no plane exists.
MIN_CORRESPONDENCES: Final = 4
#: Features requested inside the quad. Bounded to keep per-frame cost predictable.
MAX_FEATURES: Final = 120
#: Minimum inlier ratio for the fit to count as a measurement of *this* plane.
MIN_INLIER_RATIO: Final = 0.5
#: Flow error at or above which a surviving correspondence contributes no confidence.
MAX_FLOW_ERROR: Final = 40.0


class PlanarTracker(Tracker):
    def __init__(
        self,
        backend: TrackingBackend,
        corners: tuple[NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint],
        width: int,
        height: int,
    ) -> None:
        self._backend = backend
        self._width = width
        self._height = height
        self._corners: list[Point] = [to_pixels(corner, width, height) for corner in corners]
        self._reference: list[Point] = []
        self._current: list[Point] = []
        self._previous: Frame | None = None

    def initialize(self, frame: Frame) -> Measurement:
        self._previous = frame
        xs = [corner[0] for corner in self._corners]
        ys = [corner[1] for corner in self._corners]
        quad = (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
        # Stable ordering: features are sorted so the same frame always produces
        # the same correspondence order, and therefore the same RANSAC outcome.
        features = sorted(self._backend.detect_features(frame, quad, MAX_FEATURES))
        if len(features) < MIN_CORRESPONDENCES:
            return Measurement(box=None, confidence=0.0)
        self._reference = list(features)
        self._current = list(features)
        return Measurement(
            box=bounding_box(self._corners, self._width, self._height), confidence=1.0
        )

    def update(self, frame: Frame) -> Measurement:
        previous = self._previous
        if previous is None or not self._current:
            return Measurement(box=None, confidence=0.0)
        flow = self._backend.optical_flow(previous, frame, self._current)
        self._previous = frame
        reference: list[Point] = []
        tracked: list[Point] = []
        errors: list[float] = []
        for index, sample in enumerate(flow):
            if not sample.ok or index >= len(self._reference):
                continue
            reference.append(self._reference[index])
            tracked.append(sample.point)
            errors.append(sample.error)
        if len(tracked) < MIN_CORRESPONDENCES:
            self._current = []
            return Measurement(box=None, confidence=0.0)
        # Surviving features become the next frame's flow input, and the
        # reference set is narrowed with them so the two stay index-aligned.
        self._reference = reference
        self._current = tracked
        estimate = self._backend.estimate_homography(reference, tracked)
        if estimate is None:
            return Measurement(box=None, confidence=0.0)
        inlier_count = sum(1 for inlier in estimate.inliers if inlier)
        inlier_ratio = inlier_count / len(tracked)
        if inlier_count < MIN_CORRESPONDENCES or inlier_ratio < MIN_INLIER_RATIO:
            return Measurement(box=None, confidence=0.0)
        projected = [apply_homography(estimate.matrix, corner) for corner in self._corners]
        if any(corner is None for corner in projected):
            return Measurement(box=None, confidence=0.0)
        mean_error = sum(errors) / len(errors)
        error_confidence = 1.0 - clamp(mean_error / MAX_FLOW_ERROR, 0.0, 1.0)
        return Measurement(
            box=bounding_box(
                [corner for corner in projected if corner is not None], self._width, self._height
            ),
            confidence=inlier_ratio * error_confidence,
        )
