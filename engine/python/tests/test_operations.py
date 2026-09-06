"""Tests for typed reversible timeline operations (PLAN §1.2)."""

from __future__ import annotations

from typing import Any

import pytest

from framepilot_engine.render.frame_grid import is_on_frame_grid
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
from framepilot_engine.timeline.operations import (
    CAPTION_ASSET_ID,
    TEXT_OVERLAY_ASSET_ID,
    AddCaptionLayer,
    AddClip,
    AddKeyframes,
    AddLayer,
    AddMask,
    AddTextOverlay,
    AddTransition,
    AdjustAudio,
    ApplyColorGrade,
    DeleteRange,
    MoveClip,
    MoveLayer,
    Operation,
    OperationError,
    RemoveKeyframes,
    RemoveKeyframeTarget,
    RemoveLayer,
    ReorderClips,
    RestoreClips,
    RippleDelete,
    SetCaptionStyle,
    SetClipBlendMode,
    SetClipCrop,
    SetClipMedia,
    SetClipSourceRange,
    SetClipSpeed,
    SetEffectParams,
    SetTrackFlags,
    SplitClip,
    TrackObject,
    TrimClip,
    apply_operation,
    invert_operation,
)


def _clip(cid: str, track: str, start: float, end: float, **extra: object) -> Clip:
    return Clip.model_validate(
        {
            "id": cid,
            "assetId": "vid",
            "trackId": track,
            "start": start,
            "end": end,
            "sourceStart": 0.0,
            "sourceEnd": end - start,
            **extra,
        }
    )


def _timeline() -> Timeline:
    return Timeline(
        tracks=[
            Track(
                id="v", type=TrackType.VIDEO, clips=[_clip("A", "v", 0, 4), _clip("B", "v", 5, 9)]
            ),
            Track(id="a", type=TrackType.AUDIO, clips=[_clip("AU", "a", 0, 4)]),
            Track(id="ov", type=TrackType.OVERLAY, clips=[]),
            Track(id="cap", type=TrackType.CAPTION, clips=[]),
        ]
    )


def _clips(timeline: Timeline, track_id: str) -> list[Clip]:
    return next(t for t in timeline.tracks if t.id == track_id).clips


def _roundtrip(op: Operation, timeline: Timeline | None = None) -> None:
    """apply(op) then apply(invert(op)) must restore the original timeline."""
    before = timeline if timeline is not None else _timeline()
    inverse = invert_operation(before, op)
    after = apply_operation(before, op)
    restored = after
    for inv in inverse:
        restored = apply_operation(restored, inv)
    assert restored == before


# --- apply behaviour ---------------------------------------------------------


def test_trim_remaps_source_1to1() -> None:
    result = apply_operation(_timeline(), TrimClip(clip_id="A", start=1, end=3))
    clip = _clips(result, "v")[0]
    assert (clip.start, clip.end) == (1, 3)
    assert clip.source_start == 1.0 and clip.source_end == 3.0


def test_set_clip_source_range_slips_without_moving_sequence_edges() -> None:
    timeline = _timeline()
    timeline.tracks[0].clips[0] = _clip("A", "v", 0, 4, sourceStart=2.0, sourceEnd=6.0)
    op = SetClipSourceRange(clip_id="A", source_start=3.0, source_end=7.0)
    result = apply_operation(timeline, op)
    clip = _clips(result, "v")[0]
    assert (clip.start, clip.end, clip.source_start, clip.source_end) == (0, 4, 3, 7)
    _roundtrip(op, timeline)


def test_set_clip_source_range_rejects_duration_change() -> None:
    with pytest.raises(OperationError, match="duration implied"):
        apply_operation(
            _timeline(),
            SetClipSourceRange(clip_id="A", source_start=1.0, source_end=4.0),
        )


def test_set_clip_media_preserves_clip_state_and_roundtrips() -> None:
    timeline = _timeline()
    original = timeline.tracks[0].clips[0]
    op = SetClipMedia(clip_id="A", asset_id="replacement", source_start=3.0, source_end=7.0)
    result = apply_operation(timeline, op)
    replaced = _clips(result, "v")[0]
    assert replaced.id == original.id
    assert (replaced.start, replaced.end) == (original.start, original.end)
    assert replaced.asset_id == "replacement"
    assert (replaced.source_start, replaced.source_end) == (3.0, 7.0)
    _roundtrip(op, timeline)


def test_split_partitions_clip_and_keyframes() -> None:
    timeline = _timeline()
    # Give A keyframes either side of the split offset (split at t=2 → offset 2).
    timeline.tracks[0].clips[0] = _clip(
        "A",
        "v",
        0,
        4,
        keyframes=[
            Keyframe(id="k1", time=1, property="scale", value=1),
            Keyframe(id="k2", time=3, property="scale", value=2),
        ],
    )
    result = apply_operation(timeline, SplitClip(clip_id="A", at=2))
    left, right = _clips(result, "v")[0], _clips(result, "v")[1]
    assert left.id == "A" and left.end == 2 and left.source_end == 2.0
    assert right.start == 2 and right.source_start == 2.0
    assert [k.time for k in left.keyframes] == [1]
    assert [k.time for k in right.keyframes] == [1]  # 3 re-based by offset 2


def test_delete_range_splits_spanning_clip() -> None:
    # Delete the middle of A (0-4): leaves [0,1) and [3,4).
    result = apply_operation(_timeline(), DeleteRange(track_id="v", start=1, end=3))
    a_pieces = [c for c in _clips(result, "v") if c.id.startswith("A")]
    assert len(a_pieces) == 2
    assert a_pieces[0].end == 1 and a_pieces[1].start == 3


def test_ripple_delete_closes_gap() -> None:
    result = apply_operation(_timeline(), RippleDelete(track_id="v", start=0, end=2))
    # A (0-4) → (0-2) [trim]; B (5-9) shifts left by 2 → (3-7).
    clips = _clips(result, "v")
    b = next(c for c in clips if c.id == "B")
    assert (b.start, b.end) == (3, 7)


def test_move_clip_changes_track_and_sorts() -> None:
    result = apply_operation(_timeline(), MoveClip(clip_id="AU", to_track_id="v", to_start=10))
    assert _clips(result, "a") == []
    moved = next(c for c in _clips(result, "v") if c.id == "AU")
    assert moved.track_id == "v" and moved.start == 10


def test_add_clip_inserts_with_derived_id() -> None:
    result = apply_operation(
        _timeline(),
        AddClip(track_id="v", asset_id="vid", start=10, end=12, source_start=0, source_end=2),
    )
    ids = [c.id for c in _clips(result, "v")]
    assert any(cid.startswith("clip__") for cid in ids)


def test_add_text_overlay_creates_text_effect() -> None:
    result = apply_operation(_timeline(), AddTextOverlay(track_id="ov", text="Hi", start=0, end=2))
    clip = _clips(result, "ov")[0]
    assert clip.asset_id == TEXT_OVERLAY_ASSET_ID
    assert clip.effects[0].type == "text" and clip.effects[0].params["text"] == "Hi"


def test_add_caption_layer_creates_caption_effect() -> None:
    result = apply_operation(_timeline(), AddCaptionLayer(track_id="cap", start=0, end=2))
    clip = _clips(result, "cap")[0]
    assert clip.asset_id == CAPTION_ASSET_ID and clip.effects[0].type == "caption"


def test_add_keyframes_appends() -> None:
    op = AddKeyframes(
        clip_id="A", keyframes=[Keyframe(id="k1", time=1, property="opacity", value=0.5)]
    )
    result = apply_operation(_timeline(), op)
    assert len(_clips(result, "v")[0].keyframes) == 1


# --- remove_keyframes (revamp Phase 5a) --------------------------------------
#
# Mirrors the TS cases in `operations.test.ts`. `add_keyframes.replace` only swaps a
# keyframe at the same property AND time, so nothing could delete one — and a move is
# a delete plus an add.


def _animated() -> Timeline:
    """A clip carrying a small animation to remove pieces of."""
    return apply_operation(
        _timeline(),
        AddKeyframes(
            clip_id="A",
            keyframes=[
                Keyframe(id="s0", time=0, property="scale", value=1),
                Keyframe(id="s1", time=1, property="scale", value=2),
                Keyframe(id="x0", time=1, property="x", value=10),
            ],
        ),
    )


def _roundtrip_from(before: Timeline, op: Operation) -> Timeline:
    """As :func:`_roundtrip`, but from an arbitrary base timeline."""
    inverse = invert_operation(before, op)
    after = apply_operation(before, op)
    restored = after
    for inv in inverse:
        restored = apply_operation(restored, inv)
    assert restored == before
    return after


def test_remove_keyframes_drops_one_by_property_and_time() -> None:
    after = _roundtrip_from(
        _animated(),
        RemoveKeyframes(clip_id="A", targets=[RemoveKeyframeTarget(property="scale", time=1)]),
    )
    # Only scale@1s went; scale@0s and the x keyframe at the same TIME survived.
    assert sorted(k.id for k in _clips(after, "v")[0].keyframes) == ["s0", "x0"]


def test_remove_keyframes_clears_a_property_when_no_time_given() -> None:
    after = _roundtrip_from(
        _animated(), RemoveKeyframes(clip_id="A", targets=[RemoveKeyframeTarget(property="scale")])
    )
    assert [k.id for k in _clips(after, "v")[0].keyframes] == ["x0"]


def test_remove_keyframes_handles_several_targets_as_one_operation() -> None:
    after = _roundtrip_from(
        _animated(),
        RemoveKeyframes(
            clip_id="A",
            targets=[
                RemoveKeyframeTarget(property="scale", time=0),
                RemoveKeyframeTarget(property="x"),
            ],
        ),
    )
    assert [k.id for k in _clips(after, "v")[0].keyframes] == ["s1"]


def test_remove_keyframes_matches_time_within_the_replace_epsilon() -> None:
    # The two must agree, or a set-then-clear on one inspector diamond would leave a
    # stray keyframe a millisecond away from where the user clicked.
    after = apply_operation(
        _animated(),
        RemoveKeyframes(clip_id="A", targets=[RemoveKeyframeTarget(property="scale", time=1.0005)]),
    )
    assert not any(k.id == "s1" for k in _clips(after, "v")[0].keyframes)

    missed = apply_operation(
        _animated(),
        RemoveKeyframes(clip_id="A", targets=[RemoveKeyframeTarget(property="scale", time=1.5)]),
    )
    assert len(_clips(missed, "v")[0].keyframes) == 3


def test_remove_keyframes_returns_same_timeline_when_nothing_matched() -> None:
    # Identity, so a no-op removal cannot masquerade as a change to anything
    # comparing by reference.
    before = _animated()
    assert (
        apply_operation(
            before,
            RemoveKeyframes(clip_id="A", targets=[RemoveKeyframeTarget(property="rotation")]),
        )
        is before
    )
    assert apply_operation(before, RemoveKeyframes(clip_id="A", targets=[])) is before


def test_remove_keyframes_composes_with_add_to_move_a_keyframe() -> None:
    # A move is a delete at the old time plus an add at the new — the reason this op
    # unblocks dragging a keyframe on the timeline.
    removed = apply_operation(
        _animated(),
        RemoveKeyframes(clip_id="A", targets=[RemoveKeyframeTarget(property="scale", time=1)]),
    )
    moved = apply_operation(
        removed,
        AddKeyframes(clip_id="A", keyframes=[Keyframe(id="s1", time=3, property="scale", value=2)]),
    )
    scales = [k for k in _clips(moved, "v")[0].keyframes if k.property == "scale"]
    assert sorted(k.time for k in scales) == [0, 3]


def test_remove_keyframes_rejects_an_unknown_clip() -> None:
    with pytest.raises(OperationError):
        apply_operation(
            _timeline(),
            RemoveKeyframes(clip_id="ghost", targets=[RemoveKeyframeTarget(property="scale")]),
        )


def test_apply_color_grade_appends_effect() -> None:
    effect = Effect(id="g", type="color_grade", params={"exposure": 0.2})
    result = apply_operation(_timeline(), ApplyColorGrade(clip_id="A", effect=effect))
    assert _clips(result, "v")[0].effects[-1].type == "color_grade"


def test_apply_color_grade_replaces_same_id() -> None:
    # Re-grading with the same effect id updates in place (no compounding stack).
    first = Effect(id="A__grade", type="color_grade", params={"exposure": 0.2})
    second = Effect(id="A__grade", type="color_grade", params={"exposure": 0.5})
    timeline = apply_operation(_timeline(), ApplyColorGrade(clip_id="A", effect=first))
    timeline = apply_operation(timeline, ApplyColorGrade(clip_id="A", effect=second))
    grades = [e for e in _clips(timeline, "v")[0].effects if e.type == "color_grade"]
    assert len(grades) == 1 and grades[0].params["exposure"] == 0.5


def test_adjust_audio_replaces_existing_gain() -> None:
    timeline = apply_operation(_timeline(), AdjustAudio(clip_id="AU", gain_db=-3))
    timeline = apply_operation(timeline, AdjustAudio(clip_id="AU", gain_db=-6))
    gains = [e for e in _clips(timeline, "a")[0].effects if e.type == "audio_gain"]
    assert len(gains) == 1 and gains[0].params["gainDb"] == -6


def test_adjust_audio_persists_only_specified_extras() -> None:
    # Gain-only adjust stays minimal; a richer adjust carries fades/mute/normalize.
    gain_only = apply_operation(_timeline(), AdjustAudio(clip_id="AU", gain_db=0))
    assert set(_clips(gain_only, "a")[0].effects[-1].params) == {"gainDb"}

    rich = apply_operation(
        _timeline(),
        AdjustAudio.model_validate(
            {
                "clipId": "AU",
                "gainDb": -3,
                "fadeInSeconds": 0.5,
                "fadeCurve": "equal-power",
                "muted": True,
                "normalize": True,
                "duckUnderTrackId": "v",
                "duckAmountDb": -10,
            }
        ),
    )
    params = _clips(rich, "a")[0].effects[-1].params
    assert params["fadeInSeconds"] == 0.5
    assert params["fadeCurve"] == "equal-power"
    assert params["muted"] is True
    assert params["normalize"] is True
    assert params["duckUnderTrackId"] == "v"
    assert "fadeOutSeconds" not in params  # unspecified → omitted


def test_adjust_audio_carries_the_whole_channel_strip() -> None:
    """EQ, compression, and an automation lane land on the one canonical effect."""
    timeline = apply_operation(
        _timeline(),
        AdjustAudio.model_validate(
            {
                "clipId": "AU",
                "gainDb": 0,
                "eq": {"bands": [{"kind": "high-pass", "frequencyHz": 80}]},
                "dynamics": {
                    "thresholdDb": -18,
                    "ratio": 3,
                    "attackMs": 10,
                    "releaseMs": 120,
                },
                "automation": {
                    "property": "gainDb",
                    "points": [
                        {"timeSeconds": 0, "value": -20},
                        {"timeSeconds": 2, "value": 0, "easing": "ease-in-out"},
                    ],
                },
            }
        ),
    )
    effect = _clips(timeline, "a")[0].effects[-1]
    assert effect.params["eq"] == {"bands": [{"kind": "high-pass", "frequencyHz": 80}]}
    assert effect.params["dynamics"]["ratio"] == 3
    # The lane is keyframes on the same effect — the schema's own lane shape.
    assert [(k.time, k.value, k.easing) for k in effect.keyframes] == [
        (0.0, -20.0, "linear"),
        (2.0, 0.0, "ease-in-out"),
    ]
    assert effect.keyframes[0].property == "gainDb"


def test_adjust_audio_rejects_a_chain_the_renderer_could_not_honour() -> None:
    """Every rule here is one whose violation would render as something else."""
    cases: list[tuple[dict[str, Any], str]] = [
        (
            {"eq": {"bands": [{"kind": "peaking", "frequencyHz": 1000}]}},
            "requires gainDb",
        ),
        (
            {"eq": {"bands": [{"kind": "high-pass", "frequencyHz": 80, "gainDb": 3}]}},
            "takes no gainDb",
        ),
        (
            {"eq": {"bands": [{"kind": "peaking", "frequencyHz": 30000, "gainDb": 3}]}},
            "frequencyHz must be within",
        ),
        (
            {"dynamics": {"thresholdDb": -18, "ratio": 3, "attackMs": 0.2, "releaseMs": 120}},
            "attackMs must be at least",
        ),
        (
            {
                "automation": {
                    "property": "gainDb",
                    "points": [
                        {"timeSeconds": 1, "value": 0},
                        {"timeSeconds": 1, "value": -6},
                    ],
                }
            },
            "strictly increase",
        ),
        (
            {
                "automation": {
                    "property": "gainDb",
                    "points": [
                        {"timeSeconds": 0, "value": 0},
                        {"timeSeconds": 40, "value": -6},
                    ],
                }
            },
            "inside the clip",
        ),
    ]
    for extra, message in cases:
        with pytest.raises(OperationError, match=message):
            apply_operation(
                _timeline(),
                AdjustAudio.model_validate({"clipId": "AU", "gainDb": 0, **extra}),
            )


def test_adjust_audio_carries_the_strip_through_a_gain_only_edit() -> None:
    """A gain-only adjust must not delete processors it says nothing about (mirrors TS)."""
    strip = apply_operation(
        _timeline(),
        AdjustAudio.model_validate(
            {
                "clipId": "AU",
                "gainDb": 0,
                "eq": {"bands": [{"kind": "high-pass", "frequencyHz": 80}]},
                "dynamics": {"thresholdDb": -18, "ratio": 3, "attackMs": 10, "releaseMs": 120},
                "automation": {
                    "property": "gainDb",
                    "points": [
                        {"timeSeconds": 0, "value": -20},
                        {"timeSeconds": 2, "value": 0},
                    ],
                },
            }
        ),
    )
    levelled = apply_operation(strip, AdjustAudio(clip_id="AU", gain_db=-9))
    effect = _clips(levelled, "a")[0].effects[-1]
    assert effect.params["gainDb"] == -9
    assert effect.params["eq"] == {"bands": [{"kind": "high-pass", "frequencyHz": 80}]}
    assert effect.params["dynamics"]["ratio"] == 3
    assert len(effect.keyframes) == 2

    # Removal stays expressible by saying so.
    cleared = apply_operation(
        levelled, AdjustAudio.model_validate({"clipId": "AU", "gainDb": -9, "eq": {"bands": []}})
    )
    assert "eq" not in _clips(cleared, "a")[0].effects[-1].params


def test_adjust_audio_clears_an_automation_lane_with_an_empty_point_list() -> None:
    automated = apply_operation(
        _timeline(),
        AdjustAudio.model_validate(
            {
                "clipId": "AU",
                "gainDb": 0,
                "automation": {
                    "property": "gainDb",
                    "points": [
                        {"timeSeconds": 0, "value": -20},
                        {"timeSeconds": 2, "value": 0},
                    ],
                },
            }
        ),
    )
    cleared = apply_operation(
        automated,
        AdjustAudio.model_validate(
            {"clipId": "AU", "gainDb": -6, "automation": {"property": "gainDb", "points": []}}
        ),
    )
    assert _clips(cleared, "a")[0].effects[-1].keyframes == []


def test_adjust_audio_rejects_invalid_sidechain_links() -> None:
    with pytest.raises(OperationError, match="requires duckUnderTrackId"):
        apply_operation(_timeline(), AdjustAudio(clip_id="AU", gain_db=0, duck_amount_db=-12))
    with pytest.raises(OperationError, match="own track"):
        apply_operation(
            _timeline(),
            AdjustAudio(clip_id="AU", gain_db=0, duck_under_track_id="a", duck_amount_db=-12),
        )
    with pytest.raises(OperationError, match="missing track"):
        apply_operation(
            _timeline(),
            AdjustAudio(clip_id="AU", gain_db=0, duck_under_track_id="missing", duck_amount_db=-12),
        )


def _clean_cut_timeline() -> Timeline:
    """A/B share a clean cut at t=4, unlike ``_timeline()``'s 1s gap — transitions
    require adjacency, so tests that add one need their own fixture."""
    return Timeline(
        tracks=[
            Track(
                id="v", type=TrackType.VIDEO, clips=[_clip("A", "v", 0, 4), _clip("B", "v", 4, 9)]
            ),
        ]
    )


def test_add_transition_attaches_to_target() -> None:
    op = AddTransition(
        track_id="v", from_clip_id="A", to_clip_id="B", kind="cross-dissolve", duration_seconds=0.5
    )
    result = apply_operation(_clean_cut_timeline(), op)
    b = next(c for c in _clips(result, "v") if c.id == "B")
    assert b.effects[-1].type == "transition"
    assert b.effects[-1].params["fromClipId"] == "A"


def test_add_transition_roundtrip() -> None:
    _roundtrip(
        AddTransition(
            track_id="v", from_clip_id="A", to_clip_id="B", kind="fade", duration_seconds=0.5
        ),
        timeline=_clean_cut_timeline(),
    )


def test_add_mask_and_track_object() -> None:
    masked = apply_operation(_timeline(), AddMask(clip_id="A", shape="ellipse"))
    assert _clips(masked, "v")[0].effects[-1].type == "mask"
    assert _clips(masked, "v")[0].effects[-1].params == {"shape": "ellipse"}
    tracked = apply_operation(_timeline(), TrackObject(clip_id="A", target="face"))
    assert _clips(tracked, "v")[0].effects[-1].type == "object_track"


def test_add_mask_and_track_object_replace_their_canonical_effects() -> None:
    masked = apply_operation(_timeline(), AddMask(clip_id="A", shape="ellipse"))
    masked = apply_operation(masked, AddMask(clip_id="A", shape="rectangle"))
    tracked = apply_operation(masked, TrackObject(clip_id="A", target="face"))
    tracked = apply_operation(tracked, TrackObject(clip_id="A", target="object", engine="manual"))
    effects = _clips(tracked, "v")[0].effects
    assert [effect.id for effect in effects].count("A__mask") == 1
    assert [effect.id for effect in effects].count("A__track") == 1
    mask = next(effect for effect in effects if effect.id == "A__mask")
    track = next(effect for effect in effects if effect.id == "A__track")
    assert mask.params["shape"] == "rectangle"
    assert track.params["target"] == "object"


def test_add_mask_stores_geometry_and_keyframes() -> None:
    from framepilot_engine.timeline.models import Keyframe
    from framepilot_engine.timeline.operations import MaskBounds

    op = AddMask(
        clip_id="A",
        shape="rectangle",
        bounds=MaskBounds(x=0.1, y=0.2, width=0.5, height=0.6),
        points=[(0.0, 0.0), (1.0, 1.0)],
        feather=0.05,
        opacity=0.8,
        invert=True,
        keyframes=[Keyframe(id="mk", time=0.0, property="x", value=0.1)],
    )
    effect = _clips(apply_operation(_timeline(), op), "v")[0].effects[-1]
    assert effect.params["bounds"] == {"x": 0.1, "y": 0.2, "width": 0.5, "height": 0.6}
    assert effect.params["points"] == [[0.0, 0.0], [1.0, 1.0]]
    assert effect.params["feather"] == 0.05
    assert effect.params["opacity"] == 0.8
    assert effect.params["invert"] is True
    assert len(effect.keyframes) == 1


def test_restore_clips_replaces_track() -> None:
    result = apply_operation(_timeline(), RestoreClips(track_id="v", clips=[_clip("X", "v", 0, 1)]))
    assert [c.id for c in _clips(result, "v")] == ["X"]


def test_apply_does_not_mutate_input() -> None:
    timeline = _timeline()
    apply_operation(timeline, TrimClip(clip_id="A", start=1, end=2))
    assert _clips(timeline, "v")[0].start == 0  # original untouched


def test_invalid_source_range_states_both_time_domains() -> None:
    """The same sentence the TypeScript engine gives, for the same case.

    Parity with ``packages/editor-core/src/operations.test.ts`` → "states both time
    domains and both ranges when the source range is invalid". Both engines reject the
    same trim, and a run that hits it on one path must not be told less than on the other.

    The wording matters because of what it replaced: ``trim_clip produces invalid source
    range on A`` named the clip and nothing else, and the captured runs
    (``framepilot.runs.jsonl``) show a model reissuing the identical call rather than
    correcting the one confusion behind it — timeline time used where the clip's SOURCE
    range is the constraint.
    """
    timeline = Timeline(
        tracks=[
            Track(
                id="v",
                type=TrackType.VIDEO,
                clips=[_clip("A", "v", 3, 10, sourceStart=1, sourceEnd=8)],
            )
        ]
    )
    with pytest.raises(OperationError) as exc:
        apply_operation(timeline, TrimClip(clip_id="A", start=0, end=10))
    message = str(exc.value)
    assert "timeline 3s to 10s" in message
    assert "source 1s to 8s" in message
    assert "needs source -2s, which is before the media starts" in message
    assert "get_clip" in message


def test_a_zero_length_trim_names_the_times_it_was_given() -> None:
    timeline = _timeline()
    with pytest.raises(OperationError) as exc:
        apply_operation(timeline, TrimClip(clip_id="A", start=5, end=5))
    assert "5s → 5s" in str(exc.value)


def test_source_end_none_is_handled() -> None:
    timeline = Timeline(
        tracks=[Track(id="v", type=TrackType.VIDEO, clips=[_clip("A", "v", 0, 4, sourceEnd=None)])]
    )
    trimmed = apply_operation(timeline, TrimClip(clip_id="A", start=0, end=2))
    assert trimmed.tracks[0].clips[0].source_end == 2.0


# --- reversibility round-trips (apply → invert restores) ---------------------


@pytest.mark.parametrize(
    "op",
    [
        TrimClip(clip_id="A", start=1, end=3),
        SplitClip(clip_id="A", at=2),
        DeleteRange(track_id="v", start=1, end=3),
        RippleDelete(track_id="v", start=0, end=2),
        MoveClip(clip_id="AU", to_track_id="v", to_start=10),
        AddClip(track_id="v", asset_id="vid", start=10, end=12, source_start=0, source_end=2),
        AddTextOverlay(track_id="ov", text="Hi", start=0, end=2),
        AddCaptionLayer(track_id="cap", start=0, end=2),
        AddKeyframes(clip_id="A", keyframes=[Keyframe(id="k1", time=1, property="scale", value=2)]),
        ApplyColorGrade(clip_id="A", effect=Effect(id="g", type="lut", params={})),
        AdjustAudio(clip_id="AU", gain_db=-3),
        AddMask(clip_id="A", shape="rectangle"),
        TrackObject(clip_id="A", target="bounding_box"),
        SetTrackFlags(track_id="a", muted=True),
        SetTrackFlags(track_id="v", locked=True, hidden=True),
        SetTrackFlags(track_id="v", muted=False),  # off-flag round-trips too
        RestoreClips(track_id="v", clips=[_clip("Z", "v", 0, 1)]),
    ],
)
def test_operation_roundtrips(op: Operation) -> None:
    _roundtrip(op)


def test_set_track_flags_only_touches_named_flags() -> None:
    result = apply_operation(_timeline(), SetTrackFlags(track_id="a", muted=True))
    audio = next(t for t in result.tracks if t.id == "a")
    assert audio.muted is True
    assert audio.locked is False and audio.hidden is False  # untouched flags unchanged


def _role_of(timeline: Timeline, track_id: str) -> str | None:
    return next(t for t in timeline.tracks if t.id == track_id).role


def test_set_track_flags_labels_an_audio_track() -> None:
    """``Track.role`` shipped readable and unwritable after creation.

    ``add_layer`` set it and nothing else could, so ``duck_roles`` asked for a label no
    surface could apply. This is the write path, and it must behave identically in both
    runtimes or the same patch labels a track in TypeScript and not here.
    """
    result = apply_operation(_timeline(), SetTrackFlags(track_id="a", role="dialogue"))
    assert _role_of(result, "a") == "dialogue"


def test_set_track_flags_leaves_the_label_alone_when_role_is_absent() -> None:
    labelled = apply_operation(_timeline(), SetTrackFlags(track_id="a", role="music"))
    after = apply_operation(labelled, SetTrackFlags(track_id="a", muted=True))
    assert _role_of(after, "a") == "music"


def test_set_track_flags_clears_the_label_on_an_explicit_null() -> None:
    # Absent and explicit-null differ, and the difference is read from the fields that
    # were SET, not from the value — ``None`` is the clear instruction.
    labelled = apply_operation(_timeline(), SetTrackFlags(track_id="a", role="music"))
    cleared = apply_operation(labelled, SetTrackFlags(track_id="a", role=None))
    assert _role_of(cleared, "a") is None


def test_labelling_a_track_is_reversible() -> None:
    # The inverse of "label it" is an explicit clear, or undo leaves the label behind on
    # a track that never had one.
    _roundtrip(SetTrackFlags(track_id="a", role="dialogue"))


def test_relabelling_a_track_is_reversible() -> None:
    before = apply_operation(_timeline(), SetTrackFlags(track_id="a", role="music"))
    _roundtrip(SetTrackFlags(track_id="a", role="dialogue"), before)


def test_clearing_a_label_is_reversible() -> None:
    before = apply_operation(_timeline(), SetTrackFlags(track_id="a", role="music"))
    _roundtrip(SetTrackFlags(track_id="a", role=None), before)


# --- error paths -------------------------------------------------------------


def test_missing_clip_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(_timeline(), TrimClip(clip_id="ghost", start=0, end=1))
    assert exc.value.code == "missing_clip"


def test_missing_track_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(_timeline(), DeleteRange(track_id="ghost", start=0, end=1))
    assert exc.value.code == "missing_track"


def test_trim_nonpositive_duration_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(_timeline(), TrimClip(clip_id="A", start=2, end=2))
    assert exc.value.code == "invalid_range"


def test_trim_invalid_source_range_raises() -> None:
    # Pull the start far left so source_start goes negative.
    with pytest.raises(OperationError) as exc:
        apply_operation(_timeline(), TrimClip(clip_id="A", start=-5, end=1))
    assert exc.value.code == "invalid_range"


def test_split_outside_clip_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(_timeline(), SplitClip(clip_id="A", at=10))
    assert exc.value.code == "invalid_split"


def test_add_clip_invalid_range_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(
            _timeline(),
            AddClip(track_id="v", asset_id="vid", start=5, end=5, source_start=0, source_end=1),
        )
    assert exc.value.code == "invalid_range"


def test_add_clip_invalid_source_range_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(
            _timeline(),
            AddClip(track_id="v", asset_id="vid", start=10, end=12, source_start=2, source_end=2),
        )
    assert exc.value.code == "invalid_range"


def test_add_transition_nonpositive_duration_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(
            _timeline(),
            AddTransition(
                track_id="v", from_clip_id="A", to_clip_id="B", kind="cut", duration_seconds=0
            ),
        )
    assert exc.value.code == "invalid_transition"


def test_duplicate_clip_id_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(
            _timeline(),
            AddClip(
                track_id="v",
                asset_id="vid",
                start=10,
                end=12,
                source_start=0,
                source_end=2,
                clip_id="A",  # already on track v
            ),
        )
    assert exc.value.code == "duplicate_clip"


def test_delete_range_invalid_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(_timeline(), DeleteRange(track_id="v", start=3, end=3))
    assert exc.value.code == "invalid_range"


def test_delete_range_left_remainder_only() -> None:
    # Delete from inside A to past its end → only a left remainder [0,2).
    result = apply_operation(_timeline(), DeleteRange(track_id="v", start=2, end=4.5))
    a_pieces = [c for c in _clips(result, "v") if c.id.startswith("A")]
    assert len(a_pieces) == 1 and a_pieces[0].end == 2


def test_delete_range_non_overlapping_keeps_clip() -> None:
    result = apply_operation(_timeline(), DeleteRange(track_id="v", start=4, end=5))
    assert any(c.id == "A" for c in _clips(result, "v"))  # A (0-4) untouched


def test_add_keyframes_replace_swaps_same_property_same_time() -> None:
    base = apply_operation(
        _timeline(),
        AddKeyframes(
            clip_id="A",
            keyframes=[
                Keyframe(id="k1", time=1, property="scale", value=2),
                Keyframe(id="kx", time=1, property="x", value=10),
            ],
        ),
    )
    result = apply_operation(
        base,
        AddKeyframes(
            clip_id="A",
            keyframes=[Keyframe(id="k2", time=1, property="scale", value=3)],
            replace=True,
        ),
    )
    keyframes = _clips(result, "v")[0].keyframes
    scales = [k for k in keyframes if k.property == "scale"]
    assert [k.value for k in scales] == [3]  # replaced, not stacked
    assert any(k.property == "x" for k in keyframes)  # other properties survive
    # A different time still appends under replace.
    later = apply_operation(
        result,
        AddKeyframes(
            clip_id="A",
            keyframes=[Keyframe(id="k3", time=2, property="scale", value=4)],
            replace=True,
        ),
    )
    assert len([k for k in _clips(later, "v")[0].keyframes if k.property == "scale"]) == 2


# --- v5-v8 styling ops, set_effect_params, and layer ops (TS parity) ---------


def test_set_effect_params_merges_and_clears() -> None:
    graded = apply_operation(
        _timeline(),
        ApplyColorGrade(
            clip_id="A", effect=Effect(id="g", type="lut", params={"lut": "warm", "mix": 0.5})
        ),
    )
    edited = apply_operation(
        graded,
        SetEffectParams(clip_id="A", effect_id="g", params={"mix": 0.8, "lut": None}),
    )
    effect = _clips(edited, "v")[0].effects[0]
    assert effect.params == {"mix": 0.8}
    assert effect.id == "g" and effect.type == "lut"


def test_set_effect_params_missing_effect_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(_timeline(), SetEffectParams(clip_id="A", effect_id="ghost", params={}))
    assert exc.value.code == "missing_effect"


def test_set_effect_params_roundtrips_via_track_restore() -> None:
    before = apply_operation(
        _timeline(),
        ApplyColorGrade(clip_id="A", effect=Effect(id="g", type="lut", params={"lut": "warm"})),
    )
    op = SetEffectParams(clip_id="A", effect_id="g", params={"lut": "cool"})
    inverse = invert_operation(before, op)
    after = apply_operation(before, op)
    restored = after
    for inv in inverse:
        restored = apply_operation(restored, inv)
    assert restored == before


def test_set_caption_style_sets_and_clears() -> None:
    style = CaptionStyle.model_validate({"fontFamily": "Inter", "position": "top"})
    styled = apply_operation(_timeline(), SetCaptionStyle(clip_id="A", caption_style=style))
    assert _clips(styled, "v")[0].caption_style == style
    cleared = apply_operation(styled, SetCaptionStyle(clip_id="A", caption_style=None))
    assert _clips(cleared, "v")[0].caption_style is None


def test_set_clip_speed_recomputes_end_from_source_window() -> None:
    fast = apply_operation(_timeline(), SetClipSpeed(clip_id="A", speed=2))
    clip = _clips(fast, "v")[0]
    assert clip.speed == 2 and clip.end == 2.0  # 4s of source at 2x
    reset = apply_operation(fast, SetClipSpeed(clip_id="A", speed=None))
    clip = _clips(reset, "v")[0]
    assert clip.speed is None and clip.end == 4.0


def test_set_clip_speed_canonicalizes_1x_as_absent() -> None:
    unity = apply_operation(_timeline(), SetClipSpeed(clip_id="A", speed=1.0))
    assert _clips(unity, "v")[0].speed is None


def test_set_clip_speed_source_end_none_treated_as_1to1() -> None:
    timeline = Timeline(
        tracks=[
            Track(
                id="v",
                type=TrackType.VIDEO,
                clips=[_clip("A", "v", 0, 4).model_copy(update={"source_end": None})],
            )
        ]
    )
    slowed = apply_operation(timeline, SetClipSpeed(clip_id="A", speed=0.5))
    assert _clips(slowed, "v")[0].end == 8.0


def _reorder_timeline() -> Timeline:
    """Five clips of unequal length butted end to end — the montage shape of the run."""
    return Timeline(
        tracks=[
            Track(
                id="v",
                type=TrackType.VIDEO,
                clips=[
                    _clip("c1", "v", 0, 2),
                    _clip("c2", "v", 2, 5),
                    _clip("c3", "v", 5, 6),
                    _clip("c4", "v", 6, 10),
                    _clip("c5", "v", 10, 11),
                ],
            )
        ]
    )


def test_reorder_clips_moves_the_last_clip_first_without_losing_any() -> None:
    before = _reorder_timeline()
    after = apply_operation(
        before, ReorderClips(track_id="v", clip_ids=["c5", "c1", "c2", "c3", "c4"]), fps=30
    )
    assert [c.id for c in _clips(after, "v")] == ["c5", "c1", "c2", "c3", "c4"]
    assert len(_clips(after, "v")) == len(_clips(before, "v"))


def test_reorder_clips_is_gapless_on_the_grid_and_matches_ts() -> None:
    after = apply_operation(
        _reorder_timeline(),
        ReorderClips(track_id="v", clip_ids=["c5", "c1", "c2", "c3", "c4"]),
        fps=30,
    )
    assert [(c.start, c.end) for c in _clips(after, "v")] == [
        (0.0, 1.0),
        (1.0, 3.0),
        (3.0, 6.0),
        (6.0, 7.0),
        (7.0, 11.0),
    ]


def test_reorder_clips_anchors_at_the_earliest_start_not_at_zero() -> None:
    timeline = Timeline(
        tracks=[
            Track(
                id="v", type=TrackType.VIDEO, clips=[_clip("a", "v", 4, 6), _clip("b", "v", 6, 7)]
            )
        ]
    )
    after = apply_operation(timeline, ReorderClips(track_id="v", clip_ids=["b", "a"]), fps=30)
    assert [(c.start, c.end) for c in _clips(after, "v")] == [(4.0, 5.0), (5.0, 7.0)]


def test_reorder_clips_refuses_a_partial_list_and_names_the_omissions() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(_reorder_timeline(), ReorderClips(track_id="v", clip_ids=["c5", "c1"]))
    assert exc.value.code == "invalid_order"
    assert "Missing: c2, c3, c4" in str(exc.value)


def test_reorder_clips_refuses_a_duplicate_and_an_unknown_clip() -> None:
    with pytest.raises(OperationError) as dup:
        apply_operation(
            _reorder_timeline(),
            ReorderClips(track_id="v", clip_ids=["c1", "c1", "c2", "c3", "c4"]),
        )
    assert dup.value.code == "invalid_order"
    with pytest.raises(OperationError) as unknown:
        apply_operation(
            _reorder_timeline(),
            ReorderClips(track_id="v", clip_ids=["c9", "c1", "c2", "c3", "c4"]),
        )
    assert unknown.value.code == "missing_clip"


def test_reorder_clips_round_trips() -> None:
    _roundtrip(
        ReorderClips(track_id="v", clip_ids=["c5", "c4", "c3", "c2", "c1"]), _reorder_timeline()
    )


def test_set_clip_speed_off_grid_without_fps_matches_the_ts_default() -> None:
    """No fps means the pre-grid arithmetic, unchanged — the TS default too."""
    fast = apply_operation(_timeline(), SetClipSpeed(clip_id="A", speed=1.3))
    assert _clips(fast, "v")[0].end == pytest.approx(4 / 1.3, abs=1e-12)


def test_set_clip_speed_snaps_the_retimed_end_to_the_project_grid() -> None:
    """Mirror of ``retime-frame-grid.test.ts``: 4s of source at 1.3x on a 30fps grid."""
    fast = apply_operation(_timeline(), SetClipSpeed(clip_id="A", speed=1.3), fps=30)
    end = _clips(fast, "v")[0].end
    assert end == pytest.approx(92 / 30, abs=1e-12)
    assert is_on_frame_grid(end, 30)


def test_set_clip_speed_never_collapses_the_clip_at_an_extreme_rate() -> None:
    frozen = apply_operation(_timeline(), SetClipSpeed(clip_id="A", speed=600), fps=30)
    clip = _clips(frozen, "v")[0]
    assert clip.end > clip.start
    assert clip.end - clip.start == pytest.approx(1 / 30, abs=1e-12)


@pytest.mark.parametrize("bad", [0, -1, float("inf"), float("nan")])
def test_set_clip_speed_rejects_nonpositive_or_nonfinite(bad: float) -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(_timeline(), SetClipSpeed(clip_id="A", speed=bad))
    assert exc.value.code == "invalid_speed"


def test_set_clip_crop_sets_and_clears() -> None:
    rect = CropRect(x=0.25, y=0.0, width=0.5, height=1.0)
    cropped = apply_operation(_timeline(), SetClipCrop(clip_id="A", crop=rect))
    assert _clips(cropped, "v")[0].crop == rect
    cleared = apply_operation(cropped, SetClipCrop(clip_id="A", crop=None))
    assert _clips(cleared, "v")[0].crop is None


def test_set_clip_blend_mode_sets_and_canonicalizes_normal() -> None:
    lit = apply_operation(_timeline(), SetClipBlendMode(clip_id="A", blend_mode=BlendMode.SCREEN))
    assert _clips(lit, "v")[0].blend_mode == BlendMode.SCREEN
    normal = apply_operation(lit, SetClipBlendMode(clip_id="A", blend_mode=BlendMode.NORMAL))
    assert _clips(normal, "v")[0].blend_mode is None


def test_add_layer_inserts_at_clamped_index() -> None:
    fronted = apply_operation(
        _timeline(), AddLayer(layer_id="new", layer_type=TrackType.OVERLAY, at_index=0)
    )
    assert next(t.id for t in fronted.tracks) == "new"
    appended = apply_operation(
        _timeline(), AddLayer(layer_id="new", layer_type=TrackType.OVERLAY, at_index=99)
    )
    assert [t.id for t in appended.tracks][-1] == "new"


def test_add_layer_restores_clips_when_given() -> None:
    populated = apply_operation(
        _timeline(),
        AddLayer(
            layer_id="new",
            layer_type=TrackType.VIDEO,
            at_index=1,
            clips=[_clip("Z", "new", 0, 1)],
        ),
    )
    assert [c.id for c in _clips(populated, "new")] == ["Z"]


def test_add_layer_duplicate_id_raises() -> None:
    with pytest.raises(OperationError) as exc:
        apply_operation(_timeline(), AddLayer(layer_id="v", layer_type=TrackType.VIDEO, at_index=0))
    assert exc.value.code == "duplicate_layer"


def test_remove_layer_removes_track() -> None:
    removed = apply_operation(_timeline(), RemoveLayer(layer_id="a"))
    assert [t.id for t in removed.tracks] == ["v", "ov", "cap"]


def test_move_layer_reorders_with_clamp() -> None:
    moved = apply_operation(_timeline(), MoveLayer(layer_id="cap", to_index=0))
    assert [t.id for t in moved.tracks] == ["cap", "v", "a", "ov"]
    clamped = apply_operation(_timeline(), MoveLayer(layer_id="v", to_index=99))
    assert [t.id for t in clamped.tracks] == ["a", "ov", "cap", "v"]


@pytest.mark.parametrize(
    "op",
    [
        SetCaptionStyle(
            clip_id="A", caption_style=CaptionStyle.model_validate({"fontFamily": "Inter"})
        ),
        SetCaptionStyle(clip_id="A", caption_style=None),
        SetClipSpeed(clip_id="A", speed=2),
        SetClipSpeed(clip_id="A", speed=None),
        SetClipCrop(clip_id="A", crop=CropRect(x=0.1, y=0.1, width=0.5, height=0.5)),
        SetClipCrop(clip_id="A", crop=None),
        SetClipBlendMode(clip_id="A", blend_mode=BlendMode.MULTIPLY),
        SetClipBlendMode(clip_id="A", blend_mode=None),
        AddLayer(layer_id="new", layer_type=TrackType.OVERLAY, at_index=1),
        AddLayer(
            layer_id="new",
            layer_type=TrackType.VIDEO,
            at_index=2,
            clips=[_clip("Z", "new", 0, 1)],
        ),
        RemoveLayer(layer_id="a"),
        RemoveLayer(layer_id="v"),  # populated layer restores with its clips
        MoveLayer(layer_id="cap", to_index=0),
        MoveLayer(layer_id="v", to_index=3),
    ],
)
def test_new_operation_roundtrips(op: Operation) -> None:
    _roundtrip(op)


def test_speed_ramp_keep_duration_fits_the_curve_into_the_slot() -> None:
    """``keepDuration`` keeps ``end`` and moves the source out point (run cc907070).

    A ramp inside a timed cut used to recompute the clip's length and run into its
    neighbour; fitted, the neighbour is untouched and half speed over 4s of timeline
    consumes 2s of footage. Mirrors ``operations.test.ts``.
    """
    from framepilot_engine.timeline.operations import SetClipSpeedRamp

    ramp = [
        {"id": "p1", "sourceTime": 0.0, "rate": 0.5, "easing": "linear"},
        {"id": "p2", "sourceTime": 4.0, "rate": 0.5, "easing": "linear"},
    ]
    op = SetClipSpeedRamp.model_validate(
        {"type": "set_clip_speed_ramp", "clipId": "A", "ramp": ramp, "keepDuration": True}
    )
    after = apply_operation(_timeline(), op)
    a = next(c for c in _clips(after, "v") if c.id == "A")
    assert (a.start, a.end) == (0.0, 4.0)
    assert a.source_end is not None
    assert a.source_end - a.source_start == pytest.approx(2.0, abs=1e-4)
    b = next(c for c in _clips(after, "v") if c.id == "B")
    assert (b.start, b.end) == (5.0, 9.0)
    # Without the flag the length follows the curve, exactly as before.
    grown = apply_operation(
        _timeline(),
        SetClipSpeedRamp.model_validate(
            {"type": "set_clip_speed_ramp", "clipId": "A", "ramp": ramp}
        ),
    )
    grown_a = next(c for c in _clips(grown, "v") if c.id == "A")
    assert grown_a.end == pytest.approx(8.0, abs=1e-6)
