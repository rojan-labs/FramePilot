"""Mask rasterization for compositing (PRD §6.5, plan Phase 5).

WHY: a mask limits a clip to a region (rectangle/ellipse/polygon), optionally
feathered and faded, so subjects can be isolated, spotlit, or hidden. This module
is the **pure rasterizer**: it turns a :class:`MaskSpec` (geometry in frame
fractions) into an alpha array the render compiler attaches to a clip. It is
deterministic (Pillow + numpy, no system fonts, no I/O) so it is golden-stable and
100% unit-testable; the only "render" dependency is Pillow, already used for
captions (no new dependency).

Mask params can be animated: a mask effect's keyframes drive
:func:`mask_spec_at`, which evaluates them per frame via the keyframe engine —
the compiler can then build a time-varying mask.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Any

import numpy as np

from framepilot_engine.effects.keyframes import evaluate_keyframes
from framepilot_engine.timeline.models import Effect, Keyframe

# Animatable mask properties (frame fractions, except opacity 0..1).
_ANIMATABLE = ("x", "y", "width", "height", "feather", "opacity")


@dataclass(frozen=True)
class MaskSpec:
    """A resolved mask at one instant. Geometry is in frame fractions (0..1)."""

    shape: str = "rectangle"
    x: float = 0.0
    y: float = 0.0
    width: float = 1.0
    height: float = 1.0
    feather: float = 0.0
    opacity: float = 1.0
    invert: bool = False
    points: tuple[tuple[float, float], ...] = field(default_factory=tuple)


def _clamp01(value: float) -> float:
    return 0.0 if value <= 0.0 else 1.0 if value >= 1.0 else value


def mask_spec_from_params(params: dict[str, Any]) -> MaskSpec:
    """Build a :class:`MaskSpec` from a mask effect's static ``params``."""
    bounds = params.get("bounds") or {}
    raw_points = params.get("points") or []
    points = tuple((float(p[0]), float(p[1])) for p in raw_points)
    return MaskSpec(
        shape=str(params.get("shape", "rectangle")),
        x=float(bounds.get("x", 0.0)),
        y=float(bounds.get("y", 0.0)),
        width=float(bounds.get("width", 1.0)),
        height=float(bounds.get("height", 1.0)),
        feather=float(params.get("feather", 0.0)),
        opacity=float(params.get("opacity", 1.0)),
        invert=bool(params.get("invert", False)),
        points=points,
    )


def mask_spec_at(effect: Effect, time: float) -> MaskSpec:
    """Resolve a mask effect's spec at clip-relative ``time``.

    Starts from the effect's static params, then overrides any animatable
    property (``x``/``y``/``width``/``height``/``feather``/``opacity``) that has
    keyframes — so a mask can move, grow, feather, or fade over the clip.
    """
    base = mask_spec_from_params(effect.params)
    keyframes: list[Keyframe] = list(effect.keyframes)
    if not keyframes:
        return base
    overrides: dict[str, Any] = {}
    for prop in _ANIMATABLE:
        value = evaluate_keyframes(keyframes, prop, time)
        if value is not None:
            overrides[prop] = value
    if not overrides:
        return base
    return replace(base, **overrides)


def has_mask_keyframes(effect: Effect) -> bool:
    """True if the mask effect animates any param via keyframes."""
    return any(k.property in _ANIMATABLE for k in effect.keyframes)


def rasterize_mask(spec: MaskSpec, width: int, height: int) -> np.ndarray:
    """Rasterize ``spec`` to a float alpha array of shape ``(height, width)``.

    Values are in ``[0, 1]``: 1 fully shows the clip, 0 fully hides it. Feather
    softens the edge with a Gaussian blur; ``invert`` keeps the outside instead;
    ``opacity`` scales the kept region. Deterministic for golden tests.
    """
    from PIL import Image, ImageDraw, ImageFilter

    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)

    if spec.shape == "polygon" and len(spec.points) >= 3:
        polygon = [(p[0] * width, p[1] * height) for p in spec.points]
        draw.polygon(polygon, fill=255)
    else:
        left = spec.x * width
        top = spec.y * height
        right = (spec.x + spec.width) * width
        bottom = (spec.y + spec.height) * height
        box = (left, top, max(left, right - 1), max(top, bottom - 1))
        if spec.shape == "ellipse":
            draw.ellipse(box, fill=255)
        else:  # rectangle (default)
            draw.rectangle(box, fill=255)

    if spec.feather > 0.0:
        radius = spec.feather * min(width, height)
        image = image.filter(ImageFilter.GaussianBlur(radius=radius))

    alpha = np.asarray(image, dtype=np.float64) / 255.0
    if spec.invert:
        alpha = 1.0 - alpha
    return alpha * _clamp01(spec.opacity)


# --- Schema v22 helpers -------------------------------------------------------------
#
# Schema v22 (ADR 0178) replaced the ``mask`` effect with ``Clip.masks``. The stack itself is
# drawn by ``render/mask_stack.py`` on the exact rasteriser (``render/mask_raster.py``);
# :func:`rasterize_mask` above stays as the ``gaussian-legacy`` path for migrated masks, and
# these helpers read v22 masks on the source clock for the renderer and temporal evidence.


def clip_source_clock(clip: Any) -> Callable[[float], float]:
    """Clip-relative timeline seconds → asset source seconds, as the speed stage plays it."""
    from framepilot_engine.effects.speed_curve import has_speed_ramp, source_time_at

    source_start = float(clip.source_start)
    source_end = float(clip.source_end if clip.source_end is not None else clip.source_start)
    if has_speed_ramp(clip):
        ramp = list(clip.speed_ramp or [])
        span = max(0.0, source_end - source_start)
        return lambda t: source_start + source_time_at(ramp, 0.0, t, span)
    speed = 1.0 if clip.speed is None else float(clip.speed)
    if speed == 0.0:
        return lambda _t: source_start
    if speed < 0.0:
        return lambda t: source_end + t * speed
    return lambda t: source_start + t * speed


def mask_scalar_at(mask: Any, property_name: str, source_time: float) -> float | None:
    """A mask's scalar property at a SOURCE instant: keyframed value, else the stored field."""
    points = [
        Keyframe(
            id=keyframe.id,
            time=keyframe.source_time,
            property=keyframe.property.value,
            value=keyframe.value,
            easing=keyframe.easing,
            handles=keyframe.handles,
        )
        for keyframe in mask.keyframes
        if keyframe.property.value == property_name
    ]
    if points:
        # A keyframe instant returns its stored value exactly. Interpolating to it
        # (``a + (b - a) * 1``) can land an ulp away, and a mask migrated from a speed-ramped
        # v21 clip stores one keyframe per rendered frame precisely so each frame reads the
        # exact v21 value.
        for point in points:
            if point.time == source_time:
                return point.value
        animated = evaluate_keyframes(points, property_name, source_time)
        if animated is not None:
            return animated
    value = getattr(mask, _mask_attribute(mask, property_name), None)
    return float(value) if isinstance(value, int | float) else None


def _mask_attribute(mask: Any, property_name: str) -> str:
    """The model attribute a camelCase mask property is stored in.

    WHY by alias and not a hand list: the list named only the two feathers, so a static
    ``expansionPx`` (and a matte's static ``edgeShiftPx``) read as absent and exported as 0
    while the editor and the preview drew them. Found by the MK3.2 preview parity vectors.
    """
    fields = getattr(type(mask), "model_fields", None)
    if isinstance(fields, dict):
        for name, info in fields.items():
            if getattr(info, "alias", None) == property_name:
                return str(name)
    return property_name


def mask_frame_box(
    mask: Any, media_size: tuple[float, float] | None, source_time: float
) -> tuple[float, float, float, float] | None:
    """A rectangle/ellipse mask's ``(x, y, width, height)`` as fractions of the source picture.

    Mirrors ``editor-core`` ``maskFrameBox``. ``None`` for other kinds, or for a pixel mask
    on media whose size is unknown.
    """
    if mask.kind not in ("rectangle", "ellipse"):
        return None
    if mask.units == "normalized":
        scale_w, scale_h = 1.0, 1.0
    elif media_size is None:
        return None
    else:
        scale_w, scale_h = float(media_size[0]), float(media_size[1])
    cx = mask_scalar_at(mask, "cx", source_time) or 0.0
    cy = mask_scalar_at(mask, "cy", source_time) or 0.0
    if mask.kind == "ellipse":
        width = (mask_scalar_at(mask, "rx", source_time) or 0.0) * 2.0
        height = (mask_scalar_at(mask, "ry", source_time) or 0.0) * 2.0
    else:
        width = mask_scalar_at(mask, "width", source_time) or 0.0
        height = mask_scalar_at(mask, "height", source_time) or 0.0
    return (
        (cx - width / 2.0) / scale_w,
        (cy - height / 2.0) / scale_h,
        width / scale_w,
        height / scale_h,
    )
