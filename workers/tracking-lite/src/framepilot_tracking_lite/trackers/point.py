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

from collections.abc import Callable, Sequence
from typing import Final

from ..backend import Alignment, FlowSample, Frame, PixelBox, TrackingBackend
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
from .exclusions import ExclusionFollower
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
#: Confirmed vertices a frame needs before the hidden ones are carried by a plane fitted to
#: them rather than by their median shift (MK7.7).
MIN_CONFIRMED_FOR_PLANE: Final = 5
#: Confirmed vertices needed before their plane is offered to the surface registration as a guess.
MIN_CORRESPONDENCES_FOR_GUESS: Final = 4


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
        exclusions: Sequence[PixelBox] = (),
    ) -> None:
        self._backend = backend
        #: Frame regions the editor said are not the subject (MK7.7): a vertex patch is
        #: registered and verified on what is left of it.
        self._exclusions: tuple[PixelBox, ...] = tuple(exclusions)
        self._follower: ExclusionFollower | None = None
        #: Where the exclusions are on the frame being measured.
        self._covered: tuple[PixelBox, ...] = ()
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
        #: With exclusions (MK7.7): the surface around the shape — its vertices' bounding box on
        #: the reference frame — registered as a plane with the occluder left out. A vertex the
        #: occluder hides follows it, and so does the point the shape is centred on.
        self._origin: Point = self._point
        self._surface: list[Point] = _bounding_quad(self._vertices) if self._vertices else []
        self._surface_warp: Matrix3x3 = IDENTITY

    def initialize(self, frame: Frame) -> Measurement:
        self._previous = frame
        self._reference = frame
        if self._exclusions:
            self._follower = ExclusionFollower(self._backend, frame, self._exclusions)
        # The requested point is the host's own instruction, so frame one is a
        # perfect-confidence observation by definition.
        return Measurement(
            box=self._box(self._point), confidence=1.0, points=self._normalized_extra()
        )

    def update(self, frame: Frame) -> Measurement:
        previous = self._previous
        if previous is None:  # pragma: no cover - driver always initializes first
            return Measurement(box=None, confidence=0.0)
        if self._follower is not None:
            self._covered = self._follower.follow(frame)
        forward = self._backend.optical_flow(previous, frame, [self._point, *self._extra])
        self._previous = frame
        primary = self._primary_confidence(forward, previous, frame)
        if primary is None and self._follower is None:
            return Measurement(box=None, confidence=0.0)
        # With an exclusion, the point the shape is centred on can be the thing the occluder
        # sweeps across; the vertices are the measurement, and it is placed by the surface.
        confidence = 1.0 if primary is None else primary
        before = list(self._extra)
        flowed: list[Point | None] = []
        for index in range(len(self._extra)):
            sample = forward[index + 1] if index + 1 < len(forward) else None
            flowed.append(sample.point if sample is not None and sample.ok else None)
        results = [
            self._register_vertex(index, frame, flowed[index]) for index in range(len(before))
        ]
        confirmed_now = [i for i, (_, verified) in enumerate(results) if verified]
        surface = self._register_surface(frame, confirmed_now) if self._follower else None
        # A vertex its own patch could not confirm (covered, or on a surface that left) is
        # tried again from where the rest of the shape says it went, and placed there if it
        # still cannot be confirmed: its raw flow follows whatever covered it, and a vertex
        # that rides an occluder off the frame never comes back.
        predict: Callable[[int], Point] | None = None
        surface_confidence = 0.0
        if surface is not None:
            plane = surface.matrix
            predict = self._carried_by(plane, before)
            # The editor marked what is in front; the surface around it verified, so a vertex
            # behind the mark is as well placed as the surface is.
            surface_confidence = verified_confidence(surface, per_corner=True)
        elif confirmed_now:
            predict = self._predictor(confirmed_now, before)
        if predict is not None:
            for index, (vertex_confidence, verified) in enumerate(results):
                if verified:
                    continue
                predicted = predict(index)
                retried, confirmed = self._register_vertex(index, frame, predicted)
                if not confirmed:
                    self._extra[index] = predicted
                    retried = max(retried, surface_confidence)
                results[index] = (max(vertex_confidence, retried), confirmed)
        if primary is None:
            self._point = (
                apply_homography(surface.matrix, self._origin) or self._point
                if surface is not None
                else self._point
            )
        for vertex_confidence, _ in results:
            confidence = min(confidence, vertex_confidence)
        return Measurement(
            box=self._box(self._point),
            confidence=confidence,
            points=self._normalized_extra(),
        )

    def _primary_confidence(
        self, forward: Sequence[FlowSample], previous: Frame, frame: Frame
    ) -> float | None:
        """Follow the centre point; its measured confidence, or None when it was lost."""
        if not forward or not forward[0].ok:
            return None
        candidate = forward[0]
        backward = self._backend.optical_flow(frame, previous, [candidate.point])
        if not backward or not backward[0].ok:
            return None
        round_trip = distance(self._point, backward[0].point)
        if round_trip > MAX_ROUND_TRIP_PIXELS:
            return None
        self._point = candidate.point
        error_confidence = 1.0 - clamp(candidate.error / MAX_FLOW_ERROR, 0.0, 1.0)
        round_trip_confidence = 1.0 - clamp(round_trip / MAX_ROUND_TRIP_PIXELS, 0.0, 1.0)
        return error_confidence * round_trip_confidence

    def _register_surface(self, frame: Frame, confirmed: list[int]) -> Alignment | None:
        """The surface around the shape on `frame`, registered with the occluder left out."""
        reference = self._reference
        if reference is None or not self._surface:
            return None
        guesses: list[Matrix3x3] = []
        if len(confirmed) >= MIN_CORRESPONDENCES_FOR_GUESS:
            estimate = self._backend.estimate_homography(
                [self._vertices[i] for i in confirmed], [self._extra[i] for i in confirmed]
            )
            if estimate is not None:
                guesses.append(estimate.matrix)
        guesses.append(self._surface_warp)
        alignment = self._backend.align(
            reference, frame, self._surface, guesses, "homography", self._exclusions, self._covered
        )
        if alignment is None or alignment.agreement < ANCHOR_AGREEMENT:
            return None
        self._surface_warp = alignment.matrix
        return alignment

    def _carried_by(self, plane: Matrix3x3, before: list[Point]) -> Callable[[int], Point]:
        def carried(index: int) -> Point:
            moved = apply_homography(plane, self._vertices[index])
            return moved if moved is not None else before[index]

        return carried

    def _predictor(self, confirmed: list[int], before: list[Point]) -> Callable[[int], Point]:
        """Where an unconfirmed vertex should be, from the vertices this frame confirmed.

        With enough of them (MK7.7), the plane they moved on is fitted from the REFERENCE
        positions to where they are now, and the hidden vertex is carried by it: nothing
        accumulates, and a shape that turns or tilts behind an occluder keeps its hidden side
        in place. (A median frame-to-frame shift, the fallback, is a translation: under an
        orbit it slid a hidden vertex by 24 px over forty frames.)
        """
        if len(confirmed) >= MIN_CONFIRMED_FOR_PLANE:
            estimate = self._backend.estimate_homography(
                [self._vertices[i] for i in confirmed], [self._extra[i] for i in confirmed]
            )
            if estimate is not None and sum(estimate.inliers) >= MIN_CONFIRMED_FOR_PLANE:
                return self._carried_by(estimate.matrix, before)
        shifts = [
            (self._extra[i][0] - before[i][0], self._extra[i][1] - before[i][1]) for i in confirmed
        ]
        shift = (_median([m[0] for m in shifts]), _median([m[1] for m in shifts]))
        return lambda index: (before[index][0] + shift[0], before[index][1] + shift[1])

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
            if self._follower is not None and self._touches_exclusion(patch):
                # A patch the occluder touches is not evidence (MK7.7): a few cells beside an
                # occluder confirm a vertex pixels away from where it is. It follows the surface.
                continue
            # An affine patch is well posed on the smallest patch; across a larger one the
            # plane's perspective is real (≈1.5 px of keystone over 256 px), so it is modelled.
            motion = "affine" if side <= VERTEX_PATCH_PIXELS[0] else "homography"
            found = self._backend.align(
                reference, frame, patch, guesses, motion, self._exclusions, self._covered
            )
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

    def _touches_exclusion(self, patch: Sequence[Point]) -> bool:
        """Whether the patch overlaps an exclusion on the reference frame or on this one."""
        left = min(p[0] for p in patch)
        top = min(p[1] for p in patch)
        right = max(p[0] for p in patch)
        bottom = max(p[1] for p in patch)
        return any(
            left < box[0] + box[2] and box[0] < right and top < box[1] + box[3] and box[1] < bottom
            for box in (*self._exclusions, *self._covered)
        )

    def _normalized_extra(self) -> tuple[NormalizedPoint, ...] | None:
        if not self._extra:
            return None
        return tuple(
            NormalizedPoint(x=clamp_unit(x / self._width), y=clamp_unit(y / self._height))
            for x, y in self._extra
        )

    def _box(self, point: Point) -> NormalizedBox:
        return point_to_box(point, POINT_PATCH_PIXELS, self._width, self._height)


def _bounding_quad(points: Sequence[Point]) -> list[Point]:
    """The corners of `points`' bounding box, clockwise from the top-left."""
    left = min(p[0] for p in points)
    top = min(p[1] for p in points)
    right = max(p[0] for p in points)
    bottom = max(p[1] for p in points)
    return [(left, top), (right, top), (right, bottom), (left, bottom)]
