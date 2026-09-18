"""Plan 06 matte metrics that need no model: pure functions over alpha arrays.

Alpha is uint8 (0–255) throughout; "binarised" means α ≥ 0.5 (≥ 128), as 06 defines IoU.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt

U8 = npt.NDArray[np.uint8]
Bool = npt.NDArray[np.bool_]

#: 06 leak rate: a wrong connected region larger than 0.05% of the frame.
LEAK_REGION_FRACTION = 0.0005
#: Gaussian sigma of the gradient in the matting "Grad" error (Rhemann et al. use 1.4).
GRAD_SIGMA = 1.4


def binarise(alpha: U8) -> Bool:
    mask: Bool = alpha >= 128
    return mask


def iou(pred: Bool, gt: Bool) -> float:
    union = int(np.logical_or(pred, gt).sum())
    return 1.0 if union == 0 else float(np.logical_and(pred, gt).sum() / union)


def boundary(mask: Bool) -> Bool:
    m = mask.astype(np.uint8)
    edge: Bool = (m - cv2.erode(m, np.ones((3, 3), np.uint8))).astype(bool)
    return edge


def boundary_f(pred: Bool, gt: Bool, tolerance: int = 2) -> float:
    """06 BF@2px: F-measure of boundary pixels within ``tolerance`` px."""
    bp, bg = boundary(pred), boundary(gt)
    if not bp.any() and not bg.any():
        return 1.0
    if not bp.any() or not bg.any():
        return 0.0
    to_gt = cv2.distanceTransform((~bg).astype(np.uint8), cv2.DIST_L2, 5)
    to_pred = cv2.distanceTransform((~bp).astype(np.uint8), cv2.DIST_L2, 5)
    precision = float((to_gt[bp] <= tolerance).mean())
    recall = float((to_pred[bg] <= tolerance).mean())
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def largest_wrong_region(pred: Bool, gt: Bool) -> int:
    """Pixels in the largest connected region where the binarised matte is wrong."""
    wrong = np.logical_xor(pred, gt).astype(np.uint8)
    count, _, stats, _ = cv2.connectedComponentsWithStats(wrong, connectivity=8)
    return int(stats[1:, cv2.CC_STAT_AREA].max()) if count > 1 else 0


def is_leak(pred: Bool, gt: Bool) -> bool:
    """06 leak: any wrong connected region > 0.05% of the frame (a visible hole or island)."""
    return largest_wrong_region(pred, gt) > LEAK_REGION_FRACTION * pred.size


def unknown_band(gt: U8, radius: int = 3) -> Bool:
    """Ground truth's fractional pixels grown by ``radius``: where band alpha quality is judged."""
    fractional = ((gt > 0) & (gt < 255)).astype(np.uint8)
    edge = boundary(gt >= 128).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    band: Bool = cv2.dilate(fractional | edge, kernel).astype(bool)
    return band


def band_sad(pred: U8, gt: U8, band: Bool) -> float:
    """Sum of absolute alpha differences in the band, in thousands (the matting convention)."""
    diff = np.abs(pred.astype(np.float64) - gt.astype(np.float64)) / 255.0
    return float(diff[band].sum() / 1000.0)


def _gradient(alpha: U8) -> npt.NDArray[Any]:
    unit = cv2.GaussianBlur(alpha.astype(np.float32) / 255.0, (0, 0), GRAD_SIGMA)
    out: npt.NDArray[Any] = cv2.magnitude(
        cv2.Sobel(unit, cv2.CV_32F, 1, 0), cv2.Sobel(unit, cv2.CV_32F, 0, 1)
    )
    return out


def band_grad(pred: U8, gt: U8, band: Bool) -> float:
    """Gradient error in the band, in thousands."""
    diff = (_gradient(pred) - _gradient(gt)) ** 2
    return float(diff[band].sum() / 1000.0)


def dtssd(pred: Sequence[U8], gt: Sequence[U8]) -> float | None:
    """Mean over consecutive pairs of sqrt(mean((Δα_pred - Δα_gt)²)), α in [0, 1] (×100)."""
    if len(pred) < 2:
        return None
    values = []
    for index in range(1, len(pred)):
        d_pred = pred[index].astype(np.float64) - pred[index - 1].astype(np.float64)
        d_gt = gt[index].astype(np.float64) - gt[index - 1].astype(np.float64)
        values.append(float(np.sqrt(np.mean(((d_pred - d_gt) / 255.0) ** 2))) * 100.0)
    return float(np.mean(values))


def frames_aligned(matte_pts: Sequence[int], source_pts: Sequence[int]) -> tuple[int, int]:
    """(frames whose matte pts equals the source frame's pts, frames compared)."""
    matched = sum(1 for a, b in zip(matte_pts, source_pts, strict=False) if a == b)
    return matched, max(len(matte_pts), len(source_pts))


__all__ = [
    "LEAK_REGION_FRACTION",
    "band_grad",
    "band_sad",
    "binarise",
    "boundary",
    "boundary_f",
    "dtssd",
    "frames_aligned",
    "iou",
    "is_leak",
    "largest_wrong_region",
    "unknown_band",
]
