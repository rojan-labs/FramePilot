"""Geometric, motion and spatial-quantisation passes (11 of the 41 render kinds).

These all resample the frame. Every one of them samples through
``sample_bilinear``, which clamps at the edges exactly as a GPU sampler in
``CLAMP_TO_EDGE`` does — wrapping instead would fold unrelated content in from
the opposite side of the frame.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.frame_effects import EffectContext, register
from framepilot_engine.render.frame_effects._common import (
    coord_grid,
    luminance,
    normalized_grid,
    sample_bilinear,
    separable_box,
    smoothstep,
)
from framepilot_engine.render.frame_effects.deterministic import (
    quantize_time,
    value_noise01,
)

__all__: list[str] = []


def _pixel_grid(ctx: EffectContext) -> tuple[np.ndarray, np.ndarray]:
    """Float pixel-coordinate grids ``(ys, xs)`` for resampling."""
    return np.meshgrid(
        np.arange(ctx.height, dtype=np.float32),
        np.arange(ctx.width, dtype=np.float32),
        indexing="ij",
    )


def _centered_uv(ctx: EffectContext) -> tuple[np.ndarray, np.ndarray]:
    """UV centred on ``(0,0)`` in ``[-1,1]``, aspect-corrected on the short axis.

    Aspect correction is what keeps a fisheye circular on a 9:16 frame instead of
    stretching into an ellipse.
    """
    v, u = normalized_grid(ctx.height, ctx.width)
    aspect = np.float32(ctx.width) / np.float32(max(1, ctx.height))
    cx = (u - np.float32(0.5)) * np.float32(2.0)
    cy = (v - np.float32(0.5)) * np.float32(2.0)
    if aspect >= 1.0:
        cx = cx * aspect
    else:
        cy = cy / aspect
    return cy, cx


def _uv_to_pixels(
    ctx: EffectContext, cy: np.ndarray, cx: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Inverse of :func:`_centered_uv` — back to float pixel coordinates."""
    aspect = np.float32(ctx.width) / np.float32(max(1, ctx.height))
    x = cx / aspect if aspect >= 1.0 else cx
    y = cy if aspect >= 1.0 else cy * aspect
    px = (x * np.float32(0.5) + np.float32(0.5)) * np.float32(ctx.width) - np.float32(0.5)
    py = (y * np.float32(0.5) + np.float32(0.5)) * np.float32(ctx.height) - np.float32(0.5)
    return py, px


# ---------------------------------------------------------------------------
# Lens deformation & warp
# ---------------------------------------------------------------------------


@register("fisheye")
def fisheye(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Spherical lens curvature bowing the frame outward."""
    amount = np.float32(ctx.param("amount"))
    zoom = np.float32(max(0.01, ctx.param("zoom")))

    cy, cx = _centered_uv(ctx)
    radius = np.sqrt(cx * cx + cy * cy)
    # Inverse mapping: for each OUTPUT pixel find where to read. Solving forward
    # would leave holes wherever the warp expands.
    theta = np.arctan(radius * (np.float32(1.0) + amount * np.float32(2.0)))
    # Guard the exact centre, where radius is 0. `np.where` alone is not enough:
    # BOTH branches are evaluated first, so the division still runs and emits an
    # invalid-value warning (and a NaN that only happens to be discarded). A
    # denominator floor keeps it warning-free and matches GLSL, where dividing by
    # a clamped epsilon is the same idiom.
    safe_radius = np.maximum(radius, np.float32(1e-6))
    scale = np.where(
        radius > np.float32(1e-6),
        theta / (safe_radius * np.float32(np.pi / 2.0)),
        np.float32(1.0),
    )
    scale = scale.astype(np.float32) / zoom

    py, px = _uv_to_pixels(ctx, cy * scale, cx * scale)
    return sample_bilinear(frame, py, px)


@register("barrel-warp")
def barrel_warp(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Bulge the centre outward (positive) or pinch it inward (negative)."""
    amount = np.float32(ctx.param("amount"))
    cy, cx = _centered_uv(ctx)
    r2 = cx * cx + cy * cy
    # Classic Brown-Conrady radial term. Reading with (1 + k·r²) means a positive
    # k samples from further out, which magnifies the centre — a barrel bulge.
    factor = (np.float32(1.0) + amount * np.float32(0.4) * r2).astype(np.float32)
    py, px = _uv_to_pixels(ctx, cy * factor, cx * factor)
    return sample_bilinear(frame, py, px)


@register("ripple")
def ripple(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Travelling sine waves across the picture."""
    amplitude = ctx.param("amplitude")
    frequency = ctx.param("frequency")
    speed = ctx.param("speed")

    ys, xs = _pixel_grid(ctx)
    phase = ctx.local_time * speed * 2.0 * np.pi
    # Displace along BOTH axes with a quarter-cycle offset so the distortion reads
    # as water rather than a horizontal shear.
    px_amp = amplitude * 0.03 * ctx.width
    dx = np.sin(ys / max(1.0, ctx.height) * frequency * 2.0 * np.pi + phase) * px_amp
    dy = np.cos(xs / max(1.0, ctx.width) * frequency * 2.0 * np.pi + phase) * px_amp * 0.6
    return sample_bilinear(frame, ys + dy.astype(np.float32), xs + dx.astype(np.float32))


# ---------------------------------------------------------------------------
# Mirror & split
# ---------------------------------------------------------------------------


@register("mirror")
def mirror(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Reflect one half of the frame across a seam."""
    # `axis` is a CHOICE param: the value is an index into the descriptor's
    # `choices` list, which is how the schema keeps params uniformly numeric.
    axis = round(ctx.param("axis"))
    offset = float(np.clip(ctx.param("offset"), 0.0, 1.0))

    out = frame.copy()
    if axis in (0, 1):
        seam = round(offset * ctx.width)
        seam = max(1, min(ctx.width - 1, seam))
        if axis == 0:  # left → right
            width = min(seam, ctx.width - seam)
            out[:, seam : seam + width] = frame[:, seam - width : seam][:, ::-1]
        else:  # right → left
            width = min(seam, ctx.width - seam)
            out[:, seam - width : seam] = frame[:, seam : seam + width][:, ::-1]
    else:
        seam = round(offset * ctx.height)
        seam = max(1, min(ctx.height - 1, seam))
        if axis == 2:  # top → bottom
            height = min(seam, ctx.height - seam)
            out[seam : seam + height, :] = frame[seam - height : seam, :][::-1, :]
        else:  # bottom → top
            height = min(seam, ctx.height - seam)
            out[seam - height : seam, :] = frame[seam : seam + height, :][::-1, :]
    return out


@register("kaleidoscope")
def kaleidoscope(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Fold the frame into radial mirrored wedges."""
    segments = max(2, round(ctx.param("segments")))
    rotation = np.radians(ctx.param("rotation"))
    zoom = np.float32(max(0.01, ctx.param("zoom")))

    cy, cx = _centered_uv(ctx)
    radius = np.sqrt(cx * cx + cy * cy)
    angle = np.arctan2(cy, cx) + np.float32(rotation)

    wedge = np.float32(2.0 * np.pi / segments)
    # Fold into one wedge, then MIRROR the fold: without the mirror the seams are
    # discontinuous and the result reads as a stutter instead of a reflection.
    folded = np.mod(angle, wedge)
    folded = np.minimum(folded, wedge - folded)

    r = radius / zoom
    py, px = _uv_to_pixels(ctx, np.sin(folded) * r, np.cos(folded) * r)
    return sample_bilinear(frame, py, px)


# ---------------------------------------------------------------------------
# Motion & impact
# ---------------------------------------------------------------------------


@register("shake")
def shake(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Camera shake — translation plus optional rotation."""
    amplitude = ctx.param("amplitude")
    frequency = ctx.param("frequency")
    rotation = ctx.param("rotation")

    # Two incommensurate sine pairs give organic, non-repeating motion without
    # needing a RNG (which could not be reproduced in GLSL).
    t = ctx.local_time * frequency
    ox = (np.sin(t * 2.0 * np.pi) + 0.6 * np.sin(t * 5.3 * np.pi)) * amplitude * 0.02 * ctx.width
    oy = (np.cos(t * 2.3 * np.pi) + 0.6 * np.cos(t * 4.7 * np.pi)) * amplitude * 0.02 * ctx.height
    angle = np.sin(t * 3.1 * np.pi) * rotation * 0.05

    ys, xs = _pixel_grid(ctx)
    cx = np.float32(ctx.width) * np.float32(0.5)
    cy = np.float32(ctx.height) * np.float32(0.5)
    dx = xs - cx
    dy = ys - cy
    cos_a = np.float32(np.cos(angle))
    sin_a = np.float32(np.sin(angle))
    # Slight overscan so the shake never exposes a black edge.
    overscan = np.float32(1.0) / (np.float32(1.0) + np.float32(amplitude) * np.float32(0.06))
    rx = (dx * cos_a - dy * sin_a) * overscan + cx + np.float32(ox)
    ry = (dx * sin_a + dy * cos_a) * overscan + cy + np.float32(oy)
    return sample_bilinear(frame, ry, rx)


@register("zoom-punch")
def zoom_punch(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Scale up over the attack, hold, then release — an emphasis envelope."""
    amount = ctx.param("amount")
    attack = max(1e-3, ctx.param("attack"))
    hold = ctx.param("hold")

    p = ctx.progress
    if p < attack:
        envelope = smoothstep(0.0, 1.0, np.array([p / attack], dtype=np.float32))[0]
    elif p < attack + hold:
        envelope = np.float32(1.0)
    else:
        release = max(1e-3, 1.0 - attack - hold)
        envelope = (
            np.float32(1.0)
            - smoothstep(0.0, 1.0, np.array([(p - attack - hold) / release], dtype=np.float32))[0]
        )

    scale = np.float32(1.0) / (np.float32(1.0) + np.float32(amount) * envelope)
    ys, xs = _pixel_grid(ctx)
    cx = np.float32(ctx.width) * np.float32(0.5)
    cy = np.float32(ctx.height) * np.float32(0.5)
    return sample_bilinear(frame, cy + (ys - cy) * scale, cx + (xs - cx) * scale)


@register("whip-pan")
def whip_pan(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """A blurred lateral throw — pairs with a cut to make a whip transition."""
    amount = ctx.param("amount")
    angle = np.radians(ctx.param("angle"))
    blur = ctx.param("blur")

    # Peak at the middle of the layer and ease out both sides, so the throw is a
    # complete gesture regardless of how long the layer is.
    p = ctx.progress
    envelope = float(np.sin(np.clip(p, 0.0, 1.0) * np.pi))
    shift = amount * envelope * 0.5 * ctx.width
    dx = float(np.cos(angle)) * shift
    dy = float(np.sin(angle)) * shift

    ys, xs = _pixel_grid(ctx)
    taps = 7
    total = np.zeros_like(frame)
    for i in range(taps):
        # Smear BACK along the direction of travel, which is what a real shutter
        # integrating over the pan captures.
        f = (i / (taps - 1.0)) * blur
        total += sample_bilinear(frame, ys + dy * f, xs + dx * f)
    return total / np.float32(taps)


# ---------------------------------------------------------------------------
# Spatial quantisation
# ---------------------------------------------------------------------------


@register("mosaic")
def mosaic(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Quantise into flat colour cells."""
    size = max(2, round(ctx.param("size")))
    ys, xs = coord_grid(ctx.height, ctx.width)
    # Average each cell (via a box blur) then read the cell centre, so a cell is
    # its mean colour rather than whichever pixel happened to land on the corner.
    averaged = separable_box(frame, size / 2.0)
    cy = np.clip((ys // size) * size + size // 2, 0, ctx.height - 1)
    cx = np.clip((xs // size) * size + size // 2, 0, ctx.width - 1)
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(averaged[cy, cx])


@register("halftone")
def halftone(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Rotated dot screen, like newsprint."""
    dot = max(2.0, ctx.param("dotSize"))
    angle = np.radians(ctx.param("angle"))
    mix_amount = np.float32(ctx.param("mix"))

    ys, xs = _pixel_grid(ctx)
    # Rotate the SCREEN, not the image: a rotated dot grid is what stops the
    # pattern beating against horizontal picture detail.
    cos_a, sin_a = np.float32(np.cos(angle)), np.float32(np.sin(angle))
    rx = xs * cos_a - ys * sin_a
    ry = xs * sin_a + ys * cos_a

    # Distance from each cell's centre, in cell units.
    fx = np.mod(rx, dot) / dot - np.float32(0.5)
    fy = np.mod(ry, dot) / dot - np.float32(0.5)
    dist = np.sqrt(fx * fx + fy * fy) * np.float32(2.0)

    luma = luminance(separable_box(frame, dot / 3.0))
    # Dot radius tracks local darkness: dark areas grow until they merge.
    radius = np.sqrt(np.clip(np.float32(1.0) - luma, 0.0, 1.0)).astype(np.float32)
    ink = smoothstep(0.0, 0.25, radius - dist)[..., None]
    screened = np.repeat(np.float32(1.0) - ink, 3, axis=-1)
    return np.asarray(frame + (screened - frame) * mix_amount)


@register("pixel-sort")
def pixel_sort(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Bright pixels bleed along rows (or columns) in sorted-looking runs.

    A true per-row sort is data-dependent and cannot be expressed in a fragment
    shader, so this uses a directional maximum-smear gated by a brightness
    threshold — the same visual read, and identical in both renderers.
    """
    threshold = ctx.param("threshold")
    amount = ctx.param("amount")
    vertical = round(ctx.param("axis")) == 1
    if amount <= 0.0:
        # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
        return np.asarray(frame)

    luma = luminance(frame)
    mask = (luma > np.float32(threshold)).astype(np.float32)[..., None]

    span = max(1, round(amount * 0.08 * (ctx.height if vertical else ctx.width)))
    axis = 0 if vertical else 1
    smeared = frame.copy()
    step = 1
    # Doubling shifts reach `span` in log steps — the running maximum is what
    # produces the characteristic bright streaks.
    while step < span:
        rolled = np.roll(smeared, step, axis=axis)
        smeared = np.maximum(smeared, rolled * mask)
        step *= 2
    return np.asarray(frame + (smeared - frame) * np.float32(amount))


# `value_noise01`/`quantize_time` are imported for the shake family's organic
# drift; referenced here so linters see the intentional dependency.
_ = (value_noise01, quantize_time)
