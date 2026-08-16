"""Wipe passes — one reveal primitive over six projections.

Every kind here is :func:`_common.reveal` over a different ``f``: the frame
fraction along whatever sweep the kind defines. That is the whole design, and it
is why "add a wipe shape" is a few lines rather than a new pass with its own
feathering, its own edge overshoot and its own way of being subtly wrong at p = 1.

GLSL twins: the "Wipes" block of ``glsl-transitions.ts``.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.transition_passes import TransitionContext, register
from framepilot_engine.render.transition_passes._common import reveal, square_uv, uv_grid

__all__: list[str] = []


def _linear_fraction(
    ctx: TransitionContext, u: np.ndarray, v: np.ndarray, tilt_degrees: float
) -> np.ndarray:
    """Frame fraction along the (optionally tilted) travel direction, 0 → 1."""
    dx, dy = ctx.direction
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        dx, dy = 1.0, 0.0
    angle = np.radians(tilt_degrees)
    rx = dx * np.cos(angle) - dy * np.sin(angle)
    ry = dx * np.sin(angle) + dy * np.cos(angle)
    # Normalise so 0..1 spans the frame however the edge is tilted.
    half = 0.5 * (abs(float(rx)) + abs(float(ry)))
    projected = (u - 0.5) * np.float32(rx) + (v - 0.5) * np.float32(ry)
    return np.asarray(((projected + half) / max(1e-3, 2.0 * half)).astype(np.float32))


@register("wipe-linear")
def wipe_linear(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """A straight edge sweeping across. ``angle`` tilts it off its direction."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    return frame, reveal(_linear_fraction(ctx, u, v, ctx.param("angle")), ctx.progress, ctx.feather)


def _centre(
    ctx: TransitionContext, x_name: str = "centreX", y_name: str = "centreY"
) -> tuple[float, float]:
    """The kind's centre in y-UP UV space (params are stored y-down, screen-style)."""
    return ctx.param(x_name, 0.5), 1.0 - ctx.param(y_name, 0.5)


@register("wipe-radial")
def wipe_radial(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """A circle opening out of a point, or closing in on one."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    cu, cv = _centre(ctx)
    du, dv = square_uv(u - np.float32(cu), v - np.float32(cv), ctx.aspect)
    # Normalise by the distance to the furthest corner, so the reveal always
    # completes exactly at p = 1 wherever the centre is.
    corners = [
        ((0.0 - cu) * ctx.aspect, 0.0 - cv),
        ((1.0 - cu) * ctx.aspect, 0.0 - cv),
        ((0.0 - cu) * ctx.aspect, 1.0 - cv),
        ((1.0 - cu) * ctx.aspect, 1.0 - cv),
    ]
    max_r = max(float(np.hypot(x, y)) for x, y in corners)
    f = np.hypot(du, dv) / max(1e-3, max_r)
    if ctx.param("invert") > 0.5:
        f = 1.0 - f
    return frame, reveal(np.asarray(f, dtype=np.float32), ctx.progress, ctx.feather)


@register("wipe-clock")
def wipe_clock(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """A hand sweeping around the frame, measured from 12 o'clock."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    cu, cv = _centre(ctx)
    du, dv = square_uv(u - np.float32(cu), v - np.float32(cv), ctx.aspect)
    angle = np.arctan2(du, dv) - np.radians(ctx.param("start"))
    if ctx.param("reverse") > 0.5:
        angle = -angle
    f = np.mod(angle / (2.0 * np.pi) + 1.0, 1.0)
    return frame, reveal(np.asarray(f, dtype=np.float32), ctx.progress, ctx.feather)


@register("wipe-split")
def wipe_split(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Opens from the centre line, or closes in from both edges."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    axis = u if ctx.param("axis") < 0.5 else v
    f = np.abs(axis - 0.5) * 2.0
    # 0 opens from the centre outward; 1 closes in from both edges.
    if ctx.param("invert") >= 0.5:
        f = 1.0 - f
    return frame, reveal(np.asarray(f, dtype=np.float32), ctx.progress, ctx.feather)


@register("wipe-shape")
def wipe_shape(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Five shapes on one projection, each normalised so its furthest point is f = 1."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    cu, cv = _centre(ctx, "centreX", "centreY")
    du, dv = square_uv(u - np.float32(cu), v - np.float32(cv), ctx.aspect)
    du = du * 2.0
    dv = dv * 2.0
    shape = ctx.param("shape")
    if shape < 0.5:
        f = (np.abs(du) + np.abs(dv)) * 0.62
    elif shape < 1.5:
        angle = np.arctan2(dv, du)
        radius = np.hypot(du, dv)
        f = radius / (0.55 + 0.45 * np.cos(angle * 5.0)) * 0.62
    elif shape < 2.5:
        f = np.minimum(np.abs(du), np.abs(dv)) * 1.6 + np.hypot(du, dv) * 0.25
    elif shape < 3.5:
        # Heart: the classic implicit curve, rescaled to land near 1 at the corners.
        x = du
        y = -dv + 0.25
        t = x * x + y * y - 0.35
        f = (t * t * t - x * x * y * y * y) * 3.2 + 0.5
    else:
        f = np.maximum(np.abs(du) * 0.866 + np.abs(dv) * 0.5, np.abs(dv)) * 0.9
    return frame, reveal(
        np.asarray(np.clip(f, 0.0, 1.4), dtype=np.float32), ctx.progress, ctx.feather
    )


@register("wipe-bars")
def wipe_bars(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Slats, each revealing along its own short axis, optionally staggered."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    bars = max(1.0, ctx.param("bars"))
    vertical = ctx.param("axis") < 0.5
    across = u if vertical else v
    along = v if vertical else u
    idx = np.floor(np.clip(across, 0.0, 0.9999) * bars)
    delay = (idx / max(1.0, bars)) * min(0.95, max(0.0, ctx.param("stagger")))
    pp = np.clip((ctx.progress - delay) / np.maximum(1e-3, 1.0 - delay), 0.0, 1.0)
    # Alternate slats sweep the other way, so the frame does not read as one wipe
    # with a ragged edge.
    flipped = np.where(np.mod(idx, 2.0) >= 1.0, 1.0 - along, along)
    # `reveal` takes a scalar progress; here progress varies per bar, so the same
    # formula is inlined against the per-pixel `pp`.
    s = ctx.feather
    alpha = np.where(
        pp >= 1.0,
        1.0,
        np.clip((pp * (1.0 + s) - flipped) / s, 0.0, 1.0),
    )
    return frame, np.asarray(alpha.astype(np.float32))
