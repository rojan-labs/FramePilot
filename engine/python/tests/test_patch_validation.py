"""Tests for patch validation (PRD §8.5, PLAN §1.4)."""

from __future__ import annotations

from types import SimpleNamespace

from framepilot_engine.timeline.models import (
    BlendMode,
    Clip,
    CropRect,
    Effect,
    Timeline,
    Track,
    TrackType,
)
from framepilot_engine.timeline.operations import (
    AddCaptionLayer,
    AddClip,
    AddLayer,
    AddTextOverlay,
    AdjustAudio,
    ApplyColorGrade,
    DeleteRange,
    MoveLayer,
    Operation,
    RemoveLayer,
    RestoreClips,
    SetCaptionStyle,
    SetClipBlendMode,
    SetClipCrop,
    SetClipSpeed,
    SetEffectParams,
    TrimClip,
)
from framepilot_engine.validation.patch_validation import validate_patch


def _clip(cid: str, track: str, start: float, end: float) -> Clip:
    return Clip.model_validate(
        {
            "id": cid,
            "assetId": "vid",
            "trackId": track,
            "start": start,
            "end": end,
            "sourceStart": 0.0,
            "sourceEnd": end - start,
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


def _codes(result: object) -> set[str]:
    return {i.code for i in result.issues}  # type: ignore[attr-defined]


def test_valid_patch_passes() -> None:
    result = validate_patch(_timeline(), [TrimClip(clip_id="A", start=1, end=3)])
    assert result.valid and result.issues == []


def test_unsupported_operation_rejected() -> None:
    bogus = SimpleNamespace(type="frobnicate")
    result = validate_patch(_timeline(), [bogus])  # type: ignore[list-item]
    assert not result.valid
    assert "unsupported_operation" in _codes(result)


def test_missing_reference_from_replay() -> None:
    result = validate_patch(_timeline(), [TrimClip(clip_id="ghost", start=0, end=1)])
    assert not result.valid and "missing_reference" in _codes(result)


def test_negative_duration_from_replay() -> None:
    result = validate_patch(_timeline(), [TrimClip(clip_id="A", start=2, end=2)])
    assert "negative_duration" in _codes(result)


def test_overlap_detected_after_apply() -> None:
    # Move nothing, but add a clip that overlaps A on the video track.
    op = AddClip(track_id="v", asset_id="vid", start=1, end=3, source_start=0, source_end=2)
    result = validate_patch(_timeline(), [op], asset_ids=["vid"])
    assert not result.valid and "overlap_error" in _codes(result)


def test_duplicate_clip_maps_to_overlap_error() -> None:
    op = AddClip(
        track_id="v",
        asset_id="vid",
        start=10,
        end=12,
        source_start=0,
        source_end=2,
        clip_id="A",
    )
    result = validate_patch(_timeline(), [op], asset_ids=["vid"])
    assert "overlap_error" in _codes(result)


def test_text_overlay_on_any_layer_is_allowed() -> None:
    # Phase 2 (ADR 0032): layers are type-agnostic — text may live on a 'video' layer.
    result = validate_patch(_timeline(), [AddTextOverlay(track_id="v", text="x", start=10, end=11)])
    assert "invalid_layer_order" not in _codes(result)


def test_caption_on_any_layer_is_allowed() -> None:
    result = validate_patch(_timeline(), [AddCaptionLayer(track_id="v", start=10, end=11)])
    assert "invalid_layer_order" not in _codes(result)


def test_overlay_on_overlay_track_ok() -> None:
    result = validate_patch(_timeline(), [AddTextOverlay(track_id="ov", text="x", start=0, end=2)])
    assert result.valid


def test_caption_on_caption_track_ok() -> None:
    result = validate_patch(_timeline(), [AddCaptionLayer(track_id="cap", start=0, end=2)])
    assert result.valid


def test_missing_asset_when_assetids_given() -> None:
    op = AddClip(track_id="v", asset_id="unknown", start=10, end=12, source_start=0, source_end=2)
    result = validate_patch(_timeline(), [op], asset_ids=["vid"])
    assert not result.valid and "missing_asset" in _codes(result)


def test_missing_asset_skipped_without_assetids() -> None:
    op = AddClip(track_id="v", asset_id="unknown", start=10, end=12, source_start=0, source_end=2)
    result = validate_patch(_timeline(), [op])  # no asset_ids → skip the check
    assert "missing_asset" not in _codes(result)


def test_unsupported_color_grade_effect() -> None:
    op = ApplyColorGrade(clip_id="A", effect=Effect(id="e", type="cartoonify", params={}))
    result = validate_patch(_timeline(), [op])
    assert "unsupported_effect" in _codes(result)


def test_supported_color_grade_effect_ok() -> None:
    op = ApplyColorGrade(clip_id="A", effect=Effect(id="e", type="lut", params={}))
    result = validate_patch(_timeline(), [op])
    assert result.valid


def test_broken_audio_link_on_caption_track() -> None:
    # Put a clip on the caption track, then try to adjust its audio.
    timeline = _timeline()
    timeline.tracks[3].clips.append(_clip("CAP1", "cap", 0, 2))
    result = validate_patch(timeline, [AdjustAudio(clip_id="CAP1", gain_db=-3)])
    assert "broken_audio_link" in _codes(result)


def test_adjust_audio_on_video_track_ok() -> None:
    result = validate_patch(_timeline(), [AdjustAudio(clip_id="A", gain_db=-3)])
    assert result.valid


def test_adjust_audio_rejects_invalid_sidechain_links() -> None:
    no_track = validate_patch(
        _timeline(), [AdjustAudio(clip_id="AU", gain_db=-3, duck_amount_db=-12)]
    )
    own_track = validate_patch(
        _timeline(),
        [AdjustAudio(clip_id="AU", gain_db=-3, duck_under_track_id="a", duck_amount_db=-12)],
    )
    assert "broken_audio_link" in _codes(no_track)
    assert "broken_audio_link" in _codes(own_track)


def test_validation_advances_state_across_ops() -> None:
    # First op deletes A's range; second trims B — both must validate in sequence.
    ops: list[Operation] = [
        DeleteRange(track_id="v", start=0, end=4),
        TrimClip(clip_id="B", start=5, end=7),
    ]
    result = validate_patch(_timeline(), ops)
    assert result.valid


# --- v5-v8 styling ops, set_effect_params, layer ops (TS parity) --------------


def test_new_ops_validate_and_advance_state() -> None:
    ops: list[Operation] = [
        AddLayer(layer_id="pip", layer_type=TrackType.VIDEO, at_index=0),
        MoveLayer(layer_id="pip", to_index=2),
        SetClipSpeed(clip_id="A", speed=2),
        SetClipCrop(clip_id="A", crop=CropRect(x=0.25, y=0.0, width=0.5, height=1.0)),
        SetClipBlendMode(clip_id="A", blend_mode=BlendMode.SCREEN),
        SetCaptionStyle(clip_id="A", caption_style=None),
        RemoveLayer(layer_id="pip"),
    ]
    result = validate_patch(_timeline(), ops)
    assert result.valid, result.issues


def test_duplicate_layer_maps_to_duplicate_layer_code() -> None:
    result = validate_patch(
        _timeline(), [AddLayer(layer_id="v", layer_type=TrackType.VIDEO, at_index=0)]
    )
    assert not result.valid and "duplicate_layer" in _codes(result)


def test_invalid_speed_maps_to_invalid_speed_code() -> None:
    result = validate_patch(_timeline(), [SetClipSpeed(clip_id="A", speed=-2)])
    assert not result.valid and "invalid_speed" in _codes(result)


def test_missing_effect_maps_to_missing_reference() -> None:
    result = validate_patch(
        _timeline(), [SetEffectParams(clip_id="A", effect_id="ghost", params={})]
    )
    assert not result.valid and "missing_reference" in _codes(result)


def test_speed_duration_mismatch_detected_on_inconsistent_clip() -> None:
    # A hand-crafted clip whose fields disagree (4s of timeline for 4s of source
    # at 2x) is rejected no matter which op smuggles it in — here restore_clips.
    bad = _clip("X", "v", 0, 4).model_copy(update={"speed": 2.0})
    result = validate_patch(_timeline(), [RestoreClips(track_id="v", clips=[bad])])
    assert not result.valid and "speed_duration_mismatch" in _codes(result)


def test_speed_check_skips_clip_without_source_end() -> None:
    loose = _clip("X", "v", 0, 4).model_copy(update={"source_end": None, "speed": 2.0})
    result = validate_patch(_timeline(), [RestoreClips(track_id="v", clips=[loose])])
    assert result.valid, result.issues


def test_layer_ops_missing_track_map_to_missing_reference() -> None:
    for op in (RemoveLayer(layer_id="ghost"), MoveLayer(layer_id="ghost", to_index=0)):
        result = validate_patch(_timeline(), [op])
        assert not result.valid and "missing_reference" in _codes(result)
