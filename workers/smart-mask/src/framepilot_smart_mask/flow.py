"""OpenCV DIS optical flow with a fixed preset, plus warping (consensus, stabilise, verify).

DIS is deterministic and has no learned prior that could hallucinate motion, which is why the
verify stage can use it as a reference (plan 02 model choices). Flow is computed at half
resolution and scaled back: the checks need motion of the subject's silhouette, not of
single pixels, and half resolution keeps 4K flow bounded.
"""

from __future__ import annotations

from typing import Any, Final

import cv2
import numpy as np
import numpy.typing as npt

FLOW_SCALE: Final = 0.5
#: Forward-backward round trip error (px) above which a pixel's flow is not trusted.
CONSISTENCY_PX: Final = 1.5

Float = npt.NDArray[Any]

_dis: Any = None


def _estimator() -> Any:
    global _dis
    if _dis is None:
        create = getattr(cv2, "DISOpticalFlow_create")  # noqa: B009 - absent from OpenCV's stubs
        _dis = create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    return _dis


def gray(frame: npt.NDArray[np.uint8]) -> npt.NDArray[Any]:
    out: npt.NDArray[Any] = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    return out


def flow(source_gray: npt.NDArray[np.uint8], target_gray: npt.NDArray[np.uint8]) -> Float:
    """Flow ``f`` with ``target(x) ≈ source(x + f(x))``, full resolution, float32 (H,W,2)."""
    height, width = target_gray.shape
    small_w, small_h = max(int(width * FLOW_SCALE), 8), max(int(height * FLOW_SCALE), 8)
    small_source = cv2.resize(source_gray, (small_w, small_h), interpolation=cv2.INTER_AREA)
    small_target = cv2.resize(target_gray, (small_w, small_h), interpolation=cv2.INTER_AREA)
    estimate = _estimator().calc(small_target, small_source, None)
    scaled: Float = cv2.resize(
        estimate, (width, height), interpolation=cv2.INTER_LINEAR
    ) * np.float32(width / small_w)
    return scaled.astype(np.float32)


def _grid(height: int, width: int) -> tuple[Float, Float]:
    xs, ys = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    return xs, ys


def warp(image: Float, motion: Float, border_value: float = 0.0) -> Float:
    """Sample ``image`` at ``x + motion(x)`` (bilinear)."""
    height, width = motion.shape[:2]
    xs, ys = _grid(height, width)
    out: Float = cv2.remap(
        image.astype(np.float32),
        xs + motion[..., 0],
        ys + motion[..., 1],
        cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=border_value,
    )
    return out


def consistent(forward: Float, backward: Float) -> npt.NDArray[np.bool_]:
    """Pixels whose forward then backward flow returns within :data:`CONSISTENCY_PX`."""
    back_x = warp(backward[..., 0], forward)
    back_y = warp(backward[..., 1], forward)
    error = np.hypot(forward[..., 0] + back_x, forward[..., 1] + back_y)
    result: npt.NDArray[np.bool_] = error < CONSISTENCY_PX
    return result


__all__ = ["consistent", "flow", "gray", "warp"]
