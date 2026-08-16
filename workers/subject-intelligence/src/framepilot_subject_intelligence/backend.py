"""The injectable inference backend boundary.

Everything that needs OpenCV, NumPy or a model file lives behind these protocols,
so the *policy* — which detections survive, what counts as no subject, how masks
are encoded, what order results come out in — is pure Python and fully unit
testable with a scripted backend. ``opencv_backend.py`` is the real one and is
imported lazily, only when a worker actually runs.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from .geometry import PixelBox
from .protocol import DetectionLabel

#: An opaque decoded frame. Only the backend interprets it.
Frame = Any


class MediaUnreadableError(Exception):
    """The approved media handle could not be opened or decoded."""


class BackendUnavailableError(Exception):
    """The inference backend itself is missing or refuses to run on this hardware."""


class ModelUnavailableError(Exception):
    """A pinned model file is missing, unreadable, or fails its digest check."""


@dataclass(frozen=True, slots=True)
class RawDetection:
    """One detector output, in source-frame pixels.

    ``confidence`` is the model's own score, never a constant stamped on to make
    a result look measured.
    """

    label: DetectionLabel
    box: PixelBox
    confidence: float


@dataclass(frozen=True, slots=True)
class RawMask:
    """One segmentation output as a full-frame binary mask at a bounded resolution.

    The wire format carries no origin, so a mask must describe the whole frame.
    ``values`` is row-major, ``width * height`` entries, each 0 or 1.
    ``confidence`` is the mean foreground probability — a measurement, so an
    uncertain mask reports as uncertain instead of arriving as a crisp lie.
    """

    width: int
    height: int
    values: Sequence[int]
    confidence: float


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
class SubjectBackend(Protocol):
    @property
    def name(self) -> str:
        """Stable backend identity reported in the handshake and every result."""

    @property
    def model_digests(self) -> dict[str, str]:
        """sha256 of each loaded model file, for evidence lineage."""

    def open_frames(
        self, path: str, first_frame: int, last_frame_exclusive: int
    ) -> FrameSource: ...

    def detect_faces(self, frame: Frame) -> Sequence[RawDetection]: ...

    def detect_objects(self, frame: Frame) -> Sequence[RawDetection]:
        """People and things. Labels are already `person` or `object`."""

    def segment_subject(self, frame: Frame, region: PixelBox) -> RawMask:
        """Segment the subject inside ``region``, returned as a full-frame mask."""
