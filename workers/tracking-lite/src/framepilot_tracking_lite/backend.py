"""The injectable CV backend boundary.

Every numeric primitive that needs OpenCV/NumPy lives behind these protocols, so
the tracking *policy* — confidence, occlusion, loss, ordering — is pure Python
and fully unit testable without installing a CV stack. The real implementation is
``opencv_backend.py`` and is imported lazily, only when a worker actually runs.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from .geometry import Matrix3x3, Point

#: An opaque decoded frame. Only the backend interprets it.
Frame = Any


class MediaUnreadableError(Exception):
    """The approved media handle could not be opened or decoded."""


class BackendUnavailableError(Exception):
    """The CV backend itself is missing or refuses to run on this hardware."""


@dataclass(frozen=True, slots=True)
class FlowSample:
    """One pyramidal Lucas–Kanade correspondence."""

    point: Point
    ok: bool
    #: Backend-reported matching error for the tracked patch (lower is better).
    error: float


@dataclass(frozen=True, slots=True)
class RegionUpdate:
    """One region-tracker step.

    ``box_pixels`` is ``None`` when the tracker itself reports failure.
    ``appearance`` is a measured [0, 1] similarity between the current patch and
    the initialization template — never a boolean status cast to a float.
    """

    box_pixels: tuple[float, float, float, float] | None
    appearance: float


@dataclass(frozen=True, slots=True)
class HomographyEstimate:
    matrix: Matrix3x3
    #: Per-correspondence inlier flags, aligned with the input point order.
    inliers: tuple[bool, ...]


@dataclass(frozen=True, slots=True)
class Alignment:
    """A region of the reference frame registered onto the current frame, and checked (MK7.5).

    ``matrix`` maps reference pixels to current pixels. ``agreement`` is NOT a by-product of the
    fit: it is an independent check of it — the fraction of the region's textured cells that,
    block-matched between the reference and the current frame rectified through ``matrix``, land
    within a pixel of where ``matrix`` says they are. A registration that locked onto an
    occluder, an aliased repeat or a competing surface is contradicted by the cells that still
    show the real plane, so this is the number a wrong-but-measured frame is caught by.
    """

    matrix: Matrix3x3
    agreement: float
    #: The fraction of cells that clearly match somewhere ELSE — positive evidence that the
    #: registration is wrong, as opposed to cells that are merely unseen (occluded).
    contradiction: float
    #: Textured cells the check could measure; 0 means nothing in the region was verifiable.
    cells: int


@runtime_checkable
class RegionTracker(Protocol):
    def update(self, frame: Frame) -> RegionUpdate: ...


@runtime_checkable
class FrameSource(Protocol):
    @property
    def width(self) -> int: ...

    @property
    def height(self) -> int: ...

    def read(self) -> Frame | None:
        """Return the next frame in the approved range, or ``None`` at its end."""

    def close(self) -> None: ...


@runtime_checkable
class TrackingBackend(Protocol):
    @property
    def name(self) -> str:
        """Stable backend identity reported in the handshake and every result."""

    def open_frames(
        self,
        path: str,
        first_frame: int,
        last_frame_exclusive: int,
        fps: float | None = None,
    ) -> FrameSource:
        """Frames ``first..last`` on the request's ``fps`` grid (source time ``n / fps``)."""

    def optical_flow(
        self, previous: Frame, current: Frame, points: Sequence[Point]
    ) -> Sequence[FlowSample]:
        """Pyramidal Lucas–Kanade flow for ``points`` from ``previous`` to ``current``."""

    def create_region_tracker(
        self, frame: Frame, box_pixels: tuple[float, float, float, float]
    ) -> RegionTracker: ...

    def detect_features(
        self, frame: Frame, box_pixels: tuple[float, float, float, float], max_features: int
    ) -> Sequence[Point]: ...

    def estimate_homography(
        self, source: Sequence[Point], destination: Sequence[Point]
    ) -> HomographyEstimate | None: ...

    def align(
        self,
        reference: Frame,
        current: Frame,
        region: Sequence[Point],
        guesses: Sequence[Matrix3x3],
        motion: str,
    ) -> Alignment | None:
        """Register ``region`` of ``reference`` onto ``current``, starting from each guess.

        ``motion`` is ``"homography"`` (a plane) or ``"affine"`` (a small patch around a shape
        vertex). The best-verified candidate wins; ``None`` means the region could not be
        registered at all (it left the frame, or is degenerate).
        """
