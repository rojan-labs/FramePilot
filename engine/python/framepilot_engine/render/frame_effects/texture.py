"""Grain, analog-artefact and glitch passes (7 of the 41 render kinds).

Every pass here is time-varying and noise-driven, which makes them the ones most
at risk of drifting between preview and render. They all derive their randomness
from the integer hash in ``deterministic.py`` keyed on a QUANTIZED timestamp, so
"the same moment looks the same" holds whether the frame came from a render at
exactly 4.000s or a preview that landed on 4.003s.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.frame_effects import EffectContext, register
from framepilot_engine.render.frame_effects._common import (
    coord_grid,
    luminance,
    sample_bilinear,
    smoothstep,
)
from framepilot_engine.render.frame_effects.deterministic import (
    noise01,
    quantize_time,
    value_noise01,
)

__all__: list[str] = []


def _noise_frame(ctx: EffectContext, speed: float) -> int:
    """The quantized noise clock for this frame, scaled by a ``speed`` param.

    ``speed: 0`` freezes the field (a still grain plate), which is a legitimate
    look and must not divide by zero anywhere downstream.
    """
    return quantize_time(ctx.local_time * max(0.0, speed))


# ---------------------------------------------------------------------------
# Grain & physical wear
# ---------------------------------------------------------------------------


@register("grain")
def grain(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Animated film grain."""
    amount = np.float32(ctx.param("amount"))
    size = max(0.5, ctx.param("size"))
    step = _noise_frame(ctx, ctx.param("speed") * 24.0)

    ys, xs = coord_grid(ctx.height, ctx.width)
    # Sampling the noise on a coarser grid is what makes `size` mean grain size
    # rather than grain amount.
    gy = (ys / size).astype(np.int64)
    gx = (xs / size).astype(np.int64)
    n = noise01(gx, gy, step) - np.float32(0.5)

    # Grain is strongest in the midtones on real stock — it disappears in blown
    # highlights and gets buried in the blacks.
    luma = luminance(frame)
    weight = (np.float32(1.0) - np.abs(luma - np.float32(0.5)) * np.float32(1.6)).clip(0.15, 1.0)
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(frame + (n * weight * amount * np.float32(0.5))[..., None])


@register("dust-scratches")
def dust_scratches(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Dust specks and vertical scratches, as on a worn print."""
    density = ctx.param("density")
    scratch_amount = ctx.param("scratches")
    # Dirt changes on a much slower clock than grain — it is physical debris that
    # persists for several frames, not per-frame sensor noise.
    step = _noise_frame(ctx, ctx.param("speed") * 8.0)

    ys, xs = coord_grid(ctx.height, ctx.width)
    out = frame

    if density > 0.0:
        # Specks on a coarse grid; only the brightest tail becomes a speck, which
        # is what keeps them sparse rather than a dusting over everything.
        spec = noise01((xs // 3).astype(np.int64), (ys // 3).astype(np.int64), step, salt=11)
        cutoff = np.float32(1.0 - density * 0.02)
        hit = smoothstep(float(cutoff), 1.0, spec)[..., None]
        # Dust reads BOTH ways on a print — opaque specks and clear pinholes.
        polarity = noise01((xs // 3).astype(np.int64), (ys // 3).astype(np.int64), step, salt=12)
        bright = (polarity > np.float32(0.5))[..., None]
        out = np.where(bright, out + hit, out * (np.float32(1.0) - hit))

    if scratch_amount > 0.0:
        # One noise value per COLUMN, so a scratch is a full-height line.
        cols = noise01((xs // 2).astype(np.int64), np.zeros_like(ys), step // 3, salt=13)
        cutoff = np.float32(1.0 - scratch_amount * 0.01)
        line = smoothstep(float(cutoff), 1.0, cols)[..., None]
        out = out + line * np.float32(0.35)

    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(out)


# ---------------------------------------------------------------------------
# Analog / tape
# ---------------------------------------------------------------------------


@register("scanlines")
def scanlines(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Interlaced phosphor lines with an optional vertical roll."""
    count = max(1.0, ctx.param("count"))
    strength = np.float32(ctx.param("strength"))
    roll = ctx.param("roll")
    speed = ctx.param("speed")

    ys, _xs = coord_grid(ctx.height, ctx.width)
    drift = ctx.local_time * speed * roll * count * 0.25
    phase = (ys.astype(np.float32) / np.float32(ctx.height) * np.float32(count)) + np.float32(drift)
    # A raised cosine rather than alternating rows: it survives downscaling without
    # aliasing into moiré, and it matches what the shader's smooth function does.
    line = (np.float32(0.5) + np.float32(0.5) * np.cos(phase * np.float32(2.0 * np.pi))).astype(
        np.float32
    )
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(frame * (np.float32(1.0) - strength * line[..., None]))


@register("analog-vhs")
def analog_vhs(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Tracking error, chroma bleed, tape noise and line jitter together."""
    tracking = ctx.param("tracking")
    chroma = np.float32(ctx.param("chroma"))
    noise_amount = np.float32(ctx.param("noise"))
    jitter = ctx.param("jitter")
    step = _noise_frame(ctx, ctx.param("speed") * 12.0)

    ys, xs = coord_grid(ctx.height, ctx.width)
    fys, fxs = ys.astype(np.float32), xs.astype(np.float32)

    # 1. Per-line horizontal jitter — the single most recognisable VHS trait.
    line_noise = value_noise01(np.zeros_like(xs), ys, step, 3.0, salt=21) - np.float32(0.5)
    offset = line_noise * np.float32(jitter) * np.float32(0.05) * np.float32(ctx.width)

    # 2. Tracking band: a horizontal region that tears sideways, drifting upward.
    band_centre = np.float32((ctx.local_time * 0.35) % 1.3 - 0.15)
    band = np.exp(
        -np.square((fys / np.float32(ctx.height) - band_centre) * np.float32(22.0))
    ).astype(np.float32)
    offset = offset + band * np.float32(tracking) * np.float32(0.12) * np.float32(ctx.width)

    warped = sample_bilinear(frame, fys, fxs + offset)

    # 3. Chroma bleed: colour smears right of luma because the chroma channel was
    # recorded at a fraction of luma bandwidth.
    bleed_px = chroma * np.float32(0.012) * np.float32(ctx.width)
    bled = sample_bilinear(warped, fys, fxs - bleed_px)
    out = np.stack(
        [
            warped[..., 0] + (bled[..., 0] - warped[..., 0]) * chroma,
            warped[..., 1],
            warped[..., 2] + (bled[..., 2] - warped[..., 2]) * chroma,
        ],
        axis=-1,
    )

    # 4. Tape noise, concentrated in the darks where the signal-to-noise was worst.
    n = noise01(xs, ys, step, salt=22) - np.float32(0.5)
    dark_weight = (np.float32(1.0) - luminance(out)).clip(0.2, 1.0)
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(out + (n * dark_weight * noise_amount * np.float32(0.35))[..., None])


@register("tape-dropout")
def tape_dropout(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Horizontal streaks where the tape briefly loses signal."""
    density = ctx.param("density")
    length = ctx.param("length")
    step = _noise_frame(ctx, ctx.param("speed") * 10.0)

    ys, xs = coord_grid(ctx.height, ctx.width)
    # One value per scanline decides whether that line drops out at all.
    line = noise01(np.zeros_like(ys), ys, step, salt=31)
    # ~4.5% of scanlines drop out at the default density. The first scaling tried
    # here (density * 0.06) was so sparse the effect fired on zero lines of a
    # short frame — visibly nothing, which a smoke test caught as a no-op.
    cutoff = np.float32(1.0 - density * 0.15)
    hit = smoothstep(float(cutoff), 1.0, line)

    # Where it drops, the streak starts at a per-line random x and runs right.
    start = noise01(np.zeros_like(ys), ys, step, salt=32)
    u = xs.astype(np.float32) / np.float32(ctx.width)
    span = np.float32(0.05) + np.float32(length) * np.float32(0.5)
    inside = smoothstep(0.0, 0.02, u - start) * (
        np.float32(1.0) - smoothstep(float(span) - 0.05, float(span), u - start)
    )
    streak = (hit * inside)[..., None]

    # Dropout goes bright white on real tape (the head reads full-scale noise),
    # desaturating as it goes.
    luma = luminance(frame)[..., None]
    return np.asarray(frame + (np.float32(0.85) + luma * np.float32(0.15) - frame) * streak)


# ---------------------------------------------------------------------------
# Digital corruption
# ---------------------------------------------------------------------------


@register("glitch-block")
def glitch_block(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Rectangular regions tear sideways out of position."""
    density = ctx.param("density")
    size = ctx.param("size")
    displace = ctx.param("displace")
    step = _noise_frame(ctx, ctx.param("speed") * 14.0)

    block_h = max(2, round((0.02 + size * 0.14) * ctx.height))
    ys, xs = coord_grid(ctx.height, ctx.width)
    rows = (ys // block_h).astype(np.int64)

    # One decision + one displacement per block row.
    pick = noise01(np.zeros_like(rows), rows, step, salt=41)
    cutoff = np.float32(1.0 - density * 0.45)
    active = (pick > cutoff).astype(np.float32)
    amount = (noise01(np.zeros_like(rows), rows, step, salt=42) - np.float32(0.5)) * np.float32(2.0)
    offset = active * amount * np.float32(displace) * np.float32(0.25) * np.float32(ctx.width)

    torn = sample_bilinear(frame, ys.astype(np.float32), xs.astype(np.float32) + offset)

    # Displaced blocks also lose colour registration, which is what makes the tear
    # read as digital corruption rather than a pan.
    shift = active * np.float32(displace) * np.float32(0.01) * np.float32(ctx.width)
    reg = sample_bilinear(torn, ys.astype(np.float32), xs.astype(np.float32) + shift)
    return np.stack([reg[..., 0], torn[..., 1], torn[..., 2]], axis=-1)


@register("datamosh")
def datamosh(frame: np.ndarray, ctx: EffectContext) -> np.ndarray:
    """Compression-style blocks smeared forward, as when P-frames lose their key.

    A real datamosh needs the previous frame, which a stateless pass cannot hold —
    and holding state would make the render order-dependent (and un-seekable).
    This instead smears each macroblock along its own pseudo-motion vector, which
    is the visual signature without the statefulness.
    """
    strength = ctx.param("strength")
    block_size = ctx.param("blockSize")
    step = _noise_frame(ctx, ctx.param("speed") * 6.0)
    if strength <= 0.0:
        # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
        return np.asarray(frame)

    block = max(4, round((0.02 + block_size * 0.08) * max(ctx.width, ctx.height)))
    ys, xs = coord_grid(ctx.height, ctx.width)
    by = (ys // block).astype(np.int64)
    bx = (xs // block).astype(np.int64)

    # A per-block "motion vector", stable for the block's whole area.
    vx = (noise01(bx, by, step, salt=51) - np.float32(0.5)) * np.float32(2.0)
    vy = (noise01(bx, by, step, salt=52) - np.float32(0.5)) * np.float32(2.0)
    reach = np.float32(strength) * np.float32(block)

    taps = 5
    total = np.zeros_like(frame)
    for i in range(taps):
        f = (i / (taps - 1.0)) * reach
        total += sample_bilinear(
            frame, ys.astype(np.float32) + vy * f, xs.astype(np.float32) + vx * f
        )
    smeared = total / np.float32(taps)
    return np.asarray(frame + (smeared - frame) * np.float32(strength))
