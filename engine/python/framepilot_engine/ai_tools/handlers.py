"""Pure tool handlers (PRD §8.3, plan Phase 4).

WHY: each available tool maps validated arguments to a deterministic result with
no side effects — a mutating tool returns ``list[dict]`` operation dicts (a
*patch*, never a raw mutation), a read tool returns plain JSON-able data. The
operation dicts use the canonical ``type`` and camelCase field names of
:mod:`framepilot_engine.timeline.operations`, so they parse straight into the
engine ``Operation`` union and flow through the patch validator (PRD §8.5).

Handlers are pure functions of their (already validated) args + a read-only
:class:`ToolContext`; they never touch the filesystem, network, or any state not
handed to them. This mirrors the TS ``buildOps`` / ``read`` closures in
packages/ai-sdk/src/tool-registry.ts.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from framepilot_engine.ai_tools.registry import (
    AddAssetArgs,
    AddCaptionLayerArgs,
    AddClipArgs,
    AddClipsArgs,
    AddKeyframesArgs,
    AddMarkerArgs,
    AddMaskArgs,
    AddTextLayerArgs,
    AddTrackArgs,
    AddTransitionArgs,
    AdjustAudioArgs,
    ApplyColorGradeArgs,
    AutoEmphasizeCaptionsArgs,
    DeleteClipArgs,
    DeleteClipsArgs,
    DiscoverCaptionStylesArgs,
    GetClipArgs,
    GetClipsArgs,
    ListAssetsArgs,
    LoadSkillArgs,
    ManageAssetsArgs,
    MoveClipArgs,
    MoveTrackArgs,
    PunchInArgs,
    RangeOnTrackArgs,
    RememberPreferenceArgs,
    RemoveMarkerArgs,
    RemoveTrackArgs,
    SetCaptionStyleArgs,
    SetClipBlendModeArgs,
    SetClipCropArgs,
    SetClipSpeedArgs,
    SetTrackCaptionStyleArgs,
    SetTrackFlagsArgs,
    SplitClipArgs,
    TimelineWindowArgs,
    TrackObjectArgs,
    TranscriptWindowArgs,
    TrimClipArgs,
)
from framepilot_engine.ai_tools.skills_generated import SKILLS
from framepilot_engine.effects.keyframes import punch_in_keyframes
from framepilot_engine.render.caption_templates import get_caption_template, load_catalog
from framepilot_engine.render.captions import _font_manifest
from framepilot_engine.timeline.models import Asset, CaptionStyle, Project, Track, TrackType
from framepilot_engine.timeline.operations import text_effect_id, text_overlay_clip_id

_log = logging.getLogger(__name__)

#: Default punch-in span when no end time is given and the clip is unknown.
DEFAULT_PUNCH_IN_SECONDS = 1.5

# The low-level tool creates one cue. Whole caption sets are segmented before they
# reach this handler; accepting a song-length fallback block is never useful.
MAX_CAPTION_CUE_SECONDS = 10.0
MAX_CAPTION_CUE_WORDS = 12

#: Media kinds, in the order ``list_assets`` tallies them for its empty-filter note.
_ASSET_KINDS = ("video", "audio", "image")

Operations = list[dict[str, Any]]


def _normalize_caption_word(value: str) -> str:
    """Normalize one displayed/spoken word for safe grounding comparisons."""
    return re.sub(r"^\W+|\W+$", "", value, flags=re.UNICODE).casefold()


def _assert_known_caption_style(style: CaptionStyle | None) -> None:
    """Keep agent-authored styles on assets available in both render runtimes."""
    if style is None:
        return
    if style.template_id is not None and get_caption_template(style.template_id) is None:
        raise ValueError(
            f'Unknown caption template "{style.template_id}". Call discover_caption_styles first.'
        )
    for family in (style.font_family, style.accent.font_family if style.accent else None):
        if family is not None and family not in _font_manifest():
            raise ValueError(
                f'Caption font "{family}" is not bundled. Call discover_caption_styles first.'
            )


def _find_track(project: Project, track_id: str) -> Track | None:
    return next((track for track in project.timeline.tracks if track.id == track_id), None)


def _grounded_caption_keywords(track: Track, project: Project, requested: list[str]) -> list[str]:
    vocabulary: dict[str, str] = {}
    for clip in track.clips:
        if clip.caption_cue is None:
            continue
        for cue_word in clip.caption_cue.words:
            key = _normalize_caption_word(cue_word.word)
            if key:
                vocabulary.setdefault(key, cue_word.word)
        for text_word in clip.caption_cue.text.split():
            key = _normalize_caption_word(text_word)
            if key:
                vocabulary.setdefault(key, text_word)
    for transcript_word in project.transcript:
        key = _normalize_caption_word(transcript_word.word)
        if key:
            vocabulary.setdefault(key, transcript_word.word)
    grounded: list[str] = []
    for requested_word in requested:
        exact = vocabulary.get(_normalize_caption_word(requested_word))
        if exact is None:
            raise ValueError(
                f'Emphasis keyword "{requested_word}" is not present in the '
                "caption text or transcript."
            )
        grounded.append(re.sub(r"^\W+|\W+$", "", exact, flags=re.UNICODE))
    return grounded


@dataclass(frozen=True)
class Selection:
    """The user's current time selection (seconds)."""

    start: float
    end: float


@dataclass(frozen=True)
class ToolContext:
    """Read-only context a tool runs against (mirrors the TS ``ToolContext``).

    A tool never reaches outside this object: read tools read from it, mutating
    handlers resolve ids against ``project.timeline``. ``selection`` is the
    optional user time-range. This is part of the agent sandbox (PRD §18.2).
    """

    project: Project
    selection: Selection | None = None


# ---------------------------------------------------------------------------
# Deterministic id helper (mirrors the TS ``id(...)`` in tool-registry.ts)
# ---------------------------------------------------------------------------


def _derive_id(*parts: str | float) -> str:
    """Stable id so identical inputs yield identical effect/keyframe ids."""
    rendered = [str(round(p * 1000)) if isinstance(p, (int, float)) else str(p) for p in parts]
    return "_".join(rendered)


# ---------------------------------------------------------------------------
# Mutating handlers — return operation dicts (camelCase, engine-canonical)
# ---------------------------------------------------------------------------


def trim_clip(args: TrimClipArgs, ctx: ToolContext) -> Operations:
    return [{"type": "trim_clip", "clipId": args.clip_id, "start": args.start, "end": args.end}]


def split_clip(args: SplitClipArgs, ctx: ToolContext) -> Operations:
    return [{"type": "split_clip", "clipId": args.clip_id, "at": args.at}]


def delete_range(args: RangeOnTrackArgs, ctx: ToolContext) -> Operations:
    return [
        {"type": "delete_range", "trackId": args.track_id, "start": args.start, "end": args.end}
    ]


def ripple_delete(args: RangeOnTrackArgs, ctx: ToolContext) -> Operations:
    return [
        {"type": "ripple_delete", "trackId": args.track_id, "start": args.start, "end": args.end}
    ]


def _find_clip(project: Project, clip_id: str) -> tuple[Any, Any] | None:
    """Locate ``(track, clip)`` by clip id, or ``None`` when unknown."""
    for track in project.timeline.tracks:
        for clip in track.clips:
            if clip.id == clip_id:
                return track, clip
    return None


def _clip_delete_op(project: Project, clip_id: str, ripple: bool) -> dict[str, Any]:
    """The exact-span delete op for one clip (mirrors the TS ``clipDeleteOp``).

    Clips on a track can never overlap, so a range covering exactly
    ``[clip.start, clip.end)`` removes that clip and nothing else. Raises a
    model-facing :class:`ValueError` when the id is unknown — there is no range
    to build, and the error steers the model to a listing read.
    """
    found = _find_clip(project, clip_id)
    if found is None:
        raise ValueError(f'Unknown clip "{clip_id}". Use get_clips to list real clip ids.')
    track, clip = found
    return {
        "type": "ripple_delete" if ripple else "delete_range",
        "trackId": track.id,
        "start": clip.start,
        "end": clip.end,
    }


def delete_clip(args: DeleteClipArgs, ctx: ToolContext) -> Operations:
    return [_clip_delete_op(ctx.project, args.clip_id, args.ripple)]


def delete_clips(args: DeleteClipsArgs, ctx: ToolContext) -> Operations:
    ops = [
        _clip_delete_op(ctx.project, clip_id, args.ripple)
        for clip_id in dict.fromkeys(args.clip_ids)  # dedupe, keep order
    ]
    if args.ripple:
        # Ripple shifts everything after each cut earlier, so delete back-to-front:
        # the ranges were computed against the CURRENT timeline and stay correct
        # only while nothing before them has moved.
        ops.sort(key=lambda op: -float(op["start"]))
    return ops


def move_clip(args: MoveClipArgs, ctx: ToolContext) -> Operations:
    return [
        {
            "type": "move_clip",
            "clipId": args.clip_id,
            "toTrackId": args.to_track_id,
            "toStart": args.to_start,
        }
    ]


def _add_clip_op(track_id: str, clip: Any) -> dict[str, Any]:
    """One placement, built the same way whether it arrived alone or in a batch.

    ``add_clip`` has no speed argument, so its source duration is not an independent
    model choice: at 1x it must equal the timeline duration. Derive it here instead of
    trusting duplicated arithmetic from an untrusted tool call — and derive it in ONE
    place, so the batch tool cannot drift from the singular one. ``source_end`` remains
    accepted by the registry solely for backward compatibility. Mirrors
    ``domain-tools/timeline.ts#addClipOperation``.
    """
    return {
        "type": "add_clip",
        "trackId": track_id,
        "assetId": clip.asset_id,
        "start": clip.start,
        "end": clip.end,
        "sourceStart": clip.source_start,
        "sourceEnd": clip.source_start + (clip.end - clip.start),
    }


def add_clip(args: AddClipArgs, ctx: ToolContext) -> Operations:
    return [_add_clip_op(args.track_id, args)]


def add_clips(args: AddClipsArgs, ctx: ToolContext) -> Operations:
    """Every entry through the same derivation ``add_clip`` uses, in one patch.

    A batch that placed clips by even slightly different rules than the singular tool
    would be worse than no batch at all, so both go through :func:`_add_clip_op`.
    """
    return [_add_clip_op(args.track_id, clip) for clip in args.clips]


def _next_track_id(project: Project, role: str) -> str:
    """A non-colliding, deterministic id for a new track of the given role.

    Mirrors the TS ``nextTrackId`` (packages/ai-sdk/src/tool-registry.ts) and the
    web editor's ``nextLayerId`` so AI- and user-created tracks share one naming
    scheme (``layer_<role>_<n>``).
    """
    existing = {track.id for track in project.timeline.tracks}
    n = len(project.timeline.tracks) + 1
    candidate = f"layer_{role}_{n}"
    while candidate in existing:
        n += 1
        candidate = f"layer_{role}_{n}"
    return candidate


def add_track(args: AddTrackArgs, ctx: ToolContext) -> Operations:
    # The ``add_track`` tool maps to the engine ``add_layer`` op (a track *is* a layer).
    layer_id = args.id or _next_track_id(ctx.project, args.type)
    return [
        {
            "type": "add_layer",
            "layerId": layer_id,
            "layerType": args.type,
            "atIndex": args.at_index if args.at_index is not None else 0,
        }
    ]


def remove_track(args: RemoveTrackArgs, ctx: ToolContext) -> Operations:
    # The ``remove_track`` tool maps to the engine ``remove_layer`` op.
    return [{"type": "remove_layer", "layerId": args.track_id}]


def move_track(args: MoveTrackArgs, ctx: ToolContext) -> Operations:
    return [{"type": "move_layer", "layerId": args.track_id, "toIndex": args.to_index}]


def add_text_layer(args: AddTextLayerArgs, ctx: ToolContext) -> Operations:
    # The ``add_text_layer`` tool maps to the engine ``add_text_overlay`` op, plus a
    # ``set_effect_params`` carrying the styling — the same two ops the TS tool builds, in
    # the same order, so an MCP client and Agent mode produce identical patches. The style
    # lives in the effect's params bag because that is where the Inspector writes it, the
    # preview reads it and the renderer resolves it; one vocabulary, three consumers.
    clip_id = text_overlay_clip_id(args.track_id, args.start)
    ops: Operations = [
        {
            "type": "add_text_overlay",
            "trackId": args.track_id,
            "text": args.text,
            "start": args.start,
            "end": args.end,
            "clipId": clip_id,
        }
    ]
    params = {
        key: value
        for key, value in (
            ("fontSizePercent", args.size_percent),
            ("color", args.color),
            ("background", args.background),
            ("align", args.align),
            ("boxWidthPercent", args.box_width_percent),
            ("xPercent", args.x_percent),
            ("yPercent", args.y_percent),
        )
        if value is not None
    }
    if params:
        ops.append(
            {
                "type": "set_effect_params",
                "clipId": clip_id,
                "effectId": text_effect_id(clip_id),
                "params": params,
            }
        )
    return ops


def add_caption_layer(args: AddCaptionLayerArgs, ctx: ToolContext) -> Operations:
    duration = args.end - args.start
    overlapping_words = [
        word for word in ctx.project.transcript if word.start < args.end and word.end > args.start
    ]
    if duration > MAX_CAPTION_CUE_SECONDS or len(overlapping_words) > MAX_CAPTION_CUE_WORDS:
        raise ValueError(
            "add_caption_layer creates one readable cue, but "
            f"{args.start}s-{args.end}s spans {duration:.3f}s and "
            f"{len(overlapping_words)} transcript words. Split it into separate "
            "3-7 word phrase cues; never use one layer for a whole recording or song."
        )
    return [
        {
            "type": "add_caption_layer",
            "trackId": args.track_id,
            "start": args.start,
            "end": args.end,
        }
    ]


def add_keyframes(args: AddKeyframesArgs, ctx: ToolContext) -> Operations:
    keyframes = [
        {
            "id": _derive_id("kf", args.clip_id, k.property, k.time),
            "time": k.time,
            "property": k.property,
            "value": k.value,
            "easing": k.easing or "linear",
        }
        for k in args.keyframes
    ]
    return [{"type": "add_keyframes", "clipId": args.clip_id, "keyframes": keyframes}]


def _clip_duration(project: Project, clip_id: str) -> float | None:
    """Duration of a clip on the timeline, or ``None`` if it is not present."""
    for track in project.timeline.tracks:
        for clip in track.clips:
            if clip.id == clip_id:
                return clip.end - clip.start
    return None


def punch_in(args: PunchInArgs, ctx: ToolContext) -> Operations:
    start = args.start_time if args.start_time is not None else 0.0
    duration = _clip_duration(ctx.project, args.clip_id)
    fallback_end = start + DEFAULT_PUNCH_IN_SECONDS
    # Default to the full clip; fall back to a sensible span when the clip is
    # unknown or the window collapses (a missing clip is rejected downstream by
    # the patch validator, not faked here).
    if args.end_time is not None:
        end = args.end_time
    elif duration is not None:
        end = start + duration
    else:
        end = fallback_end
    if end <= start:
        end = fallback_end
    _log.debug("punch_in: clip=%s start=%.3f end=%.3f", args.clip_id, start, end)
    keyframes = punch_in_keyframes(
        id_prefix=_derive_id("punch", args.clip_id),
        start_time=start,
        end_time=end,
        from_scale=args.from_scale if args.from_scale is not None else 1.0,
        to_scale=args.to_scale if args.to_scale is not None else 1.2,
        easing=args.easing or "ease-in-out",
    )
    return [
        {
            "type": "add_keyframes",
            "clipId": args.clip_id,
            "keyframes": [k.model_dump(by_alias=True) for k in keyframes],
        }
    ]


def apply_color_grade(args: ApplyColorGradeArgs, ctx: ToolContext) -> Operations:
    effect = {
        "id": _derive_id("grade", args.clip_id),
        "type": args.type or "color_grade",
        "params": args.params or {},
        "keyframes": [],
    }
    return [{"type": "apply_color_grade", "clipId": args.clip_id, "effect": effect}]


def adjust_audio(args: AdjustAudioArgs, ctx: ToolContext) -> Operations:
    return [{"type": "adjust_audio", "clipId": args.clip_id, "gainDb": args.gain_db}]


def add_transition(args: AddTransitionArgs, ctx: ToolContext) -> Operations:
    return [
        {
            "type": "add_transition",
            "trackId": args.track_id,
            "fromClipId": args.from_clip_id,
            "toClipId": args.to_clip_id,
            "kind": args.kind,
            "durationSeconds": args.duration_seconds,
        }
    ]


def add_mask(args: AddMaskArgs, ctx: ToolContext) -> Operations:
    return [{"type": "add_mask", "clipId": args.clip_id, "shape": args.shape}]


def track_object(args: TrackObjectArgs, ctx: ToolContext) -> Operations:
    op: dict[str, Any] = {"type": "track_object", "clipId": args.clip_id, "target": args.target}
    if args.region is not None:
        op["region"] = args.region.model_dump()
    if args.engine is not None:
        op["engine"] = args.engine
    return [op]


def set_track_flags(args: SetTrackFlagsArgs, ctx: ToolContext) -> Operations:
    op: dict[str, Any] = {"type": "set_track_flags", "trackId": args.track_id}
    if args.muted is not None:
        op["muted"] = args.muted
    if args.locked is not None:
        op["locked"] = args.locked
    if args.hidden is not None:
        op["hidden"] = args.hidden
    return [op]


def set_track_caption_style(args: SetTrackCaptionStyleArgs, ctx: ToolContext) -> Operations:
    _assert_known_caption_style(args.caption_style)
    caption_style = (
        args.caption_style.model_dump(by_alias=True, exclude_none=True)
        if args.caption_style is not None
        else None
    )
    return [
        {
            "type": "set_track_caption_style",
            "trackId": args.track_id,
            "captionStyle": caption_style,
        }
    ]


def auto_emphasize_captions(args: AutoEmphasizeCaptionsArgs, ctx: ToolContext) -> Operations:
    track = _find_track(ctx.project, args.track_id)
    if track is None:
        raise ValueError(f'Unknown track "{args.track_id}". Use get_timeline to list real ids.')
    if track.type != TrackType.CAPTION:
        raise ValueError(f'Track "{args.track_id}" is not a caption track.')
    keywords = _grounded_caption_keywords(track, ctx.project, args.keywords)
    caption_style = (
        track.caption_style.model_dump(by_alias=True, exclude_none=True)
        if track.caption_style is not None
        else {}
    )
    accent = dict(caption_style.get("accent", {}))
    accent.update(
        {
            "mode": "keywords",
            "keywords": keywords,
            "color": args.color or accent.get("color") or "#ffd60a",
            "fontScale": args.font_scale or accent.get("fontScale") or 1.18,
        }
    )
    caption_style["accent"] = accent
    return [
        {
            "type": "set_track_caption_style",
            "trackId": args.track_id,
            "captionStyle": caption_style,
        }
    ]


# ---------------------------------------------------------------------------
# Per-clip styling handlers (schema v5-v8, H1.2 slices)
#
# These emit clip-scoped ops (set_caption_style / set_clip_speed / set_clip_crop /
# set_clip_blend_mode) that are NOT part of the engine's timeline ``Operation``
# union (see framepilot_engine.timeline.operations) — like the project-scoped
# add_asset/manage_assets ops below, they are applied/validated on the TS
# editor-core side. Mirrors the TS ``buildOps`` closures in tool-registry.ts.
# ---------------------------------------------------------------------------


def set_caption_style(args: SetCaptionStyleArgs, ctx: ToolContext) -> Operations:
    _assert_known_caption_style(args.caption_style)
    caption_style = (
        args.caption_style.model_dump(by_alias=True, exclude_none=True)
        if args.caption_style is not None
        else None
    )
    return [{"type": "set_caption_style", "clipId": args.clip_id, "captionStyle": caption_style}]


def set_clip_speed(args: SetClipSpeedArgs, ctx: ToolContext) -> Operations:
    return [{"type": "set_clip_speed", "clipId": args.clip_id, "speed": args.speed}]


def set_clip_crop(args: SetClipCropArgs, ctx: ToolContext) -> Operations:
    crop = args.crop.model_dump() if args.crop is not None else None
    return [{"type": "set_clip_crop", "clipId": args.clip_id, "crop": crop}]


def set_clip_blend_mode(args: SetClipBlendModeArgs, ctx: ToolContext) -> Operations:
    blend_mode = args.blend_mode.value if args.blend_mode is not None else None
    return [{"type": "set_clip_blend_mode", "clipId": args.clip_id, "blendMode": blend_mode}]


# ---------------------------------------------------------------------------
# Project (media-bin) mutating handlers — assets & folders (schema v3, ADR 0026)
# ---------------------------------------------------------------------------

#: Canonical by-kind folders for the deterministic ``manage_assets`` fallback.
_KIND_FOLDERS: dict[str, dict[str, str]] = {
    "video": {"id": "folder_video", "name": "Video"},
    "audio": {"id": "folder_audio", "name": "Audio"},
    "image": {"id": "folder_images", "name": "Images"},
}


def _asset_id_from_path(path: str) -> str:
    """Deterministic, filesystem-safe asset id derived from a media path."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", path).strip("_")
    return f"asset_{slug or 'media'}"


def add_asset(args: AddAssetArgs, ctx: ToolContext) -> Operations:
    asset: dict[str, Any] = {
        "id": args.id or _asset_id_from_path(args.path),
        "path": args.path,
        "kind": args.kind,
    }
    if args.duration_seconds is not None:
        asset["durationSeconds"] = args.duration_seconds
    if args.folder_id is not None:
        asset["folderId"] = args.folder_id
    return [{"type": "add_asset", "asset": asset}]


def _organize_by_kind(ctx: ToolContext) -> Operations:
    ops: Operations = []
    existing = {f.id for f in ctx.project.folders}
    used_kinds = {a.kind for a in ctx.project.assets}
    for kind in ("video", "audio", "image"):
        folder = _KIND_FOLDERS[kind]
        if kind in used_kinds and folder["id"] not in existing:
            ops.append(
                {
                    "type": "create_folder",
                    "folderId": folder["id"],
                    "name": folder["name"],
                    "parentId": None,
                }
            )
    for asset in ctx.project.assets:
        target = _KIND_FOLDERS[asset.kind]["id"]
        if asset.folder_id != target:
            ops.append({"type": "move_asset", "assetId": asset.id, "folderId": target})
    return ops


def manage_assets(args: ManageAssetsArgs, ctx: ToolContext) -> Operations:
    has_plan = bool(args.folders) or bool(args.assignments)
    if args.strategy == "by-kind" or not has_plan:
        _log.debug("manage_assets: strategy=by-kind (deterministic fallback)")
        return _organize_by_kind(ctx)
    _log.debug(
        "manage_assets: strategy=%s folders=%d assignments=%d",
        args.strategy,
        len(args.folders or []),
        len(args.assignments or []),
    )
    ops: Operations = []
    for folder in args.folders or []:
        ops.append(
            {
                "type": "create_folder",
                "folderId": folder.id,
                "name": folder.name,
                "parentId": folder.parent_id,
            }
        )
    for assignment in args.assignments or []:
        ops.append(
            {"type": "move_asset", "assetId": assignment.asset_id, "folderId": assignment.folder_id}
        )
    return ops


# ---------------------------------------------------------------------------
# Markers / chapters (schema v9, H1.2 slice) — project-scoped ops (like
# add_asset/manage_assets above), not part of the timeline ``Operation`` union.
# ---------------------------------------------------------------------------


def add_marker(args: AddMarkerArgs, ctx: ToolContext) -> Operations:
    marker_id = args.id or _derive_id("marker", args.time, args.label or "")
    op: dict[str, Any] = {"type": "add_marker", "id": marker_id, "time": args.time}
    if args.label is not None:
        op["label"] = args.label
    if args.color is not None:
        op["color"] = args.color
    return [op]


def remove_marker(args: RemoveMarkerArgs, ctx: ToolContext) -> Operations:
    return [{"type": "remove_marker", "id": args.id}]


def remember_preference(args: RememberPreferenceArgs, ctx: ToolContext) -> Operations:
    """Write one lasting editing preference into the project's AI memory (P5.2).

    Whole-record, like the TS side: ``aiMemory`` is a free-form record, so a key-scoped
    operation would need an inverse that distinguished "was absent" from "was empty".
    Carrying the whole record makes the inverse the record that was there, exactly.
    """
    memory: dict[str, Any] = dict(ctx.project.ai_memory or {})
    if args.key is not None and args.value is not None:
        memory[args.key] = args.value
    if args.export_platforms is not None:
        memory["exportPlatforms"] = list(args.export_platforms)
    return [{"type": "set_ai_memory", "memory": memory}]


# ---------------------------------------------------------------------------
# Read handlers — return JSON-able project data from the context
# ---------------------------------------------------------------------------


def _model_asset(asset: Asset) -> dict[str, Any]:
    """One asset as the MODEL sees it — identity, kind, duration, folder.

    ``Asset.media`` (proxy path, waveform ``peaks``, thumbnail paths) is engine-derived
    RENDER data: one float per waveform bucket, so a single minute-long clip is hundreds
    of numbers and a real bin is tens of thousands. The model never draws a waveform or
    opens a proxy — the timeline canvas and preview player read those from the project —
    yet the raw dump crowded the asset ids the read exists to deliver out of every
    downstream budget (evidence preview, ``recall_evidence``, the result popup). Mirrors
    ``Asset.source`` (provider provenance, schema v20) is collapsed for a related but
    distinct reason: it is not render data, but eight fields of licence URLs, creator
    URLs and fetch timestamps are not reasoning material either. The one fact the model
    can act on is that a track obliges a credit, so that survives as
    ``attributionRequired`` and the rest does not — the full record lives in the project
    file, where the Credits view reads it (ADR 0138).

    Mirrors ``packages/ai-sdk/src/model-view.ts``; both tool surfaces must return the
    same shape.
    """
    dumped = asset.model_dump(by_alias=True)
    dumped.pop("media", None)
    source = dumped.pop("source", None)
    if isinstance(source, dict) and source.get("attributionRequired") is True:
        dumped["attributionRequired"] = True
    return dumped


#: Words previewed by `get_project_state` before it defers to `get_mapped_transcript`.
#: Mirrors `TRANSCRIPT_PREVIEW_WORDS` in `tool-registry.ts`.
TRANSCRIPT_PREVIEW_WORDS = 12


def get_project_state(args: Any, ctx: ToolContext) -> dict[str, Any]:
    dumped = ctx.project.model_dump(by_alias=True)
    # Undo entries can carry large inverse patches and are editor recovery state, not
    # model reasoning material. Keep this projection aligned with model-view.ts; a live
    # project history previously inflated one tool result to 116 MB.
    dumped["history"] = []
    # The bin comes back as a TALLY, not a listing — `list_assets` returns the same array,
    # and a run that calls both pays for the asset ids twice and files two evidence
    # handles for one fact. What this tool adds over `list_assets` is everything else:
    # fps, resolution, the timeline, markers, memory. Mirrors
    # `tool-registry.ts`'s `assetTally`; the two surfaces must return the same shape.
    dumped.pop("assets", None)
    by_kind: dict[str, int] = {}
    for asset in ctx.project.assets:
        by_kind[asset.kind] = by_kind.get(asset.kind, 0) + 1
    dumped["assetSummary"] = {
        "total": len(ctx.project.assets),
        "byKind": by_kind,
        "note": "Asset ids are not listed here — call list_assets for them.",
    }
    # And so does the transcript, for the same measured reason. In run `145ec3f3` the
    # transcript was 19,219 of this payload's 21,000 characters — 91% — for a 47-second
    # video, and the run read it nine times. `get_mapped_transcript` returns the words
    # windowed, and returns them as they play AFTER the edit, which is the version worth
    # reasoning about. Mirrors `tool-registry.ts`'s `transcriptTally`.
    dumped.pop("transcript", None)
    words = ctx.project.transcript
    preview = " ".join(word.word for word in words[:TRANSCRIPT_PREVIEW_WORDS])
    dumped["transcriptSummary"] = {
        "words": len(words),
        "startSeconds": words[0].start if words else None,
        "endSeconds": words[-1].end if words else None,
        "preview": f"{preview}…" if len(words) > TRANSCRIPT_PREVIEW_WORDS else preview,
        "note": (
            "This project has no transcript yet — call transcribe to create one."
            if not words
            else "Words are not listed here — call get_mapped_transcript for the "
            "transcript as it plays after your edits."
        ),
    }
    return dumped


def discover_caption_styles(args: DiscoverCaptionStylesArgs, ctx: ToolContext) -> dict[str, Any]:
    """Return bundled static caption assets; no project or external state is read."""
    query = args.query.casefold() if args.query is not None else None
    templates = [
        template
        for template in load_catalog().values()
        if args.category is None or template.category == args.category
    ]
    if query is not None:
        templates = [
            template
            for template in templates
            if any(
                query in value.casefold()
                for value in (
                    template.id,
                    template.label,
                    template.category,
                    template.style.font_family or "",
                    template.style.display or "",
                )
            )
        ]
    limited = templates[: args.limit or 20]
    fonts = []
    for family, entry in _font_manifest().items():
        fonts.append(
            {
                "family": family,
                "category": entry.get("category"),
                "minWeight": entry.get("minWeight"),
                "maxWeight": entry.get("maxWeight"),
            }
        )
    return {
        "matched": len(templates),
        "returned": len(limited),
        "fonts": fonts,
        "templates": [
            {
                "templateId": template.id,
                "label": template.label,
                "category": template.category,
                "suggestedWordsPerLine": template.suggested_words_per_line,
                "fontFamily": template.style.font_family,
                "display": template.style.display,
            }
            for template in limited
        ],
        "compositionFields": [
            "fontFamily",
            "fontWeight",
            "fontStyle",
            "fontScale",
            "textColor",
            "outlineColor",
            "outlineWidth",
            "xPercent",
            "yPercent",
            "rotation",
            "maxWidthPercent",
            "textAlign",
            "lineHeight",
            "safeArea",
            "letterSpacing",
            "background",
            "shadow",
            "animation",
            "accent",
        ],
    }


def get_timeline(args: TimelineWindowArgs, ctx: ToolContext) -> dict[str, Any]:
    """The timeline, optionally windowed to clips overlapping ``[start, end)``."""
    timeline = ctx.project.timeline.model_dump(by_alias=True)
    if args.start is None and args.end is None:
        return timeline
    start = args.start if args.start is not None else float("-inf")
    end = args.end if args.end is not None else float("inf")
    timeline["tracks"] = [
        {
            **track,
            "clips": [
                clip for clip in track["clips"] if clip["end"] > start and clip["start"] < end
            ],
        }
        for track in timeline["tracks"]
    ]
    return timeline


def get_transcript(args: TranscriptWindowArgs, ctx: ToolContext) -> list[dict[str, Any]]:
    """The transcript, optionally windowed to words overlapping ``[start, end)``."""
    words = ctx.project.transcript
    if args.start is not None or args.end is not None:
        start = args.start if args.start is not None else float("-inf")
        end = args.end if args.end is not None else float("inf")
        words = [w for w in words if w.end > start and w.start < end]
    return [word.model_dump(by_alias=True) for word in words]


#: `get_clips` page size when the model gives no limit (mirrors the TS constant).
_GET_CLIPS_DEFAULT_LIMIT = 50


def _clip_row(clip: Any) -> dict[str, Any]:
    """Compact clip row for windowed listings (mirrors the TS ``clipRow``).

    Heavy nested payloads (effects, keyframes, styling) are replaced with
    counts so a long-form timeline can be scanned cheaply; ``get_clip`` returns
    the full clip when the detail is needed.
    """
    row: dict[str, Any] = {
        "id": clip.id,
        "trackId": clip.track_id,
        "assetId": clip.asset_id,
        "start": clip.start,
        "end": clip.end,
        "sourceStart": clip.source_start,
        "sourceEnd": clip.source_end,
    }
    if clip.speed is not None:
        row["speed"] = clip.speed
    row["effectCount"] = len(clip.effects)
    row["keyframeCount"] = len(clip.keyframes)
    return row


def get_timeline_summary(args: Any, ctx: ToolContext) -> dict[str, Any]:
    """Compact per-track overview (mirrors the TS ``get_timeline_summary``)."""
    tracks: list[dict[str, Any]] = []
    for track in ctx.project.timeline.tracks:
        entry: dict[str, Any] = {
            "id": track.id,
            "type": track.type,
            "clipCount": len(track.clips),
            "firstClipStart": min((c.start for c in track.clips), default=None),
            "lastClipEnd": max((c.end for c in track.clips), default=None),
        }
        # Python models default the v4 flags to False; mirror the TS shape, which
        # only carries a flag when it is meaningfully set.
        if track.muted:
            entry["muted"] = True
        if track.locked:
            entry["locked"] = True
        if track.hidden:
            entry["hidden"] = True
        tracks.append(entry)
    return {
        "durationSeconds": max((t["lastClipEnd"] or 0 for t in tracks), default=0),
        "trackCount": len(tracks),
        "clipCount": sum(t["clipCount"] for t in tracks),
        "tracks": tracks,
        "markerCount": len(ctx.project.markers),
        "transcriptWordCount": len(ctx.project.transcript),
    }


def get_clips(args: GetClipsArgs, ctx: ToolContext) -> dict[str, Any]:
    """Windowed, paginated compact clip listing (mirrors the TS ``get_clips``)."""
    start = args.start if args.start is not None else float("-inf")
    end = args.end if args.end is not None else float("inf")
    matched = sorted(
        (
            clip
            for track in ctx.project.timeline.tracks
            if args.track_id is None or track.id == args.track_id
            for clip in track.clips
            if clip.end > start and clip.start < end
        ),
        key=lambda c: (c.start, c.track_id),
    )
    offset = args.offset or 0
    limit = args.limit if args.limit is not None else _GET_CLIPS_DEFAULT_LIMIT
    page = matched[offset : offset + limit]
    return {
        "clips": [_clip_row(c) for c in page],
        "total": len(matched),
        "hasMore": offset + len(page) < len(matched),
    }


def get_clip(args: GetClipArgs, ctx: ToolContext) -> dict[str, Any]:
    """One clip in full detail plus its trackId (mirrors the TS ``get_clip``)."""
    found = _find_clip(ctx.project, args.clip_id)
    if found is None:
        return {"error": f'Unknown clip "{args.clip_id}". Use get_clips to list real ids.'}
    track, clip = found
    return {"trackId": track.id, "clip": clip.model_dump(by_alias=True)}


def list_assets(args: ListAssetsArgs, ctx: ToolContext) -> dict[str, Any]:
    """List the media bin (assets + folders), applying the optional filters."""
    assets = list(ctx.project.assets)
    if args.kind is not None:
        assets = [a for a in assets if a.kind == args.kind]
    if args.folder_id is not None:
        assets = [a for a in assets if a.folder_id == args.folder_id]
    result: dict[str, Any] = {
        "assets": [_model_asset(a) for a in assets],
        "folders": [f.model_dump(by_alias=True) for f in ctx.project.folders],
    }
    # A filter that matched nothing and an empty bin are the same ``{"assets": []}`` to a
    # reader, and the agent has read the first as the second — then told the user to
    # import media that was already there. Say which one it is (mirrors the TS tool).
    if not assets and ctx.project.assets:
        result["note"] = _empty_filter_note(ctx.project.assets)
    return result


def _empty_filter_note(assets: Sequence[Asset]) -> str:
    """What the bin actually holds, for a filter that excluded every asset."""
    tally = ", ".join(
        f"{count} {kind}"
        for kind, count in ((k, sum(1 for a in assets if a.kind == k)) for k in _ASSET_KINDS)
        if count
    )
    return (
        "No asset matched this filter, but the media bin is NOT empty — it holds "
        f"{len(assets)} asset(s): {tally}. Call list_assets with no arguments to see them all."
    )


def get_selected_range(args: Any, ctx: ToolContext) -> dict[str, float] | None:
    if ctx.selection is None:
        return None
    return {"start": ctx.selection.start, "end": ctx.selection.end}


def recall_evidence(args: Any, ctx: ToolContext) -> dict[str, Any]:
    """Honest degraded answer for the sidecar surface (ADR 0075).

    The evidence store is per-RUN state owned by the TS orchestrator, which answers
    this call before it ever reaches a registry body. The sidecar holds no run, so
    it says so plainly rather than pretending to recall something.
    """
    _log.debug("recall_evidence: no run-scoped evidence store on the sidecar surface")
    return {
        "recalled": False,
        "reason": "No evidence store is attached to this run.",
    }


def load_skill(args: LoadSkillArgs, ctx: ToolContext) -> dict[str, Any]:
    """Return one bundled skill's full playbook (ADR 0057).

    Skills are generated from ``packages/ai-sdk/skills/*.md`` into
    :mod:`framepilot_engine.ai_tools.skills_generated` (the Python mirror of the
    TS bundle), so both registries serve identical content. Unknown names return
    the valid list so the model can self-correct.
    """
    for skill in SKILLS:
        if skill["name"] == args.name:
            _log.debug("load_skill: found %r", args.name)
            return skill
    _log.warning("load_skill: unknown skill %r", args.name)
    return {
        "error": f'Unknown skill "{args.name}".',
        "available": [skill["name"] for skill in SKILLS],
    }
