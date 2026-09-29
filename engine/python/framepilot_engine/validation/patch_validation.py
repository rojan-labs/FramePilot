"""Patch validation before apply (PRD §8.5, PLAN §1.4).

WHY: the AI/agent proposes patches; nothing reaches ``apply`` unvalidated
(PRD §3.2). This is the **Python mirror** of the TS ``editor-core`` validator: it
replays the patch against a working copy of the timeline (operations are pure, so
the caller's state is never touched) and reports every problem with an actionable
message and the offending operation index.

Reversibility (PRD §8.5 "operation is reversible"): every registered engine
operation is reversible by construction (proven by the apply→invert round-trip
tests), so the validator enforces reversibility by rejecting any op that is not a
registered engine operation (``unsupported_operation``).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from typing import Literal

from pydantic import BaseModel, Field

from framepilot_engine.effects.speed_curve import clip_timeline_duration, has_speed_ramp
from framepilot_engine.timeline.models import Asset, Timeline, Track
from framepilot_engine.timeline.operations import (
    SUPPORTED_COLOR_GRADE_EFFECTS,
    AddClip,
    AdjustAudio,
    ApplyColorGrade,
    Operation,
    OperationError,
    SetClipMedia,
    apply_operation,
)
from framepilot_engine.timeline.transition_policy import transition_eligibility

_EPSILON = 1e-9

#: Seconds of float noise a source out-point may carry and still be "at" its media's end
#: (the TS ``SOURCE_SECONDS_EPSILON``).
_SOURCE_SECONDS_EPSILON = 1e-6

#: The frame rate the source-overrun tolerance falls back to without a grid (the TS
#: ``UNGRIDDED_TOLERANCE_FPS``): the editor's 30 fps, so "one frame" still means a frame.
_UNGRIDDED_TOLERANCE_FPS = 30.0

ValidationCode = Literal[
    "missing_reference",
    "negative_duration",
    "invalid_layer_order",
    "missing_asset",
    "unsupported_effect",
    "broken_audio_link",
    "overlap_error",
    "transition_overlap",
    "unsupported_operation",
    "not_reversible",
    "duplicate_layer",
    "invalid_speed",
    "speed_duration_mismatch",
    # An apply path rejected the operation's SHAPE rather than its times. Mirrors the
    # TS validator's `invalid_operation` arm.
    "invalid_operation",
    # Two masks on one clip would share an id (schema v22). Mirrors the TS code.
    "duplicate_mask",
    # A shape's params cannot be drawn (schema v25). Mirrors the TS `invalid_style` code.
    "invalid_style",
    # A clip reads more than one frame past the end of its audio/video (AL42, #156).
    # Mirrors the TS `source_past_media_end` code.
    "source_past_media_end",
]
ValidationSeverity = Literal["error", "warning"]

# Operations the engine supports (all reversible). Mirrors the TS set.
SUPPORTED_OPERATIONS = frozenset(
    {
        "trim_clip",
        "set_clip_source_range",
        "set_clip_media",
        "split_clip",
        "delete_range",
        "move_clip",
        "reorder_clips",
        "ripple_delete",
        "add_clip",
        "add_text_overlay",
        "add_shape",
        "add_caption_layer",
        "add_keyframes",
        "remove_keyframes",
        "apply_color_grade",
        "adjust_audio",
        "add_transition",
        "add_mask",
        "track_object",
        "set_track_flags",
        "set_effect_params",
        "set_caption_style",
        "set_clip_speed",
        "set_clip_speed_ramp",
        "set_clip_crop",
        "set_clip_blend_mode",
        "add_layer",
        "remove_layer",
        "move_layer",
        "restore_clips",
    }
)


class ValidationIssue(BaseModel):
    """One validation problem with an actionable message (PRD §8.5)."""

    code: ValidationCode
    severity: ValidationSeverity
    message: str
    operation_index: int | None = None


class ValidationResult(BaseModel):
    """Outcome of validating a patch; ``valid`` is true iff no error issues."""

    valid: bool
    issues: list[ValidationIssue] = Field(default_factory=list)


def validate_patch(
    timeline: Timeline,
    operations: Sequence[Operation],
    *,
    asset_ids: Iterable[str] | None = None,
    assets: Iterable[Asset] | None = None,
    fps: float | None = None,
) -> ValidationResult:
    """Validate ``operations`` against ``timeline`` (PRD §8.5).

    Checks: references exist, no negative/invalid duration, valid layer order, no
    missing asset (when ``asset_ids`` is given), supported color-grade effect, no
    broken audio link, no clip overlap, no clip placed or extended more than a frame
    past the end of its media (when ``assets`` is given), op is engine-supported
    (== reversible).

    :param timeline: Timeline the patch would be applied to.
    :param operations: The patch operations, in order.
    :param asset_ids: Known asset ids; enables the missing-asset check for
        ``add_clip``. Omit to skip it (the timeline alone cannot prove an asset).
    :param assets: The media bin; enables ``source_past_media_end``. Omit to skip it.
    :param fps: The project frame rate, which sets that check's one-frame tolerance.
    :returns: A :class:`ValidationResult` (``valid`` false if any error issue).
    """
    known_assets = set(asset_ids) if asset_ids is not None else None
    media = {
        asset.id: length
        for asset in assets or ()
        if (length := media_length_seconds(asset)) is not None
    }
    tolerance = source_past_media_tolerance_seconds(fps or _UNGRIDDED_TOLERANCE_FPS)
    issues: list[ValidationIssue] = []
    working = timeline

    for index, op in enumerate(operations):
        if op.type not in SUPPORTED_OPERATIONS:
            issues.append(
                ValidationIssue(
                    code="unsupported_operation",
                    severity="error",
                    message=f'Operation "{op.type}" is not supported by the engine.',
                    operation_index=index,
                )
            )
            continue  # cannot replay an unknown op

        issues.extend(_static_checks(working, op, index, known_assets))

        # Replay to advance state and surface range/overlap/reference errors. On
        # failure keep the last good ``working`` so later ops still validate.
        try:
            nxt = apply_operation(working, op)
            issues.extend(_overlap_checks(nxt, index))
            issues.extend(_transition_overlap_checks(nxt, index))
            issues.extend(_speed_consistency_checks(nxt, index))
            if op.type != "restore_clips":
                issues.extend(_source_past_media_checks(working, nxt, index, media, tolerance))
            working = nxt
        except OperationError as exc:
            issues.append(_from_operation_error(exc, index))

    valid = not any(i.severity == "error" for i in issues)
    return ValidationResult(valid=valid, issues=issues)


def _clip_track(timeline: Timeline, clip_id: str) -> Track | None:
    return next((t for t in timeline.tracks if any(c.id == clip_id for c in t.clips)), None)


def _static_checks(
    timeline: Timeline, op: Operation, index: int, asset_ids: set[str] | None
) -> list[ValidationIssue]:
    """Checks that read the timeline before applying (layer order, assets, effects, audio)."""
    issues: list[ValidationIssue] = []

    # NOTE (Phase 2, ADR 0032): layers are type-agnostic — any clip kind may live on
    # any layer, so add_text_overlay / add_caption_layer no longer constrain the
    # target layer's advisory ``track.type``. Overlap and audio-link checks below
    # still apply to every layer regardless of kind. Mirrors the TS validator.
    if isinstance(op, (AddClip, SetClipMedia)):
        if asset_ids is not None and op.asset_id not in asset_ids:
            issues.append(
                ValidationIssue(
                    code="missing_asset",
                    severity="error",
                    message=f"Unknown asset '{op.asset_id}' referenced by {op.type}.",
                    operation_index=index,
                )
            )
    elif isinstance(op, ApplyColorGrade):
        if op.effect.type not in SUPPORTED_COLOR_GRADE_EFFECTS:
            issues.append(
                ValidationIssue(
                    code="unsupported_effect",
                    severity="error",
                    message=(
                        f"Unsupported color-grade effect '{op.effect.type}'. Expected one "
                        f"of: {', '.join(SUPPORTED_COLOR_GRADE_EFFECTS)}."
                    ),
                    operation_index=index,
                )
            )
    elif isinstance(op, AdjustAudio):
        track = _clip_track(timeline, op.clip_id)
        if track and track.type not in ("audio", "video"):
            issues.append(
                ValidationIssue(
                    code="broken_audio_link",
                    severity="error",
                    message=(
                        f"Cannot adjust audio on clip '{op.clip_id}': its track "
                        f"'{track.id}' ({track.type}) carries no audio."
                    ),
                    operation_index=index,
                )
            )
    return issues


def _overlap_checks(timeline: Timeline, index: int) -> list[ValidationIssue]:
    """Report overlapping clips on any track of the post-apply timeline."""
    issues: list[ValidationIssue] = []
    for track in timeline.tracks:
        ordered = sorted(track.clips, key=lambda c: c.start)
        for i in range(1, len(ordered)):
            prev, cur = ordered[i - 1], ordered[i]
            if cur.start < prev.end - _EPSILON:
                issues.append(
                    ValidationIssue(
                        code="overlap_error",
                        severity="error",
                        message=f"Clips '{prev.id}' and '{cur.id}' overlap on track '{track.id}'.",
                        operation_index=index,
                    )
                )
    return issues


def _transition_overlap_checks(timeline: Timeline, index: int) -> list[ValidationIssue]:
    """Validate every stored transition through the canonical Python policy.

    This intentionally does not restate adjacency, clean-cut, or duration formulas.
    ``transition_eligibility`` is the Python semantic mirror of editor-core's policy,
    so validation and operation application can consume one decision contract.
    """
    issues: list[ValidationIssue] = []
    for track in timeline.tracks:
        for to_clip in track.clips:
            effect = next((e for e in to_clip.effects if e.type == "transition"), None)
            if effect is None:
                continue
            duration = effect.params.get("durationSeconds")
            from_clip_id = effect.params.get("fromClipId")
            if not isinstance(duration, (int, float)) or isinstance(duration, bool):
                detail = "durationSeconds must be numeric"
            elif not isinstance(from_clip_id, str):
                detail = "fromClipId must name the outgoing clip"
            else:
                result = transition_eligibility(
                    timeline,
                    track_id=track.id,
                    from_clip_id=from_clip_id,
                    to_clip_id=to_clip.id,
                    duration_seconds=float(duration),
                )
                if result.ok:
                    continue
                detail = result.detail
            issues.append(
                ValidationIssue(
                    code="transition_overlap",
                    severity="error",
                    message=f"Transition on clip '{to_clip.id}' is invalid: {detail}.",
                    operation_index=index,
                )
            )
    return issues


# Slack for the speed/duration invariant (mirrors the TS SPEED_EPSILON).
_SPEED_EPSILON = 1e-6


def _speed_consistency_checks(timeline: Timeline, index: int) -> list[ValidationIssue]:
    """Enforce the clip-internal speed/time-remap invariant (schema v6).

    A clip's timeline duration must equal its source duration divided by its
    speed (absent speed ≡ 1x). Checked on the whole post-apply timeline after
    every op — mirrors the TS ``speedConsistencyChecks``. A clip whose
    ``source_end`` is unset (Python-only looseness) cannot be proven wrong, so
    it is skipped rather than guessed at.
    """
    issues: list[ValidationIssue] = []
    for track in timeline.tracks:
        for clip in track.clips:
            if clip.source_end is None:
                continue
            # A RAMPED clip's duration is the integral of its curve, not a division. Read
            # it from the one function the render and every edge-changing operation use
            # (`effects/speed_curve.clip_timeline_duration`), or a ramp is reported invalid
            # the moment it is applied — which is what made `set_clip_speed_ramp`
            # unusable before it had a tool. `None` is a freeze frame: no duration is
            # derivable and none is wrong, so it is skipped like an unset `source_end`.
            expected = clip_timeline_duration(clip)
            if expected is None:
                continue
            speed = clip.speed if clip.speed is not None else 1.0
            actual = clip.end - clip.start
            if abs(actual - expected) > _SPEED_EPSILON:
                issues.append(
                    ValidationIssue(
                        code="speed_duration_mismatch",
                        severity="error",
                        message=(
                            f"Clip '{clip.id}' on track '{track.id}' has timeline duration "
                            f"{actual}s but its source range "
                            f"({clip.source_end - clip.source_start}s) "
                            + (
                                "under its speed ramp "
                                if has_speed_ramp(clip)
                                else f"at speed {speed}x "
                            )
                            + f"implies {expected}s. "
                            f"(end - start must equal the duration the source range and "
                            f"speed settings imply.)"
                        ),
                        operation_index=index,
                    )
                )
    return issues


def media_length_seconds(asset: Asset) -> float | None:
    """The length a clip of ``asset`` may read up to (TS ``mediaLengthSeconds``).

    ``None`` for a still (drawn for as long as it is placed) and for media whose length is
    unknown.
    """
    if asset.kind not in ("audio", "video"):
        return None
    seconds = asset.duration_seconds
    if seconds is None or not math.isfinite(seconds) or seconds <= 0:
        return None
    return float(seconds)


def source_past_media_tolerance_seconds(fps: float) -> float:
    """How far past its media a source out-point may sit: one project frame (TS mirror)."""
    return 1.0 / fps + _SOURCE_SECONDS_EPSILON


def _source_past_media_checks(
    before: Timeline,
    after: Timeline,
    index: int,
    media: Mapping[str, float],
    tolerance: float,
) -> list[ValidationIssue]:
    """Clips this operation left reading more than a frame past their media (AL42, #156).

    Mirrors the TS ``sourcePastMediaIssues``: judged on the delta, over the tracks whose
    clips the operation changed. A clip is reported only when it reads further into its
    asset than any clip on those tracks already did, so a project saved with an overrun
    can still be split, moved and trimmed shorter. The message names the clip, the asset
    and its length — never the overrun, which changes with every retry and would split
    the repeated-failure guard's key.
    """
    if not media:
        return []
    previous = {track.id: track for track in before.tracks}
    touched = [track for track in after.tracks if previous.get(track.id) != track]
    if not touched:
        return []
    touched_ids = {track.id for track in touched}
    furthest: dict[str, float] = {}
    for track in before.tracks:
        if track.id not in touched_ids and not _holds_a_clip_of(track, touched):
            continue
        for clip in track.clips:
            if clip.source_end is not None:
                furthest[clip.asset_id] = max(
                    furthest.get(clip.asset_id, -math.inf), clip.source_end
                )
    issues: list[ValidationIssue] = []
    for track in touched:
        for clip in track.clips:
            length = media.get(clip.asset_id)
            if length is None or clip.source_end is None:
                continue
            if clip.source_end - length <= tolerance:
                continue
            if clip.source_end <= furthest.get(clip.asset_id, -math.inf) + _EPSILON:
                continue
            seconds = f"{length:.3f}"
            issues.append(
                ValidationIssue(
                    code="source_past_media_end",
                    severity="error",
                    message=(
                        f"Clip '{clip.id}' reads past the end of asset '{clip.asset_id}', "
                        f"which is {seconds}s long. Its source range must end by {seconds}s: "
                        "trim it with trim_clip, place it shorter, or slow it down, so the "
                        "clip plays no more of the asset than it holds."
                    ),
                    operation_index=index,
                )
            )
    return issues


def _holds_a_clip_of(track: Track, touched: Sequence[Track]) -> bool:
    """Whether a clip of ``track`` now sits on a touched track (a clip moved between lanes)."""
    ids = {clip.id for clip in track.clips}
    return any(clip.id in ids for other in touched for clip in other.clips)


def _from_operation_error(error: OperationError, index: int) -> ValidationIssue:
    """Map an :class:`OperationError` raised during replay to a validation issue."""
    if error.code in ("missing_clip", "missing_track", "missing_effect"):
        code: ValidationCode = "missing_reference"
    elif error.code in ("invalid_range", "invalid_split"):
        code = "negative_duration"
    elif error.code == "duplicate_layer":
        code = "duplicate_layer"
    elif error.code == "invalid_speed":
        code = "invalid_speed"
    elif error.code == "invalid_transition":
        code = "transition_overlap"
    elif error.code == "broken_audio_link":
        code = "broken_audio_link"
    elif error.code == "invalid_order":
        code = "invalid_operation"
    elif error.code == "duplicate_mask":
        code = "duplicate_mask"
    elif error.code == "invalid_style":
        code = "invalid_style"
    else:  # duplicate_clip
        code = "overlap_error"
    return ValidationIssue(code=code, severity="error", message=str(error), operation_index=index)
