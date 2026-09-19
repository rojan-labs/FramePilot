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
#: BR7.5 temporal stage: DIS at full resolution with a finer patch grid and more variational
#: refinement. Warping the ground-truth alpha of the BR7.4 calibration clips with it misses by
#: 5-38 levels in the band against 11-51 for the half-resolution preset (hair 8 vs 16, walk
#: 38 vs 51): the half-resolution flow is good enough to check a silhouette, not to move an edge.
FINE_PATCH_SIZE: Final = 8
FINE_PATCH_STRIDE: Final = 3
FINE_REFINEMENT_ITERATIONS: Final = 10
#: A warped neighbour is trusted per pixel by how well it predicts this frame's colour: weight
#: exp(-(r / sigma)^2) of the CIELAB residual r averaged over a (2*patch+1)^2 window, times
#: forward-backward consistency. Motion boundaries, where DIS is worst and alpha lives, fail it.
PHOTOMETRIC_SIGMA: Final = 6.0
PHOTOMETRIC_PATCH: Final = 2

Float = npt.NDArray[Any]

_dis: Any = None
_fine: Any = None


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


def _fine_estimator() -> Any:
    global _fine
    if _fine is None:
        create = getattr(cv2, "DISOpticalFlow_create")  # noqa: B009 - absent from OpenCV's stubs
        _fine = create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
        _fine.setFinestScale(0)
        _fine.setPatchSize(FINE_PATCH_SIZE)
        _fine.setPatchStride(FINE_PATCH_STRIDE)
        _fine.setVariationalRefinementIterations(FINE_REFINEMENT_ITERATIONS)
    return _fine


def fine_flow(source_gray: npt.NDArray[np.uint8], target_gray: npt.NDArray[np.uint8]) -> Float:
    """Like :func:`flow` at full resolution and finer (the temporal stage's motion)."""
    estimate: Float = _fine_estimator().calc(target_gray, source_gray, None)
    return estimate.astype(np.float32)


def lab(frame: npt.NDArray[np.uint8]) -> Float:
    """CIELAB (OpenCV 8-bit scaling) as float32, for photometric residuals."""
    out: Float = cv2.cvtColor(frame, cv2.COLOR_RGB2LAB).astype(np.float32)
    return out


def reliability(source_lab: Float, target_lab: Float, forward: Float, backward: Float) -> Float:
    """Per pixel, how far ``source`` warped by ``forward`` can be trusted on ``target`` (0-1).

    ``forward`` = ``flow(source, target)``, ``backward`` = ``flow(target, source)``.
    """
    residual = np.sqrt(((warp(source_lab, forward) - target_lab) ** 2).sum(axis=-1))
    size = 2 * PHOTOMETRIC_PATCH + 1
    residual = cv2.blur(residual, (size, size))
    weight: Float = np.exp(-((residual / PHOTOMETRIC_SIGMA) ** 2)).astype(np.float32)
    return weight * consistent(forward, backward)


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


__all__ = ["consistent", "fine_flow", "flow", "gray", "lab", "reliability", "warp"]
