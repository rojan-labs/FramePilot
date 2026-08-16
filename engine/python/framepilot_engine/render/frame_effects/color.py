"""Tonal, colour and light-overlay passes (13 of the 41 render kinds).

Every pass takes and returns a float32 RGB frame in ``[0, 1]`` at full strength;
``intensity`` is mixed by the dispatcher. See ``__init__.py`` for the contract.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.frame_effects import EffectContext, register
from framepilot_engine.render.frame_effects._common import (
    hue_to_rgb,
    luminance,
    normalized_grid,
    smoothstep,
)
from framepilot_engine.render.frame_effects.deterministic import (
    quantize_time,
    value_noise01,
)

__all__: list[str] = []


# ---------------------------------------------------------------------------
# Film & cinematic
# ---------------------------------------------------------------------------


@register("film-fade")
def film_fade(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Lifted blacks, rolled highlights, warmth and desaturation — faded stock.

    Order matters and is the same order a film print does it: lift/roll first
    (a tonal remap), THEN warmth and saturation. Grading before the roll-off
    would push already-warm highlights past the shoulder and clip them.
    """
    lift = np.float32(ctx.param("lift"))
    rolloff = np.float32(ctx.param("rolloff"))
    warmth = np.float32(ctx.param("warmth"))
    saturation = np.float32(ctx.param("saturation"))

    # Compress into [lift, 1] so black never reaches 0 — the defining trait.
    out = lift + frame * (np.float32(1.0) - lift)
    # Shoulder: pull highlights toward a soft knee proportionally to rolloff.
    knee = np.float32(1.0) - rolloff * np.float32(0.35)
    out = np.where(out > knee, knee + (out - knee) * (np.float32(1.0) - rolloff), out)

    # Warmth as a red/blue counter-tilt, so overall exposure is unchanged.
    tilt = np.array([1.0 + float(warmth) * 0.12, 1.0, 1.0 - float(warmth) * 0.12], dtype=np.float32)
    out = out * tilt

    luma = luminance(out)[..., None]
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(luma + (out - luma) * saturation)


@register("film-curve")
def film_curve(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Split-toned S-curve — one hue into the shadows, another into the highlights."""
    contrast = np.float32(ctx.param("contrast"))
    strength = np.float32(ctx.param("strength"))
    shadow = hue_to_rgb(ctx.param("shadowTint"))
    highlight = hue_to_rgb(ctx.param("highlightTint"))

    # S-curve pivoted on mid-grey. Using smoothstep rather than a gamma keeps both
    # ends symmetrical, so a negative `contrast` genuinely flattens rather than
    # just brightening.
    curved = frame + (smoothstep(0.0, 1.0, frame) - frame) * contrast

    luma = luminance(curved)
    # Tint weights peak at the ends and vanish at mid-grey, so skin (near 0.5)
    # keeps its own colour — the whole point of a split tone rather than a wash.
    shadow_w = (np.clip(np.float32(1.0) - luma * np.float32(2.0), 0.0, 1.0) * strength)[..., None]
    highlight_w = (np.clip(luma * np.float32(2.0) - np.float32(1.0), 0.0, 1.0) * strength)[
        ..., None
    ]

    # Soft-light-ish toning: scale toward the tint hue, preserving luma.
    toned = curved * (np.float32(1.0) - shadow_w) + curved * shadow * shadow_w * np.float32(1.6)
    toned = (
        toned * (np.float32(1.0) - highlight_w)
        + (toned + (highlight - toned) * np.float32(0.5)) * highlight_w
    )
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(toned)


# ---------------------------------------------------------------------------
# Lens falloff & light overlays
# ---------------------------------------------------------------------------


@register("vignette")
def vignette(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Darkened corners. Radius sets where falloff starts, softness how gradual."""
    amount = np.float32(ctx.param("amount"))
    radius = np.float32(ctx.param("radius"))
    softness = np.float32(ctx.param("softness"))

    v, u = normalized_grid(ctx.height, ctx.width)
    # Aspect-corrected radial distance, so a 9:16 frame vignettes in a circle
    # rather than an ellipse.
    aspect = np.float32(ctx.width) / np.float32(max(1, ctx.height))
    dx = (u - np.float32(0.5)) * np.float32(2.0) * max(np.float32(1.0), aspect)
    dy = (v - np.float32(0.5)) * np.float32(2.0) * max(np.float32(1.0), np.float32(1.0) / aspect)
    dist = np.sqrt(dx * dx + dy * dy)

    inner = radius * np.float32(1.4)
    outer = inner + np.float32(0.05) + softness * np.float32(1.2)
    falloff = smoothstep(float(inner), float(outer), dist)
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(frame * (np.float32(1.0) - falloff[..., None] * amount))


@register("light-leak")
def light_leak(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """A soft band of light spilling in from one edge, drifting slowly over time."""
    angle = np.radians(ctx.param("angle"))
    strength = np.float32(ctx.param("strength"))
    warmth = np.float32(ctx.param("warmth"))
    position = np.float32(ctx.param("position"))

    v, u = normalized_grid(ctx.height, ctx.width)
    # Project onto the leak axis, so `position` slides the band along it.
    axis = (u - np.float32(0.5)) * np.float32(np.cos(angle)) + (v - np.float32(0.5)) * np.float32(
        np.sin(angle)
    )

    # Organic drift: a slow smooth-noise wobble on the band centre. Quantized time
    # keeps it identical between preview and render.
    frame_idx = quantize_time(ctx.local_time)
    wobble = value_noise01(
        np.zeros((1, 1), dtype=np.int64), np.zeros((1, 1), dtype=np.int64), frame_idx // 12, 4.0
    )[0, 0]
    centre = (position - np.float32(0.5)) + (wobble - np.float32(0.5)) * np.float32(0.06)

    band = np.exp(-np.square((axis - centre) * np.float32(6.0))).astype(np.float32)
    tint = np.array([1.0, 0.72 + 0.2 * float(warmth), 0.42 + 0.1 * float(warmth)], dtype=np.float32)
    warm = tint / max(float(tint.max()), 1e-6)
    # Screen blend, so the leak adds light without ever darkening a pixel.
    add = band[..., None] * warm * strength
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(
        np.float32(1.0) - (np.float32(1.0) - frame) * (np.float32(1.0) - np.clip(add, 0.0, 1.0))
    )


@register("lens-flare")
def lens_flare(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """A streaked anamorphic flare anchored at a point, plus a ghost across centre."""
    fx = np.float32(ctx.param("x"))
    fy = np.float32(ctx.param("y"))
    strength = np.float32(ctx.param("strength"))
    spread = np.float32(ctx.param("spread"))

    v, u = normalized_grid(ctx.height, ctx.width)
    dx = u - fx
    dy = v - fy

    # Horizontal streak: tight vertically, wide horizontally — the anamorphic look.
    streak = np.exp(-np.square(dy * np.float32(60.0))) * np.exp(
        -np.square(dx / (np.float32(0.15) + spread * np.float32(0.5)))
    )
    core = np.exp(-(dx * dx + dy * dy) * np.float32(600.0))
    # Ghost mirrored through frame centre, as real glass produces.
    gx = u - (np.float32(1.0) - fx)
    gy = v - (np.float32(1.0) - fy)
    ghost = np.exp(-(gx * gx + gy * gy) * np.float32(300.0)) * np.float32(0.4)

    blue = np.array([0.55, 0.72, 1.0], dtype=np.float32)
    add = ((streak + core)[..., None] * blue + ghost[..., None]) * strength
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(
        np.float32(1.0) - (np.float32(1.0) - frame) * (np.float32(1.0) - np.clip(add, 0.0, 1.0))
    )


@register("halation")
def halation(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Warm bleed around highlights, the way film emulsion scatters red light."""
    # Imported here rather than at module scope: `_common` imports nothing from
    # this module, but keeping the heavy blur import local documents that halation
    # is the only colour pass that needs a spatial filter.
    from framepilot_engine.render.frame_effects._common import gaussian_blur

    threshold = ctx.param("threshold")
    strength = np.float32(ctx.param("strength"))
    tint = hue_to_rgb(ctx.param("tint"))

    luma = luminance(frame)
    # Soft knee above the threshold, so a highlight does not pop into blooming.
    mask = smoothstep(threshold, min(1.0, threshold + 0.25), luma)[..., None]
    bleed = gaussian_blur(frame * mask, 18.0)
    add = bleed * tint * strength
    return np.asarray(
        np.float32(1.0) - (np.float32(1.0) - frame) * (np.float32(1.0) - np.clip(add, 0.0, 1.0))
    )


# ---------------------------------------------------------------------------
# Chromatic separation
# ---------------------------------------------------------------------------


def _shift_channel(frame: np.ndarray, channel: int, dy: float, dx: float) -> np.ndarray:
    """Integer-roll one colour channel. Edges replicate rather than wrap."""
    shifted = np.roll(frame[..., channel], (round(dy), round(dx)), axis=(0, 1))
    # `np.roll` wraps, which would drag the opposite edge into frame; clamp the
    # wrapped band back to the edge row/column instead.
    iy, ix = round(dy), round(dx)
    if iy > 0:
        shifted[:iy, :] = shifted[iy : iy + 1, :]
    elif iy < 0:
        shifted[iy:, :] = shifted[iy - 1 : iy, :]
    if ix > 0:
        shifted[:, :ix] = shifted[:, ix : ix + 1]
    elif ix < 0:
        shifted[:, ix:] = shifted[:, ix - 1 : ix]
    return shifted


@register("chroma-shift")
def chroma_shift(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Lens-style aberration: fringing that GROWS toward the frame edges."""
    amount = np.float32(ctx.param("amount"))
    angle = np.radians(ctx.param("angle"))

    v, u = normalized_grid(ctx.height, ctx.width)
    # Radial weight is what separates real aberration from a flat channel offset:
    # glass is sharp on axis and disperses at the periphery.
    dx = (u - np.float32(0.5)) * np.float32(2.0)
    dy = (v - np.float32(0.5)) * np.float32(2.0)
    radial = np.sqrt(dx * dx + dy * dy)

    px = float(amount) * 0.02 * ctx.width
    offx = px * float(np.cos(angle))
    offy = px * float(np.sin(angle))

    from framepilot_engine.render.frame_effects._common import sample_bilinear

    ys, xs = np.meshgrid(
        np.arange(ctx.height, dtype=np.float32),
        np.arange(ctx.width, dtype=np.float32),
        indexing="ij",
    )
    red = sample_bilinear(frame, ys + offy * radial, xs + offx * radial)[..., 0]
    blue = sample_bilinear(frame, ys - offy * radial, xs - offx * radial)[..., 2]
    return np.stack([red, frame[..., 1], blue], axis=-1)


@register("rgb-split")
def rgb_split(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Hard, uniform channel separation along one axis — the glitch/3D look."""
    amount = ctx.param("amount")
    angle = np.radians(ctx.param("angle"))
    px = amount * 0.03 * ctx.width
    dx = px * float(np.cos(angle))
    dy = px * float(np.sin(angle))
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(
        np.stack(
            [
                _shift_channel(frame, 0, dy, dx),
                frame[..., 1],
                _shift_channel(frame, 2, -dy, -dx),
            ],
            axis=-1,
        )
    )


# ---------------------------------------------------------------------------
# Quantisation
# ---------------------------------------------------------------------------


@register("posterize")
def posterize(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Flatten tones into N bands, with a saturation push for the poster look."""
    levels = max(2.0, ctx.param("levels"))
    saturation = np.float32(ctx.param("saturation"))
    luma = luminance(frame)[..., None]
    boosted = luma + (frame - luma) * saturation
    steps = np.float32(levels - 1.0)
    # Round (not floor) so the band boundaries sit symmetrically about each level;
    # flooring would darken the whole image by half a band.
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(np.round(np.clip(boosted, 0.0, 1.0) * steps) / steps)


@register("dither")
def dither(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Ordered (Bayer 4x4) dithering down to a few levels per channel.

    An ordered matrix rather than noise: it is stable frame to frame, so a static
    shot does not shimmer, and it is trivially identical in GLSL (a lookup on
    ``gl_FragCoord % 4``).
    """
    levels = max(2.0, ctx.param("levels"))
    strength = np.float32(ctx.param("strength"))

    bayer = (
        np.array(
            [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]],
            dtype=np.float32,
        )
        / np.float32(16.0)
    ) - np.float32(0.5)

    ys, xs = np.meshgrid(np.arange(ctx.height), np.arange(ctx.width), indexing="ij")
    threshold = bayer[ys % 4, xs % 4][..., None]

    steps = np.float32(levels - 1.0)
    nudged = frame + threshold * strength / steps
    return np.asarray(np.clip(np.round(np.clip(nudged, 0.0, 1.0) * steps) / steps, 0.0, 1.0))


# ---------------------------------------------------------------------------
# Temporal light
# ---------------------------------------------------------------------------


@register("flash")
def flash(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Rhythmic white blowouts on a duty cycle."""
    frequency = ctx.param("frequency")
    strength = np.float32(ctx.param("strength"))
    duty = ctx.param("duty")
    if frequency <= 0.0:
        # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
        return np.asarray(frame)
    phase = (ctx.local_time * frequency) % 1.0
    if phase >= duty or duty <= 0.0:
        return frame
    # Ramp down across the lit portion so each flash decays rather than switching
    # off — a hard square edge reads as a dropped frame, not a flash.
    envelope = np.float32(1.0 - (phase / duty))
    lit = envelope * strength
    return np.asarray(frame + (np.float32(1.0) - frame) * lit)


@register("flicker")
def flicker(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Irregular brightness wobble — a failing bulb rather than a clean strobe."""
    frequency = ctx.param("frequency")
    depth = np.float32(ctx.param("depth"))
    irregular = np.float32(ctx.param("irregular"))
    if frequency <= 0.0:
        # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
        return np.asarray(frame)

    # A clean sine gives the regular component; smooth noise on a quantized clock
    # supplies the irregular one, so "irregular: 0" is a steady pulse.
    regular = np.float32(0.5 + 0.5 * np.sin(ctx.local_time * frequency * 2.0 * np.pi))
    step = quantize_time(ctx.local_time * max(0.1, frequency) * 0.25)
    jitter = value_noise01(
        np.zeros((1, 1), dtype=np.int64), np.zeros((1, 1), dtype=np.int64), step, 2.0, salt=7
    )[0, 0]
    level = regular + (jitter - regular) * irregular
    return np.asarray(frame * (np.float32(1.0) - depth * (np.float32(1.0) - level)))


@register("strobe-color")
def strobe_color(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Alternating colour washes on a steady beat."""
    hue_a = hue_to_rgb(ctx.param("hueA"))
    hue_b = hue_to_rgb(ctx.param("hueB"))
    frequency = ctx.param("frequency")
    strength = np.float32(ctx.param("strength"))
    if frequency <= 0.0:
        # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
        return np.asarray(frame)

    # Square alternation with a short crossfade, so the wash snaps on the beat but
    # does not tear a frame in half at high rates.
    phase = (ctx.local_time * frequency) % 2.0
    blend = smoothstep(0.85, 1.15, np.array([phase], dtype=np.float32))[0]
    if phase > 1.5:
        blend = np.float32(1.0) - smoothstep(1.85, 2.0, np.array([phase], dtype=np.float32))[0]
    wash = hue_a + (hue_b - hue_a) * blend

    luma = luminance(frame)[..., None]
    # Multiply against luma so the wash keeps the picture's tonal structure
    # instead of flooding it flat.
    return np.asarray(frame + (luma * wash - frame) * strength)
