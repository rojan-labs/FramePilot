"""Dissolve passes — the ones that only touch alpha (and one that only touches colour).

GLSL twins: the "Dissolves" block of ``glsl-transitions.ts``. Read that file's
header and ``_common.py``'s note on the y-up UV grid before changing anything here.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.transition_passes import TransitionContext, register
from framepilot_engine.render.transition_passes._common import (
    luminance,
    noise_stable,
    opaque,
    reveal,
    sample,
    screen_blend,
    uv_grid,
    value_noise01,
)

__all__: list[str] = []


@register("dissolve")
def dissolve(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """A plain opacity ramp, optionally lingering at the halfway blend.

    ``hold`` widens a plateau at 0.5. A dissolve that lingers there reads as
    deliberate; the same length without the plateau just reads as slow.
    """
    p = ctx.progress
    h = min(0.9, max(0.0, ctx.param("hold"))) * 0.5
    ramp = max(1e-3, 0.5 - h)
    if p < 0.5 - h:
        a = p / ramp * 0.5
    elif p > 0.5 + h:
        a = 0.5 + (p - 0.5 - h) / ramp * 0.5
    else:
        a = 0.5
    # Mirrors opacity_at: intensity sets how far down the dip goes, so 0.5 is a
    # dissolve that never fully loses the picture rather than a shorter one.
    floor = 1.0 - ctx.intensity
    alpha = np.full(frame.shape[:2], floor + (1.0 - floor) * a, dtype=np.float32)
    return frame, alpha


@register("dip-color")
def dip_color(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Through a colour and back out. ``blend`` picks dip (replace) or flash (add)."""
    hold = min(0.95, max(0.0, ctx.param("hold")))
    k = 1.0 if ctx.progress <= hold else 1.0 - (ctx.progress - hold) / max(1e-3, 1.0 - hold)
    k = float(np.clip(k, 0.0, 1.0)) * ctx.intensity
    colour = np.array([ctx.param("red"), ctx.param("green"), ctx.param("blue")], dtype=np.float32)
    if ctx.param("blend") < 0.5:
        rgb = frame + (colour - frame) * np.float32(k)
    else:
        rgb = screen_blend(frame, np.broadcast_to(colour * np.float32(k), frame.shape))
    return opaque(np.asarray(rgb, dtype=np.float32))


@register("luma-fade")
def luma_fade(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """The brightest (or darkest) parts of the next shot arrive first."""
    lum = luminance(frame)
    if ctx.param("invert") > 0.5:
        lum = 1.0 - lum
    return frame, reveal(np.asarray(1.0 - lum, dtype=np.float32), ctx.progress, ctx.feather)


@register("noise-dissolve")
def noise_dissolve(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Organic patches arrive first — ink through paper rather than a grid."""
    height, width = frame.shape[0], frame.shape[1]
    ys, xs = np.meshgrid(
        np.arange(height, dtype=np.float32), np.arange(width, dtype=np.float32), indexing="ij"
    )
    cell = max(2.0, ctx.param("cell") * min(width, height))
    field = value_noise01(xs, ys, cell, int(ctx.param("seed")))
    return frame, reveal(field, ctx.progress, ctx.feather)


@register("pixel-dissolve")
def pixel_dissolve(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Blocks arrive in a fixed random order.

    A hard step per block, deliberately: feathering here would soften each block's
    own edges and turn the effect back into the dissolve it exists as an
    alternative to.
    """
    height, width = frame.shape[0], frame.shape[1]
    block = max(2.0, ctx.param("blockPx"))
    ys, xs = np.meshgrid(
        np.arange(height, dtype=np.float32), np.arange(width, dtype=np.float32), indexing="ij"
    )
    cx = np.floor(xs / np.float32(block)).astype(np.int64)
    cy = np.floor(ys / np.float32(block)).astype(np.int64)
    order = noise_stable(cx, cy, int(ctx.param("seed")))
    return frame, np.asarray((order <= ctx.progress).astype(np.float32))


@register("mosaic")
def mosaic(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Coarse blocks resolving into detail; alpha eases in over the first quarter."""
    height, width = frame.shape[0], frame.shape[1]
    block = max(1.0, ctx.param("blockPx") * ctx.rem)
    u, v = uv_grid(height, width)
    qu = (
        (np.floor(u * np.float32(width) / np.float32(block)) + 0.5)
        * np.float32(block)
        / np.float32(width)
    )
    qv = (
        (np.floor((1.0 - v) * np.float32(height) / np.float32(block)) + 0.5)
        * np.float32(block)
        / np.float32(height)
    )
    rgb = sample(frame, qu, 1.0 - qv)
    alpha = np.full(frame.shape[:2], float(np.clip(ctx.progress * 4.0, 0.0, 1.0)), dtype=np.float32)
    return rgb, alpha
