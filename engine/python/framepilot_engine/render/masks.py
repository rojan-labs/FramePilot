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


# --- Schema v22 mask stack → this rasteriser (interim, until MK2) --------------------
#
# Schema v22 (ADR 0178) replaced the ``mask`` effect with ``Clip.masks``: geometry in
# display-corrected source pixels, keyframes on the asset's SOURCE clock. The exact
# stack rasteriser (``render/mask_stack.py``) is MK2. Until it lands, the one shape this
# module has always drawn — a single rectangle, ellipse or polygon, hard or Gaussian-
# feathered, cutting clip alpha — is mapped back onto :class:`MaskSpec`, so every
# migrated v21 project renders the picture it rendered before. Anything this rasteriser
# cannot draw faithfully is REFUSED with :class:`UnsupportedMaskStack` rather than drawn
# approximately: a mask that silently renders differently from the editor is worse than
# an export that says why it stopped.

#: Remedy shared by every interim refusal.
_MK2_REMEDY = "This mask renders once the mask rasteriser ships; disable it to export now."


class UnsupportedMaskStack(ValueError):
    """The clip's mask stack uses something the interim renderer cannot draw faithfully."""


def _media_scale(
    mask: Any, media_size: tuple[int, int] | None, clip_id: str
) -> tuple[float, float]:
    if getattr(mask, "units", None) == "normalized":
        return (1.0, 1.0)
    if media_size is None:
        raise UnsupportedMaskStack(
            f"Mask {mask.id!r} on clip {clip_id!r} is stored in source pixels but the media "
            "size is unknown. Measure this media first."
        )
    return (float(media_size[0]), float(media_size[1]))


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


@dataclass(frozen=True)
class LegacyMask:
    """A v22 alpha mask expressed as this module's frame-fraction :class:`MaskSpec`."""

    spec_at: Callable[[float], MaskSpec]
    """The spec at CLIP-RELATIVE timeline seconds (what ``_attach_mask`` asks for)."""
    animated: bool


def legacy_mask_for_clip(clip: Any, media_size: tuple[int, int] | None) -> LegacyMask | None:
    """Map a clip's v22 mask stack onto the v21 rasteriser, or ``None`` when nothing cuts.

    :param clip: The clip (a :class:`~framepilot_engine.timeline.models.Clip`).
    :param media_size: The asset's probed ``(width, height)``, or ``None`` when unmeasured.
    :raises UnsupportedMaskStack: When the enabled stack needs the MK2 rasteriser.
    """
    enabled = [mask for mask in (getattr(clip, "masks", None) or []) if mask.enabled]
    if not enabled:
        return None
    if len(enabled) > 1:
        raise UnsupportedMaskStack(
            f"Clip {clip.id!r} has more than one enabled mask. {_MK2_REMEDY}"
        )
    mask = enabled[0]
    _assert_interim_drawable(mask, clip.id)
    scale_w, scale_h = _media_scale(mask, media_size, clip.id)
    crop = clip.crop
    crop_x, crop_y = (crop.x, crop.y) if crop is not None else (0.0, 0.0)
    crop_w, crop_h = (crop.width, crop.height) if crop is not None else (1.0, 1.0)
    feather_scale = 1.0 if mask.units == "normalized" else min(crop_w * scale_w, crop_h * scale_h)

    def fx(px: float) -> float:
        return (px / scale_w - crop_x) / crop_w

    def fy(py: float) -> float:
        return (py / scale_h - crop_y) / crop_h

    by_property: dict[str, list[Keyframe]] = {}
    for keyframe in mask.keyframes:
        by_property.setdefault(keyframe.property.value, []).append(
            Keyframe(
                id=keyframe.id,
                time=keyframe.source_time,
                property=keyframe.property.value,
                value=keyframe.value,
                easing=keyframe.easing,
                handles=keyframe.handles,
            )
        )
    clock = clip_source_clock(clip)

    def value(name: str, source_time: float) -> float:
        points = by_property.get(name)
        if points:
            animated = evaluate_keyframes(points, name, source_time)
            if animated is not None:
                return animated
        return float(getattr(mask, _FIELD_BY_PROPERTY.get(name, name)))

    def spec_at(t: float) -> MaskSpec:
        s = clock(t)
        opacity = value("opacity", s)
        feather = value("featherOuterPx", s) / feather_scale if feather_scale > 0 else 0.0
        common = {"feather": feather, "opacity": opacity, "invert": mask.invert}
        if mask.kind == "path":
            keyframe = mask.path_keyframes[0]
            coords = keyframe.points
            points = tuple((fx(coords[i]), fy(coords[i + 1])) for i in range(0, len(coords), 6))
            return MaskSpec(shape="polygon", points=points, **common)
        cx = value("cx", s)
        cy = value("cy", s)
        if mask.kind == "ellipse":
            width = value("rx", s) * 2.0
            height = value("ry", s) * 2.0
        else:
            width = value("width", s)
            height = value("height", s)
        return MaskSpec(
            shape=mask.kind,
            x=fx(cx - width / 2.0),
            y=fy(cy - height / 2.0),
            width=width / scale_w / crop_w,
            height=height / scale_h / crop_h,
            **common,
        )

    return LegacyMask(spec_at=spec_at, animated=bool(mask.keyframes))


#: Snake-case model attribute for each camelCase keyframe property the interim reads.
_FIELD_BY_PROPERTY = {"featherOuterPx": "feather_outer_px"}

_INTERIM_PROPERTIES = frozenset(
    {"opacity", "featherOuterPx", "cx", "cy", "width", "height", "rx", "ry"}
)


def _assert_interim_drawable(mask: Any, clip_id: str) -> None:
    reasons: list[str] = []
    if mask.kind not in ("rectangle", "ellipse", "path"):
        reasons.append(f"kind {mask.kind!r}")
    if mask.target.kind != "alpha":
        reasons.append("an effect target")
    if mask.space != "source":
        reasons.append("frame space")
    if mask.mode != "add":
        reasons.append(f"mode {mask.mode.value!r}")
    if mask.expansion_px != 0 or mask.feather_inner_px != 0:
        reasons.append("expansion or inner feather")
    if mask.tracking is not None:
        reasons.append("a transform track")
    if mask.feather_model == "distance" and (
        mask.feather_outer_px != 0
        or any(keyframe.property.value == "featherOuterPx" for keyframe in mask.keyframes)
    ):
        # Only ``gaussian-legacy`` is the blur this module draws; a distance feather drawn
        # as a blur would export a different edge than the editor promises.
        reasons.append("a distance feather")
    if getattr(mask, "rotation", 0.0) != 0 or getattr(mask, "roundness", 0.0) != 0:
        reasons.append("rotation or roundness")
    if any(keyframe.property.value not in _INTERIM_PROPERTIES for keyframe in mask.keyframes):
        reasons.append("an animated property the interim renderer cannot draw")
    if mask.kind == "path":
        if len(mask.path_keyframes) != 1:
            reasons.append("an animated path")
        elif any(
            value != 0
            for keyframe in mask.path_keyframes
            for index, value in enumerate(keyframe.points)
            if index % 6 >= 2
        ):
            reasons.append("curved path segments")
        elif keyframe_feathers(mask):
            reasons.append("per-vertex feather")
    if reasons:
        raise UnsupportedMaskStack(
            f"Mask {mask.id!r} on clip {clip_id!r} uses {', '.join(reasons)}. {_MK2_REMEDY}"
        )


def keyframe_feathers(mask: Any) -> bool:
    """Whether any path keyframe carries a non-zero per-vertex feather."""
    return any(
        any(value != 0 for value in (keyframe.feather_px or [])) for keyframe in mask.path_keyframes
    )


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
        animated = evaluate_keyframes(points, property_name, source_time)
        if animated is not None:
            return animated
    attribute = {"featherOuterPx": "feather_outer_px", "featherInnerPx": "feather_inner_px"}.get(
        property_name, property_name
    )
    value = getattr(mask, attribute, None)
    return float(value) if isinstance(value, int | float) else None


def mask_frame_box(
    mask: Any, media_size: tuple[int, int] | None, source_time: float
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
