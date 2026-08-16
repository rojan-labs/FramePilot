"""Motion passes — the picture travels.

Each of these is a UV remap plus :func:`_common.picture`'s off-frame alpha, which
is what lets a shot slide, spin or stretch partly out of frame without any of them
needing a bounds test of its own.

GLSL twins: the "Motion" block of ``glsl-transitions.ts``.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.transition_passes import TransitionContext, register
from framepilot_engine.render.transition_passes._common import (
    noise_stable,
    picture,
    rotate2,
    square_uv,
    unsquare_uv,
    uv_grid,
)

__all__: list[str] = []


@register("slide")
def slide(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """The picture arrives from off-frame.

    It starts one frame away OPPOSITE its travel and decays to rest, so
    ``direction: left`` starts off-screen right — the same convention
    ``offset_at`` has always used. ``slices`` splits the frame into bands that
    arrive from alternating sides; ``stagger`` delays each behind the last.
    """
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    dx, dy = ctx.direction
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        dx, dy = -1.0, 0.0
    slices = max(1.0, ctx.param("slices"))
    stagger = min(0.95, max(0.0, ctx.param("stagger")))
    # The across-axis is perpendicular to travel, so bands are always crosswise.
    across = u if abs(-dy) > abs(dx) else v
    idx = np.floor(np.clip(across, 0.0, 0.9999) * slices) if slices > 1.0 else np.zeros_like(u)
    delay = (idx / slices) * stagger if slices > 1.0 else np.zeros_like(u)
    pp = np.clip((ctx.progress - delay) / np.maximum(1e-3, 1.0 - delay), 0.0, 1.0)
    sign = np.where(np.mod(idx, 2.0) >= 1.0, -1.0, 1.0) if slices > 1.0 else np.ones_like(u)
    travel = ctx.param("distance") * ctx.intensity * (1.0 - pp)
    return picture(frame, u + np.float32(dx) * sign * travel, v + np.float32(dy) * sign * travel)


@register("zoom")
def zoom(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Scale in or out, optionally about an off-centre point and with a roll.

    ``out`` is the RECIPROCAL of ``in``, not its negation, so neither can reach a
    zero scale and an intensity of 0 is a no-op either way (mirrors ``zoom_from``).
    """
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    magnitude = 1.0 + (ctx.param("scaleFrom") - 1.0) * ctx.intensity
    start = 1.0 / max(0.05, magnitude) if ctx.dir_sign < 0.0 else magnitude
    scale = start + (1.0 - start) * ctx.progress
    cu = ctx.param("centreX", 0.5)
    cv = 1.0 - ctx.param("centreY", 0.5)
    du, dv = square_uv(u - np.float32(cu), v - np.float32(cv), ctx.aspect)
    du, dv = rotate2(du, dv, -ctx.param("rotate") * 2.0 * np.pi * ctx.rem)
    du, dv = unsquare_uv(
        du / np.float32(max(0.05, scale)), dv / np.float32(max(0.05, scale)), ctx.aspect
    )
    return picture(frame, du + np.float32(cu), dv + np.float32(cv))


@register("spin")
def spin(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Rotates down out of nowhere and lands square."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    scale = 1.0 + (ctx.param("scaleFrom") - 1.0) * ctx.intensity
    scale = scale + (1.0 - scale) * ctx.progress
    du, dv = square_uv(u - 0.5, v - 0.5, ctx.aspect)
    du, dv = rotate2(du, dv, -ctx.param("turns") * 2.0 * np.pi * ctx.rem)
    du, dv = unsquare_uv(
        du / np.float32(max(0.05, scale)), dv / np.float32(max(0.05, scale)), ctx.aspect
    )
    return picture(frame, du + 0.5, dv + 0.5)


@register("stretch")
def stretch(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Arrives as a smear along one axis and snaps to size."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    k = 1.0 + (ctx.param("stretchAmount") - 1.0) * ctx.intensity
    k = max(0.05, k + (1.0 - k) * ctx.progress)
    du = u - 0.5
    dv = v - 0.5
    if ctx.param("axis") < 0.5:
        du = du / np.float32(k)
    else:
        dv = dv / np.float32(k)
    return picture(frame, du + 0.5, dv + 0.5)


@register("shake")
def shake(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """An impact shake that settles.

    Deterministic from ``progress`` rather than from a clock: the same frame of the
    same transition must shake the same way in the preview and in the export, and a
    clock-driven jitter cannot promise that.
    """
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    seed = int(ctx.param("seed"))
    step = np.array([[np.floor(ctx.progress * max(1.0, ctx.param("frequency")))]], dtype=np.int64)
    amt = ctx.param("shakeAmount") * ctx.intensity * ctx.rem
    dx = float(noise_stable(step, np.zeros_like(step), seed)[0, 0]) * 2.0 - 1.0
    dy = float(noise_stable(step, np.ones_like(step), seed)[0, 0]) * 2.0 - 1.0
    roll = (float(noise_stable(step, np.full_like(step, 2), seed)[0, 0]) * 2.0 - 1.0) * ctx.param(
        "rotate"
    )
    du, dv = square_uv(u - 0.5, v - 0.5, ctx.aspect)
    du, dv = rotate2(du, dv, -roll * 0.25 * amt)
    du, dv = unsquare_uv(du, dv, ctx.aspect)
    return picture(
        frame, du + 0.5 - np.float32(dx * amt * 0.12), dv + 0.5 - np.float32(dy * amt * 0.12)
    )
