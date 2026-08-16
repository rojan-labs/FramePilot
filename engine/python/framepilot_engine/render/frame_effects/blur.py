"""Blur, glow and edge passes (10 of the 41 render kinds).

These are the spatial-filter effects. All of them route through the O(1)-per-pixel
box/Gaussian helpers in ``_common`` rather than a convolution kernel, because a
naive kernel at the catalog's 64px maximum would dominate a 1080p render.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.frame_effects import EffectContext, register
from framepilot_engine.render.frame_effects._common import (
    gaussian_blur,
    hue_to_rgb,
    luminance,
    normalized_grid,
    sample_bilinear,
    separable_box,
    smoothstep,
)

__all__: list[str] = []


# ---------------------------------------------------------------------------
# Blur & focus
# ---------------------------------------------------------------------------


@register("blur-gaussian")
def blur_gaussian(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Even defocus across the frame."""
    return gaussian_blur(frame, ctx.param("radius"))


@register("blur-directional")
def blur_directional(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Motion smear along one axis — samples a line, not a disc."""
    radius = ctx.param("radius")
    if radius <= 0.5:
        return frame
    angle = np.radians(ctx.param("angle"))
    dx = float(np.cos(angle))
    dy = float(np.sin(angle))

    ys, xs = np.meshgrid(
        np.arange(ctx.height, dtype=np.float32),
        np.arange(ctx.width, dtype=np.float32),
        indexing="ij",
    )
    # Fixed tap count (not radius-proportional): the GLSL side must unroll a
    # constant loop, and a variable count there would not match here.
    taps = 9
    total = np.zeros_like(frame)
    for i in range(taps):
        offset = (i / (taps - 1.0) - 0.5) * 2.0 * radius
        total += sample_bilinear(frame, ys + dy * offset, xs + dx * offset)
    return total / np.float32(taps)


@register("blur-radial")
def blur_radial(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Streaks rushing outward from a centre point — speed/zoom blur."""
    strength = ctx.param("strength")
    if strength <= 0.0:
        return frame
    cx = ctx.param("centerX") * ctx.width
    cy = ctx.param("centerY") * ctx.height

    ys, xs = np.meshgrid(
        np.arange(ctx.height, dtype=np.float32),
        np.arange(ctx.width, dtype=np.float32),
        indexing="ij",
    )
    taps = 9
    total = np.zeros_like(frame)
    for i in range(taps):
        # Scale each tap toward the centre: the accumulated smear is therefore
        # radial, and zero-length at the centre itself (which stays sharp).
        scale = 1.0 - (i / (taps - 1.0)) * strength * 0.25
        total += sample_bilinear(frame, cy + (ys - cy) * scale, cx + (xs - cx) * scale)
    return total / np.float32(taps)


@register("tilt-shift")
def tilt_shift(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """A sharp horizontal band with blur above and below it."""
    radius = ctx.param("radius")
    focus_y = ctx.param("focusY")
    band = ctx.param("bandHeight")

    blurred = gaussian_blur(frame, radius)
    v, _u = normalized_grid(ctx.height, ctx.width)
    distance = np.abs(v - np.float32(focus_y))
    inner = np.float32(max(0.01, band * 0.5))
    # Feather over the band's own width so a narrow band is not hard-edged.
    weight = smoothstep(float(inner), float(inner) + 0.12 + float(band) * 0.3, distance)[..., None]
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(frame + (blurred - frame) * weight)


@register("soft-focus")
def soft_focus(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Blurred bloom laid over the sharp original — diffusion, not defocus."""
    radius = ctx.param("radius")
    mix_amount = np.float32(ctx.param("mix"))
    lift = np.float32(ctx.param("lift"))

    blurred = gaussian_blur(frame, radius)
    # Screen the blur over the original: highlights spread and the core stays
    # readable. A plain lerp would just look out of focus.
    screened = np.float32(1.0) - (np.float32(1.0) - frame) * (np.float32(1.0) - blurred)
    out = frame + (screened - frame) * mix_amount
    return np.asarray(out + (np.float32(1.0) - out) * lift)


# ---------------------------------------------------------------------------
# Glow & bloom
# ---------------------------------------------------------------------------


@register("bloom")
def bloom(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Light blooming out of pixels brighter than a threshold."""
    threshold = ctx.param("threshold")
    strength = np.float32(ctx.param("strength"))
    radius = ctx.param("radius")

    luma = luminance(frame)
    # Soft knee: a hard cutoff makes bloom pop on and off as a highlight moves.
    mask = smoothstep(threshold, min(1.0, threshold + 0.2), luma)[..., None]
    glow = gaussian_blur(frame * mask, radius)
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(np.clip(frame + glow * strength, 0.0, None))


@register("glow-diffuse")
def glow_diffuse(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """An even glow from the whole frame, not just the highlights."""
    strength = np.float32(ctx.param("strength"))
    radius = ctx.param("radius")
    glow = gaussian_blur(frame, radius)
    screened = np.float32(1.0) - (np.float32(1.0) - frame) * (np.float32(1.0) - glow)
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(frame + (screened - frame) * strength)


# ---------------------------------------------------------------------------
# Edge & stylised
# ---------------------------------------------------------------------------


def _sobel(luma: np.ndarray) -> np.ndarray:
    """Sobel gradient magnitude of a luma plane, normalized to roughly ``[0, 1]``.

    Implemented with shifted slices rather than a convolution so it stays cheap and
    so the GLSL twin — which samples eight neighbours directly — matches exactly.
    """
    padded = np.pad(luma, 1, mode="edge")
    # fmt: off
    gx = (
        -padded[:-2, :-2] - np.float32(2.0) * padded[1:-1, :-2] - padded[2:, :-2]
        + padded[:-2, 2:] + np.float32(2.0) * padded[1:-1, 2:] + padded[2:, 2:]
    )
    gy = (
        -padded[:-2, :-2] - np.float32(2.0) * padded[:-2, 1:-1] - padded[:-2, 2:]
        + padded[2:, :-2] + np.float32(2.0) * padded[2:, 1:-1] + padded[2:, 2:]
    )
    # fmt: on
    # /4 because the Sobel kernel sums to 4 on a full-contrast edge.
    return np.asarray(
        np.clip(np.sqrt(gx * gx + gy * gy) / np.float32(4.0), 0.0, 1.0).astype(np.float32)
    )


def _thicken(edges: np.ndarray, thickness: float) -> np.ndarray:
    """Widen an edge map. A box blur then a re-threshold approximates a dilation."""
    if thickness <= 0.0:
        return edges
    radius = 1.0 + thickness * 3.0
    spread = separable_box(edges[..., None], radius)[..., 0]
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(np.clip(spread * (np.float32(1.0) + np.float32(radius)), 0.0, 1.0))


@register("edge-outline")
def edge_outline(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Trace contours and light them over the original picture."""
    threshold = ctx.param("threshold")
    thickness = ctx.param("thickness")
    mix_amount = np.float32(ctx.param("mix"))

    edges = _sobel(luminance(frame))
    edges = smoothstep(threshold, min(1.0, threshold + 0.15), edges)
    edges = _thicken(edges, thickness)[..., None]
    # Screen white along the edges so they read as light rather than paint.
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(frame + (np.float32(1.0) - frame) * edges * mix_amount)


@register("neon-edge")
def neon_edge(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Saturated neon contours over a darkened frame."""
    threshold = ctx.param("threshold")
    hue = hue_to_rgb(ctx.param("hue"))
    strength = np.float32(ctx.param("strength"))
    thickness = ctx.param("thickness")

    edges = _sobel(luminance(frame))
    edges = smoothstep(threshold, min(1.0, threshold + 0.12), edges)
    edges = _thicken(edges, thickness)
    # Bloom the edge map itself, which is what makes it read as emitted light
    # rather than a coloured line.
    glow = gaussian_blur(edges[..., None], 8.0)[..., 0]

    # Darken the base so the neon has something to sit against — a neon effect on
    # a bright frame just looks like a colour cast.
    base = frame * (np.float32(1.0) - strength * np.float32(0.55))
    lit = (edges + glow * np.float32(0.8))[..., None] * hue * strength * np.float32(1.4)
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(
        np.float32(1.0) - (np.float32(1.0) - base) * (np.float32(1.0) - np.clip(lit, 0.0, 1.0))
    )


@register("sketch")
def sketch(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Pen-and-ink line work on white."""
    strength = np.float32(ctx.param("strength"))
    threshold = ctx.param("threshold")

    edges = _sobel(luminance(frame))
    ink = smoothstep(threshold * 0.5, min(1.0, threshold * 0.5 + 0.25), edges)
    # Invert to dark lines on white paper.
    paper = np.float32(1.0) - ink[..., None]
    drawn = np.repeat(paper, 3, axis=-1)
    return np.asarray(frame + (drawn - frame) * strength)
