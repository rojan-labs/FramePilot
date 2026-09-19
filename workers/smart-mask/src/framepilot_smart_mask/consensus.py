"""Stage 5: per-pixel consensus of independent estimates, the unknown band, a per-frame score.

Estimates per frame: SAM forward, SAM backward (when a pass reached the frame), BiRefNet
(α ≥ 0.5) and the previous frame's final alpha warped by DIS flow.

**What BR0 got wrong, and how this differs.** The BR0 prototype put every disagreement pixel
(plus 6 px around every estimate's edge) into the band and gave the band BiRefNet's alpha. When
BiRefNet dropped an arm or matted a background object, the whole region was "disagreement",
so the binarised matte *was* BiRefNet's mask (BR0.4: that is where most of the IoU loss came
from).

**BR7.4: topology from SAM, the edge from BiRefNet only where the two agree.** The BR7.4 CI
eval (it0, BiRefNet at its trained 2048² tile) measured each estimate against ground truth:
BiRefNet's edge is the most precise one where it agrees with SAM (hair, product, similar
colour: BF@2px 0.98–1.00 against SAM's 0.93–0.97), and wrong by whole regions where it does
not (low light, a crossing person, the talking head: IoU 0.81–0.95 against SAM's 0.89–0.99).
Letting it vote on the silhouette cost frames either way. So:

* the **silhouette** is the vote of the SAM passes and the warped previous alpha (ties broken
  by the SAM logits); BiRefNet does not vote on topology;
* **edge trust** is per frame: when BiRefNet's boundary agrees with the silhouette's within
  ``AGREEMENT_TOLERANCE`` px on at least ``EDGE_AGREEMENT`` of both boundaries (a BF-style
  F-measure), BiRefNet decides every pixel within ``CORRIDOR`` px of the silhouette's
  boundary (SAM's 256² logits are ~3–5 px coarse at 720p; BiRefNet's are not). Otherwise
  the silhouette's own edge stands;
* the **unknown band** is a ring of ``edge_radius`` around the final boundary. Inside it, on
  a trusted frame, alpha is BiRefNet's fractional alpha where it is fractional or agrees with
  the decision; on an untrusted frame the edge stays binary (BiRefNet's soft edge there is
  a soft edge in the wrong place);
* an editor's **Edge brush** stroke (``extra_band``, BR6.10) joins the band on that frame and
  always re-mattes with BiRefNet's alpha where it is fractional or agrees: the stroke never
  sets alpha itself;
* hard disagreement between ALL the estimates (BiRefNet included) is still **measured** in
  the frame score, so verification and self-correction see it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

import cv2
import numpy as np
import numpy.typing as npt

#: Band half-width at 1080p; scaled by frame height, at least 2 px.
EDGE_RADIUS_1080P: Final = 6
#: BiRefNet's edge is trusted on a frame when its boundary and the silhouette's agree within
#: this many px (at 1080p, scaled) on at least EDGE_AGREEMENT of both (fitted on the it0
#: calibration split: 0.9 at 3 px for 720p kept every category's gain and dropped the losses).
AGREEMENT_TOLERANCE_1080P: Final = 4.5
EDGE_AGREEMENT: Final = 0.9
#: On a trusted frame BiRefNet decides pixels this close (px at 1080p, scaled) to the
#: silhouette's boundary: about one SAM low-res cell at 720p.
CORRIDOR_1080P: Final = 4.5
#: Disagreement within this multiple of the edge radius of the boundary is edge uncertainty.
NEAR_EDGE_MULTIPLE: Final = 4
#: Denominator floor for fractions of a tiny or empty subject (pixels).
MIN_AREA_PX: Final = 64

Bool = npt.NDArray[np.bool_]


def edge_radius(height: int) -> int:
    return max(2, round(EDGE_RADIUS_1080P * height / 1080))


#: SAM's masks are upsampled from 256² logits, so their edges sit up to a low-res cell off the
#: image edge. A guided filter (He et al.) with the frame as guide snaps them to it before the
#: vote. Fitted on the BR7.4 it1 calibration split (radius 6 px at 720p, eps 0.01 of the unit
#: range); held out: talking_head BF 0.974 -> 0.993, crossing IoU 0.898 -> 0.903, walk_pan
#: 0.979 -> 0.981; a larger radius cost similar_colour (subject and background alike).
GUIDED_RADIUS_1080P: Final = 9
GUIDED_EPS: Final = 0.01


def snap_to_image(masks: list[Bool], frame: npt.NDArray[np.uint8]) -> list[Bool]:
    """Each SAM mask guided-filtered with the frame, re-thresholded at one half."""
    if not masks:
        return masks
    guide = frame.astype(np.float32) / 255.0
    radius = _scaled(GUIDED_RADIUS_1080P, frame.shape[0])
    snapped: list[Bool] = []
    for mask in masks:
        filtered = cv2.ximgproc.guidedFilter(guide, mask.astype(np.float32), radius, GUIDED_EPS)
        snapped.append(filtered >= 0.5)
    return snapped


#: On a frame whose edge BiRefNet is not trusted with, the band still needs a soft edge (a hard
#: 0/255 step is a halo in the composite and flickers): the silhouette guided-filtered with the
#: frame, clamped so it binarises exactly as the silhouette does. Chosen on the BR7.4 it4
#: calibration split by replay: talking_head band SAD 1.63 -> 0.85, foreground ΔE 9.0 -> 4.5,
#: dtSSD 3.4 -> 1.6; IoU and BF@2px unchanged by construction.
SOFT_EDGE_RADIUS_1080P: Final = 4.5
SOFT_EDGE_EPS: Final = 0.01


def soft_edge(
    result: FrameConsensus, frame: npt.NDArray[np.uint8], extra_band: Bool | None = None
) -> npt.NDArray[np.uint8]:
    """``result.alpha`` with a guided-filter soft edge in the band when the edge is SAM's.

    Pixels under an Edge brush stroke (``extra_band``) keep the matted alpha consensus gave them.
    """
    if result.score.get("edgeTrusted", 1.0) or not result.band.any():
        return result.alpha
    guide = frame.astype(np.float32) / 255.0
    radius = _scaled(SOFT_EDGE_RADIUS_1080P, frame.shape[0])
    filtered = cv2.ximgproc.guidedFilter(
        guide, result.majority.astype(np.float32), radius, SOFT_EDGE_EPS
    )
    soft = np.clip(np.round(filtered * 255.0), 0, 255).astype(np.uint8)
    soft = np.where(result.majority, np.maximum(soft, 128), np.minimum(soft, 127)).astype(np.uint8)
    region = result.band if extra_band is None else result.band & ~extra_band
    alpha = result.alpha.copy()
    alpha[region] = soft[region]
    return alpha


def _scaled(px_1080p: float, height: int) -> int:
    return max(2, round(px_1080p * height / 1080))


def disk(radius: int) -> npt.NDArray[Any]:
    kernel: npt.NDArray[Any] = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)
    )
    return kernel


def boundary(mask: Bool) -> Bool:
    m = mask.astype(np.uint8)
    edge: Bool = (m - cv2.erode(m, np.ones((3, 3), np.uint8))).astype(bool)
    return edge


def distance_to_boundary(mask: Bool) -> npt.NDArray[Any]:
    """Per pixel, the distance (px) to the nearest boundary pixel of ``mask``."""
    edge = boundary(mask)
    if not edge.any():
        return np.full(mask.shape, np.inf, np.float32)
    out: npt.NDArray[Any] = cv2.distanceTransform((~edge).astype(np.uint8), cv2.DIST_L2, 5)
    return out


def boundary_agreement(a: Bool, b: Bool, tolerance: int) -> float:
    """F-measure of the two masks' boundary pixels lying within ``tolerance`` px of the other's."""
    edge_a, edge_b = boundary(a), boundary(b)
    if not edge_a.any() and not edge_b.any():
        return 1.0
    if not edge_a.any() or not edge_b.any():
        return 0.0
    precision = float((distance_to_boundary(b)[edge_a] <= tolerance).mean())
    recall = float((distance_to_boundary(a)[edge_b] <= tolerance).mean())
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


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
    extra_band: Bool | None = None,
    silhouette: Bool | None = None,
) -> FrameConsensus:
    """Combine one frame's estimates. ``warped_previous`` is alpha in [0,255] float or None.

    ``extra_band`` (the Edge brush) widens the unknown band; it is not a vote and not a
    constraint, so it changes only which pixels may take BiRefNet's fractional alpha.
    ``silhouette`` (BR7.5, the temporal vote of ``stabilise.temporal_vote``) replaces the
    per-frame vote of the SAM passes and the warped previous alpha; every score part is still
    measured on this frame's own estimates.
    """
    birefnet = birefnet_alpha >= 128
    votes: list[Bool] = [*sam_masks, birefnet]
    if warped_previous is not None:
        votes.append(warped_previous >= 127.5)
    stack = np.stack(votes)
    n = len(votes)
    if silhouette is None:
        silhouette = _silhouette(sam_masks, sam_logits, birefnet, warped_previous)
    height = birefnet.shape[0]
    trusted_edge = (
        boundary_agreement(silhouette, birefnet, _scaled(AGREEMENT_TOLERANCE_1080P, height))
        >= EDGE_AGREEMENT
    )
    majority = silhouette
    if trusted_edge:
        near_edge = distance_to_boundary(silhouette) <= _scaled(CORRIDOR_1080P, height)
        majority = np.where(near_edge, birefnet, silhouette)
    disagreement = stack.any(axis=0) & ~stack.all(axis=0)
    edge = boundary(majority)
    ring = cv2.dilate(edge.astype(np.uint8), disk(radius)).astype(bool)
    near = cv2.dilate(edge.astype(np.uint8), disk(radius * NEAR_EDGE_MULTIPLE)).astype(bool)
    # Only pixels BiRefNet itself calls fractional are soft-edge uncertainty; a hard
    # disagreement (a limb one estimate dropped) is decided by the vote, even near the edge.
    fractional = (birefnet_alpha > 0) & (birefnet_alpha < 255)
    band = ring
    if extra_band is not None:
        band = band | extra_band
    alpha = np.where(majority, 255, 0).astype(np.uint8)
    # BiRefNet supplies band alpha only where it is fractional or agrees with the decision, and
    # only on a frame whose edge it is trusted with (or under an Edge brush stroke).
    matted = ring if trusted_edge else np.zeros_like(ring)
    if extra_band is not None:
        matted = matted | extra_band
    trusted = matted & (fractional | (birefnet == majority))
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
        "edgeTrusted": 1.0 if trusted_edge else 0.0,
    }
    score["score"] = frame_score(score)
    return FrameConsensus(alpha=alpha, band=band, majority=majority, score=score)


def _silhouette(
    sam_masks: list[Bool],
    sam_logits: npt.NDArray[Any] | None,
    birefnet: Bool,
    warped_previous: npt.NDArray[Any] | None,
) -> Bool:
    """Vote of the SAM passes and the warped previous alpha; BiRefNet only when nothing else."""
    votes: list[Bool] = list(sam_masks)
    if warped_previous is not None:
        votes.append(warped_previous >= 127.5)
    if not votes:
        return birefnet
    count = np.sum(votes, axis=0, dtype=np.int32)
    majority: Bool = count * 2 > len(votes)
    if len(votes) % 2 == 0:
        tie = count * 2 == len(votes)
        tie_break = sam_logits > 0 if sam_logits is not None else birefnet
        majority = majority | (tie & tie_break)
    return majority


def frame_score(parts: dict[str, float]) -> float:
    """One number, 0 (every estimate agrees) to 1: the largest disagreement signal."""
    signals = [1.0 - parts["samBirefnetIoU"], parts["hardDisagreementFraction"]]
    if not np.isnan(parts["samPairIoU"]):
        signals.append(1.0 - parts["samPairIoU"])
    return float(min(max(signals), 1.0))


__all__ = [
    "FrameConsensus",
    "boundary",
    "boundary_agreement",
    "consensus",
    "disk",
    "distance_to_boundary",
    "edge_radius",
    "frame_score",
    "iou",
    "snap_to_image",
    "soft_edge",
]
