"""Optical passes — the lens misbehaves.

GLSL twins: the "Optical" block of ``glsl-transitions.ts``.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.transition_passes import TransitionContext, register
from framepilot_engine.render.transition_passes._common import (
    gaussian_blur,
    noise_stable,
    opaque,
    reveal,
    rotate2,
    sample,
    screen_blend,
    square_uv,
    unsquare_uv,
    uv_grid,
)

__all__: list[str] = []


@register("blur-dissolve")
def blur_dissolve(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """The next shot resolving out of a soft blur.

    Alpha stays 1 throughout: this is the legacy ``blur`` kind's look, which never
    faded, and the catalog entry that maps onto it must keep looking like itself.
    """
    radius = ctx.param("radius") * min(ctx.width, ctx.height) * ctx.rem
    return opaque(gaussian_blur(frame, radius))


@register("blur-directional")
def blur_directional(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """A smear along the travel direction, optionally moving along it as well.

    Nine taps, matching the shader's fixed tap count exactly — a different count
    would produce a visibly different smear length for the same radius.
    """
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    dx, dy = ctx.direction
    if abs(dx) < 1e-6 and abs(dy) < 1e-6:
        dx, dy = -1.0, 0.0
    travel = ctx.param("travel") * ctx.intensity * (1.0 - ctx.progress)
    qu = u + np.float32(dx) * np.float32(travel)
    qv = v + np.float32(dy) * np.float32(travel)
    alpha = ((qu >= 0.0) & (qu <= 1.0) & (qv >= 0.0) & (qv <= 1.0)).astype(np.float32)

    radius_px = ctx.param("radius") * min(ctx.width, ctx.height) * ctx.rem
    if radius_px <= 0.5:
        return sample(frame, qu, qv), alpha
    step_u = np.float32(dx * radius_px / max(1.0, ctx.width))
    step_v = np.float32(dy * radius_px / max(1.0, ctx.height))
    total = np.zeros_like(frame)
    for i in range(9):
        offset = (i / 8.0 - 0.5) * 2.0
        total += sample(frame, qu + step_u * np.float32(offset), qv + step_v * np.float32(offset))
    return np.asarray((total / np.float32(9.0)).astype(np.float32)), alpha


@register("blur-radial")
def blur_radial(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Zoom blur and spin blur: the same nine taps along a different path."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    strength = ctx.param("strength") * ctx.rem
    if strength <= 0.001:
        return opaque(sample(frame, u, v))
    cu = ctx.param("centreX", 0.5)
    cv = 1.0 - ctx.param("centreY", 0.5)
    spin_mode = ctx.param("mode") >= 0.5
    total = np.zeros_like(frame)
    for i in range(9):
        k = i / 8.0
        if not spin_mode:
            # 'out' streaks the other way, so a radial burst and a zoom-in blur
            # are the same pass with a sign.
            scale = 1.0 - k * strength * 0.35 * (-1.0 if ctx.dir_sign < 0.0 else 1.0)
            qu = np.float32(cu) + (u - np.float32(cu)) * np.float32(scale)
            qv = np.float32(cv) + (v - np.float32(cv)) * np.float32(scale)
        else:
            du, dv = square_uv(u - np.float32(cu), v - np.float32(cv), ctx.aspect)
            du, dv = rotate2(du, dv, k * strength * 0.5)
            du, dv = unsquare_uv(du, dv, ctx.aspect)
            qu = du + np.float32(cu)
            qv = dv + np.float32(cv)
        total += sample(frame, qu, qv)
    return opaque(np.asarray((total / np.float32(9.0)).astype(np.float32)))


@register("glitch")
def glitch(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Rows tear sideways and some are missing, so the shot assembles out of the damage."""
    height, width = frame.shape[0], frame.shape[1]
    u, v = uv_grid(height, width)
    seed = int(ctx.param("seed"))
    blocks = max(2.0, ctx.param("blocks"))
    row = np.floor(v * np.float32(blocks)).astype(np.int64)
    phase = np.full_like(row, int(np.floor(ctx.progress * 24.0)))
    noise = noise_stable(row, phase, seed)
    shift = (noise * 2.0 - 1.0) * ctx.param("displace") * ctx.intensity * ctx.rem * 0.4
    qu = u + shift.astype(np.float32)
    split = np.float32(ctx.param("rgbSplit") * ctx.rem * 0.04)
    rgb = np.stack(
        [
            sample(frame, qu + split, v)[..., 0],
            sample(frame, qu, v)[..., 1],
            sample(frame, qu - split, v)[..., 2],
        ],
        axis=-1,
    )
    order = noise_stable(row, np.full_like(row, 91), seed)
    alpha = (order <= ctx.progress * 1.25).astype(np.float32)
    return np.asarray(rgb.astype(np.float32)), np.asarray(alpha)


@register("rgb-split")
def rgb_split(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """Colour channels fly apart and converge while the frame dissolves in behind."""
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    amount = np.float32(ctx.param("split") * ctx.intensity * ctx.rem * 0.12)
    angle = np.radians(ctx.param("angle"))
    dx = np.float32(np.cos(angle))
    dy = np.float32(np.sin(angle))
    rgb = np.stack(
        [
            sample(frame, u + dx * amount, v + dy * amount)[..., 0],
            sample(frame, u, v)[..., 1],
            sample(frame, u - dx * amount, v - dy * amount)[..., 2],
        ],
        axis=-1,
    )
    alpha = np.full(frame.shape[:2], float(np.clip(ctx.progress * 1.6, 0.0, 1.0)), dtype=np.float32)
    return np.asarray(rgb.astype(np.float32)), alpha


@register("light-leak")
def light_leak(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """A band of light travelling across the frame.

    In ``leak`` mode it screens in and carries the incoming shot with it; in
    ``burn`` mode the band is where the old frame has been eaten away, so the light
    and the reveal are the same edge.
    """
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    dx, dy = ctx.direction
    angle = np.radians(ctx.param("angle"))
    rx = dx * np.cos(angle) - dy * np.sin(angle)
    ry = dx * np.sin(angle) + dy * np.cos(angle)
    if abs(rx) < 1e-6 and abs(ry) < 1e-6:
        rx, ry = 1.0, 0.0
    half = 0.5 * (abs(float(rx)) + abs(float(ry)))
    f = ((u - 0.5) * np.float32(rx) + (v - 0.5) * np.float32(ry) + half) / max(1e-3, 2.0 * half)

    head = ctx.progress * 1.7 - 0.35
    # The band fades out as well as travelling: a leak whose glow is still on the
    # frame at progress 1 leaves the shot permanently brighter than it should be.
    band = np.exp(-np.square((f - head) * 3.2)) * (1.0 - ctx.progress)
    warmth = float(np.clip(ctx.param("warmth"), 0.0, 1.0))
    cool = np.array([1.0, 0.88, 0.66], dtype=np.float32)
    hot = np.array([1.0, 0.42, 0.12], dtype=np.float32)
    tint = cool + (hot - cool) * np.float32(warmth)
    glow = (band * ctx.param("brightness") * ctx.intensity).astype(np.float32)[..., None]

    if ctx.param("mode") > 0.5:
        rgb = screen_blend(frame, tint * glow * np.float32(1.4))
        return np.asarray(rgb), reveal(np.asarray(f, dtype=np.float32), ctx.progress, ctx.feather)
    rgb = screen_blend(frame, tint * glow)
    ramp = np.float32(np.clip(ctx.progress * 1.2, 0.0, 1.0))
    alpha = np.clip(ramp + (1.0 - ramp) * band, 0.0, 1.0).astype(np.float32)
    return np.asarray(rgb), np.asarray(alpha)
