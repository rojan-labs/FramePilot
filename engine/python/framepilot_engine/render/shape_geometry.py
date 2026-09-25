"""Shape geometry: a shape clip's params → frame pixels (schema v25, plan/elements EL4a, ADR 0190).

The engine is the only shape rasteriser (``render/shape_raster.py``), so this is the only place
the outlines are computed. What the frame plans need — the pixel rectangle the raster covers — is
:func:`shape_bounds`, plain arithmetic mirrored by ``shapeBounds`` in
``packages/editor-core/src/shape-geometry.ts`` and pinned by the frame-plan vectors.

Units (``timeline-schema/src/shape-params.ts``): a box centre is a percent of each frame axis, a
box size and the stroke width a percent of the frame HEIGHT, segment ends a percent of each axis.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from framepilot_engine.render.shape_catalog import (
    SHAPE_EFFECT_TYPE,
    ShapeDescriptor,
    knob_value,
    shape_descriptor,
    shape_params_problem,
)
from framepilot_engine.timeline.models import Clip
from framepilot_engine.timeline.synthetic_assets import synthetic_clip_kind

_log = logging.getLogger(__name__)

#: Anti-aliasing margin around a shape's outline, in output pixels.
BOUNDS_MARGIN = 1.0
#: An arrow head's half-width as a fraction of its length.
ARROW_HALF_WIDTH = 0.5
#: A bar cap's half-length as a multiple of the stroke width.
BAR_HALF_LENGTH = 2.0
#: A dot cap's radius as a multiple of the stroke width.
DOT_RADIUS = 1.0

Point = tuple[float, float]


@dataclass(frozen=True)
class ShapeBounds:
    """The integer pixel rectangle a shape's raster covers, in frame pixels, before transform."""

    x: int
    y: int
    width: int
    height: int

    @property
    def centre(self) -> Point:
        return (self.x + self.width / 2, self.y + self.height / 2)

    def to_json(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}


@dataclass(frozen=True)
class ResolvedShape:
    """A shape's params resolved to frame pixels: what the rasteriser draws."""

    descriptor: ShapeDescriptor
    params: Mapping[str, Any]
    #: Box: (left, top, right, bottom). Segment: unused.
    box: tuple[float, float, float, float] | None
    #: Segment: the two ends. Box: unused.
    ends: tuple[Point, Point] | None
    stroke_width: float
    stroke: str | None
    fill: str | None


def shape_clip_params(clip: Clip) -> Mapping[str, Any] | None:
    """A shape clip's params when it can be drawn, else ``None``.

    The patch validator refuses a shape that cannot be drawn, so ``None`` here means a file edited
    by hand or by a newer build; the frame plan and the export both skip it, and say so.
    """
    if synthetic_clip_kind(clip.asset_id) != "shape":
        return None
    effect = next((e for e in clip.effects if e.type == SHAPE_EFFECT_TYPE), None)
    if effect is None:
        _log.warning("Shape clip %s has no shape effect; it is not drawn.", clip.id)
        return None
    problem = shape_params_problem(effect.params)
    if problem is not None:
        _log.warning("Shape clip %s is not drawn: %s", clip.id, problem)
        return None
    return effect.params


def _descriptor(params: Mapping[str, Any]) -> ShapeDescriptor:
    descriptor = shape_descriptor(str(params.get("shape")))
    if descriptor is None:
        raise ValueError(
            f"There is no shape called '{params.get('shape')}'. Pick one from the Shapes tab."
        )
    return descriptor


def resolve_shape(params: Mapping[str, Any], width: int, height: int) -> ResolvedShape:
    """Resolve ``params`` to frame pixels for a ``width`` x ``height`` frame."""
    descriptor = _descriptor(params)
    stroke = params.get("stroke")
    stroke_width = height * float(params["strokeWidth"]) / 100 if stroke is not None else 0.0
    if descriptor.frame == "box":
        cx = width * float(params["x"]) / 100
        cy = height * float(params["y"]) / 100
        half_w = height * float(params["width"]) / 100 / 2
        half_h = height * float(params["height"]) / 100 / 2
        return ResolvedShape(
            descriptor=descriptor,
            params=params,
            box=(cx - half_w, cy - half_h, cx + half_w, cy + half_h),
            ends=None,
            stroke_width=stroke_width,
            stroke=stroke,
            fill=params.get("fill"),
        )
    start = (width * float(params["x1"]) / 100, height * float(params["y1"]) / 100)
    end = (width * float(params["x2"]) / 100, height * float(params["y2"]) / 100)
    return ResolvedShape(
        descriptor=descriptor,
        params=params,
        box=None,
        ends=(start, end),
        stroke_width=stroke_width,
        # A segment is drawn by its stroke; a fill has nothing to enclose.
        stroke=stroke,
        fill=None,
    )


def arrow_head_length(shape: ResolvedShape) -> float:
    """How long an arrow cap is, in frame pixels (``headSize`` x the stroke width)."""
    if shape.descriptor.knob("headSize") is None:
        return 4.0 * shape.stroke_width
    return knob_value(shape.descriptor, shape.params, "headSize") * shape.stroke_width


def _cap_reach(shape: ResolvedShape, cap: str) -> float:
    """How far a cap reaches sideways from the segment's axis, in frame pixels."""
    if cap == "arrow":
        return arrow_head_length(shape) * ARROW_HALF_WIDTH
    if cap == "dot":
        return DOT_RADIUS * shape.stroke_width
    if cap == "bar":
        return BAR_HALF_LENGTH * shape.stroke_width
    return shape.stroke_width / 2


def shape_bounds(
    params: Mapping[str, Any], width: int, height: int, *, rotates: bool = False
) -> ShapeBounds:
    """The integer rectangle a shape's raster covers: its outline, stroke, caps and a margin.

    :param rotates: the clip animates ``rotation``. The export rotates a layer inside its own box
        (``expand=False``), so a rotating shape gets a square raster as wide as its diagonal,
        centred on the same point: every angle then fits and nothing is clipped.
    """
    shape = resolve_shape(params, width, height)
    if shape.box is not None:
        left, top, right, bottom = shape.box
        pad = shape.stroke_width / 2 + BOUNDS_MARGIN
    else:
        assert shape.ends is not None
        (x1, y1), (x2, y2) = shape.ends
        left, top, right, bottom = min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)
        reach = max(
            shape.stroke_width / 2,
            _cap_reach(shape, str(params.get("startCap", "none"))),
            _cap_reach(shape, str(params.get("endCap", "none"))),
        )
        pad = reach + BOUNDS_MARGIN
    left, top, right, bottom = left - pad, top - pad, right + pad, bottom + pad
    if rotates:
        half = math.hypot(right - left, bottom - top) / 2
        centre_x, centre_y = (left + right) / 2, (top + bottom) / 2
        left, top, right, bottom = (
            centre_x - half,
            centre_y - half,
            centre_x + half,
            centre_y + half,
        )
    x0 = math.floor(left)
    y0 = math.floor(top)
    return ShapeBounds(
        x=x0,
        y=y0,
        width=max(1, math.ceil(right) - x0),
        height=max(1, math.ceil(bottom) - y0),
    )


# --- outlines ------------------------------------------------------------------------------


def _arc_steps(radius: float, sweep: float, tolerance: float) -> int:
    """Chords for an arc of ``radius`` so no chord strays more than ``tolerance`` from it."""
    if radius <= tolerance:
        return 1
    step = 2 * math.acos(max(-1.0, 1 - tolerance / radius))
    return max(1, math.ceil(sweep / step))


def rounded_rect_outline(
    box: tuple[float, float, float, float], radius: float, tolerance: float
) -> list[Point]:
    """A closed outline (first point not repeated) of a box with rounded corners."""
    left, top, right, bottom = box
    radius = max(0.0, min(radius, (right - left) / 2, (bottom - top) / 2))
    if radius == 0:
        return [(left, top), (right, top), (right, bottom), (left, bottom)]
    steps = _arc_steps(radius, math.pi / 2, tolerance)
    corners = (
        (right - radius, top + radius, -math.pi / 2),
        (right - radius, bottom - radius, 0.0),
        (left + radius, bottom - radius, math.pi / 2),
        (left + radius, top + radius, math.pi),
    )
    points: list[Point] = []
    for cx, cy, start in corners:
        for index in range(steps + 1):
            angle = start + (math.pi / 2) * index / steps
            points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return points


def ellipse_outline(box: tuple[float, float, float, float], tolerance: float) -> list[Point]:
    """A closed outline of the ellipse inscribed in ``box``."""
    left, top, right, bottom = box
    cx, cy = (left + right) / 2, (top + bottom) / 2
    rx, ry = (right - left) / 2, (bottom - top) / 2
    steps = max(8, _arc_steps(max(rx, ry), 2 * math.pi, tolerance))
    return [
        (cx + rx * math.cos(2 * math.pi * i / steps), cy + ry * math.sin(2 * math.pi * i / steps))
        for i in range(steps)
    ]


def box_outline(shape: ResolvedShape, grow: float, tolerance: float) -> list[Point]:
    """The box shape's outline grown outward by ``grow`` pixels (negative shrinks)."""
    assert shape.box is not None
    left, top, right, bottom = shape.box
    grown = (left - grow, top - grow, right + grow, bottom + grow)
    if grown[2] <= grown[0] or grown[3] <= grown[1]:
        return []
    generator = shape.descriptor.generator
    if generator == "ellipse":
        return ellipse_outline(grown, tolerance)
    if generator == "rect":
        corner = knob_value(shape.descriptor, shape.params, "cornerRadius") / 100
        radius = min(right - left, bottom - top) * corner + grow
        return rounded_rect_outline(grown, radius, tolerance)
    raise ValueError(
        f"Shape '{shape.descriptor.id}' has a generator this build cannot draw. Update FramePilot."
    )
