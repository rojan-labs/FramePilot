"""AI tool registry (PRD §8.3, plan Phase 4).

The AI may only edit through these registered, schema-validated tools; tools
return *patches* (lists of typed operation dicts), never raw mutations.

WHY: this is the security boundary for the agent (PRD §18.2). The model never
touches project JSON directly — it calls a tool by name, the input is validated
against the tool's Pydantic ``input_model`` (the schema gate), and a mutating
tool emits operations that go through the patch validator (PRD §8.5) before
anything is applied.

This module is the Python mirror of the TS ``@framepilot/ai-sdk`` tool registry
(packages/ai-sdk/src/tool-registry.ts) — same tool list, same ``available`` /
``mutating`` flags, same argument shapes. The JSON Schema advertised to the model
is *derived* from each tool's Pydantic model (``model_json_schema``), so the
validation gate and the advertised schema can never drift.

Build-order invariant (PRD §23): tools whose underlying engine capability does
not exist yet are registered for discoverability but marked ``available=False``
so the dispatcher refuses to invoke them rather than fabricate a result:
``generate_mask`` (dependency-gated CV work; ``detect_faces`` was superseded by the
desktop-only pack-backed ``detect_subjects`` in 2026-08). ``render_preview``
/ ``export_video`` are available, non-mutating *actions*. ``analyze_silence`` /
``detect_scenes`` are available, non-mutating *analysis* tools: their ffmpeg
engine (``framepilot_engine.analysis``) exists, and — like actions — the host
executes them against the media and returns the data; the pure dispatch here only
validates their arguments (it never runs ffmpeg itself).
"""

from __future__ import annotations

import logging
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator, model_validator

from framepilot_engine.render.caption_templates import load_catalog
from framepilot_engine.timeline.models import BlendMode, CaptionStyle, CropRect

_log = logging.getLogger(__name__)

# ``extra="forbid"`` is the security boundary: unknown args are rejected, never
# silently dropped. Every tool input model inherits it.
_STRICT = ConfigDict(extra="forbid")


def _blank_to_none(value: Any) -> Any:
    """Read a blank optional string selector as "not provided".

    Models routinely fill an optional string parameter with ``""`` instead of omitting
    the key — ``list_assets {"kind": "video", "folderId": ""}`` is the observed shape.
    Taken literally that is an *active* filter for a folder whose id is the empty
    string, which no id in this schema can ever be, so the tool answered "no assets"
    for a full media bin and the agent concluded the project was empty.

    ``""`` is never a meaningful id, query, or category, so a blank (or whitespace-only)
    value means "not provided". Mirrors ``filterString`` in the TS registry
    (packages/ai-sdk/src/tool-registry.ts); the two surfaces must behave identically.
    """
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    return stripped or None


# An OPTIONAL string selector (id, query, category) as it arrives from a model.
FilterStr = Annotated[str | None, BeforeValidator(_blank_to_none)]


# ---------------------------------------------------------------------------
# Tool kinds
# ---------------------------------------------------------------------------

ToolKind = Literal["read", "mutate", "action", "analysis", "unavailable"]


# ---------------------------------------------------------------------------
# Input models (mirror the Zod schemas in packages/ai-sdk/src/tool-registry.ts)
# ---------------------------------------------------------------------------


class NoArgs(BaseModel):
    """No-argument tool input. Rejects any supplied field."""

    model_config = _STRICT


class TrimClipArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)


class SplitClipArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    at: float = Field(ge=0.0)


class RangeOnTrackArgs(BaseModel):
    """Shared shape for ``delete_range`` and ``ripple_delete``."""

    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)


class MoveClipArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    to_track_id: str = Field(alias="toTrackId")
    to_start: float = Field(alias="toStart", ge=0.0)


class AddClipArgs(BaseModel):
    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    asset_id: str = Field(alias="assetId")
    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)
    source_start: float = Field(default=0.0, alias="sourceStart", ge=0.0)
    # Accepted for compatibility with older callers. The handler derives the real
    # source end from the timeline span so untrusted model arithmetic cannot violate
    # the clip speed/duration invariant.
    source_end: float | None = Field(default=None, alias="sourceEnd", ge=0.0)


class AddTrackArgs(BaseModel):
    """Create a new empty track/layer (mirrors the TS ``add_track`` tool).

    ``type`` is the track's advisory role (default ``overlay``); ``at_index`` is
    the z-order slot (0 = visual front) and defaults to the front when omitted; an
    explicit ``id`` may be supplied, otherwise the handler derives a
    non-colliding deterministic one.
    """

    model_config = _STRICT
    type: Literal["video", "audio", "caption", "overlay"] = "overlay"
    at_index: int | None = Field(default=None, alias="atIndex", ge=0)
    id: FilterStr = None


class AddTextLayerArgs(BaseModel):
    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    text: str
    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)


class AddCaptionLayerArgs(BaseModel):
    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    start: float = Field(ge=0.0)
    end: float = Field(ge=0.0)


class KeyframeArg(BaseModel):
    """One keyframe spec from the model (id is derived by the handler)."""

    model_config = _STRICT
    time: float = Field(ge=0.0)
    property: str
    value: float
    easing: Literal["linear", "ease-in", "ease-out", "ease-in-out", "hold", "bezier"] | None = None


class AddKeyframesArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    keyframes: list[KeyframeArg] = Field(min_length=1)


class PunchInArgs(BaseModel):
    """Zoom/punch-in (animated scale) on a clip; times are clip-relative."""

    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    from_scale: float | None = Field(default=None, alias="fromScale", gt=0.0)
    to_scale: float | None = Field(default=None, alias="toScale", gt=0.0)
    easing: Literal["linear", "ease-in", "ease-out", "ease-in-out", "hold", "bezier"] | None = None
    start_time: float | None = Field(default=None, alias="startTime", ge=0.0)
    end_time: float | None = Field(default=None, alias="endTime", ge=0.0)


class ApplyColorGradeArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    type: Literal["color_grade", "lut", "transform"] | None = None
    params: dict[str, Any] | None = None


class AdjustAudioArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    gain_db: float = Field(alias="gainDb")


# --- Effect layers (schema v13, ADR 0088) ----------------------------------
#
# These mirror the TS tool schemas field for field. The parity test
# (tests/test_tool_registry_ts_parity.py) pins the NAMES; keeping the shapes
# aligned by hand is what lets a sidecar-hosted agent and a browser-hosted one
# produce the same patches from the same model output.


class DiscoverEffectsArgs(BaseModel):
    model_config = _STRICT
    query: FilterStr = None
    category: FilterStr = None
    shelf: Literal["popular", "recommended"] | None = None
    limit: int | None = None


class DiscoverTransitionsArgs(BaseModel):
    model_config = _STRICT
    query: FilterStr = None
    category: FilterStr = None
    shelf: Literal["popular", "recommended"] | None = None
    limit: int | None = None


class ApplyEffectArgs(BaseModel):
    model_config = _STRICT
    effect_id: str = Field(alias="effectId")
    start_time: float = Field(alias="startTime")
    end_time: float | None = Field(default=None, alias="endTime")
    params: dict[str, float] | None = None
    intensity: float | None = None
    track_id: FilterStr = Field(default=None, alias="trackId")


class MoveEffectArgs(BaseModel):
    model_config = _STRICT
    layer_id: str = Field(alias="layerId")
    to_start: float = Field(alias="toStart")
    to_track_id: FilterStr = Field(default=None, alias="toTrackId")


class ResizeEffectArgs(BaseModel):
    model_config = _STRICT
    layer_id: str = Field(alias="layerId")
    start: float
    end: float


class AdjustEffectArgs(BaseModel):
    model_config = _STRICT
    layer_id: str = Field(alias="layerId")
    params: dict[str, float] | None = None
    intensity: float | None = None


class SetEffectEnabledArgs(BaseModel):
    model_config = _STRICT
    layer_id: str = Field(alias="layerId")
    enabled: bool


class RemoveEffectArgs(BaseModel):
    model_config = _STRICT
    layer_id: str = Field(alias="layerId")


class AddTransitionArgs(BaseModel):
    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    from_clip_id: str = Field(alias="fromClipId")
    to_clip_id: str = Field(alias="toClipId")
    # A transition catalog id, not an enum. The catalog is data, and restating
    # 78 ids here would make every added transition a change in four packages;
    # the operation checks it against the catalog and refuses an unknown one with
    # a readable sentence, which is what a model needs to correct itself.
    kind: str
    duration_seconds: float = Field(alias="durationSeconds", gt=0.0)


class AddMaskArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    shape: Literal["rectangle", "ellipse", "polygon"]


class BoundsArg(BaseModel):
    """A region as frame fractions (0..1)."""

    model_config = _STRICT
    x: float = Field(ge=0.0)
    y: float = Field(ge=0.0)
    width: float = Field(ge=0.0)
    height: float = Field(ge=0.0)


class TrackObjectArgs(BaseModel):
    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    target: Literal["face", "bounding_box", "object"]
    region: BoundsArg | None = None
    engine: FilterStr = None


class AddAssetArgs(BaseModel):
    """Add a media asset to the project bin (schema v3, ADR 0026)."""

    model_config = _STRICT
    path: str
    kind: Literal["video", "audio", "image"] = "video"
    duration_seconds: float | None = Field(default=None, alias="durationSeconds", ge=0.0)
    folder_id: FilterStr = Field(default=None, alias="folderId")
    id: FilterStr = None


class FolderPlanArg(BaseModel):
    """One folder in a ``manage_assets`` semantic plan."""

    model_config = _STRICT
    id: str
    name: str
    parent_id: FilterStr = Field(default=None, alias="parentId")


class AssignmentArg(BaseModel):
    """One asset→folder assignment in a ``manage_assets`` plan (``None`` = root)."""

    model_config = _STRICT
    asset_id: str = Field(alias="assetId")
    folder_id: FilterStr = Field(alias="folderId")


class ManageAssetsArgs(BaseModel):
    """Organize the media bin: an explicit semantic plan or ``by-kind`` grouping."""

    model_config = _STRICT
    strategy: Literal["by-kind", "plan"] | None = None
    folders: list[FolderPlanArg] | None = None
    assignments: list[AssignmentArg] | None = None


class ListAssetsArgs(BaseModel):
    """List the media bin, optionally filtered (mirrors the TS ``listAssetsSchema``).

    Both filters are optional and ANDed: ``kind`` narrows to one media type and
    ``folder_id`` to a single bin folder. Omit both to list the whole bin.
    """

    model_config = _STRICT
    kind: Literal["video", "audio", "image"] | None = None
    folder_id: FilterStr = Field(default=None, alias="folderId")


class LoadSkillArgs(BaseModel):
    """Load one bundled skill's full instructions (mirrors the TS ``load_skill``)."""

    model_config = _STRICT
    name: str


class RecallEvidenceArgs(BaseModel):
    """Re-open a stored read by handle (mirrors the TS ``recall_evidence``, ADR 0075)."""

    model_config = _STRICT
    evidence_id: str = Field(alias="evidenceId")
    query: FilterStr = None
    # Character offset into the stored payload, so the tail of a result larger than the
    # recall budget stays reachable (mirrors the TS ``offset``).
    offset: int | None = Field(default=None, ge=0)


class TranscriptWindowArgs(BaseModel):
    """Optional transcript window (mirrors the TS ``transcriptWindowSchema``).

    Only words overlapping ``[start, end)`` are returned; omit both to read the
    whole transcript (today's behavior).
    """

    model_config = _STRICT
    start: float | None = Field(default=None, ge=0.0)
    end: float | None = Field(default=None, ge=0.0)


class MapTimeArgs(BaseModel):
    """One timestamp to convert between timebases (mirrors the TS ``map_time``).

    ``sourceTime`` (+ optional ``assetId``) asks where a moment of the original
    recording ended up on the edit; ``sequenceTime`` asks what plays at a moment
    of the edit. Both omitted returns the whole timeline map.
    """

    model_config = _STRICT
    source_time: float | None = Field(default=None, alias="sourceTime", ge=0.0)
    asset_id: FilterStr = Field(default=None, alias="assetId")
    sequence_time: float | None = Field(default=None, alias="sequenceTime", ge=0.0)


class VerifyCaptionsArgs(BaseModel):
    """Caption verification tolerance (mirrors the TS ``verify_captions``)."""

    model_config = _STRICT
    tolerance_seconds: float | None = Field(default=None, alias="toleranceSeconds", ge=0.0)


class GetClipsArgs(BaseModel):
    """Windowed, paginated clip listing (mirrors the TS ``getClipsSchema``)."""

    model_config = _STRICT
    track_id: FilterStr = Field(default=None, alias="trackId")
    start: float | None = Field(default=None, ge=0.0)
    end: float | None = Field(default=None, ge=0.0)
    offset: int | None = Field(default=None, ge=0)
    limit: int | None = Field(default=None, ge=1, le=200)


class GetClipArgs(BaseModel):
    """Read one clip in full detail (mirrors the TS ``get_clip``)."""

    model_config = _STRICT
    clip_id: str = Field(alias="clipId")


class DeleteClipArgs(BaseModel):
    """Delete one clip by id (mirrors the TS ``delete_clip``)."""

    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    ripple: bool = False


class DeleteClipsArgs(BaseModel):
    """Delete several clips by id in one call (mirrors the TS ``delete_clips``)."""

    model_config = _STRICT
    clip_ids: list[str] = Field(alias="clipIds", min_length=1, max_length=50)
    ripple: bool = False


class RemoveTrackArgs(BaseModel):
    """Remove a track/layer by id (mirrors the TS ``remove_track``)."""

    model_config = _STRICT
    track_id: str = Field(alias="trackId")


class MoveTrackArgs(BaseModel):
    """Reorder a track to a new z-order slot (mirrors the TS ``move_track``)."""

    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    to_index: int = Field(alias="toIndex", ge=0)


class TranscribeArgs(BaseModel):
    """Request host-owned ASR for one project asset (plan H0.1)."""

    model_config = _STRICT
    asset_id: FilterStr = Field(default=None, alias="assetId")


class SetTrackFlagsArgs(BaseModel):
    """Mute/lock/hide a track (schema v4). Only provided flags change."""

    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    muted: bool | None = None
    locked: bool | None = None
    hidden: bool | None = None

    @model_validator(mode="after")
    def _at_least_one_flag(self) -> SetTrackFlagsArgs:
        if self.muted is None and self.locked is None and self.hidden is None:
            raise ValueError("Set at least one of muted/locked/hidden.")
        return self


class SetCaptionStyleArgs(BaseModel):
    """Style a caption clip (schema v5). ``None`` clears styling back to unstyled.

    Reuses :class:`framepilot_engine.timeline.models.CaptionStyle` verbatim (the
    same rich value the engine persists) so the tool argument can never drift
    from what it writes — mirrors the TS ``CaptionStyleSchema`` reuse.
    """

    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    caption_style: CaptionStyle | None = Field(alias="captionStyle")


class SetTrackCaptionStyleArgs(BaseModel):
    """Set the shared style for every caption cue on one track (schema v11+)."""

    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    caption_style: CaptionStyle | None = Field(alias="captionStyle")


class AutoEmphasizeCaptionsArgs(BaseModel):
    """AI-selected, transcript-grounded emphasis plus optional track composition."""

    model_config = _STRICT
    track_id: str = Field(alias="trackId")
    keywords: list[str] = Field(min_length=1, max_length=12)
    style: CaptionStyle | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$")
    font_scale: float | None = Field(default=None, alias="fontScale", ge=1.0, le=3.0)

    @field_validator("keywords")
    @classmethod
    def _unique_keywords(cls, keywords: list[str]) -> list[str]:
        cleaned = [keyword.strip() for keyword in keywords]
        if any(not keyword for keyword in cleaned):
            raise ValueError("Keywords must not be blank.")
        normalized = [
            re.sub(r"^\W+|\W+$", "", keyword, flags=re.UNICODE).casefold() for keyword in cleaned
        ]
        if any(not keyword for keyword in normalized):
            raise ValueError("Keywords must contain a letter or number.")
        if len(set(normalized)) != len(normalized):
            raise ValueError("Keywords must be unique.")
        return cleaned


def caption_template_count() -> int:
    """How many caption templates the catalog holds, for the ``limit`` ceiling.

    Read from the committed catalog artifact rather than hardcoded: the ceiling used to be
    a literal 45 against a 51-template catalog, so no single ``discover_caption_styles``
    call could return everything and the ids past the cut were unusable — and
    ``set_track_caption_style`` rejects an id the model was never shown.
    """
    return len(load_catalog())


class DiscoverCaptionStylesArgs(BaseModel):
    """Filter the bundled caption templates while always returning bundled fonts."""

    model_config = _STRICT
    # A blank query means "browse the whole catalog", not a rejected call: a model that
    # fills the optional field with "" was asking for everything (see ``_blank_to_none``).
    query: FilterStr = None
    category: (
        Literal[
            "one-word", "phrase", "karaoke", "build", "boxed", "editorial", "aesthetic", "cinematic"
        ]
        | None
    ) = None
    # Mirrors the TS ceiling: the catalog's own size, so the whole catalog is reachable
    # in one call. A ceiling below it meant no call could return everything.
    limit: int | None = Field(default=None, ge=1, le=caption_template_count())


class SetClipSpeedArgs(BaseModel):
    """Set a clip's constant playback speed (schema v6 time-remap). ``None`` resets to 1x."""

    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    speed: float | None = Field(gt=0.0)


class SetClipCropArgs(BaseModel):
    """Crop/reframe a clip (schema v7). ``None`` clears the crop back to the full frame.

    Reuses :class:`framepilot_engine.timeline.models.CropRect` verbatim (the same
    rich value the engine persists) — mirrors the TS ``CropRectSchema`` reuse.
    """

    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    crop: CropRect | None


class SetClipBlendModeArgs(BaseModel):
    """Set a clip's compositing blend mode (schema v8). ``None`` resets to 'normal'."""

    model_config = _STRICT
    clip_id: str = Field(alias="clipId")
    blend_mode: BlendMode | None = Field(alias="blendMode")


class AddMarkerArgs(BaseModel):
    """Add a marker/chapter point to the project timeline (schema v9).

    An explicit ``id`` may be supplied; otherwise the handler derives a
    deterministic one from ``time``+``label`` (mirrors the TS ``add_marker`` tool).
    """

    model_config = _STRICT
    time: float = Field(ge=0.0)
    label: str | None = Field(default=None, min_length=1)
    color: str | None = Field(default=None, min_length=1)
    id: FilterStr = None


class RemoveMarkerArgs(BaseModel):
    """Remove a marker/chapter by id (schema v9)."""

    model_config = _STRICT
    id: str


class AnalyzeSilenceArgs(BaseModel):
    """Analyse an asset's audio for silent ranges (plan Phase 9.2).

    ``asset_id`` selects which media to analyse; omit it to analyse the first
    asset that carries audio. The thresholds mirror ffmpeg ``silencedetect``.
    """

    model_config = _STRICT
    asset_id: FilterStr = Field(default=None, alias="assetId")
    noise_floor_db: float | None = Field(default=None, alias="noiseFloorDb")
    min_silence_seconds: float | None = Field(default=None, alias="minSilenceSeconds", ge=0.0)


class DetectScenesArgs(BaseModel):
    """Detect scene-cut timestamps in an asset's video (plan Phase 9.2).

    ``asset_id`` selects which media to analyse; omit it to analyse the first
    video asset. ``threshold`` is the ffmpeg scene score (0..1).
    """

    model_config = _STRICT
    asset_id: FilterStr = Field(default=None, alias="assetId")
    threshold: float | None = Field(default=None, ge=0.0, le=1.0)


class GetFrameArgs(BaseModel):
    """Render ONE composited frame of the timeline and look at it (vision).

    ``time_seconds`` is TIMELINE time, like every other timing tool here — the
    model reasons about the edit, not about source media. ``max_dimension``
    bounds the returned image: it is sent to a model as base64, so its token
    cost scales with its pixels, and most framing/legibility questions are
    answered at the small default. Captions are burned in unless turned off —
    soft captions are invisible in a still.
    """

    model_config = _STRICT
    time_seconds: float = Field(alias="timeSeconds")
    max_dimension: int | None = Field(default=None, alias="maxDimension", ge=128, le=1280)
    burn_captions: bool | None = Field(default=None, alias="burnCaptions")


class DetectBeatsArgs(BaseModel):
    """Detect beat/onset timestamps in an asset's audio (plan AGENT-NATIVE-UX T6).

    ``asset_id`` selects which media to analyse; omit it to analyse the first
    audio-bearing asset. ``sensitivity`` tunes the onset peak picker (lower
    finds more, softer beats). ``hard_sync`` is an EDITORIAL declaration rather than an
    analysis parameter — the analyzer ignores it entirely; it tells the calling runtime that
    every interior picture cut is meant to land exactly on an onset, and is what decides
    whether an off-grid cut is refused or merely reported (see the TS
    ``kernel/beat-grid/beat-alignment.ts``). Mirrors the TS ``detectBeatsSchema``.
    """

    model_config = _STRICT
    asset_id: FilterStr = Field(default=None, alias="assetId")
    sensitivity: float | None = Field(default=None, ge=0.5, le=4.0)
    hard_sync: bool | None = Field(default=None, alias="hardSync")


# `search_music`, `add_music`, `search_stock` and `add_stock` are deliberately
# ABSENT from this mirror, like `ask_user`. They execute in the Electron main
# process — the provider network, the API keys and the project media directory all
# live there — and the sidecar has no route to fall back to, because it has no
# business holding a provider connection. They are marked `hostUiOnly` on the TS
# side, and `test_tool_registry_ts_parity.py` enforces that host-only tools stay
# out of here (ADR 0139).


class SearchMediaArgs(BaseModel):
    """Full-text search over transcript/markers/asset names (plan B2.2).

    Mirrors the TS ``searchMediaSchema``. The sidecar reduces ``query`` to safe
    FTS5 terms (no MATCH-grammar injection) and returns ranked, typed hits in
    timeline seconds.
    """

    model_config = _STRICT
    query: str = Field(min_length=1)
    limit: int | None = Field(default=None, ge=1, le=100)


class SessionContextArgs(BaseModel):
    """Session-start context assembly (plan B6.3).

    Mirrors the TS ``sessionContextSchema``: no arguments — the project is
    implied by the session. Strict, so an invented parameter is rejected rather
    than silently ignored.
    """

    model_config = _STRICT


class FindSimilarArgs(BaseModel):
    """Semantic similarity search over brain embeddings (plan B3.3).

    Mirrors the TS ``findSimilarSchema``. Blended cosine + keyword ranking
    when an embeddings model is configured; honest keyword-only degrade
    otherwise (the response's ``mode`` says which).
    """

    model_config = _STRICT
    query: str = Field(min_length=1)
    limit: int | None = Field(default=None, ge=1, le=100)


class SearchVisualArgs(BaseModel):
    """Visual grounding search over on-screen content (plan MI5.1/§3.4).

    Mirrors the TS ``searchVisualSchema``. The sidecar embeds ``query``
    cross-modally, runs the vector KNN, and fuses it with caption/transcript
    recall into ranked evidence packets. Honestly degrades (available with a
    reason, no packets) when the footage is unindexed or no embedding key is set.
    """

    model_config = _STRICT
    query: str = Field(min_length=1)
    k: int | None = Field(default=None, ge=1, le=50)
    asset_ids: list[str] | None = Field(default=None, alias="assetIds")
    time_range: tuple[float, float] | None = Field(default=None, alias="timeRange")

    @model_validator(mode="after")
    def _ordered_range(self) -> SearchVisualArgs:
        if self.time_range is not None and self.time_range[0] > self.time_range[1]:
            raise ValueError("timeRange start must be <= end.")
        return self


class DescribeFootageArgs(BaseModel):
    """Time-ordered visual read of ONE asset (plan §3.5).

    Mirrors the TS ``describeFootageSchema``. The host reads the asset's scene
    captions/spans start→end over the same visual-search substrate — a "what am I
    looking at" primer — with no query to craft.
    """

    model_config = _STRICT
    asset_id: str = Field(alias="assetId")
    time_range: tuple[float, float] | None = Field(default=None, alias="timeRange")

    @model_validator(mode="after")
    def _ordered_range(self) -> DescribeFootageArgs:
        if self.time_range is not None and self.time_range[0] > self.time_range[1]:
            raise ValueError("timeRange start must be <= end.")
        return self


class IndexMediaArgs(BaseModel):
    """Trigger/await visual indexing (plan MI4.1).

    Mirrors the TS ``indexMediaSchema``. ``asset_id`` narrows the worklist (omitted
    indexes every video/image asset the brain knows); ``wait`` (default true) drives
    the paced job to completion vs. a single kick. Needs an embedding key configured.
    """

    model_config = _STRICT
    asset_id: FilterStr = Field(default=None, alias="assetId")
    wait: bool | None = None


class MapFootageArgs(BaseModel):
    """Time-ordered structural digest of the whole footage (plan FI2.1/FI3.2).

    Mirrors the TS ``mapFootageSchema``. Omitted ``asset_id`` maps every visual
    asset; ``refresh`` forces a recompute past the cached map.
    """

    model_config = _STRICT
    asset_id: FilterStr = Field(default=None, alias="assetId")
    refresh: bool | None = None


class _ChapterArg(BaseModel):
    """One chapter signal fed into ``read_edit_signals`` (mirrors the TS chapter shape)."""

    model_config = _STRICT
    t0: float
    t1: float
    title: str
    summary: str | None = None


class _HighlightArg(BaseModel):
    """One highlight signal fed into ``read_edit_signals`` (mirrors the TS highlight shape)."""

    model_config = _STRICT
    t0: float
    t1: float
    label: str
    score: float | None = None


class _SilenceArg(BaseModel):
    """One silence-gap signal fed into ``read_edit_signals``."""

    model_config = _STRICT
    start: float
    end: float


class ProposeEditsArgs(BaseModel):
    """Turn gathered footage-understanding signals into cited edit candidates (plan FI4.1).

    Mirrors the TS ``proposeEditsSchema``. Every input is optional — the caller passes
    whatever it already gathered (``map_footage`` chapters/highlights, ``analyze_silence``
    ranges, ``detect_scenes`` cuts, and whether the target is vertical); this tool is
    deterministic and never calls the engine, so it carries no ``available`` gate.
    """

    model_config = _STRICT
    chapters: list[_ChapterArg] | None = None
    highlights: list[_HighlightArg] | None = None
    silences: list[_SilenceArg] | None = None
    scene_cuts: list[float] | None = Field(default=None, alias="sceneCuts")
    vertical_target: bool | None = Field(default=None, alias="verticalTarget")


# ---------------------------------------------------------------------------
# Tool spec
# ---------------------------------------------------------------------------


class ToolSpec(BaseModel):
    """Specification of one AI-callable tool (PRD §8.3).

    ``input_model`` is the Pydantic model that validates the tool's untrusted
    arguments (the schema gate). ``input_schema`` is the JSON Schema *derived*
    from it — advertised to the model, never hand-written, so the two cannot
    drift. ``mutating`` flags whether the tool proposes a timeline patch (vs. a
    read-only query or a side-effecting action). ``available`` is False when the
    underlying engine capability does not exist yet (build-order invariant).
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    name: str
    description: str
    kind: ToolKind
    mutating: bool = Field(default=False, description="True if the tool proposes a timeline patch.")
    available: bool = Field(
        default=True, description="False when the underlying engine capability is missing."
    )
    input_model: type[BaseModel] = Field(
        default=NoArgs, description="Pydantic model validating the tool's arguments."
    )
    input_schema: dict[str, Any] = Field(
        default_factory=dict, description="JSON Schema derived from ``input_model``."
    )


def _spec(
    name: str,
    description: str,
    *,
    kind: ToolKind,
    input_model: type[BaseModel] = NoArgs,
    mutating: bool = False,
    available: bool = True,
) -> ToolSpec:
    """Build a :class:`ToolSpec`, deriving ``input_schema`` from ``input_model``.

    The JSON Schema is always derived (never hand-written) so the advertised
    schema and the validation gate are guaranteed identical.
    """
    return ToolSpec(
        name=name,
        description=description,
        kind=kind,
        mutating=mutating,
        available=available,
        input_model=input_model,
        # Derive the advertised schema; alias names are what the model sends.
        input_schema=input_model.model_json_schema(by_alias=True),
    )


# Core tool registry — names are the canonical list from PRD §8.3.
TOOL_REGISTRY: dict[str, ToolSpec] = {
    # --- Read tools (PRD §8.3) ---
    "get_project_state": _spec(
        "get_project_state",
        "Return the current editable project state without editor-only undo history. "
        "This is the live state for the active session — read it here, not from "
        "project.fp.json on disk.",
        kind="read",
    ),
    "get_timeline": _spec(
        "get_timeline", "Return the current timeline (tracks/clips).", kind="read"
    ),
    "get_transcript": _spec(
        "get_transcript",
        "Return the word-level transcript in SOURCE time — where each word sits in "
        "the original recording, NOT where it plays on the edited timeline. The two "
        "are the same only before any cut. To place captions, add markers, or "
        "reference a moment on the timeline, use get_mapped_transcript instead; never "
        "convert these timestamps yourself. Pass start/end (source seconds) to read "
        "only that window — on a long recording, read sections, not the whole thing.",
        kind="read",
        input_model=TranscriptWindowArgs,
    ),
    "get_timeline_map": _spec(
        "get_timeline_map",
        "THE authoritative source↔sequence timing for every clip: assetId, source "
        "in/out, sequence in/out, speed, track — plus the sequence duration and the "
        "timeline revision. Read this whenever you need to relate a moment in the "
        "original footage to a moment on the edit. Never compute that relationship "
        "yourself from clip durations, and never reuse a mapping you read earlier: "
        "any cut, trim, move or speed change makes it wrong, and the revision tells "
        "you it did.",
        kind="read",
    ),
    "map_time": _spec(
        "map_time",
        "Convert one timestamp between the original footage and the edited sequence. "
        "Give { sourceTime, assetId } to ask where a moment of footage ended up — the "
        "answer is a LIST, because it may have been cut (empty) or used more than "
        "once. Give { sequenceTime } to ask what plays at a moment of the edit. Use "
        "this instead of doing the arithmetic; it accounts for trims, speed, and "
        "reuse. Called with no arguments it returns the whole timeline map.",
        kind="read",
        input_model=MapTimeArgs,
    ),
    "get_mapped_transcript": _spec(
        "get_mapped_transcript",
        "The transcript as it plays on the EDITED timeline: only words that survived "
        "the cuts, each with its sequence time, its original source time, and the "
        "clip carrying it — grouped into runs that never cross a cut. This is what "
        'captions, markers, and any "quote the video at time T" answer must be '
        "built from. Words in deleted footage are gone, so anything you read here is "
        "genuinely audible.",
        kind="read",
        input_model=TranscriptWindowArgs,
    ),
    "list_edit_boundaries": _spec(
        "list_edit_boundaries",
        "Every real cut in the sequence — where one clip ends and the next begins — "
        "with the two clip ids, the sequence time, and the longest transition each "
        "can carry. A transition can only go at one of these. A narrative pivot "
        "INSIDE a continuous clip is not a boundary: split the clip there first, or "
        "the transition has nothing to happen at.",
        kind="read",
    ),
    "verify_captions": _spec(
        "verify_captions",
        "Check the caption track against the edited timeline and report what is "
        "actually wrong: cues outside the sequence, cues spanning a cut, cues over "
        "deleted speech, cues out of sync with the mapped word timings, stale cues "
        "from an older timeline revision, and retained speech with no caption. "
        "Returns { ok, cueCount, issues[] }. Run this before saying captions are "
        'done — an operation returning "applied" is not evidence that anything is '
        "synchronized.",
        kind="read",
        input_model=VerifyCaptionsArgs,
    ),
    "verify_transitions": _spec(
        "verify_transitions",
        "Read back every transition actually present in timeline state and check each "
        "sits at a real cut, references the correct adjacent clips, and has a "
        "duration the boundary can carry. Also reports boundaries you may have "
        "intended to treat but did not. Returns { ok, transitionCount, issues[] }. "
        "Run this before saying a transition was added; a command being accepted is "
        "not proof it is visible.",
        kind="read",
    ),
    "get_timeline_summary": _spec(
        "get_timeline_summary",
        "Return a compact overview of the timeline: total duration, and per track its "
        "id, type, flags, clip count, and first/last clip times — plus marker and "
        "transcript-word counts. Orient with this first on a large project; it is far "
        "cheaper than get_timeline, which dumps every clip.",
        kind="read",
    ),
    "get_clips": _spec(
        "get_clips",
        "List clips as compact rows (ids, times, source in/out, effect/keyframe "
        "counts), optionally filtered to one trackId and/or a start/end window "
        "(timeline seconds), paginated with offset/limit (default 50, max 200). "
        "Returns { clips, total, hasMore }. Use this instead of get_timeline on a "
        "long-form project; use get_clip for one clip in full detail.",
        kind="read",
        input_model=GetClipsArgs,
    ),
    "get_clip": _spec(
        "get_clip",
        "Return one clip in full detail (effects, keyframes, styling) plus its "
        "trackId. The precise deep read to pair with the compact get_clips listing.",
        kind="read",
        input_model=GetClipArgs,
    ),
    "list_assets": _spec(
        "list_assets",
        "List the media-bin assets and folders. A focused, cheaper read than "
        "get_project_state when you only need the media library — optionally filter "
        "by kind (video/audio/image) and/or folderId. Returns { assets, folders }.",
        kind="read",
        input_model=ListAssetsArgs,
    ),
    "get_selected_range": _spec(
        "get_selected_range",
        "Return the user's selected timeline range (start/end seconds), or null when "
        "nothing is selected.",
        kind="read",
    ),
    "recall_evidence": _spec(
        "recall_evidence",
        "Re-open something you already read. Every read you make this run is filed "
        "under a short handle like [ev_3] shown next to it in your action log; pass "
        "that handle to get the full result back, optionally narrowed by a word or "
        "phrase. Use this instead of re-running the read — it is free, it cannot "
        "change under you, and it returns more of the payload than the log preview "
        "shows. A query matches on any of its words, so several keywords are fine. "
        "When a result says it was truncated at N characters, call again with offset "
        "N to read on from there.",
        kind="read",
        input_model=RecallEvidenceArgs,
    ),
    "load_skill": _spec(
        "load_skill",
        "Load the full instructions of a skill from the skills manifest in your "
        "context. Call it BEFORE starting work the skill covers, then follow the "
        "returned playbook. Returns { name, description, tools, body } or the list "
        "of valid names when the skill is unknown.",
        kind="read",
        input_model=LoadSkillArgs,
    ),
    # --- Mutating tools (PRD §8.3) — each returns typed, reversible operations ---
    "trim_clip": _spec(
        "trim_clip",
        "Set a clip's new start/end in timeline seconds; the source in/out shifts by "
        "the same amount. Use to tighten or extend one clip's edges.",
        kind="mutate",
        input_model=TrimClipArgs,
        mutating=True,
    ),
    "split_clip": _spec(
        "split_clip",
        "Split a clip in two at a timeline time strictly inside the clip.",
        kind="mutate",
        input_model=SplitClipArgs,
        mutating=True,
    ),
    "delete_range": _spec(
        "delete_range",
        "Delete a timeline range (seconds) on one track, leaving a gap. Use "
        "ripple_delete instead when the gap should close.",
        kind="mutate",
        input_model=RangeOnTrackArgs,
        mutating=True,
    ),
    "delete_clip": _spec(
        "delete_clip",
        "Delete one clip by id. Set ripple: true to also close the gap it leaves "
        "(later clips on its track shift earlier). Safer than delete_range/"
        "ripple_delete when you mean a specific clip — no hand-computed times.",
        kind="mutate",
        input_model=DeleteClipArgs,
        mutating=True,
    ),
    "delete_clips": _spec(
        "delete_clips",
        "Delete several clips by id in one call (max 50). Set ripple: true to close "
        "each gap (later clips shift earlier). Use for multi-cut edits like removing "
        "every flagged clip — one call instead of many delete_clip calls.",
        kind="mutate",
        input_model=DeleteClipsArgs,
        mutating=True,
    ),
    "ripple_delete": _spec(
        "ripple_delete",
        "Delete a timeline range (seconds) on one track and close the gap — later "
        "clips shift earlier. Prefer this for cutting dead air or tightening pacing.",
        kind="mutate",
        input_model=RangeOnTrackArgs,
        mutating=True,
    ),
    "move_clip": _spec(
        "move_clip",
        "Move a clip to a track at a new timeline start time (duration unchanged).",
        kind="mutate",
        input_model=MoveClipArgs,
        mutating=True,
    ),
    "add_track": _spec(
        "add_track",
        'Create a new empty track (a "layer") to get a free lane for clips that '
        "would otherwise overlap. Clips on one track can never overlap, so this is "
        "how you stack simultaneous elements — a title over b-roll, picture-in-"
        "picture, an extra overlay, or a second audio bed — when no existing track "
        "has a free range. type is the track's advisory role "
        "(video/audio/caption/overlay): it sets the default label/icon only, not a "
        "content limit. atIndex is the z-order slot where index 0 is the visual front; "
        "omit it to add the track in front. Pass id to name the track so you can "
        "reference it as trackId in the same turn; otherwise a deterministic id is "
        "generated.",
        kind="mutate",
        input_model=AddTrackArgs,
        mutating=True,
    ),
    "remove_track": _spec(
        "remove_track",
        'Remove a track (a "layer") by id, including any clips on it. Reversible '
        "(undo restores the track with its clips), but prefer targeted clip edits — "
        "removing a populated track that holds prior work is rejected unless the "
        "user themselves asked for it.",
        kind="mutate",
        input_model=RemoveTrackArgs,
        mutating=True,
    ),
    "move_track": _spec(
        "move_track",
        "Reorder a track to a new z-order slot. toIndex 0 is the visual front "
        "(nearer the viewer); clips are untouched. Use to put an overlay above the "
        "footage it should cover, or push b-roll behind a title.",
        kind="mutate",
        input_model=MoveTrackArgs,
        mutating=True,
    ),
    "add_clip": _spec(
        "add_clip",
        "Place an existing asset on a track: start/end are timeline seconds; "
        "sourceStart picks where playback begins in the asset (default 0). The host "
        "derives the matching sourceEnd from the timeline span at 1x, so never copy an "
        "image asset's display duration into sourceEnd. Read the "
        "timeline and assets first so you use real track/asset ids, and pick a "
        "track whose range is free — clips on one track can never overlap.",
        kind="mutate",
        input_model=AddClipArgs,
        mutating=True,
    ),
    "add_text_layer": _spec(
        "add_text_layer",
        "Add a text overlay clip on a track over a timeline range (start/end seconds). "
        "Clips on one track can never overlap — stack simultaneous text elements on "
        "separate tracks with a free range.",
        kind="mutate",
        input_model=AddTextLayerArgs,
        mutating=True,
    ),
    "add_caption_layer": _spec(
        "add_caption_layer",
        "Add ONE short transcript-driven caption cue on a track over a timeline range "
        "(start/end seconds). Never use one call for a whole recording or song: first "
        "read get_mapped_transcript, then add separate readable phrase cues (normally "
        "3-7 words, never more than 12). Style the completed set track-wide.",
        kind="mutate",
        input_model=AddCaptionLayerArgs,
        mutating=True,
    ),
    "add_keyframes": _spec(
        "add_keyframes",
        "Animate a clip property (e.g. scale, opacity, x, y) with keyframes; times are "
        "seconds from the clip's start.",
        kind="mutate",
        input_model=AddKeyframesArgs,
        mutating=True,
    ),
    "punch_in": _spec(
        "punch_in",
        "Add a zoom/punch-in (animated scale) to a clip; window defaults to the whole clip.",
        kind="mutate",
        input_model=PunchInArgs,
        mutating=True,
    ),
    "apply_color_grade": _spec(
        "apply_color_grade",
        "Apply a color grade to a clip.",
        kind="mutate",
        input_model=ApplyColorGradeArgs,
        mutating=True,
    ),
    "adjust_audio": _spec(
        "adjust_audio",
        "Adjust a clip's audio gain (dB).",
        kind="mutate",
        input_model=AdjustAudioArgs,
        mutating=True,
    ),
    # --- Effect layers (schema v13, ADR 0088) ------------------------------
    "discover_caption_styles": _spec(
        "discover_caption_styles",
        "Browse the production caption design system. Returns bundled fonts with real "
        "weight ranges and matching templates. Use only returned font families and "
        "template ids so preview and export remain identical.",
        kind="read",
        input_model=DiscoverCaptionStylesArgs,
    ),
    "discover_effects": _spec(
        "discover_effects",
        "Browse the effect catalog. Search by name, tag or use case ('vhs', "
        "'teal orange', 'censor'), or filter by category. Returns each effect's id, "
        "what it looks like, and its tunable parameters WITH their real ranges and "
        "defaults. Call this before apply_effect or adjust_effect — the ids and "
        "parameter names are not guessable, and out-of-range values are rejected by "
        "the patch validator.",
        kind="read",
        input_model=DiscoverEffectsArgs,
    ),
    "discover_transitions": _spec(
        "discover_transitions",
        "Browse the transition catalog. Search by name, direction, feel or use case "
        "('left', 'fast', 'cinematic', 'social media'), or filter by category. Returns "
        "each transition's id, what it does, its default length, and the parameters it "
        "actually reads. Call this before add_transition — the ids are not guessable, "
        "and a kind this build does not know is refused outright rather than rendering "
        "as nothing.",
        kind="read",
        input_model=DiscoverTransitionsArgs,
    ),
    "apply_effect": _spec(
        "apply_effect",
        "Apply a catalog effect as its own timeline LAYER over a time range. The "
        "effect affects every visible clip beneath it for that range — it is not "
        "attached to one clip. Use discover_effects first to get a real effectId and "
        "its parameter ranges. Creates an effect track if the project has none. Omit "
        "endTime to use the effect's own default duration.",
        kind="mutate",
        input_model=ApplyEffectArgs,
        mutating=True,
    ),
    "move_effect": _spec(
        "move_effect",
        "Move an effect layer to a new start time, keeping its duration. Pass "
        "toTrackId to move it onto a different effect lane (which changes the order "
        "it combines in — lower lanes apply first).",
        kind="mutate",
        input_model=MoveEffectArgs,
        mutating=True,
    ),
    "resize_effect": _spec(
        "resize_effect",
        "Change an effect layer's in/out points — trim, extend or shorten it. Both "
        "times are absolute timeline seconds.",
        kind="mutate",
        input_model=ResizeEffectArgs,
        mutating=True,
    ),
    "adjust_effect": _spec(
        "adjust_effect",
        "Retune an applied effect. `params` is a PARTIAL patch — send only the values "
        "to change. `intensity` (0-1) is the master strength every effect honours; "
        "pass null to reset it to full. Call discover_effects for the valid parameter "
        "names and ranges of the effect's kind.",
        kind="mutate",
        input_model=AdjustEffectArgs,
        mutating=True,
    ),
    "set_effect_enabled": _spec(
        "set_effect_enabled",
        "Temporarily bypass an effect layer, or re-enable it. The layer stays on the "
        "timeline either way — use remove_effect to delete it.",
        kind="mutate",
        input_model=SetEffectEnabledArgs,
        mutating=True,
    ),
    "remove_effect": _spec(
        "remove_effect",
        "Delete an effect layer from the timeline. Reversible.",
        kind="mutate",
        input_model=RemoveEffectArgs,
        mutating=True,
    ),
    "add_transition": _spec(
        "add_transition",
        "Add a transition at the cut between two adjacent clips on the same track "
        "(fromClipId/toClipId must be neighbours).",
        kind="mutate",
        input_model=AddTransitionArgs,
        mutating=True,
    ),
    "add_mask": _spec(
        "add_mask",
        "Add a mask shape to a clip.",
        kind="mutate",
        input_model=AddMaskArgs,
        mutating=True,
    ),
    "track_object": _spec(
        "track_object",
        "Attach an object tracker to a clip.",
        kind="mutate",
        input_model=TrackObjectArgs,
        mutating=True,
    ),
    "set_track_flags": _spec(
        "set_track_flags",
        "Mute/unmute, lock/unlock, or hide/show a track (schema v4).",
        kind="mutate",
        input_model=SetTrackFlagsArgs,
        mutating=True,
    ),
    # --- Per-clip styling edits (schema v5-v8, H1.2 slices) ---
    # These surface engine capabilities that already render (caption styling,
    # time-remap, crop/reframe, blend modes) but had no AI tool, so the agent
    # could not reach them. Mirrors packages/ai-sdk/src/tool-registry.ts.
    "set_track_caption_style": _spec(
        "set_track_caption_style",
        "Set the complete shared caption composition for one track: discovered font/template, "
        "weight, scale, colors, x/y placement, rotation, width, alignment, spacing, background, "
        "shadow, animation and accent. Per-cue overrides still win. Null clears the default.",
        kind="mutate",
        input_model=SetTrackCaptionStyleArgs,
        mutating=True,
    ),
    "auto_emphasize_captions": _spec(
        "auto_emphasize_captions",
        "Apply AI-selected semantic emphasis to a caption track. Read the mapped transcript, "
        "then provide 1-12 sparse exact spoken keywords chosen for meaning, delivery and payoff. "
        "Every term is grounded against caption/transcript text. Optional style simultaneously "
        "sets font, template, x/y placement and the complete caption composition.",
        kind="mutate",
        input_model=AutoEmphasizeCaptionsArgs,
        mutating=True,
    ),
    "set_caption_style": _spec(
        "set_caption_style",
        "Override one caption cue using the complete composition surface: a discovered "
        "font/template, weight, scale, colors, x/y placement, rotation, width, alignment, "
        "spacing, background, shadow, animation and accent. Null clears the override.",
        kind="mutate",
        input_model=SetCaptionStyleArgs,
        mutating=True,
    ),
    "set_clip_speed": _spec(
        "set_clip_speed",
        "Set a clip's constant playback speed (schema v6 time-remap): 2 plays it 2x "
        "faster, 0.5 at half speed. speed: null resets to 1x. The clip's timeline length "
        "is recomputed from its (unchanged) source in/out points, so a speed-up shortens "
        "the clip and a slow-down lengthens it.",
        kind="mutate",
        input_model=SetClipSpeedArgs,
        mutating=True,
    ),
    "set_clip_crop": _spec(
        "set_clip_crop",
        "Crop/reframe a clip to a rectangle of its source frame (schema v7), given as "
        "0..1 fractions { x, y, width, height } from the top-left corner. crop: null "
        "clears the crop back to the full frame. Use it to reframe 16:9 footage into a "
        "9:16 subject-centered crop.",
        kind="mutate",
        input_model=SetClipCropArgs,
        mutating=True,
    ),
    "set_clip_blend_mode": _spec(
        "set_clip_blend_mode",
        "Set how a clip composites over the layers beneath it (schema v8): e.g. "
        "'screen', 'multiply', 'overlay', 'soft-light'. blendMode: null resets to "
        "'normal'. Meaningful for overlay-track clips (light leaks, textures, glows).",
        kind="mutate",
        input_model=SetClipBlendModeArgs,
        mutating=True,
    ),
    "transcribe": _spec(
        "transcribe",
        "Transcribe an audio or video asset with the configured speech-to-text "
        "provider. The trusted host produces timestamps and writes a reversible "
        "set_transcript patch; the model never supplies transcript words.",
        kind="analysis",
        input_model=TranscribeArgs,
        mutating=False,
    ),
    # --- Project (media-bin) mutating tools — assets & folders (schema v3) ---
    "add_asset": _spec(
        "add_asset",
        "Add a media asset to the project bin (e.g. AI-generated media).",
        kind="mutate",
        input_model=AddAssetArgs,
        mutating=True,
    ),
    "manage_assets": _spec(
        "manage_assets",
        "Organize the media bin into folders (semantic plan or by-kind).",
        kind="mutate",
        input_model=ManageAssetsArgs,
        mutating=True,
    ),
    # --- Markers / chapters (schema v9, H1.2 slice) ---
    # Project-scoped timeline landmarks (a bare marker) or named "chapter" points
    # (a marker with a label). Mirrors packages/ai-sdk/src/tool-registry.ts.
    "add_marker": _spec(
        "add_marker",
        "Add a marker (or named 'chapter' point) at a position on the project timeline "
        "(schema v9). Give a time in seconds, an optional label to promote it to a "
        "chapter, and an optional CSS color for the scrub-bar. A deterministic id is "
        "derived from time+label when none is supplied.",
        kind="mutate",
        input_model=AddMarkerArgs,
        mutating=True,
    ),
    "remove_marker": _spec(
        "remove_marker",
        "Remove a marker/chapter by id (schema v9).",
        kind="mutate",
        input_model=RemoveMarkerArgs,
        mutating=True,
    ),
    # --- Action tools (PRD §8.3) — host-executed side effects, no patch ---
    "render_preview": _spec("render_preview", "Render a fast low-res preview.", kind="action"),
    "export_video": _spec("export_video", "Render the final export video.", kind="action"),
    # --- Analysis tools (PRD §8.3) — ffmpeg-backed, host-executed, return data ---
    "analyze_silence": _spec(
        "analyze_silence",
        "Detect silent ranges in an asset's audio (ffmpeg silencedetect). Returns "
        "start/end/duration for each gap; does not edit the timeline.",
        kind="analysis",
        input_model=AnalyzeSilenceArgs,
    ),
    "detect_scenes": _spec(
        "detect_scenes",
        "Detect scene-cut timestamps in an asset's video (ffmpeg scene score). "
        "Returns cut times; does not edit the timeline.",
        kind="analysis",
        input_model=DetectScenesArgs,
    ),
    "detect_beats": _spec(
        "detect_beats",
        "Detect musical beat/onset timestamps in an asset's audio (energy-flux onset "
        "detection) plus an estimated BPM. Use for beat-synced montage cuts. Returns "
        "beat times in seconds; does not edit the timeline. Needs an asset that has an "
        "audio track — silent footage has no beats, so pass the music asset's id.",
        kind="analysis",
        input_model=DetectBeatsArgs,
    ),
    "get_frame": _spec(
        "get_frame",
        "LOOK at the edit: render one frame of the timeline at a given time and see it as "
        "an image. Use it to CHECK your own work visually — caption placement and "
        "legibility, framing after a punch-in or reframe, whether a title collides with "
        "the footage, whether a grade reads as intended. Prefer it over guessing from "
        "numbers whenever the question is about how something LOOKS. It renders through "
        "the same engine as the final export, so what you see is what will be delivered. "
        "One frame per call, and each costs real context — grab the few moments that "
        "actually settle the question, not a sweep of the timeline.",
        kind="analysis",
        input_model=GetFrameArgs,
    ),
    "search_media": _spec(
        "search_media",
        "Full-text search over the transcript, markers, and asset names — use for "
        '"find where I said X" instead of reading the whole transcript. Returns ranked '
        "hits { type, assetId?, markerId?, start, end, snippet, score } with times in "
        "timeline seconds (asset hits add clip placements); does not edit the timeline.",
        kind="analysis",
        input_model=SearchMediaArgs,
    ),
    "find_similar": _spec(
        "find_similar",
        "Semantic similarity search over the project's media — use for \"find moments "
        'like X" / "shots similar to this" where exact words may differ. Returns ranked '
        "hits like search_media; blends meaning-based and keyword matches when an "
        "embeddings model is configured, and honestly degrades to keyword-only when "
        "not (the result says which). Does not edit the timeline.",
        kind="analysis",
        input_model=FindSimilarArgs,
    ),
    # --- Visual grounding (plan MI5/§3.4) — see what is on screen ---
    "search_visual": _spec(
        "search_visual",
        "Search what is actually ON SCREEN across the footage — the primary way to GROUND "
        'any content-dependent edit ("cut to the product shot", "where does the whiteboard '
        'appear"). Retrieves ranked evidence packets { assetId, t0, t1 (asset seconds), '
        "sceneId, score, caption, transcriptOverlap, sources } fusing visual-vector, "
        "caption, and transcript recall. Prefer this over guessing from dialogue: read the "
        "captions/spans and cite them. Honestly degrades (available with a reason, no "
        "packets) when the footage is not indexed or no embedding key is set. Optional k "
        "(1-50), assetIds, and timeRange narrow recall. Does not edit the timeline.",
        kind="analysis",
        input_model=SearchVisualArgs,
    ),
    "describe_footage": _spec(
        "describe_footage",
        "Walk ONE asset in time order — its scene captions and spans from start to end — "
        'the "what am I looking at" primer before you plan cuts on it. Returns the same '
        "evidence packets as search_visual, sorted by time rather than ranked by a query. "
        "Use search_visual instead when you are looking for a specific thing across all "
        "footage. Optional timeRange limits the walk. Honestly reports when the asset is "
        "not indexed yet. Does not edit the timeline.",
        kind="analysis",
        input_model=DescribeFootageArgs,
    ),
    "index_media": _spec(
        "index_media",
        "Build (or finish) the visual index so search_visual and describe_footage can see "
        "the footage: samples frames, embeds them, and captions scenes. Call it when a "
        "visual search reports the footage is not indexed yet. By default it waits until "
        "indexing is complete (wait: false returns after starting); assetId indexes just "
        "that asset, omitted indexes every video/image the project knows. Needs an "
        "embedding key configured — reports honestly when none is set. Does not edit the "
        "timeline.",
        kind="analysis",
        input_model=IndexMediaArgs,
    ),
    "map_footage": _spec(
        "map_footage",
        "Map the WHOLE footage with no query — the FIRST move on unfamiliar or long "
        "material before you plan any edit. Returns a time-ordered digest "
        "{ chapters: [{ t0, t1, title, summary }], highlights: [{ t0, t1, label, score }], "
        "summary, durationSec } in timeline seconds, so you can see the story shape at a "
        "glance and decide where to cut, tighten, punch in, or reframe. Then drill into a "
        "chapter with describe_footage / search_visual. Optional assetId maps just one "
        "asset; refresh recomputes past the cache. Honestly reports when the footage is not "
        "indexed yet or generative understanding is unavailable. Does not edit the timeline.",
        kind="analysis",
        input_model=MapFootageArgs,
    ),
    "read_edit_signals": _spec(
        "read_edit_signals",
        "Describe what is measurably THERE across a stretch of the edit — the facts a move "
        "should be chosen from, never the move itself. Pass the signals you have already "
        "gathered (map_footage chapters/highlights, analyze_silence ranges, detect_scenes "
        "cuts); returns them in TIME order as [{ kind: highlight|chapter|silence|emphasis|"
        "scene_change, t0, t1, observation, from }] in timeline seconds, with each chapter's "
        "shape (length, highlights inside, words spoken) and each silence long enough to "
        "notice. Transcript emphasis is measured from the project for you. `from` says "
        "whether a signal was supplied by you or measured here — a chapter you did not read "
        "from the footage is still only your own claim. WHICH move each observation deserves "
        "— a punch-in, a reframe, a ramp, a cut, nothing at all — is your judgement, and this "
        "tool deliberately does not rank or recommend. Does not edit the timeline.",
        kind="read",
        input_model=ProposeEditsArgs,
    ),
    "session_context": _spec(
        "session_context",
        "Read what's already known about this project before doing anything else: the "
        "media bin digest, what happened in the last session, the edits this user "
        "rejected (do not repeat them) and accepted, plus their cross-project working "
        "style. Use at the start of a session, or when you need to know what the user "
        "has already told us. Does not edit the timeline.",
        kind="analysis",
        input_model=SessionContextArgs,
    ),
    # --- Not-yet-available tools (engine TBD; build-order invariant) ---
    # detect_faces was superseded by the pack-backed `detect_subjects` on the TS
    # side (2026-08); detection is desktop-host-only and stays off this surface.
    "generate_mask": _spec(
        "generate_mask",
        "Generate a subject mask (unavailable — segmentation produces bitmap masks, "
        "and timeline masks steer by rectangle bounds). The measured alternative on "
        "the desktop host is track_subject_automatically with subject=silhouette.",
        kind="unavailable",
        mutating=True,
        available=False,
    ),
}


def get_tool(name: str) -> ToolSpec | None:
    """Look up a tool spec by name, or ``None`` if not registered."""
    tool = TOOL_REGISTRY.get(name)
    if tool is None:
        _log.warning("get_tool: lookup missed for %r", name)
    return tool
