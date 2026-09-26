"""The shape rasteriser (schema v25, plan/elements EL4a, ADR 0190).

The only place a shape becomes pixels: the export composites this raster and the desktop monitor
draws the same raster fetched over ``POST /preview/text-raster`` (``kind: "shape"``), so the two
cannot disagree about a shape's look. Placement is :func:`shape_geometry.shape_bounds`, which the
frame plans mirror.

How it draws, deterministically and with Pillow alone:

- each part (the fill, the stroke) is a coverage mask drawn at 4x supersampling (fewer when the
  supersampled raster would pass 8192 px on a side) and box-averaged down with ``Image.reduce``;
- a solid stroke is the outline grown by half the stroke width minus the outline shrunk by it, so
  it is centred on the outline; a dashed stroke is dashes of 3w every 5w along the outline, a
  dotted one discs of diameter w every 2w; segment caps are drawn in the stroke's colour;
- a stroke along an outline piece is its segments with a disc at every turn (round joins);
- the coloured parts are composited stroke-over-fill in floating point with straight alpha and
  rounded once to 8 bits, so a translucent marker has clean edges instead of the dark fringe a
  straight-alpha downsample leaves.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import numpy as np
from PIL import Image, ImageChops, ImageDraw

from framepilot_engine.render.captions import _load_font
from framepilot_engine.render.shape_catalog import is_shape_label
from framepilot_engine.render.shape_geometry import (
    ARROW_HALF_WIDTH,
    BAR_HALF_LENGTH,
    DOT_RADIUS,
    Point,
    ResolvedShape,
    ShapeBounds,
    Subpath,
    arrow_head_length,
    box_outline,
    box_subpaths,
    resolve_shape,
    segment_control,
    segment_polyline,
    shape_bounds,
)
from framepilot_engine.render.text_overlay import _basic_features

#: Supersampling factor for anti-aliasing.
SUPERSAMPLE = 4
#: The largest supersampled raster side: a shape bigger than this draws at a lower factor.
MAX_SUPERSAMPLED_SIDE = 8192
#: How far a flattened curve may stray from the true curve, in supersampled pixels.
FLATTEN_TOLERANCE = 0.25
#: Dash pattern, in stroke widths.
DASH_ON = 3.0
DASH_OFF = 2.0
#: Dot spacing, in stroke widths.
DOT_SPACING = 2.0
#: Lines this wide (supersampled pixels) or thinner are drawn without round joins, as Pillow's
#: ``line(joint="curve")`` draws them.
JOINLESS_MAX_WIDTH = 4
#: A badge label's face: the title default (Inter, bold), through the title rasteriser's loader.
LABEL_FAMILY = "Inter"
LABEL_WEIGHT = 700
#: The label's font size as a fraction of the box's shorter side, and the widest it may run as a
#: fraction of the box's width (a long label shrinks to fit rather than spilling out).
LABEL_SIZE = 0.56
LABEL_MAX_WIDTH = 0.78
#: A label's colour when the shape names none.
LABEL_DEFAULT_COLOR = "#FFFFFF"

Mask = Image.Image


def _hex_rgba(colour: str) -> tuple[float, float, float, float]:
    value = colour.lstrip("#")
    red, green, blue = int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    alpha = int(value[6:8], 16) if len(value) == 8 else 255
    return red / 255, green / 255, blue / 255, alpha / 255


def _supersample(bounds: ShapeBounds) -> int:
    side = max(bounds.width, bounds.height)
    return max(1, min(SUPERSAMPLE, MAX_SUPERSAMPLED_SIDE // side))


class _Canvas:
    """Maps frame pixels onto the supersampled raster and draws coverage masks."""

    def __init__(self, bounds: ShapeBounds, scale: int) -> None:
        self.bounds = bounds
        self.scale = scale
        self.size = (bounds.width * scale, bounds.height * scale)

    def point(self, frame: Point) -> Point:
        # Unshifted: Pillow truncates a float coordinate and fills the pixel it lands in, so an
        # edge at ``a`` fills from pixel ``floor(a)`` — on average centred where the geometry is.
        # A half-pixel "centre" shift would bias every shape up and to the left.
        return (
            (frame[0] - self.bounds.x) * self.scale,
            (frame[1] - self.bounds.y) * self.scale,
        )

    def mask(self, draw: Callable[[ImageDraw.ImageDraw], None]) -> Mask:
        image = Image.new("L", self.size, 0)
        draw(ImageDraw.Draw(image))
        return image

    def polygon(self, outline: Sequence[Point]) -> Mask:
        points = [self.point(p) for p in outline]
        if len(points) < 3:
            return Image.new("L", self.size, 0)
        return self.mask(lambda d: d.polygon(points, fill=255))


def _round_joined_line(draw: ImageDraw.ImageDraw, points: Sequence[Point], width: int) -> None:
    """A wide polyline with a round join at every turn: Pillow's ``line(joint="curve")``, cheaper.

    Pillow joins each turning vertex with a pieslice, plus two patch lines for the slivers the
    pieslice's straight edges leave, in Python per vertex. A curve flattens to hundreds of
    vertices, so an outline icon paid for hundreds of them: the grape icon's ~740 were most of the
    slowest raster in the catalogue. Here each join is the whole disc that pieslice is cut from
    (the same bounding box, so the same arc): it covers those slivers itself, and the rest of it is
    within half a stroke of the vertex, so inside the stroke anyway. The segments are Pillow's own
    single ``draw_lines`` call, as before.
    """
    draw.line(points, fill=255, width=width)
    if width <= JOINLESS_MAX_WIDTH:
        return
    radius = width / 2 - 1
    for (ax, ay), (x, y), (bx, by) in zip(points, points[1:], points[2:], strict=False):
        in_x, in_y, out_x, out_y = x - ax, y - ay, bx - x, by - y
        if in_x * out_y == in_y * out_x and in_x * out_x + in_y * out_y > 0:
            continue  # straight on: the two segments already meet edge to edge
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)


def _path_length(points: Sequence[Point]) -> list[float]:
    lengths = [0.0]
    for (ax, ay), (bx, by) in itertools.pairwise(points):
        lengths.append(lengths[-1] + math.hypot(bx - ax, by - ay))
    return lengths


def _point_at(points: Sequence[Point], lengths: Sequence[float], distance: float) -> Point:
    for index in range(1, len(points)):
        if lengths[index] >= distance:
            span = lengths[index] - lengths[index - 1]
            t = 0.0 if span == 0 else (distance - lengths[index - 1]) / span
            (ax, ay), (bx, by) = points[index - 1], points[index]
            return (ax + (bx - ax) * t, ay + (by - ay) * t)
    return points[-1]


def _sub_path(
    points: Sequence[Point], lengths: Sequence[float], start: float, end: float
) -> list[Point]:
    inner = [p for p, at in zip(points, lengths, strict=True) if start < at < end]
    return [_point_at(points, lengths, start), *inner, _point_at(points, lengths, end)]


def _stroke_path(canvas: _Canvas, path: Sequence[Point], width: float, style: str) -> Mask:
    """A dashed or dotted stroke along an open ``path`` (frame pixels)."""
    points = [canvas.point(p) for p in path]
    lengths = _path_length(points)
    total = lengths[-1]
    w = width * canvas.scale
    line_width = max(1, round(w))

    def draw(d: ImageDraw.ImageDraw) -> None:
        if style == "dotted":
            radius = w / 2
            distance = 0.0
            while distance <= total:
                x, y = _point_at(points, lengths, distance)
                d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
                distance += DOT_SPACING * w
            return
        on, period = DASH_ON * w, (DASH_ON + DASH_OFF) * w
        distance = 0.0
        while distance < total:
            segment = _sub_path(points, lengths, distance, min(total, distance + on))
            _round_joined_line(d, segment, line_width)
            distance += period

    return canvas.mask(draw)


def _filled(canvas: _Canvas, subpaths: Sequence[Subpath], even_odd: bool) -> Mask:
    """The closed pieces filled: their union, or with even-odd holes (a ring, a frame)."""
    mask: Mask | None = None
    for points, closed in subpaths:
        if not closed or len(points) < 3:
            continue
        piece = canvas.polygon(points)
        if mask is None:
            mask = piece
        else:
            mask = (
                ImageChops.difference(mask, piece) if even_odd else ImageChops.lighter(mask, piece)
            )
    return mask if mask is not None else Image.new("L", canvas.size, 0)


def _stroked(
    canvas: _Canvas, subpaths: Sequence[Subpath], width: float, style: str, round_caps: bool
) -> Mask:
    """Every piece stroked along its centre line: round joins, and round or butt open ends."""
    if style != "solid":
        masks = [
            _stroke_path(canvas, [*points, points[0]] if closed else list(points), width, style)
            for points, closed in subpaths
            if len(points) > 1
        ]
        mask = masks[0] if masks else Image.new("L", canvas.size, 0)
        for other in masks[1:]:
            mask = ImageChops.lighter(mask, other)
        return mask
    w = width * canvas.scale
    line_width = max(1, round(w))

    def draw(d: ImageDraw.ImageDraw) -> None:
        for points, closed in subpaths:
            if len(points) < 2:
                continue
            mapped = [canvas.point(p) for p in points]
            if closed:
                mapped.append(mapped[0])
            _round_joined_line(d, mapped, line_width)
            ends = mapped[:1] if closed else [mapped[0], mapped[-1]]
            if round_caps or closed:
                for x, y in ends:
                    d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=255)

    return canvas.mask(draw)


def _box_masks(shape: ResolvedShape, canvas: _Canvas) -> tuple[Mask | None, Mask | None]:
    tolerance = FLATTEN_TOLERANCE / canvas.scale
    if shape.descriptor.generator not in ("rect", "ellipse"):
        # Every other generator is outline pieces: polygons, stars, rings, bubbles, corners and
        # paths (icons among them), filled by their rule and stroked along their centre lines.
        subpaths = box_subpaths(shape, tolerance)
        geometry = shape.descriptor.geometry
        even_odd = geometry.get("fillRule") == "evenodd"
        fill_mask = _filled(canvas, subpaths, even_odd) if shape.fill is not None else None
        if shape.stroke is None:
            return fill_mask, None
        style = str(shape.params.get("strokeStyle", "solid"))
        round_caps = bool(geometry.get("roundCaps"))
        return fill_mask, _stroked(canvas, subpaths, shape.stroke_width, style, round_caps)
    fill = canvas.polygon(box_outline(shape, 0.0, tolerance)) if shape.fill is not None else None
    if shape.stroke is None:
        return fill, None
    half = shape.stroke_width / 2
    style = str(shape.params.get("strokeStyle", "solid"))
    if style == "solid":
        # The ring: the outline grown by half the stroke, with the outline shrunk by half punched
        # out of the same mask (one image, no subtraction pass).
        outer = [canvas.point(p) for p in box_outline(shape, half, tolerance)]
        inner = [canvas.point(p) for p in box_outline(shape, -half, tolerance)]

        def ring(d: ImageDraw.ImageDraw) -> None:
            d.polygon(outer, fill=255)
            if len(inner) >= 3:
                d.polygon(inner, fill=0)

        return fill, canvas.mask(ring)
    outline = box_outline(shape, 0.0, tolerance)
    return fill, _stroke_path(canvas, [*outline, outline[0]], shape.stroke_width, style)


def _unit(a: Point, b: Point) -> tuple[float, float]:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    return (dx / length, dy / length) if length > 0 else (1.0, 0.0)


def _curved_segment_mask(shape: ResolvedShape, canvas: _Canvas) -> Mask:
    """A curved line or arrow: the flattened curve, with caps along its end tangents."""
    polyline = segment_polyline(shape, FLATTEN_TOLERANCE / canvas.scale)
    w = shape.stroke_width
    head = arrow_head_length(shape)
    start_cap = str(shape.params.get("startCap", "none"))
    end_cap = str(shape.params.get("endCap", "none"))
    style = str(shape.params.get("strokeStyle", "solid"))

    def trimmed(points: list[Point], cut: float) -> list[Point]:
        # Drop the first `cut` pixels of arc length, so a head's base meets the line.
        remaining = cut
        while len(points) > 2:
            step = math.dist(points[0], points[1])
            if step > remaining:
                ux, uy = _unit(points[0], points[1])
                return [(points[0][0] + ux * remaining, points[0][1] + uy * remaining), *points[1:]]
            remaining -= step
            points = points[1:]
        return points

    body = list(polyline)
    if start_cap == "arrow":
        body = trimmed(body, head * 0.9)
    if end_cap == "arrow":
        body = list(reversed(trimmed(list(reversed(body)), head * 0.9)))
    line = _stroked(canvas, [(body, False)], w, style, round_caps=False)
    start_dir = _unit(polyline[1], polyline[0])
    end_dir = _unit(polyline[-2], polyline[-1])
    caps = _caps_mask(
        canvas,
        shape,
        ((start_cap, polyline[0], start_dir), (end_cap, polyline[-1], end_dir)),
    )
    return ImageChops.lighter(line, caps)


def _caps_mask(
    canvas: _Canvas,
    shape: ResolvedShape,
    caps: Sequence[tuple[str, Point, tuple[float, float]]],
) -> Mask:
    """Caps drawn at tips, each pointing along its outward direction."""
    w = shape.stroke_width
    head = arrow_head_length(shape)

    def draw(d: ImageDraw.ImageDraw) -> None:
        for cap, tip, (ux, uy) in caps:
            if cap == "arrow":
                base = (tip[0] - ux * head, tip[1] - uy * head)
                half = head * ARROW_HALF_WIDTH
                triangle = [
                    tip,
                    (base[0] - uy * half, base[1] + ux * half),
                    (base[0] + uy * half, base[1] - ux * half),
                ]
                d.polygon([canvas.point(p) for p in triangle], fill=255)
            elif cap == "dot":
                cx, cy = canvas.point(tip)
                r = DOT_RADIUS * w * canvas.scale
                d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
            elif cap == "bar":
                half = BAR_HALF_LENGTH * w
                a = canvas.point((tip[0] - uy * half, tip[1] + ux * half))
                b = canvas.point((tip[0] + uy * half, tip[1] - ux * half))
                d.line([a, b], fill=255, width=max(1, round(w * canvas.scale)))

    return canvas.mask(draw)


def _segment_mask(shape: ResolvedShape, canvas: _Canvas) -> Mask:
    assert shape.ends is not None
    if segment_control(shape) is not None:
        return _curved_segment_mask(shape, canvas)
    start, end = shape.ends
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    ux, uy = (dx / length, dy / length) if length > 0 else (1.0, 0.0)
    w = shape.stroke_width
    head = arrow_head_length(shape)
    start_cap = str(shape.params.get("startCap", "none"))
    end_cap = str(shape.params.get("endCap", "none"))
    # The line stops where an arrow head's base begins, so it never pokes through the tip.
    line_start = (
        (start[0] + ux * head * 0.9, start[1] + uy * head * 0.9) if start_cap == "arrow" else start
    )
    line_end = (end[0] - ux * head * 0.9, end[1] - uy * head * 0.9) if end_cap == "arrow" else end
    style = str(shape.params.get("strokeStyle", "solid"))

    def caps(d: ImageDraw.ImageDraw) -> None:
        for cap, tip, sign in ((start_cap, start, -1.0), (end_cap, end, 1.0)):
            if cap == "arrow":
                base = (tip[0] - sign * ux * head, tip[1] - sign * uy * head)
                half = head * ARROW_HALF_WIDTH
                triangle = [
                    tip,
                    (base[0] - uy * half, base[1] + ux * half),
                    (base[0] + uy * half, base[1] - ux * half),
                ]
                d.polygon([canvas.point(p) for p in triangle], fill=255)
            elif cap == "dot":
                cx, cy = canvas.point(tip)
                r = DOT_RADIUS * w * canvas.scale
                d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
            elif cap == "bar":
                half = BAR_HALF_LENGTH * w
                a = canvas.point((tip[0] - uy * half, tip[1] + ux * half))
                b = canvas.point((tip[0] + uy * half, tip[1] - ux * half))
                d.line([a, b], fill=255, width=max(1, round(w * canvas.scale)))

    cap_mask = canvas.mask(caps)
    if style != "solid":
        return ImageChops.lighter(
            _stroke_path(canvas, [line_start, line_end], w, style),
            cap_mask,
        )
    half = w / 2
    body = [
        (line_start[0] - uy * half, line_start[1] + ux * half),
        (line_end[0] - uy * half, line_end[1] + ux * half),
        (line_end[0] + uy * half, line_end[1] - ux * half),
        (line_start[0] + uy * half, line_start[1] - ux * half),
    ]
    return ImageChops.lighter(canvas.polygon(body), cap_mask)


def _label_mask(shape: ResolvedShape, canvas: _Canvas) -> Mask | None:
    """A badge's label, centred on its ink in the shape's box (plan/elements EL5.4), or ``None``."""
    label = shape.params.get("label")
    if shape.box is None or not is_shape_label(label):
        return None
    left, top, right, bottom = shape.box
    width, height = right - left, bottom - top
    size = max(1, round(min(width, height) * LABEL_SIZE * canvas.scale))
    font = _load_font(LABEL_FAMILY, size, LABEL_WEIGHT)
    features = _basic_features(font)
    probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    bbox = probe.textbbox((0, 0), label, font=font, features=features)
    room = width * LABEL_MAX_WIDTH * canvas.scale
    if bbox[2] - bbox[0] > room:
        size = max(1, math.floor(size * room / (bbox[2] - bbox[0])))
        font = _load_font(LABEL_FAMILY, size, LABEL_WEIGHT)
        bbox = probe.textbbox((0, 0), label, font=font, features=features)
    cx, cy = canvas.point(((left + right) / 2, (top + bottom) / 2))
    origin = (cx - (bbox[0] + bbox[2]) / 2, cy - (bbox[1] + bbox[3]) / 2)
    return canvas.mask(
        lambda draw: draw.text(origin, label, font=font, fill=255, features=features)
    )


def _coverage(mask: Mask | None, scale: int) -> np.ndarray | None:
    if mask is None:
        return None
    reduced = mask.reduce(scale) if scale > 1 else mask
    return np.asarray(reduced, dtype=np.float32) * np.float32(1 / 255)


def _composite(
    size: tuple[int, int], parts: Sequence[tuple[np.ndarray | None, str | None]]
) -> Image.Image:
    """Composite coloured coverage masks back to front into a straight-alpha RGBA image.

    Accumulates premultiplied colour (each part a constant colour times its coverage) and
    un-premultiplies once, so a translucent edge keeps its colour instead of darkening. Each
    channel is its own contiguous plane: broadcasting over a trailing channel axis is several
    times slower at 4K.
    """
    width, height = size
    planes = [np.zeros((height, width), dtype=np.float32) for _ in range(3)]
    alpha = np.zeros((height, width), dtype=np.float32)
    for coverage, colour in parts:
        if coverage is None or colour is None:
            continue
        *channels, opacity = _hex_rgba(colour)
        a = coverage * np.float32(opacity)
        keep = 1 - a
        for plane, value in zip(planes, channels, strict=True):
            plane *= keep
            plane += a * np.float32(value)
        alpha *= keep
        alpha += a
    covered = alpha > 0
    safe = np.where(covered, alpha, np.float32(1))

    def to_byte(plane: np.ndarray) -> Image.Image:
        return Image.fromarray(np.rint(np.clip(plane, 0, 1) * 255).astype(np.uint8), "L")

    bands = [to_byte(np.where(covered, plane / safe, np.float32(0))) for plane in planes]
    return Image.merge("RGBA", [*bands, to_byte(alpha)])


def rasterize_shape(
    params: Mapping[str, Any], width: int, height: int, *, rotates: bool = False
) -> tuple[Image.Image, ShapeBounds]:
    """Draw a shape for a ``width`` x ``height`` frame.

    :param rotates: the clip animates ``rotation``: draw into the rotation-safe square bounds.
    :returns: the straight-alpha RGBA raster and the frame-pixel rectangle it covers (the raster
        is exactly ``bounds.width`` x ``bounds.height``).
    """
    shape = resolve_shape(params, width, height)
    bounds = shape_bounds(params, width, height, rotates=rotates)
    scale = _supersample(bounds)
    canvas = _Canvas(bounds, scale)
    if shape.box is not None:
        fill_mask, stroke_mask = _box_masks(shape, canvas)
    else:
        fill_mask, stroke_mask = None, _segment_mask(shape, canvas)
    label_colour = params.get("labelColor")
    image = _composite(
        (bounds.width, bounds.height),
        [
            (_coverage(fill_mask, scale), shape.fill),
            (_coverage(stroke_mask, scale), shape.stroke),
            (
                _coverage(_label_mask(shape, canvas), scale),
                label_colour if isinstance(label_colour, str) else LABEL_DEFAULT_COLOR,
            ),
        ],
    )
    return image, bounds
