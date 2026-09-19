"""Exclusion regions that follow what they were drawn around (MK7.7).

An editor marks an occluder — a hand, a passer-by, a car crossing a sign — with a box on the
frame they are fixing. The occluder moves; a box that stayed where it was drawn would uncover it
a few frames later and hide plane that is in plain view. So the box follows its own content:
each frame, the content it covered on the reference frame is found again near where its motion
so far predicts it, the way a professional planar tracker's exclusion layer is itself tracked.

A box whose content is too flat to find, or that has run off the frame, keeps moving at its last
velocity rather than stopping: an occluder does not stop because it became hard to see.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from ..backend import Frame, PixelBox, TrackingBackend

#: Below this match the content was not found (it left, turned, or blurred away).
FOLLOW_MIN_MATCH: Final = 0.6


class ExclusionFollower:
    """The editor's exclusion boxes, carried from the reference frame to each tracked frame."""

    def __init__(self, backend: TrackingBackend, reference: Frame, boxes: Sequence[PixelBox]):
        self._backend = backend
        self._reference = reference
        self._drawn: tuple[PixelBox, ...] = tuple(boxes)
        self._current: list[PixelBox] = list(boxes)
        self._velocity: list[tuple[float, float]] = [(0.0, 0.0) for _ in boxes]

    @property
    def reference_boxes(self) -> tuple[PixelBox, ...]:
        """Where the boxes are on the reference frame: exactly as the editor drew them."""
        return self._drawn

    def follow(self, frame: Frame) -> tuple[PixelBox, ...]:
        """Where each box is on `frame`, the next frame in decode order."""
        for index, drawn in enumerate(self._drawn):
            last = self._current[index]
            vx, vy = self._velocity[index]
            predicted = (last[0] + vx, last[1] + vy, last[2], last[3])
            found = self._backend.follow_region(self._reference, drawn, frame, predicted)
            moved = found[0] if found is not None and found[1] >= FOLLOW_MIN_MATCH else predicted
            self._velocity[index] = (moved[0] - last[0], moved[1] - last[1])
            self._current[index] = moved
        return tuple(self._current)
