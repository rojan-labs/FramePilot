"""Stage 10: independent per-frame checks → ``needsReview`` ranges with a reason.

Signals are measured once per frame without thresholds (:func:`frame_signals`), then compared
with a frozen :class:`Thresholds` (:func:`flag_frames`). Keeping the two apart is what lets the
accuracy harness fix thresholds on a held-out split and score another (BR3.15) instead of
tuning on the set it reports.

Checks (plan 02 stage 10, plus the pipeline's own disagreement signals):

=====  ===================================================================  ====================
code   what                                                                 reason
=====  ===================================================================  ====================
a      alpha re-warped by DIS flow from each neighbour disagrees with this  flow_inconsistent
       frame (consistent-flow pixels only), on BOTH sides
b      a significant island or hole appears that neither neighbour has      new_region
c      alpha gradient does not follow image gradient inside the band        edge_misaligned
c2     strong image edges just outside the matte that no alpha edge         edge_misaligned
       explains (a missed limb every estimate agrees on)
d      area or centroid jumps against the neighbourhood median              flow_inconsistent
e      estimates disagree: SAM fwd/bwd, SAM/BiRefNet, hard disagreement,    estimates_disagree
       band size
f      SAM's object score contradicts the delivered matte                   occlusion
g      only one SAM estimate reached the frame                              estimates_disagree
h      empty matte next to non-empty frames (a presence transition)         subject_lost
m      wide band under fast motion                                          motion_blur
u      a check could not run (missing signal)                               estimates_disagree
=====  ===================================================================  ====================

A frame the pipeline could not verify is flagged, never reported verified. Locked frames are
editor-approved and never flagged.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any, Final

import cv2
import numpy as np
import numpy.typing as npt

from .consensus import boundary, disk, edge_radius
from .flow import consistent, warp
from .protocol import MAX_REVIEW_RANGES, ReviewRange, ReviewReason

MIN_COMPONENT_FRACTION: Final = 0.0005  # 06 leak rate: a region > 0.05% of the frame
RING_OUT_PX_1080P: Final = 16
EDGE_PERCENTILE: Final = 90

REASON_BY_CHECK: Final[dict[str, ReviewReason]] = {
    "a": "flow_inconsistent",
    "b": "new_region",
    "c": "edge_misaligned",
    "c2": "edge_misaligned",
    "d": "flow_inconsistent",
    "e": "estimates_disagree",
    "f": "occlusion",
    "g": "estimates_disagree",
    "h": "subject_lost",
    "m": "motion_blur",
    "u": "estimates_disagree",
}
#: When a frame fails several checks, the range carries the most specific reason.
REASON_PRIORITY: Final[tuple[ReviewReason, ...]] = (
    "subject_lost",
    "occlusion",
    "new_region",
    "motion_blur",
    "edge_misaligned",
    "flow_inconsistent",
    "estimates_disagree",
)


@dataclass(frozen=True, slots=True)
class Thresholds:
    """Frozen per calibration. ``None`` disables a check."""

    a_rewarp_mismatch: float | None = 0.05
    b_components: bool = True
    c_edge_corr: float | None = 0.20
    c2_unexplained: float | None = 0.5
    d_area_logratio: float | None = 0.15
    d_centroid_frac: float | None = 0.25
    e_sam_pair_iou: float | None = 0.98
    e_sam_birefnet_iou: float | None = 0.98
    e_hard_disagreement: float | None = 0.02
    e_band_frac: float | None = 0.40
    f_object_score: bool = True
    g_single_estimate: bool = False
    h_presence_window: int = 3
    m_flow_px: float | None = None
    m_band_frac: float | None = None
    version: str = "br0-attempt-4"

    def as_json(self) -> dict[str, Any]:
        return asdict(self)


Float = npt.NDArray[Any]


def _components(mask: npt.NDArray[np.bool_], min_px: int) -> tuple[int, int]:
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    islands = int(sum(stats[i, cv2.CC_STAT_AREA] >= min_px for i in range(1, count)))
    inverse = (~mask).astype(np.uint8)
    count2, labels, stats2, _ = cv2.connectedComponentsWithStats(inverse, connectivity=4)
    border = set(
        np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])).tolist()
    )
    holes = int(
        sum(stats2[i, cv2.CC_STAT_AREA] >= min_px for i in range(1, count2) if i not in border)
    )
    return islands, holes


def _magnitude(values: Float) -> Float:
    out: Float = cv2.magnitude(
        cv2.Sobel(values, cv2.CV_32F, 1, 0), cv2.Sobel(values, cv2.CV_32F, 0, 1)
    )
    return out


def edge_correlation(alpha: Float, gray: Float, band: npt.NDArray[np.bool_]) -> float:
    if int(band.sum()) < 50:
        return 1.0
    gradient_alpha = _magnitude(alpha)[band]
    gradient_image = _magnitude(gray)[band]
    if gradient_alpha.std() < 1e-6 or gradient_image.std() < 1e-6:
        return 0.0
    return float(np.corrcoef(gradient_alpha, gradient_image)[0, 1])


def unexplained_edges(
    alpha: Float, gray: Float, mask: npt.NDArray[np.bool_], ring_px: int
) -> float:
    if not mask.any():
        return 0.0
    magnitude = _magnitude(gray)
    mask8 = mask.astype(np.uint8)
    ring = cv2.dilate(mask8, disk(ring_px)).astype(bool) & ~cv2.dilate(mask8, disk(2)).astype(bool)
    near = cv2.dilate(mask8, disk(ring_px * 3)).astype(bool)
    threshold = np.percentile(magnitude[near], EDGE_PERCENTILE)
    alpha_edges = _magnitude(alpha) > 0.05
    explained = cv2.dilate(alpha_edges.astype(np.uint8), disk(2)).astype(bool)
    strong = (magnitude > threshold) & ring & ~explained
    return float(strong.sum() / max(int(boundary(mask).sum()), 1))


def frame_signals(
    index: int,
    alphas: Sequence[npt.NDArray[np.uint8]],
    grays: Sequence[npt.NDArray[np.uint8]],
    flow: Any,
    consensus_score: dict[str, float],
    sam_scores: tuple[float, float],
    bands: Sequence[npt.NDArray[np.bool_]],
) -> dict[str, Any]:
    """Threshold-free measurements for one frame. ``flow(source, target)`` as in flow.py."""
    alpha = alphas[index]
    mask = alpha >= 128
    height, width = mask.shape
    area = int(mask.sum())
    rewarp: list[float] = []
    motion: list[float] = []
    for neighbour in (index - 1, index + 1):
        if not 0 <= neighbour < len(alphas):
            continue
        forward = flow(neighbour, index)
        backward = flow(index, neighbour)
        trusted = consistent(forward, backward)
        warped = warp(alphas[neighbour].astype(np.float32), forward) >= 127.5
        denominator = max(int(np.logical_or(mask, warped)[trusted].sum()), 1)
        rewarp.append(float(np.logical_xor(mask, warped)[trusted].sum() / denominator))
        if mask.any():
            motion.append(float(np.hypot(forward[..., 0], forward[..., 1])[mask].mean()))
    ys, xs = np.nonzero(mask)
    islands, holes = _components(mask, int(MIN_COMPONENT_FRACTION * height * width))
    ring = max(4, round(RING_OUT_PX_1080P * height / 1080))
    band = (
        bands[index]
        if bands[index].any()
        else cv2.dilate(boundary(mask).astype(np.uint8), disk(edge_radius(height))).astype(bool)
    )
    alpha_unit = alpha.astype(np.float32) / 255.0
    gray = grays[index].astype(np.float32)
    return {
        "area": area,
        "cx": float(xs.mean()) if area else None,
        "cy": float(ys.mean()) if area else None,
        "rewarp": rewarp,
        "motionPx": max(motion) if motion else 0.0,
        "islands": islands,
        "holes": holes,
        "edgeCorr": edge_correlation(alpha_unit, gray, band),
        "unexplainedEdges": unexplained_edges(alpha_unit, gray, mask, ring),
        "samPairIoU": consensus_score.get("samPairIoU", float("nan")),
        "samBirefnetIoU": consensus_score.get("samBirefnetIoU", float("nan")),
        "hardDisagreement": consensus_score.get("hardDisagreementFraction", float("nan")),
        "bandFrac": consensus_score.get("bandFraction", float("nan")),
        "estimates": consensus_score.get("estimates", float("nan")),
        "fwdScore": sam_scores[0],
        "bwdScore": sam_scores[1],
    }


def _nan(value: Any) -> bool:
    return value is None or (isinstance(value, float) and math.isnan(value))


def flag_frames(
    signals: Sequence[dict[str, Any]], thresholds: Thresholds, locked: set[int]
) -> list[list[str]]:
    """Checks each frame failed (empty = verified)."""
    out: list[list[str]] = []
    count = len(signals)
    for index, s in enumerate(signals):
        if index in locked:
            out.append([])
            continue
        why: set[str] = set()
        t = thresholds
        if (
            t.a_rewarp_mismatch is not None
            and s["rewarp"]
            and min(s["rewarp"]) > t.a_rewarp_mismatch
        ):
            why.add("a")
        if t.b_components:
            neighbours = [signals[k] for k in (index - 1, index + 1) if 0 <= k < count]
            if neighbours and (
                s["islands"] > max(n["islands"] for n in neighbours)
                or s["holes"] > max(n["holes"] for n in neighbours)
            ):
                why.add("b")
        if t.c_edge_corr is not None and s["area"] and s["edgeCorr"] < t.c_edge_corr:
            why.add("c")
        if t.c2_unexplained is not None and s["unexplainedEdges"] > t.c2_unexplained:
            why.add("c2")
        window = [signals[k] for k in range(max(0, index - 2), min(count, index + 3)) if k != index]
        areas = [w["area"] for w in window]
        median = float(np.median(areas)) if areas else 0.0
        if (window and (s["area"] == 0) != (median == 0)) or (
            t.d_area_logratio is not None
            and s["area"]
            and median
            and abs(math.log(s["area"] / median)) > t.d_area_logratio
        ):
            why.add("d")
        elif t.d_centroid_frac is not None and s["area"]:
            centres = [(w["cx"], w["cy"]) for w in window if w["area"]]
            if centres:
                mx = float(np.median([c[0] for c in centres]))
                my = float(np.median([c[1] for c in centres]))
                if math.hypot(s["cx"] - mx, s["cy"] - my) > t.d_centroid_frac * math.sqrt(
                    s["area"]
                ):
                    why.add("d")
        if (
            t.e_sam_pair_iou is not None
            and not _nan(s["samPairIoU"])
            and s["samPairIoU"] < t.e_sam_pair_iou
        ):
            why.add("e")
        if (
            t.e_sam_birefnet_iou is not None
            and not _nan(s["samBirefnetIoU"])
            and s["samBirefnetIoU"] < t.e_sam_birefnet_iou
        ):
            why.add("e")
        if (
            t.e_hard_disagreement is not None
            and not _nan(s["hardDisagreement"])
            and s["hardDisagreement"] > t.e_hard_disagreement
        ):
            why.add("e")
        if t.e_band_frac is not None and not _nan(s["bandFrac"]) and s["bandFrac"] > t.e_band_frac:
            why.add("e")
        if t.f_object_score:
            for score in (s["fwdScore"], s["bwdScore"]):
                if not _nan(score) and (score < 0) == (s["area"] > 0):
                    why.add("f")
                    break
        if t.g_single_estimate and _nan(s["samPairIoU"]):
            why.add("g")
        window_h = t.h_presence_window
        if (
            window_h
            and s["area"] == 0
            and any(
                signals[k]["area"] > 0
                for k in range(max(0, index - window_h), min(count, index + window_h + 1))
            )
        ):
            why.add("h")
        if (
            t.m_flow_px is not None
            and t.m_band_frac is not None
            and s["motionPx"] > t.m_flow_px
            and not _nan(s["bandFrac"])
            and s["bandFrac"] > t.m_band_frac
        ):
            why.add("m")
        if any(_nan(s[key]) for key in ("samBirefnetIoU", "bandFrac")):
            why.add("u")
        out.append(sorted(why))
    return out


def primary_reason(checks: Sequence[str]) -> ReviewReason:
    reasons = {REASON_BY_CHECK[check] for check in checks}
    return next(reason for reason in REASON_PRIORITY if reason in reasons)


def review_ranges(flags: Sequence[Sequence[str]], pts: Sequence[int]) -> tuple[ReviewRange, ...]:
    """Consecutive flagged frames with the same reason become one range (≤ 4096 ranges)."""
    ranges: list[list[Any]] = []
    for index, checks in enumerate(flags):
        if not checks:
            continue
        reason = primary_reason(checks)
        if ranges and ranges[-1][1] == index - 1 and ranges[-1][2] == reason:
            ranges[-1][1] = index
        else:
            ranges.append([index, index, reason])
    while len(ranges) > MAX_REVIEW_RANGES:
        # Merge the closest pair; the merged range keeps the higher-priority reason.
        gaps = [ranges[i + 1][0] - ranges[i][1] for i in range(len(ranges) - 1)]
        i = int(np.argmin(gaps))
        merged_reason = min((ranges[i][2], ranges[i + 1][2]), key=REASON_PRIORITY.index)
        ranges[i : i + 2] = [[ranges[i][0], ranges[i + 1][1], merged_reason]]
    return tuple(ReviewRange(pts[start], pts[end], reason) for start, end, reason in ranges)


__all__ = [
    "REASON_BY_CHECK",
    "Thresholds",
    "flag_frames",
    "frame_signals",
    "primary_reason",
    "review_ranges",
]
