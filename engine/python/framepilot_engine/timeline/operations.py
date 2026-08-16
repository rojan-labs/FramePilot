"""Typed, reversible timeline operations (PLAN §1.2, PRD §8.3).

WHY: every edit — human or AI — is one of these typed operations, never a raw
mutation. This module is the **Python mirror** of the TS ``@framepilot/editor-core``
operations (the source of truth), so the render engine and the editor share one
operation semantics. :func:`apply_operation` is a pure transform returning a new
immutable timeline; :func:`invert_operation` returns the operation(s) that undo it.

Reversibility design (mirrors ADR 0006): most operations are confined to a single
track, so their inverse is a lossless snapshot-restore of that track's clip list —
the internal :class:`RestoreClips`. ``trim_clip``/``move_clip`` and the
whole-value setters (``set_track_flags``, ``set_caption_style``, ``set_clip_speed``,
``set_clip_crop``, ``set_clip_blend_mode``, ``move_layer``) keep a readable
same-shape inverse because it is exact and small; the layer ops invert to each
other (``add_layer`` ⇄ ``remove_layer``, carrying type/z-order/clips); everything
else inverts to ``restore_clips``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated, Any, Literal, NamedTuple, cast

from pydantic import BaseModel, Field

from framepilot_engine.timeline.models import (
    BlendMode,
    CaptionStyle,
    Clip,
    CropRect,
    Effect,
    Keyframe,
    Timeline,
    Track,
    TrackType,
)
from framepilot_engine.timeline.transition_policy import transition_eligibility

# Floating-point slack for time comparisons (mirrors the TS EPSILON).
_EPSILON = 1e-9

# Effect types apply_color_grade is allowed to attach (mirrors TS).
SUPPORTED_COLOR_GRADE_EFFECTS = ("color_grade", "lut", "transform")

# Synthetic asset ids for clips that have no media source (mirrors TS).
TEXT_OVERLAY_ASSET_ID = "__text__"
CAPTION_ASSET_ID = "__caption__"


class _Operation(BaseModel):
    """Base for all operations. Subclasses set a literal ``type``."""

    model_config = {"populate_by_name": True}


class TrimClip(_Operation):
    """Adjust a clip's in/out 1:1 without moving neighbours."""

    type: Literal["trim_clip"] = "trim_clip"
    clip_id: str = Field(alias="clipId")
    start: float
    end: float


class SetClipSourceRange(_Operation):
    """Replace a clip's source in/out without moving its sequence boundaries."""

    type: Literal["set_clip_source_range"] = "set_clip_source_range"
    clip_id: str = Field(alias="clipId")
    source_start: float = Field(alias="sourceStart")
    source_end: float = Field(alias="sourceEnd")


class SetClipMedia(_Operation):
    """Replace media/source while preserving the clip's edit state and position."""

    type: Literal["set_clip_media"] = "set_clip_media"
    clip_id: str = Field(alias="clipId")
    asset_id: str = Field(alias="assetId")
    source_start: float = Field(alias="sourceStart")
    source_end: float = Field(alias="sourceEnd")


class SplitClip(_Operation):
    """Split one clip into two at ``at`` (timeline seconds)."""

    type: Literal["split_clip"] = "split_clip"
    clip_id: str = Field(alias="clipId")
    at: float


class DeleteRange(_Operation):
    """Delete a time range on a track, leaving a gap."""

    type: Literal["delete_range"] = "delete_range"
    track_id: str = Field(alias="trackId")
    start: float
    end: float


class MoveClip(_Operation):
    """Move a clip to a new track/position."""

    type: Literal["move_clip"] = "move_clip"
    clip_id: str = Field(alias="clipId")
    to_track_id: str = Field(alias="toTrackId")
    to_start: float = Field(alias="toStart")


class RippleDelete(_Operation):
    """Delete a range and pull later clips left to close the gap."""

    type: Literal["ripple_delete"] = "ripple_delete"
    track_id: str = Field(alias="trackId")
    start: float
    end: float


class AddClip(_Operation):
    """Add a new clip from an asset onto a track."""

    type: Literal["add_clip"] = "add_clip"
    track_id: str = Field(alias="trackId")
    asset_id: str = Field(alias="assetId")
    start: float
    end: float
    source_start: float = Field(alias="sourceStart")
    source_end: float = Field(alias="sourceEnd")
    clip_id: str | None = Field(default=None, alias="clipId")


class AddTextOverlay(_Operation):
    """Add a text overlay element (PRD §6.1/§6.6)."""

    type: Literal["add_text_overlay"] = "add_text_overlay"
    track_id: str = Field(alias="trackId")
    text: str
    start: float
    end: float
    clip_id: str | None = Field(default=None, alias="clipId")


class AddCaptionLayer(_Operation):
    """Add a caption clip from a transcript (PRD §6.2)."""

    type: Literal["add_caption_layer"] = "add_caption_layer"
    track_id: str = Field(alias="trackId")
    start: float
    end: float
    clip_id: str | None = Field(default=None, alias="clipId")


class AddKeyframes(_Operation):
    """Append keyframes to a clip (PRD §6.3)."""

    type: Literal["add_keyframes"] = "add_keyframes"
    clip_id: str = Field(alias="clipId")
    keyframes: list[Keyframe] = Field(default_factory=list)
    #: Replace an existing keyframe with the same property at the same time
    #: (±1ms) instead of stacking a duplicate (mirrors TS; H4 transform controls).
    replace: bool = False


class RemoveKeyframeTarget(BaseModel):
    """One keyframe to remove: a property, and optionally a specific time.

    Matched by **property + time**, not by ``id``: ids are generated by whatever
    built the keyframe and are not a stable handle a UI can rely on, whereas
    property-and-time is what a user points at when they click a diamond. A target
    with no ``time`` clears the property entirely.
    """

    model_config = {"populate_by_name": True}

    property: str
    time: float | None = None


class RemoveKeyframes(_Operation):
    """Remove keyframes from a clip (revamp Phase 5a).

    Mirrors the TS ``remove_keyframes``. ``add_keyframes`` with ``replace`` only
    swaps a keyframe at the same property AND time, so it can neither delete one nor
    move one (a move is a delete plus an add) — hence this op.
    """

    type: Literal["remove_keyframes"] = "remove_keyframes"
    clip_id: str = Field(alias="clipId")
    targets: list[RemoveKeyframeTarget] = Field(default_factory=list)


class ApplyColorGrade(_Operation):
    """Attach a color-grade effect to a clip (PRD §6.7)."""

    type: Literal["apply_color_grade"] = "apply_color_grade"
    clip_id: str = Field(alias="clipId")
    effect: Effect


class AudioEqBand(BaseModel):
    """One band of a clip's corrective EQ (mirrors TS ``AudioEqBand``)."""

    model_config = {"populate_by_name": True}
    kind: Literal["low-shelf", "peaking", "high-shelf", "high-pass", "low-pass"]
    frequency_hz: float = Field(alias="frequencyHz")
    gain_db: float | None = Field(default=None, alias="gainDb")
    q: float | None = None


class AudioEq(BaseModel):
    """A clip's whole EQ curve. Present replaces it outright; absent leaves it alone."""

    model_config = {"populate_by_name": True}
    bands: list[AudioEqBand]


class AudioDynamics(BaseModel):
    """A clip's compressor settings (mirrors TS ``AudioDynamicsSettings``)."""

    model_config = {"populate_by_name": True}
    threshold_db: float = Field(alias="thresholdDb")
    ratio: float
    attack_ms: float = Field(alias="attackMs")
    release_ms: float = Field(alias="releaseMs")
    makeup_gain_db: float | None = Field(default=None, alias="makeupGainDb")


class AudioAutomationPoint(BaseModel):
    """One authored point on a clip audio automation lane."""

    model_config = {"populate_by_name": True}
    time_seconds: float = Field(alias="timeSeconds")
    value: float
    easing: str | None = None


class AudioAutomation(BaseModel):
    """A clip audio automation lane. An empty ``points`` list clears it."""

    model_config = {"populate_by_name": True}
    property: Literal["gainDb"]
    points: list[AudioAutomationPoint]


class AdjustAudio(_Operation):
    """Set an audio gain (dB) effect on a clip (PRD §6.8).

    Also carries the rest of the clip's channel strip — EQ, compression, and a
    gain automation lane — because they live on the same canonical ``audio_gain``
    effect and a partial write would drop whichever half it did not mention.
    """

    type: Literal["adjust_audio"] = "adjust_audio"
    clip_id: str = Field(alias="clipId")
    gain_db: float = Field(alias="gainDb")
    fade_in_seconds: float | None = Field(default=None, alias="fadeInSeconds")
    fade_out_seconds: float | None = Field(default=None, alias="fadeOutSeconds")
    fade_curve: Literal["linear", "equal-power", "smooth"] | None = Field(
        default=None, alias="fadeCurve"
    )
    muted: bool | None = None
    normalize: bool | None = None
    duck_under_track_id: str | None = Field(default=None, alias="duckUnderTrackId")
    duck_amount_db: float | None = Field(default=None, alias="duckAmountDb")
    eq: AudioEq | None = None
    dynamics: AudioDynamics | None = None
    automation: AudioAutomation | None = None


class AddTransition(_Operation):
    """Add a catalog transition between two adjacent clips (PRD §6.9).

    ``kind`` is the catalog id. The generated catalog evolves as data, so Python
    intentionally accepts a string here just like editor-core and leaves catalog
    membership to the AI/catalog boundary. Timeline geometry is enforced by the
    canonical transition policy when the operation is applied.
    """

    type: Literal["add_transition"] = "add_transition"
    track_id: str = Field(alias="trackId")
    from_clip_id: str = Field(alias="fromClipId")
    to_clip_id: str = Field(alias="toClipId")
    kind: str
    duration_seconds: float = Field(alias="durationSeconds")


class MaskBounds(BaseModel):
    """Axis-aligned mask bounds, as fractions (0..1) of the clip frame."""

    model_config = {"populate_by_name": True}
    x: float = 0.0
    y: float = 0.0
    width: float = 1.0
    height: float = 1.0


class AddMask(_Operation):
    """Add a mask to a clip (PRD §6.5).

    Geometry (``bounds``/``points``/``feather``/``opacity``/``invert``) is stored
    on the mask effect's free-form ``params`` (no schema change); ``keyframes`` are
    attached to the effect to animate the mask over time. Mirrors the TS
    ``AddMaskOp``.
    """

    type: Literal["add_mask"] = "add_mask"
    clip_id: str = Field(alias="clipId")
    shape: Literal["rectangle", "ellipse", "polygon"]
    bounds: MaskBounds | None = None
    points: list[tuple[float, float]] | None = None
    feather: float | None = None
    opacity: float | None = None
    invert: bool | None = None
    keyframes: list[Keyframe] | None = None


class TrackObject(_Operation):
    """Attach an object/face tracker to a clip (PRD §6.4).

    ``target='object'`` tracks any user-picked region (``region``); ``engine``
    names the tracker that produced/will produce it; ``keyframes`` carry the
    per-frame bounding box (x/y/width/height over clip time). Mirrors the TS
    ``TrackObjectOp``.
    """

    type: Literal["track_object"] = "track_object"
    clip_id: str = Field(alias="clipId")
    target: Literal["face", "bounding_box", "object"]
    region: MaskBounds | None = None
    engine: str | None = None
    keyframes: list[Keyframe] | None = None


class SetTrackFlags(_Operation):
    """Set a track's editing/render flags (schema v4). Mirrors the TS ``SetTrackFlagsOp``.

    Only provided flags change; omitted flags are left as-is. Operates on track
    metadata (not clips), so its inverse is a same-shape ``set_track_flags``
    carrying the flags' prior values.
    """

    type: Literal["set_track_flags"] = "set_track_flags"
    track_id: str = Field(alias="trackId")
    locked: bool | None = None
    hidden: bool | None = None
    muted: bool | None = None


class SetEffectParams(_Operation):
    """Shallow-merge ``params`` into an existing effect on a clip.

    A key set to ``None`` clears it; id/type/keyframes are untouched. Mirrors the
    TS ``SetEffectParamsOp`` (which clears on ``undefined`` — JSON has no
    ``undefined``, so ``null`` is the cross-language "clear this key" marker).
    Inverse: the standard track snapshot restore.
    """

    type: Literal["set_effect_params"] = "set_effect_params"
    clip_id: str = Field(alias="clipId")
    effect_id: str = Field(alias="effectId")
    params: dict[str, Any] = Field(default_factory=dict)


class SetCaptionStyle(_Operation):
    """Set or clear a clip's rich caption style (schema v5). Mirrors ``SetCaptionStyleOp``.

    ``caption_style=None`` clears back to unstyled; a value replaces wholesale
    (never merged), so the same-shape inverse carries the clip's prior style.
    """

    type: Literal["set_caption_style"] = "set_caption_style"
    clip_id: str = Field(alias="clipId")
    caption_style: CaptionStyle | None = Field(alias="captionStyle")


class SetClipSpeed(_Operation):
    """Set (or reset with ``None``) a clip's constant playback rate (schema v6).

    Mirrors ``SetClipSpeedOp``: the asset range is unchanged; the timeline ``end``
    is recomputed so ``end - start == (source_end - source_start) / speed``.
    """

    type: Literal["set_clip_speed"] = "set_clip_speed"
    clip_id: str = Field(alias="clipId")
    speed: float | None


class SetClipCrop(_Operation):
    """Set or clear a clip's crop rect (schema v7). Mirrors ``SetClipCropOp``."""

    type: Literal["set_clip_crop"] = "set_clip_crop"
    clip_id: str = Field(alias="clipId")
    crop: CropRect | None


class SetClipBlendMode(_Operation):
    """Set or clear a clip's compositing blend mode (schema v8). Mirrors ``SetClipBlendModeOp``."""

    type: Literal["set_clip_blend_mode"] = "set_clip_blend_mode"
    clip_id: str = Field(alias="clipId")
    blend_mode: BlendMode | None = Field(alias="blendMode")


class AddLayer(_Operation):
    """Insert a new track/layer at a z-order slot (Phase 2). Mirrors ``AddLayerOp``.

    ``at_index`` 0 is the visual front; out-of-range indexes clamp to an edge.
    ``clips`` exists so ``remove_layer``'s inverse can restore a populated layer.
    """

    type: Literal["add_layer"] = "add_layer"
    layer_id: str = Field(alias="layerId")
    layer_type: TrackType = Field(alias="layerType")
    at_index: int = Field(alias="atIndex")
    clips: list[Clip] | None = None


class RemoveLayer(_Operation):
    """Remove a layer by id (lossless: inverse restores type, z-order, and clips)."""

    type: Literal["remove_layer"] = "remove_layer"
    layer_id: str = Field(alias="layerId")


class MoveLayer(_Operation):
    """Reorder a layer to a new z-order slot; clips are never touched."""

    type: Literal["move_layer"] = "move_layer"
    layer_id: str = Field(alias="layerId")
    to_index: int = Field(alias="toIndex")


class RestoreClips(_Operation):
    """Internal inverse primitive: replace a track's whole clip list with a snapshot."""

    type: Literal["restore_clips"] = "restore_clips"
    track_id: str = Field(alias="trackId")
    clips: list[Clip] = Field(default_factory=list)


# Discriminated union over ``type`` — the canonical operation type (PRD §8.4).
Operation = Annotated[
    TrimClip
    | SetClipSourceRange
    | SetClipMedia
    | SplitClip
    | DeleteRange
    | MoveClip
    | RippleDelete
    | AddClip
    | AddTextOverlay
    | AddCaptionLayer
    | AddKeyframes
    | RemoveKeyframes
    | ApplyColorGrade
    | AdjustAudio
    | AddTransition
    | AddMask
    | TrackObject
    | SetTrackFlags
    | SetEffectParams
    | SetCaptionStyle
    | SetClipSpeed
    | SetClipCrop
    | SetClipBlendMode
    | AddLayer
    | RemoveLayer
    | MoveLayer
    | RestoreClips,
    Field(discriminator="type"),
]

_OperationCode = Literal[
    "missing_clip",
    "missing_track",
    "missing_effect",
    "invalid_range",
    "invalid_split",
    "invalid_transition",
    "duplicate_clip",
    "duplicate_layer",
    "invalid_speed",
    "broken_audio_link",
]


class OperationError(Exception):
    """Raised by :func:`apply_operation` when an op cannot be applied.

    The patch validator (PRD §8.5) is the gate that prevents these from reaching
    apply; this is the defensive last line. ``code`` mirrors the TS union.
    """

    def __init__(self, code: _OperationCode, message: str) -> None:
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class _ClipLocation(NamedTuple):
    track: Track
    track_index: int
    clip: Clip
    clip_index: int


def _clone_clip(clip: Clip) -> Clip:
    """Deep copy a clip so the result never aliases the input."""
    return clip.model_copy(deep=True)


def _find_track(timeline: Timeline, track_id: str) -> tuple[Track, int]:
    for index, track in enumerate(timeline.tracks):
        if track.id == track_id:
            return track, index
    raise OperationError("missing_track", f"Track not found: {track_id}")


def _find_clip(timeline: Timeline, clip_id: str) -> _ClipLocation:
    for track_index, track in enumerate(timeline.tracks):
        for clip_index, clip in enumerate(track.clips):
            if clip.id == clip_id:
                return _ClipLocation(track, track_index, clip, clip_index)
    raise OperationError("missing_clip", f"Clip not found: {clip_id}")


def _with_track_clips(timeline: Timeline, track_index: int, clips: list[Clip]) -> Timeline:
    """Return a new timeline with ``track_index``'s clip list replaced."""
    tracks = list(timeline.tracks)
    tracks[track_index] = tracks[track_index].model_copy(update={"clips": list(clips)})
    return timeline.model_copy(update={"tracks": tracks})


def _sort_by_start(clips: list[Clip]) -> list[Clip]:
    return sorted(clips, key=lambda c: c.start)


def _derive_clip_id(prefix: str, *parts: str | float) -> str:
    """Deterministic clip id for ops that create clips without an explicit id."""
    rendered = [str(round(p * 1000)) if isinstance(p, (int, float)) else str(p) for p in parts]
    return f"{prefix}__{'_'.join(rendered)}"


def _assert_positive_range(start: float, end: float, label: str) -> None:
    if end - start <= _EPSILON:
        raise OperationError(
            "invalid_range", f"{label}: end must be greater than start ({start} -> {end})"
        )


def _replace_clip_at(timeline: Timeline, loc: _ClipLocation, next_clip: Clip) -> Timeline:
    clips = list(loc.track.clips)
    clips[loc.clip_index] = next_clip
    return _with_track_clips(timeline, loc.track_index, clips)


def _truncate_clip(clip: Clip, new_start: float, new_end: float, clip_id: str) -> Clip:
    """A clip spanning [new_start, new_end) with source re-mapped 1:1."""
    d_start = new_start - clip.start
    d_end = new_end - clip.end
    return _clone_clip(clip).model_copy(
        update={
            "id": clip_id,
            "start": new_start,
            "end": new_end,
            "source_start": clip.source_start + d_start,
            "source_end": (clip.source_end + d_end) if clip.source_end is not None else None,
        }
    )


def _subtract_range(clip: Clip, start: float, end: float) -> list[Clip]:
    """Remove timeline range [start, end) from a clip, returning 0-2 clips."""
    overlaps = clip.start < end - _EPSILON and clip.end > start + _EPSILON
    if not overlaps:
        return [clip]
    pieces: list[Clip] = []
    if clip.start < start - _EPSILON:
        pieces.append(_truncate_clip(clip, clip.start, start, f"{clip.id}__l"))
    if clip.end > end + _EPSILON:
        right_id = f"{clip.id}__r" if pieces else clip.id
        pieces.append(_truncate_clip(clip, end, clip.end, right_id))
    return pieces


def _insert_clip(timeline: Timeline, track_id: str, clip: Clip) -> Timeline:
    track, index = _find_track(timeline, track_id)
    if any(c.id == clip.id for c in track.clips):
        raise OperationError(
            "duplicate_clip", f"Clip id already exists on track {track_id}: {clip.id}"
        )
    return _with_track_clips(timeline, index, _sort_by_start([*track.clips, clip]))


# ---------------------------------------------------------------------------
# apply
# ---------------------------------------------------------------------------


def apply_operation(timeline: Timeline, operation: Operation) -> Timeline:
    """Apply ``operation`` to ``timeline``, returning a new immutable timeline.

    The input timeline is never mutated.

    :param timeline: The timeline to transform.
    :param operation: The operation to apply.
    :returns: A new :class:`Timeline`.
    :raises OperationError: If the op references missing entities or would
        produce an invalid timeline.
    """
    handler = _APPLY[operation.type]
    return handler(timeline, operation)


def _apply_trim(timeline: Timeline, op: TrimClip) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    if op.end - op.start <= _EPSILON:
        raise OperationError(
            "invalid_range", f"trim_clip would give non-positive duration on {op.clip_id}"
        )
    clip = loc.clip
    # Move source in/out by the same delta as the timeline edges (1:1 speed).
    source_end = clip.source_end if clip.source_end is not None else clip.end - clip.start
    new_source_start = clip.source_start + (op.start - clip.start)
    new_source_end = source_end + (op.end - clip.end)
    if new_source_start < -_EPSILON or new_source_end - new_source_start <= _EPSILON:
        raise OperationError(
            "invalid_range", f"trim_clip produces invalid source range on {op.clip_id}"
        )
    next_clip = clip.model_copy(
        update={
            "start": op.start,
            "end": op.end,
            "source_start": new_source_start,
            "source_end": new_source_end,
        }
    )
    return _replace_clip_at(timeline, loc, next_clip)


def _apply_set_clip_source_range(timeline: Timeline, op: SetClipSourceRange) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    if op.source_start < -_EPSILON or op.source_end - op.source_start <= _EPSILON:
        raise OperationError(
            "invalid_range",
            f"set_clip_source_range produces invalid source range on {op.clip_id}",
        )
    clip = loc.clip
    speed = clip.speed if clip.speed is not None else 1.0
    if speed != 0:
        implied_duration = (op.source_end - op.source_start) / abs(speed)
        if abs(implied_duration - (clip.end - clip.start)) > 1e-6:
            raise OperationError(
                "invalid_range",
                f"set_clip_source_range would change the duration implied by {op.clip_id}'s speed",
            )
    return _replace_clip_at(
        timeline,
        loc,
        clip.model_copy(update={"source_start": op.source_start, "source_end": op.source_end}),
    )


def _apply_set_clip_media(timeline: Timeline, op: SetClipMedia) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    if not op.asset_id or op.source_start < -_EPSILON or op.source_end <= op.source_start:
        raise OperationError("invalid_range", f"set_clip_media is invalid for {op.clip_id}")
    clip = loc.clip
    speed = clip.speed if clip.speed is not None else 1.0
    if speed != 0:
        implied_duration = (op.source_end - op.source_start) / abs(speed)
        if abs(implied_duration - (clip.end - clip.start)) > 1e-6:
            raise OperationError(
                "invalid_range",
                f"set_clip_media would change the duration implied by {op.clip_id}'s speed",
            )
    return _replace_clip_at(
        timeline,
        loc,
        clip.model_copy(
            update={
                "asset_id": op.asset_id,
                "source_start": op.source_start,
                "source_end": op.source_end,
            }
        ),
    )


def _apply_split(timeline: Timeline, op: SplitClip) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    clip = loc.clip
    if op.at <= clip.start + _EPSILON or op.at >= clip.end - _EPSILON:
        raise OperationError(
            "invalid_split", f"split point {op.at} is not strictly inside clip {op.clip_id}"
        )
    source_end = clip.source_end if clip.source_end is not None else clip.end - clip.start
    fraction = (op.at - clip.start) / (clip.end - clip.start)
    source_at = clip.source_start + fraction * (source_end - clip.source_start)
    offset = op.at - clip.start

    left_keyframes = [
        k.model_copy(deep=True) for k in clip.keyframes if k.time <= offset + _EPSILON
    ]
    right_keyframes = [
        k.model_copy(deep=True, update={"time": k.time - offset})
        for k in clip.keyframes
        if k.time > offset + _EPSILON
    ]

    left = _clone_clip(clip).model_copy(
        update={"end": op.at, "source_end": source_at, "keyframes": left_keyframes}
    )
    right = _clone_clip(clip).model_copy(
        update={
            "id": _derive_clip_id(clip.id, "split", op.at),
            "start": op.at,
            "source_start": source_at,
            "keyframes": right_keyframes,
        }
    )
    clips = list(loc.track.clips)
    clips[loc.clip_index : loc.clip_index + 1] = [left, right]
    return _with_track_clips(timeline, loc.track_index, clips)


def _apply_delete_range(timeline: Timeline, op: DeleteRange) -> Timeline:
    _assert_positive_range(op.start, op.end, "delete_range")
    track, index = _find_track(timeline, op.track_id)
    next_clips: list[Clip] = []
    for clip in track.clips:
        next_clips.extend(_subtract_range(clip, op.start, op.end))
    return _with_track_clips(timeline, index, next_clips)


def _apply_ripple_delete(timeline: Timeline, op: RippleDelete) -> Timeline:
    _assert_positive_range(op.start, op.end, "ripple_delete")
    track, index = _find_track(timeline, op.track_id)
    gap = op.end - op.start
    trimmed: list[Clip] = []
    for clip in track.clips:
        trimmed.extend(_subtract_range(clip, op.start, op.end))
    shifted = [
        clip.model_copy(update={"start": clip.start - gap, "end": clip.end - gap})
        if clip.start >= op.end - _EPSILON
        else clip
        for clip in trimmed
    ]
    return _with_track_clips(timeline, index, _sort_by_start(shifted))


def _apply_move(timeline: Timeline, op: MoveClip) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    _, dest_index = _find_track(timeline, op.to_track_id)
    duration = loc.clip.end - loc.clip.start
    moved = _clone_clip(loc.clip).model_copy(
        update={"track_id": op.to_track_id, "start": op.to_start, "end": op.to_start + duration}
    )
    after_removal = _with_track_clips(
        timeline, loc.track_index, [c for c in loc.track.clips if c.id != op.clip_id]
    )
    dest_clips = after_removal.tracks[dest_index].clips
    return _with_track_clips(after_removal, dest_index, _sort_by_start([*dest_clips, moved]))


def _apply_add_clip(timeline: Timeline, op: AddClip) -> Timeline:
    _assert_positive_range(op.start, op.end, "add_clip")
    _assert_positive_range(op.source_start, op.source_end, "add_clip source")
    clip_id = op.clip_id or _derive_clip_id("clip", op.track_id, op.asset_id, op.start)
    clip = Clip(
        id=clip_id,
        asset_id=op.asset_id,
        track_id=op.track_id,
        start=op.start,
        end=op.end,
        source_start=op.source_start,
        source_end=op.source_end,
    )
    return _insert_clip(timeline, op.track_id, clip)


def _apply_add_text_overlay(timeline: Timeline, op: AddTextOverlay) -> Timeline:
    _assert_positive_range(op.start, op.end, "add_text_overlay")
    clip_id = op.clip_id or _derive_clip_id("text", op.track_id, op.start)
    clip = Clip(
        id=clip_id,
        asset_id=TEXT_OVERLAY_ASSET_ID,
        track_id=op.track_id,
        start=op.start,
        end=op.end,
        source_start=0.0,
        source_end=op.end - op.start,
        effects=[Effect(id=f"{clip_id}__text", type="text", params={"text": op.text})],
    )
    return _insert_clip(timeline, op.track_id, clip)


def _apply_add_caption_layer(timeline: Timeline, op: AddCaptionLayer) -> Timeline:
    _assert_positive_range(op.start, op.end, "add_caption_layer")
    clip_id = op.clip_id or _derive_clip_id("caption", op.track_id, op.start)
    clip = Clip(
        id=clip_id,
        asset_id=CAPTION_ASSET_ID,
        track_id=op.track_id,
        start=op.start,
        end=op.end,
        source_start=0.0,
        source_end=op.end - op.start,
        effects=[Effect(id=f"{clip_id}__caption", type="caption", params={})],
    )
    return _insert_clip(timeline, op.track_id, clip)


_KEYFRAME_REPLACE_EPSILON = 0.001


def _apply_add_keyframes(timeline: Timeline, op: AddKeyframes) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    kept = (
        [
            existing
            for existing in loc.clip.keyframes
            if not any(
                incoming.property == existing.property
                and abs(incoming.time - existing.time) <= _KEYFRAME_REPLACE_EPSILON
                for incoming in op.keyframes
            )
        ]
        if op.replace
        else list(loc.clip.keyframes)
    )
    next_clip = loc.clip.model_copy(
        update={"keyframes": [*kept, *(k.model_copy(deep=True) for k in op.keyframes)]}
    )
    return _replace_clip_at(timeline, loc, next_clip)


def _apply_remove_keyframes(timeline: Timeline, op: RemoveKeyframes) -> Timeline:
    """Drop every keyframe matching one of ``op.targets``.

    Reuses ``_KEYFRAME_REPLACE_EPSILON`` so "the keyframe at this time" means exactly
    what it means for ``add_keyframes``' replace — the two must agree, or a
    set-then-clear on one diamond would leave a stray keyframe a millisecond away.
    """
    loc = _find_clip(timeline, op.clip_id)
    keyframes = [
        existing
        for existing in loc.clip.keyframes
        if not any(
            target.property == existing.property
            # No time on the target = clear the whole property.
            and (
                target.time is None or abs(target.time - existing.time) <= _KEYFRAME_REPLACE_EPSILON
            )
            for target in op.targets
        )
    ]
    if len(keyframes) == len(loc.clip.keyframes):
        # Nothing matched: return the SAME timeline so a no-op removal cannot
        # masquerade as a change to anything comparing by identity.
        return timeline
    next_clip = loc.clip.model_copy(update={"keyframes": keyframes})
    return _replace_clip_at(timeline, loc, next_clip)


def _apply_color_grade(timeline: Timeline, op: ApplyColorGrade) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    # Replace an effect with the same id rather than stacking (mirrors TS): an
    # interactive grade panel or re-applied preset updates in place so multiple
    # color_grade effects never compound at render. A distinct id still appends.
    effects = [e for e in loc.clip.effects if e.id != op.effect.id]
    effects.append(op.effect.model_copy(deep=True))
    next_clip = loc.clip.model_copy(update={"effects": effects})
    return _replace_clip_at(timeline, loc, next_clip)


#: EQ shapes that take a boost/cut. The pass filters cut a range outright, so a
#: gain on one is a setting the renderer has nowhere to apply.
_EQ_GAIN_KINDS = frozenset({"low-shelf", "peaking", "high-shelf"})
_EQ_MAX_BANDS = 8
_EQ_FREQUENCY_RANGE = (20.0, 20000.0)
#: The compressor detects peaks in 1 ms blocks, so a faster attack cannot be honoured.
_DYNAMICS_MIN_ATTACK_MS = 1.0
_AUTOMATION_MIN_POINTS = 2


def _validate_audio_chain(op: AdjustAudio, clip_duration: float) -> None:
    """Mirror the TS audio contract rules that decide whether a render is honest.

    Numeric taste ranges stay in the TS contract layer; what is restated here is
    every rule whose violation would otherwise render as *something else* —
    silently dropped bands, an unreachable automation point, an ambiguous curve.
    """
    # An empty band list is the documented "clear the EQ" instruction (mirrors TS).
    if op.eq is not None and op.eq.bands:
        if len(op.eq.bands) > _EQ_MAX_BANDS:
            raise OperationError(
                "broken_audio_link", f"An EQ may carry at most {_EQ_MAX_BANDS} bands"
            )
        low, high = _EQ_FREQUENCY_RANGE
        for index, band in enumerate(op.eq.bands):
            if not low <= band.frequency_hz <= high:
                raise OperationError(
                    "broken_audio_link",
                    f"eq.bands[{index}].frequencyHz must be within {low}..{high} Hz",
                )
            needs_gain = band.kind in _EQ_GAIN_KINDS
            if needs_gain and band.gain_db is None:
                raise OperationError("broken_audio_link", f"A {band.kind} band requires gainDb")
            if not needs_gain and band.gain_db is not None:
                raise OperationError(
                    "broken_audio_link",
                    f"A {band.kind} band cuts a range outright and takes no gainDb",
                )
    if op.dynamics is not None:
        if op.dynamics.ratio < 1.0:
            raise OperationError("broken_audio_link", "dynamics.ratio must be at least 1")
        if op.dynamics.attack_ms < _DYNAMICS_MIN_ATTACK_MS:
            raise OperationError(
                "broken_audio_link",
                f"dynamics.attackMs must be at least {_DYNAMICS_MIN_ATTACK_MS} ms",
            )
        if op.dynamics.release_ms <= 0.0:
            raise OperationError("broken_audio_link", "dynamics.releaseMs must be positive")
    # An empty lane is the documented "clear the automation" instruction.
    if op.automation is not None and op.automation.points:
        if len(op.automation.points) < _AUTOMATION_MIN_POINTS:
            raise OperationError(
                "broken_audio_link",
                f"An automation lane needs at least {_AUTOMATION_MIN_POINTS} points",
            )
        previous = float("-inf")
        for point in op.automation.points:
            if not 0.0 <= point.time_seconds <= clip_duration:
                raise OperationError(
                    "broken_audio_link",
                    f"Automation times must be inside the clip (0..{clip_duration}s)",
                )
            if point.time_seconds <= previous:
                raise OperationError("broken_audio_link", "Automation times must strictly increase")
            previous = point.time_seconds


def _apply_adjust_audio(timeline: Timeline, op: AdjustAudio) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    _validate_audio_chain(op, loc.clip.end - loc.clip.start)
    if op.duck_amount_db is not None and op.duck_under_track_id is None:
        raise OperationError("broken_audio_link", "duckAmountDb requires duckUnderTrackId")
    if op.duck_under_track_id is not None:
        sidechain = next(
            (track for track in timeline.tracks if track.id == op.duck_under_track_id), None
        )
        if sidechain is None:
            raise OperationError(
                "broken_audio_link",
                f"duckUnderTrackId references missing track: {op.duck_under_track_id}",
            )
        if sidechain.id == loc.track.id:
            raise OperationError("broken_audio_link", "Audio cannot duck under its own track")
        if sidechain.type in (TrackType.CAPTION, TrackType.EFFECT):
            raise OperationError(
                "broken_audio_link", "duckUnderTrackId must reference an audio-capable track"
            )
    effects = [e for e in loc.clip.effects if e.type != "audio_gain"]
    # Only persist specified params, so a gain-only adjust stays minimal (mirrors TS).
    params: dict[str, object] = {"gainDb": op.gain_db}
    if op.fade_in_seconds is not None:
        params["fadeInSeconds"] = op.fade_in_seconds
    if op.fade_out_seconds is not None:
        params["fadeOutSeconds"] = op.fade_out_seconds
    if op.fade_curve is not None:
        params["fadeCurve"] = op.fade_curve
    if op.muted is not None:
        params["muted"] = op.muted
    if op.normalize is not None:
        params["normalize"] = op.normalize
    if op.duck_under_track_id is not None:
        params["duckUnderTrackId"] = op.duck_under_track_id
    if op.duck_amount_db is not None:
        params["duckAmountDb"] = op.duck_amount_db
    # EQ, compression, and the lane are carried forward when the op omits them
    # (mirrors TS): `adjust_audio` is the "set the level" verb, and rebuilding the
    # effect from the op alone made a gain-only edit silently delete processors
    # authored moments earlier. An omitted processor is not a removal instruction;
    # an empty band list or an empty point list is.
    prior = next((e for e in loc.clip.effects if e.type == "audio_gain"), None)
    prior_params = dict(prior.params) if prior is not None else {}
    if op.eq is not None:
        if op.eq.bands:
            params["eq"] = op.eq.model_dump(by_alias=True, exclude_none=True)
    elif "eq" in prior_params:
        params["eq"] = prior_params["eq"]
    if op.dynamics is not None:
        params["dynamics"] = op.dynamics.model_dump(by_alias=True, exclude_none=True)
    elif "dynamics" in prior_params:
        params["dynamics"] = prior_params["dynamics"]
    # The automation lane is keyframes on this same effect — the schema's own lane
    # shape, evaluated by the keyframe engine both runtimes share (mirrors TS).
    keyframes = (
        [k.model_copy(deep=True) for k in prior.keyframes]
        if op.automation is None and prior is not None
        else []
        if op.automation is None
        else [
            Keyframe(
                id=f"{op.clip_id}__{op.automation.property}__{round(point.time_seconds * 1000)}",
                time=point.time_seconds,
                property=op.automation.property,
                value=point.value,
                easing=point.easing or "linear",
            )
            for point in op.automation.points
        ]
    )
    effects.append(
        Effect(id=f"{op.clip_id}__gain", type="audio_gain", params=params, keyframes=keyframes)
    )
    return _replace_clip_at(timeline, loc, loc.clip.model_copy(update={"effects": effects}))


def _apply_add_transition(timeline: Timeline, op: AddTransition) -> Timeline:
    eligibility = transition_eligibility(
        timeline,
        track_id=op.track_id,
        from_clip_id=op.from_clip_id,
        to_clip_id=op.to_clip_id,
        duration_seconds=op.duration_seconds,
    )
    if not eligibility.ok:
        raise OperationError("invalid_transition", f"add_transition: {eligibility.detail}")
    loc = _find_clip(timeline, op.to_clip_id)
    effect = Effect(
        id=f"{op.to_clip_id}__transition",
        type="transition",
        params={
            "kind": op.kind,
            "durationSeconds": op.duration_seconds,
            "fromClipId": op.from_clip_id,
        },
    )
    # Idempotent by transition id (one transition per incoming clip, id
    # ``{to_clip_id}__transition``): re-adding — e.g. a UI duration-resize or kind
    # swap — replaces in place rather than stacking duplicate transition effects.
    # Mirrors apply_color_grade's replace-by-id precedent.
    effects = [e for e in loc.clip.effects if e.id != effect.id]
    effects.append(effect)
    return _replace_clip_at(timeline, loc, loc.clip.model_copy(update={"effects": effects}))


def _apply_add_mask(timeline: Timeline, op: AddMask) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    params: dict[str, Any] = {"shape": op.shape}
    if op.bounds is not None:
        params["bounds"] = op.bounds.model_dump()
    if op.points is not None:
        params["points"] = [list(point) for point in op.points]
    if op.feather is not None:
        params["feather"] = op.feather
    if op.opacity is not None:
        params["opacity"] = op.opacity
    if op.invert is not None:
        params["invert"] = op.invert
    keyframes = [k.model_copy(deep=True) for k in op.keyframes] if op.keyframes else []
    effect = Effect(id=f"{op.clip_id}__mask", type="mask", params=params, keyframes=keyframes)
    effects = [existing for existing in loc.clip.effects if existing.id != effect.id]
    effects.append(effect)
    return _replace_clip_at(timeline, loc, loc.clip.model_copy(update={"effects": effects}))


def _apply_track_object(timeline: Timeline, op: TrackObject) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    params: dict[str, Any] = {"target": op.target}
    if op.region is not None:
        params["region"] = op.region.model_dump()
    if op.engine is not None:
        params["engine"] = op.engine
    keyframes = [k.model_copy(deep=True) for k in op.keyframes] if op.keyframes else []
    effect = Effect(
        id=f"{op.clip_id}__track",
        type="object_track",
        params=params,
        keyframes=keyframes,
    )
    effects = [existing for existing in loc.clip.effects if existing.id != effect.id]
    effects.append(effect)
    return _replace_clip_at(timeline, loc, loc.clip.model_copy(update={"effects": effects}))


def _apply_set_track_flags(timeline: Timeline, op: SetTrackFlags) -> Timeline:
    track, index = _find_track(timeline, op.track_id)
    # Only flags this op targets (value is not None) change; clips are untouched.
    update = {
        flag: value
        for flag, value in (("locked", op.locked), ("hidden", op.hidden), ("muted", op.muted))
        if value is not None
    }
    tracks = list(timeline.tracks)
    tracks[index] = track.model_copy(update=update)
    return timeline.model_copy(update={"tracks": tracks})


def _apply_restore_clips(timeline: Timeline, op: RestoreClips) -> Timeline:
    _, index = _find_track(timeline, op.track_id)
    return _with_track_clips(timeline, index, [c.model_copy(deep=True) for c in op.clips])


# Dispatch table keyed on the operation discriminator.
def _apply_set_effect_params(timeline: Timeline, op: SetEffectParams) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    index = next((i for i, e in enumerate(loc.clip.effects) if e.id == op.effect_id), -1)
    if index == -1:
        raise OperationError(
            "missing_effect",
            f"set_effect_params references effect {op.effect_id} not on clip {op.clip_id}",
        )
    existing = loc.clip.effects[index]
    # Shallow-merge the new params over the existing ones (a key set to ``None``
    # clears it — the cross-language "clear" marker, see SetEffectParams). id/type/
    # keyframes are preserved — this edits params only.
    merged = dict(existing.params)
    for key, value in op.params.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    effects = list(loc.clip.effects)
    effects[index] = existing.model_copy(deep=True, update={"params": merged})
    return _replace_clip_at(timeline, loc, loc.clip.model_copy(update={"effects": effects}))


def _apply_set_caption_style(timeline: Timeline, op: SetCaptionStyle) -> Timeline:
    # The typed ``CaptionStyle`` field makes an invalid style unrepresentable at
    # parse time (the Pydantic mirror of TS's defensive re-validation).
    loc = _find_clip(timeline, op.clip_id)
    style = op.caption_style.model_copy(deep=True) if op.caption_style is not None else None
    return _replace_clip_at(
        timeline, loc, _clone_clip(loc.clip).model_copy(update={"caption_style": style})
    )


def _apply_set_clip_speed(timeline: Timeline, op: SetClipSpeed) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    speed = op.speed if op.speed is not None else 1.0
    if not (speed == speed and abs(speed) != float("inf")) or speed <= 0:
        raise OperationError(
            "invalid_speed",
            f"set_clip_speed requires a positive, finite speed for clip "
            f"'{op.clip_id}' (got {op.speed}).",
        )
    clip = loc.clip
    source_end = clip.source_end if clip.source_end is not None else clip.end - clip.start
    source_duration = source_end - clip.source_start
    # Canonicalize 1x as *absent* (``None``): a reset lands on a timeline deep-equal
    # to a clip that never had a speed set (mirrors the TS canonical form).
    next_clip = _clone_clip(clip).model_copy(
        update={
            "end": clip.start + source_duration / speed,
            "speed": None if abs(speed - 1.0) <= _EPSILON else speed,
        }
    )
    return _replace_clip_at(timeline, loc, next_clip)


def _apply_set_clip_crop(timeline: Timeline, op: SetClipCrop) -> Timeline:
    # The typed ``CropRect`` field enforces bounds at parse time (Pydantic mirror
    # of TS's defensive ``CropRectSchema`` re-validation).
    loc = _find_clip(timeline, op.clip_id)
    crop = op.crop.model_copy(deep=True) if op.crop is not None else None
    return _replace_clip_at(timeline, loc, _clone_clip(loc.clip).model_copy(update={"crop": crop}))


def _apply_set_clip_blend_mode(timeline: Timeline, op: SetClipBlendMode) -> Timeline:
    loc = _find_clip(timeline, op.clip_id)
    # Canonicalize 'normal' (and None) as *absent*, mirroring set_clip_speed's 1x.
    mode = None if op.blend_mode is None or op.blend_mode == "normal" else op.blend_mode
    return _replace_clip_at(
        timeline, loc, _clone_clip(loc.clip).model_copy(update={"blend_mode": mode})
    )


def _apply_add_layer(timeline: Timeline, op: AddLayer) -> Timeline:
    if any(t.id == op.layer_id for t in timeline.tracks):
        raise OperationError("duplicate_layer", f"Layer id already exists: {op.layer_id}")
    # Clamp the insertion index into [0, len] so an out-of-range z-order slot
    # appends rather than throwing (index 0 = visual front). Mirrors TS.
    at = max(0, min(len(timeline.tracks), op.at_index))
    layer = Track(
        id=op.layer_id,
        type=op.layer_type,
        clips=[c.model_copy(deep=True) for c in (op.clips or [])],
    )
    tracks = list(timeline.tracks)
    tracks.insert(at, layer)
    return timeline.model_copy(update={"tracks": tracks})


def _apply_remove_layer(timeline: Timeline, op: RemoveLayer) -> Timeline:
    _, index = _find_track(timeline, op.layer_id)
    tracks = list(timeline.tracks)
    del tracks[index]
    return timeline.model_copy(update={"tracks": tracks})


def _apply_move_layer(timeline: Timeline, op: MoveLayer) -> Timeline:
    _, index = _find_track(timeline, op.layer_id)
    tracks = list(timeline.tracks)
    layer = tracks.pop(index)
    # Clamp into [0, len] after removal so an out-of-range slot lands at an edge.
    to = max(0, min(len(tracks), op.to_index))
    tracks.insert(to, layer)
    return timeline.model_copy(update={"tracks": tracks})


_APPLY: dict[str, Callable[[Timeline, Any], Timeline]] = {
    "trim_clip": _apply_trim,
    "set_clip_source_range": _apply_set_clip_source_range,
    "set_clip_media": _apply_set_clip_media,
    "split_clip": _apply_split,
    "delete_range": _apply_delete_range,
    "ripple_delete": _apply_ripple_delete,
    "move_clip": _apply_move,
    "add_clip": _apply_add_clip,
    "add_text_overlay": _apply_add_text_overlay,
    "add_caption_layer": _apply_add_caption_layer,
    "add_keyframes": _apply_add_keyframes,
    "remove_keyframes": _apply_remove_keyframes,
    "apply_color_grade": _apply_color_grade,
    "adjust_audio": _apply_adjust_audio,
    "add_transition": _apply_add_transition,
    "add_mask": _apply_add_mask,
    "track_object": _apply_track_object,
    "set_track_flags": _apply_set_track_flags,
    "set_effect_params": _apply_set_effect_params,
    "set_caption_style": _apply_set_caption_style,
    "set_clip_speed": _apply_set_clip_speed,
    "set_clip_crop": _apply_set_clip_crop,
    "set_clip_blend_mode": _apply_set_clip_blend_mode,
    "add_layer": _apply_add_layer,
    "remove_layer": _apply_remove_layer,
    "move_layer": _apply_move_layer,
    "restore_clips": _apply_restore_clips,
}


# ---------------------------------------------------------------------------
# invert
# ---------------------------------------------------------------------------

# Ops whose inverse is a snapshot-restore of the track holding ``clip_id``.
_CLIP_RESTORE_OPS = frozenset(
    {
        "split_clip",
        "add_keyframes",
        "remove_keyframes",
        "apply_color_grade",
        "set_effect_params",
        "adjust_audio",
        "add_mask",
        "track_object",
    }
)
# Ops whose inverse is a snapshot-restore of ``track_id``.
_TRACK_RESTORE_OPS = frozenset(
    {
        "delete_range",
        "ripple_delete",
        "add_clip",
        "add_text_overlay",
        "add_caption_layer",
        "restore_clips",
    }
)


def invert_operation(timeline_before: Timeline, operation: Operation) -> list[Operation]:
    """Compute the operation(s) that undo ``operation`` against ``timeline_before``.

    Reversibility is a hard requirement (PRD §8.5) and backs undo/redo (PLAN §1.3).

    :param timeline_before: The timeline state before ``operation`` is applied.
    :param operation: The operation to invert.
    :returns: Operations that, applied in order, restore ``timeline_before``.
    :raises OperationError: If ``operation`` references entities missing from
        ``timeline_before``.
    """
    if isinstance(operation, TrimClip):
        clip = _find_clip(timeline_before, operation.clip_id).clip
        return [TrimClip(clip_id=operation.clip_id, start=clip.start, end=clip.end)]
    if isinstance(operation, SetClipSourceRange):
        clip = _find_clip(timeline_before, operation.clip_id).clip
        source_end = clip.source_end if clip.source_end is not None else clip.end - clip.start
        return [
            SetClipSourceRange(
                clip_id=operation.clip_id,
                source_start=clip.source_start,
                source_end=source_end,
            )
        ]
    if isinstance(operation, SetClipMedia):
        clip = _find_clip(timeline_before, operation.clip_id).clip
        source_end = clip.source_end if clip.source_end is not None else clip.end - clip.start
        return [
            SetClipMedia(
                clip_id=clip.id,
                asset_id=clip.asset_id,
                source_start=clip.source_start,
                source_end=source_end,
            )
        ]
    if isinstance(operation, MoveClip):
        clip = _find_clip(timeline_before, operation.clip_id).clip
        return [MoveClip(clip_id=operation.clip_id, to_track_id=clip.track_id, to_start=clip.start)]
    if operation.type in _CLIP_RESTORE_OPS:
        clip_id = cast(str, operation.clip_id)  # type: ignore[union-attr]
        return [_restore_for(_find_clip(timeline_before, clip_id).track)]
    if isinstance(operation, AddTransition):
        return [_restore_for(_find_clip(timeline_before, operation.to_clip_id).track)]
    if isinstance(operation, SetCaptionStyle):
        # Same-shape inverse: the clip's prior style wholesale (None when unstyled).
        clip = _find_clip(timeline_before, operation.clip_id).clip
        return [SetCaptionStyle(clip_id=operation.clip_id, caption_style=clip.caption_style)]
    if isinstance(operation, SetClipSpeed):
        # Same-shape inverse: the prior speed (None ≡ 1x) deterministically
        # restores the prior ``end`` from the (untouched) source range.
        clip = _find_clip(timeline_before, operation.clip_id).clip
        return [SetClipSpeed(clip_id=operation.clip_id, speed=clip.speed)]
    if isinstance(operation, SetClipCrop):
        clip = _find_clip(timeline_before, operation.clip_id).clip
        return [SetClipCrop(clip_id=operation.clip_id, crop=clip.crop)]
    if isinstance(operation, SetClipBlendMode):
        clip = _find_clip(timeline_before, operation.clip_id).clip
        return [SetClipBlendMode(clip_id=operation.clip_id, blend_mode=clip.blend_mode)]
    if isinstance(operation, AddLayer):
        # Undo an insert by removing the layer it created.
        return [RemoveLayer(layer_id=operation.layer_id)]
    if isinstance(operation, RemoveLayer):
        # Lossless: re-insert the removed layer at its prior z-order with its clips.
        track, index = _find_track(timeline_before, operation.layer_id)
        return [
            AddLayer(
                layer_id=track.id,
                layer_type=track.type,
                at_index=index,
                clips=[c.model_copy(deep=True) for c in track.clips],
            )
        ]
    if isinstance(operation, MoveLayer):
        # Same-shape inverse: move the layer back to the index it occupied before.
        _, index = _find_track(timeline_before, operation.layer_id)
        return [MoveLayer(layer_id=operation.layer_id, to_index=index)]
    if isinstance(operation, SetTrackFlags):
        # Same-shape inverse: restore the prior value of exactly the flags this op
        # touched. Track flags default to False, so an absent flag reads as False.
        track = _find_track(timeline_before, operation.track_id)[0]
        return [
            SetTrackFlags(
                trackId=operation.track_id,
                **({"locked": track.locked} if operation.locked is not None else {}),
                **({"hidden": track.hidden} if operation.hidden is not None else {}),
                **({"muted": track.muted} if operation.muted is not None else {}),
            )
        ]
    # _TRACK_RESTORE_OPS — every remaining op carries a ``track_id``.
    track_id = cast(str, operation.track_id)  # type: ignore[union-attr]
    return [_restore_for(_find_track(timeline_before, track_id)[0])]


def _restore_for(track: Track) -> RestoreClips:
    return RestoreClips(track_id=track.id, clips=[c.model_copy(deep=True) for c in track.clips])
