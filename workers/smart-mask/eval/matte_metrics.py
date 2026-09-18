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


def srgb_to_lab(rgb: npt.NDArray[Any]) -> npt.NDArray[Any]:
    """sRGB in [0, 1] (…, 3) to CIE L*a*b* (D65), L in [0, 100]."""
    unit = np.clip(np.asarray(rgb, np.float32), 0.0, 1.0)
    flat = unit.reshape(-1, 1, 3)
    lab: npt.NDArray[Any] = cv2.cvtColor(flat, cv2.COLOR_RGB2Lab).reshape(unit.shape)
    return lab.astype(np.float64)


def delta_e2000(lab1: npt.NDArray[Any], lab2: npt.NDArray[Any]) -> npt.NDArray[Any]:
    """CIEDE2000 colour difference (Sharma, Wu, Dalal 2005), element-wise over (…, 3) Lab."""
    l1, a1, b1 = (np.asarray(lab1, np.float64)[..., k] for k in range(3))
    l2, a2, b2 = (np.asarray(lab2, np.float64)[..., k] for k in range(3))
    c_bar = (np.hypot(a1, b1) + np.hypot(a2, b2)) / 2
    g = 0.5 * (1 - np.sqrt(c_bar**7 / (c_bar**7 + 25.0**7)))
    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    zero = (c1p * c2p) == 0
    dh = h2p - h1p
    dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dh = np.where(zero, 0.0, dh)
    d_l, d_c = l2 - l1, c2p - c1p
    d_h = 2 * np.sqrt(c1p * c2p) * np.sin(np.radians(dh) / 2)
    l_bar, cp_bar = (l1 + l2) / 2, (c1p + c2p) / 2
    h_sum = h1p + h2p
    h_bar = np.where(
        zero,
        h_sum,
        np.where(
            np.abs(h1p - h2p) <= 180,
            h_sum / 2,
            np.where(h_sum < 360, (h_sum + 360) / 2, (h_sum - 360) / 2),
        ),
    )
    t = (
        1
        - 0.17 * np.cos(np.radians(h_bar - 30))
        + 0.24 * np.cos(np.radians(2 * h_bar))
        + 0.32 * np.cos(np.radians(3 * h_bar + 6))
        - 0.20 * np.cos(np.radians(4 * h_bar - 63))
    )
    d_theta = 30 * np.exp(-(((h_bar - 275) / 25) ** 2))
    r_c = 2 * np.sqrt(cp_bar**7 / (cp_bar**7 + 25.0**7))
    s_l = 1 + 0.015 * (l_bar - 50) ** 2 / np.sqrt(20 + (l_bar - 50) ** 2)
    s_c = 1 + 0.045 * cp_bar
    s_h = 1 + 0.015 * cp_bar * t
    r_t = -np.sin(np.radians(2 * d_theta)) * r_c
    out: npt.NDArray[Any] = np.sqrt(
        (d_l / s_l) ** 2 + (d_c / s_c) ** 2 + (d_h / s_h) ** 2 + r_t * (d_c / s_c) * (d_h / s_h)
    )
    return out


#: 06 "a new background": saturated magenta, where halos and colour fringe show most (as on the
#: contact sheet and in the 09 oracle's matte rows).
NEW_BACKGROUND_RGB = (1.0, 0.0, 1.0)


def composite(
    foreground: U8, alpha: U8, background: tuple[float, float, float]
) -> npt.NDArray[Any]:
    """``α·F + (1-α)·B`` in [0, 1] for uint8 foreground colour (H, W, 3) and alpha (H, W)."""
    unit = alpha.astype(np.float32)[..., None] / 255.0
    back = np.asarray(background, np.float32)[None, None, :]
    out: npt.NDArray[Any] = unit * (foreground.astype(np.float32) / 255.0) + (1 - unit) * back
    return out


def foreground_delta_e(
    pred_fg: U8, pred_alpha: U8, gt_fg: U8, gt_alpha: U8, region: Bool
) -> tuple[float, int]:
    """06 foreground colour error: (sum of ΔE2000, pixels) of the two composites in ``region``."""
    if not region.any():
        return 0.0, 0
    pred = composite(pred_fg, pred_alpha, NEW_BACKGROUND_RGB)[region]
    truth = composite(gt_fg, gt_alpha, NEW_BACKGROUND_RGB)[region]
    values = delta_e2000(srgb_to_lab(pred), srgb_to_lab(truth))
    return float(values.sum()), int(values.size)


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
    "composite",
    "delta_e2000",
    "dtssd",
    "foreground_delta_e",
    "frames_aligned",
    "iou",
    "is_leak",
    "largest_wrong_region",
    "srgb_to_lab",
    "unknown_band",
]
