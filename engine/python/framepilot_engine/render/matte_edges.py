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
5. resample to the size the picture was decoded at (swscale's bicubic geometry, B = 0,
   C = 0.6), then MoviePy's integer crop, as the picture itself went;
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


#: ffmpeg's default scaler for the export's decode (MoviePy passes ``-sws_flags bicubic``):
#: swscale's SWS_BICUBIC is the Mitchell-Netravali cubic with B = 0 and C = 0.6.
BICUBIC_B = 0.0
BICUBIC_C = 0.6


def _cubic_weight(x: FloatArray) -> FloatArray:
    """The B/C cubic at ``x`` (elementwise polynomials, Horner order, no ``pow``)."""
    ax = np.abs(x)
    b, c = BICUBIC_B, BICUBIC_C
    near = (
        ((12.0 - 9.0 * b - 6.0 * c) * ax + (-18.0 + 12.0 * b + 6.0 * c)) * ax * ax + (6.0 - 2.0 * b)
    ) / 6.0
    far = (
        (((-b - 6.0 * c) * ax + (6.0 * b + 30.0 * c)) * ax + (-12.0 * b - 48.0 * c)) * ax
        + (8.0 * b + 24.0 * c)
    ) / 6.0
    weight: FloatArray = np.where(ax < 1.0, near, np.where(ax < 2.0, far, 0.0))
    return weight


def resample_taps(source: int, size: int) -> tuple[npt.NDArray[np.int64], FloatArray]:
    """Per output index, the source indices and normalised weights of the bicubic filter.

    Geometry is swscale's: output pixel ``i`` centres on source ``(i + 0.5) * s - 0.5`` with
    ``s = source / size``; a downscale stretches the kernel by ``s`` (so it averages every source
    pixel it covers), an upscale does not. Indices clamp to the edge. Weights are divided by
    their sum, accumulated tap by tap in index order (no floating reduction).

    :returns: ``(indices, weights)``, both ``(size, taps)``.
    """
    scale = source / size
    stretch = max(scale, 1.0)
    taps = 2 * math.ceil(2.0 * stretch)
    centres = (np.arange(size, dtype=np.float64) + 0.5) * scale - 0.5
    first = np.floor(centres - 2.0 * stretch).astype(np.int64) + 1
    offsets = np.arange(taps, dtype=np.int64)
    positions = first[:, None] + offsets[None, :]
    weights = _cubic_weight((positions.astype(np.float64) - centres[:, None]) / stretch)
    total = weights[:, 0].copy()
    for tap in range(1, taps):
        total = total + weights[:, tap]
    normalised: FloatArray = weights / total[:, None]
    return np.clip(positions, 0, source - 1), normalised


def _resample_axis(values: FloatArray, size: int, axis: int, ceiling: float) -> FloatArray:
    """Bicubic resample along one axis (:func:`resample_taps`), clamped to ``[0, ceiling]``."""
    source = values.shape[axis]
    if source == size:
        return values
    indices, weights = resample_taps(source, size)
    moved = np.moveaxis(values, axis, 0)
    shape = (size,) + (1,) * (moved.ndim - 1)
    result = moved[indices[:, 0]] * weights[:, 0].reshape(shape)
    for tap in range(1, indices.shape[1]):
        result = result + moved[indices[:, tap]] * weights[:, tap].reshape(shape)
    clamped: FloatArray = np.moveaxis(np.minimum(np.maximum(result, 0.0), ceiling), 0, axis)
    return clamped


def resample(values: FloatArray, width: int, height: int, ceiling: float) -> FloatArray:
    """Bicubic resample of a plane (2-D or channels last) to ``width`` x ``height``: rows first
    (horizontal pass), then columns, as swscale filters."""
    horizontal = _resample_axis(values, width, 1, ceiling)
    return _resample_axis(horizontal, height, 0, ceiling)


def to_frame(
    values: FloatArray,
    clip: Any,
    width: int,
    height: int,
    decoded_size: tuple[int, int] | None = None,
    ceiling: float = 1.0,
) -> FloatArray:
    """A display-space artifact plane, taken through the picture's own path onto its frame.

    The picture is decoded (scaled by ffmpeg) to ``decoded_size`` and then cropped; the plane is
    resampled to the same size with the same filter geometry (:func:`resample`) and cropped by
    the same integer slices, so each value lands on the picture pixel it describes. A plane is
    only resampled again if the crop still disagrees with the frame (never for the export).

    :param decoded_size: ``(width, height)`` the source was decoded at; ``None`` = the plane's.
    :param ceiling: Upper clamp after resampling (1 for alpha, 255 for colour).
    """
    full_w, full_h = (
        decoded_size if decoded_size is not None else (values.shape[1], values.shape[0])
    )
    decoded = resample(values, full_w, full_h, ceiling)
    rows, cols = _crop_slices(clip, full_w, full_h)
    cropped = decoded[rows, cols]
    return resample(cropped, width, height, ceiling)


def decontaminate_dense(
    picture: npt.NDArray[Any],
    alpha_int: npt.NDArray[Any],
    maximum: int,
    foreground: npt.NDArray[np.uint8],
    clip: Any,
    decoded_size: tuple[int, int] | None = None,
) -> npt.NDArray[np.uint8]:
    """:func:`decontaminate` computed over every pixel of the frame: the definition.

    Kept as the reference the fast path is tested against byte for byte
    (``tests/test_matte_decontaminate_exact.py``), and used for a picture that is not ``uint8``.
    """
    height, width = picture.shape[:2]
    band = ((alpha_int > 0) & (alpha_int < maximum)).astype(np.float64)
    premultiplied = foreground.astype(np.float64) * band[:, :, None]
    weight = to_frame(band, clip, width, height, decoded_size)
    colour = to_frame(premultiplied, clip, width, height, decoded_size, ceiling=255.0)
    base = picture.astype(np.float64)
    mixed = base + (colour - base * weight[:, :, None])
    return np.clip(np.rint(mixed), 0, 255).astype(np.uint8)


def _bounds(active: npt.NDArray[np.bool_]) -> tuple[slice, slice] | None:
    """The smallest row/column box holding every true cell, ``None`` when there is none."""
    rows = np.flatnonzero(active.any(axis=1))
    if rows.size == 0:
        return None
    cols = np.flatnonzero(active.any(axis=0))
    return slice(int(rows[0]), int(rows[-1]) + 1), slice(int(cols[0]), int(cols[-1]) + 1)


def _mix(
    picture: npt.NDArray[np.uint8],
    weight: FloatArray,
    colour: FloatArray,
    box: tuple[slice, slice],
) -> npt.NDArray[np.uint8]:
    """``picture`` with the definition's arithmetic applied inside ``box`` only."""
    out = picture.copy()
    base = picture[box].astype(np.float64)
    mixed = base + (colour - base * weight[:, :, None])
    out[box] = np.clip(np.rint(mixed), 0, 255).astype(np.uint8)
    return out


def decontaminate(
    picture: npt.NDArray[Any],
    alpha_int: npt.NDArray[Any],
    maximum: int,
    foreground: npt.NDArray[np.uint8],
    clip: Any,
    decoded_size: tuple[int, int] | None = None,
) -> npt.NDArray[np.uint8]:
    """Replace the picture's colour inside the matte's soft band with the foreground estimate.

    The band is every source pixel with ``0 < alpha < maximum`` (the pack stores foreground
    colour only there). Band weight and band-premultiplied colour are mapped to the frame
    separately, so a resample never mixes the zeros outside the band into an edge colour:
    ``out = picture + (foreground_premultiplied - picture * band)``.

    WHY this is not computed over the whole frame (PX5, ``PX5-BUDGETS.md``): the dense form
    (:func:`decontaminate_dense`) builds four frame-sized float64 arrays per frame - 227 ms of a
    4K export frame, the largest part of what a matte cost. Where the band weight and colour are
    both zero the formula is ``picture + (0 - picture * 0)``, which is the picture exactly, and
    a ``uint8`` picture survives ``rint``/``clip``/``astype`` unchanged. So the arithmetic runs
    only inside the box that holds the band, and the bytes are the same:

    * no resample or crop between the artifact and the frame (the export at source size): the
      box is taken on the band itself, before anything is converted to float;
    * otherwise the planes are resampled as before (a resample reads neighbours, so its input
      is not cut) and the box is taken on the resampled weight and colour.
    """
    if picture.dtype != np.uint8:
        return decontaminate_dense(picture, alpha_int, maximum, foreground, clip, decoded_size)
    height, width = picture.shape[:2]
    in_band = (alpha_int > 0) & (alpha_int < maximum)
    source_h, source_w = in_band.shape
    full_w, full_h = decoded_size if decoded_size is not None else (source_w, source_h)
    rows, cols = _crop_slices(clip, full_w, full_h)
    untouched = (
        (full_w, full_h) == (source_w, source_h)
        and (rows, cols) == (slice(0, full_h), slice(0, full_w))
        and (width, height) == (source_w, source_h)
    )
    if untouched:
        box = _bounds(in_band)
        if box is None:
            return picture.copy()
        band = in_band[box].astype(np.float64)
        premultiplied = foreground[box].astype(np.float64) * band[:, :, None]
        return _mix(picture, band, premultiplied, box)
    band = in_band.astype(np.float64)
    premultiplied = foreground.astype(np.float64) * band[:, :, None]
    weight = to_frame(band, clip, width, height, decoded_size)
    colour = to_frame(premultiplied, clip, width, height, decoded_size, ceiling=255.0)
    box = _bounds((weight != 0.0) | (colour != 0.0).any(axis=2))
    if box is None:
        return picture.copy()
    return _mix(picture, weight[box], colour[box], box)


# --- The matte finesse group (MK6.2) ------------------------------------------------------
#
# One clean-up chain, shared by every kind whose alpha is a RASTER rather than a shape: `matte`
# (a delivered AI matte), `key` (a qualifier's output) and, when it ships, `layer`. A shape mask
# needs none of it — its edge is exact by construction — which is why the group lives on those
# kinds and not on `MaskLayerBase`.
#
# The order is the order a matte artist works in, and it is the order both twins evaluate:
#
#   1. denoise        soften isolated speckle before anything measures the edge;
#   2. clean black    crush the near-transparent haze to nothing;
#   3. clean white    lift the near-opaque haze to solid;
#   4. morph open     erode then dilate: removes specks OUTSIDE the subject;
#   5. morph close    dilate then erode: fills pinholes INSIDE it;
#   6. shrink/grow    move the whole edge in or out;
#   7. blur           soften what is left;
#   8. in/out ratio   move the 50% crossing of that softened edge.
#
# Denoising after the levels would re-introduce the haze they removed, and blurring before the
# morphology would smear the specks the morphology is there to delete — so the order is not a
# preference, it is what makes each control do what its name says.

#: Radius (px) beyond which the preview's key shader cannot run an op in one pass; the export
#: has no such limit, so the monitor refuses rather than drawing a different edge (MK6.2).
PREVIEW_MORPH_LIMIT_PX = 16.0


def denoise(alpha: FloatArray, amount: float) -> FloatArray:
    """Blend toward the 3x3 box mean by ``amount``; edges replicate, as morphology does.

    A box of exactly 3 is deliberate: the control is for speckle, and a wider kernel would move
    the edge, which is what shrink/grow and blur are for.
    """
    if amount <= 0.0:
        return alpha
    height, width = alpha.shape
    left, right = _clamped_index(width, -1), _clamped_index(width, 1)
    up, down = _clamped_index(height, -1), _clamped_index(height, 1)
    rows = alpha[:, left] + alpha + alpha[:, right]
    mean = (rows[up, :] + rows + rows[down, :]) / 9.0
    return alpha + (mean - alpha) * min(float(amount), 1.0)


def _morphology_at(alpha: FloatArray, radius: float, grow: bool) -> FloatArray:
    """Dilate (``grow``) or erode by a disc of ``radius``, mixing the two integer radii."""
    magnitude = abs(float(radius))
    if magnitude <= 0.0:
        return alpha
    low = math.floor(magnitude)
    high = math.ceil(magnitude)
    scaled = alpha * 1.0
    low_alpha: FloatArray = _disc_morphology(scaled, low, grow)
    if high == low:
        return low_alpha
    high_alpha: FloatArray = _disc_morphology(scaled, high, grow)
    mixed: FloatArray = low_alpha + (high_alpha - low_alpha) * (magnitude - float(low))
    return mixed


def morph_open(alpha: FloatArray, radius: float) -> FloatArray:
    """Erode then dilate: deletes specks smaller than the disc, outside the subject."""
    if radius <= 0.0:
        return alpha
    return _morphology_at(_morphology_at(alpha, radius, grow=False), radius, grow=True)


def morph_close(alpha: FloatArray, radius: float) -> FloatArray:
    """Dilate then erode: fills pinholes smaller than the disc, inside the subject."""
    if radius <= 0.0:
        return alpha
    return _morphology_at(_morphology_at(alpha, radius, grow=True), radius, grow=False)


def shrink_grow(alpha: FloatArray, pixels: float) -> FloatArray:
    """Move the whole edge out (+) or in (-) by a disc of ``pixels``."""
    if pixels == 0.0:
        return alpha
    return _morphology_at(alpha, abs(pixels), grow=pixels > 0.0)


def _box_pass(alpha: FloatArray, radius: int) -> FloatArray:
    """One separable box blur of integer ``radius``, edges replicating.

    Summed left to right along each axis, which is the accumulation order a twin must repeat.
    """
    if radius <= 0:
        return alpha
    height, width = alpha.shape
    horizontal = alpha.copy()
    for offset in range(1, radius + 1):
        horizontal = horizontal + alpha[:, _clamped_index(width, -offset)]
        horizontal = horizontal + alpha[:, _clamped_index(width, offset)]
    horizontal = horizontal / float(2 * radius + 1)
    vertical = horizontal.copy()
    for offset in range(1, radius + 1):
        vertical = vertical + horizontal[_clamped_index(height, -offset), :]
        vertical = vertical + horizontal[_clamped_index(height, offset), :]
    result: FloatArray = vertical / float(2 * radius + 1)
    return result


def blur(alpha: FloatArray, radius: float) -> FloatArray:
    """Three box passes, the standard cheap gaussian, as the effect passes approximate one.

    An exact gaussian would need a table and a normalisation both sides had to agree on to the
    last bit; three boxes of ``round(radius / 3)`` are integer-radius sums that agree by
    construction, and at these radii the shapes are indistinguishable.
    """
    if radius <= 0.0:
        return alpha
    box = max(1, round(float(radius) / 3.0))
    return _box_pass(_box_pass(_box_pass(alpha, box), box), box)


def in_out_ratio(alpha: FloatArray, ratio: float) -> FloatArray:
    """Move the 50% crossing of a soft edge out (+) or in (-), keeping 0 and 1 fixed.

    Two straight segments through a moved midpoint, so a fully transparent pixel stays
    transparent and a fully opaque one stays opaque: the control changes where the edge SITS,
    never how far it reaches.
    """
    if ratio == 0.0:
        return alpha
    clamped = min(1.0, max(-1.0, float(ratio)))
    mid = 0.5 - clamped * 0.5
    if mid <= 0.0:
        return np.where(alpha > 0.0, 1.0, 0.0)
    if mid >= 1.0:
        return np.where(alpha >= 1.0, 1.0, 0.0)
    below = alpha * 0.5 / mid
    above = 0.5 + (alpha - mid) * 0.5 / (1.0 - mid)
    result: FloatArray = np.where(alpha <= mid, below, above)
    return np.minimum(np.maximum(result, 0.0), 1.0)


def apply_finesse(alpha: FloatArray, finesse: Any, levels: tuple[float, float]) -> FloatArray:
    """The whole group in order, on an alpha already in ``[0, 1]``.

    :param finesse: The mask's ``MaskFinesse``.
    :param levels: The effective ``(clean black, clean white)`` — a matte's ``edgeMode`` can
        supply them, so the caller resolves them rather than reading the group twice.
    """
    result = denoise(alpha, float(finesse.denoise))
    result = apply_clean_levels(result, levels[0], levels[1])
    result = morph_open(result, float(finesse.morph_open_px))
    result = morph_close(result, float(finesse.morph_close_px))
    result = shrink_grow(result, float(finesse.shrink_grow_px))
    result = blur(result, float(finesse.blur_px))
    return in_out_ratio(result, float(finesse.in_out_ratio))


def finesse_is_identity(finesse: Any, levels: tuple[float, float]) -> bool:
    """Whether the group changes nothing, so a caller can skip the whole chain."""
    return (
        float(finesse.denoise) == 0.0
        and levels == (0.0, 1.0)
        and float(finesse.morph_open_px) == 0.0
        and float(finesse.morph_close_px) == 0.0
        and float(finesse.shrink_grow_px) == 0.0
        and float(finesse.blur_px) == 0.0
        and float(finesse.in_out_ratio) == 0.0
    )
