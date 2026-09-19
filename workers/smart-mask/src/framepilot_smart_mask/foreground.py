"""Stage 8: the subject's true colour in the soft band (multi-level foreground estimation).

Germer et al., "Fast Multi-Level Foreground Estimation" (ICPR 2020), the algorithm behind
pymatting's MIT-licensed ``estimate_foreground_ml``, reimplemented here in vectorised numpy
(no numba): coarse-to-fine, solving per pixel the 2×2 system that keeps
``image ≈ α·F + (1-α)·B`` with smooth F and B, weighted by alpha gradients. Updates use a
red-black checkerboard so each half-sweep sees its neighbours' latest values (Gauss-Seidel
order, as the reference does), which keeps convergence equivalent.

Only a padded box around the band is solved, and only pixels with ``0 < α < 255`` are
written: ``foreground.mkv`` is zero elsewhere, which FFV1 compresses to almost nothing and
which the engine never reads (``render/matte_edges.py`` uses the band only).
"""

from __future__ import annotations

import math
from typing import Any, Final

import cv2
import numpy as np
import numpy.typing as npt

REGULARIZATION: Final = 1e-5
GRADIENT_WEIGHT: Final = 1.0
SMALL_SIZE: Final = 32
SMALL_ITERATIONS: Final = 10
LARGE_ITERATIONS: Final = 2
BOX_PAD_PX: Final = 16

Float = npt.NDArray[Any]


def _resize_nearest(values: Float, width: int, height: int) -> Float:
    out: Float = cv2.resize(values, (width, height), interpolation=cv2.INTER_NEAREST)
    if out.ndim == 2 and values.ndim == 3:
        out = out[:, :, None]
    return out


def estimate_foreground(image: Float, alpha: Float) -> tuple[Float, Float]:
    """``image`` (H,W,3) float in [0,1], ``alpha`` (H,W) in [0,1] → (foreground, background)."""
    height0, width0 = alpha.shape
    levels = max(math.ceil(math.log2(max(width0, height0, 2))), 1)
    mean = image.reshape(-1, 3).mean(axis=0)
    foreground = np.broadcast_to(mean, (1, 1, 3)).astype(np.float32).copy()
    background = foreground.copy()
    for level in range(levels + 1):
        width = max(round(width0 ** (level / levels)), 1)
        height = max(round(height0 ** (level / levels)), 1)
        img = _resize_nearest(image.astype(np.float32), width, height).reshape(height, width, 3)
        a = _resize_nearest(alpha.astype(np.float32), width, height).reshape(height, width)
        foreground = _resize_nearest(foreground, width, height).reshape(height, width, 3)
        background = _resize_nearest(background, width, height).reshape(height, width, 3)
        iterations = (
            SMALL_ITERATIONS if width * height <= SMALL_SIZE * SMALL_SIZE else LARGE_ITERATIONS
        )
        for _ in range(iterations):
            for parity in (0, 1):
                _sweep(img, a, foreground, background, parity)
    return foreground, background


def _sweep(image: Float, alpha: Float, foreground: Float, background: Float, parity: int) -> None:
    height, width = alpha.shape
    a0 = alpha
    a1 = 1.0 - a0
    a00 = a0 * a0
    a01 = a0 * a1
    a11 = a1 * a1
    b0 = a0[..., None] * image
    b1 = a1[..., None] * image
    # The regulariser on the diagonal keeps the system solvable where a pixel has no neighbours
    # (the 1x1 coarsest level) and alpha is exactly 0 or 1.
    sum_a00 = a00 + REGULARIZATION
    sum_a11 = a11 + REGULARIZATION
    sum_b0 = b0.copy()
    sum_b1 = b1.copy()
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        valid = np.ones((height, width), bool)
        if dy == -1:
            valid[0, :] = False
        if dy == 1:
            valid[-1, :] = False
        if dx == -1:
            valid[:, 0] = False
        if dx == 1:
            valid[:, -1] = False
        neighbour_alpha = np.roll(a0, (-dy, -dx), axis=(0, 1))
        neighbour_f = np.roll(foreground, (-dy, -dx), axis=(0, 1))
        neighbour_b = np.roll(background, (-dy, -dx), axis=(0, 1))
        da = (REGULARIZATION + GRADIENT_WEIGHT * np.abs(a0 - neighbour_alpha)) * valid
        sum_a00 += da
        sum_a11 += da
        sum_b0 += da[..., None] * neighbour_f
        sum_b1 += da[..., None] * neighbour_b
    inv_det = 1.0 / (sum_a00 * sum_a11 - a01 * a01)
    new_f = np.clip(
        (sum_a11[..., None] * sum_b0 - a01[..., None] * sum_b1) * inv_det[..., None], 0.0, 1.0
    )
    new_b = np.clip(
        (sum_a00[..., None] * sum_b1 - a01[..., None] * sum_b0) * inv_det[..., None], 0.0, 1.0
    )
    ys, xs = np.indices((height, width))
    update = ((ys + xs) % 2) == parity
    foreground[update] = new_f[update]
    background[update] = new_b[update]


def foreground_frame(
    frame: npt.NDArray[np.uint8], alpha: npt.NDArray[np.uint8]
) -> npt.NDArray[np.uint8]:
    """Foreground RGB (uint8, full frame), non-zero only where ``0 < alpha < 255``."""
    height, width = alpha.shape
    out = np.zeros((height, width, 3), np.uint8)
    soft = (alpha > 0) & (alpha < 255)
    if not soft.any():
        return out
    ys, xs = np.nonzero(soft)
    top, bottom = max(int(ys.min()) - BOX_PAD_PX, 0), min(int(ys.max()) + BOX_PAD_PX + 1, height)
    left, right = max(int(xs.min()) - BOX_PAD_PX, 0), min(int(xs.max()) + BOX_PAD_PX + 1, width)
    image = frame[top:bottom, left:right].astype(np.float32) / 255.0
    local_alpha = alpha[top:bottom, left:right].astype(np.float32) / 255.0
    estimated, _ = estimate_foreground(image, local_alpha)
    region = np.clip(np.round(estimated * 255.0), 0, 255).astype(np.uint8)
    local_soft = soft[top:bottom, left:right]
    out[top:bottom, left:right][local_soft] = region[local_soft]
    return out


__all__ = ["estimate_foreground", "foreground_frame"]
