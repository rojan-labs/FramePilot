"""Spatial passes — the picture is a surface in 3D.

GLSL twins: the "Spatial" block of ``glsl-transitions.ts``.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.transition_passes import TransitionContext, register
from framepilot_engine.render.transition_passes._common import picture, sample, uv_grid

__all__: list[str] = []


@register("perspective-3d")
def perspective_3d(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """One projection, seven looks.

    A flip is one panel turning about its centre; a door is two turning about their
    outer edges; a fold is many; a cube pivots on an edge with depth; a carousel
    adds an arc; a tunnel is pure recession with no turn at all. Genuinely
    different pictures, and the same maths with different numbers — which is
    exactly the reuse the catalog is built on.

    Back faces are dropped rather than mirrored: this pass only ever has the
    INCOMING picture, so a "back face" here would be the same shot reversed, which
    is worse than letting the outgoing shot show through underneath.
    """
    u, v = uv_grid(frame.shape[0], frame.shape[1])
    vertical = ctx.param("axis") < 0.5
    panels = max(1.0, ctx.param("panels"))
    pivot = float(np.clip(ctx.param("pivot"), 0.0, 1.0))
    depth = ctx.param("depth")
    turns = ctx.param("turns")
    arc = ctx.param("arc")
    shade = ctx.param("shade")
    push = ctx.param("push")

    along = u if vertical else v
    other = v if vertical else u
    idx = np.floor(np.clip(along, 0.0, 0.9999) * panels)
    local = along * panels - idx
    sign = np.where(np.mod(idx, 2.0) < 0.5, 1.0, -1.0)
    pv = 0.5 + (0.0 - 0.5) * pivot

    angle = turns * 2.0 * np.pi * ctx.rem * sign
    ca = np.cos(angle)
    sa = np.sin(angle)

    x = local - pv
    z = x * sa + push * ctx.rem * 2.0 + arc * (1.0 - ca)
    # Perspective divide. The clamp keeps a surface that has swung behind the
    # camera from inverting instead of simply disappearing.
    w = np.maximum(0.15, 1.0 + z * depth * 1.1)
    xp = (x * ca) / w
    op = (other - 0.5) / w + 0.5
    ap = (xp + pv + idx) / panels

    qu = ap if vertical else op
    qv = op if vertical else ap
    rgb, alpha = picture(frame, qu.astype(np.float32), qv.astype(np.float32))

    # Keep each panel inside its own slot, or a wide panel bleeds over its neighbour.
    lo = idx / panels
    hi = (idx + 1.0) / panels
    alpha = alpha * ((ap >= lo - 1e-4) & (ap <= hi + 1e-4)).astype(np.float32)
    alpha = alpha * (ca >= 0.0).astype(np.float32)
    facing = np.clip(ca, 0.0, 1.0)
    shading = (1.0 + (facing - 1.0) * shade).astype(np.float32)[..., None]
    return np.asarray((rgb * shading).astype(np.float32)), np.asarray(alpha.astype(np.float32))


@register("page-turn")
def page_turn(frame: np.ndarray, ctx: TransitionContext) -> tuple[np.ndarray, np.ndarray]:
    """A curl sweeping across, with the shadow the lifted page casts.

    Honest about its limits: a real page turn shows the BACK of the outgoing page,
    and this pass only has the incoming picture. What it draws is the reveal edge
    and its shading, which is the part that reads as a page at speed.
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

    radius = max(0.02, ctx.param("curl") * 0.35)
    # The edge overshoots by three feathers rather than one, so the curl's lens bend
    # has fully left the frame by progress 1 and the shot lands undistorted.
    edge = ctx.progress * (1.0 + radius * 3.0)
    behind = (edge - f) / radius
    # Bend the sampling just behind the edge so the paper reads as curved.
    bend = np.exp(-np.square(behind) * 2.0) * radius * 0.35
    rgb = sample(
        frame,
        u - np.float32(rx) * bend.astype(np.float32),
        v - np.float32(ry) * bend.astype(np.float32),
    )
    shadow = (1.0 - ctx.param("shade") * 0.65 * np.exp(-np.square(behind) * 3.0)).astype(np.float32)
    alpha = (behind >= 0.0).astype(np.float32)
    return np.asarray((rgb * shadow[..., None]).astype(np.float32)), alpha
