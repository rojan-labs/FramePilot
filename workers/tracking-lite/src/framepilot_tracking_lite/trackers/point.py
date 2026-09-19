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

from collections.abc import Sequence
from typing import Final

from ..backend import Frame, TrackingBackend
from ..geometry import (
    IDENTITY,
    Matrix3x3,
    Point,
    apply_homography,
    clamp,
    clamp_unit,
    distance,
    point_to_box,
    translated,
)
from ..policy import Measurement, Tracker
from ..protocol import NormalizedBox, NormalizedPoint
from .planar import ANCHOR_AGREEMENT, verified_confidence

#: Square patch, in pixels, that the reported box represents. Matches the flow window.
POINT_PATCH_PIXELS: Final = 21.0
#: Flow error at or above which the correspondence carries no confidence.
MAX_FLOW_ERROR: Final = 40.0
#: Forward–backward round-trip distance, in pixels, treated as a lost correspondence.
MAX_ROUND_TRIP_PIXELS: Final = 2.0
#: Sides of the patch each shape vertex is registered by, in source pixels (MK7.5), smallest
#: first: the smallest one with verifiable texture is used, so a vertex on a flat stretch of an
#: edge borrows the motion of the nearest texture instead of following noise.
VERTEX_PATCH_PIXELS: Final = (64.0, 128.0, 256.0)
#: Verifiable cells a vertex patch needs before its verdict is taken; one or two cells would
#: turn a single blurred cell into a flagged frame.
VERTEX_MIN_CELLS: Final = 4
#: A patch verified this well is used as is; below it the next size up is tried as well, and
#: the better-verified one wins (a smooth trunk verifies poorly at 64 px and well at 128).
VERTEX_WELL_VERIFIED: Final = 0.9


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


class PointTracker(Tracker):
    """One point, plus any number of extra points followed in the SAME pass.

    The extra points are how a shape (``point-cloud``) track is measured: a path's vertices
    move independently, and tracking them as separate requests would decode the media once per
    vertex (MK7.2).

    **Each vertex is registered, not chained (MK7.5).** Flow from the previous frame is only the
    guess; the patch around the vertex in the REFERENCE frame is then registered onto the
    current frame (an affine patch, so it may rotate, scale and shear), and the vertex moves
    with that patch. Chained flow slid a vertex by tens of pixels over two seconds of low-light
    footage; registration against the frame the path was drawn on cannot drift.

    **Confidence** is the WORST vertex's verified confidence (the same cell check a plane gets),
    combined with the primary point's own measure: one vertex on the wrong texture makes the
    whole shape wrong, so it has to make the whole frame reviewable.
    """

    def __init__(
        self,
        backend: TrackingBackend,
        point: NormalizedPoint,
        width: int,
        height: int,
        extra: Sequence[NormalizedPoint] = (),
    ) -> None:
        self._backend = backend
        self._width = width
        self._height = height
        self._point: Point = (point.x * width, point.y * height)
        self._vertices: list[Point] = [(p.x * width, p.y * height) for p in extra]
        self._extra: list[Point] = list(self._vertices)
        #: Per vertex: the last verified patch warp, reference → current.
        self._warps: list[Matrix3x3] = [IDENTITY for _ in self._vertices]
        #: Per vertex: the index of the patch size that last verified it.
        self._sides: list[int] = [0 for _ in self._vertices]
        self._previous: Frame | None = None
        self._reference: Frame | None = None

    def initialize(self, frame: Frame) -> Measurement:
        self._previous = frame
        self._reference = frame
        # The requested point is the host's own instruction, so frame one is a
        # perfect-confidence observation by definition.
        return Measurement(
            box=self._box(self._point), confidence=1.0, points=self._normalized_extra()
        )

    def update(self, frame: Frame) -> Measurement:
        previous = self._previous
        if previous is None:  # pragma: no cover - driver always initializes first
            return Measurement(box=None, confidence=0.0)
        forward = self._backend.optical_flow(previous, frame, [self._point, *self._extra])
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
        confidence = error_confidence * round_trip_confidence
        before = list(self._extra)
        flowed: list[Point | None] = []
        for index in range(len(self._extra)):
            sample = forward[index + 1] if index + 1 < len(forward) else None
            flowed.append(sample.point if sample is not None and sample.ok else None)
        results = [
            self._register_vertex(index, frame, flowed[index]) for index in range(len(before))
        ]
        # A vertex its own patch could not confirm (covered, or on a surface that left) is
        # tried again from where the confirmed vertices say the shape went, and placed there if
        # it still cannot be confirmed: its raw flow follows whatever covered it, and a vertex
        # that rides an occluder off the frame never comes back.
        moved = [
            (self._extra[i][0] - before[i][0], self._extra[i][1] - before[i][1])
            for i, (_, verified) in enumerate(results)
            if verified
        ]
        if moved:
            shift = (_median([m[0] for m in moved]), _median([m[1] for m in moved]))
            for index, (vertex_confidence, verified) in enumerate(results):
                if verified:
                    continue
                predicted = (before[index][0] + shift[0], before[index][1] + shift[1])
                retried, confirmed = self._register_vertex(index, frame, predicted)
                if not confirmed:
                    self._extra[index] = predicted
                results[index] = (max(vertex_confidence, retried), confirmed)
        for vertex_confidence, _ in results:
            confidence = min(confidence, vertex_confidence)
        return Measurement(
            box=self._box(self._point),
            confidence=confidence,
            points=self._normalized_extra(),
        )

    def _register_vertex(
        self, index: int, frame: Frame, flowed: Point | None
    ) -> tuple[float, bool]:
        """Move vertex `index` with its registered patch.

        Returns the vertex's confidence and whether the patch confirmed it (it only moves when
        it did; otherwise it follows `flowed`, the caller's best guess).
        """
        reference = self._reference
        if reference is None:  # pragma: no cover - driver always initializes first
            return 0.0, False
        vertex = self._vertices[index]
        warp = self._warps[index]
        guesses: list[Matrix3x3] = []
        if flowed is not None:
            at = apply_homography(warp, vertex)
            if at is not None:
                guesses.append(translated(warp, flowed[0] - at[0], flowed[1] - at[1]))
        guesses.append(warp)
        alignment = None
        chosen = self._sides[index]
        # Start at the size that verified last frame: texture around a vertex does not change
        # from one frame to the next, and re-trying the smaller ones every frame is most of the
        # cost of a shape track on flat footage.
        for side in VERTEX_PATCH_PIXELS[chosen:]:
            half = side / 2.0
            patch = (
                (vertex[0] - half, vertex[1] - half),
                (vertex[0] + half, vertex[1] - half),
                (vertex[0] + half, vertex[1] + half),
                (vertex[0] - half, vertex[1] + half),
            )
            # An affine patch is well posed on the smallest patch; across a larger one the
            # plane's perspective is real (≈1.5 px of keystone over 256 px), so it is modelled.
            motion = "affine" if side <= VERTEX_PATCH_PIXELS[0] else "homography"
            found = self._backend.align(reference, frame, patch, guesses, motion)
            if found is None or found.cells < VERTEX_MIN_CELLS:
                continue
            if alignment is None or verified_confidence(found) > verified_confidence(alignment):
                alignment = found
                self._sides[index] = VERTEX_PATCH_PIXELS.index(side)
            if verified_confidence(alignment) >= VERTEX_WELL_VERIFIED:
                break
        if alignment is None or alignment.cells == 0:
            # Nothing around this vertex can be verified: it follows its guess, unconfirmed.
            if flowed is not None:
                self._extra[index] = flowed
            return 0.0, False
        moved = apply_homography(alignment.matrix, vertex)
        if moved is None or alignment.agreement < ANCHOR_AGREEMENT:
            if flowed is not None:
                self._extra[index] = flowed
            return verified_confidence(alignment), False
        self._warps[index] = alignment.matrix
        self._extra[index] = moved
        return verified_confidence(alignment), True

    def _normalized_extra(self) -> tuple[NormalizedPoint, ...] | None:
        if not self._extra:
            return None
        return tuple(
            NormalizedPoint(x=clamp_unit(x / self._width), y=clamp_unit(y / self._height))
            for x, y in self._extra
        )

    def _box(self, point: Point) -> NormalizedBox:
        return point_to_box(point, POINT_PATCH_PIXELS, self._width, self._height)
