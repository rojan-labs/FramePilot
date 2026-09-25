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

import logging
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import partial
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
from framepilot_engine.effects.speed_curve import (
    has_speed_ramp,
    integrate_rate,
    source_time_at,
)
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
    CaptionRaster,
    caption_style_is_animated,
    render_caption_raster,
    resolve_caption_cue,
)
from framepilot_engine.render.clip_blur import (
    CLIP_BLUR_EFFECT_TYPE,
    apply_clip_blur,
    clip_blur_amount,
)
from framepilot_engine.render.color import (
    CubeLut,
    apply_color_grade,
    apply_lut,
    color_grade_from_params,
    parse_cube_lut,
)
from framepilot_engine.render.edge_styles import (
    EdgeStyleRefusal,
    apply_edge_styles,
    clip_edge_styles,
    edge_distance_scale,
)
from framepilot_engine.render.frame_effects import apply_effect_layers
from framepilot_engine.render.frame_masks import layer_mask_stack
from framepilot_engine.render.frame_plan import (
    back_to_front,
    caption_tracks,
    clips_in_sequence,
    fit_scale,
    layer_matte_sources,
    layer_opacity_at,
    layer_position_at,
    layer_scale_at,
    legacy_transition,
    live_catalog_transitions,
    picture_effects,
    text_overlay_text,
    title_envelope_animates,
    transition_underlays,
    underlay_material,
    uses_legacy_transition_path,
    video_source_time,
)
from framepilot_engine.render.frame_plan import (
    clip_kind as clip_kind,
)
from framepilot_engine.render.frame_plan import (
    transition_underlay_window as transition_underlay_window,
)
from framepilot_engine.render.key_mask import despill
from framepilot_engine.render.layer_mattes import (
    LayerMatteFrame,
    LayerMatteRefusal,
    LayerMatteResolver,
    PicturePlacement,
    assert_layer_sources,
)
from framepilot_engine.render.mask_stack import (
    ClipMaskStacks,
    MaskStackRefusal,
    clip_mask_stacks,
    mix_by_alpha,
)
from framepilot_engine.render.matte_edges import decontaminate
from framepilot_engine.render.matte_media import assert_media_unchanged
from framepilot_engine.render.mattes import (
    MatteFrame,
    MatteReader,
    MatteRefusal,
    PreparedMatte,
    assert_frames_align,
    prepare_matte,
)
from framepilot_engine.render.presets import ExportPreset
from framepilot_engine.render.pts_reader import (
    VideoTiming,
    VideoTimingError,
    reader_frame_index,
    use_pts_reader,
    video_timing,
)
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.render.text_overlay import rasterize_text_overlay, text_overlay_layout
from framepilot_engine.render.tracks import TrackArtifact, TrackRefusal, prepare_track
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


def ramped_time_map(ramp: list[Any], max_source: float) -> Any:
    """The ``time_transform`` callable for a speed-ramped clip.

    MoviePy hands the picture a scalar ``t`` and the AUDIO a whole array of sample
    times at once — ``AudioClip.get_frame`` is vectorised, and so is every sampler
    that reads it (the export writer, the temporal-evidence review). ``float(t)`` on
    that array raised ``only 0-dimensional arrays can be converted to Python scalars``,
    which killed the perceptual review of every edit carrying a ramp (run
    ``cc907070``: "Review could not run … (4 reviews)") and would kill the export
    of a ramped clip with sound. Scalars stay scalars; an array maps element-wise.
    """

    def _scalar(t: float) -> float:
        return source_time_at(ramp, 0.0, float(t), max_source)

    # The audio array is the whole reason this needs care. `source_time_at` inverts the
    # curve by BISECTION — INVERSION_STEPS passes, each one re-normalising the ramp and
    # Simpson-integrating every segment — so mapping it per sample costs ~60 integrations
    # per sample. Picture asks 30 times a second and never noticed; audio asks 44,100
    # times a second, and a single 3.3s ramped clip is then ~8 million integrations. That
    # is what made a 61-second export run for over half an hour at 100% CPU with no
    # output, indistinguishable from a hang (measured on project_raw_mttqrhhzjy9w).
    #
    # The curve is strictly increasing (rates are positive, which is exactly why it is
    # invertible at all), so it can be inverted ONCE into a monotonic table and applied to
    # the whole array by `np.interp` in C. The table is built lazily: a ramped clip whose
    # audio is never pulled should not pay for it.
    #
    # `np.interp` clamps outside the table, which is the behaviour `source_time_at`
    # already has at both ends — 0 before the start, `max_source` past the end, holding
    # the last frame rather than reading off the asset.
    table: list[Any] = []

    def _lookup() -> tuple[Any, Any]:
        if not table:
            # ~1ms of source per step, bounded so a long clip cannot blow the table up.
            steps = max(2, min(1 << 16, math.ceil(max_source * 1000.0) + 1))
            sources = np.linspace(0.0, max_source, steps)
            timeline = np.fromiter(
                (integrate_rate(ramp, 0.0, float(x)) for x in sources),
                dtype=np.float64,
                count=steps,
            )
            table.extend((timeline, sources))
        return table[0], table[1]

    def _map(t: Any) -> Any:
        if np.ndim(t) == 0:
            return _scalar(t)
        times = np.asarray(t, dtype=np.float64)
        timeline, sources = _lookup()
        return np.interp(times, timeline, sources).reshape(times.shape)

    return _map


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
        remapped = source.time_transform(
            ramped_time_map(ramp, max_source), apply_to=["mask", "audio"]
        )
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
    """What the export must come out as, from the timeline and the chosen target.

    The spec is the preset's frame and rate (validated exactly), the timeline's duration,
    and whether sound is expected at all and expected to run to the end. Sound comes from
    audio clips AND from video clips whose source was probed with audio (``media.peaks``);
    a video asset that was never probed is not assumed to carry sound, so the audio checks
    skip rather than fail on a silent screen recording.
    """
    asset_kinds = _asset_kinds_from_project(project)
    duration = timeline_duration(project.timeline)
    audio_end = _audio_content_end(project)
    return ExpectedRender(
        duration_seconds=duration,
        expect_video=has_video_content(project.timeline, asset_kinds),
        expect_audio=has_audio_content(project.timeline, asset_kinds) or audio_end > 0.0,
        width=preset.width,
        height=preset.height,
        fps=preset.fps,
        # Sound that stops before the picture is the edit, not a defect; only a timeline
        # whose sound reaches the end is held to "no silent tail".
        expect_audio_to_end=audio_end >= duration - _AUDIO_END_SLACK_SECONDS,
    )


#: Sound may end this close to the picture's end and still count as "to the end" — a
#: single frame of slack for a clip whose audio was trimmed on the frame grid.
_AUDIO_END_SLACK_SECONDS = 0.1


def _audio_content_end(project: Project) -> float:
    """The latest timeline second at which some unmuted clip carries sound (0 when none)."""
    assets = {asset.id: asset for asset in project.assets}
    end = 0.0
    for track in project.timeline.tracks:
        if track.muted:
            continue
        for clip in track.clips:
            asset = assets.get(clip.asset_id)
            if asset is None:
                continue
            has_sound = asset.kind == "audio" or (
                asset.kind == "video" and bool(asset.media and asset.media.peaks)
            )
            if has_sound:
                end = max(end, clip.end)
    return end


def unsupported_animated_properties(timeline: Timeline) -> list[str]:
    deferred: set[str] = set()
    for track in timeline.tracks:
        for clip in track.clips:
            deferred.update(deferred_transform_properties(clip))
    return sorted(deferred)


def _compile_image_clip(
    image_clip_cls: Any, path: str, clip: Clip, target: tuple[int, int], lut_base_dir: Path
) -> Any:
    """A still through the picture pipeline, in the video path's order (plan/elements EL2a).

    Crop, grade, the legacy transition's blur, opacity (keyframes * a fade * a wipe, multiplied
    into the image's own transparency), the catalog transitions, then placement with any
    geometry transition. Masks and edge styles on stills are not drawn yet (``with_stack=False``),
    matching the frame plan. A still borrows no under-layer.
    """
    source = image_clip_cls(path).with_duration(clip.end - clip.start)
    source = _apply_crop(source, clip)
    source = _apply_color_grade(source, clip, lut_base_dir)
    use_legacy = _uses_legacy_transition_path(clip)
    transition = legacy_transition(clip)
    source = _apply_transition_blur(source, transition)
    source = _attach_mask(source, clip, transition, with_stack=False)
    source = _apply_catalog_transition(source, clip, use_legacy)
    placed = _place_video_clip(source, clip, target, transition)
    return placed.with_start(clip.start)


def _compile_text_clip(image_clip_cls: Any, clip: Clip, target: tuple[int, int]) -> Any | None:
    """Rasterize a text overlay and place it, honouring the clip's own transform.

    The transform is why this goes through :func:`_place_video_clip` rather than a bare
    ``with_position("center")``. ``punch_in`` and ``add_keyframes`` accept a text clip,
    validate, apply, and report an edit — and the compiler used to drop the keyframes on
    the floor, so a run could add fifteen animated text cards, be told fifteen times that
    it had, and render fifteen static ones. An operation that lands in the timeline and
    renders as nothing is the "never fake success" invariant broken from the far end.
    """
    content = text_overlay_text(clip)
    if content is None:
        return None
    text, style_params = content
    layout = text_overlay_layout(style_params, target[0], target[1])
    image = rasterize_text_overlay(text, style_params, target[0], target[1])
    layer = image_clip_cls(image, transparent=True).with_duration(clip.end - clip.start)
    # EL2a: a title's opacity, In/Out envelope and transitions render, as the frame plan says.
    use_legacy = _uses_legacy_transition_path(clip)
    transition = legacy_transition(clip)
    layer = _apply_transition_blur(layer, transition)
    layer = _attach_mask(layer, clip, transition, with_stack=False)
    layer = _apply_catalog_transition(layer, clip, use_legacy)
    placed = _place_video_clip(
        layer,
        clip,
        target,
        transition,
        fit_to_frame=False,
        centre=(layout.centre_x, layout.centre_y),
    )
    return placed.with_start(clip.start)


def _place_video_clip(
    source: VideoClip,
    clip: Clip,
    target: tuple[int, int],
    transition: transitions.Transition | None,
    *,
    fit_to_frame: bool = True,
    centre: tuple[float, float] | None = None,
) -> VideoClip:
    """Scale, animate and position one picture layer inside the target frame.

    :param fit_to_frame: ``True`` for source media, which is scaled to fill the frame
        before any authored transform. ``False`` for a layer already rasterized at its
        finished size — a text overlay is drawn tight to its own glyphs, and fitting that
        to the frame would blow one word up to full width. Such a layer keeps a base scale
        of 1 and is animated around the frame centre.
    :param centre: Where the layer's centre sits in the frame, in pixels. Defaults to the
        frame centre. A text overlay authors this as ``xPercent``/``yPercent``, and the
        preview has honored it since the Inspector could set it — the render did not, so
        every overlay exported dead centre whatever the editor had positioned.
    """
    target_w, target_h = target
    clip_w, clip_h = source.size
    base_scale = fit_scale((clip_w, clip_h), target, fit_to_frame=fit_to_frame)
    centre_x, centre_y = centre if centre is not None else (target_w / 2, target_h / 2)
    geo_transition = transition is not None and transitions.affects_geometry(transition)
    animated = has_rendered_transform(clip) or geo_transition or title_envelope_animates(clip)
    if not animated:
        placed = source if base_scale == 1.0 else source.resized(base_scale)
        if centre is None:
            return placed.with_position("center")
        width = clip_w * base_scale
        height = clip_h * base_scale
        return placed.with_position((centre_x - width / 2, centre_y - height / 2))

    # The arithmetic lives in `frame_plan` so the plan the preview is tested against and the
    # export are one computation, not two that agree today.
    def scale_at(t: float) -> float:
        return base_scale * layer_scale_at(clip, t, transition)

    def position_at(t: float) -> tuple[float, float]:
        return layer_position_at(
            clip, t, (clip_w, clip_h), base_scale, target, (centre_x, centre_y), transition
        )

    placed = source.resized(scale_at)
    if ROTATION in animated_properties(clip):
        placed = placed.rotated(lambda t: evaluate_clip_transform(clip, t).rotation, expand=False)
    return placed.with_position(position_at)


# The cut-adjacency tolerance, under-layer windows, neighbour lookup and handle slack live
# in `frame_plan` (see `transition_underlays` / `underlay_material`), which the compile loop
# below consumes, so the frame plan and the export cannot place an under-layer differently.


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
    pixel_aspect_ratio: float = 1.0,
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
    start, _end = window
    reader = _open_source_reader(
        video_file_clip_cls, path, max_decode_dimension, None, pixel_aspect_ratio
    )
    opened.append(reader)
    # Which handle (past the out-point for "in", before the in-point for "out") and whether
    # any is left is decided in `frame_plan.underlay_material`, the same call the plan makes.
    plan = underlay_material(neighbour, role, window, float(reader.duration))
    span = plan.span

    if plan.mode == "subclip":
        material = reader.subclipped(plan.handle_start, plan.handle_start + span)
    else:
        # No handle left (the neighbour is cut to the very edge of its asset). Hold its edge
        # frame rather than reveal black: a held frame under a fast ramp reads as continuous;
        # black reads as a flash, which is the defect this exists to remove.
        held = image_clip_cls(reader.get_frame(plan.edge_time)).with_duration(span)
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


def _pixel_aspect_ratio(project: Project, clip: Clip) -> float:
    """The clip asset's probed pixel aspect ratio (1 when square or unprobed)."""
    asset = next((a for a in project.assets if a.id == clip.asset_id), None)
    media = asset.media if asset is not None else None
    par = media.pixel_aspect_ratio if media is not None else None
    return float(par) if par else 1.0


def _asset_media_size(project: Project, clip: Clip) -> tuple[float, float] | None:
    """The clip asset's display-corrected ``(width, height)`` masks are measured in (v22).

    Pixel aspect ratio and rotation applied (``AssetMedia.display_size``), matching
    ``editor-core`` ``assetDisplaySize``. The mask becomes fractions of this size and is
    drawn over the decoded frame: MoviePy decodes a rotated stream already turned, and a
    horizontal PAR stretch leaves a fraction of the width unchanged, so the fractions land
    on the same picture points the editor drew them on.
    """
    asset = next((a for a in project.assets if a.id == clip.asset_id), None)
    media = asset.media if asset is not None else None
    return media.display_size() if media is not None else None


def _clip_mask_stacks(
    clip: Clip,
    media_size: tuple[float, float] | None,
    mattes: dict[str, Callable[[float], MatteFrame]] | None = None,
    decoded_size: tuple[int, int] | None = None,
    tracks: dict[str, Any] | None = None,
    layer_mattes: Callable[[Any, float, int, int], tuple[LayerMatteFrame, PicturePlacement]]
    | None = None,
    placements: Callable[[float, int, int], tuple[PicturePlacement, tuple[int, int]]] | None = None,
) -> ClipMaskStacks | None:
    """The clip's v22 mask stacks, or a :class:`CompileError` naming why export refuses one."""
    try:
        return clip_mask_stacks(
            clip, media_size, mattes, decoded_size, tracks, layer_mattes, placements
        )
    except MaskStackRefusal as exc:
        raise CompileError(str(exc)) from exc


def picture_placement_at(
    clip: Clip,
    t: float,
    size: tuple[int, int],
    target: tuple[int, int],
    transition: transitions.Transition | None,
) -> PicturePlacement:
    """Where :func:`_place_video_clip` lands a clip's ``size`` picture at clip-local ``t``.

    The same decisions, as integers: MoviePy's ``Resize`` truncates ``size * scale``,
    ``compute_position`` truncates the position (``"center"`` is ``(W - w) / 2``), and rotation is
    PIL's counter-clockwise angle, applied only when the clip animates rotation. A track matte
    (MK8.2) needs this to know which frame pixel each of the clip's pixels lands on.
    """
    clip_w, clip_h = size
    target_w, target_h = target
    base_scale = fit_scale((clip_w, clip_h), target, fit_to_frame=True)
    geo_transition = transition is not None and transitions.affects_geometry(transition)
    if not has_rendered_transform(clip) and not geo_transition:
        width, height = (
            (clip_w, clip_h)
            if base_scale == 1.0
            else (int(clip_w * base_scale), int(clip_h * base_scale))
        )
        return PicturePlacement(
            clip_w,
            clip_h,
            width,
            height,
            0.0,
            int((target_w - width) / 2),
            int((target_h - height) / 2),
        )
    scale = base_scale * layer_scale_at(clip, t, transition)
    x, y = layer_position_at(
        clip, t, (clip_w, clip_h), base_scale, target, (target_w / 2, target_h / 2), transition
    )
    rotation = (
        float(evaluate_clip_transform(clip, t).rotation)
        if ROTATION in animated_properties(clip)
        else 0.0
    )
    return PicturePlacement(
        clip_w, clip_h, int(clip_w * scale), int(clip_h * scale), rotation, int(x), int(y)
    )


def _frame_placement_binding(
    clip: Clip,
    target: tuple[int, int],
    transition: transitions.Transition | None,
) -> Callable[[float, int, int], tuple[PicturePlacement, tuple[int, int]]]:
    """Where a clip's raster lands on the frame at clip-local ``t``, and the frame's size (MK9.1).

    A frame-space clip mask is drawn on the output frame and read back through this placement,
    the same one a track matte uses, so it stays fixed on the frame as the picture moves.
    """

    def placement_at(t: float, width: int, height: int) -> tuple[PicturePlacement, tuple[int, int]]:
        return picture_placement_at(clip, t, (width, height), target, transition), target

    return placement_at


def _layer_matte_binding(
    resolver: LayerMatteResolver,
    clip: Clip,
    target: tuple[int, int],
    transition: transitions.Transition | None,
) -> Callable[[Any, float, int, int], tuple[LayerMatteFrame, PicturePlacement]]:
    """A clip's track mattes at clip-local ``t``: the source frame and this clip's placement."""

    def matte_at(
        mask: Any, t: float, width: int, height: int
    ) -> tuple[LayerMatteFrame, PicturePlacement]:
        frame = resolver.frame_at(mask.source, clip.start + t)
        return frame, picture_placement_at(clip, t, (width, height), target, transition)

    return matte_at


_log = logging.getLogger(__name__)

#: Per clip id, per matte mask id: the artifact that passed its pre-render checks.
PreparedMattes = dict[str, dict[str, PreparedMatte]]

#: Per clip id, per tracked mask id: the transform track that passed its pre-render checks.
PreparedTracks = dict[str, dict[str, TrackArtifact]]


def _prepare_clip_tracks(clip: Clip, base_dir: Path) -> dict[str, TrackArtifact]:
    """Check every tracked mask on ``clip`` (file, digest, document, method) (MK7.1)."""
    prepared: dict[str, TrackArtifact] = {}
    for mask in clip.masks or []:
        if not mask.enabled or mask.tracking is None:
            continue
        try:
            prepared[mask.id] = prepare_track(mask, clip, base_dir)
        except TrackRefusal as exc:
            raise CompileError(str(exc)) from exc
    return prepared


def _prepare_clip_mattes(project: Project, clip: Clip, base_dir: Path) -> dict[str, PreparedMatte]:
    """Check every enabled matte on ``clip`` (files, digests, format, size, coverage) (BR2.3)."""
    asset = next((a for a in project.assets if a.id == clip.asset_id), None)
    media = asset.media if asset is not None else None
    prepared: dict[str, PreparedMatte] = {}
    for mask in clip.masks or []:
        if not mask.enabled or mask.kind != "matte":
            continue
        try:
            prepared[mask.id] = prepare_matte(mask, clip, base_dir, media, float(project.fps))
        except MatteRefusal as exc:
            raise CompileError(str(exc)) from exc
    return prepared


def _export_source_frames(
    clip: Clip, reader: Any, output_fps: float, source_fps: float, asset_duration: float | None
) -> list[int]:
    """Every decode-order source frame the export reads for ``clip`` at ``output_fps``.

    The composite samples ``t = k / fps`` and a layer plays for ``start <= t < end``; each
    sample reads the frame :func:`reader_frame_index` names for :func:`video_source_time`
    (by pts on a variable-rate source).
    """
    first = math.ceil(clip.start * output_fps - 1e-9)
    frames: list[int] = []
    k = first
    while k / output_fps < clip.end:
        local = k / output_fps - clip.start
        frame = reader_frame_index(
            reader, video_source_time(clip, local, source_fps, asset_duration), source_fps
        )
        if frame is not None:
            frames.append(frame)
        k += 1
    return frames


def _source_timing(reader: Any) -> VideoTiming | None:
    """The opened source's frame timestamps, or ``None`` when they cannot be listed."""
    filename = getattr(reader, "filename", None)
    if not isinstance(filename, str):
        return None
    try:
        return video_timing(filename)
    except (VideoTimingError, OSError) as exc:
        _log.warning("could not list frame timestamps of %s: %s", Path(filename).name, exc)
        return None


def _bind_mattes(
    clip: Clip,
    prepared: dict[str, PreparedMatte],
    reader: Any,
    output_fps: float,
    opened: list[Any],
) -> dict[str, Callable[[float], MatteFrame]]:
    """Open a :class:`MatteReader` per matte and bind "frame at clip-relative ``t``" to it.

    Before any frame renders, every source frame the export will read is checked against the
    artifact (:func:`assert_frames_align`): a matte that cannot be proven frame-exact refuses.
    """
    if not prepared:
        return {}
    source_fps = float(reader.fps)
    asset_duration = float(reader.duration) if reader.duration is not None else None
    frames = sorted(
        set(_export_source_frames(clip, reader, output_fps, source_fps, asset_duration))
    )
    timing = _source_timing(reader)
    bound: dict[str, Callable[[float], MatteFrame]] = {}
    for mask_id, matte in prepared.items():
        try:
            assert_frames_align(matte, frames, timing)
            filename = getattr(reader, "filename", None)
            if isinstance(filename, str):
                assert_media_unchanged(matte, filename)
        except MatteRefusal as exc:
            raise CompileError(str(exc)) from exc
        mask = next(m for m in clip.masks or [] if m.id == mask_id)
        want_foreground = bool(getattr(mask, "decontaminate", False))
        matte_reader = MatteReader(matte, want_foreground=want_foreground)
        opened.append(matte_reader)

        def frame_at(t: float, matte_reader: MatteReader = matte_reader) -> MatteFrame:
            source_time = video_source_time(clip, t, source_fps, asset_duration)
            frame = reader_frame_index(reader, source_time, source_fps)
            if frame is None:  # pragma: no cover - fps is known once a reader is open
                raise CompileError(f"Clip {clip.id!r}: the matte frame could not be resolved.")
            return matte_reader.frame_for_source_frame(frame)

        bound[mask_id] = frame_at
    _log.debug(
        "clip %s: %d matte reader(s) over %d source frames", clip.id, len(bound), len(frames)
    )
    return bound


def _apply_matte_decontamination(source: VideoClip, stacks: ClipMaskStacks | None) -> VideoClip:
    """Replace edge colour with each matte's foreground estimate before any effect or alpha."""
    if stacks is None:
        return source
    cleaning = [mask for mask in stacks.matte_masks() if mask.decontaminate]
    if not cleaning:
        return source
    clip = stacks.clip

    def cleaned(get_frame: Callable[[float], np.ndarray], t: float) -> np.ndarray:
        picture = get_frame(t)
        for mask in reversed(cleaning):
            matte = stacks.mattes[str(mask.id)](t)
            if matte.foreground is None:  # pragma: no cover - reader opened with foreground
                continue
            picture = decontaminate(
                picture, matte.alpha, matte.maximum, matte.foreground, clip, stacks.decoded_size
            )
        return picture

    return source.transform(cleaned, keep_duration=True)


def _apply_key_despill(source: VideoClip, stacks: ClipMaskStacks | None) -> VideoClip:
    """Pull the backing colour out of the picture for every key asking for despill (MK6.1).

    Applied AFTER the stack has been attached, deliberately: the qualifier has to read the
    colour the camera recorded, and a limiter that ran first would have already taken the green
    it is looking for. This is the same order a hardware keyer uses — extract, then suppress —
    and it is why despill is a stage of its own rather than a step inside the qualifier.
    """
    if stacks is None:
        return source
    despilling = stacks.despilling_keys()
    if not despilling:
        return source

    def cleaned(get_frame: Callable[[float], np.ndarray], t: float) -> np.ndarray:
        picture = get_frame(t)
        for mask in reversed(despilling):
            picture = despill(picture, str(mask.despill))
        return picture

    return source.transform(cleaned, keep_duration=True)


def _refuse_unrenderable_edge_styles(clip: Clip, media_size: tuple[float, float] | None) -> None:
    """Refuse a malformed edge style, or one whose lengths cannot be scaled (MK9.2)."""
    try:
        styles = clip_edge_styles(clip)
    except EdgeStyleRefusal as exc:
        raise CompileError(str(exc)) from exc
    if styles and media_size is None:
        raise CompileError(
            f"Edge styles on clip {clip.id!r} are sized in source pixels but the media size is "
            "unknown. Measure this media first."
        )


def _apply_edge_styles(
    source: VideoClip,
    clip: Clip,
    stacks: ClipMaskStacks | None,
    media_size: tuple[float, float] | None,
    transition: transitions.Transition | None,
) -> VideoClip:
    """Draw the clip's cut-out edge styles (outline, glow, shadow) under its picture (MK9.2).

    After the stack is attached and despilled: the styles read the alpha-target stack (the
    cut-out) and the picture goes over them, so the picture keeps every pixel it had. A static
    stack is evaluated once and reused.
    """
    styles = clip_edge_styles(clip)
    if not styles or stacks is None or not stacks.alpha or media_size is None:
        return source
    width, height = source.size
    scale = edge_distance_scale(clip, media_size, width, height)
    existing_mask = source.mask
    keyed = stacks.alpha_needs_picture
    memo: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    # The cut-out is reused when the stack does not move; opacity is read per instant anyway.
    static = not stacks.alpha_animated
    static_cut: list[Any] = []

    def evaluate(t: float, frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        key = round(t * 1_000_000)
        hit = memo.get(key)
        if hit is not None:
            return hit
        alpha = (
            np.ones((height, width), dtype=np.float64)
            if existing_mask is None
            else np.asarray(existing_mask.get_frame(t), dtype=np.float64)
        )
        if static and static_cut:
            cut = static_cut[0]
        else:
            picture = (lambda: source.get_frame(t)) if keyed else None
            cut = stacks.alpha_at(t, width, height, picture)
            if static:
                static_cut.append(cut)
        result = apply_edge_styles(
            np.asarray(frame, dtype=np.uint8),
            alpha,
            cut,
            styles,
            scale,
            layer_opacity_at(clip, t, transition),
        )
        if len(memo) > 2:
            memo.clear()
        memo[key] = result
        return result

    def picture_at(get_frame: Callable[[float], np.ndarray], t: float) -> np.ndarray:
        return evaluate(t, get_frame(t))[0]

    styled = source.transform(picture_at, keep_duration=True)

    def alpha_at(t: float) -> Any:
        return evaluate(t, source.get_frame(t))[1]

    from moviepy import VideoClip as _VideoClip

    mask = _VideoClip(frame_function=alpha_at, is_mask=True).with_duration(source.duration)
    _log.debug("edge styles on clip %s: %s", clip.id, ",".join(style.kind for style in styles))
    return styled.with_mask(mask)


def _refuse_unrenderable_masks(
    project: Project, base_dir: Path | None = None
) -> tuple[PreparedMattes, PreparedTracks]:
    """Refuse, before any reader opens, a mask stack the export cannot draw faithfully.

    With ``base_dir`` (the project directory) every enabled matte's artifact and every tracked
    mask's transform track is checked too, and the artifacts that passed are returned for the
    compile to open.
    """
    prepared: PreparedMattes = {}
    tracks: PreparedTracks = {}
    kinds = _asset_kinds_from_project(project)
    # MK8.2: a track matte whose source is missing, holds no picture, or loops back refuses here.
    try:
        assert_layer_sources(project)
    except LayerMatteRefusal as exc:
        raise CompileError(str(exc)) from exc
    for track in project.timeline.tracks:
        for layer in track.effect_layers or []:
            # MK5.2: an adjustment lane's stack is in frame pixels on the layer's own clock;
            # `apply_effect_layers` mixes it. What it cannot draw refuses here, before a frame.
            try:
                layer_mask_stack(layer)
            except MaskStackRefusal as exc:
                raise CompileError(str(exc)) from exc
        if track.type != TrackType.VIDEO or track.hidden:
            continue
        for clip in track.clips:
            # Only video clips draw their stack (stills are placed without crop or mask).
            if clip.masks and kinds.get(clip.asset_id) == "video":
                _clip_mask_stacks(clip, _asset_media_size(project, clip))
                _refuse_unrenderable_edge_styles(clip, _asset_media_size(project, clip))
                if base_dir is not None:
                    matte = _prepare_clip_mattes(project, clip, base_dir)
                    if matte:
                        prepared[clip.id] = matte
                    tracked = _prepare_clip_tracks(clip, base_dir)
                    if tracked:
                        tracks[clip.id] = tracked
    return prepared, tracks


def _attach_mask(
    source: VideoClip,
    clip: Clip,
    transition: transitions.Transition | None,
    media_size: tuple[float, float] | None = None,
    stacks: ClipMaskStacks | None = None,
    *,
    with_stack: bool = True,
) -> VideoClip:
    """Wrap ``source`` in its alpha: opacity * fade * wipe * the alpha-target mask stack.

    A layer that already carries transparency — a still's PNG/WebP alpha, a title's glyph
    coverage — keeps it: the alpha computed here MULTIPLIES the existing mask instead of
    replacing it, or a sticker would turn into an opaque square the moment it fades.

    :param with_stack: ``False`` for layers whose mask stack the export does not draw yet
        (stills and titles, plan/elements EL2a); the stack is then neither computed nor applied.
    """
    width, height = source.size
    # Schema v22: the clip's alpha-target mask stack, drawn by the exact rasteriser
    # (render/mask_stack.py, ADR 0178); a stack export cannot draw refuses before rendering.
    if stacks is None and with_stack:
        stacks = _clip_mask_stacks(clip, media_size)
    alpha_stack = stacks if stacks is not None and stacks.alpha else None
    geometry_animated = alpha_stack is not None and alpha_stack.alpha_animated
    opacity_animated = OPACITY in animated_properties(clip) or title_envelope_animates(clip)
    fade_transition = transition is not None and transitions.affects_opacity(transition)
    wipe_transition = transition is not None and transitions.affects_wipe(transition)
    static_opacity = evaluate_clip_transform(clip, 0.0).opacity
    nothing_to_mask = (
        alpha_stack is None
        and not opacity_animated
        and not fade_transition
        and not wipe_transition
        and static_opacity >= 1.0
    )
    if nothing_to_mask:
        return source

    def opacity_at(t: float) -> float:
        return layer_opacity_at(clip, t, transition)

    if wipe_transition:
        assert transition is not None
        wipe_axis, wipe_inverted = transitions.wipe_axis(transition)
        wipe_feather = transitions.wipe_softness(transition)
        extent = width if wipe_axis == "x" else height
        fracs = (np.arange(extent, dtype=np.float64) + 0.5) / extent
        if wipe_inverted:
            fracs = 1.0 - fracs
        sweep_fracs = fracs.reshape((1, extent)) if wipe_axis == "x" else fracs.reshape((extent, 1))

    # MK6.1: a key mask reads the clip's own picture at the instant it is drawn, so the mask
    # clip must ask the source for that frame — and can never be drawn once and reused.
    keyed = alpha_stack is not None and alpha_stack.alpha_needs_picture

    def alpha_at(t: float) -> Any:
        opacity = opacity_at(t)
        picture = (lambda: source.get_frame(t)) if keyed else None
        stacked = None if alpha_stack is None else alpha_stack.alpha_at(t, width, height, picture)
        if stacked is None:
            alpha = np.full((height, width), opacity, dtype=np.float64)
        else:
            alpha = stacked * opacity
        if wipe_transition:
            assert transition is not None
            reveal = transitions.wipe_progress_at(transition, t)
            wipe_band = np.clip(
                (transitions.wipe_edge(reveal, wipe_feather) - sweep_fracs) / wipe_feather, 0.0, 1.0
            )
            alpha = alpha * wipe_band
        return alpha

    own = source.mask

    def combined_alpha_at(t: float) -> Any:
        alpha = alpha_at(t)
        return alpha if own is None else alpha * own.get_frame(t)

    time_varying = (
        geometry_animated or opacity_animated or fade_transition or wipe_transition or keyed
    )
    if time_varying:
        from moviepy import VideoClip as _VideoClip

        mask = _VideoClip(frame_function=combined_alpha_at, is_mask=True).with_duration(
            source.duration
        )
    else:
        from moviepy import ImageClip

        mask = ImageClip(combined_alpha_at(0.0), is_mask=True).with_duration(source.duration)
    return source.with_mask(mask)


_uses_legacy_transition_path = uses_legacy_transition_path


def _apply_catalog_transition(source: VideoClip, clip: Clip, use_legacy: bool) -> VideoClip:
    live = live_catalog_transitions(clip, use_legacy)
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


def _apply_color_grade(
    source: VideoClip,
    clip: Clip,
    lut_base_dir: Path,
    stacks: ClipMaskStacks | None = None,
) -> VideoClip:
    for effect in picture_effects(clip):
        if effect.type == "color_grade":
            grade = color_grade_from_params(effect.params)
            if grade.is_identity:
                continue
            apply: Callable[[np.ndarray], np.ndarray] = partial(apply_color_grade, grade=grade)
        elif effect.type == CLIP_BLUR_EFFECT_TYPE:
            if clip_blur_amount(effect.params) <= 0.0:
                continue
            apply = partial(apply_clip_blur, params=dict(effect.params))
        else:
            lut = _load_lut(_resolve_lut_path(effect.params, lut_base_dir, clip.id), clip.id)
            apply = partial(apply_lut, lut=lut)
        if stacks is not None and stacks.by_effect.get(effect.id):
            source = _masked_effect(source, stacks, effect.id, apply)
        else:
            source = source.image_transform(apply)
    return source


def _masked_effect(
    source: VideoClip,
    stacks: ClipMaskStacks,
    effect_id: str,
    apply: Callable[[np.ndarray], np.ndarray],
) -> VideoClip:
    """Apply an effect only where its mask stack lets it through (v22 effect-target masks).

    The effect runs on the whole frame and is mixed with the untouched frame by the stack's
    alpha at the clip's source instant, so a face blur or sky grade stays glued to the picture.
    """
    width, height = source.size
    static_alpha = (
        None
        if stacks.effect_animated(effect_id)
        else stacks.effect_alpha_at(effect_id, 0.0, width, height)
    )

    def masked(get_frame: Callable[[float], np.ndarray], t: float) -> np.ndarray:
        frame = get_frame(t)
        # A key limiting this effect qualifies the effect's INPUT, not its output: the editor
        # picked the colour off the picture as it was before the effect ran.
        alpha = (
            static_alpha
            if static_alpha is not None
            else stacks.effect_alpha_at(effect_id, t, width, height, lambda: frame)
        )
        effected = apply(frame)
        if alpha is None:
            return effected
        mixed: np.ndarray = mix_by_alpha(frame, effected, alpha)
        return mixed

    return source.transform(masked, keep_duration=True)


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
    on_progress: Callable[[float], None] | None = None,
) -> VideoClip:
    """Build the MoviePy composition for ``project``.

    ``on_progress`` receives 0..1 as each placed clip is opened. Preparation is a real
    share of an export's wall time — about 13% of a 30 s 4K render, spent opening readers
    and building the graph — and reporting it as one flat number made the bar sit still
    and then lag: measured 5.5 percentage points behind reality at the 20% mark.
    """
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
    total_clips = sum(len(track.clips) for track in project.timeline.tracks)
    prepared = 0
    prepared_mattes, prepared_tracks = _refuse_unrenderable_masks(project, lut_base_dir)
    # MK8.2: clips and tracks another clip reads as its track matte are rendered for the matte
    # and never composited (the frame plan marks them `matteOnly`).
    matte_sources = layer_matte_sources(project, asset_kinds)
    layer_mattes = LayerMatteResolver(target)

    def _prepared_one() -> None:
        nonlocal prepared
        prepared += 1
        if on_progress is not None and total_clips:
            on_progress(min(1.0, prepared / total_clips))

    picture_by_track: list[list[tuple[Any, str | None]]] = []
    audio_layers: list[Any] = []
    opened: list[Any] = []
    try:
        for track in project.timeline.tracks:
            track_pictures: list[tuple[Any, str | None]] = []
            # Clips in sequence order, so a transition can find the shot on the other side of
            # its cut and borrow that shot's material for the ramp (see `_underlay_layer`).
            ordered = clips_in_sequence(track)
            for position, clip in enumerate(ordered):
                _prepared_one()
                kind = clip_kind(clip, asset_kinds)
                if kind in _PICTURE_KINDS:
                    if track.hidden:
                        continue
                    path = _resolve_clip_asset(clip, asset_index)
                    if kind == "image":
                        picture = _compile_image_clip(ImageClip, path, clip, target, lut_base_dir)
                        opened.append(picture)
                        if matte_sources.consumes(track.id, clip.id, None):
                            layer_mattes.add(track.id, clip.id, picture)
                        else:
                            track_pictures.append((picture, clip.blend_mode))
                    else:
                        # P7.5: when the clip is a plain fit — nothing animated, nothing
                        # cropped, no transition bending its geometry — its displayed size
                        # is known now, so ffmpeg decodes straight to it and MoviePy's
                        # per-frame PIL resize becomes a no-op. That resize was 69% of a
                        # measured 4K->1080x1920 export.
                        static_fit = (
                            max_decode_dimension is None
                            and not clip.keyframes
                            and clip.crop is None
                            and not has_rendered_transform(clip)
                            and not _uses_legacy_transition_path(clip)
                            and transitions.transition_from_clip(clip) is None
                        )
                        reader = _open_source_reader(
                            VideoFileClip,
                            path,
                            max_decode_dimension
                            if max_decode_dimension is not None
                            else decode_cap_for_clip(clip, target),
                            target if static_fit else None,
                            _pixel_aspect_ratio(project, clip),
                        )
                        opened.append(reader)
                        source = _subclipped_source(reader, clip)
                        source = _apply_crop(source, clip)
                        source = _apply_speed(source, clip)
                        if not track.muted and source.audio is not None:
                            footage = _apply_audio_effects(source.audio, clip, project.timeline)
                            audio_layers.append(footage.with_start(clip.start))
                        source = source.without_audio()
                        stacks = _clip_mask_stacks(
                            clip,
                            _asset_media_size(project, clip),
                            _bind_mattes(
                                clip, prepared_mattes.get(clip.id, {}), reader, fps, opened
                            ),
                            (int(reader.size[0]), int(reader.size[1])),
                            prepared_tracks.get(clip.id, {}),
                            _layer_matte_binding(
                                layer_mattes, clip, target, legacy_transition(clip)
                            ),
                            _frame_placement_binding(clip, target, legacy_transition(clip)),
                        )
                        source = _apply_matte_decontamination(source, stacks)
                        source = _apply_color_grade(source, clip, lut_base_dir, stacks)
                        use_legacy = uses_legacy_transition_path(clip)
                        transition = legacy_transition(clip)
                        source = _apply_transition_blur(source, transition)
                        source = _attach_mask(
                            source, clip, transition, _asset_media_size(project, clip), stacks
                        )
                        source = _apply_key_despill(source, stacks)
                        source = _apply_edge_styles(
                            source, clip, stacks, _asset_media_size(project, clip), transition
                        )
                        source = _apply_catalog_transition(source, clip, use_legacy)
                        placed = _place_video_clip(source, clip, target, transition)
                        # UNDER-LAYERS FIRST: a transition reveals the shot on the other side
                        # of its cut, and butt-joined clips leave nothing there — so the
                        # neighbour's handle is placed beneath the ramp before the clip itself
                        # goes on top. Appended in this order because a later entry in the
                        # list composites above an earlier one.
                        for planned in transition_underlays(clip, position, ordered, asset_kinds):
                            resolved_neighbour = planned.neighbour
                            underlay = _underlay_layer(
                                VideoFileClip,
                                ImageClip,
                                resolved_neighbour,
                                planned.role,
                                planned.window,
                                _resolve_clip_asset(resolved_neighbour, asset_index),
                                target,
                                lut_base_dir,
                                max_decode_dimension,
                                opened,
                                _pixel_aspect_ratio(project, resolved_neighbour),
                            )
                            if matte_sources.consumes(track.id, resolved_neighbour.id, clip.id):
                                layer_mattes.add(track.id, clip.id, underlay)
                            else:
                                track_pictures.append((underlay, resolved_neighbour.blend_mode))
                        if matte_sources.consumes(track.id, clip.id, None):
                            layer_mattes.add(track.id, clip.id, placed.with_start(clip.start))
                        else:
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
                        if matte_sources.consumes(track.id, clip.id, None):
                            layer_mattes.add(track.id, clip.id, text_layer)
                        else:
                            track_pictures.append((text_layer, clip.blend_mode))
            picture_by_track.append(track_pictures)

        video_layers: list[tuple[Any, str | None]] = []
        for track_pictures in back_to_front(picture_by_track):
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
        has_blend_mode = any(mode is not None and mode != "normal" for _, mode in video_layers)
        if has_blend_mode:
            composite = _composite_with_blend_modes(video_layers, target, fps)
        else:
            composite = CompositeVideoClip(
                [layer for layer, _ in video_layers], size=target, bg_color=(0, 0, 0)
            ).with_fps(fps)
        composite = apply_effect_layers(composite, project.timeline, fps=fps)
        # Burned captions go on AFTER the effect layers. A look restyles the picture; the
        # captions are delivery text with a design of their own, and the preview draws them as
        # a DOM overlay the effect stage never reaches. Composited before it, the captured
        # short's opening caption was radial-blurred and every cue vignetted in the export
        # while the monitor showed them crisp.
        if burn_captions:
            captions = _caption_layers(project, target)
            if any(caption.backdrop is not None for caption in captions):
                # A frosted-glass chip blurs the DELIVERED picture behind it, which no
                # MoviePy layer can see; the caption compositor draws each playing
                # caption over the frame beneath it, frosting first (schema v24).
                composite = _composite_captions(composite, captions, fps)
            elif any(caption.blend_mode not in (None, "normal") for caption in captions):
                composite = _composite_with_blend_modes(
                    [(composite, None), *((c.picture, c.blend_mode) for c in captions)],
                    target,
                    fps,
                )
            elif captions:
                composite = CompositeVideoClip(
                    [composite, *(caption.picture for caption in captions)],
                    size=target,
                    bg_color=(0, 0, 0),
                ).with_fps(fps)
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
    video_layers: list[tuple[Any, str | None]], target: tuple[int, int], fps: float
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

    result = _VideoClip(frame_function=frame_at).with_duration(new_duration)
    # `base` and `canvas` (and, through it, `layer`) are only reachable from `frame_at`'s
    # closure, not from any attribute `close_clip_tree` walks — without this, every blend-mode
    # composite would leak the ffmpeg readers underneath it on every close.
    result._framepilot_children = [base, canvas]
    return result


def _keep_inside(start: float, inner: int, extent: int) -> int:
    """Where a visible box of length ``inner`` starts on an axis of length ``extent``.

    Clamped so the box stays inside the frame; a box LONGER than the frame is centred, so
    it overflows both edges evenly — what the preview's centred CSS box does — instead of
    being pinned to the leading edge and running off the other side only.
    """
    if inner >= extent:
        return round((extent - inner) / 2)
    return round(min(max(start, 0.0), float(extent - inner)))


def _caption_position_y(
    position: str, frame_height: int, box_height: int, margin: int, inset: int = 0
) -> int:
    inner = max(0, box_height - 2 * inset)
    if position == "top":
        y = float(margin)
    elif position == "middle":
        y = float((frame_height - inner) // 2)
    else:
        y = float(frame_height - inner - margin)
    return _keep_inside(y, inner, frame_height) - inset


def _caption_position(
    style: Any,
    target_w: int,
    target_h: int,
    box_w: int,
    box_h: int,
    margin: int,
    inset: tuple[int, int] = (0, 0),
) -> tuple[int, int]:
    """Top-left corner of a ``box_w`` by ``box_h`` caption canvas on the target frame.

    ``inset`` is the transparent room (horizontal, vertical) between the canvas edge and the
    caption's own box — see :attr:`CaptionRaster.margin`. Every rule here (the anchor
    margins, the safe-area clamp, keeping the caption inside the frame) is applied to that
    box, which is what the viewer sees and what the preview positions; the canvas origin is
    the box origin minus the inset, and may be negative.
    """
    inset_x, inset_y = inset
    inner_w = max(0, box_w - 2 * inset_x)
    inner_h = max(0, box_h - 2 * inset_y)
    if style.x_percent is None and style.y_percent is None:
        return (
            _keep_inside((target_w - inner_w) / 2, inner_w, target_w) - inset_x,
            _caption_position_y(style.position or "bottom", target_h, box_h, margin, inset_y),
        )
    x_percent = style.x_percent if style.x_percent is not None else 50.0
    y_percent = style.y_percent if style.y_percent is not None else 50.0
    if style.safe_area is not False:
        x_percent = min(90.0, max(10.0, x_percent))
        y_percent = min(90.0, max(10.0, y_percent))
    return (
        _keep_inside(target_w * x_percent / 100.0 - inner_w / 2, inner_w, target_w) - inset_x,
        _keep_inside(target_h * y_percent / 100.0 - inner_h / 2, inner_h, target_h) - inset_y,
    )


def _rotated_inset(margin: int, box_w: int, box_h: int, rotation_deg: float) -> tuple[int, int]:
    """The transparent inset of a caption canvas after it is rotated with ``expand=True``.

    The caption's own box rotates with the canvas, so its axis-aligned extent grows by the
    rotation; the inset is half of what the rotated canvas has beyond it on each axis.
    """
    if margin <= 0:
        return (0, 0)
    if rotation_deg == 0.0:
        return (margin, margin)
    theta = math.radians(rotation_deg)
    cos_t, sin_t = abs(math.cos(theta)), abs(math.sin(theta))
    inner_w = max(0, box_w - 2 * margin)
    inner_h = max(0, box_h - 2 * margin)
    outer_w = box_w * cos_t + box_h * sin_t
    outer_h = box_w * sin_t + box_h * cos_t
    rotated_w = inner_w * cos_t + inner_h * sin_t
    rotated_h = inner_w * sin_t + inner_h * cos_t
    return (max(0, int((outer_w - rotated_w) / 2)), max(0, int((outer_h - rotated_h) / 2)))


def baseline_caption_position(
    target_w: int, target_h: int, box_w: int, box_h: int
) -> tuple[int, int]:
    """Where an unstyled caption box is pasted: centred, in the lower safe area.

    Shared with the desktop preview's text raster route, which returns the placement with the
    raster so the monitor pastes the export's box where the export pastes it.
    """
    from framepilot_engine.timeline.models import CaptionStyle

    margin = int(target_h * _CAPTION_BOTTOM_MARGIN_FRACTION)
    return _caption_position(
        CaptionStyle(position="bottom"), target_w, target_h, box_w, box_h, margin
    )


def caption_overlay_frames(
    project: Project, target: tuple[int, int], times: Sequence[float]
) -> list[np.ndarray]:
    """The burned-in captions ALONE, over black, at each of ``times``.

    The same layers :func:`compile_timeline` composites when ``burn_captions`` is on, at the
    same frame size, with no picture beneath them — so a caller can tell which pixels of a
    delivered frame are caption without compiling the picture a second time
    (``render/caption_legibility.py``). Blend modes are not applied: this answers WHERE the
    captions are drawn, not how they mix with a picture that is not there.

    :param project: The project whose caption tracks are drawn.
    :param target: ``(width, height)`` of the delivered frame.
    :param times: Timeline seconds to draw.
    :returns: One ``(height, width, 3)`` ``uint8`` frame per time.
    """
    from moviepy import ColorClip, CompositeVideoClip

    layers = [caption.picture for caption in _caption_layers(project, target)]
    duration = max([timeline_duration(project.timeline), *(t + 1.0 for t in times)])
    base = ColorClip(size=target, color=(0, 0, 0), duration=duration)
    composite = CompositeVideoClip([base, *layers], size=target, bg_color=(0, 0, 0))
    try:
        return [np.asarray(composite.get_frame(float(t)), dtype=np.uint8)[..., :3] for t in times]
    finally:
        close_clip_tree(composite)


@dataclass(frozen=True)
class _CaptionLayer:
    """One burned caption, placed in the frame, and — for a frosted chip — its backdrop.

    ``backdrop`` is placed exactly like ``picture`` (same size, rotation and position)
    and carries the chip's coverage as its mask: where the delivered picture behind the
    caption is replaced by a blurred copy of itself, ``backdrop_sigma_px`` wide.
    """

    picture: Any
    blend_mode: str | None
    backdrop: Any | None = None
    backdrop_sigma_px: float = 0.0


def _caption_layers(project: Project, target: tuple[int, int]) -> list[_CaptionLayer]:
    layers: list[_CaptionLayer] = []
    for track in caption_tracks(project):
        for clip in track.clips:
            cue = resolve_caption_cue(clip, project.transcript)
            if not cue.text.strip():
                continue
            style = layer_caption_style(track.caption_style, clip.caption_style)
            layers.append(caption_layer_for(clip, cue.text, style, cue.words, target))
    return layers


def caption_layer_for(
    clip: Clip,
    text: str,
    style: Any,
    words: Sequence[TranscriptWord],
    target: tuple[int, int],
) -> _CaptionLayer:
    """One burned caption exactly as :func:`compile_timeline` builds it: raster, motion, placement.

    Shared with the desktop monitor's caption raster route
    (:mod:`framepilot_engine.render.preview_text`), which samples it at one frame, so a styled
    caption in the monitor is the export's own caption rather than a second rendering of it.

    :param clip: The caption clip (its ``start``/``end`` time the motion; ``blend_mode`` rides
        along on the returned layer).
    :param text: The cue's resolved text.
    :param style: The cue's layered caption style (track default under the clip's override), or
        ``None`` for the unstyled baseline.
    :param words: The cue's timed words, in timeline seconds.
    :param target: ``(width, height)`` of the delivered frame.
    :returns: The placed picture layer (and, for a frosted chip, its backdrop).
    """
    target_w, target_h = target
    margin = int(target_h * _CAPTION_BOTTOM_MARGIN_FRACTION)
    return _caption_clip(clip, text, style, words, target_w, target_h, margin)


def _caption_clip(
    clip: Clip,
    text: str,
    style: Any,
    cue_words: Sequence[TranscriptWord],
    target_w: int,
    target_h: int,
    margin: int,
) -> _CaptionLayer:
    from moviepy import ImageClip
    from moviepy import VideoClip as _VideoClip

    from framepilot_engine.render.caption_templates import resolve_caption_style

    duration = clip.end - clip.start
    words = list(cue_words) if style else []
    resolved = resolve_caption_style(style) if style is not None else None
    frosted = (
        resolved is not None
        and resolved.background is not None
        and (resolved.background.blur or 0.0) > 0.0
    )

    def finish(picture: Any, raster_margin: int) -> Any:
        rotation = (
            resolved.rotation if resolved is not None and resolved.rotation is not None else 0.0
        )
        unrotated_w, unrotated_h = picture.size
        if rotation != 0.0:
            picture = picture.rotated(-rotation, expand=True)
        box_w, box_h = picture.size
        placement_style = resolved
        if placement_style is None:
            x, y = baseline_caption_position(target_w, target_h, box_w, box_h)
        else:
            inset = _rotated_inset(raster_margin, unrotated_w, unrotated_h, rotation)
            x, y = _caption_position(
                placement_style, target_w, target_h, box_w, box_h, margin, inset
            )
        return picture.with_start(clip.start).with_position((x, y))

    def raster_at(frame_time: float) -> CaptionRaster:
        return render_caption_raster(
            text, target_w, target_h, style=style, words=words, frame_time=frame_time
        )

    if style is not None and caption_style_is_animated(style):
        last_frame: tuple[float, CaptionRaster] | None = None

        def cached(t: float) -> CaptionRaster:
            nonlocal last_frame
            if last_frame is None or last_frame[0] != t:
                last_frame = (t, raster_at(clip.start + t))
            return last_frame[1]

        def rgb_at(t: float) -> np.ndarray:
            return np.ascontiguousarray(cached(t).image[:, :, :3])

        def alpha_at(t: float) -> np.ndarray:
            return cached(t).image[:, :, 3].astype(np.float64) / 255.0

        picture = _VideoClip(frame_function=rgb_at).with_duration(duration)
        mask = _VideoClip(frame_function=alpha_at, is_mask=True).with_duration(duration)
        # The inset is a property of the layout, fixed for the cue: every frame's canvas is
        # the same size with the same room around the box (captions.py lays out once).
        first = cached(0.0)
        picture = finish(picture.with_mask(mask), first.margin)
        if not frosted:
            return _CaptionLayer(picture, clip.blend_mode)
        white = np.full((*first.image.shape[:2], 3), 255, dtype=np.uint8)

        def backdrop_at(t: float) -> np.ndarray:
            coverage = cached(t).backdrop
            if coverage is None:  # pragma: no cover - a frosted style always has a backdrop
                return np.zeros(first.image.shape[:2], dtype=np.float64)
            return coverage.astype(np.float64) / 255.0

        backdrop = _VideoClip(frame_function=lambda _t: white).with_duration(duration)
        backdrop_mask = _VideoClip(frame_function=backdrop_at, is_mask=True).with_duration(duration)
        return _CaptionLayer(
            picture,
            clip.blend_mode,
            finish(backdrop.with_mask(backdrop_mask), first.margin),
            first.backdrop_sigma_px,
        )

    raster = raster_at(clip.start)
    picture = finish(
        ImageClip(raster.image, transparent=True).with_duration(duration), raster.margin
    )
    if raster.backdrop is None:
        return _CaptionLayer(picture, clip.blend_mode)
    white = np.full((*raster.image.shape[:2], 3), 255, dtype=np.uint8)
    coverage = ImageClip(raster.backdrop.astype(np.float64) / 255.0, is_mask=True).with_duration(
        duration
    )
    backdrop = finish(ImageClip(white).with_duration(duration).with_mask(coverage), raster.margin)
    return _CaptionLayer(picture, clip.blend_mode, backdrop, raster.backdrop_sigma_px)


def _composite_captions(base: VideoClip, captions: Sequence[_CaptionLayer], fps: float) -> Any:
    """Draw each caption playing at ``t`` over the frame beneath it, frosting first.

    WHY a compositor of its own: a frosted chip (schema v24) replaces the picture
    behind it with a blurred copy of that picture. A MoviePy layer only sees its own
    pixels, and nesting one composite per cue to reach the frame below would re-blit
    the whole frame once per caption on the track (hundreds per export). Here the
    frame is read once, and only the captions actually playing at ``t`` touch it —
    each placed by MoviePy's own ``compose_on``, so the geometry is the one the
    plain composite path uses.
    """
    from moviepy import VideoClip as _VideoClip

    base_duration = float(base.duration)

    def frame_at(t: float) -> np.ndarray:
        from PIL import Image

        base_t = min(max(t, 0.0), max(base_duration - 1e-6, 0.0))
        frame = Image.fromarray(np.asarray(base.get_frame(base_t), dtype=np.uint8)).convert("RGBA")
        for caption in captions:
            if not caption.picture.is_playing(t):
                continue
            if caption.backdrop is not None and caption.backdrop_sigma_px > 0:
                frame = _frost_behind(frame, caption.backdrop, t, caption.backdrop_sigma_px)
            frame = _draw_caption_on(frame, caption, t)
        return np.asarray(frame.convert("RGB"), dtype=np.uint8)

    result = _VideoClip(frame_function=frame_at).with_duration(base_duration).with_fps(fps)
    # Only reachable from `frame_at`'s closure; `close_clip_tree` walks this list.
    result._framepilot_children = [
        base,
        *(caption.picture for caption in captions),
        *(caption.backdrop for caption in captions if caption.backdrop is not None),
    ]
    return result


def _frost_behind(frame: Any, backdrop: Any, t: float, sigma_px: float) -> Any:
    """Replace the picture under the chip's coverage with its Gaussian blur.

    Only the chip's bounding box (plus the blur's reach, 3 sigma) is blurred, so a
    caption-sized chip costs a caption-sized blur, not a full-frame one.
    """
    from moviepy.tools import compute_position
    from PIL import Image, ImageFilter

    local = t - backdrop.start
    coverage = np.asarray(backdrop.mask.get_frame(local), dtype=np.float64)
    rows, cols = np.nonzero(coverage > 0.0)
    if rows.size == 0:
        return frame
    height, width = coverage.shape
    x, y = compute_position((width, height), frame.size, backdrop.pos(local), backdrop.relative_pos)
    x, y = int(x), int(y)
    reach = math.ceil(3.0 * sigma_px)
    left = max(0, x + int(cols.min()) - reach)
    top = max(0, y + int(rows.min()) - reach)
    right = min(frame.width, x + int(cols.max()) + 1 + reach)
    bottom = min(frame.height, y + int(rows.max()) + 1 + reach)
    if right <= left or bottom <= top:
        return frame
    blurred = frame.crop((left, top, right, bottom)).filter(ImageFilter.GaussianBlur(sigma_px))
    placed = Image.new("L", frame.size, 0)
    placed.paste(Image.fromarray(np.round(coverage * 255.0).astype(np.uint8), "L"), (x, y))
    frame.paste(blurred, (left, top), placed.crop((left, top, right, bottom)))
    return frame


def _draw_caption_on(frame: Any, caption: _CaptionLayer, t: float) -> Any:
    """Composite one placed caption over ``frame``, honouring its blend mode."""
    from PIL import Image

    mode = caption.blend_mode
    if mode is None or mode == "normal":
        return caption.picture.compose_on(frame, t)
    layer = caption.picture.compose_on(Image.new("RGBA", frame.size, (0, 0, 0, 0)), t)
    top = np.asarray(layer, dtype=np.float64) / 255.0
    base = np.asarray(frame.convert("RGB"), dtype=np.float64) / 255.0
    alpha = top[:, :, 3:4]
    mixed = base * (1.0 - alpha) + apply_blend_mode(base, top[:, :, :3], mode) * alpha
    return Image.fromarray(np.clip(np.round(mixed * 255.0), 0, 255).astype(np.uint8)).convert(
        "RGBA"
    )


#: Extra source pixels kept beyond the exact need, so a cropped/fitted frame never upsamples.
DECODE_CAP_HEADROOM = 1.25


def decode_cap_for_clip(clip: Clip, target: tuple[int, int]) -> int | None:
    """The largest source edge this clip's export needs (plan/system-mission P7.5).

    A 4K source fitted into a 1080p frame only ever contributes 1080p of detail, so ffmpeg
    can decode it at that size instead of handing Python full frames to shrink. A crop
    needs more: a 30%-wide crop filling the frame needs ~3.3x the frame's pixels from the
    source. Animated clips (scale/position keyframes) are left uncapped — the zoom they
    reach is not known here, and a soft zoom is worse than a slower export.
    """
    if clip.keyframes:
        return None
    longest = max(target)
    crop = clip.crop
    fraction = 1.0
    if crop is not None:
        fraction = max(1e-3, min(float(crop.width), float(crop.height)))
    return math.ceil(longest / fraction * DECODE_CAP_HEADROOM)


def fitted_decode_size(
    source: tuple[float, float], target: tuple[int, int]
) -> tuple[int, int] | None:
    """The exact size a fit-to-frame clip is displayed at, for ffmpeg to decode straight to.

    A landscape 4K source in a 1080x1920 portrait frame is displayed at 1080x608. Decoding
    it at 2400 and letting MoviePy resize every frame to 1080x608 in PIL is the single most
    expensive thing an export does: profiling a 30s 4K->1080x1920 render put **33.3s of
    48.2s — 69% of the whole export — inside one line**, `ImagingCore.resize`, called once
    per frame. ffmpeg's scaler does the same work in the decode thread with SIMD.

    Returns ``None`` when the source is already at or below the displayed size, so an
    upscale is never requested (that would cost time AND invent detail).
    """
    source_w, source_h = source
    target_w, target_h = target
    if source_w <= 0 or source_h <= 0:
        return None
    scale = min(target_w / source_w, target_h / source_h)
    if scale >= 1.0:
        return None
    # Even dimensions: odd sizes break yuv420p chroma subsampling in several encoders.
    return (
        max(2, round(source_w * scale / 2) * 2),
        max(2, round(source_h * scale / 2) * 2),
    )


def _even(value: float) -> int:
    """Nearest even integer (Python ``round`` on the half), at least 2: yuv420p needs even sizes."""
    return max(2, round(value / 2) * 2)


def _open_moviepy_reader(
    video_file_clip_cls: Any,
    path: str,
    max_decode_dimension: int | None,
    fit_target: tuple[int, int] | None = None,
    pixel_aspect_ratio: float = 1.0,
) -> Any:
    """MoviePy's reader at the decode size the export needs (see :func:`_open_source_reader`)."""
    reader = video_file_clip_cls(path)
    width, height = reader.size
    par = pixel_aspect_ratio if pixel_aspect_ratio and pixel_aspect_ratio > 0 else 1.0
    # The sample aspect ratio stretches STORAGE width. ffmpeg autorotates a quarter-turned
    # source and MoviePy swaps `size` first, so there the stretched axis is the upright height
    # (PX2.11: stretching the upright width squashed rotated anamorphic footage).
    rotation = abs(int(getattr(getattr(reader, "reader", None), "rotation", 0) or 0))
    display = (width, height * par) if rotation in (90, 270) else (width * par, height)
    anamorphic = par != 1.0
    if fit_target is not None:
        exact = fitted_decode_size(display, fit_target)
        if exact is None and anamorphic:
            exact = (_even(display[0]), _even(display[1]))
        if exact is not None:
            reader.close()
            return video_file_clip_cls(path, target_resolution=exact)
        return reader
    longest = max(display)
    if max_decode_dimension is None or longest <= max_decode_dimension:
        if not anamorphic:
            return reader
        reader.close()
        return video_file_clip_cls(path, target_resolution=(_even(display[0]), _even(display[1])))
    scale = max_decode_dimension / longest
    target = (_even(display[0] * scale), _even(display[1] * scale))
    reader.close()
    return video_file_clip_cls(path, target_resolution=target)


def _open_source_reader(
    video_file_clip_cls: Any,
    path: str,
    max_decode_dimension: int | None,
    fit_target: tuple[int, int] | None = None,
    pixel_aspect_ratio: float = 1.0,
) -> Any:
    """Open a source, decoding no larger than the export actually needs.

    ``fit_target`` is the frame a *statically fitted* clip lands in — no keyframes, no
    crop, no transform, no geometry transition — where the displayed size is known now and
    ffmpeg can be asked for exactly it, leaving MoviePy's per-frame resize a no-op. Any
    clip that moves, scales or is cropped falls back to ``max_decode_dimension``, which
    keeps headroom because the zoom it reaches is not knowable here.

    ``pixel_aspect_ratio`` (PX2.9, ``Asset.media.pixelAspectRatio``): MoviePy reads storage
    pixels and ignores the sample aspect ratio, so an anamorphic source is decoded straight
    to its display-corrected size (storage width times PAR, even-rounded) and every later stage
    sees square pixels. ffmpeg autorotates and MoviePy swaps the size, so for a quarter-turned
    source the stretch lands on the upright height (PX2.11).

    A variable-frame-rate source (BR2.5) then reads frames by pts
    (:func:`~framepilot_engine.render.pts_reader.use_pts_reader`); a constant-rate source keeps
    MoviePy's reader, so its export is unchanged.
    """
    clip = _open_moviepy_reader(
        video_file_clip_cls, path, max_decode_dimension, fit_target, pixel_aspect_ratio
    )
    from moviepy.video.io.ffmpeg_reader import FFMPEG_VideoReader

    if not isinstance(getattr(clip, "reader", None), FFMPEG_VideoReader):
        return clip
    try:
        return use_pts_reader(clip, path)
    except (VideoTimingError, OSError) as exc:
        _log.warning("could not check %s for a variable frame rate: %s", Path(path).name, exc)
        return clip


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
