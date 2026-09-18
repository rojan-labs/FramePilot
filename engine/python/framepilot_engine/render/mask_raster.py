"""The exact, deterministic mask rasteriser (MK2.1, ADR 0178).

WHY this exists: a mask edge is judged at the pixel, and the export and the preview have to
agree on it byte for byte. Parity by tolerance is not enough, so both sides run THIS
algorithm: the Python engine here, and ``apps/web-editor/src/preview/masks/mask-raster.ts``
(MK3) against the vectors in ``tests/fixtures/mask-raster``. Every step is specified so it
can be reproduced in another language with plain indexed loops:

1. **Shapes are Beziers.** Rectangles (with corner roundness) and ellipses are generated as
   closed cubic Bezier paths first (:func:`rectangle_path`, :func:`ellipse_path`), so there
   is one path type.
2. **Flatten** each cubic segment by recursive midpoint subdivision until both control
   points lie within :data:`FLATTEN_TOLERANCE` (0.02 source px) of the chord, left half
   before right half, at most :data:`MAX_FLATTEN_DEPTH` levels (:func:`flatten_path`).
   Flattening happens in SOURCE units; the flattened points are then mapped to raster
   pixels (an affine map of a polyline is exact).
3. **Coverage** (zero feather, zero expansion): exact area coverage by signed-area
   accumulation, the font-rasteriser method, in Q16.16 integer area units
   (:func:`coverage_alpha`). Integer accumulation is exact, so its order cannot change the
   result; the integers become float64 once.
4. **Distance feather** (any feather or expansion): the exact Euclidean distance from each
   pixel centre in the feather band to the flattened segments, signed by the pixel centre's
   nonzero winding, shifted by expansion, mapped through the falloff
   (:func:`distance_alpha`). Per-vertex feather is interpolated along each segment. The
   band is bounded, so cost scales with edge length; the interior is filled by spans.
5. **Combine** the stack by mode (:func:`combine`), then **quantise once** with
   round-half-even (:func:`quantize_alpha`).

DETERMINISM RULES (required for byte equality; see plan 10 "Rasteriser"):

* float64 everywhere, never float32.
* No floating-point reductions over an axis (``np.sum``/``np.add.reduce``): their pairwise
  or SIMD order differs across builds. Floating-point work here is ELEMENTWISE only
  (``+ - * /``, ``sqrt``, ``floor``, ``rint``, ``minimum``/``maximum``), which is
  correctly rounded per element and order-independent. Accumulations are either integer
  (``cumsum``/``add.reduceat`` over int64: exact, so order cannot matter) or ``max``
  (``np.maximum.at``: exact and commutative).
* No ``exp``/``pow``/``sin`` in per-pixel paths: ``linear`` and ``smooth`` falloffs are
  polynomials, ``gaussian`` reads a 4096-entry table generated once and shipped as data
  (``mask_falloff_gaussian.json``). ``cos``/``sin`` run once per shape, and multiples of 90
  degrees are exact constants.
* Expressions are written in the order the TypeScript twin must evaluate them; do not
  "simplify" them (``a + (b - a) * t`` and ``a * (1 - t) + b * t`` differ in the last bit).
"""

from __future__ import annotations

import base64
import json
import logging
import math
from dataclasses import dataclass
from functools import lru_cache
from itertools import pairwise
from pathlib import Path
from typing import Literal

import numpy as np
import numpy.typing as npt

_log = logging.getLogger(__name__)

FloatArray = npt.NDArray[np.float64]

#: Maximum distance, in SOURCE pixels, between a flattened chord and its Bezier control points.
FLATTEN_TOLERANCE = 0.02
#: Subdivision cap; 16 levels is 65,536 chords per segment, far below any real need.
MAX_FLATTEN_DEPTH = 16
#: Q16.16: one pixel of area is this many integer units.
Q16_ONE = 65536
#: Entries in the shipped gaussian falloff table.
FALLOFF_TABLE_SIZE = 4096
#: ``k`` in ``(exp(-k (1-x)^2) - exp(-k)) / (1 - exp(-k))``: a gaussian with sigma 1/3.
GAUSSIAN_FALLOFF_K = 4.5
#: 4 (sqrt(2) - 1) / 3: the cubic control-point distance that best approximates a quarter circle.
KAPPA = 0.5522847498307936
#: Pixel/segment pairs evaluated per chunk (bounds memory on large feathers).
_PAIR_CHUNK = 1 << 20

_FALLOFF_TABLE_PATH = Path(__file__).with_name("mask_falloff_gaussian.json")

Falloff = Literal["linear", "smooth", "gaussian"]
Mode = Literal["add", "subtract", "intersect", "difference", "lighten", "darken"]


class MaskRasterError(ValueError):
    """A mask cannot be rasterised as given (malformed geometry)."""


# --- Paths ----------------------------------------------------------------------------


@dataclass(frozen=True)
class BezierVertex:
    """One vertex of a closed cubic path; tangents are OFFSETS from the vertex."""

    x: float
    y: float
    in_x: float = 0.0
    in_y: float = 0.0
    out_x: float = 0.0
    out_y: float = 0.0
    feather: float | None = None


@dataclass(frozen=True)
class BezierPath:
    """A closed cubic Bezier path. ``first_vertex`` is where flattening starts."""

    vertices: tuple[BezierVertex, ...]
    first_vertex: int = 0

    @property
    def has_vertex_feather(self) -> bool:
        return any(vertex.feather is not None for vertex in self.vertices)


@dataclass(frozen=True)
class Polyline:
    """A closed flattened path: ``xs[-1] == xs[0]``. ``feathers`` is per point, or ``None``."""

    xs: FloatArray
    ys: FloatArray
    feathers: FloatArray | None = None


def _cos_sin(degrees: float) -> tuple[float, float]:
    """``(cos, sin)`` of a clockwise rotation; exact for multiples of 90 degrees."""
    turns = degrees / 90.0
    if turns == math.floor(turns):
        quarter = int(turns) % 4
        return ((1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0))[quarter]
    radians = degrees * math.pi / 180.0
    return (math.cos(radians), math.sin(radians))


def _placed(
    local: list[tuple[float, float, float, float, float, float]],
    cx: float,
    cy: float,
    rotation: float,
) -> BezierPath:
    cos_r, sin_r = _cos_sin(rotation)
    vertices: list[BezierVertex] = []
    for lx, ly, ix, iy, ox, oy in local:
        vertices.append(
            BezierVertex(
                x=cx + (cos_r * lx - sin_r * ly),
                y=cy + (sin_r * lx + cos_r * ly),
                in_x=cos_r * ix - sin_r * iy,
                in_y=sin_r * ix + cos_r * iy,
                out_x=cos_r * ox - sin_r * oy,
                out_y=sin_r * ox + cos_r * oy,
            )
        )
    return BezierPath(tuple(vertices))


def ellipse_path(cx: float, cy: float, rx: float, ry: float, rotation: float = 0.0) -> BezierPath:
    """An ellipse as four cubic arcs, clockwise on screen (y down), starting at +x."""
    kx = KAPPA * rx
    ky = KAPPA * ry
    local = [
        (rx, 0.0, 0.0, -ky, 0.0, ky),
        (0.0, ry, kx, 0.0, -kx, 0.0),
        (-rx, 0.0, 0.0, ky, 0.0, -ky),
        (0.0, -ry, -kx, 0.0, kx, 0.0),
    ]
    return _placed(local, cx, cy, rotation)


def rectangle_path(
    cx: float,
    cy: float,
    width: float,
    height: float,
    rotation: float = 0.0,
    roundness: float = 0.0,
) -> BezierPath:
    """A rectangle; ``roundness`` 0..1 sets the corner radius to ``roundness * min(w, h) / 2``."""
    hw = width / 2.0
    hh = height / 2.0
    radius = min(max(roundness, 0.0), 1.0) * min(width, height) / 2.0
    if radius <= 0.0:
        local = [
            (-hw, -hh, 0.0, 0.0, 0.0, 0.0),
            (hw, -hh, 0.0, 0.0, 0.0, 0.0),
            (hw, hh, 0.0, 0.0, 0.0, 0.0),
            (-hw, hh, 0.0, 0.0, 0.0, 0.0),
        ]
        return _placed(local, cx, cy, rotation)
    k = KAPPA * radius
    local = [
        (-hw + radius, -hh, -k, 0.0, 0.0, 0.0),
        (hw - radius, -hh, 0.0, 0.0, k, 0.0),
        (hw, -hh + radius, 0.0, -k, 0.0, 0.0),
        (hw, hh - radius, 0.0, 0.0, 0.0, k),
        (hw - radius, hh, k, 0.0, 0.0, 0.0),
        (-hw + radius, hh, 0.0, 0.0, -k, 0.0),
        (-hw, hh - radius, 0.0, k, 0.0, 0.0),
        (-hw, -hh + radius, 0.0, 0.0, 0.0, -k),
    ]
    return _placed(local, cx, cy, rotation)


def path_from_points(
    points: list[float],
    feathers: list[float] | None = None,
    first_vertex: int = 0,
) -> BezierPath:
    """A path from the schema's flat ``[x, y, inX, inY, outX, outY, ...]`` storage."""
    if len(points) % 6 != 0 or len(points) < 18:
        raise MaskRasterError(
            "A mask path needs at least three vertices of six numbers each. Redraw the path."
        )
    count = len(points) // 6
    if feathers is not None and len(feathers) != count:
        raise MaskRasterError(
            "A mask path stores one per-vertex feather for every vertex. Redraw the path."
        )
    vertices = tuple(
        BezierVertex(
            x=points[6 * i],
            y=points[6 * i + 1],
            in_x=points[6 * i + 2],
            in_y=points[6 * i + 3],
            out_x=points[6 * i + 4],
            out_y=points[6 * i + 5],
            feather=None if feathers is None else feathers[i],
        )
        for i in range(count)
    )
    return BezierPath(vertices, first_vertex % count)


# --- Flattening ------------------------------------------------------------------------


def _dist2_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx = bx - ax
    dy = by - ay
    qx = px - ax
    qy = py - ay
    length2 = dx * dx + dy * dy
    if length2 == 0.0:
        return qx * qx + qy * qy
    t = (qx * dx + qy * dy) / length2
    t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
    ex = qx - t * dx
    ey = qy - t * dy
    return ex * ex + ey * ey


def _flatten_cubic(
    p: tuple[float, float, float, float, float, float, float, float],
    t0: float,
    t1: float,
    depth: int,
    tolerance2: float,
    out_x: list[float],
    out_y: list[float],
    out_t: list[float],
) -> None:
    x0, y0, x1, y1, x2, y2, x3, y3 = p
    flat = (
        _dist2_to_segment(x1, y1, x0, y0, x3, y3) <= tolerance2
        and _dist2_to_segment(x2, y2, x0, y0, x3, y3) <= tolerance2
    )
    if flat or depth >= MAX_FLATTEN_DEPTH:
        out_x.append(x3)
        out_y.append(y3)
        out_t.append(t1)
        return
    ax = (x0 + x1) * 0.5
    ay = (y0 + y1) * 0.5
    bx = (x1 + x2) * 0.5
    by = (y1 + y2) * 0.5
    cx = (x2 + x3) * 0.5
    cy = (y2 + y3) * 0.5
    dx = (ax + bx) * 0.5
    dy = (ay + by) * 0.5
    ex = (bx + cx) * 0.5
    ey = (by + cy) * 0.5
    mx = (dx + ex) * 0.5
    my = (dy + ey) * 0.5
    tm = (t0 + t1) * 0.5
    _flatten_cubic(
        (x0, y0, ax, ay, dx, dy, mx, my), t0, tm, depth + 1, tolerance2, out_x, out_y, out_t
    )
    _flatten_cubic(
        (mx, my, ex, ey, cx, cy, x3, y3), tm, t1, depth + 1, tolerance2, out_x, out_y, out_t
    )


def flatten_path(path: BezierPath, tolerance: float = FLATTEN_TOLERANCE) -> Polyline:
    """Flatten a closed path to a closed polyline (last point repeats the first).

    Segment ``i`` runs from vertex ``first_vertex + i`` to the next. Per-vertex feather, when
    any vertex has one (``None`` counts as 0), is interpolated by the Bezier parameter:
    ``fa + (fb - fa) * t``.
    """
    vertices = path.vertices
    count = len(vertices)
    if count < 2:
        raise MaskRasterError("A mask path needs at least three vertices. Redraw the path.")
    tolerance2 = tolerance * tolerance
    start = vertices[path.first_vertex % count]
    xs: list[float] = [start.x]
    ys: list[float] = [start.y]
    feathers: list[float] | None = [] if path.has_vertex_feather else None
    if feathers is not None:
        feathers.append(start.feather or 0.0)
    for step in range(count):
        a = vertices[(path.first_vertex + step) % count]
        b = vertices[(path.first_vertex + step + 1) % count]
        seg_x: list[float] = []
        seg_y: list[float] = []
        seg_t: list[float] = []
        control = (
            a.x,
            a.y,
            a.x + a.out_x,
            a.y + a.out_y,
            b.x + b.in_x,
            b.y + b.in_y,
            b.x,
            b.y,
        )
        _flatten_cubic(control, 0.0, 1.0, 0, tolerance2, seg_x, seg_y, seg_t)
        xs.extend(seg_x)
        ys.extend(seg_y)
        if feathers is not None:
            fa = a.feather or 0.0
            fb = b.feather or 0.0
            feathers.extend(fa + (fb - fa) * t for t in seg_t)
    return Polyline(
        np.asarray(xs, dtype=np.float64),
        np.asarray(ys, dtype=np.float64),
        None if feathers is None else np.asarray(feathers, dtype=np.float64),
    )


def to_raster(
    polyline: Polyline, scale_x: float, scale_y: float, offset_x: float, offset_y: float
) -> Polyline:
    """Map source-unit points to raster pixels: ``X = x * scale_x + offset_x`` (elementwise)."""
    return Polyline(
        polyline.xs * scale_x + offset_x,
        polyline.ys * scale_y + offset_y,
        polyline.feathers,
    )


# --- Coverage (Q16.16 signed area) ------------------------------------------------------


def _split_points(
    x0: FloatArray, y0: FloatArray, x1: FloatArray, y1: FloatArray, width: int, height: int
) -> tuple[npt.NDArray[np.int64], FloatArray, FloatArray]:
    """Every segment's endpoints plus its integer x/y crossings, sorted along the segment.

    Returns ``(segment id, x, y)`` in order: by segment, then parameter ``t``, then kind
    (start 0, y crossing 1, x crossing 2, end 3). Crossing coordinates on the crossed axis
    are the exact integer.
    """
    n = x0.shape[0]
    seg = np.arange(n, dtype=np.int64)
    ids = [seg, seg]
    ts = [np.zeros(n), np.ones(n)]
    px = [x0, x1]
    py = [y0, y1]
    kinds = [np.zeros(n, dtype=np.int64), np.full(n, 3, dtype=np.int64)]

    ymin = np.minimum(y0, y1)
    ymax = np.maximum(y0, y1)
    lo = np.maximum(np.floor(ymin) + 1.0, 0.0)
    hi = np.minimum(np.ceil(ymax) - 1.0, float(height))
    counts = np.maximum(hi - lo + 1.0, 0.0).astype(np.int64)
    if int(counts.sum()) > 0:  # integer sum: exact
        owner = np.repeat(seg, counts)
        offsets = np.arange(owner.shape[0], dtype=np.int64) - np.repeat(
            np.cumsum(counts) - counts, counts
        )
        k = np.repeat(lo, counts) + offsets.astype(np.float64)
        t = (k - y0[owner]) / (y1[owner] - y0[owner])
        ids.append(owner)
        ts.append(t)
        px.append(x0[owner] + t * (x1[owner] - x0[owner]))
        py.append(k)
        kinds.append(np.ones(owner.shape[0], dtype=np.int64))

    xmin = np.minimum(x0, x1)
    xmax = np.maximum(x0, x1)
    lo = np.maximum(np.floor(xmin) + 1.0, 0.0)
    hi = np.minimum(np.ceil(xmax) - 1.0, float(width))
    counts = np.where(x0 != x1, np.maximum(hi - lo + 1.0, 0.0), 0.0).astype(np.int64)
    if int(counts.sum()) > 0:
        owner = np.repeat(seg, counts)
        offsets = np.arange(owner.shape[0], dtype=np.int64) - np.repeat(
            np.cumsum(counts) - counts, counts
        )
        k = np.repeat(lo, counts) + offsets.astype(np.float64)
        t = (k - x0[owner]) / (x1[owner] - x0[owner])
        ids.append(owner)
        ts.append(t)
        px.append(k)
        py.append(y0[owner] + t * (y1[owner] - y0[owner]))
        kinds.append(np.full(owner.shape[0], 2, dtype=np.int64))

    all_ids = np.concatenate(ids)
    all_t = np.concatenate(ts)
    all_kinds = np.concatenate(kinds)
    order = np.lexsort((all_kinds, all_t, all_ids))
    return all_ids[order], np.concatenate(px)[order], np.concatenate(py)[order]


def coverage_alpha(polyline: Polyline, width: int, height: int) -> FloatArray:
    """Exact area coverage of a closed polyline (raster px), nonzero winding, clamped to 1.

    Each piece of an edge inside one pixel cell adds its signed height ``dY`` (Q16.16 integer)
    split into ``round(dY * (1 - frac))`` at its cell and the rest at the next cell, where
    ``frac`` is the piece's mean x within the cell; a row's running sum is then that pixel's
    signed covered area. Pieces left of the frame add their whole ``dY`` to column 0. Heights
    are rounded at the (shared) piece endpoints, so a closed path's integers telescope and a
    row outside the shape sums to exactly zero.

    That running sum is the pixel's NET winding area, which equals nonzero coverage wherever
    the winding inside the pixel stays within {0, +1} or {0, -1}. Where it may not (opposite
    windings meeting at a self-crossing, or a path overlapping itself), the pixel is replaced by
    :func:`exact_cell_coverage`, the exact nonzero area. Such pixels are found by
    :func:`_complex_cells`: a cell crossed by path segments that are not one consecutive run, or
    by a run in which two non-adjacent segments intersect or touch.
    """
    alpha = np.zeros((height, width), dtype=np.float64)
    xs, ys = polyline.xs, polyline.ys
    all_x0, all_y0, all_x1, all_y1 = xs[:-1], ys[:-1], xs[1:], ys[1:]
    keep = (
        (all_y0 != all_y1)
        & (np.maximum(all_y0, all_y1) > 0.0)
        & (np.minimum(all_y0, all_y1) < float(height))
    )
    if not bool(keep.any()) or width <= 0 or height <= 0:
        return alpha
    kept_ids = np.flatnonzero(keep).astype(np.int64)
    x0, y0, x1, y1 = all_x0[keep], all_y0[keep], all_x1[keep], all_y1[keep]
    seg, px, py = _split_points(x0, y0, x1, y1, width, height)

    fixed_y = np.rint(py * float(Q16_ONE)).astype(np.int64)
    a = np.arange(seg.shape[0] - 1)
    b = a + 1
    same = seg[a] == seg[b]
    a, b = a[same], b[same]
    complex_cells = _complex_cells(
        all_x0,
        all_y0,
        all_x1,
        all_y1,
        kept_ids[seg[a]],
        (px[a] + px[b]) * 0.5,
        (py[a] + py[b]) * 0.5,
        width,
        height,
    )
    d_y = fixed_y[b] - fixed_y[a]
    nonzero = d_y != 0
    a, b, d_y = a[nonzero], b[nonzero], d_y[nonzero]
    row = np.floor((py[a] + py[b]) * 0.5)
    in_rows = (row >= 0.0) & (row < float(height))
    a, b, d_y, row = a[in_rows], b[in_rows], d_y[in_rows], row[in_rows]
    mid_x = (px[a] + px[b]) * 0.5
    col = np.floor(np.clip(mid_x, -1.0, float(width)))
    rows_i = row.astype(np.int64)

    left = col < 0.0
    inside = (col >= 0.0) & (col < float(width))
    frac = mid_x[inside] - col[inside]
    d_in = d_y[inside]
    area = np.rint(d_in.astype(np.float64) * (1.0 - frac)).astype(np.int64)
    col_in = col[inside].astype(np.int64)
    row_in = rows_i[inside]
    spill = col_in + 1 < width

    stride = width + 1
    keys = np.concatenate(
        [
            rows_i[left] * stride,
            row_in * stride + col_in,
            row_in[spill] * stride + col_in[spill] + 1,
        ]
    )
    values = np.concatenate([d_y[left], area, (d_in - area)[spill]])
    if keys.shape[0] == 0:
        return alpha
    order = np.argsort(keys, kind="stable")
    keys = keys[order]
    values = values[order]
    starts = np.flatnonzero(np.concatenate(([True], keys[1:] != keys[:-1])))
    unique_keys = keys[starts]
    merged = np.add.reduceat(values, starts)  # int64: exact in any order
    rows = unique_keys // stride
    cols = unique_keys % stride
    running = np.cumsum(merged)  # int64: exact
    row_first = np.flatnonzero(np.concatenate(([True], rows[1:] != rows[:-1])))
    run_lengths = np.diff(np.append(row_first, rows.shape[0])).astype(np.int64)
    before = np.where(row_first > 0, running[np.maximum(row_first - 1, 0)], 0)
    running = running - np.repeat(before, run_lengths)
    covered = np.minimum(np.abs(running), Q16_ONE).astype(np.float64) / float(Q16_ONE)
    alpha[rows, cols] = covered

    next_cols = np.empty_like(cols)
    next_cols[:-1] = np.where(rows[1:] == rows[:-1], cols[1:], width)
    next_cols[-1] = width
    for index in np.flatnonzero((covered > 0.0) & (next_cols - cols > 1)):
        alpha[rows[index], cols[index] + 1 : next_cols[index]] = covered[index]
    for row_index, col_index in complex_cells:
        alpha[row_index, col_index] = exact_cell_coverage(
            all_x0, all_y0, all_x1, all_y1, row_index, col_index
        )
    return alpha


def _complex_cells(
    x0: FloatArray,
    y0: FloatArray,
    x1: FloatArray,
    y1: FloatArray,
    piece_segments: npt.NDArray[np.int64],
    piece_mid_x: FloatArray,
    piece_mid_y: FloatArray,
    width: int,
    height: int,
) -> list[tuple[int, int]]:
    """Cells whose net winding area may differ from nonzero coverage, in row-major order.

    Membership: every non-horizontal piece marks the cell holding its midpoint; a horizontal
    segment marks each cell its span touches in row ``floor(y)`` (and ``y - 1`` when ``y`` is an
    integer). A cell is complex when its segment ids (segments ``0..n-1`` of the closed path,
    ``n - 1`` adjacent to ``0``) are not one cyclically consecutive run, or when a run of three
    or more contains two non-adjacent segments that intersect or touch (:func:`_segments_meet`).
    """
    count = x0.shape[0]
    rows = np.floor(piece_mid_y)
    cols = np.floor(np.clip(piece_mid_x, -1.0, float(width)))
    inside = (rows >= 0.0) & (rows < float(height)) & (cols >= 0.0) & (cols < float(width))
    keys = [rows[inside].astype(np.int64) * width + cols[inside].astype(np.int64)]
    owners = [piece_segments[inside]]
    horizontal = np.flatnonzero((y0 == y1) & (y0 >= 0.0) & (y0 <= float(height)))
    for segment in horizontal.tolist():
        y = float(y0[segment])
        first = max(math.floor(min(float(x0[segment]), float(x1[segment]))), 0)
        last = min(math.floor(max(float(x0[segment]), float(x1[segment]))), width - 1)
        if last < first:
            continue
        for row in {math.floor(y), math.floor(y) - 1 if y == math.floor(y) else -1}:
            if 0 <= row < height:
                span = np.arange(first, last + 1, dtype=np.int64)
                keys.append(row * width + span)
                owners.append(np.full(span.shape[0], segment, dtype=np.int64))
    all_keys = np.concatenate(keys)
    all_owners = np.concatenate(owners)
    if all_keys.shape[0] == 0:
        return []
    order = np.lexsort((all_owners, all_keys))
    all_keys = all_keys[order]
    all_owners = all_owners[order]
    distinct = np.concatenate(
        ([True], (all_keys[1:] != all_keys[:-1]) | (all_owners[1:] != all_owners[:-1]))
    )
    all_keys = all_keys[distinct]
    all_owners = all_owners[distinct]
    starts = np.flatnonzero(np.concatenate(([True], all_keys[1:] != all_keys[:-1])))
    ends = np.append(starts[1:], all_keys.shape[0])
    flagged: list[tuple[int, int]] = []
    for start, end in zip(starts.tolist(), ends.tolist(), strict=True):
        if end - start < 2:
            continue
        ids = all_owners[start:end].tolist()
        gaps = sum(1 for a, b in pairwise(ids) if b - a != 1)
        wraps = ids[0] == 0 and ids[-1] == count - 1
        contiguous = gaps == 0 or (gaps == 1 and wraps)
        if not contiguous or (len(ids) >= 3 and _run_meets_itself(x0, y0, x1, y1, ids, count)):
            key = int(all_keys[start])
            flagged.append((key // width, key % width))
    return flagged


def _run_meets_itself(
    x0: FloatArray, y0: FloatArray, x1: FloatArray, y1: FloatArray, ids: list[int], count: int
) -> bool:
    for i, first in enumerate(ids):
        for second in ids[i + 1 :]:
            gap = second - first
            if gap == 1 or gap == count - 1:
                continue
            if _segments_meet(x0, y0, x1, y1, first, second):
                return True
    return False


def _segments_meet(
    x0: FloatArray, y0: FloatArray, x1: FloatArray, y1: FloatArray, p: int, q: int
) -> bool:
    """Whether two segments share any point (orientation test; collinear overlap counts)."""
    ax, ay, bx, by = float(x0[p]), float(y0[p]), float(x1[p]), float(y1[p])
    cx, cy, dx, dy = float(x0[q]), float(y0[q]), float(x1[q]), float(y1[q])

    def orient(ux: float, uy: float, vx: float, vy: float, wx: float, wy: float) -> float:
        return (vx - ux) * (wy - uy) - (vy - uy) * (wx - ux)

    def within(ux: float, uy: float, vx: float, vy: float, wx: float, wy: float) -> bool:
        return min(ux, vx) <= wx <= max(ux, vx) and min(uy, vy) <= wy <= max(uy, vy)

    o1 = orient(ax, ay, bx, by, cx, cy)
    o2 = orient(ax, ay, bx, by, dx, dy)
    o3 = orient(cx, cy, dx, dy, ax, ay)
    o4 = orient(cx, cy, dx, dy, bx, by)
    if ((o1 > 0.0 and o2 < 0.0) or (o1 < 0.0 and o2 > 0.0)) and (
        (o3 > 0.0 and o4 < 0.0) or (o3 < 0.0 and o4 > 0.0)
    ):
        return True
    return (
        (o1 == 0.0 and within(ax, ay, bx, by, cx, cy))
        or (o2 == 0.0 and within(ax, ay, bx, by, dx, dy))
        or (o3 == 0.0 and within(cx, cy, dx, dy, ax, ay))
        or (o4 == 0.0 and within(cx, cy, dx, dy, bx, by))
    )


def exact_cell_coverage(
    x0: FloatArray, y0: FloatArray, x1: FloatArray, y1: FloatArray, row: int, col: int
) -> float:
    """The exact nonzero-winding area of the closed path inside pixel ``(row, col)``.

    A vertical-slab sweep over ``y`` in ``[row, row + 1]``, float64, in this fixed order:

    1. Candidates: non-horizontal segments with ``min(y) < row + 1`` and ``max(y) > row``.
    2. Slab boundaries: ``row``, ``row + 1``; every candidate endpoint ``y`` strictly inside;
       every ``y`` where a candidate crosses ``x = col`` or ``x = col + 1`` strictly inside
       (``t = (k - x0) / (x1 - x0)``, ``0 < t < 1``, ``y = y0 + t * (y1 - y0)``); every ``y``
       strictly inside where two candidates whose x-ranges reach the cell intersect at an
       ``x`` in ``[col, col + 1]`` (``t = (qpx * sy - qpy * sx) / (rx * sy - ry * sx)``). Sorted
       ascending, duplicates removed.
    3. Per slab ``[ya, yb]`` (ascending), ``ym = (ya + yb) * 0.5``. A candidate crosses the slab
       when ``min(y) <= ym < max(y)``, at ``x(y) = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)``,
       direction +1 downward else -1. Crossings with ``x(ym) < col`` add their direction to
       the starting winding; those with ``x(ym) > col + 1`` are ignored; the rest, ordered by
       ``(x(ym), direction, segment id)``, are walked left to right from ``x = col``. Each gap
       with winding != 0 adds ``max(0, hi - lo)`` to the covered length at ``ya`` and at
       ``yb``, with crossing x clamped to ``[col, col + 1]``; the gap after the last crossing
       ends at ``col + 1``.
    4. ``area += (length_a + length_b) * 0.5 * (yb - ya)``; the result is clamped to [0, 1].

    Within a slab no two crossings swap order inside the cell and none enters or leaves the
    cell, so the covered length is linear in ``y`` and the trapezoid is exact.
    """
    top = float(row)
    bottom = top + 1.0
    left = float(col)
    right = left + 1.0
    candidates = np.flatnonzero(
        (y0 != y1) & (np.minimum(y0, y1) < bottom) & (np.maximum(y0, y1) > top)
    ).tolist()
    splits: list[float] = [top, bottom]
    reaching: list[int] = []
    for segment in candidates:
        ax, ay, bx, by = (
            float(x0[segment]),
            float(y0[segment]),
            float(x1[segment]),
            float(y1[segment]),
        )
        for y in (ay, by):
            if top < y < bottom:
                splits.append(y)
        if ax != bx:
            for k in (left, right):
                t = (k - ax) / (bx - ax)
                if 0.0 < t < 1.0:
                    y = ay + t * (by - ay)
                    if top < y < bottom:
                        splits.append(y)
        if min(ax, bx) <= right and max(ax, bx) >= left:
            reaching.append(segment)
    for i, p in enumerate(reaching):
        for q in reaching[i + 1 :]:
            rx = float(x1[p]) - float(x0[p])
            ry = float(y1[p]) - float(y0[p])
            sx = float(x1[q]) - float(x0[q])
            sy = float(y1[q]) - float(y0[q])
            denominator = rx * sy - ry * sx
            if denominator == 0.0:
                continue
            qpx = float(x0[q]) - float(x0[p])
            qpy = float(y0[q]) - float(y0[p])
            t = (qpx * sy - qpy * sx) / denominator
            u = (qpx * ry - qpy * rx) / denominator
            if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0:
                x = float(x0[p]) + t * rx
                y = float(y0[p]) + t * ry
                if left <= x <= right and top < y < bottom:
                    splits.append(y)
    bounds = sorted(set(splits))
    area = 0.0
    for ya, yb in pairwise(bounds):
        ym = (ya + yb) * 0.5
        winding = 0
        walk: list[tuple[float, int, int, float, float]] = []
        for segment in candidates:
            ax, ay, bx, by = (
                float(x0[segment]),
                float(y0[segment]),
                float(x1[segment]),
                float(y1[segment]),
            )
            if not (min(ay, by) <= ym < max(ay, by)):
                continue
            direction = 1 if by > ay else -1
            xm = ax + ((ym - ay) * (bx - ax)) / (by - ay)
            if xm < left:
                winding += direction
            elif xm <= right:
                xa = ax + ((ya - ay) * (bx - ax)) / (by - ay)
                xb = ax + ((yb - ay) * (bx - ax)) / (by - ay)
                walk.append((xm, direction, segment, xa, xb))
        walk.sort(key=lambda entry: (entry[0], entry[1], entry[2]))
        length_a = 0.0
        length_b = 0.0
        previous_a = left
        previous_b = left
        for _xm, direction, _segment, xa, xb in walk:
            current_a = min(max(xa, left), right)
            current_b = min(max(xb, left), right)
            if winding != 0:
                length_a += max(0.0, current_a - previous_a)
                length_b += max(0.0, current_b - previous_b)
            previous_a = current_a
            previous_b = current_b
            winding += direction
        if winding != 0:
            length_a += max(0.0, right - previous_a)
            length_b += max(0.0, right - previous_b)
        area += (length_a + length_b) * 0.5 * (yb - ya)
    return 0.0 if area <= 0.0 else 1.0 if area >= 1.0 else area


# --- Pixel-centre winding ---------------------------------------------------------------


def centre_inside(polyline: Polyline, width: int, height: int) -> npt.NDArray[np.bool_]:
    """Whether each pixel centre is inside the closed polyline (nonzero winding).

    A segment crosses row ``r`` when ``min(y) <= r + 0.5 < max(y)``, at
    ``x = x0 + ((r + 0.5 - y0) * (x1 - x0)) / (y1 - y0)``; a centre is inside when the
    crossings strictly left of it wind to a nonzero total.
    """
    inside = np.zeros((height, width), dtype=np.bool_)
    xs, ys = polyline.xs, polyline.ys
    x0, y0, x1, y1 = xs[:-1], ys[:-1], xs[1:], ys[1:]
    ymin = np.minimum(y0, y1)
    ymax = np.maximum(y0, y1)
    first = np.maximum(np.ceil(ymin - 0.5), 0.0)
    last = np.minimum(np.ceil(ymax - 0.5) - 1.0, float(height - 1))
    counts = np.where(y0 != y1, np.maximum(last - first + 1.0, 0.0), 0.0).astype(np.int64)
    total = int(counts.sum())
    if total == 0:
        return inside
    owner = np.repeat(np.arange(x0.shape[0], dtype=np.int64), counts)
    offsets = np.arange(total, dtype=np.int64) - np.repeat(np.cumsum(counts) - counts, counts)
    row = np.repeat(first, counts) + offsets.astype(np.float64)
    centre_y = row + 0.5
    cross_x = x0[owner] + ((centre_y - y0[owner]) * (x1[owner] - x0[owner])) / (
        y1[owner] - y0[owner]
    )
    direction = np.where(y1[owner] > y0[owner], 1, -1).astype(np.int64)
    order = np.lexsort((direction, cross_x, row))
    rows = row[order].astype(np.int64)
    crossings = cross_x[order]
    directions = direction[order]
    winding = 0
    for index in range(total):
        if index == 0 or rows[index] != rows[index - 1]:
            winding = 0
        winding += int(directions[index])
        last_in_row = index + 1 == total or rows[index + 1] != rows[index]
        if winding == 0 or last_in_row:
            continue
        # Centres with crossing < c + 0.5 <= next crossing.
        start = math.floor(float(crossings[index]) - 0.5) + 1
        stop = math.floor(float(crossings[index + 1]) - 0.5)
        start = max(start, 0)
        stop = min(stop, width - 1)
        if stop >= start:
            inside[rows[index], start : stop + 1] = True
    return inside


# --- Falloff ----------------------------------------------------------------------------


def generate_gaussian_falloff_table() -> list[float]:
    """The shipped table, recomputed (generation only; never called per pixel)."""
    k = GAUSSIAN_FALLOFF_K
    floor = math.exp(-k)
    values: list[float] = []
    for index in range(FALLOFF_TABLE_SIZE):
        x = index / (FALLOFF_TABLE_SIZE - 1)
        values.append((math.exp(-k * (1.0 - x) * (1.0 - x)) - floor) / (1.0 - floor))
    values[0] = 0.0
    values[-1] = 1.0
    return values


def encode_falloff_table(values: list[float]) -> dict[str, object]:
    """The on-disk form: little-endian float64, base64."""
    raw = np.asarray(values, dtype="<f8").tobytes()
    return {
        "curve": "gaussian",
        "k": GAUSSIAN_FALLOFF_K,
        "size": len(values),
        "encoding": "float64-le-base64",
        "values": base64.b64encode(raw).decode("ascii"),
    }


@lru_cache(maxsize=1)
def gaussian_falloff_table() -> FloatArray:
    """The shipped gaussian falloff table (``mask_falloff_gaussian.json``)."""
    document = json.loads(_FALLOFF_TABLE_PATH.read_text(encoding="utf-8"))
    table = np.frombuffer(base64.b64decode(document["values"]), dtype="<f8").astype(np.float64)
    if table.shape[0] != FALLOFF_TABLE_SIZE:
        raise MaskRasterError("The mask falloff table is damaged. Reinstall FramePilot.")
    return table


def apply_falloff(x: FloatArray, falloff: str) -> FloatArray:
    """Falloff of ``x`` in ``[0, 1]`` (0 = outer band edge, 1 = fully inside)."""
    if falloff == "linear":
        return x
    if falloff == "smooth":
        return (x * x) * (3.0 - 2.0 * x)
    table = gaussian_falloff_table()
    position = x * float(FALLOFF_TABLE_SIZE - 1)
    index = np.minimum(np.floor(position), float(FALLOFF_TABLE_SIZE - 2))
    frac = position - index
    low = table[index.astype(np.int64)]
    high = table[index.astype(np.int64) + 1]
    return low + (high - low) * frac


# --- Distance feather -------------------------------------------------------------------


def _band_rows(
    ax: FloatArray, ay: FloatArray, bx: FloatArray, by: FloatArray, radius: float, height: int
) -> tuple[npt.NDArray[np.int64], npt.NDArray[np.int64]]:
    """``(segment, row)`` for every row whose pixel centres can lie within ``radius``."""
    first = np.maximum(np.ceil(np.minimum(ay, by) - radius - 0.5), 0.0)
    last = np.minimum(np.floor(np.maximum(ay, by) + radius - 0.5), float(height - 1))
    counts = np.maximum(last - first + 1.0, 0.0).astype(np.int64)
    owner = np.repeat(np.arange(ax.shape[0], dtype=np.int64), counts)
    offset = np.arange(owner.shape[0], dtype=np.int64) - np.repeat(
        np.cumsum(counts) - counts, counts
    )
    return owner, first.astype(np.int64)[owner] + offset


def _band_columns(
    ax: FloatArray,
    ay: FloatArray,
    bx: FloatArray,
    by: FloatArray,
    rows: npt.NDArray[np.int64],
    radius: float,
    width: int,
) -> tuple[FloatArray, FloatArray]:
    """First/last column whose centre can lie within ``radius`` of a segment on a row.

    The part of the segment with ``|y - (row + 0.5)| <= radius`` is found by its parameter
    range; its x extent widened by ``radius`` bounds the row's pixels. A superset of the band
    is all that is needed: the per-pixel reduction is exact whatever extra pairs it sees.
    """
    centre_y = rows.astype(np.float64) + 0.5
    dy = by - ay
    dx = bx - ax
    flat = dy == 0.0
    safe = np.where(flat, 1.0, dy)
    t_a = np.where(flat, 0.0, (centre_y - radius - ay) / safe)
    t_b = np.where(flat, 1.0, (centre_y + radius - ay) / safe)
    t_lo = np.maximum(np.minimum(t_a, t_b), 0.0)
    t_hi = np.minimum(np.maximum(t_a, t_b), 1.0)
    x_lo = ax + t_lo * dx
    x_hi = ax + t_hi * dx
    first = np.maximum(np.ceil(np.minimum(x_lo, x_hi) - radius - 0.5), 0.0)
    last = np.minimum(np.floor(np.maximum(x_lo, x_hi) + radius - 0.5), float(width - 1))
    last = np.where(t_lo > t_hi, first - 1.0, last)
    return first, last


def _band_chunk(
    ax: FloatArray,
    ay: FloatArray,
    bx: FloatArray,
    by: FloatArray,
    fa: FloatArray,
    fb: FloatArray,
    radius: float,
    width: int,
    height: int,
    flat_inside: npt.NDArray[np.bool_],
    best: FloatArray,
    *,
    expansion: float,
    feather_inner: float,
    falloff: str,
) -> None:
    """Fold one chunk of segments into ``best`` (``max`` of the signed per-pair alpha)."""
    owner, rows = _band_rows(ax, ay, bx, by, radius, height)
    if owner.shape[0] == 0:
        return
    first, last = _band_columns(ax[owner], ay[owner], bx[owner], by[owner], rows, radius, width)
    counts = np.maximum(last - first + 1.0, 0.0).astype(np.int64)
    pairs = int(counts.sum())  # integer sum: exact
    if pairs == 0:
        return
    seg = np.repeat(owner, counts)
    row = np.repeat(rows, counts)
    col = np.repeat(first.astype(np.int64), counts) + (
        np.arange(pairs, dtype=np.int64) - np.repeat(np.cumsum(counts) - counts, counts)
    )
    pixel = row * width + col
    centre_x = col.astype(np.float64) + 0.5
    centre_y = row.astype(np.float64) + 0.5
    dx = bx[seg] - ax[seg]
    dy = by[seg] - ay[seg]
    qx = centre_x - ax[seg]
    qy = centre_y - ay[seg]
    length2 = dx * dx + dy * dy
    degenerate = length2 == 0.0
    t = np.where(degenerate, 0.0, (qx * dx + qy * dy) / np.where(degenerate, 1.0, length2))
    t = np.minimum(np.maximum(t, 0.0), 1.0)
    ex = qx - t * dx
    ey = qy - t * dy
    distance = np.sqrt(ex * ex + ey * ey)
    is_inside = flat_inside[pixel]
    signed = np.where(is_inside, -distance, distance) - expansion
    outer = fa[seg] + (fb[seg] - fa[seg]) * t
    denominator = feather_inner + outer
    hard = denominator == 0.0
    x = np.where(hard, 0.5 - signed, (outer - signed) / np.where(hard, 1.0, denominator))
    x = np.minimum(np.maximum(x, 0.0), 1.0)
    value = np.where(hard, x, apply_falloff(x, falloff))
    np.maximum.at(best, pixel, np.where(is_inside, -value, value))


def distance_alpha(
    polyline: Polyline,
    width: int,
    height: int,
    *,
    expansion: float,
    feather_inner: float,
    feather_outer: float,
    falloff: str,
) -> FloatArray:
    """Alpha from the signed distance to the edge, for a feathered or expanded shape (raster px).

    For a pixel centre at distance ``d`` from a segment (positive outside, negative inside),
    ``s = d - expansion`` and ``w_o`` is the outer feather there (per-vertex feather, when the
    polyline carries it, replaces ``feather_outer``). Then::

        x = (w_o - s) / (w_i + w_o)      clamped to [0, 1]; alpha = falloff(x)
        x = 0.5 - s                      when w_i + w_o == 0 (a one-pixel linear edge)

    A pixel takes the segment giving the MAX alpha when its centre is outside and the MIN
    when inside, i.e. its nearest edge when the feather is constant. Pixels further than the
    band radius from every segment are exactly 1 inside and 0 outside.
    """
    inside = centre_inside(polyline, width, height)
    alpha = inside.astype(np.float64)
    if polyline.xs.shape[0] < 2:
        return alpha
    max_outer = (
        feather_outer if polyline.feathers is None else float(np.max(polyline.feathers))
    )  # max is exact
    widest = max(max_outer + expansion, feather_inner - expansion, 0.0)
    radius = widest + 1.5
    ax, ay = polyline.xs[:-1], polyline.ys[:-1]
    bx, by = polyline.xs[1:], polyline.ys[1:]
    if polyline.feathers is None:
        fa = np.full(ax.shape[0], feather_outer)
        fb = fa
    else:
        fa, fb = polyline.feathers[:-1], polyline.feathers[1:]
    best = np.full(width * height, -np.inf, dtype=np.float64)
    flat_inside = inside.reshape(-1)

    # Chunk by segment so the (segment, row, column) expansion stays bounded in memory.
    estimate = (np.abs(by - ay) + 2.0 * radius + 2.0) * (np.abs(bx - ax) + 2.0 * radius + 2.0)
    segment = 0
    total = ax.shape[0]
    while segment < total:
        stop = segment + 1
        budget = float(estimate[segment])
        while stop < total and budget + float(estimate[stop]) <= _PAIR_CHUNK:
            budget += float(estimate[stop])
            stop += 1
        chunk = slice(segment, stop)
        segment = stop
        _band_chunk(
            ax[chunk],
            ay[chunk],
            bx[chunk],
            by[chunk],
            fa[chunk],
            fb[chunk],
            radius,
            width,
            height,
            flat_inside,
            best,
            expansion=expansion,
            feather_inner=feather_inner,
            falloff=falloff,
        )

    touched = np.isfinite(best)
    flat = alpha.reshape(-1)
    flat[touched] = np.where(flat_inside[touched], -best[touched], best[touched])
    return alpha


# --- One shape, the stack, quantisation --------------------------------------------------


@dataclass(frozen=True)
class ShapeRaster:
    """One mask shape ready to rasterise: a raster-px polyline and raster-px edge params."""

    polyline: Polyline
    expansion: float = 0.0
    feather_inner: float = 0.0
    feather_outer: float = 0.0
    falloff: str = "smooth"


def shape_alpha(shape: ShapeRaster, width: int, height: int) -> FloatArray:
    """A shape's alpha before invert/opacity: coverage when hard, distance feather otherwise."""
    per_vertex = shape.polyline.feathers
    hard = (
        shape.expansion == 0.0
        and shape.feather_inner == 0.0
        and (shape.feather_outer == 0.0 if per_vertex is None else not bool(np.any(per_vertex)))
    )
    if hard:
        return coverage_alpha(shape.polyline, width, height)
    return distance_alpha(
        shape.polyline,
        width,
        height,
        expansion=shape.expansion,
        feather_inner=shape.feather_inner,
        feather_outer=shape.feather_outer,
        falloff=shape.falloff,
    )


def layer_alpha(alpha: FloatArray, *, invert: bool, opacity: float) -> FloatArray:
    """Invert (``1 - a``) then scale by opacity clamped to ``[0, 1]``."""
    clamped = 0.0 if opacity <= 0.0 else 1.0 if opacity >= 1.0 else opacity
    base = 1.0 - alpha if invert else alpha
    return base * clamped


def combine(accumulated: FloatArray, mask: FloatArray, mode: str) -> FloatArray:
    """Combine a mask into the stack result above it. The stack starts all-zero.

    ``add`` min(1, a + m) · ``subtract`` max(0, a - m) · ``intersect`` a * m ·
    ``difference`` |a - m| · ``lighten`` max(a, m) · ``darken`` min(a, m).
    """
    # The two-step modes clamp in place (PX5.4): the same ufuncs in the same order, one frame-
    # sized array instead of two per mask at 4K (``tests/test_mask_stack_tail_exact.py``).
    if mode == "add":
        added: FloatArray = np.add(accumulated, mask)
        return np.minimum(added, 1.0, out=added)
    if mode == "subtract":
        taken: FloatArray = np.subtract(accumulated, mask)
        return np.maximum(taken, 0.0, out=taken)
    if mode == "intersect":
        return accumulated * mask
    if mode == "difference":
        apart: FloatArray = np.subtract(accumulated, mask)
        return np.abs(apart, out=apart)
    if mode == "lighten":
        return np.maximum(accumulated, mask)
    if mode == "darken":
        return np.minimum(accumulated, mask)
    raise MaskRasterError(
        "A mask uses a combine mode this renderer does not know. Update FramePilot."
    )


def quantize_alpha(alpha: FloatArray) -> npt.NDArray[np.uint8]:
    """The one quantisation: ``rint(clamp(a, 0, 1) * 255)``, ties to even.

    Written into one working array (PX5.4): the same four ufuncs in the same order as the
    expression, so the same bits, without three more frame-sized float arrays per 4K frame.
    """
    scaled: FloatArray = np.maximum(alpha, 0.0)
    np.minimum(scaled, 1.0, out=scaled)
    np.multiply(scaled, 255.0, out=scaled)
    np.rint(scaled, out=scaled)
    return scaled.astype(np.uint8)


# --- Analytic kinds: split, band, gradient (MK8.1) ------------------------------------------
#
# WHY analytic: a split, a mirror band and a gradient are a distance to a line or a centre, so
# they need no path, no flattening and no coverage sweep. They follow the same determinism rules
# as the shapes (float64, elementwise, sqrt only, the shipped falloff table) and are pinned by the
# same vectors (``tests/fixtures/mask-raster/analytic.json``).
#
# Geometry arrives in SOURCE units with the raster mapping ``X = x * scale_x + offset_x``; lengths
# (softness, width, expansion, feathers) scale by ``distance_scale``, as a shape's feathers do.
#
# A hard edge (no feather, no softness) is EXACT area coverage: the part of the pixel square on
# the kept side of a straight line. Projected onto the line's unit normal ``(nx, ny)``, the square
# is the sum of two uniform widths ``|nx|`` and ``|ny|``, so the covered fraction is that
# trapezoid's CDF (:func:`_footprint_cdf`) — a closed form of ``+ - * /`` only.


def _footprint_cdf(x: FloatArray, u: float, v: float) -> FloatArray:
    """Fraction of a unit pixel whose projection onto a unit normal lies below ``x``.

    ``x`` is measured from the pixel centre along the normal; ``u <= v`` are ``|nx|, |ny|``
    sorted. Evaluated branch by branch in this order (the TypeScript twin does the same)::

        x <= -half            0
        x >= half             1
        u == 0 or |x| <= lo   0.5 + x / v
        x < -lo               (x + half)^2 / (2 u v)
        x > lo                1 - (half - x)^2 / (2 u v)

    with ``half = (u + v) * 0.5`` and ``lo = (v - u) * 0.5``.
    """
    half = (u + v) * 0.5
    middle = 0.5 + x / v
    if u == 0.0:
        result = middle
    else:
        lo = (v - u) * 0.5
        two_uv = 2.0 * u * v
        below = x + half
        above = half - x
        result = np.where(
            x < -lo,
            (below * below) / two_uv,
            np.where(x > lo, 1.0 - (above * above) / two_uv, middle),
        )
    return np.where(x <= -half, 0.0, np.where(x >= half, 1.0, result))


def _pixel_centres(width: int, height: int) -> tuple[FloatArray, FloatArray]:
    """Pixel-centre coordinates as a row ``(1, width)`` and a column ``(height, 1)``."""
    xs = (np.arange(width, dtype=np.float64) + 0.5).reshape(1, width)
    ys = (np.arange(height, dtype=np.float64) + 0.5).reshape(height, 1)
    return xs, ys


def raster_line_normal(angle: float, scale_x: float, scale_y: float) -> tuple[float, float]:
    """The unit normal, in RASTER pixels, of a line at ``angle`` degrees (clockwise, y down).

    The line's direction in source units is ``(cos, sin)``; mapped to the raster it is
    ``(cos * scale_x, sin * scale_y)``, whose normal is ``(-sin * scale_y, cos * scale_x)``.
    The normal points to the side the line CUTS AWAY; ``(0, 0)`` for a degenerate raster.
    """
    cos_a, sin_a = _cos_sin(angle)
    nx = -sin_a * scale_y
    ny = cos_a * scale_x
    length = math.sqrt(nx * nx + ny * ny)
    if length == 0.0:
        return (0.0, 0.0)
    return (nx / length, ny / length)


@dataclass(frozen=True)
class AnalyticEdge:
    """A straight edge's softness in raster px: ``softness / 2`` joins each feather side."""

    expansion: float
    feather_inner: float
    feather_outer: float
    falloff: str

    @property
    def hard(self) -> bool:
        return self.feather_inner + self.feather_outer == 0.0


def analytic_edge(
    distance_scale: float,
    *,
    expansion: float,
    feather_inner: float,
    feather_outer: float,
    softness: float,
    falloff: str,
) -> AnalyticEdge:
    """Edge parameters of a split or band in raster px (``max(., 0)`` on every width)."""
    half_soft = max(softness, 0.0) * 0.5
    return AnalyticEdge(
        expansion=expansion * distance_scale,
        feather_inner=(max(feather_inner, 0.0) + half_soft) * distance_scale,
        feather_outer=(max(feather_outer, 0.0) + half_soft) * distance_scale,
        falloff=falloff,
    )


def _signed_line_distance(
    width: int, height: int, origin_x: float, origin_y: float, nx: float, ny: float
) -> FloatArray:
    """``(centre - origin) . normal`` per pixel, raster px, positive on the cut-away side."""
    xs, ys = _pixel_centres(width, height)
    return (xs - origin_x) * nx + (ys - origin_y) * ny


def _soft_edge_alpha(signed: FloatArray, edge: AnalyticEdge) -> FloatArray:
    """The distance feather of the shapes: ``x = (w_o - s) / (w_i + w_o)``, then the falloff."""
    denominator = edge.feather_inner + edge.feather_outer
    x = (edge.feather_outer - signed) / denominator
    x = np.minimum(np.maximum(x, 0.0), 1.0)
    return apply_falloff(x, edge.falloff)


def linear_alpha(
    width: int,
    height: int,
    origin_x: float,
    origin_y: float,
    normal: tuple[float, float],
    edge: AnalyticEdge,
) -> FloatArray:
    """A split: the half-plane on the side AGAINST ``normal`` (raster px origin and normal).

    ``t`` is the signed distance of a pixel centre from the line. Hard: the exact covered area
    of ``t < expansion``. Soft: ``s = t - expansion`` through :func:`_soft_edge_alpha`.
    """
    nx, ny = normal
    if nx == 0.0 and ny == 0.0:
        return np.zeros((height, width), dtype=np.float64)
    t = _signed_line_distance(width, height, origin_x, origin_y, nx, ny)
    if edge.hard:
        u = min(abs(nx), abs(ny))
        v = max(abs(nx), abs(ny))
        return _footprint_cdf(edge.expansion - t, u, v)
    return _soft_edge_alpha(t - edge.expansion, edge)


def band_alpha(
    width: int,
    height: int,
    origin_x: float,
    origin_y: float,
    normal: tuple[float, float],
    half_width: float,
    edge: AnalyticEdge,
) -> FloatArray:
    """A band ``half_width`` either side of the line (a mirror / filmstrip strip), raster px.

    Hard: the exact covered area of ``|t| < half_width + expansion`` (zero when that is not
    positive). Soft: ``s = |t| - half_width - expansion`` through :func:`_soft_edge_alpha`.
    """
    nx, ny = normal
    if nx == 0.0 and ny == 0.0:
        return np.zeros((height, width), dtype=np.float64)
    t = _signed_line_distance(width, height, origin_x, origin_y, nx, ny)
    if edge.hard:
        reach = half_width + edge.expansion
        if reach <= 0.0:
            return np.zeros((height, width), dtype=np.float64)
        u = min(abs(nx), abs(ny))
        v = max(abs(nx), abs(ny))
        return _footprint_cdf(reach - t, u, v) - _footprint_cdf(-reach - t, u, v)
    return _soft_edge_alpha(np.abs(t) - half_width - edge.expansion, edge)


def linear_gradient_alpha(
    width: int,
    height: int,
    start_x: float,
    start_y: float,
    end_x: float,
    end_y: float,
    curve: str,
) -> FloatArray:
    """Opaque at ``start``, clear at ``end`` (raster px), across the line joining them.

    ``p = ((c - start) . (end - start)) / |end - start|^2`` per pixel centre, then
    ``curve(clamp(1 - p, 0, 1))``. A gradient with no length draws nothing.
    """
    dx = end_x - start_x
    dy = end_y - start_y
    length2 = dx * dx + dy * dy
    if length2 == 0.0:
        return np.zeros((height, width), dtype=np.float64)
    xs, ys = _pixel_centres(width, height)
    p = ((xs - start_x) * dx + (ys - start_y) * dy) / length2
    x = np.minimum(np.maximum(1.0 - p, 0.0), 1.0)
    return apply_falloff(x, curve)


def radial_gradient_alpha(
    width: int,
    height: int,
    centre_x: float,
    centre_y: float,
    radius_x: float,
    radius_y: float,
    curve: str,
) -> FloatArray:
    """Opaque at the centre, clear at the radius (raster px; the radii differ only when the
    raster is scaled unevenly, so the gradient stays round in the SOURCE).

    ``p = sqrt(qx^2 + qy^2)`` with ``q = (c - centre) / radius`` per axis, then
    ``curve(clamp(1 - p, 0, 1))``. A gradient with no radius draws nothing.
    """
    if radius_x <= 0.0 or radius_y <= 0.0:
        return np.zeros((height, width), dtype=np.float64)
    xs, ys = _pixel_centres(width, height)
    qx = (xs - centre_x) / radius_x
    qy = (ys - centre_y) / radius_y
    p = np.sqrt(qx * qx + qy * qy)
    x = np.minimum(np.maximum(1.0 - p, 0.0), 1.0)
    return apply_falloff(x, curve)


@dataclass(frozen=True)
class AnalyticShape:
    """One analytic mask in SOURCE units, ready to rasterise through a raster mapping.

    ``kind`` is ``linear``, ``band`` or ``gradient``. Linear and band read ``origin_*``,
    ``angle``, ``softness`` (and band ``band_width``) plus the edge fields; a gradient reads
    ``gradient_shape``, ``start_*``, ``end_*`` and ``curve``.
    """

    kind: str
    origin_x: float = 0.0
    origin_y: float = 0.0
    angle: float = 0.0
    band_width: float = 0.0
    softness: float = 0.0
    expansion: float = 0.0
    feather_inner: float = 0.0
    feather_outer: float = 0.0
    falloff: str = "smooth"
    gradient_shape: str = "linear"
    start_x: float = 0.0
    start_y: float = 0.0
    end_x: float = 0.0
    end_y: float = 0.0
    curve: str = "linear"


def analytic_alpha(
    shape: AnalyticShape,
    width: int,
    height: int,
    *,
    scale_x: float,
    scale_y: float,
    offset_x: float,
    offset_y: float,
    distance_scale: float,
) -> FloatArray:
    """An analytic mask's alpha (before invert and opacity) on a ``width`` x ``height`` raster."""
    if width <= 0 or height <= 0:
        return np.zeros((max(height, 0), max(width, 0)), dtype=np.float64)
    if shape.kind == "gradient":
        sx = shape.start_x * scale_x + offset_x
        sy = shape.start_y * scale_y + offset_y
        if shape.gradient_shape == "radial":
            ddx = shape.end_x - shape.start_x
            ddy = shape.end_y - shape.start_y
            radius = math.sqrt(ddx * ddx + ddy * ddy)
            return radial_gradient_alpha(
                width, height, sx, sy, radius * scale_x, radius * scale_y, shape.curve
            )
        ex = shape.end_x * scale_x + offset_x
        ey = shape.end_y * scale_y + offset_y
        return linear_gradient_alpha(width, height, sx, sy, ex, ey, shape.curve)
    edge = analytic_edge(
        distance_scale,
        expansion=shape.expansion,
        feather_inner=shape.feather_inner,
        feather_outer=shape.feather_outer,
        softness=shape.softness,
        falloff=shape.falloff,
    )
    ox = shape.origin_x * scale_x + offset_x
    oy = shape.origin_y * scale_y + offset_y
    normal = raster_line_normal(shape.angle, scale_x, scale_y)
    if shape.kind == "linear":
        return linear_alpha(width, height, ox, oy, normal, edge)
    if shape.kind == "band":
        half_width = max(shape.band_width, 0.0) * distance_scale * 0.5
        return band_alpha(width, height, ox, oy, normal, half_width, edge)
    raise MaskRasterError(
        "A mask uses an analytic kind this renderer does not know. Update FramePilot."
    )
