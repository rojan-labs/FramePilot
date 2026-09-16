"""What one exported frame is made of: the render compiler's decisions, without pixels (PX1).

WHY this exists: the export (``compile_timeline``) and the preview are two renderers, and
they drifted — text drawn above pictures it sits under, one picture shown where the export
stacks three, a sped-up clip routed to a renderer that ignores speed. Every one of those
is a disagreement about *what* to draw, not *how*. This module states the "what" once: an
ordered back-to-front list of layers at a sequence time, each with its source frame,
crop, geometry, opacity, blend mode, effects, mask and transition state.

The compiler **consumes** these helpers (track order, under-layer windows and handles,
placement arithmetic, opacity, picture-effect order, text/caption content), so there is
one copy of each decision on the Python side. ``packages/editor-core/src/frame-plan.ts`` is
the TypeScript twin, and ``tests/fixtures/frame-plan/*.json`` pins the two together field
by field (plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md, PX1.3).

What this deliberately does NOT describe: raster sizes of text and captions (they depend
on font metrics, which only the pixel stage has), integer rounding MoviePy/ffmpeg apply to
a resized or cropped frame, and the decode-size caps of P7.5. Those are pixel concerns and
belong to the PX4 oracle. Geometry here is the exact float the compiler asks for.

Quirks of today's export are described, not fixed: a still image ignores its crop and
opacity keyframes, burned captions sit above every track in caption-track list order, and
an effect layer applies to the finished frame whatever its lane position. A plan that
"corrected" them would stop being a description of the export.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from framepilot_engine.effects.speed_curve import has_speed_ramp, source_time_at
from framepilot_engine.effects.transform import evaluate_clip_transform
from framepilot_engine.render import transitions
from framepilot_engine.render.captions import resolve_caption_cue
from framepilot_engine.render.text_overlay import text_overlay_layout
from framepilot_engine.timeline.models import (
    Clip,
    Effect,
    MaskLayer,
    Project,
    Track,
    TrackType,
)

_log = logging.getLogger(__name__)

TEXT_ASSET_ID = "__text__"
CAPTION_ASSET_ID = "__caption__"
PICTURE_KINDS = frozenset({"video", "image"})

#: How close two clips must sit to count as one cut. See the compiler's note on ADR 0146.
CUT_ADJACENCY_TOLERANCE = 1e-3

#: How much of a neighbour's handle an under-layer may borrow, as a multiple of the ramp.
UNDERLAY_HANDLE_SLACK = 1.05

#: MoviePy's frame-number nudge (``FFMPEG_VideoReader.get_frame_number``): ``int(fps*t + 1e-5)``.
FRAME_NUMBER_EPSILON = 0.00001

#: The export composites on black (``CompositeVideoClip(bg_color=(0, 0, 0))``).
BACKGROUND_RGB = (0, 0, 0)

#: The picture effects the compiler applies per clip, in the order it applies them.
PICTURE_EFFECT_ORDER = ("color_grade", "lut")


class FramePlanError(ValueError):
    """A frame plan could not be derived (e.g. a sample time that is not finite)."""


# ---------------------------------------------------------------------------
# Decisions shared with the compiler
# ---------------------------------------------------------------------------


def clip_kind(clip: Clip, asset_kinds: Mapping[str, str | None]) -> str:
    """Derive a clip's renderable kind from its asset (or synthetic id)."""
    if clip.asset_id == TEXT_ASSET_ID:
        return "text"
    if clip.asset_id == CAPTION_ASSET_ID:
        return "caption"
    kind = asset_kinds.get(clip.asset_id)
    if kind == "audio":
        return "audio"
    if kind == "image":
        return "image"
    return "video"


def clips_in_sequence(track: Track) -> list[Clip]:
    """A track's clips in sequence order — the order the compiler places them in."""
    return sorted(track.clips, key=lambda entry: entry.start)


def uses_legacy_transition_path(clip: Clip) -> bool:
    """True when the incoming transition renders through the pre-catalog envelope path."""
    effect = next((e for e in clip.effects if e.type == "transition"), None)
    if effect is None or effect.params.get("disabled") is True:
        return False
    kind = str(effect.params.get("kind", ""))
    return transitions.is_legacy_kind(kind) and transitions.read_alignment(effect.params) == "start"


def legacy_transition(clip: Clip) -> transitions.Transition | None:
    """The envelope-path transition entering ``clip``; ``None`` when it takes the catalog path."""
    return transitions.transition_from_clip(clip) if uses_legacy_transition_path(clip) else None


def live_catalog_transitions(
    clip: Clip, use_legacy: bool
) -> list[tuple[str, transitions.Transition]]:
    """The catalog-path transitions on ``clip``, ``(role, transition)``, outgoing first."""
    incoming = None if use_legacy else transitions.resolve_from_clip(clip, "in")
    outgoing = transitions.resolve_from_clip(clip, "out")
    return [
        (role, tr)
        for role, tr in (("out", outgoing), ("in", incoming))
        if tr is not None and not tr.is_cut and tr.duration > 0.0
    ]


def transition_underlay_window(
    clip: Clip, neighbour: Clip, role: str
) -> tuple[float, float] | None:
    """The sequence span a transition on ``clip`` needs picture underneath it.

    A transition is stamped on butt-joined clips as an effect, not as an overlap, so the
    reveal would composite over black without an under-layer borrowed from the neighbour.

    :param clip: The clip carrying the transition effect.
    :param neighbour: The clip on the other side of the cut.
    :param role: ``"in"`` (ramp after the cut, on the incoming clip) or ``"out"``.
    :returns: ``(start, end)`` in sequence seconds, or ``None`` when the two clips are not
        adjacent (a transition on a non-cut renders nothing and needs no underlay).
    """
    transition = transitions.resolve_from_clip(clip, role)
    if transition is None or transition.is_cut or transition.duration <= 0.0:
        return None
    in_seconds, out_seconds = transitions.transition_window(
        transition.alignment, transition.duration
    )
    span = in_seconds if role == "in" else out_seconds
    if span <= 0.0:
        return None
    if role == "in":
        if abs(neighbour.end - clip.start) > CUT_ADJACENCY_TOLERANCE:
            return None
        return (clip.start, min(clip.end, clip.start + span))
    if abs(clip.end - neighbour.start) > CUT_ADJACENCY_TOLERANCE:
        return None
    return (max(clip.start, clip.end - span), clip.end)


def transition_neighbour(
    clip: Clip,
    role: str,
    adjacent: Clip | None,
    by_id: Mapping[str, Clip],
) -> Clip | None:
    """The clip a transition on ``clip`` transitions with: the named one, else the adjacent one."""
    wanted = "transition" if role == "in" else transitions.TRANSITION_OUT_EFFECT_TYPE
    effect = next((entry for entry in clip.effects if entry.type == wanted), None)
    if effect is None:
        return None
    key = "fromClipId" if role == "in" else "toClipId"
    named = effect.params.get(key)
    if isinstance(named, str) and named in by_id:
        return by_id[named]
    return adjacent


@dataclass(frozen=True)
class Underlay:
    """A picture placed UNDER a transition ramp, borrowed from the neighbour's handle."""

    role: str
    neighbour: Clip
    window: tuple[float, float]


def transition_underlays(
    clip: Clip,
    position: int,
    ordered: Sequence[Clip],
    asset_kinds: Mapping[str, str | None],
) -> list[Underlay]:
    """Every under-layer a video clip needs, in placement order (``in`` then ``out``)."""
    by_id = {entry.id: entry for entry in ordered}
    found: list[Underlay] = []
    for role, adjacent in (
        ("in", ordered[position - 1] if position > 0 else None),
        ("out", ordered[position + 1] if position + 1 < len(ordered) else None),
    ):
        neighbour = transition_neighbour(clip, role, adjacent, by_id)
        if neighbour is None or clip_kind(neighbour, asset_kinds) != "video":
            continue
        window = transition_underlay_window(clip, neighbour, role)
        if window is None:
            continue
        found.append(Underlay(role=role, neighbour=neighbour, window=window))
    return found


@dataclass(frozen=True)
class UnderlayMaterial:
    """Where an under-layer's picture comes from in the neighbour's asset.

    ``subclip`` reads ``[handle_start, handle_start + span)``; ``hold`` freezes the frame
    at ``edge_time`` because the neighbour is cut to the edge of its asset.
    """

    mode: str
    handle_start: float
    span: float
    edge_time: float


def underlay_material(
    neighbour: Clip, role: str, window: tuple[float, float], source_duration: float
) -> UnderlayMaterial:
    """Resolve what an under-layer shows, given the neighbour's asset duration."""
    start, end = window
    span = end - start
    borrow = span * UNDERLAY_HANDLE_SLACK
    if role == "in":
        # An absent `source_end` means the clip plays to the END of its asset: no handle.
        handle_start = (
            float(neighbour.source_end) if neighbour.source_end is not None else source_duration
        )
        available = max(0.0, source_duration - handle_start)
        edge_time = max(0.0, min(handle_start, source_duration - CUT_ADJACENCY_TOLERANCE))
    else:
        handle_start = max(0.0, float(neighbour.source_start) - borrow)
        available = float(neighbour.source_start) - handle_start
        edge_time = max(
            0.0,
            min(float(neighbour.source_start), source_duration - CUT_ADJACENCY_TOLERANCE),
        )
    mode = "subclip" if available >= span else "hold"
    return UnderlayMaterial(mode=mode, handle_start=handle_start, span=span, edge_time=edge_time)


def picture_effects(clip: Clip) -> list[Effect]:
    """The per-clip picture effects the compiler applies, in apply order (grade, then LUT)."""
    found: list[Effect] = []
    for effect_type in PICTURE_EFFECT_ORDER:
        effect = next((e for e in clip.effects if e.type == effect_type), None)
        if effect is not None:
            found.append(effect)
    return found


def enabled_masks(clip: Clip) -> list[MaskLayer]:
    """The clip's enabled mask layers, top first: the stack the export evaluates (schema v22)."""
    return [mask for mask in (clip.masks or []) if mask.enabled]


def mask_source_time(clip: Clip, local: float) -> float:
    """The ASSET source second a clip's mask stack is evaluated at, clip-local ``local``.

    Mask keyframes live on the source clock (ADR 0178). This is the continuous speed-stage
    mapping (``render.masks.clip_source_clock``): ramp, freeze, forward and reverse speed.
    Unlike :func:`video_source_time` it needs no probed fps, because the mask is attached
    after the speed stage and sampled at the clip's own time, not at a decoded frame.
    """
    start = float(clip.source_start)
    end = float(clip.source_end if clip.source_end is not None else clip.source_start)
    if has_speed_ramp(clip):
        span = max(0.0, end - start)
        return start + source_time_at(list(clip.speed_ramp or []), 0.0, float(local), span)
    speed = 1.0 if clip.speed is None else float(clip.speed)
    if speed == 0.0:
        return start
    if speed < 0.0:
        return end + local * speed
    return start + local * speed


def _mask_plan_json(clip: Clip, local: float) -> dict[str, Any] | None:
    masks = enabled_masks(clip)
    if not masks:
        return None
    layers: list[dict[str, Any]] = []
    for mask in masks:
        target: dict[str, Any] = {"kind": mask.target.kind}
        if mask.target.kind == "effect":
            target["effectId"] = mask.target.effect_id
        layers.append(
            {
                "id": mask.id,
                "kind": mask.kind,
                "mode": str(mask.mode.value),
                "invert": mask.invert,
                "space": str(mask.space.value),
                "featherModel": str(mask.feather_model.value),
                "target": target,
            }
        )
    return {"sourceTime": mask_source_time(clip, local), "layers": layers}


def fit_scale(
    source_size: tuple[float, float], target: tuple[int, int], *, fit_to_frame: bool
) -> float:
    """The base scale a layer is placed at: contain-fit for media, 1 for pre-rasterized layers."""
    if not fit_to_frame:
        return 1.0
    clip_w, clip_h = source_size
    target_w, target_h = target
    return float(min(target_w / clip_w, target_h / clip_h))


def layer_scale_at(clip: Clip, t: float, transition: transitions.Transition | None) -> float:
    """The authored scale at clip-local ``t`` times a geometry transition's zoom (no base fit)."""
    scale = evaluate_clip_transform(clip, t).scale
    if transition is not None and transitions.affects_geometry(transition):
        scale *= transitions.scale_at(transition, t)
    return scale


def layer_position_at(
    clip: Clip,
    t: float,
    source_size: tuple[float, float],
    base_scale: float,
    target: tuple[int, int],
    centre: tuple[float, float],
    transition: transitions.Transition | None,
) -> tuple[float, float]:
    """The layer's top-left in frame pixels at clip-local ``t`` (the compiler's ``position_at``)."""
    target_w, target_h = target
    clip_w, clip_h = source_size
    centre_x, centre_y = centre
    transform = evaluate_clip_transform(clip, t)
    scale = base_scale * layer_scale_at(clip, t, transition)
    width = clip_w * scale
    height = clip_h * scale
    dx, dy = (
        transitions.offset_at(transition, t, target_w, target_h)
        if transition is not None and transitions.affects_geometry(transition)
        else (0.0, 0.0)
    )
    return (centre_x - width / 2 + transform.x + dx, centre_y - height / 2 + transform.y + dy)


def layer_opacity_at(clip: Clip, t: float, transition: transitions.Transition | None) -> float:
    """Keyframed opacity at clip-local ``t`` times a legacy fade's envelope."""
    opacity = evaluate_clip_transform(clip, t).opacity
    if transition is not None and transitions.affects_opacity(transition):
        opacity *= transitions.opacity_at(transition, t)
    return opacity


def text_overlay_text(clip: Clip) -> tuple[str, Mapping[str, Any]] | None:
    """A text clip's words and style params, or ``None`` when it draws nothing."""
    text_effect = next((e for e in clip.effects if e.type == "text"), None)
    text = str(text_effect.params.get("text", "")) if text_effect is not None else ""
    if not text.strip():
        return None
    return text, (text_effect.params if text_effect is not None else {})


def caption_tracks(project: Project) -> list[Track]:
    """Caption tracks the burn-in draws, in LIST order (which puts ``tracks[0]`` lowest)."""
    return [
        track
        for track in project.timeline.tracks
        if track.type == TrackType.CAPTION and not track.hidden
    ]


def back_to_front(per_track: Sequence[Any]) -> list[Any]:
    """Track lists in composite order: ``tracks[0]`` is the visual front, so it goes last."""
    return list(reversed(per_track))


def layer_is_active(start: float, end: float, t: float) -> bool:
    """MoviePy's ``is_playing`` for a layer placed at ``start`` for ``end - start`` seconds."""
    return start <= t < start + (end - start)


def video_source_time(
    clip: Clip, local: float, source_fps: float | None, asset_duration: float | None
) -> float | None:
    """The source time MoviePy reads for a video clip at clip-local ``local``.

    Mirrors the compiler's ``_subclipped_source`` then ``_apply_speed`` time chain operation
    for operation, so the value is exact rather than approximately equal:

    * ramp: ``source_time_at(ramp, 0, local, span) + source_start``;
    * freeze (``speed == 0``): ``source_start``;
    * ``speed`` absent or 1: ``local + source_start``;
    * positive speed (``MultiplySpeed``): ``speed * local + source_start``;
    * reverse (``TimeMirror`` then ``MultiplySpeed(|speed|)``):
      ``subclip_duration - |speed| * local - 1 / fps + source_start``, which needs the
      probed source fps (``None`` when it is unknown).
    """
    start = float(clip.source_start)
    if has_speed_ramp(clip):
        if clip.source_end is None:
            return None
        max_source = float(clip.source_end) - start
        return source_time_at(list(clip.speed_ramp or []), 0.0, float(local), max_source) + start
    speed = clip.speed
    if speed is None or speed == 1.0:
        return local + start
    if speed == 0.0:
        return 0.0 + start
    if speed > 0.0:
        return speed * local + start
    if source_fps is None:
        return None
    end = clip.source_end
    if end is not None and asset_duration is not None and end >= asset_duration:
        end = None
    if end is None:
        if asset_duration is None:
            return None
        end = asset_duration
    subclip_duration = end - start
    magnitude = abs(speed)
    mirrored_at = local if magnitude == 1.0 else magnitude * local
    return subclip_duration - mirrored_at - 1 / source_fps + start


def source_frame_index(source_time: float | None, source_fps: float | None) -> int | None:
    """The frame number MoviePy's ffmpeg reader decodes for ``source_time``."""
    if source_time is None or source_fps is None:
        return None
    return int(source_fps * source_time + FRAME_NUMBER_EPSILON)


# ---------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LayerSource:
    asset_id: str
    asset_kind: str
    time: float | None
    frame: int | None

    def to_json(self) -> dict[str, Any]:
        return {
            "assetId": self.asset_id,
            "assetKind": self.asset_kind,
            "time": self.time,
            "frame": self.frame,
        }


@dataclass(frozen=True)
class LayerGeometry:
    """Where a layer lands. ``left/top/width/height`` are ``None`` for text and captions,
    whose raster size depends on font metrics only the pixel stage has."""

    base_scale: float
    scale: float
    anchor_x: float
    anchor_y: float
    rotation: float
    left: float | None = None
    top: float | None = None
    width: float | None = None
    height: float | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "baseScale": self.base_scale,
            "scale": self.scale,
            "anchorX": self.anchor_x,
            "anchorY": self.anchor_y,
            "rotation": self.rotation,
            "left": self.left,
            "top": self.top,
            "width": self.width,
            "height": self.height,
        }


@dataclass(frozen=True)
class TransitionState:
    role: str
    kind: str
    path: str
    render_kind: str
    progress: float
    eased: float

    def to_json(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "kind": self.kind,
            "path": self.path,
            "renderKind": self.render_kind,
            "progress": self.progress,
            "eased": self.eased,
        }


@dataclass(frozen=True)
class PlanLayer:
    kind: str
    role: str
    track_id: str
    clip_id: str | None
    for_clip_id: str | None
    local_time: float
    source: LayerSource | None = None
    text: str | None = None
    crop: dict[str, float] | None = None
    geometry: LayerGeometry | None = None
    opacity: float = 1.0
    blend_mode: str = "normal"
    effects: list[dict[str, Any]] = field(default_factory=list)
    mask: dict[str, Any] | None = None
    transitions: list[TransitionState] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "role": self.role,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "forClipId": self.for_clip_id,
            "localTime": self.local_time,
            "source": None if self.source is None else self.source.to_json(),
            "text": self.text,
            "crop": self.crop,
            "geometry": None if self.geometry is None else self.geometry.to_json(),
            "opacity": self.opacity,
            "blendMode": self.blend_mode,
            "effects": self.effects,
            "mask": self.mask,
            "transitions": [state.to_json() for state in self.transitions],
        }


@dataclass(frozen=True)
class FramePlan:
    time: float
    width: int
    height: int
    background: tuple[int, int, int]
    layers: list[PlanLayer]
    frame_effects: list[dict[str, Any]]

    def to_json(self) -> dict[str, Any]:
        return {
            "time": self.time,
            "width": self.width,
            "height": self.height,
            "background": list(self.background),
            "layers": [layer.to_json() for layer in self.layers],
            "frameEffects": self.frame_effects,
        }


@dataclass(frozen=True)
class _Context:
    project: Project
    t: float
    target: tuple[int, int]
    asset_kinds: dict[str, str | None]
    asset_sizes: dict[str, tuple[int, int]]
    asset_durations: dict[str, float | None]
    source_fps: Mapping[str, float]


def _crop_json(clip: Clip) -> dict[str, float] | None:
    crop = clip.crop
    if crop is None:
        return None
    return {"x": crop.x, "y": crop.y, "width": crop.width, "height": crop.height}


def _cropped_size(clip: Clip, size: tuple[int, int], *, honour_crop: bool) -> tuple[float, float]:
    width, height = float(size[0]), float(size[1])
    crop = clip.crop if honour_crop else None
    if crop is None:
        return (width, height)
    return (crop.width * width, crop.height * height)


def _picture_geometry(
    ctx: _Context,
    clip: Clip,
    local: float,
    *,
    honour_crop: bool,
    transition: transitions.Transition | None,
) -> LayerGeometry | None:
    size = ctx.asset_sizes.get(clip.asset_id)
    if size is None:
        return None
    source_size = _cropped_size(clip, size, honour_crop=honour_crop)
    base = fit_scale(source_size, ctx.target, fit_to_frame=True)
    centre = (ctx.target[0] / 2, ctx.target[1] / 2)
    scale = base * layer_scale_at(clip, local, transition)
    left, top = layer_position_at(clip, local, source_size, base, ctx.target, centre, transition)
    width = source_size[0] * scale
    height = source_size[1] * scale
    return LayerGeometry(
        base_scale=base,
        scale=scale,
        anchor_x=left + width / 2,
        anchor_y=top + height / 2,
        rotation=evaluate_clip_transform(clip, local).rotation,
        left=left,
        top=top,
        width=width,
        height=height,
    )


def _effects_json(clip: Clip) -> list[dict[str, Any]]:
    return [{"type": e.type, "params": dict(e.params)} for e in picture_effects(clip)]


def _transition_states(clip: Clip, local: float) -> list[TransitionState]:
    use_legacy = uses_legacy_transition_path(clip)
    states: list[TransitionState] = []
    legacy = legacy_transition(clip)
    if legacy is not None and legacy.duration > 0.0 and 0.0 <= local < legacy.duration:
        states.append(
            TransitionState(
                role="in",
                kind=legacy.kind,
                path="legacy",
                render_kind="",
                progress=transitions.progress(local, legacy.duration),
                eased=transitions.eased_progress(legacy, local),
            )
        )
    duration = float(clip.end - clip.start)
    for role, tr in live_catalog_transitions(clip, use_legacy):
        progress = transitions.progress_at(role, local, tr, duration)
        if progress is None:
            continue
        states.append(
            TransitionState(
                role=role,
                kind=tr.kind,
                path="catalog",
                render_kind=tr.render_kind,
                progress=progress,
                eased=transitions.ease(tr, progress),
            )
        )
    return states


def _video_layer(ctx: _Context, track: Track, clip: Clip) -> PlanLayer:
    local = ctx.t - clip.start
    fps = ctx.source_fps.get(clip.asset_id)
    source_time = video_source_time(clip, local, fps, ctx.asset_durations.get(clip.asset_id))
    transition = legacy_transition(clip)
    return PlanLayer(
        kind="picture",
        role="clip",
        track_id=track.id,
        clip_id=clip.id,
        for_clip_id=None,
        local_time=local,
        source=LayerSource(
            clip.asset_id, "video", source_time, source_frame_index(source_time, fps)
        ),
        crop=_crop_json(clip),
        geometry=_picture_geometry(ctx, clip, local, honour_crop=True, transition=transition),
        opacity=layer_opacity_at(clip, local, transition),
        blend_mode=_blend(clip),
        effects=_effects_json(clip),
        mask=_mask_plan_json(clip, local),
        transitions=_transition_states(clip, local),
    )


def _image_layer(ctx: _Context, track: Track, clip: Clip) -> PlanLayer:
    local = ctx.t - clip.start
    return PlanLayer(
        kind="picture",
        role="clip",
        track_id=track.id,
        clip_id=clip.id,
        for_clip_id=None,
        local_time=local,
        source=LayerSource(clip.asset_id, "image", None, None),
        geometry=_picture_geometry(ctx, clip, local, honour_crop=False, transition=None),
        blend_mode=_blend(clip),
        effects=_effects_json(clip),
    )


def _underlay_layer(ctx: _Context, track: Track, clip: Clip, underlay: Underlay) -> PlanLayer:
    neighbour = underlay.neighbour
    start, _ = underlay.window
    local = ctx.t - start
    duration = ctx.asset_durations.get(neighbour.asset_id)
    fps = ctx.source_fps.get(neighbour.asset_id)
    source_time: float | None = None
    if duration is not None:
        material = underlay_material(neighbour, underlay.role, underlay.window, duration)
        source_time = (
            local + material.handle_start if material.mode == "subclip" else material.edge_time
        )
    plain = neighbour.model_copy(update={"keyframes": []})
    return PlanLayer(
        kind="picture",
        role="underlay",
        track_id=track.id,
        clip_id=neighbour.id,
        for_clip_id=clip.id,
        local_time=local,
        source=LayerSource(
            neighbour.asset_id, "video", source_time, source_frame_index(source_time, fps)
        ),
        crop=_crop_json(neighbour),
        geometry=_picture_geometry(ctx, plain, local, honour_crop=True, transition=None),
        blend_mode=_blend(neighbour),
        effects=_effects_json(neighbour),
    )


def _text_layer(ctx: _Context, track: Track, clip: Clip) -> PlanLayer | None:
    content = text_overlay_text(clip)
    if content is None:
        return None
    text, params = content
    local = ctx.t - clip.start
    layout = text_overlay_layout(params, ctx.target[0], ctx.target[1])
    transform = evaluate_clip_transform(clip, local)
    return PlanLayer(
        kind="text",
        role="clip",
        track_id=track.id,
        clip_id=clip.id,
        for_clip_id=None,
        local_time=local,
        text=text,
        geometry=LayerGeometry(
            base_scale=1.0,
            scale=layer_scale_at(clip, local, None),
            anchor_x=layout.centre_x + transform.x,
            anchor_y=layout.centre_y + transform.y,
            rotation=transform.rotation,
        ),
        blend_mode=_blend(clip),
    )


def _blend(clip: Clip) -> str:
    mode = clip.blend_mode
    return "normal" if mode is None else str(mode.value)


def _track_layers(ctx: _Context, track: Track) -> list[PlanLayer]:
    """One track's active layers in the compiler's placement order."""
    if track.hidden:
        return []
    ordered = clips_in_sequence(track)
    layers: list[PlanLayer] = []
    for position, clip in enumerate(ordered):
        kind = clip_kind(clip, ctx.asset_kinds)
        if kind == "image":
            if layer_is_active(clip.start, clip.end, ctx.t):
                layers.append(_image_layer(ctx, track, clip))
        elif kind == "video":
            for underlay in transition_underlays(clip, position, ordered, ctx.asset_kinds):
                if layer_is_active(underlay.window[0], underlay.window[1], ctx.t):
                    layers.append(_underlay_layer(ctx, track, clip, underlay))
            if layer_is_active(clip.start, clip.end, ctx.t):
                layers.append(_video_layer(ctx, track, clip))
        elif kind == "text" and layer_is_active(clip.start, clip.end, ctx.t):
            text_layer = _text_layer(ctx, track, clip)
            if text_layer is not None:
                layers.append(text_layer)
    return layers


def _has_picture_anywhere(project: Project, asset_kinds: Mapping[str, str | None]) -> bool:
    for track in project.timeline.tracks:
        if track.hidden:
            continue
        for clip in track.clips:
            kind = clip_kind(clip, asset_kinds)
            if kind in PICTURE_KINDS or (kind == "text" and text_overlay_text(clip) is not None):
                return True
    return False


def _has_audio_anywhere(project: Project, asset_kinds: Mapping[str, str | None]) -> bool:
    return any(
        not track.muted and any(clip_kind(c, asset_kinds) == "audio" for c in track.clips)
        for track in project.timeline.tracks
    )


def _caption_layers(ctx: _Context) -> list[PlanLayer]:
    layers: list[PlanLayer] = []
    for track in caption_tracks(ctx.project):
        for clip in track.clips:
            cue = resolve_caption_cue(clip, ctx.project.transcript)
            if not cue.text.strip() or not layer_is_active(clip.start, clip.end, ctx.t):
                continue
            layers.append(
                PlanLayer(
                    kind="caption",
                    role="clip",
                    track_id=track.id,
                    clip_id=clip.id,
                    for_clip_id=None,
                    local_time=ctx.t - clip.start,
                    text=cue.text,
                    blend_mode=_blend(clip),
                )
            )
    return layers


def frame_plan_at(
    project: Project,
    t: float,
    *,
    target: tuple[int, int] | None = None,
    burn_captions: bool = False,
    source_fps: Mapping[str, float] | None = None,
) -> FramePlan:
    """Describe the exported frame at sequence time ``t``, back to front.

    :param project: The project to describe.
    :param t: Sequence time in seconds.
    :param target: Output frame size; defaults to the project resolution, as the preview uses.
    :param burn_captions: Whether the export burns caption tracks in.
    :param source_fps: Probed frame rate per asset id. Needed for frame numbers and for
        reverse playback, whose time mirror is one source frame short.
    :raises FramePlanError: If ``t`` is not a finite number.
    """
    if t != t or t in (float("inf"), float("-inf")):
        raise FramePlanError(f"Frame plan time must be finite, got {t!r}.")
    size = target or (project.resolution.width, project.resolution.height)
    asset_sizes: dict[str, tuple[int, int]] = {}
    for asset in project.assets:
        media = asset.media
        if media is not None and media.width and media.height:
            asset_sizes[asset.id] = (media.width, media.height)
    ctx = _Context(
        project=project,
        t=t,
        target=size,
        asset_kinds={asset.id: asset.kind for asset in project.assets},
        asset_sizes=asset_sizes,
        asset_durations={asset.id: asset.duration_seconds for asset in project.assets},
        source_fps=dict(source_fps or {}),
    )
    layers: list[PlanLayer] = []
    for track_layers in back_to_front(
        [_track_layers(ctx, track) for track in project.timeline.tracks]
    ):
        layers.extend(track_layers)
    timeline_end = max((c.end for tr in project.timeline.tracks for c in tr.clips), default=0.0)
    if (
        not _has_picture_anywhere(project, ctx.asset_kinds)
        and _has_audio_anywhere(project, ctx.asset_kinds)
        and layer_is_active(0.0, timeline_end, t)
    ):
        # The compiler's black stand-in for an audio-only timeline, as long as the timeline.
        layers.append(
            PlanLayer(
                kind="solid", role="clip", track_id="", clip_id=None, for_clip_id=None, local_time=t
            )
        )
    if burn_captions:
        layers.extend(_caption_layers(ctx))
    frame_effects = [
        {
            "trackId": track.id,
            "layerId": layer.id,
            "kind": layer.kind,
            "effectId": layer.effect_id,
            "params": dict(layer.params),
            "intensity": layer.strength,
        }
        for track, layer in project.timeline.active_effect_layers_at(t)
    ]
    _log.debug(
        "frame plan at %.6f: %d layers, %d frame effects", t, len(layers), len(frame_effects)
    )
    return FramePlan(
        time=t,
        width=size[0],
        height=size[1],
        background=BACKGROUND_RGB,
        layers=layers,
        frame_effects=frame_effects,
    )
