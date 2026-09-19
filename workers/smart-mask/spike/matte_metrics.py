"""Pure helpers for BR0.3/BR0.4: metrics from 06-PRECISION-AND-EVAL and band construction.

No model, no I/O: numpy + OpenCV only, unit-tested in tests/test_matte_metrics.py.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

#: 06 "Error-detection recall": a frame is wrong when IoU < 0.98 or BF@2px < 0.95.
WRONG_IOU = 0.98
WRONG_BF = 0.95


def binarise(alpha: np.ndarray) -> np.ndarray:
    """α ≥ 0.5 for float alpha in [0,1], or ≥ 128 for uint8 (06: IoU of binarised alpha)."""
    return alpha >= (128 if alpha.dtype == np.uint8 else 0.5)


def iou(pred: np.ndarray, gt: np.ndarray) -> float:
    union = np.logical_or(pred, gt).sum()
    if union == 0:
        return 1.0
    return float(np.logical_and(pred, gt).sum() / union)


def boundary(mask: np.ndarray) -> np.ndarray:
    """Inner boundary pixels of a binary mask (4-connected erosion difference)."""
    m = mask.astype(np.uint8)
    return (m - cv2.erode(m, np.ones((3, 3), np.uint8))).astype(bool)


def boundary_f(pred: np.ndarray, gt: np.ndarray, tol_px: int = 2) -> float:
    """BF@tol: F-measure of boundary pixels matched within ``tol_px`` (Euclidean)."""
    bp, bg = boundary(pred), boundary(gt)
    if not bp.any() and not bg.any():
        return 1.0
    if not bp.any() or not bg.any():
        return 0.0
    # distance to nearest boundary pixel of the other mask
    dist_to_g = cv2.distanceTransform((~bg).astype(np.uint8), cv2.DIST_L2, 5)
    dist_to_p = cv2.distanceTransform((~bp).astype(np.uint8), cv2.DIST_L2, 5)
    precision = float((dist_to_g[bp] <= tol_px).mean())
    recall = float((dist_to_p[bg] <= tol_px).mean())
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def frame_is_wrong(pred_alpha: np.ndarray, gt_alpha: np.ndarray) -> tuple[bool, float, float]:
    p, g = binarise(pred_alpha), binarise(gt_alpha)
    i, bf = iou(p, g), boundary_f(p, g)
    return (i < WRONG_IOU or bf < WRONG_BF), i, bf


def disk(radius: int) -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))


def unknown_band(estimates: list[np.ndarray], edge_radius: int) -> np.ndarray:
    """Stage 5 band: pixels where binary estimates disagree, plus ``edge_radius`` around every
    estimate's boundary (a unanimous low-resolution edge is still not a precise edge)."""
    stack = np.stack([e.astype(bool) for e in estimates])
    disagree = stack.any(0) & ~stack.all(0)
    edges = np.zeros(stack.shape[1:], np.uint8)
    for e in stack:
        edges |= boundary(e).astype(np.uint8)
    if edge_radius > 0:
        edges = cv2.dilate(edges, disk(edge_radius))
    return disagree | edges.astype(bool)


def consensus_alpha(estimates: list[np.ndarray], band: np.ndarray, band_alpha: np.ndarray) -> np.ndarray:
    """Unanimous pixels outside the band are exactly 0 or 1; the band takes ``band_alpha``.

    Outside the band the estimates agree by construction, so any one of them gives the value.
    """
    base = estimates[0].astype(np.float32)
    return np.where(band, band_alpha.astype(np.float32), base)


def wilson_lower(successes: int, n: int, z: float = 1.96) -> float:
    """95% Wilson lower bound of a proportion (recall on a finite pilot set)."""
    if n == 0:
        return float("nan")
    p = successes / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre - margin) / denom


def tiles_1d(length: int, tile: int, overlap: int) -> list[int]:
    """Start offsets covering [0, length) with tiles of ``tile`` overlapping ≥ ``overlap``."""
    if length <= tile:
        return [0]
    step = tile - overlap
    starts = list(range(0, length - tile, step))
    starts.append(length - tile)
    return starts


def blend_weight(tile: int, overlap: int) -> np.ndarray:
    """Separable linear ramp weights so overlapping tiles sum to a partition of unity."""
    ramp = np.ones(tile, np.float32)
    if overlap > 0:
        r = (np.arange(overlap, dtype=np.float32) + 0.5) / overlap
        ramp[:overlap] = r
        ramp[-overlap:] = r[::-1]
    return np.outer(ramp, ramp)
