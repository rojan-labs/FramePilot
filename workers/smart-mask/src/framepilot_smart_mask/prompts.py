"""Turn a request's prompts into per-frame conditioning, and editor inputs into constraints.

* ``points`` and ``box`` prompts on the same frame merge into one SAM prompt, box first (the
  upstream ``add_new_points_or_box`` order: labels 2/3 for the box corners, then 1/0 points).
* ``lock``: an editor-approved alpha PNG. It seeds SAM's memory as a mask prompt AND is copied
  verbatim into the matte (the host checks it bit for bit).
* ``brush``: a correction PNG with keep = 255, remove = 0, untouched = 128. Keep/remove pixels
  are hard constraints on that frame's alpha; the frame is re-seeded from the corrected mask.

A prompt whose pts is not exactly one of the requested frames' pts is refused: identity is a
pts, never a nearest frame.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Final

import numpy as np
import numpy.typing as npt

from .protocol import MatteRequest, ProtocolError
from .sandbox import InputDirectory

BRUSH_KEEP: Final = 255
BRUSH_REMOVE: Final = 0
BRUSH_UNTOUCHED: Final = 128
BOX_LABELS: Final = (2, 3)
INCLUDE_LABEL: Final = 1
EXCLUDE_LABEL: Final = 0


@dataclass(slots=True)
class FramePrompts:
    """Everything the editor said about one frame (index within the job range)."""

    index: int
    pts: int
    coords: list[tuple[float, float]] = field(default_factory=list)
    labels: list[int] = field(default_factory=list)
    has_box: bool = False
    lock: npt.NDArray[np.uint8] | None = None
    keep: npt.NDArray[np.bool_] | None = None
    remove: npt.NDArray[np.bool_] | None = None

    @property
    def has_points(self) -> bool:
        return bool(self.coords)


@dataclass(frozen=True, slots=True)
class ResolvedPrompts:
    frames: dict[int, FramePrompts]

    @property
    def locked(self) -> dict[int, npt.NDArray[np.uint8]]:
        return {index: frame.lock for index, frame in self.frames.items() if frame.lock is not None}

    @property
    def point_frames(self) -> list[int]:
        return sorted(index for index, frame in self.frames.items() if frame.has_points)

    @property
    def brushed(self) -> list[int]:
        return sorted(index for index, frame in self.frames.items() if frame.keep is not None)


def decode_gray_png(data: bytes, width: int, height: int, what: str) -> npt.NDArray[np.uint8]:
    """Decode an 8-bit single-channel PNG at exactly ``width`` x ``height``."""
    import cv2

    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ProtocolError("invalid_request", f"The {what} file is not a PNG.")
    image: Any = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.dtype != np.uint8 or image.ndim != 2:
        raise ProtocolError("invalid_request", f"The {what} file must be an 8-bit grayscale PNG.")
    if image.shape != (height, width):
        raise ProtocolError(
            "invalid_request", f"The {what} file is not at the matte's display size."
        )
    decoded: npt.NDArray[np.uint8] = image
    return decoded


def resolve_prompts(
    request: MatteRequest,
    frame_pts: tuple[int, ...],
    width: int,
    height: int,
    inputs: InputDirectory | None,
) -> ResolvedPrompts:
    """Map every prompt to its frame index; decode and validate brush and lock files."""
    index_of = {pts: index for index, pts in enumerate(frame_pts)}
    frames: dict[int, FramePrompts] = {}
    for prompt in request.prompts:
        index = index_of.get(prompt.pts)
        if index is None:
            raise ProtocolError(
                "invalid_request", "A prompt's pts is not one of the requested frames."
            )
        frame = frames.setdefault(index, FramePrompts(index=index, pts=prompt.pts))
        if prompt.kind == "box":
            if frame.has_box:
                raise ProtocolError("invalid_request", "A frame may carry at most one box prompt.")
            assert prompt.box is not None
            box = prompt.box
            corners = [(box.x, box.y), (box.x + box.width, box.y + box.height)]
            frame.coords[:0] = corners
            frame.labels[:0] = list(BOX_LABELS)
            frame.has_box = True
        elif prompt.kind == "points":
            for point in prompt.points:
                frame.coords.append((point.x, point.y))
                frame.labels.append(INCLUDE_LABEL if point.label == "include" else EXCLUDE_LABEL)
        else:
            if inputs is None or prompt.file is None:
                raise ProtocolError(
                    "invalid_request", "Brush and lock prompts need the inputs handle."
                )
            image = decode_gray_png(inputs.read_bytes(prompt.file), width, height, prompt.kind)
            if prompt.kind == "lock":
                frame.lock = image
            else:
                allowed = (
                    (image == BRUSH_KEEP) | (image == BRUSH_REMOVE) | (image == BRUSH_UNTOUCHED)
                )
                if not bool(allowed.all()):
                    raise ProtocolError(
                        "invalid_request",
                        "A correction PNG may hold only keep (255), remove (0) or untouched (128).",
                    )
                frame.keep = image == BRUSH_KEEP
                frame.remove = image == BRUSH_REMOVE
    for frame in frames.values():
        if frame.lock is not None and (frame.keep is not None or frame.has_points):
            raise ProtocolError(
                "invalid_request", "A locked frame cannot also carry points, a box or a brush."
            )
    return ResolvedPrompts(frames=frames)


def apply_constraints(
    alpha: npt.NDArray[np.uint8], frame: FramePrompts | None
) -> npt.NDArray[np.uint8]:
    """Locks replace the frame; brush keep/remove pixels are forced. Returns a new array."""
    if frame is None:
        return alpha
    if frame.lock is not None:
        return frame.lock.copy()
    out = alpha.copy()
    if frame.keep is not None:
        out[frame.keep] = 255
    if frame.remove is not None:
        out[frame.remove] = 0
    return out


def constrained_pixels(frame: FramePrompts | None, shape: tuple[int, int]) -> npt.NDArray[np.bool_]:
    """Pixels no later stage may change on this frame."""
    fixed = np.zeros(shape, np.bool_)
    if frame is None:
        return fixed
    if frame.lock is not None:
        fixed[:] = True
        return fixed
    if frame.keep is not None:
        fixed |= frame.keep
    if frame.remove is not None:
        fixed |= frame.remove
    return fixed


__all__ = [
    "BRUSH_KEEP",
    "BRUSH_REMOVE",
    "BRUSH_UNTOUCHED",
    "FramePrompts",
    "ResolvedPrompts",
    "apply_constraints",
    "constrained_pixels",
    "decode_gray_png",
    "resolve_prompts",
]
