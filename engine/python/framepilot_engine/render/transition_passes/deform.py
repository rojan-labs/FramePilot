"""Deformation passes — the picture bends.

GLSL twins: the "Deformation" block of ``glsl-transitions.ts``.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.transition_passes import TransitionContext, register
from framepilot_engine.render.transition_passes._common import (
    rotate2,
    sample,
    square_uv,
    unsquare_uv,
    uv_grid,
    value_noise01,
)

__all__: list[str] = []


def _ramped_alpha(frame: np.ndarray, progress: float, rate: float) -> np.ndarray:
    """A flat alpha that reaches 1 before the deformation finishes.

    These kinds read as "the picture bending into place", which only works if the
    picture is already there while it bends. Ramping alpha faster than progress is
    what separates them from a dissolve with a wobble.
    """
    return np.full(frame.shape[:2], float(np.clip(progress * rate, 0.0, 1.0)), dtype=np.float32)


@register("ripple")
def ripple(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Rings spreading out from a point and settling."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    cu = ctx.param("centreX", 0.5)
    cv = 1.0 - ctx.param("centreY", 0.5)
    du, dv = square_uv(u - np.float32(cu), v - np.float32(cv), ctx.aspect)
    radius = np.hypot(du, dv)
    amplitude = ctx.param("amplitude") * ctx.intensity * ctx.rem * 0.25
    wave = (
        np.sin(radius * ctx.param("frequency") * 2.0 * np.pi - ctx.progress * 2.0 * np.pi * 2.0)
        * amplitude
        * np.exp(-radius * 2.2)
    )
    safe = np.maximum(radius, 1e-4)
    ou, ov = unsquare_uv(du / safe * wave, dv / safe * wave, ctx.aspect)
    return sample(frame, u + ou.astype(np.float32), v + ov.astype(np.float32)), _ramped_alpha(
        frame, ctx.progress, 1.5
    )


@register("warp")
def warp(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Heat haze that straightens out."""
    height, width = frame.shape[0], frame.shape[1]
    u, v = uv_grid(height, width)
    ys, xs = np.meshgrid(
        np.arange(height, dtype=np.float32), np.arange(width, dtype=np.float32), indexing="ij"
    )
    seed = int(ctx.param("seed"))
    cell = max(0.02, ctx.param("cell")) * min(width, height)
    amplitude = np.float32(ctx.param("amplitude") * ctx.intensity * ctx.rem * 0.35)
    nx = value_noise01(xs, ys, cell, seed) - 0.5
    ny = value_noise01(xs + 137.0, ys + 137.0, cell, seed + 7) - 0.5
    return sample(frame, u + nx * amplitude, v + ny * amplitude), _ramped_alpha(
        frame, ctx.progress, 1.4
    )


@register("liquid")
def liquid(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """A vortex that unwinds, strongest at the centre so the edges stay readable."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    cu = ctx.param("centreX", 0.5)
    cv = 1.0 - ctx.param("centreY", 0.5)
    du, dv = square_uv(u - np.float32(cu), v - np.float32(cv), ctx.aspect)
    radius = np.hypot(du, dv)
    angle = ctx.param("swirl") * ctx.intensity * ctx.rem * 7.0 * np.exp(-radius * 2.5)
    ru, rv = rotate2(du, dv, angle)
    ou, ov = unsquare_uv(ru, rv, ctx.aspect)
    return sample(frame, ou + np.float32(cu), ov + np.float32(cv)), _ramped_alpha(
        frame, ctx.progress, 1.4
    )


@register("kaleidoscope")
def kaleidoscope(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Mirrored wedges folding back into one frame."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    segments = max(2.0, ctx.param("segments"))
    du, dv = square_uv(u - 0.5, v - 0.5, ctx.aspect)
    radius = np.hypot(du, dv)
    angle = np.arctan2(dv, du)
    wedge = 2.0 * np.pi / segments
    folded = np.abs(np.mod(angle, wedge) - wedge * 0.5)
    blended = angle + (folded - angle) * np.float32(ctx.rem)
    ou, ov = unsquare_uv(np.cos(blended) * radius, np.sin(blended) * radius, ctx.aspect)
    return sample(frame, ou + 0.5, ov + 0.5), _ramped_alpha(frame, ctx.progress, 1.3)
