"""Stage 5: per-pixel consensus of independent estimates, the unknown band, a per-frame score.

Estimates per frame: SAM forward, SAM backward (when a pass reached the frame), BiRefNet
(α ≥ 0.5) and the previous frame's final alpha warped by DIS flow.

**What BR0 got wrong, and how this differs.** The BR0 prototype put every disagreement pixel
(plus 6 px around every estimate's edge) into the band and gave the band BiRefNet's alpha. When
BiRefNet dropped an arm or matted a background object, the whole region was "disagreement",
so the binarised matte *was* BiRefNet's mask (BR0.4: that is where most of the IoU loss came
from). Here:

* the silhouette is the **majority vote** of the estimates (ties broken by the SAM logits);
* the **unknown band** is a ring of ``edge_radius`` around the majority boundary, plus
  disagreement pixels close to that boundary where BiRefNet's alpha is fractional (a soft edge);
* hard disagreement (a missing limb, a background island), wherever it lies, is decided by the
  vote, not handed to BiRefNet, and is **measured** in the frame score so verification and
  self-correction see it;
* inside the band, alpha is BiRefNet's fractional alpha; outside it is exactly 0 or 1.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

import cv2
import numpy as np
import numpy.typing as npt

#: Band half-width at 1080p; scaled by frame height, at least 2 px.
EDGE_RADIUS_1080P: Final = 6
#: Disagreement within this multiple of the edge radius of the boundary is edge uncertainty.
NEAR_EDGE_MULTIPLE: Final = 4
#: Denominator floor for fractions of a tiny or empty subject (pixels).
MIN_AREA_PX: Final = 64

Bool = npt.NDArray[np.bool_]


def edge_radius(height: int) -> int:
    return max(2, round(EDGE_RADIUS_1080P * height / 1080))


def disk(radius: int) -> npt.NDArray[Any]:
    kernel: npt.NDArray[Any] = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)
    )
    return kernel


def boundary(mask: Bool) -> Bool:
    m = mask.astype(np.uint8)
    edge: Bool = (m - cv2.erode(m, np.ones((3, 3), np.uint8))).astype(bool)
    return edge


def iou(a: Bool, b: Bool) -> float:
    union = int(np.logical_or(a, b).sum())
    return 1.0 if union == 0 else float(np.logical_and(a, b).sum() / union)


@dataclass(frozen=True, slots=True)
class FrameConsensus:
    alpha: npt.NDArray[np.uint8]
    band: Bool
    majority: Bool
    score: dict[str, float]


def consensus(
    sam_masks: list[Bool],
    sam_logits: npt.NDArray[Any] | None,
    birefnet_alpha: npt.NDArray[np.uint8],
    warped_previous: npt.NDArray[Any] | None,
    radius: int,
) -> FrameConsensus:
    """Combine one frame's estimates. ``warped_previous`` is alpha in [0,255] float or None."""
    birefnet = birefnet_alpha >= 128
    votes: list[Bool] = [*sam_masks, birefnet]
    if warped_previous is not None:
        votes.append(warped_previous >= 127.5)
    stack = np.stack(votes)
    count = stack.sum(axis=0, dtype=np.int32)
    n = len(votes)
    majority = count * 2 > n
    if n % 2 == 0:
        tie = count * 2 == n
        tie_break = sam_logits > 0 if sam_logits is not None else birefnet
        majority = majority | (tie & tie_break)
    disagreement = stack.any(axis=0) & ~stack.all(axis=0)
    edge = boundary(majority)
    ring = cv2.dilate(edge.astype(np.uint8), disk(radius)).astype(bool)
    near = cv2.dilate(edge.astype(np.uint8), disk(radius * NEAR_EDGE_MULTIPLE)).astype(bool)
    # Only pixels BiRefNet itself calls fractional are soft-edge uncertainty; a hard
    # disagreement (a limb one estimate dropped) is decided by the vote, even near the edge.
    fractional = (birefnet_alpha > 0) & (birefnet_alpha < 255)
    band = ring | (disagreement & near & fractional)
    alpha = np.where(majority, 255, 0).astype(np.uint8)
    # Inside the band BiRefNet supplies alpha only where it is fractional or agrees with the
    # vote; a hard contradiction keeps the majority's 0 or 255.
    trusted = band & (fractional | (birefnet == majority))
    alpha[trusted] = birefnet_alpha[trusted]
    area = max(int(majority.sum()), MIN_AREA_PX)
    # Disagreement not explained as a soft edge: a dropped limb, an extra island, a wrong subject.
    hard_disagreement = disagreement & ~(near & fractional)
    score = {
        "samPairIoU": iou(sam_masks[0], sam_masks[1]) if len(sam_masks) == 2 else float("nan"),
        "samBirefnetIoU": iou(np.logical_or.reduce(sam_masks) if sam_masks else majority, birefnet),
        "majorityBirefnetIoU": iou(majority, birefnet),
        "disagreementFraction": float(disagreement.sum() / area),
        "hardDisagreementFraction": float(hard_disagreement.sum() / area),
        "bandFraction": float(band.sum() / area),
        "area": float(majority.sum()),
        "estimates": float(n),
    }
    score["score"] = frame_score(score)
    return FrameConsensus(alpha=alpha, band=band, majority=majority, score=score)


def frame_score(parts: dict[str, float]) -> float:
    """One number, 0 (every estimate agrees) to 1: the largest disagreement signal."""
    signals = [1.0 - parts["samBirefnetIoU"], parts["hardDisagreementFraction"]]
    if not np.isnan(parts["samPairIoU"]):
        signals.append(1.0 - parts["samPairIoU"])
    return float(min(max(signals), 1.0))


__all__ = ["FrameConsensus", "boundary", "consensus", "disk", "edge_radius", "frame_score", "iou"]
