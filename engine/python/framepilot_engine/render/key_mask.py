"""The ``key`` mask kind: a deterministic colour/luma qualifier (MK6.1, plan 10).

WHAT IT IS: a chroma key and a secondary-grade qualifier are the same tool — a rule that reads a
pixel's colour and says how much it matches. No model, no artifact, no per-frame job: the same
input RGB always gives the same alpha, which is why it can be a mask kind rather than a pack.

WHICH WAY IT POINTS: the alpha is **how much the pixel matches**, like every other kind's alpha is
"inside the shape". A green screen is therefore keyed by selecting the green and setting the
mask's ``invert``, exactly as a shape cut-out is inverted; nothing about the key is special-cased
in the stack.

FOUR MODELS, ONE CODE PATH: ``hsl``, ``rgb`` and ``luma`` are lists of per-channel ranges, and the
model only says which channels are meaningful (the validator enforces that). ``3d`` is a tolerance
sphere around sampled colours — the eyedropper's model, for colours no axis-aligned range
describes. All of them multiply their terms, so a qualifier is an intersection.

PARITY: the preview runs this as a shader (``preview/effects/glsl-passes.ts`` → the mask key pass)
on the RGB the decode produced with the engine's own colour matrix (PX2.7), so both sides read the
same numbers. The gate is engine vs preview keyed alpha within 1/255 on colour charts in
BT.601/709, full and limited range (plan 06). To make that reachable in a fragment shader, every
formula here is a polynomial in float32-representable steps — no table lookups, no ``exp``, no
``pow`` — and the softness curve is the smoothstep both languages spell the same way. That is a
deliberate difference from the shape rasteriser, which is byte-identical because it can be.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

from framepilot_engine.render.mask_raster import FloatArray

_log = logging.getLogger(__name__)

#: Rec. 709 luma, the same coefficients the effect passes use (``frame_effects`` REC709).
LUMA_COEFFICIENTS = (0.2126, 0.7152, 0.0722)

#: Channels a range can qualify on. ``hue`` is circular; the rest are plain ``[0, 1]`` values.
CHANNELS = frozenset({"hue", "saturation", "luma", "red", "green", "blue"})


def to_unit_rgb(picture: np.ndarray) -> FloatArray:
    """The picture as float64 RGB in ``[0, 1]``; ``uint8`` is divided by 255 exactly."""
    array = np.asarray(picture)
    if array.dtype == np.uint8:
        return array.astype(np.float64) / 255.0
    return np.clip(array.astype(np.float64), 0.0, 1.0)


def smoothstep(x: FloatArray) -> FloatArray:
    """``x * x * (3 - 2x)`` on an already-clamped ``x``; the one softness curve both sides use."""
    return (x * x) * (3.0 - 2.0 * x)


def luma_of(rgb: FloatArray) -> FloatArray:
    """Rec. 709 luma, accumulated left to right so the twin can evaluate it in the same order."""
    red, green, blue = LUMA_COEFFICIENTS
    value: FloatArray = rgb[:, :, 0] * red + rgb[:, :, 1] * green + rgb[:, :, 2] * blue
    return value


def hue_of(rgb: FloatArray, maximum: FloatArray, span: FloatArray) -> FloatArray:
    """Hue in ``[0, 1)`` from the standard six-sector formula; a grey pixel is hue 0."""
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    safe = np.where(span > 0.0, span, 1.0)
    from_red = ((green - blue) / safe) % 6.0
    from_green = (blue - red) / safe + 2.0
    from_blue = (red - green) / safe + 4.0
    sector = np.where(maximum == red, from_red, np.where(maximum == green, from_green, from_blue))
    hue: FloatArray = np.where(span > 0.0, sector / 6.0, 0.0)
    return hue


def channel_values(rgb: FloatArray) -> dict[str, FloatArray]:
    """Every channel a range can qualify on, computed once per frame.

    ``saturation`` is the HSV one (``span / max``), not the HSL one: a keyer asks "how far from
    grey is this pixel", and the HSL definition sends that towards 1 for near-white pixels, which
    pulls highlights into a qualifier that was aimed at a saturated backing.
    """
    maximum = np.maximum(np.maximum(rgb[:, :, 0], rgb[:, :, 1]), rgb[:, :, 2])
    minimum = np.minimum(np.minimum(rgb[:, :, 0], rgb[:, :, 1]), rgb[:, :, 2])
    span = maximum - minimum
    saturation = np.where(maximum > 0.0, span / np.where(maximum > 0.0, maximum, 1.0), 0.0)
    return {
        "hue": hue_of(rgb, maximum, span),
        "saturation": saturation,
        "luma": luma_of(rgb),
        "red": rgb[:, :, 0],
        "green": rgb[:, :, 1],
        "blue": rgb[:, :, 2],
    }


def _linear_distance(value: FloatArray, low: float, high: float) -> FloatArray:
    """How far ``value`` sits outside ``[low, high]``; 0 inside."""
    below = low - value
    above = value - high
    outside: FloatArray = np.maximum(np.maximum(below, above), 0.0)
    return outside


def _circular_distance(value: FloatArray, low: float, high: float) -> FloatArray:
    """The same for hue, where the axis wraps at 1 and ``low > high`` means a wrapping arc."""
    if low <= high:
        below = (low - value) % 1.0
        above = (value - high) % 1.0
        inside = (value >= low) & (value <= high)
    else:
        below = (low - value) % 1.0
        above = (value - high) % 1.0
        inside = (value >= low) | (value <= high)
    outside: FloatArray = np.where(inside, 0.0, np.minimum(below, above))
    return outside


def range_membership(
    value: FloatArray, low: float, high: float, softness: float, *, circular: bool
) -> FloatArray:
    """One range's term: 1 inside, 0 beyond the softness band, smoothstep across it."""
    distance = (
        _circular_distance(value, low, high) if circular else _linear_distance(value, low, high)
    )
    if softness <= 0.0:
        inside: FloatArray = (distance <= 0.0).astype(np.float64)
        return inside
    ramp = np.clip(1.0 - distance / softness, 0.0, 1.0)
    return smoothstep(ramp)


def qualifier(mask: Any, channels: dict[str, FloatArray]) -> FloatArray:
    """The ranges' intersection: every range multiplies in, in the order they are stored.

    A key with no ranges qualifies nothing (0), not everything: an empty qualifier is a mask the
    editor has not finished, and showing the whole frame as "matched" would hide that.
    """
    ranges = list(mask.ranges or [])
    if not ranges:
        shape = channels["luma"].shape
        return np.zeros(shape, dtype=np.float64)
    extra = max(float(mask.softness), 0.0)
    result: FloatArray | None = None
    for entry in ranges:
        channel = str(entry.channel.value if hasattr(entry.channel, "value") else entry.channel)
        value = channels[channel]
        softness = max(float(entry.softness), 0.0) + extra
        # Hue always measures on the circle; the rest are plain [0, 1] axes, where a stored
        # low > high is an empty range rather than a wrap.
        term = range_membership(
            value, float(entry.low), float(entry.high), softness, circular=channel == "hue"
        )
        result = term if result is None else result * term
    assert result is not None
    return result


def sample_qualifier(mask: Any, rgb: FloatArray) -> FloatArray:
    """The ``3d`` model: a tolerance sphere per sampled colour, with a soft shell of equal width.

    The samples are unioned with ``max`` (a pixel near any sample is matched), which is what an
    eyedropper that adds colours has to mean.
    """
    samples = list(mask.samples3d or [])
    if not samples:
        return np.zeros(rgb.shape[:2], dtype=np.float64)
    tolerance = max(float(mask.softness), 0.0)
    best: FloatArray | None = None
    for sample in samples:
        dr = rgb[:, :, 0] - float(sample[0])
        dg = rgb[:, :, 1] - float(sample[1])
        db = rgb[:, :, 2] - float(sample[2])
        distance = np.sqrt(dr * dr + dg * dg + db * db)
        if tolerance <= 0.0:
            term: FloatArray = (distance <= 0.0).astype(np.float64)
        else:
            ramp = np.clip(2.0 - distance / tolerance, 0.0, 1.0)
            term = smoothstep(ramp)
        best = term if best is None else np.maximum(best, term)
    assert best is not None
    return best


def apply_shadow_retention(matched: FloatArray, luma: FloatArray, retention: float) -> FloatArray:
    """Pull dark pixels back out of the key so a shadow on the backing survives.

    ``retention`` is the luma below which a pixel is protected: at 0 nothing changes, at 0.2 a
    pixel darker than 0.2 is excluded from the key in proportion to how dark it is. Without this
    a chroma key eats the shadows an actor casts on the screen, which is the whole reason a
    professional keyer has the control.
    """
    if retention <= 0.0:
        return matched
    ramp = np.clip(luma / retention, 0.0, 1.0)
    return matched * smoothstep(ramp)


def key_alpha(mask: Any, picture: np.ndarray) -> FloatArray:
    """How much each pixel of ``picture`` matches the key, before invert, opacity and finesse.

    :param mask: A ``key`` mask layer.
    :param picture: RGB, ``uint8`` or float in ``[0, 1]``, shape ``(H, W, 3)``.
    """
    rgb = to_unit_rgb(picture)
    model = str(mask.model.value if hasattr(mask.model, "value") else mask.model)
    if model == "3d":
        matched = sample_qualifier(mask, rgb)
        luma = luma_of(rgb)
    else:
        channels = channel_values(rgb)
        matched = qualifier(mask, channels)
        luma = channels["luma"]
    matched = apply_shadow_retention(matched, luma, max(float(mask.shadow_retention), 0.0))
    _log.debug("key mask %s: model %s, matched mean %.4f", mask.id, model, float(matched.mean()))
    return np.clip(matched, 0.0, 1.0)


# --- Despill ------------------------------------------------------------------------------


def despill(picture: np.ndarray, colour: str) -> np.ndarray:
    """Pull a green or blue cast out of the picture, returning the input's dtype.

    The rule is the standard limiter: a pixel's backing channel is capped at the average of the
    other two, so a pixel that is genuinely green keeps its green and a pixel that is only
    spilling loses it. ``strength`` is deliberately absent — a limiter that only half-applies
    leaves a visible fringe, and the mask's own edge controls are where softness belongs.
    """
    if colour not in ("green", "blue"):
        return picture
    rgb = to_unit_rgb(picture)
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    if colour == "green":
        limit = (red + blue) / 2.0
        result = np.stack([red, np.minimum(green, limit), blue], axis=-1)
    else:
        limit = (red + green) / 2.0
        result = np.stack([red, green, np.minimum(blue, limit)], axis=-1)
    if np.asarray(picture).dtype == np.uint8:
        return np.clip(np.rint(result * 255.0), 0, 255).astype(np.uint8)
    return result.astype(np.asarray(picture).dtype)
