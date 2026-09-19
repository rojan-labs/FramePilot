"""Planar tracking by feature correspondence plus homography.

Features are detected once inside the requested quad and then tracked frame to
frame with Lucas–Kanade flow. Each frame, a homography is fitted from the
**initial** feature positions to their current positions, so the reported plane
is always anchored to the requested quad rather than accumulating frame-to-frame
drift, and the requested corners are projected through it.

**Registration (MK7.5).** Flow chained frame to frame accumulates error, and on low-texture or
blurred footage it slides by pixels. So the flow fit is only the *guess*: the backend then
registers the requested quad of the reference frame directly onto the current frame (ECC,
which is invariant to exposure gain and offset), and every feature is re-anchored on that
registered plane before the next frame. A plane is therefore always measured against the frame
the mask was drawn on, never against the previous frame's estimate of it.

**Confidence** is the backend's independent check of that registration: the fraction of the
quad's textured cells that, block-matched against the reference, land within a pixel of where
the plane says they are (`Alignment.agreement`), scaled by the flow's matching error. A plane
that locked onto an occluder, an aliased repeat or a competing surface is contradicted by the
cells still showing the real one, which is what makes a measured-and-wrong frame reach the
review list instead of passing as confident. When flow itself fails (a lighting jump, a whip),
the last verified plane is the guess and the registration decides; below
:data:`MIN_AGREEMENT` nothing is reported, so a vanished plane is held and eventually lost
rather than invented.

The projected quad is reported as its bounding box, which is all protocol v1's ``box``
can carry, **and** as the normalized homography itself in the sample's additive
``transform`` field (MK7.2). The transform is what mask tracking actually needs: a
bounding box cannot express rotation or perspective, and the host constrains the
homography to the motion model the editor asked for.
"""

from __future__ import annotations

from typing import Final

from ..backend import Alignment, Frame, TrackingBackend
from ..geometry import (
    IDENTITY,
    Matrix3x3,
    Point,
    apply_homography,
    bounding_box,
    clamp,
    normalized_homography,
    to_pixels,
)
from ..policy import Measurement, Tracker
from ..protocol import NormalizedPoint

#: A homography needs four correspondences; below that no plane exists.
MIN_CORRESPONDENCES: Final = 4
#: Features requested inside the quad. Bounded to keep per-frame cost predictable.
MAX_FEATURES: Final = 120
#: Flow planes tried as registration guesses: the dominant one and the runner-up.
FLOW_HYPOTHESES: Final = 2
#: Flow error at or above which a surviving correspondence contributes no confidence.
MAX_FLOW_ERROR: Final = 40.0
#: Below this verified agreement the plane is not reported at all (held, then lost).
MIN_AGREEMENT: Final = 0.2
#: A contradicting-cell fraction at which confidence reaches zero.
CONTRADICTION_CEILING: Final = 0.2
#: At or above this agreement the registered plane becomes the next frame's anchor.
ANCHOR_AGREEMENT: Final = 0.5


def verified_confidence(alignment: Alignment) -> float:
    """How much of the plane the check confirmed, as the number the host thresholds.

    Squared agreement: the host flags below 0.5, so a plane is only confident once about 71 % of
    its verifiable texture lands where the plane says. What is NOT verified is where a plane is
    wrong without contradiction — with half the quad hidden, the visible half fits perfectly and
    the hidden corners are extrapolated, and on real footage that extrapolation is off by pixels.
    Any positive contradiction (cells that clearly sit somewhere else) scales it down further.
    """
    penalty = clamp(1.0 - alignment.contradiction / CONTRADICTION_CEILING, 0.0, 1.0)
    return alignment.agreement * alignment.agreement * penalty


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
        self._reference_frame: Frame | None = None
        #: The last plane the check confirmed, reference → current.
        self._anchor: Matrix3x3 = IDENTITY

    def initialize(self, frame: Frame) -> Measurement:
        self._previous = frame
        self._reference_frame = frame
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
            box=bounding_box(self._corners, self._width, self._height),
            confidence=1.0,
            # The reference frame is the identity by definition: the plane is where it is.
            transform=(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0),
        )

    def update(self, frame: Frame) -> Measurement:
        previous = self._previous
        reference_frame = self._reference_frame
        if previous is None or reference_frame is None or not self._reference:
            return Measurement(box=None, confidence=0.0)
        flow_guesses, error_confidence, chained = self._flow_guesses(previous, frame)
        self._previous = frame
        guesses = [*flow_guesses, self._anchor]
        alignment = self._backend.align(
            reference_frame, frame, self._corners, guesses, "homography"
        )
        if alignment is None or alignment.cells == 0:
            self._current = chained
            return Measurement(box=None, confidence=0.0)
        self._reanchor(alignment, chained)
        if alignment.agreement < MIN_AGREEMENT:
            return Measurement(box=None, confidence=0.0)
        projected = [apply_homography(alignment.matrix, corner) for corner in self._corners]
        if any(corner is None for corner in projected):
            return Measurement(box=None, confidence=0.0)
        return Measurement(
            box=bounding_box(
                [corner for corner in projected if corner is not None], self._width, self._height
            ),
            confidence=verified_confidence(alignment) * error_confidence,
            transform=normalized_homography(alignment.matrix, self._width, self._height),
        )

    def _flow_guesses(
        self, previous: Frame, frame: Frame
    ) -> tuple[list[Matrix3x3], float, list[Point]]:
        """Planes the flow supports, as the registration's starting guesses.

        The dominant RANSAC plane first, then the plane the REST of the features agree on: when
        a foreground object covers most of the quad, the dominant motion is the object's and the
        real plane is the runner-up — the registration's check decides which one is the mask's.
        Also returns the flow's error confidence and where each feature's flow landed.
        """
        flow = self._backend.optical_flow(previous, frame, self._current)
        reference: list[Point] = []
        tracked: list[Point] = []
        errors: list[float] = []
        chained = list(self._current)
        for index, sample in enumerate(flow):
            if not sample.ok or index >= len(self._reference):
                continue
            chained[index] = sample.point
            reference.append(self._reference[index])
            tracked.append(sample.point)
            errors.append(sample.error)
        error_confidence = (
            1.0 - clamp(sum(errors) / len(errors) / MAX_FLOW_ERROR, 0.0, 1.0) if errors else 1.0
        )
        guesses: list[Matrix3x3] = []
        for _ in range(FLOW_HYPOTHESES):
            if len(tracked) < MIN_CORRESPONDENCES:
                break
            estimate = self._backend.estimate_homography(reference, tracked)
            if estimate is None:
                break
            inlier_count = sum(1 for inlier in estimate.inliers if inlier)
            if inlier_count < MIN_CORRESPONDENCES:
                break
            guesses.append(estimate.matrix)
            reference = [
                p for p, inlier in zip(reference, estimate.inliers, strict=True) if not inlier
            ]
            tracked = [p for p, inlier in zip(tracked, estimate.inliers, strict=True) if not inlier]
        return guesses, error_confidence, chained

    def _reanchor(self, alignment: Alignment, chained: list[Point]) -> None:
        """Put every feature back on a verified plane; otherwise keep following the flow.

        Re-anchoring is what stops flow drift from accumulating, and it restores features that
        slid off or were lost: after an occluder passes, they are on the plane again.
        """
        if alignment.agreement < ANCHOR_AGREEMENT:
            self._current = chained
            return
        self._anchor = alignment.matrix
        anchored: list[Point] = []
        for index, feature in enumerate(self._reference):
            moved = apply_homography(alignment.matrix, feature)
            anchored.append(moved if moved is not None else chained[index])
        self._current = anchored
