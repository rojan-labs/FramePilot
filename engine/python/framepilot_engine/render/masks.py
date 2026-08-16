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
