"""Pixel rules for a ``matte`` mask layer (BR2.2, plan 04): edge shift, clean levels, distance
feather, decontamination, and mapping the source-resolution matte onto the clip's frame.

WHY a separate module: :mod:`framepilot_engine.render.mask_stack` evaluates geometry; a matte is
a raster, and its rules are raster rules. They follow the same determinism rules as the shape
rasteriser (:mod:`framepilot_engine.render.mask_raster`) so the preview (BR5) can reproduce them
exactly:

* morphology runs on the stored INTEGER matte (``max``/``min`` are exact and commutative);
* distances are integer squared distances (exact), square-rooted once per pixel;
* the only integer accumulations are ``maximum.accumulate``/``minimum.accumulate`` over
  indices; float work is elementwise and written in the order a twin must evaluate it
  (``a + (b - a) * t``).

The order a layer is evaluated in, all in SOURCE pixels of the artifact, then mapped to the
clip's frame (docs/api/timeline-schema.md, "Matte masks"):

1. alpha = stored value / format maximum;
2. ``edgeShiftPx`` (positive grows, negative shrinks): grey-scale dilation or erosion by a
   disc of the integer radii either side of ``|r|``, mixed linearly by the fraction;
3. clean black / clean white levels (``edgeMode: 'sharp'`` supplies 0.25 / 0.75 unless the
   finesse group sets its own);
4. base ``expansionPx`` / feathers: when any is non-zero, the matte's 50 % contour is redrawn
   with the distance-feather formula of the shape rasteriser;
5. crop (MoviePy's integer crop) and bilinear resample to the clip's frame;
6. the base layer rules (invert, opacity, combine mode) in the stack, as for every kind.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import numpy.typing as npt

from framepilot_engine.render.mask_raster import FloatArray, apply_falloff

#: ``edgeMode: 'sharp'`` as finesse clean levels: the soft band is compressed to the middle
#: half of its alpha range around the 50 % edge, which keeps the edge where the matte put it.
SHARP_CLEAN_BLACK = 0.25
SHARP_CLEAN_WHITE = 0.75

IntArray = npt.NDArray[np.int64]


# --- Edge shift ---------------------------------------------------------------------------


def _clamped_index(n: int, offset: int) -> IntArray:
    return np.clip(np.arange(n, dtype=np.int64) + offset, 0, n - 1)


def _disc_morphology(values: npt.NDArray[Any], radius: int, grow: bool) -> npt.NDArray[Any]:
    """Grey dilation (``grow``) or erosion by the disc ``dx*dx + dy*dy <= radius*radius``.

    Out-of-frame pixels replicate the nearest edge pixel, so a subject touching the frame edge
    keeps touching it. Row windows are built incrementally (``H_w`` from ``H_(w-1)``), and each
    row offset ``dy`` takes the window half-width ``isqrt(r*r - dy*dy)``, so only one window is
    held at a time.
    """
    if radius <= 0:
        return values
    height, width = values.shape
    pick = np.maximum if grow else np.minimum
    by_width: dict[int, list[int]] = {}
    for dy in range(-radius, radius + 1):
        by_width.setdefault(math.isqrt(radius * radius - dy * dy), []).append(dy)
    result = values.copy()
    window = values
    left, right = _clamped_index(width, -1), _clamped_index(width, 1)
    for half in range(radius + 1):
        if half > 0:
            window = pick(pick(window[:, left], window), window[:, right])
        for dy in by_width.get(half, []):
            result = pick(result, window[_clamped_index(height, dy), :])
    return result


def edge_shift(alpha_int: npt.NDArray[Any], maximum: int, shift_px: float) -> FloatArray:
    """The matte as float alpha after shifting its edge by ``shift_px`` source pixels."""
    magnitude = abs(float(shift_px))
    low = math.floor(magnitude)
    high = math.ceil(magnitude)
    grow = shift_px > 0
    scale = float(maximum)
    low_alpha = _disc_morphology(alpha_int, low, grow).astype(np.float64) / scale
    if high == low:
        return low_alpha
    high_alpha = _disc_morphology(alpha_int, high, grow).astype(np.float64) / scale
    fraction = magnitude - float(low)
    return low_alpha + (high_alpha - low_alpha) * fraction


# --- Clean levels -------------------------------------------------------------------------


def clean_levels(mask: Any) -> tuple[float, float]:
    """The effective ``(clean black, clean white)`` of a matte: finesse, else its edge mode."""
    finesse = mask.finesse
    black, white = float(finesse.clean_black), float(finesse.clean_white)
    if black == 0.0 and white == 1.0 and str(mask.edge_mode) == "sharp":
        return SHARP_CLEAN_BLACK, SHARP_CLEAN_WHITE
    return black, white


def apply_clean_levels(alpha: FloatArray, black: float, white: float) -> FloatArray:
    """``(a - black) / (white - black)`` clamped to ``[0, 1]``; a threshold when they meet."""
    if black == 0.0 and white == 1.0:
        return alpha
    if white <= black:
        return (alpha >= black).astype(np.float64)
    scaled = (alpha - black) / (white - black)
    return np.minimum(np.maximum(scaled, 0.0), 1.0)


# --- Distance feather ---------------------------------------------------------------------


def _row_distance(features: npt.NDArray[np.bool_], cap: int) -> IntArray:
    """Per pixel, the column distance to the nearest feature pixel in its row, capped."""
    width = features.shape[1]
    columns = np.arange(width, dtype=np.int64)
    far = np.int64(width + cap + 1)
    before = np.maximum.accumulate(np.where(features, columns, -far), axis=1)
    after = np.minimum.accumulate(np.where(features, columns, width + far)[:, ::-1], axis=1)[
        :, ::-1
    ]
    return np.minimum(np.minimum(columns - before, after - columns), cap)


def _bounded_distance(features: npt.NDArray[np.bool_], cap: int) -> FloatArray:
    """Euclidean distance from each pixel centre to the nearest feature centre, capped at ``cap``.

    Exact up to the cap: the squared distance is the minimum over row offsets ``dy`` of
    ``row_distance(y + dy)**2 + dy**2`` in integers; rows outside the frame hold no feature.
    """
    height = features.shape[0]
    row = _row_distance(features, cap)
    squared = row * row
    best = squared.copy()
    capped = np.int64(cap * cap)
    for dy in range(1, cap + 1):
        extra = np.int64(dy * dy)
        if dy < height:
            below = np.full_like(squared, capped)
            below[: height - dy] = squared[dy:] + extra
            above = np.full_like(squared, capped)
            above[dy:] = squared[: height - dy] + extra
            best = np.minimum(best, np.minimum(below, above))
    distance: FloatArray = np.sqrt(np.minimum(best, capped).astype(np.float64))
    return distance


def distance_feather(
    alpha: FloatArray,
    *,
    expansion: float,
    feather_inner: float,
    feather_outer: float,
    falloff: str,
) -> FloatArray:
    """Redraw the matte's 50 % contour with the shape rasteriser's distance-feather formula.

    Inside is ``alpha >= 0.5``. The signed distance of a pixel centre to the contour is half a
    pixel less than the distance to the nearest centre on the other side (positive outside).
    Then, as :func:`framepilot_engine.render.mask_raster.distance_alpha`, with
    ``s = d - expansion``: ``x = (w_o - s) / (w_i + w_o)`` clamped (or ``0.5 - s`` when both
    feathers are zero) and ``alpha = falloff(x)``.
    """
    if expansion == 0.0 and feather_inner == 0.0 and feather_outer == 0.0:
        return alpha
    inside = alpha >= 0.5
    widest = max(feather_outer + expansion, feather_inner - expansion, 0.0)
    cap = math.ceil(widest) + 2
    to_inside = _bounded_distance(inside, cap)
    to_outside = _bounded_distance(~inside, cap)
    signed = np.where(inside, 0.5 - to_outside, to_inside - 0.5)
    shifted = signed - expansion
    total = feather_inner + feather_outer
    x = 0.5 - shifted if total <= 0.0 else (feather_outer - shifted) / total
    clamped = np.minimum(np.maximum(x, 0.0), 1.0)
    return apply_falloff(clamped, falloff)


# --- Onto the clip's frame ----------------------------------------------------------------


def _crop_slices(clip: Any, width: int, height: int) -> tuple[slice, slice]:
    """MoviePy's ``vfx.Crop`` on fractions of the frame: ``int()`` of each edge."""
    crop = getattr(clip, "crop", None)
    if crop is None:
        return slice(0, height), slice(0, width)
    x1, y1 = int(crop.x * width), int(crop.y * height)
    x2, y2 = int((crop.x + crop.width) * width), int((crop.y + crop.height) * height)
    return slice(y1, y2), slice(x1, x2)


def _resize_axis(values: FloatArray, size: int, axis: int) -> FloatArray:
    """Bilinear resample along one axis, pixel centres aligned, edges clamped."""
    source = values.shape[axis]
    if source == size:
        return values
    positions = (np.arange(size, dtype=np.float64) + 0.5) * (source / size) - 0.5
    positions = np.minimum(np.maximum(positions, 0.0), float(source - 1))
    low = np.floor(positions).astype(np.int64)
    high = np.minimum(low + 1, source - 1)
    fraction = positions - low.astype(np.float64)
    shape = [1] * values.ndim
    shape[axis] = size
    weight = fraction.reshape(shape)
    first = np.take(values, low, axis=axis)
    second = np.take(values, high, axis=axis)
    resampled: FloatArray = first + (second - first) * weight
    return resampled


def to_frame(values: FloatArray, clip: Any, width: int, height: int) -> FloatArray:
    """A source-resolution plane (2-D or channels last), cropped as the clip, sized to the frame."""
    rows, cols = _crop_slices(clip, values.shape[1], values.shape[0])
    cropped = values[rows, cols]
    return _resize_axis(_resize_axis(cropped, height, 0), width, 1)


def decontaminate(
    picture: npt.NDArray[Any],
    alpha_int: npt.NDArray[Any],
    maximum: int,
    foreground: npt.NDArray[np.uint8],
    clip: Any,
) -> npt.NDArray[np.uint8]:
    """Replace the picture's colour inside the matte's soft band with the foreground estimate.

    The band is every source pixel with ``0 < alpha < maximum`` (the pack stores foreground
    colour only there). Band weight and band-premultiplied colour are mapped to the frame
    separately, so a resample never mixes the zeros outside the band into an edge colour:
    ``out = picture + (foreground_premultiplied - picture * band)``.
    """
    height, width = picture.shape[:2]
    band = ((alpha_int > 0) & (alpha_int < maximum)).astype(np.float64)
    premultiplied = foreground.astype(np.float64) * band[:, :, None]
    weight = to_frame(band, clip, width, height)
    colour = to_frame(premultiplied, clip, width, height)
    base = picture.astype(np.float64)
    mixed = base + (colour - base * weight[:, :, None])
    return np.clip(np.rint(mixed), 0, 255).astype(np.uint8)
