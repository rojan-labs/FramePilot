"""Evaluate a clip's schema-v22 mask stack for the export (MK2.2, ADR 0178).

WHY: ``Clip.masks`` is the one alpha model. This module turns a stack into pixels at a
SOURCE instant: scalar keyframes and whole-path keyframes are evaluated on the asset clock
(so trims, splits and speed changes never move a mask off the picture), geometry in
display-corrected source pixels is mapped through the clip's crop onto the frame the
compiler attaches it to, and each shape is drawn by the exact rasteriser
(:mod:`framepilot_engine.render.mask_raster`).

Two consumers in ``render/compiler.py``:

* **alpha targets** combine into the clip's alpha in ``_attach_mask``;
* **effect targets** (one stack per effect id) mix that effect's output with its input by
  the stack's alpha inside the effect application (``_apply_color_grade``).

``gaussian-legacy`` masks (migrated from v21 only) keep the v21 Pillow rasteriser and blur
from :mod:`framepilot_engine.render.masks`, so an existing project exports byte-identically;
a stack that is exactly one enabled legacy alpha mask returns that float alpha untouched.

A ``matte`` layer (BR2.2) is a raster from the Smart Mask pack: its decoded frame is bound per
clip by the compiler (``render/mattes.py``) and drawn by ``render/matte_edges.py``, then combined
by the same mode/opacity/invert rules.

What export cannot draw yet is REFUSED before rendering with :class:`MaskStackRefusal`
(a remedy, no varying numbers): a mask drawn approximately would silently differ from what
the editor promised.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from itertools import pairwise
from typing import Any

import numpy as np

from framepilot_engine.effects.keyframes import segment_progress
from framepilot_engine.render.key_mask import key_alpha
from framepilot_engine.render.layer_mattes import (
    LayerMatteFrame,
    PicturePlacement,
    sample_plane,
    sampled_channel,
)
from framepilot_engine.render.mask_raster import (
    AnalyticShape,
    BezierPath,
    FloatArray,
    MaskRasterError,
    ShapeRaster,
    analytic_alpha,
    combine,
    ellipse_path,
    flatten_path,
    layer_alpha,
    path_from_points,
    quantize_alpha,
    rectangle_path,
    shape_alpha,
    to_raster,
)
from framepilot_engine.render.masks import (
    MaskSpec,
    clip_source_clock,
    mask_scalar_at,
    rasterize_mask,
)
from framepilot_engine.render.matte_edges import (
    apply_finesse,
    clean_levels,
    distance_feather,
    edge_shift,
    to_frame,
)
from framepilot_engine.render.mattes import MatteFrame
from framepilot_engine.render.tracks import warp_path
from framepilot_engine.timeline.models import Keyframe

_log = logging.getLogger(__name__)

#: Kinds the export draws today.
SHAPE_KINDS = frozenset({"rectangle", "ellipse", "path"})
RASTER_KINDS = frozenset({"matte"})
#: Kinds whose alpha is read from the PICTURE rather than from geometry (MK6.1).
PICTURE_KINDS = frozenset({"key"})
#: Kinds drawn from a distance to a line or a centre, no path (MK8.1).
ANALYTIC_KINDS = frozenset({"linear", "band", "gradient"})

#: A matte layer's decoded frame at the instant being drawn (bound per clip by the compiler).
MatteFrameSource = Callable[[Any], MatteFrame]

#: The picture a ``key`` mask reads: the clip's own RGB frame at the instant being drawn, at the
#: raster's size. Supplied by the compiler; a key mask without one is a caller bug.
PictureSource = Callable[[], Any]

#: A ``layer`` mask's matte at the instant being drawn, for a raster ``width`` x ``height``: the
#: source composited alone on the frame and where the clip's picture lands (bound by the compiler).
LayerMatteSource = Callable[[Any, int, int], tuple[LayerMatteFrame, PicturePlacement]]

#: Where the clip's raster lands on the OUTPUT FRAME at the instant being drawn, for a raster
#: ``width`` x ``height``, and the frame's ``(width, height)``: what a frame-space clip mask
#: (``space: 'frame'``, MK9.1) needs to be read back onto the clip. Bound by the compiler.
FramePlacementSource = Callable[[int, int], tuple[PicturePlacement, tuple[int, int]]]

#: Kinds a frame-space CLIP mask may be (MK9.1): the ones drawn from geometry. A matte and a key
#: read the clip's own picture, and a track matte is already a frame picture, so none of them has
#: a frame-space variant to draw.
FRAME_SPACE_KINDS = frozenset({"rectangle", "ellipse", "path", "linear", "band", "gradient"})

#: Why each other kind is refused, with the remedy. Keyed by kind; no numbers in the text.
_KIND_REFUSALS: dict[str, str] = {}

_DISABLE_REMEDY = "Disable the mask to export now."


class MaskStackRefusal(ValueError):
    """The export cannot draw this mask stack faithfully; the message says what to do."""


@dataclass(frozen=True)
class FrameOwner:
    """The owner of masks already in OUTPUT-FRAME pixels: an adjustment lane (MK5.2), or a clip's
    frame-space mask while it is drawn on the frame (MK9.1).

    It has no crop, so the source → raster mapping is the identity once the "media size" is stated
    as the frame itself; a mask evaluated for it is drawn directly, never re-placed.
    """

    id: str
    crop: None = None


def _is_frame_space(mask: Any) -> bool:
    return str(mask.space.value) == "frame"


# --- Source → raster mapping ------------------------------------------------------------


@dataclass(frozen=True)
class RasterFrame:
    """Maps mask units onto a raster: ``X = x * scale_x + offset_x``; lengths scale by
    ``distance_scale``."""

    scale_x: float
    scale_y: float
    offset_x: float
    offset_y: float
    distance_scale: float


def raster_frame(
    mask: Any, clip: Any, media_size: tuple[float, float] | None, width: int, height: int
) -> RasterFrame:
    """The mapping from a mask's stored units to the clip's cropped frame, ``width`` by ``height``.

    :raises MaskStackRefusal: A pixel-unit mask on media whose size was never measured.
    """
    crop = clip.crop
    crop_x, crop_y = (crop.x, crop.y) if crop is not None else (0.0, 0.0)
    crop_w, crop_h = (crop.width, crop.height) if crop is not None else (1.0, 1.0)
    if getattr(mask, "units", None) == "normalized":
        source_w, source_h = 1.0, 1.0
    elif media_size is None:
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on clip {clip.id!r} is stored in source pixels but the media "
            "size is unknown. Measure this media first."
        )
    else:
        source_w, source_h = float(media_size[0]), float(media_size[1])
    scale_x = width / (crop_w * source_w)
    scale_y = height / (crop_h * source_h)
    return RasterFrame(
        scale_x=scale_x,
        scale_y=scale_y,
        offset_x=-(crop_x * source_w) * scale_x,
        offset_y=-(crop_y * source_h) * scale_y,
        distance_scale=min(scale_x, scale_y),
    )


# --- Keyframes --------------------------------------------------------------------------


def _scalar(mask: Any, name: str, source_time: float) -> float:
    value = mask_scalar_at(mask, name, source_time)
    return 0.0 if value is None else value


def _timing(time: float, easing: str, handles: Any) -> Keyframe:
    return Keyframe(id="", time=time, property="", value=0.0, easing=easing, handles=handles)


def path_keyframe_at(mask: Any, source_time: float) -> tuple[list[float], list[float] | None]:
    """A path mask's flat points (and per-vertex feather) at a source instant.

    Keyframes are ordered by ``sourceTime`` (stable). Before the first and after the last the
    path holds; between two, every number is ``a + (b - a) * p`` where ``p`` is the earlier
    keyframe's eased progress (ADR 0089, including two-sided bezier handles). Vertex ``i``
    of one keyframe corresponds to vertex ``i`` of the next, counted from the mask's
    ``firstVertex`` for both, so correspondence never swaps.
    """
    frames = sorted(mask.path_keyframes, key=lambda keyframe: keyframe.source_time)
    if not frames:
        raise MaskStackRefusal(
            f"Path mask {mask.id!r} has no path keyframes. Redraw the path or remove the mask."
        )
    if any(len(frame.points) != len(frames[0].points) for frame in frames):
        raise MaskStackRefusal(
            f"Path mask {mask.id!r} has keyframes with different vertex counts. "
            "Insert or remove the vertex on every keyframe."
        )
    first = frames[0]
    if source_time <= first.source_time:
        return list(first.points), _feathers(first, len(first.points) // 6)
    last = frames[-1]
    if source_time >= last.source_time:
        return list(last.points), _feathers(last, len(last.points) // 6)
    for left, right in pairwise(frames):
        if left.source_time <= source_time <= right.source_time:
            local = (source_time - left.source_time) / (right.source_time - left.source_time)
            progress = segment_progress(
                _timing(left.source_time, left.easing, left.handles),
                _timing(right.source_time, right.easing, right.handles),
                local,
            )
            points = [
                a + (b - a) * progress for a, b in zip(left.points, right.points, strict=True)
            ]
            count = len(left.points) // 6
            fa = _feathers(left, count)
            fb = _feathers(right, count)
            if fa is None and fb is None:
                return points, None
            fa = fa if fa is not None else [0.0] * count
            fb = fb if fb is not None else [0.0] * count
            return points, [a + (b - a) * progress for a, b in zip(fa, fb, strict=True)]
    return list(last.points), _feathers(last, len(last.points) // 6)  # pragma: no cover


def _feathers(frame: Any, count: int) -> list[float] | None:
    values = frame.feather_px
    if values is None:
        return None
    if len(values) != count:
        raise MaskStackRefusal(
            "A mask path keyframe stores one per-vertex feather for every vertex. Redraw the path."
        )
    return [float(value) for value in values]


def mask_path_at(mask: Any, source_time: float) -> BezierPath:
    """A rectangle, ellipse or path mask as a closed Bezier path in its stored units."""
    if mask.kind == "rectangle":
        return rectangle_path(
            _scalar(mask, "cx", source_time),
            _scalar(mask, "cy", source_time),
            _scalar(mask, "width", source_time),
            _scalar(mask, "height", source_time),
            _scalar(mask, "rotation", source_time),
            _scalar(mask, "roundness", source_time),
        )
    if mask.kind == "ellipse":
        return ellipse_path(
            _scalar(mask, "cx", source_time),
            _scalar(mask, "cy", source_time),
            _scalar(mask, "rx", source_time),
            _scalar(mask, "ry", source_time),
            _scalar(mask, "rotation", source_time),
        )
    points, feathers = path_keyframe_at(mask, source_time)
    try:
        return path_from_points(points, feathers, int(mask.first_vertex))
    except MaskRasterError as exc:
        raise MaskStackRefusal(f"Path mask {mask.id!r}: {exc}") from exc


# --- One mask ---------------------------------------------------------------------------


def tracked_mask_path_at(mask: Any, track: Any | None, source_time: float) -> BezierPath:
    """A shape mask's path at ``source_time`` as it is drawn: ``T(t) · G(t)`` (MK7.1, MK7.7).

    The mask's own animation ``G`` first — its keyframes, including a correction an editor made
    relative to the tracked motion (hold keyframes around the corrected stretch) — then the
    track ``T`` on its control points. This order is the contract a correction relies on; the
    preview's ``trackedMaskPathAt`` is the same two steps, pinned by
    ``tests/fixtures/mask-track/corrected.json``.
    """
    path = mask_path_at(mask, source_time)
    return path if track is None else warp_path(track, path, source_time)


def _is_legacy(mask: Any) -> bool:
    return str(mask.feather_model.value) == "gaussian-legacy"


#: How many ulps either side of an inverted value :func:`_recover_fraction` searches.
_RECOVERY_ULPS = 8


def _recover_fraction(estimate: float, forward: Callable[[float], float], stored: float) -> float:
    """The v21 fraction the migration turned into ``stored``, recovered exactly when possible.

    The migration maps a frame fraction to source pixels (``forward``), and inverting that in
    floating point lands a few ulps off (0.2 comes back as 0.19999999999999998), which is
    enough to move a Pillow edge. Among the floats within :data:`_RECOVERY_ULPS` of the
    estimate, keep those that ``forward`` maps to ``stored`` EXACTLY, and pick the one with
    the shortest decimal form (authored fractions are short), then the nearest. When none
    reproduces ``stored``, the estimate stands.
    """
    candidates = [estimate]
    below = above = estimate
    for _ in range(_RECOVERY_ULPS):
        below = math.nextafter(below, -math.inf)
        above = math.nextafter(above, math.inf)
        candidates.extend((below, above))
    exact = [value for value in candidates if forward(value) == stored]
    if not exact:
        return estimate
    return min(exact, key=lambda value: (len(repr(value)), abs(value - estimate)))


def _legacy_value(legacy: Any, name: str, s: float) -> float | None:
    """A v21 spec value from a mask's ``legacySpec`` at source ``s``, or ``None``.

    Read without arithmetic, so the preview reads the identical value: the static field when the
    value never animated, the value AT a keyframe instant (every rendered frame of a moving
    curve), the end value outside the keyframes, or the value of a hold (two neighbours with one
    value, which is how the migration collapses runs). Between two different values there is no
    v21 value to reproduce, so ``None``.
    """
    points = sorted(
        (point for point in legacy.keyframes if point.property.value == name),
        key=lambda point: point.source_time,
    )
    if not points:
        return float(getattr(legacy, name))
    for point in points:
        if point.source_time == s:
            return float(point.value)
    if s < points[0].source_time:
        return float(points[0].value)
    if s > points[-1].source_time:
        return float(points[-1].value)
    for before, after in pairwise(points):
        if before.source_time < s < after.source_time:
            return float(before.value) if before.value == after.value else None
    return None


def _legacy_spec(
    mask: Any, clip: Any, media_size: tuple[float, float] | None, s: float
) -> MaskSpec:
    """The v21 :class:`MaskSpec` (cropped-frame fractions) this legacy mask is, at source ``s``.

    It inverts ``packages/timeline-schema/src/mask-migration.ts`` expression for expression.
    A migrated mask carries the v21 spec itself (``legacySpec``, MK2.5): the stored centre and
    size are not one-to-one with v21's fractions (x = 0.2 and x = 0.19999999999999996 store the
    same centre, yet v21 drew ``x * width``, 64.0 vs 63.99999999999999), so no inverse can be
    exact. Those values are drawn whenever the migration's own arithmetic maps them onto the
    geometry stored at ``s``, which holds for every rendered frame of an unedited mask, so it
    draws the identical Pillow raster it drew as a v21 ``mask`` effect by construction. A mask
    edited since (or one with no spec) falls back to recovering each fraction from the stored
    pixels (:func:`_recover_fraction`).
    """
    normalized = mask.units == "normalized"
    if normalized:
        scale_w, scale_h = 1.0, 1.0
    elif media_size is None:
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on clip {clip.id!r} is stored in source pixels but the media "
            "size is unknown. Measure this media first."
        )
    else:
        scale_w, scale_h = float(media_size[0]), float(media_size[1])
    crop = clip.crop
    crop_x, crop_y = (crop.x, crop.y) if crop is not None else (0.0, 0.0)
    crop_w, crop_h = (crop.width, crop.height) if crop is not None else (1.0, 1.0)
    crop_width = crop_w * scale_w
    crop_height = crop_h * scale_h
    feather_scale = 1.0 if normalized else min(crop_width, crop_height)

    def to_x(fraction: float) -> float:
        return fraction if normalized else (crop_x + fraction * crop_w) * scale_w

    def to_y(fraction: float) -> float:
        return fraction if normalized else (crop_y + fraction * crop_h) * scale_h

    def from_x(px: float) -> float:
        return px if normalized else (px / scale_w - crop_x) / crop_w

    def from_y(py: float) -> float:
        return py if normalized else (py / scale_h - crop_y) / crop_h

    def to_feather(fraction: float) -> float:
        return fraction if normalized else fraction * feather_scale

    ellipse = mask.kind == "ellipse"
    size_w, size_h = ("rx", "ry") if ellipse else ("width", "height")
    half = 0.5 if ellipse else 1.0

    def to_w(fraction: float) -> float:
        return (fraction if normalized else fraction * crop_width) * half

    def to_h(fraction: float) -> float:
        return (fraction if normalized else fraction * crop_height) * half

    opacity = _scalar(mask, "opacity", s)
    stored = _stored_v21_spec(mask, s, to_x, to_y, to_w, to_h, to_feather)
    if stored is not None:
        return replace(stored, opacity=opacity, invert=mask.invert)
    if mask.legacy_spec is not None:
        _log.debug("legacy mask %s: stored v21 spec no longer maps at s=%r; recovering", mask.id, s)

    def recover(name: str, estimate: float, forward: Callable[[float], float]) -> float:
        return _recover_fraction(estimate, forward, _scalar(mask, name, s))

    stored_feather = _scalar(mask, "featherOuterPx", s)
    feather = stored_feather / feather_scale if feather_scale > 0 else 0.0
    if feather_scale > 0:
        feather = recover("featherOuterPx", feather, to_feather)
    common: dict[str, Any] = {"feather": feather, "opacity": opacity, "invert": mask.invert}
    if mask.kind == "path":
        points, _ = path_keyframe_at(mask, s)
        polygon = tuple(
            (
                _recover_fraction(from_x(points[i]), to_x, points[i]),
                _recover_fraction(from_y(points[i + 1]), to_y, points[i + 1]),
            )
            for i in range(0, len(points), 6)
        )
        return MaskSpec(shape="polygon", points=polygon, **common)
    stored_w = _scalar(mask, size_w, s)
    stored_h = _scalar(mask, size_h, s)
    box_w = stored_w * 2.0 if ellipse else stored_w
    box_h = stored_h * 2.0 if ellipse else stored_h
    fw = recover(size_w, box_w / scale_w / crop_w, to_w)
    fh = recover(size_h, box_h / scale_h / crop_h, to_h)
    cx = _scalar(mask, "cx", s)
    cy = _scalar(mask, "cy", s)
    fx = _recover_fraction(from_x(cx) - fw / 2, lambda f: to_x(f + fw / 2), cx)
    fy = _recover_fraction(from_y(cy) - fh / 2, lambda f: to_y(f + fh / 2), cy)
    return MaskSpec(shape=mask.kind, x=fx, y=fy, width=fw, height=fh, **common)


def _stored_v21_spec(
    mask: Any,
    s: float,
    to_x: Callable[[float], float],
    to_y: Callable[[float], float],
    to_w: Callable[[float], float],
    to_h: Callable[[float], float],
    to_feather: Callable[[float], float],
) -> MaskSpec | None:
    """The v21 spec a migrated mask stored (``legacySpec``) at ``s``, if it still holds.

    It holds when every value maps, through the migration's own expressions (the ``to_*``
    callables), onto the geometry stored at ``s``, bit for bit; anything else means the mask was
    edited after the migration, and ``None`` sends the caller to recovery. Opacity and invert
    are the caller's: the migration stored those directly.
    """
    legacy = mask.legacy_spec
    if legacy is None:
        return None
    feather = _legacy_value(legacy, "feather", s)
    if feather is None or to_feather(feather) != _scalar(mask, "featherOuterPx", s):
        return None
    if mask.kind == "path":
        if legacy.points is None:
            return None
        points, _ = path_keyframe_at(mask, s)
        if len(points) != 6 * len(legacy.points):
            return None
        for index, (px, py) in enumerate(legacy.points):
            if to_x(px) != points[6 * index] or to_y(py) != points[6 * index + 1]:
                return None
        return MaskSpec(shape="polygon", points=tuple(legacy.points), feather=feather)
    x, y, width, height = (_legacy_value(legacy, name, s) for name in ("x", "y", "width", "height"))
    if x is None or y is None or width is None or height is None:
        return None
    size_w, size_h = ("rx", "ry") if mask.kind == "ellipse" else ("width", "height")
    holds = (
        to_w(width) == _scalar(mask, size_w, s)
        and to_h(height) == _scalar(mask, size_h, s)
        and to_x(x + width / 2) == _scalar(mask, "cx", s)
        and to_y(y + height / 2) == _scalar(mask, "cy", s)
    )
    if not holds:
        return None
    return MaskSpec(shape=mask.kind, x=x, y=y, width=width, height=height, feather=feather)


def matte_alpha(
    mask: Any,
    clip: Any,
    frame: MatteFrame,
    width: int,
    height: int,
    source_time: float,
    decoded_size: tuple[int, int] | None = None,
) -> FloatArray:
    """One matte layer's alpha (after invert and opacity) on the clip's frame (BR2.2).

    Source-pixel edge rules first (:mod:`framepilot_engine.render.matte_edges`: edge shift,
    clean levels from finesse or ``edgeMode``, then base expansion/feather on the matte's own
    contour), then the clip's crop and frame size, then the base invert and opacity.
    """
    alpha = edge_shift(frame.alpha, frame.maximum, _scalar(mask, "edgeShiftPx", source_time))
    # The finesse group (MK6.2) sits between the artifact's own edge shift and the mask's base
    # expansion/feather: the shift says where the delivered edge belongs, finesse cleans that
    # edge up, and the base controls are the shape rules every kind shares.
    alpha = apply_finesse(alpha, mask.finesse, clean_levels(mask))
    alpha = distance_feather(
        alpha,
        expansion=_scalar(mask, "expansionPx", source_time),
        feather_inner=max(_scalar(mask, "featherInnerPx", source_time), 0.0),
        feather_outer=max(_scalar(mask, "featherOuterPx", source_time), 0.0),
        falloff=str(mask.falloff.value),
    )
    return layer_alpha(
        to_frame(alpha, clip, width, height, decoded_size),
        invert=bool(mask.invert),
        opacity=_scalar(mask, "opacity", source_time),
    )


def key_mask_alpha(mask: Any, picture: Any, source_time: float) -> FloatArray:
    """One ``key`` layer's alpha (after clean levels, invert and opacity) on ``picture`` (MK6.1).

    The qualifier reads the picture the clip composites at this instant, so the key follows the
    footage without a keyframe; the matte finesse group then cleans the edge it produced, and
    the mask's own scalars (opacity) are read on the source clock like every other kind.
    """
    matched = key_alpha(mask, picture)
    matched = apply_finesse(
        matched,
        mask.finesse,
        (float(mask.finesse.clean_black), float(mask.finesse.clean_white)),
    )
    return layer_alpha(
        matched, invert=bool(mask.invert), opacity=_scalar(mask, "opacity", source_time)
    )


def analytic_shape_at(mask: Any, source_time: float) -> AnalyticShape:
    """A ``linear``, ``band`` or ``gradient`` mask's geometry at a source instant (MK8.1).

    Every animatable scalar is read on the source clock like a shape's; a gradient has no edge,
    so its expansion and feathers are not read (the validator refuses them on a gradient).
    """
    if mask.kind == "gradient":
        return AnalyticShape(
            kind="gradient",
            gradient_shape=str(mask.shape),
            start_x=_scalar(mask, "startX", source_time),
            start_y=_scalar(mask, "startY", source_time),
            end_x=_scalar(mask, "endX", source_time),
            end_y=_scalar(mask, "endY", source_time),
            curve=str(mask.curve.value),
        )
    return AnalyticShape(
        kind=str(mask.kind),
        origin_x=_scalar(mask, "originX", source_time),
        origin_y=_scalar(mask, "originY", source_time),
        angle=_scalar(mask, "angle", source_time),
        band_width=_scalar(mask, "widthPx", source_time) if mask.kind == "band" else 0.0,
        softness=_scalar(mask, "softnessPx", source_time),
        expansion=_scalar(mask, "expansionPx", source_time),
        feather_inner=_scalar(mask, "featherInnerPx", source_time),
        feather_outer=_scalar(mask, "featherOuterPx", source_time),
        falloff=str(mask.falloff.value),
    )


def _analytic_mask_alpha(
    mask: Any,
    clip: Any,
    media_size: tuple[float, float] | None,
    width: int,
    height: int,
    source_time: float,
) -> FloatArray:
    frame = raster_frame(mask, clip, media_size, width, height)
    alpha = analytic_alpha(
        analytic_shape_at(mask, source_time),
        width,
        height,
        scale_x=frame.scale_x,
        scale_y=frame.scale_y,
        offset_x=frame.offset_x,
        offset_y=frame.offset_y,
        distance_scale=frame.distance_scale,
    )
    return layer_alpha(
        alpha, invert=bool(mask.invert), opacity=_scalar(mask, "opacity", source_time)
    )


def layer_mask_alpha(
    mask: Any, frame: LayerMatteFrame, placement: PicturePlacement, source_time: float
) -> FloatArray:
    """One ``layer`` mask's alpha on the clip's raster (MK8.2, :mod:`render.layer_mattes`).

    The source's channel sampled where each pixel lands, then the finesse group (clean levels
    first, as a key's), then the base invert and opacity.
    """
    values = sampled_channel(frame, str(mask.channel), placement)
    values = apply_finesse(
        values,
        mask.finesse,
        (float(mask.finesse.clean_black), float(mask.finesse.clean_white)),
    )
    return layer_alpha(
        values, invert=bool(mask.invert), opacity=_scalar(mask, "opacity", source_time)
    )


def mask_alpha(
    mask: Any,
    clip: Any,
    media_size: tuple[float, float] | None,
    width: int,
    height: int,
    source_time: float,
    matte_frame: MatteFrameSource | None = None,
    decoded_size: tuple[int, int] | None = None,
    track: Any | None = None,
    picture: PictureSource | None = None,
    layer_matte: LayerMatteSource | None = None,
    frame_placement: FramePlacementSource | None = None,
) -> FloatArray:
    """One mask's alpha (after invert and opacity) on the clip's frame at a source instant.

    :param matte_frame: Supplies a matte layer's decoded frame at this instant; required when
        ``mask`` is a matte.
    :param track: The mask's prepared transform track, applied to the path's control points
        before flattening (MK7.1); ``None`` for an untracked mask.
    :param picture: Supplies the clip's RGB frame at this instant; required for a ``key`` mask.
    :param layer_matte: Supplies a ``layer`` mask's source frame and the clip's placement.
    :param frame_placement: Where the clip's raster lands on the output frame; required when
        ``mask`` is fixed to the frame (``space: 'frame'``, MK9.1).
    """
    if _is_frame_space(mask) and not isinstance(clip, FrameOwner):
        return frame_space_alpha(mask, clip, width, height, source_time, frame_placement)
    return _drawn_alpha(
        mask,
        clip,
        media_size,
        width,
        height,
        source_time,
        matte_frame,
        decoded_size,
        track,
        picture,
        layer_matte,
    )


def frame_space_alpha(
    mask: Any,
    clip: Any,
    width: int,
    height: int,
    source_time: float,
    frame_placement: FramePlacementSource | None,
) -> FloatArray:
    """A frame-space clip mask (MK9.1) on the clip's ``width`` x ``height`` raster.

    The mask is drawn on the OUTPUT FRAME in frame pixels, exactly as an adjustment lane's mask
    is (identity mapping, the same rasteriser), invert and opacity included, then read back onto
    the clip at the frame pixel each of its pixel centres lands on (:func:`sample_plane`, the
    track matte's mapping). So it stays put on the frame while the picture under it moves,
    scales or rotates. A clip pixel that lands off the frame reads 0: nothing there is visible.
    """
    if frame_placement is None:
        raise MaskStackRefusal(
            f"Frame-space mask {mask.id!r} on clip {clip.id!r} has no frame placement bound. "
            "Export again; if it repeats, report it."
        )
    placement, (frame_w, frame_h) = frame_placement(width, height)
    drawn = _drawn_alpha(
        mask,
        FrameOwner(str(clip.id)),
        (float(frame_w), float(frame_h)),
        frame_w,
        frame_h,
        source_time,
    )
    return sample_plane(drawn, placement)


def _drawn_alpha(
    mask: Any,
    clip: Any,
    media_size: tuple[float, float] | None,
    width: int,
    height: int,
    source_time: float,
    matte_frame: MatteFrameSource | None = None,
    decoded_size: tuple[int, int] | None = None,
    track: Any | None = None,
    picture: PictureSource | None = None,
    layer_matte: LayerMatteSource | None = None,
) -> FloatArray:
    """:func:`mask_alpha` for a mask in its owner's own raster units (source or frame pixels)."""
    if mask.kind == "layer":
        if layer_matte is None:
            raise MaskStackRefusal(
                f"Track matte {mask.id!r} on clip {clip.id!r} has no source picture bound. "
                "Export again; if it repeats, report it."
            )
        source_picture, placement = layer_matte(mask, width, height)
        return layer_mask_alpha(mask, source_picture, placement, source_time)
    if mask.kind == "key":
        if picture is None:
            raise MaskStackRefusal(
                f"Key mask {mask.id!r} on clip {clip.id!r} has no picture bound. "
                "Export again; if it repeats, report it."
            )
        return key_mask_alpha(mask, picture(), source_time)
    if mask.kind == "matte":
        if matte_frame is None:
            raise MaskStackRefusal(
                f"Matte mask {mask.id!r} on clip {clip.id!r} has no decoded frames bound. "
                "Export again; if it repeats, report it."
            )
        return matte_alpha(mask, clip, matte_frame(mask), width, height, source_time, decoded_size)
    if mask.kind in ANALYTIC_KINDS:
        return _analytic_mask_alpha(mask, clip, media_size, width, height, source_time)
    if _is_legacy(mask):
        spec = _legacy_spec(mask, clip, media_size, source_time)
        return rasterize_mask(spec, width, height)
    frame = raster_frame(mask, clip, media_size, width, height)
    path = tracked_mask_path_at(mask, track, source_time)
    polyline = to_raster(
        flatten_path(path), frame.scale_x, frame.scale_y, frame.offset_x, frame.offset_y
    )
    if polyline.feathers is not None:
        polyline = type(polyline)(
            polyline.xs, polyline.ys, polyline.feathers * frame.distance_scale
        )
    shape = ShapeRaster(
        polyline=polyline,
        expansion=_scalar(mask, "expansionPx", source_time) * frame.distance_scale,
        feather_inner=max(_scalar(mask, "featherInnerPx", source_time), 0.0) * frame.distance_scale,
        feather_outer=max(_scalar(mask, "featherOuterPx", source_time), 0.0) * frame.distance_scale,
        falloff=str(mask.falloff.value),
    )
    return layer_alpha(
        shape_alpha(shape, width, height),
        invert=bool(mask.invert),
        opacity=_scalar(mask, "opacity", source_time),
    )


def stack_alpha(
    masks: Sequence[Any],
    clip: Any,
    media_size: tuple[float, float] | None,
    width: int,
    height: int,
    source_time: float,
    matte_frame: MatteFrameSource | None = None,
    decoded_size: tuple[int, int] | None = None,
    tracks: dict[str, Any] | None = None,
    picture: PictureSource | None = None,
    layer_matte: LayerMatteSource | None = None,
    frame_placement: FramePlacementSource | None = None,
) -> FloatArray:
    """The combined alpha of an ordered (top first) stack of enabled masks.

    The result is quantised once (``rint(a * 255) / 255``), except a stack that is exactly
    one ``add`` legacy mask, which returns the v21 float alpha unchanged (byte-identical
    migration).
    """
    if len(masks) == 1 and _is_legacy(masks[0]) and str(masks[0].mode.value) == "add":
        return mask_alpha(masks[0], clip, media_size, width, height, source_time)
    accumulated = np.zeros((height, width), dtype=np.float64)
    for mask in masks:
        alpha = mask_alpha(
            mask,
            clip,
            media_size,
            width,
            height,
            source_time,
            matte_frame,
            decoded_size,
            (tracks or {}).get(str(mask.id)),
            picture,
            layer_matte,
            frame_placement,
        )
        accumulated = combine(accumulated, alpha, str(mask.mode.value))
    return quantize_alpha(accumulated).astype(np.float64) / 255.0


# --- Refusals ---------------------------------------------------------------------------


#: Mask kinds a transform track can move: the track warps CONTROL POINTS, and only these have
#: any (MK7.1). A matte or a key follows its own pixels, so a track on one is refused rather
#: than silently ignored.
_TRACKABLE_KINDS = frozenset({"rectangle", "ellipse", "path"})


def _refuse(mask: Any, clip_id: str, reason: str) -> MaskStackRefusal:
    return MaskStackRefusal(f"Mask {mask.id!r} on clip {clip_id!r}: {reason}. {_DISABLE_REMEDY}")


def assert_renderable(mask: Any, clip: Any, effect_ids: frozenset[str]) -> None:
    """Refuse, before any frame renders, a mask the export cannot draw faithfully."""
    reason = _KIND_REFUSALS.get(str(mask.kind))
    if reason is not None:
        raise _refuse(mask, clip.id, reason)
    if mask.tracking is not None and str(mask.kind) not in _TRACKABLE_KINDS:
        raise _refuse(
            mask, clip.id, "only shape masks can be tracked — clear the track or change the kind"
        )
    if _is_frame_space(mask):
        _assert_frame_space_drawable(mask, clip.id)
    if mask.target.kind == "effect" and mask.target.effect_id not in effect_ids:
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on clip {clip.id!r} limits an effect that is not on the clip. "
            "Retarget the mask or remove it."
        )
    if mask.kind == "matte":
        _assert_matte_drawable(mask, clip.id)
    if mask.kind == "key":
        _assert_key_drawable(mask, clip.id)
    if mask.kind in ANALYTIC_KINDS:
        assert_analytic_drawable(mask, f"clip {clip.id!r}")
        return
    if mask.kind == "layer":
        assert_layer_drawable(mask, f"clip {clip.id!r}")
        return
    if _is_legacy(mask):
        if mask.tracking is not None:
            raise _refuse(
                mask,
                clip.id,
                "a mask with the legacy blur feather cannot be tracked — switch its feather "
                "model to Distance",
            )
        _assert_legacy_drawable(mask, clip.id)
    if mask.kind == "path":
        path_keyframe_at(mask, mask.path_keyframes[0].source_time if mask.path_keyframes else 0.0)


def _assert_frame_space_drawable(mask: Any, clip_id: str) -> None:
    """A frame-space clip mask (MK9.1): geometry in frame pixels, with the distance feather."""
    if str(mask.kind) not in FRAME_SPACE_KINDS:
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on clip {clip_id!r} is fixed to the frame, and only shapes, splits, "
            "bands and gradients can be. Set its space to Source."
        )
    if mask.tracking is not None:
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on clip {clip_id!r} is fixed to the frame and tracked, and a track "
            "follows the picture. Set its space to Source or clear the track."
        )
    if getattr(mask, "units", None) == "normalized" or _is_legacy(mask):
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on clip {clip_id!r} is fixed to the frame but was migrated from an "
            "older project. Set its space to Source, or redraw it."
        )


def _assert_matte_drawable(mask: Any, clip_id: str) -> None:
    """A matte draws edge shift, the whole finesse group (MK6.2), expansion and feather."""
    if _is_legacy(mask):
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on clip {clip_id!r} uses the legacy blur feather, which only "
            "shapes migrated from older projects have. Switch the mask's feather model to Distance."
        )


def _assert_key_drawable(mask: Any, clip_id: str) -> None:
    """A key draws its qualifier, the finesse group and despill; only the legacy feather is out."""
    if _is_legacy(mask):
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on clip {clip_id!r} uses the legacy blur feather, which only "
            "shapes migrated from older projects have. Switch the mask's feather model to Distance."
        )


def assert_analytic_drawable(mask: Any, owner_label: str) -> None:
    """A split, band or gradient draws with the distance feather only; a gradient has no edge."""
    if _is_legacy(mask):
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on {owner_label} uses the legacy blur feather, which only "
            "shapes migrated from older projects have. Switch the mask's feather model to Distance."
        )
    if mask.kind == "gradient" and gradient_has_edge_controls(mask):
        raise MaskStackRefusal(
            f"Gradient mask {mask.id!r} on {owner_label} has expansion or feather set, and a "
            "gradient has no edge to grow or soften. Set them to 0 and shape the ramp with its "
            "start, end and curve."
        )


def assert_layer_drawable(mask: Any, owner_label: str) -> None:
    """A track matte's edge is the source's: expansion and feathers have nothing to act on."""
    if _is_legacy(mask):
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on {owner_label} uses the legacy blur feather, which only "
            "shapes migrated from older projects have. Switch the mask's feather model to Distance."
        )
    if gradient_has_edge_controls(mask):
        raise MaskStackRefusal(
            f"Track matte {mask.id!r} on {owner_label} has expansion or feather set, and a track "
            "matte takes its edge from its source. Set them to 0 and use the finesse controls to "
            "grow or soften it."
        )


def gradient_has_edge_controls(mask: Any) -> bool:
    """Whether a gradient carries expansion or feather (static or keyframed), which it ignores."""
    edge = ("expansionPx", "featherInnerPx", "featherOuterPx")
    return (
        mask.expansion_px != 0
        or mask.feather_inner_px != 0
        or mask.feather_outer_px != 0
        or any(keyframe.property.value in edge for keyframe in mask.keyframes)
    )


def _assert_legacy_drawable(mask: Any, clip_id: str) -> None:
    """``gaussian-legacy`` is the v21 blur of a v21 shape; anything more needs ``distance``."""
    legacy_only = (
        mask.expansion_px == 0
        and mask.feather_inner_px == 0
        and getattr(mask, "rotation", 0.0) == 0
        and getattr(mask, "roundness", 0.0) == 0
        and not any(
            keyframe.property.value in ("expansionPx", "featherInnerPx", "rotation", "roundness")
            for keyframe in mask.keyframes
        )
    )
    if mask.kind == "path":
        legacy_only = legacy_only and all(
            all(value == 0 for index, value in enumerate(frame.points) if index % 6 >= 2)
            and not any(value != 0 for value in (frame.feather_px or []))
            for frame in mask.path_keyframes
        )
    if not legacy_only:
        raise MaskStackRefusal(
            f"Mask {mask.id!r} on clip {clip_id!r} uses the legacy blur feather with geometry "
            "it cannot blur (rotation, roundness, curves, expansion, inner or per-vertex "
            "feather). Switch the mask's feather model to Distance."
        )


# --- A clip's stacks --------------------------------------------------------------------


def _animated(mask: Any) -> bool:
    # A matte reads a new artifact frame per instant; a key reads the picture itself. Neither
    # can be drawn once and reused, whatever its keyframes say.
    if mask.kind in ("matte", "key", "layer"):
        return True
    # A frame-space mask is read through where the picture lands, which moves with the clip's
    # transform even when the mask itself does not (MK9.1).
    if _is_frame_space(mask):
        return True
    return bool(mask.keyframes) or (mask.kind == "path" and len(mask.path_keyframes) > 1)


@dataclass(frozen=True)
class ClipMaskStacks:
    """A clip's enabled shape masks, split by target, ready to evaluate per frame."""

    clip: Any
    media_size: tuple[float, float] | None
    alpha: tuple[Any, ...]
    by_effect: dict[str, tuple[Any, ...]]
    clock: Callable[[float], float]
    #: Per matte mask id, its decoded frame at CLIP-RELATIVE ``t`` (bound by the compiler).
    mattes: dict[str, Callable[[float], MatteFrame]] = field(default_factory=dict)
    #: ``(width, height)`` the source was decoded at before its crop (matte resampling, BR2.7).
    decoded_size: tuple[int, int] | None = None
    #: Per tracked mask id, its prepared transform track (MK7.1); bound by the compiler.
    tracks: dict[str, Any] = field(default_factory=dict)
    #: A ``layer`` mask's matte at CLIP-RELATIVE ``t`` for a raster size (MK8.2); bound by the
    #: compiler, which alone knows the source pictures and where this clip lands.
    layer_mattes: (
        Callable[[Any, float, int, int], tuple[LayerMatteFrame, PicturePlacement]] | None
    ) = None
    #: Where the clip's raster lands on the output frame at CLIP-RELATIVE ``t`` (MK9.1); bound
    #: by the compiler, which alone knows the clip's placement. Needed by frame-space masks.
    placements: Callable[[float, int, int], tuple[PicturePlacement, tuple[int, int]]] | None = None

    def _placement_at(self, t: float) -> FramePlacementSource | None:
        bound = self.placements
        if bound is None:
            return None

        def placement_of(width: int, height: int) -> tuple[PicturePlacement, tuple[int, int]]:
            return bound(t, width, height)

        return placement_of

    def _layer_mattes_at(self, t: float) -> LayerMatteSource | None:
        bound = self.layer_mattes
        if bound is None:
            return None

        def matte_of(
            mask: Any, width: int, height: int
        ) -> tuple[LayerMatteFrame, PicturePlacement]:
            return bound(mask, t, width, height)

        return matte_of

    def layer_masks(self) -> tuple[Any, ...]:
        """Every enabled track matte in the clip's stacks, top first."""
        return tuple(
            mask
            for mask in (*self.alpha, *(m for ms in self.by_effect.values() for m in ms))
            if mask.kind == "layer"
        )

    @property
    def alpha_animated(self) -> bool:
        return any(_animated(mask) for mask in self.alpha)

    def effect_animated(self, effect_id: str) -> bool:
        return any(_animated(mask) for mask in self.by_effect.get(effect_id, ()))

    def alpha_at(
        self, t: float, width: int, height: int, picture: PictureSource | None = None
    ) -> FloatArray | None:
        """The alpha-target stack at CLIP-RELATIVE ``t``; ``None`` when nothing cuts alpha.

        :param picture: The clip's RGB frame at ``t``, needed only when the stack has a key.
        """
        if not self.alpha:
            return None
        return stack_alpha(
            self.alpha,
            self.clip,
            self.media_size,
            width,
            height,
            self.clock(t),
            self._matte_frames_at(t),
            self.decoded_size,
            self.tracks,
            picture,
            self._layer_mattes_at(t),
            self._placement_at(t),
        )

    def effect_alpha_at(
        self,
        effect_id: str,
        t: float,
        width: int,
        height: int,
        picture: PictureSource | None = None,
    ) -> FloatArray | None:
        """The stack limiting ``effect_id`` at clip-relative ``t``; ``None`` when unmasked."""
        masks = self.by_effect.get(effect_id)
        if not masks:
            return None
        return stack_alpha(
            masks,
            self.clip,
            self.media_size,
            width,
            height,
            self.clock(t),
            self._matte_frames_at(t),
            self.decoded_size,
            self.tracks,
            picture,
            self._layer_mattes_at(t),
            self._placement_at(t),
        )

    @property
    def alpha_needs_picture(self) -> bool:
        """Whether the alpha-target stack reads the picture (it holds a ``key``)."""
        return any(mask.kind == "key" for mask in self.alpha)

    def effect_needs_picture(self, effect_id: str) -> bool:
        """Whether the stack limiting ``effect_id`` reads the picture."""
        return any(mask.kind == "key" for mask in self.by_effect.get(effect_id, ()))

    def despilling_keys(self) -> tuple[Any, ...]:
        """Every enabled key layer asking for despill, top first (MK6.1)."""
        return tuple(
            mask
            for mask in (*self.alpha, *(m for ms in self.by_effect.values() for m in ms))
            if mask.kind == "key" and str(mask.despill) != "none"
        )

    def matte_masks(self) -> tuple[Any, ...]:
        """Every enabled matte layer in the clip's stacks, top first."""
        return tuple(
            mask
            for mask in (*self.alpha, *(m for ms in self.by_effect.values() for m in ms))
            if mask.kind == "matte"
        )

    def _matte_frames_at(self, t: float) -> MatteFrameSource:
        def frame_of(mask: Any) -> MatteFrame:
            source = self.mattes.get(str(mask.id))
            if source is None:
                raise MaskStackRefusal(
                    f"Matte mask {mask.id!r} on clip {self.clip.id!r} has no decoded frames "
                    "bound. Export again; if it repeats, report it."
                )
            return source(t)

        return frame_of


def clip_mask_stacks(
    clip: Any,
    media_size: tuple[float, float] | None,
    mattes: dict[str, Callable[[float], MatteFrame]] | None = None,
    decoded_size: tuple[int, int] | None = None,
    tracks: dict[str, Any] | None = None,
    layer_mattes: Callable[[Any, float, int, int], tuple[LayerMatteFrame, PicturePlacement]]
    | None = None,
    placements: Callable[[float, int, int], tuple[PicturePlacement, tuple[int, int]]] | None = None,
) -> ClipMaskStacks | None:
    """A clip's enabled mask stacks, refused up front if export cannot draw one faithfully.

    :param clip: The clip (a :class:`~framepilot_engine.timeline.models.Clip`).
    :param media_size: The asset's display-corrected ``(width, height)`` (PAR and rotation
        applied), or ``None`` when unmeasured.
    :param mattes: Per matte mask id, its decoded frame at clip-relative ``t``. Absent while
        only checking renderability (before any reader opens).
    :param placements: Where the clip's raster lands on the output frame at clip-relative ``t``
        and the frame size; required to DRAW a frame-space mask (MK9.1).
    :raises MaskStackRefusal: When a mask needs a renderer that has not shipped.
    """
    enabled = [mask for mask in (getattr(clip, "masks", None) or []) if mask.enabled]
    if not enabled:
        return None
    effect_ids = frozenset(effect.id for effect in clip.effects)
    for mask in enabled:
        assert_renderable(mask, clip, effect_ids)
        # A frame-space mask is in frame pixels: it needs no measured media size.
        if (
            getattr(mask, "units", None) != "normalized"
            and media_size is None
            and not _is_frame_space(mask)
        ):
            raise MaskStackRefusal(
                f"Mask {mask.id!r} on clip {clip.id!r} is stored in source pixels but the media "
                "size is unknown. Measure this media first."
            )
    alpha = tuple(mask for mask in enabled if mask.target.kind == "alpha")
    by_effect: dict[str, tuple[Any, ...]] = {}
    for mask in enabled:
        if mask.target.kind == "effect":
            by_effect[mask.target.effect_id] = (*by_effect.get(mask.target.effect_id, ()), mask)
    _log.debug(
        "mask stacks for clip %s: %d alpha, %d effect targets",
        clip.id,
        len(alpha),
        len(by_effect),
    )
    return ClipMaskStacks(
        clip=clip,
        media_size=media_size,
        alpha=alpha,
        by_effect=by_effect,
        clock=clip_source_clock(clip),
        mattes=dict(mattes or {}),
        decoded_size=decoded_size,
        tracks=dict(tracks or {}),
        layer_mattes=layer_mattes,
        placements=placements,
    )


def mix_by_alpha(original: Any, effected: Any, alpha: FloatArray) -> Any:
    """``original + (effected - original) * alpha`` per pixel, back in the input's dtype."""
    base = np.asarray(original, dtype=np.float64)
    done = np.asarray(effected, dtype=np.float64)
    weight = alpha[:, :, None] if base.ndim == 3 else alpha
    mixed = base + (done - base) * weight
    if np.asarray(original).dtype == np.uint8:
        return np.clip(np.rint(mixed), 0, 255).astype(np.uint8)
    return mixed.astype(np.asarray(original).dtype)
