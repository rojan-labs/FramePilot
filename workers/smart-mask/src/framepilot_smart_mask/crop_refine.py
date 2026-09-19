"""Stage 3b (BR7.5): a second SAM pass on a tight crop around the subject, for a finer edge.

**Why.** SAM 2.1 decodes 256² logits for the whole frame, so at 720p one logit cell is 5 × 2.8
px and the upsampled edge sits up to a cell off the image edge. On a small subject (the pilot's
crossing, fast-motion, leave-and-re-enter and twin clips: 4-5% of the frame) that is most of the
BF@2px error, and the BR7.4 attribution showed SAM's own masks already carry it (SAM forward
BF 0.84-0.89 there, before any consensus). Guided filtering (``snap_to_image``) recovered
part of it; the rest needs more logit cells on the subject.

**What.** After tracking, for each frame whose subject is small enough that a crop around it
is at least ``MIN_GAIN`` × finer than the frame, the crop (the tracked silhouette's box, padded
by ``PAD_FRACTION`` of its long side, no narrower than ``MAX_ASPECT``) is encoded as its own
1024² image and decoded in SAM's image mode with the tracked silhouette as the prompt: its box
plus one include point at its deepest interior pixel. The crop's logits are mapped back to the
frame. Nothing is invented: the prompt is the first pass's own answer, and the crop estimate
is used only when it agrees with it (IoU ≥ ``MIN_AGREEMENT``) and SAM says the object is
present; otherwise the frame keeps the first pass.

**How it is used** (``refined_masks``): it replaces each SAM pass's edge, not its topology.
Pixels within ``CORRIDOR_CELLS`` full-frame logit cells of a pass's boundary take the crop's
decision; everything farther keeps the pass's. So a limb the crop drops, or a neighbour it
grabs, cannot change the silhouette away from the edge.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Final

import cv2
import numpy as np
import numpy.typing as npt

from .backend import SamModules
from .consensus import distance_to_boundary, iou
from .tracker import HIDDEN_DIM, IMAGE_SIZE, LOW_RES, preprocess, resize_bilinear

_log = logging.getLogger(__name__)

#: Padding around the silhouette's box, as a fraction of its long side (SAM needs context
#: around the object; its own box prompts are tight, the image around them is not).
PAD_FRACTION: Final = 0.15
#: Minimum padding in display pixels.
PAD_MIN_PX: Final = 16
#: The crop's long side is at most this many times its short side (a 16:9 frame's own ratio,
#: which SAM already sees squashed to 1024² in every tracked frame).
MAX_ASPECT: Final = 16 / 9
#: A crop is decoded only if it gives at least this many times more logit cells per pixel on
#: the subject than the whole frame did (square root of frame area over crop area, i.e. the
#: crop covers at most 1/MIN_GAIN² = 44% of the frame). Large subjects (a talking head, a
#: busy-background portrait) already have enough and pass unchanged. BR7.5 it9 measured the
#: first version, a square crop compared with the frame's SHORT side: a standing person
#: (140 × 520 px at 720p) failed it, so the pass ran on 1 of 320 frames.
MIN_GAIN: Final = 1.5
#: The crop estimate must agree with the tracked silhouette this well to be used.
MIN_AGREEMENT: Final = 0.85
#: Smallest silhouette worth a crop pass (display pixels).
MIN_AREA_PX: Final = 64
#: Half-width of the edge corridor the crop decides, in full-frame SAM logit cells.
CORRIDOR_CELLS: Final = 1.5

Bool = npt.NDArray[np.bool_]
Float = npt.NDArray[Any]


@dataclass(frozen=True, slots=True)
class CropBox:
    """``[x0, x1) × [y0, y1)`` in display pixels."""

    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0


@dataclass(frozen=True, slots=True)
class CropEstimate:
    """The crop pass's decision at display size, and what it was measured against."""

    mask: Bool
    box: CropBox
    agreement: float
    score: float


def _fit(start: float, size: int, limit: int) -> tuple[int, int]:
    """A span of ``size`` starting near ``start`` shifted to lie within ``[0, limit)``."""
    size = min(size, limit)
    begin = round(start)
    begin = min(max(begin, 0), limit - size)
    return begin, begin + size


def crop_box(prior: Bool) -> CropBox | None:
    """The padded, square-where-possible crop around ``prior``, or None when not worth it."""
    ys, xs = np.nonzero(prior)
    if len(xs) < MIN_AREA_PX:
        return None
    height, width = prior.shape
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    long_side = max(x1 - x0, y1 - y0)
    pad = 2 * max(PAD_MIN_PX, round(PAD_FRACTION * long_side))
    crop_w, crop_h = x1 - x0 + pad, y1 - y0 + pad
    # SAM squashes its input to 1024²; keep the crop within the aspect a 16:9 frame has.
    crop_w = max(crop_w, round(crop_h / MAX_ASPECT))
    crop_h = max(crop_h, round(crop_w / MAX_ASPECT))
    left, right = _fit((x0 + x1) / 2 - crop_w / 2, crop_w, width)
    top, bottom = _fit((y0 + y1) / 2 - crop_h / 2, crop_h, height)
    # Logit cells per subject pixel scale with the area SAM's 1024² input covers.
    gain = ((width * height) / ((right - left) * (bottom - top))) ** 0.5
    if gain < MIN_GAIN:
        return None
    return CropBox(left, top, right, bottom)


def _deepest_point(mask: Bool) -> tuple[float, float]:
    depth = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 5)
    y, x = np.unravel_index(int(np.argmax(depth)), depth.shape)
    return float(x) + 0.5, float(y) + 0.5


def refine_in_crop(
    modules: SamModules, frame: npt.NDArray[np.uint8], prior: Bool
) -> CropEstimate | None:
    """One crop pass for one frame; None when the frame keeps the tracked silhouette."""
    box = crop_box(prior)
    if box is None:
        return None
    rgb = np.ascontiguousarray(frame[box.y0 : box.y1, box.x0 : box.x1])
    local = prior[box.y0 : box.y1, box.x0 : box.x1]
    if not local.any():
        return None
    features = modules.encode_image(preprocess(rgb))
    sx, sy = IMAGE_SIZE / box.width, IMAGE_SIZE / box.height
    ys, xs = np.nonzero(local)
    px, py = _deepest_point(local)
    coords = np.array(
        [[[xs.min() * sx, ys.min() * sy], [(xs.max() + 1) * sx, (ys.max() + 1) * sy],
          [px * sx, py * sy]]],
        np.float32,
    )  # fmt: skip
    labels = np.array([[2, 3, 1]], np.int32)
    no_mem = modules.constants.no_mem_embed.reshape(1, HIDDEN_DIM, 1, 1).astype(np.float32)
    decoded = modules.decode_points(features.fpn2 + no_mem, features, coords, labels, False)
    score = float(np.asarray(decoded.object_score_logits).reshape(-1)[0])
    low_res = np.asarray(decoded.low_res_masks, np.float32).reshape(LOW_RES, LOW_RES)
    local_mask = resize_bilinear(low_res, box.height, box.width) > 0
    mask = np.zeros_like(prior)
    mask[box.y0 : box.y1, box.x0 : box.x1] = local_mask
    agreement = iou(mask, prior)
    if score <= 0 or agreement < MIN_AGREEMENT:
        _log.debug("crop pass discarded: score %.2f, agreement %.3f", score, agreement)
        return None
    return CropEstimate(mask=mask, box=box, agreement=agreement, score=score)


def corridor_px(height: int, width: int) -> int:
    """The edge corridor in display pixels: ``CORRIDOR_CELLS`` of SAM's coarser logit axis."""
    return max(2, round(CORRIDOR_CELLS * max(height, width) / LOW_RES))


def refined_masks(masks: list[Bool], crop: Bool | None) -> list[Bool]:
    """Each SAM pass's mask with its edge corridor decided by the crop estimate."""
    if crop is None or not masks:
        return masks
    reach = corridor_px(*crop.shape)
    out: list[Bool] = []
    for mask in masks:
        near = distance_to_boundary(mask) <= reach
        out.append(np.where(near, crop, mask))
    return out


__all__ = [
    "CropBox",
    "CropEstimate",
    "corridor_px",
    "crop_box",
    "refine_in_crop",
    "refined_masks",
]
