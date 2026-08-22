"""Timeline → MoviePy composition compiler (plan 2.2).

WHY: the render engine must turn a declarative :class:`Project` timeline into a
concrete MoviePy clip **deterministically** — the same project always compiles to
the same composition, which is what makes golden-media tests and "reliability
over magic" (PRD §3.6) possible.

Two concerns are split so most of the logic is testable without MoviePy or real
media:

* **Pure timeline math** — :func:`timeline_duration`, :func:`expected_render`,
  :func:`unsupported_track_types`. No I/O, no MoviePy; 100% unit-testable.
* **Composition** — :func:`compile_timeline` builds the MoviePy clip and is
  covered by integration tests against tiny generated media.

Scope: the deterministic baseline composites **video** and **audio** tracks
(position by timeline start, trim by source in/out, letterbox-fit to the preset
frame). On top of the fit, per-clip **transform keyframes** are now applied
(Phase 5): ``scale`` (zoom/punch-in), ``x``/``y`` (reframing), and ``rotation``
animate as MoviePy time-varying functions via
:mod:`framepilot_engine.effects.transform`; a per-clip **color grade** (the
``color_grade`` effect) is applied per frame via
:mod:`framepilot_engine.render.color`; per-clip **audio** (gain, mute,
peak-normalize, fade in/out, and presence ducking — the ``adjust_audio`` effect)
is composed into one time-varying gain in the mixer via
:mod:`framepilot_engine.audio.mixing`. When ``burn_captions`` is set,
caption-track clips are burned in (Phase 3.3): their text is reconstructed from
the project transcript and rasterized to an overlay (see
:mod:`framepilot_engine.render.captions`). Per-clip **opacity** and **transitions**
(fade / cross-dissolve via opacity, push / zoom via geometry, blur) now render too
(Phase 6) via :mod:`framepilot_engine.render.transitions` and the clip mask.
Text overlays (``add_text_overlay``, clip kind ``text``) are burned in
unconditionally — their ``text`` effect is rasterized and composited centered in
the frame (see :mod:`framepilot_engine.render.text_overlay`) — so an applied text
overlay always renders, never silently drops. Caption tracks still burn in only
when ``burn_captions`` is set; anything not yet rendered is reported by
:func:`unsupported_track_types` / :func:`unsupported_animated_properties`, never
silently dropped. A clip's constant ``speed`` (schema v6 time-remap) is applied via
:func:`_apply_speed` (MoviePy's ``vfx.MultiplySpeed``) before it is placed, so a
sped-up/slow-mo clip's rendered segment actually matches its (derived) timeline
span — see that function's docstring for the pitch-shift tradeoff this MVP accepts.
A clip's optional ``crop`` rect (schema v7) is applied via :func:`_apply_crop`
(MoviePy's ``vfx.Crop``) right after subclipping and before speed/color-grade/
mask/placement, so the crop is the frame every later stage operates on. A clip's
optional ``blend_mode`` (schema v8) changes *how* its picture layer composites
against whatever is beneath it: :func:`_blend_layer_over` folds it in with the
:mod:`framepilot_engine.render.blend` per-channel formulas (see that module and
``docs/adr/0048-clip-blend-mode-schema-v8.md`` for the base/blend layer
convention), still respecting the clip's own alpha. When no clip in the
timeline sets a non-``'normal'`` blend mode, compositing takes the original
single-``CompositeVideoClip`` fast path — byte-identical to pre-v8 renders.

**Effect layers (schema v13, ADR 0088)** are the one stage that is deliberately
NOT per-clip. Everything above transforms a single clip's picture; an effect layer
transforms the frame composited from every visible track beneath it, for its own
time range. :func:`framepilot_engine.render.frame_effects.apply_effect_layers`
therefore wraps the finished composite — after all tracks are folded together and
after burned captions, before audio is attached — and a timeline with no effect
layers passes through untouched, so pre-v13 projects render byte-identically and
pay no per-frame cost.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, Any, cast

import numpy as np

from framepilot_engine.audio.filters import (
    apply_audio_filter,
    build_clip_filter,
    peak_normalize_gain_db,
)
from framepilot_engine.audio.mixing import (
    apply_gain_envelope,
    automation_envelope,
    db_to_gain,
    duck_gain_at,
    fade_gain_at,
    sample_envelope,
)
from framepilot_engine.effects.speed_curve import has_speed_ramp, source_time_at
from framepilot_engine.effects.transform import (
    OPACITY,
    ROTATION,
    animated_properties,
    deferred_transform_properties,
    evaluate_clip_transform,
    has_rendered_transform,
)
from framepilot_engine.media.assets import AssetIndex
from framepilot_engine.render import transition_passes, transitions
from framepilot_engine.render.blend import apply_blend_mode
from framepilot_engine.render.caption_templates import layer_caption_style
from framepilot_engine.render.captions import (
    caption_style_is_animated,
    render_caption_image,
    resolve_caption_cue,
)
from framepilot_engine.render.color import (
    CubeLut,
    apply_color_grade,
    apply_lut,
    color_grade_from_params,
    parse_cube_lut,
)
from framepilot_engine.render.frame_effects import apply_effect_layers
from framepilot_engine.render.masks import (
    has_mask_keyframes,
    mask_spec_at,
    mask_spec_from_params,
    rasterize_mask,
)
from framepilot_engine.render.presets import ExportPreset
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.render.text_overlay import render_text_overlay_image, text_overlay_style
from framepilot_engine.safety import PathTraversalError, resolve_within
from framepilot_engine.timeline.models import (
    Clip,
    Project,
    Timeline,
    TrackType,
    TranscriptWord,
)
from framepilot_engine.validation.render_validation import ExpectedRender

if TYPE_CHECKING:  # pragma: no cover - typing only
    from moviepy import VideoClip

_RENDERABLE = {TrackType.VIDEO, TrackType.AUDIO}
_PICTURE_KINDS = frozenset({"video", "image"})


def clip_kind(clip: Clip, asset_kinds: Mapping[str, str | None]) -> str:
    """Derive a clip's renderable kind from its asset (or synthetic id)."""
    if clip.asset_id == "__text__":
        return "text"
    if clip.asset_id == "__caption__":
        return "caption"
    kind = asset_kinds.get(clip.asset_id)
    if kind == "audio":
        return "audio"
    if kind == "image":
        return "image"
    return "video"


def _asset_kinds_from_project(project: Project) -> dict[str, str | None]:
    return {asset.id: asset.kind for asset in project.assets}


_CAPTION_BOTTOM_MARGIN_FRACTION = 0.08


class CompileError(Exception):
    """Raised when a timeline cannot be compiled (e.g. a clip's asset is missing)."""


def _subclipped_source(source: Any, clip: Clip) -> Any:
    end = clip.source_end
    if end is not None and end >= float(source.duration):
        end = None
    return source.subclipped(clip.source_start, end)


def _apply_crop(source: Any, clip: Clip) -> Any:
    crop = clip.crop
    if crop is None:
        return source
    from moviepy import vfx

    width, height = source.size
    x1 = crop.x * width
    y1 = crop.y * height
    x2 = (crop.x + crop.width) * width
    y2 = (crop.y + crop.height) * height
    return source.with_effects([vfx.Crop(x1=x1, y1=y1, x2=x2, y2=y2)])


_SPEED_DURATION_TOLERANCE_SECONDS = 0.05


def _apply_speed(source: Any, clip: Clip) -> Any:
    speed = clip.speed
    expected_duration = clip.end - clip.start
    if has_speed_ramp(clip):
        ramp = list(clip.speed_ramp or [])
        if clip.source_end is None or clip.source_start is None:
            raise CompileError(
                f"Clip {clip.id!r} carries a speed ramp but no source range. "
                "A speed curve describes how footage is consumed; there is none here."
            )
        max_source = float(clip.source_end) - float(clip.source_start)

        def _ramped_source_time(t: float) -> float:
            return source_time_at(ramp, 0.0, float(t), max_source)

        remapped = source.time_transform(_ramped_source_time, apply_to=["mask", "audio"])
        return remapped.with_duration(expected_duration)
    if speed is None or speed == 1.0:
        return source
    if speed == 0.0:
        frozen = source.time_transform(lambda _t: 0.0, apply_to=["mask"])
        return frozen.without_audio().with_duration(expected_duration)
    if speed < 0.0:
        from moviepy import vfx as _vfx

        reversed_source = source.with_effects([_vfx.TimeMirror()])
        magnitude = abs(speed)
        remapped = (
            reversed_source
            if magnitude == 1.0
            else reversed_source.with_effects([_vfx.MultiplySpeed(factor=magnitude)])
        )
        actual = float(remapped.duration)
        if abs(actual - expected_duration) > _SPEED_DURATION_TOLERANCE_SECONDS:
            raise CompileError(
                f"Clip {clip.id!r} reverse speed {speed!r} produced a {actual:.4f}s "
                f"segment but the timeline span is {expected_duration:.4f}s "
                "(end - start). Refusing to render a misaligned clip."
            )
        return remapped
    from moviepy import vfx

    remapped = source.with_effects([vfx.MultiplySpeed(factor=speed)])
    actual_duration = float(remapped.duration)
    if abs(actual_duration - expected_duration) > _SPEED_DURATION_TOLERANCE_SECONDS:
        raise CompileError(
            f"Clip {clip.id!r} speed {speed!r} produced a {actual_duration:.4f}s "
            f"segment but the timeline span is {expected_duration:.4f}s "
            "(end - start). Refusing to render a misaligned clip."
        )
    return remapped


def timeline_duration(timeline: Timeline) -> float:
    ends = [clip.end for track in timeline.tracks for clip in track.clips]
    return max(ends) if ends else 0.0


def has_audio_content(timeline: Timeline, asset_kinds: Mapping[str, str | None]) -> bool:
    return any(
        not track.muted and any(clip_kind(clip, asset_kinds) == "audio" for clip in track.clips)
        for track in timeline.tracks
    )


def has_video_content(timeline: Timeline, asset_kinds: Mapping[str, str | None]) -> bool:
    return any(
        not track.hidden
        and any(clip_kind(clip, asset_kinds) in _PICTURE_KINDS for clip in track.clips)
        for track in timeline.tracks
    )


def unsupported_track_types(
    timeline: Timeline,
    asset_kinds: Mapping[str, str | None] | None = None,
    *,
    burn_captions: bool = False,
) -> list[str]:
    kinds = asset_kinds or {}
    rendered = {"video", "image", "audio", "text"} | ({"caption"} if burn_captions else set())
    deferred = {
        clip_kind(clip, kinds)
        for track in timeline.tracks
        for clip in track.clips
        if clip_kind(clip, kinds) not in rendered
    }
    return sorted(deferred)


def expected_render(project: Project, preset: ExportPreset) -> ExpectedRender:
    asset_kinds = _asset_kinds_from_project(project)
    return ExpectedRender(
        duration_seconds=timeline_duration(project.timeline),
        expect_video=has_video_content(project.timeline, asset_kinds),
        expect_audio=has_audio_content(project.timeline, asset_kinds),
    )


def unsupported_animated_properties(timeline: Timeline) -> list[str]:
    deferred: set[str] = set()
    for track in timeline.tracks:
        for clip in track.clips:
            deferred.update(deferred_transform_properties(clip))
    return sorted(deferred)


def _compile_image_clip(
    image_clip_cls: Any, path: str, clip: Clip, target: tuple[int, int], lut_base_dir: Path
) -> Any:
    source = image_clip_cls(path).with_duration(clip.end - clip.start)
    source = _apply_color_grade(source, clip, lut_base_dir)
    placed = _place_video_clip(source, clip, target, None)
    return placed.with_start(clip.start)


def _compile_text_clip(image_clip_cls: Any, clip: Clip, target: tuple[int, int]) -> Any | None:
    text_effect = next((e for e in clip.effects if e.type == "text"), None)
    text = str(text_effect.params.get("text", "")) if text_effect is not None else ""
    if not text.strip():
        return None
    style_params = text_effect.params if text_effect is not None else {}
    font_size, color = text_overlay_style(style_params, target[1])
    image = render_text_overlay_image(text, target[0], target[1], font_size=font_size, color=color)
    return (
        image_clip_cls(image, transparent=True)
        .with_start(clip.start)
        .with_duration(clip.end - clip.start)
        .with_position("center")
    )


def _place_video_clip(
    source: VideoClip,
    clip: Clip,
    target: tuple[int, int],
    transition: transitions.Transition | None,
) -> VideoClip:
    target_w, target_h = target
    clip_w, clip_h = source.size
    base_scale: float = float(min(target_w / clip_w, target_h / clip_h))
    geo_transition = transition is not None and transitions.affects_geometry(transition)
    if not has_rendered_transform(clip) and not geo_transition:
        return source.resized(base_scale).with_position("center")

    def effective_scale(t: float) -> float:
        scale = evaluate_clip_transform(clip, t).scale
        if transition is not None and geo_transition:
            scale *= transitions.scale_at(transition, t)
        return scale

    def scale_at(t: float) -> float:
        return base_scale * effective_scale(t)

    def position_at(t: float) -> tuple[float, float]:
        transform = evaluate_clip_transform(clip, t)
        scale = base_scale * effective_scale(t)
        width = clip_w * scale
        height = clip_h * scale
        dx, dy = (
            transitions.offset_at(transition, t, target_w, target_h)
            if transition is not None and geo_transition
            else (0.0, 0.0)
        )
        pos_x = (target_w - width) / 2 + transform.x + dx
        pos_y = (target_h - height) / 2 + transform.y + dy
        return (pos_x, pos_y)

    placed = source.resized(scale_at)
    if ROTATION in animated_properties(clip):
        placed = placed.rotated(lambda t: evaluate_clip_transform(clip, t).rotation, expand=False)
    return placed.with_position(position_at)


#: How close two clips must sit to count as one cut. A frame at 240fps is ~4ms, so this is
#: below any real edit boundary while still absorbing float noise from time quantization.
_CUT_ADJACENCY_TOLERANCE = 1e-3

#: How much of a neighbour's handle a transition under-layer may borrow, as a multiple of
#: the ramp itself. Slightly over 1 so a rounding error at the tail cannot leave the last
#: frame of the ramp uncovered.
_UNDERLAY_HANDLE_SLACK = 1.05


def transition_underlay_window(
    clip: Clip, neighbour: Clip, role: str
) -> tuple[float, float] | None:
    """The sequence span a transition on ``clip`` needs picture underneath it.

    A transition is stamped on butt-joined clips as an effect, not as an overlap: the
    incoming clip animates in over its own first ``in_seconds``, by which time the outgoing
    clip has already ended. Nothing is beneath it, so the reveal composites against the
    black background — a "cross dissolve" dissolves up from black, and a whip pan whips in
    over black. Both were reported by the perceptual reviewer as "unexpected black frames"
    at every cut, and no proposal the agent could make would fix them, because the fault is
    here.

    :param clip: The clip carrying the transition effect.
    :param neighbour: The clip on the other side of the cut.
    :param role: ``"in"`` (ramp after the cut, on the incoming clip) or ``"out"``.
    :returns: ``(start, end)`` in sequence seconds, or ``None`` when the two clips are not
        actually adjacent (a transition on a non-cut renders nothing and needs no underlay).
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
        # The outgoing clip must end where this one begins, or there is no cut here.
        if abs(neighbour.end - clip.start) > _CUT_ADJACENCY_TOLERANCE:
            return None
        return (clip.start, min(clip.end, clip.start + span))
    if abs(clip.end - neighbour.start) > _CUT_ADJACENCY_TOLERANCE:
        return None
    return (max(clip.start, clip.end - span), clip.end)


def _transition_neighbour(
    clip: Clip,
    role: str,
    adjacent: Clip | None,
    by_id: Mapping[str, Clip],
) -> Clip | None:
    """The clip a transition on ``clip`` is transitioning with, or ``None``.

    The effect names its counterpart (``fromClipId`` on the incoming half, ``toClipId`` on
    the outgoing one), and that name is authoritative — it is what the operation validated
    against. Sequence adjacency is only the fallback for a hand-written project whose params
    omit it.
    """
    wanted = "transition" if role == "in" else transitions.TRANSITION_OUT_EFFECT_TYPE
    effect = next((entry for entry in clip.effects if entry.type == wanted), None)
    if effect is None:
        return None
    key = "fromClipId" if role == "in" else "toClipId"
    named = effect.params.get(key)
    if isinstance(named, str) and named in by_id:
        return by_id[named]
    return adjacent


def _underlay_layer(
    video_file_clip_cls: Any,
    image_clip_cls: Any,
    neighbour: Clip,
    role: str,
    window: tuple[float, float],
    path: str,
    target: tuple[int, int],
    lut_base_dir: Path,
    max_decode_dimension: int | None,
    opened: list[Any],
) -> Any:
    """Build the picture that sits UNDER a transition ramp, from the neighbour's handle.

    The neighbour keeps playing (or, when it has no material left, holds its edge frame) for
    exactly the ramp, framed and graded exactly as it is on the timeline — so a dissolve
    resolves into the shot the editor actually cut from, and a whip pan whips off it.

    :param neighbour: The clip on the other side of the cut, whose material and look the
        under-layer borrows.
    :param role: ``"in"`` ⇒ the ramp is after the cut, so this continues the neighbour PAST
        its out-point; ``"out"`` ⇒ the ramp is before the cut, so this is the neighbour's
        pre-roll BEFORE its in-point.
    :param window: The sequence span to cover, from :func:`transition_underlay_window`.
    :param opened: The compiler's resource ledger; everything opened here is appended so a
        failed compile still closes it.
    """
    start, end = window
    span = end - start
    reader = _open_source_reader(video_file_clip_cls, path, max_decode_dimension)
    opened.append(reader)
    source_duration = float(reader.duration)
    borrow = span * _UNDERLAY_HANDLE_SLACK
    if role == "in":
        # Continue past the out-point, if the asset has anything left there.
        handle_start = float(neighbour.source_end if neighbour.source_end is not None else 0.0)
        available = max(0.0, source_duration - handle_start)
        edge_time = max(0.0, min(handle_start, source_duration - _CUT_ADJACENCY_TOLERANCE))
    else:
        # Roll back before the in-point, if there is anything before it.
        handle_start = max(0.0, float(neighbour.source_start) - borrow)
        available = float(neighbour.source_start) - handle_start
        edge_time = max(
            0.0,
            min(float(neighbour.source_start), source_duration - _CUT_ADJACENCY_TOLERANCE),
        )

    if available >= span:
        material = reader.subclipped(handle_start, handle_start + span)
    else:
        # No handle left (the neighbour is cut to the very edge of its asset). Hold its edge
        # frame rather than reveal black: a held frame under a fast ramp reads as continuous;
        # black reads as a flash, which is the defect this exists to remove.
        held = image_clip_cls(reader.get_frame(edge_time)).with_duration(span)
        opened.append(held)
        material = held

    material = _apply_crop(material, neighbour)
    material = _apply_color_grade(material, neighbour, lut_base_dir)
    # Placed with the NEIGHBOUR's framing, but without its transition (an under-layer is
    # plain picture — it is the thing being revealed, never a second reveal) and without its
    # keyframed motion, which is timed to the neighbour's own clip-local clock.
    plain = neighbour.model_copy(update={"keyframes": []})
    placed = _place_video_clip(material, plain, target, None)
    return placed.with_start(start).with_duration(span)


def _apply_transition_blur(
    source: VideoClip, transition: transitions.Transition | None
) -> VideoClip:
    if transition is None or not transitions.affects_blur(transition):
        return source
    width, height = source.size
    min_dim = float(min(width, height))

    def blurred(get_frame: Any, t: float) -> Any:
        frame = get_frame(t)
        radius = transitions.blur_radius_at(transition, t, min_dim)
        if radius <= 0.5:
            return frame
        from PIL import Image, ImageFilter

        image = Image.fromarray(frame.astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius))
        return np.asarray(image)

    return source.transform(blurred, keep_duration=True)


def _attach_mask(
    source: VideoClip, clip: Clip, transition: transitions.Transition | None
) -> VideoClip:
    width, height = source.size
    mask_effect = next((e for e in clip.effects if e.type == "mask"), None)
    geometry_animated = mask_effect is not None and has_mask_keyframes(mask_effect)
    opacity_animated = OPACITY in animated_properties(clip)
    fade_transition = transition is not None and transitions.affects_opacity(transition)
    wipe_transition = transition is not None and transitions.affects_wipe(transition)
    static_opacity = evaluate_clip_transform(clip, 0.0).opacity
    nothing_to_mask = (
        mask_effect is None
        and not opacity_animated
        and not fade_transition
        and not wipe_transition
        and static_opacity >= 1.0
    )
    if nothing_to_mask:
        return source

    def opacity_at(t: float) -> float:
        opacity = evaluate_clip_transform(clip, t).opacity
        if fade_transition:
            assert transition is not None
            opacity *= transitions.opacity_at(transition, t)
        return opacity

    if wipe_transition:
        assert transition is not None
        wipe_axis, wipe_inverted = transitions.wipe_axis(transition)
        wipe_feather = transitions.wipe_softness(transition)
        extent = width if wipe_axis == "x" else height
        fracs = (np.arange(extent, dtype=np.float64) + 0.5) / extent
        if wipe_inverted:
            fracs = 1.0 - fracs
        sweep_fracs = fracs.reshape((1, extent)) if wipe_axis == "x" else fracs.reshape((extent, 1))

    def alpha_at(t: float) -> Any:
        opacity = opacity_at(t)
        if mask_effect is None:
            alpha = np.full((height, width), opacity, dtype=np.float64)
        else:
            spec = (
                mask_spec_at(mask_effect, t)
                if geometry_animated
                else mask_spec_from_params(mask_effect.params)
            )
            alpha = rasterize_mask(spec, width, height) * opacity
        if wipe_transition:
            assert transition is not None
            reveal = transitions.wipe_progress_at(transition, t)
            wipe_band = np.clip(
                (transitions.wipe_edge(reveal, wipe_feather) - sweep_fracs) / wipe_feather, 0.0, 1.0
            )
            alpha = alpha * wipe_band
        return alpha

    time_varying = geometry_animated or opacity_animated or fade_transition or wipe_transition
    if time_varying:
        from moviepy import VideoClip as _VideoClip

        mask = _VideoClip(frame_function=alpha_at, is_mask=True).with_duration(source.duration)
    else:
        from moviepy import ImageClip

        mask = ImageClip(alpha_at(0.0), is_mask=True).with_duration(source.duration)
    return source.with_mask(mask)


def _uses_legacy_transition_path(clip: Clip) -> bool:
    effect = next((e for e in clip.effects if e.type == "transition"), None)
    if effect is None or effect.params.get("disabled") is True:
        return False
    kind = str(effect.params.get("kind", ""))
    return transitions.is_legacy_kind(kind) and transitions.read_alignment(effect.params) == "start"


def _apply_catalog_transition(source: VideoClip, clip: Clip, use_legacy: bool) -> VideoClip:
    incoming = None if use_legacy else transitions.resolve_from_clip(clip, "in")
    outgoing = transitions.resolve_from_clip(clip, "out")
    live = [
        (role, tr)
        for role, tr in (("out", outgoing), ("in", incoming))
        if tr is not None and not tr.is_cut and tr.duration > 0.0
    ]
    if not live:
        return source

    duration = float(clip.end - clip.start)
    existing_mask = source.mask
    memo: dict[int, tuple[np.ndarray, np.ndarray]] = {}

    def evaluate(t: float, frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        key = round(t * 1_000_000)
        hit = memo.get(key)
        if hit is not None:
            return hit
        rgb = frame.astype(np.float32) / np.float32(255.0) if frame.dtype == np.uint8 else frame
        alpha = np.ones(rgb.shape[:2], dtype=np.float32)
        for role, tr in live:
            progress = transitions.progress_at(role, t, tr, duration)
            if progress is None:
                continue
            eased = transitions.ease(tr, progress)
            if role == "out":
                _, revealed = transition_passes.apply_transition_to_frame(rgb, tr, eased)
                alpha = np.asarray((alpha * (1.0 - revealed)).astype(np.float32))
            else:
                rgb, revealed = transition_passes.apply_transition_to_frame(rgb, tr, eased)
                alpha = np.asarray((alpha * revealed).astype(np.float32))
        result = (rgb, alpha)
        if len(memo) > 2:
            memo.clear()
        memo[key] = result
        return result

    def picture_at(get_frame: Callable[[float], np.ndarray], t: float) -> np.ndarray:
        frame = get_frame(t)
        rgb, _ = evaluate(t, frame)
        if frame.dtype == np.uint8:
            scaled = np.clip(rgb, 0.0, 1.0) * np.float32(255.0) + np.float32(0.5)
            return np.asarray(scaled.astype(np.uint8))
        return np.asarray(np.clip(rgb, 0.0, 1.0))

    transformed = source.transform(picture_at, keep_duration=True)

    def alpha_at(t: float) -> Any:
        _, alpha = evaluate(t, source.get_frame(t))
        if existing_mask is not None:
            alpha = alpha * existing_mask.get_frame(t)
        return alpha

    from moviepy import VideoClip as _VideoClip

    mask = _VideoClip(frame_function=alpha_at, is_mask=True).with_duration(source.duration)
    return transformed.with_mask(mask)


def _resolve_lut_path(params: Mapping[str, Any], base_dir: Path, clip_id: str) -> Path:
    declared = params.get("path")
    if not isinstance(declared, str) or not declared:
        raise CompileError(f"Clip {clip_id!r} 'lut' effect is missing a string 'path' param.")
    try:
        return resolve_within(base_dir, declared)
    except PathTraversalError as exc:
        raise CompileError(
            f"Clip {clip_id!r} 'lut' path {declared!r} escapes the project sandbox: {exc}"
        ) from exc


def _load_lut(path: Path, clip_id: str) -> CubeLut:
    if not path.is_file():
        raise CompileError(f"Clip {clip_id!r} 'lut' file not found: {path}")
    try:
        return parse_cube_lut(path.read_text())
    except ValueError as exc:
        raise CompileError(f"Clip {clip_id!r} has an invalid .cube LUT ({path}): {exc}") from exc


def _apply_color_grade(source: VideoClip, clip: Clip, lut_base_dir: Path) -> VideoClip:
    grade_effect = next((e for e in clip.effects if e.type == "color_grade"), None)
    if grade_effect is not None:
        grade = color_grade_from_params(grade_effect.params)
        if not grade.is_identity:
            source = source.image_transform(lambda frame: apply_color_grade(frame, grade))
    lut_effect = next((e for e in clip.effects if e.type == "lut"), None)
    if lut_effect is not None:
        lut = _load_lut(_resolve_lut_path(lut_effect.params, lut_base_dir, clip.id), clip.id)
        source = source.image_transform(lambda frame: apply_lut(frame, lut))
    return source


def _audio_settings(clip: Clip) -> dict[str, Any]:
    effect = next((e for e in clip.effects if e.type == "audio_gain"), None)
    return dict(effect.params) if effect is not None else {}


def _audio_gain_factor(clip: Clip) -> float:
    params = _audio_settings(clip)
    if not params:
        return 1.0
    if bool(params.get("muted", False)):
        return 0.0
    return db_to_gain(float(params.get("gainDb", 0.0)))


def _duck_intervals(
    timeline: Timeline, track_id: str, clip_start: float
) -> list[tuple[float, float]]:
    track = next((t for t in timeline.tracks if t.id == track_id), None)
    if track is None:
        return []
    return [(c.start - clip_start, c.end - clip_start) for c in track.clips]


def _eq_bands(params: Mapping[str, Any]) -> list[dict[str, Any]]:
    eq = params.get("eq")
    if not isinstance(eq, Mapping):
        return []
    bands = eq.get("bands")
    return (
        [dict(band) for band in bands if isinstance(band, Mapping)]
        if isinstance(bands, list)
        else []
    )


class _StreamingAudioWorkspace:
    """Own temporary PCM files for one processed clip until its readers close."""

    def __init__(self, clip_id: str) -> None:
        self._temporary = TemporaryDirectory(prefix=f"framepilot-audio-{clip_id[:24]}-")
        self.root = Path(self._temporary.name)
        self._closed = False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._temporary.cleanup()


def _attach_owned_resource(clip: Any, resource: Any) -> Any:
    current = list(getattr(clip, "_framepilot_resources", []))
    current.append(resource)
    clip._framepilot_resources = current
    return clip


def _carry_owned_resources(source: Any, result: Any) -> Any:
    resources = list(getattr(source, "_framepilot_resources", []))
    if resources:
        result._framepilot_resources = resources
    return result


def _stream_audio_processors(source: Any, clip: Clip, params: Mapping[str, Any]) -> Any:
    """Materialize processors through chunked file I/O, never a clip-length NumPy array.

    MoviePy writes the already-trimmed/time-remapped source in bounded chunks, ffmpeg applies
    normalize/EQ/compression as a streaming filtergraph, then an AudioFileClip reads the
    processed file on demand. The workspace is attached to that reader and is removed by
    ``close_clip_tree`` only after every derived clip has closed.
    """
    from moviepy import AudioFileClip

    workspace = _StreamingAudioWorkspace(clip.id)
    raw_path = workspace.root / "source.wav"
    processed_path = workspace.root / "processed.wav"
    sample_rate = int(getattr(source, "fps", 44100) or 44100)
    try:
        source.write_audiofile(
            str(raw_path),
            fps=sample_rate,
            codec="pcm_f32le",
            logger=None,
        )
        normalize_db = (
            peak_normalize_gain_db(raw_path) if bool(params.get("normalize", False)) else None
        )
        dynamics = params.get("dynamics")
        filter_str = build_clip_filter(
            eq_bands=_eq_bands(params),
            dynamics=dynamics if isinstance(dynamics, Mapping) else None,
            normalize_gain_db=normalize_db,
        )
        final_path = raw_path
        if filter_str is not None:
            apply_audio_filter(raw_path, processed_path, filter_str)
            raw_path.unlink(missing_ok=True)
            final_path = processed_path
        processed = AudioFileClip(str(final_path)).with_duration(float(source.duration))
        return _attach_owned_resource(processed, workspace)
    except BaseException:
        workspace.close()
        raise


def _apply_audio_effects(source: Any, clip: Clip, timeline: Timeline) -> Any:
    """Apply mute → normalize/EQ/compressor → fader/fades/ducking in bounded memory."""
    params = _audio_settings(clip)
    muted = bool(params.get("muted", False))
    if muted:
        # A muted clip contributes no samples. Do not write/measure/filter an hour of audio only
        # to multiply it by zero at the end.
        return source.with_volume_scaled(0.0)

    static = _audio_gain_factor(clip)
    processors = (
        bool(params.get("normalize", False))
        or bool(_eq_bands(params))
        or isinstance(params.get("dynamics"), Mapping)
    )
    if processors:
        source = _stream_audio_processors(source, clip, params)
        # Normalize/EQ/dynamics are baked into the temporary stream. Gain is the fader and stays
        # after compression so lowering a clip does not alter compressor threshold behavior.
        static = db_to_gain(float(params.get("gainDb", 0.0)))

    effect = next((e for e in clip.effects if e.type == "audio_gain"), None)
    duration = float(source.duration)
    lane = (
        None if effect is None else automation_envelope(list(effect.keyframes), "gainDb", duration)
    )
    fade_curve = str(params.get("fadeCurve", "linear") or "linear")
    fade_in = float(params.get("fadeInSeconds", 0.0) or 0.0)
    fade_out = float(params.get("fadeOutSeconds", 0.0) or 0.0)
    duck_track = params.get("duckUnderTrackId")
    duck_intervals = _duck_intervals(timeline, str(duck_track), clip.start) if duck_track else []
    duck_amount = float(params.get("duckAmountDb", -12.0))

    time_varying = fade_in > 0.0 or fade_out > 0.0 or bool(duck_intervals) or lane is not None
    if not time_varying:
        result = source.with_volume_scaled(static) if static != 1.0 else source
        return _carry_owned_resources(source, result)

    def gained(get_frame: Any, t: Any) -> Any:
        times = np.asarray(t, dtype=np.float64)
        level = static if lane is None else sample_envelope(times, lane[0], lane[1])
        envelope = (
            level
            * fade_gain_at(times, fade_in, fade_out, duration, fade_curve)
            * duck_gain_at(times, duck_intervals, duck_amount)
        )
        return apply_gain_envelope(get_frame(t), envelope)

    return _carry_owned_resources(source, source.transform(gained, keep_duration=True))


def compile_timeline(
    project: Project,
    asset_index: AssetIndex,
    preset: ExportPreset,
    *,
    burn_captions: bool = False,
    max_decode_dimension: int | None = None,
) -> VideoClip:
    from moviepy import (
        AudioFileClip,
        ColorClip,
        CompositeAudioClip,
        CompositeVideoClip,
        ImageClip,
        VideoFileClip,
    )

    target = (preset.width, preset.height)
    fps = preset.fps or project.fps
    asset_kinds = {entry.asset_id: entry.kind for entry in asset_index.entries}
    lut_base_dir = Path(asset_index.base_dir)
    picture_by_track: list[list[tuple[Any, str | None]]] = []
    audio_layers: list[Any] = []
    opened: list[Any] = []
    try:
        for track in project.timeline.tracks:
            track_pictures: list[tuple[Any, str | None]] = []
            # Clips in sequence order, so a transition can find the shot on the other side of
            # its cut and borrow that shot's material for the ramp (see `_underlay_layer`).
            ordered = sorted(track.clips, key=lambda entry: entry.start)
            by_id = {entry.id: entry for entry in ordered}
            for position, clip in enumerate(ordered):
                kind = clip_kind(clip, asset_kinds)
                if kind in _PICTURE_KINDS:
                    if track.hidden:
                        continue
                    path = _resolve_clip_asset(clip, asset_index)
                    if kind == "image":
                        picture = _compile_image_clip(ImageClip, path, clip, target, lut_base_dir)
                        opened.append(picture)
                        track_pictures.append((picture, clip.blend_mode))
                    else:
                        reader = _open_source_reader(VideoFileClip, path, max_decode_dimension)
                        opened.append(reader)
                        source = _subclipped_source(reader, clip)
                        source = _apply_crop(source, clip)
                        source = _apply_speed(source, clip)
                        if not track.muted and source.audio is not None:
                            footage = _apply_audio_effects(source.audio, clip, project.timeline)
                            audio_layers.append(footage.with_start(clip.start))
                        source = source.without_audio()
                        source = _apply_color_grade(source, clip, lut_base_dir)
                        use_legacy = _uses_legacy_transition_path(clip)
                        transition = transitions.transition_from_clip(clip) if use_legacy else None
                        source = _apply_transition_blur(source, transition)
                        source = _attach_mask(source, clip, transition)
                        source = _apply_catalog_transition(source, clip, use_legacy)
                        placed = _place_video_clip(source, clip, target, transition)
                        # UNDER-LAYERS FIRST: a transition reveals the shot on the other side
                        # of its cut, and butt-joined clips leave nothing there — so the
                        # neighbour's handle is placed beneath the ramp before the clip itself
                        # goes on top. Appended in this order because a later entry in the
                        # list composites above an earlier one.
                        for role, neighbour in (
                            ("in", ordered[position - 1] if position > 0 else None),
                            ("out", ordered[position + 1] if position + 1 < len(ordered) else None),
                        ):
                            resolved_neighbour = _transition_neighbour(clip, role, neighbour, by_id)
                            if resolved_neighbour is None:
                                continue
                            if clip_kind(resolved_neighbour, asset_kinds) != "video":
                                continue
                            window = transition_underlay_window(clip, resolved_neighbour, role)
                            if window is None:
                                continue
                            underlay = _underlay_layer(
                                VideoFileClip,
                                ImageClip,
                                resolved_neighbour,
                                role,
                                window,
                                _resolve_clip_asset(resolved_neighbour, asset_index),
                                target,
                                lut_base_dir,
                                max_decode_dimension,
                                opened,
                            )
                            track_pictures.append((underlay, resolved_neighbour.blend_mode))
                        track_pictures.append((placed.with_start(clip.start), clip.blend_mode))
                elif kind == "audio":
                    if track.muted:
                        continue
                    path = _resolve_clip_asset(clip, asset_index)
                    reader = AudioFileClip(path)
                    opened.append(reader)
                    source = _subclipped_source(reader, clip)
                    source = _apply_speed(source, clip)
                    source = _apply_audio_effects(source, clip, project.timeline)
                    audio_layers.append(source.with_start(clip.start))
                elif kind == "text":
                    if track.hidden:
                        continue
                    text_layer = _compile_text_clip(ImageClip, clip, target)
                    if text_layer is not None:
                        opened.append(text_layer)
                        track_pictures.append((text_layer, clip.blend_mode))
            picture_by_track.append(track_pictures)

        video_layers: list[tuple[Any, str | None]] = []
        for track_pictures in reversed(picture_by_track):
            video_layers.extend(track_pictures)

        if not video_layers and audio_layers:
            video_layers.append(
                (
                    ColorClip(
                        size=target,
                        color=(0, 0, 0),
                        duration=timeline_duration(project.timeline),
                    ).with_fps(fps),
                    None,
                )
            )
        if not video_layers:
            raise CompileError(
                "Timeline has no renderable video clips; rendering requires at least "
                "one video clip (caption/overlay-only timelines come later)."
            )
        if burn_captions:
            video_layers.extend(_caption_layers(project, target))

        has_blend_mode = any(mode is not None and mode != "normal" for _, mode in video_layers)
        if has_blend_mode:
            composite = _composite_with_blend_modes(video_layers, target, fps)
        else:
            composite = CompositeVideoClip(
                [layer for layer, _ in video_layers], size=target, bg_color=(0, 0, 0)
            ).with_fps(fps)
        composite = apply_effect_layers(composite, project.timeline, fps=fps)
        if audio_layers:
            composite = composite.with_audio(CompositeAudioClip(audio_layers))
        return composite
    except BaseException:
        for clip_obj in opened:
            close_clip_tree(clip_obj)
        # Processed audio layers are not necessarily descendants of the source reader after a
        # failed compile. Close them too so their workspaces cannot survive an exception path.
        for audio in audio_layers:
            close_clip_tree(audio)
        raise


def _composite_with_blend_modes(
    video_layers: list[tuple[Any, str | None]], target: tuple[int, int], fps: int
) -> VideoClip:
    from moviepy import CompositeVideoClip as _CompositeVideoClip

    first_layer, _ = video_layers[0]
    running: VideoClip = _CompositeVideoClip([first_layer], size=target, bg_color=(0, 0, 0))
    for layer, mode in video_layers[1:]:
        if mode is None or mode == "normal":
            running = _CompositeVideoClip([running, layer], size=target, bg_color=(0, 0, 0))
        else:
            running = _blend_layer_over(running, layer, mode, target)
    return running.with_fps(fps)


def _blend_layer_over(base: VideoClip, layer: Any, mode: str, target: tuple[int, int]) -> VideoClip:
    from moviepy import CompositeVideoClip as _CompositeVideoClip
    from moviepy import VideoClip as _VideoClip

    canvas = _CompositeVideoClip([layer], size=target)
    base_duration = float(base.duration)
    canvas_duration = float(canvas.duration)
    new_duration = max(base_duration, canvas_duration)
    blend_mode = mode

    def frame_at(t: float) -> np.ndarray:
        base_t = min(max(t, 0.0), max(base_duration - 1e-6, 0.0))
        base_rgb = base.get_frame(base_t).astype(np.float64) / 255.0
        if t < 0.0 or t >= canvas_duration:
            return cast(np.ndarray, np.clip(base_rgb * 255.0, 0, 255).astype(np.uint8))
        blend_rgb = canvas.get_frame(t).astype(np.float64) / 255.0
        alpha = canvas.mask.get_frame(t).astype(np.float64)
        blended = apply_blend_mode(base_rgb, blend_rgb, blend_mode)
        alpha3 = alpha[..., np.newaxis]
        out = base_rgb * (1.0 - alpha3) + blended * alpha3
        return cast(np.ndarray, np.clip(out * 255.0, 0, 255).astype(np.uint8))

    return _VideoClip(frame_function=frame_at).with_duration(new_duration)


def _caption_position_y(position: str, frame_height: int, box_height: int, margin: int) -> int:
    if position == "top":
        y = margin
    elif position == "middle":
        y = (frame_height - box_height) // 2
    else:
        y = frame_height - box_height - margin
    return max(0, min(y, max(0, frame_height - box_height)))


def _caption_position(
    style: Any,
    target_w: int,
    target_h: int,
    box_w: int,
    box_h: int,
    margin: int,
) -> tuple[int, int]:
    if style.x_percent is None and style.y_percent is None:
        return (
            (target_w - box_w) // 2,
            _caption_position_y(style.position or "bottom", target_h, box_h, margin),
        )
    x_percent = style.x_percent if style.x_percent is not None else 50.0
    y_percent = style.y_percent if style.y_percent is not None else 50.0
    if style.safe_area is not False:
        x_percent = min(90.0, max(10.0, x_percent))
        y_percent = min(90.0, max(10.0, y_percent))
    x = round(target_w * x_percent / 100.0 - box_w / 2)
    y = round(target_h * y_percent / 100.0 - box_h / 2)
    return (
        max(0, min(x, max(0, target_w - box_w))),
        max(0, min(y, max(0, target_h - box_h))),
    )


def _caption_layers(project: Project, target: tuple[int, int]) -> list[tuple[Any, str | None]]:
    target_w, target_h = target
    margin = int(target_h * _CAPTION_BOTTOM_MARGIN_FRACTION)
    layers: list[tuple[Any, str | None]] = []
    for track in project.timeline.tracks:
        if track.type != TrackType.CAPTION or track.hidden:
            continue
        for clip in track.clips:
            cue = resolve_caption_cue(clip, project.transcript)
            if not cue.text.strip():
                continue
            style = layer_caption_style(track.caption_style, clip.caption_style)
            layer = _caption_clip(clip, cue.text, style, cue.words, target_w, target_h, margin)
            layers.append((layer, clip.blend_mode))
    return layers


def _caption_clip(
    clip: Clip,
    text: str,
    style: Any,
    cue_words: Sequence[TranscriptWord],
    target_w: int,
    target_h: int,
    margin: int,
) -> Any:
    from moviepy import ImageClip
    from moviepy import VideoClip as _VideoClip

    from framepilot_engine.render.caption_templates import resolve_caption_style

    duration = clip.end - clip.start
    words = list(cue_words) if style else []
    resolved = resolve_caption_style(style) if style is not None else None

    def finish(picture: Any) -> Any:
        rotation = (
            resolved.rotation if resolved is not None and resolved.rotation is not None else 0.0
        )
        if rotation != 0.0:
            picture = picture.rotated(-rotation, expand=True)
        box_w, box_h = picture.size
        placement_style = resolved
        if placement_style is None:
            from framepilot_engine.timeline.models import CaptionStyle

            placement_style = CaptionStyle(position="bottom")
        x, y = _caption_position(placement_style, target_w, target_h, box_w, box_h, margin)
        return picture.with_start(clip.start).with_position((x, y))

    if style is not None and caption_style_is_animated(style):
        last_frame: tuple[float, np.ndarray] | None = None

        def rgba_at(t: float) -> np.ndarray:
            nonlocal last_frame
            if last_frame is None or last_frame[0] != t:
                last_frame = (
                    t,
                    render_caption_image(
                        text,
                        target_w,
                        target_h,
                        style=style,
                        words=words,
                        frame_time=clip.start + t,
                    ),
                )
            return last_frame[1]

        def rgb_at(t: float) -> np.ndarray:
            image = rgba_at(t)
            return np.ascontiguousarray(image[:, :, :3])

        def alpha_at(t: float) -> np.ndarray:
            image = rgba_at(t)
            return image[:, :, 3].astype(np.float64) / 255.0

        picture = _VideoClip(frame_function=rgb_at).with_duration(duration)
        mask = _VideoClip(frame_function=alpha_at, is_mask=True).with_duration(duration)
        picture = picture.with_mask(mask)
        return finish(picture)

    image = render_caption_image(
        text, target_w, target_h, style=style, words=words, frame_time=clip.start
    )
    return finish(ImageClip(image, transparent=True).with_duration(duration))


def _open_source_reader(
    video_file_clip_cls: Any,
    path: str,
    max_decode_dimension: int | None,
) -> Any:
    reader = video_file_clip_cls(path)
    if max_decode_dimension is None:
        return reader
    width, height = reader.size
    if max(width, height) <= max_decode_dimension:
        return reader
    scale = max_decode_dimension / max(width, height)
    target = (
        max(2, round(width * scale / 2) * 2),
        max(2, round(height * scale / 2) * 2),
    )
    reader.close()
    return video_file_clip_cls(path, target_resolution=target)


def _resolve_clip_asset(clip: Clip, asset_index: AssetIndex) -> str:
    entry = asset_index.by_id(clip.asset_id)
    if entry is None:
        raise CompileError(f"Clip {clip.id!r} references unknown asset {clip.asset_id!r}.")
    if not entry.ok or entry.resolved_path is None:
        raise CompileError(
            f"Clip {clip.id!r} asset {clip.asset_id!r} is unusable: "
            f"{entry.error or 'not available'}."
        )
    return entry.resolved_path
