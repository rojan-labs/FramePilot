"""AL42 / #156: the Python validator mirrors ``source_past_media_end``.

The TS twin is ``packages/editor-core/src/validator.media-end.test.ts``; the cases and the
message are the same.
"""

from __future__ import annotations

from framepilot_engine.timeline.models import Asset, Clip, Timeline, Track, TrackType
from framepilot_engine.timeline.operations import (
    AddClip,
    MoveClip,
    Operation,
    RestoreClips,
    SetClipSpeed,
    SplitClip,
    TrimClip,
)
from framepilot_engine.validation.patch_validation import (
    ValidationResult,
    media_length_seconds,
    validate_patch,
)

_FPS = 30.0
_WHOOSH = Asset.model_validate(
    {"id": "whoosh", "path": "media/Swipe_Whoosh.mp3", "kind": "audio", "durationSeconds": 0.447506}
)
_SHOT = Asset.model_validate(
    {"id": "shot", "path": "media/shot.mp4", "kind": "video", "durationSeconds": 4.0}
)
_PHOTO = Asset.model_validate(
    {"id": "photo", "path": "media/p.png", "kind": "image", "durationSeconds": 0.2}
)
_UNPROBED = Asset.model_validate({"id": "raw", "path": "media/raw.wav", "kind": "audio"})
_ASSETS = [_WHOOSH, _SHOT, _PHOTO, _UNPROBED]


def _clip(cid: str, track: str, asset: str, end: float) -> Clip:
    return Clip.model_validate(
        {
            "id": cid,
            "assetId": asset,
            "trackId": track,
            "start": 0.0,
            "end": end,
            "sourceStart": 0.0,
            "sourceEnd": end,
        }
    )


def _timeline(sfx: list[Clip] | None = None, picture: list[Clip] | None = None) -> Timeline:
    return Timeline(
        tracks=[
            Track(id="v", type=TrackType.VIDEO, clips=picture or []),
            Track(id="sfx", type=TrackType.AUDIO, clips=sfx or []),
        ]
    )


def _validate(ops: list[Operation], timeline: Timeline | None = None) -> ValidationResult:
    return validate_patch(timeline or _timeline(), ops, assets=_ASSETS, fps=_FPS)


def _place(asset: str, source_end: float, start: float = 2.0) -> AddClip:
    return AddClip(
        track_id="sfx",
        asset_id=asset,
        clip_id="placed",
        start=start,
        end=start + source_end,
        source_start=0.0,
        source_end=source_end,
    )


def test_refuses_a_clip_placed_past_its_audio_with_the_length_and_the_fix() -> None:
    result = _validate([_place("whoosh", 1.0)])
    assert not result.valid
    [issue] = result.issues
    assert issue.code == "source_past_media_end"
    assert issue.operation_index == 0
    # Byte-for-byte the TS message, so either validator's refusal reads the same.
    assert issue.message == (
        "Clip 'placed' reads past the end of asset 'whoosh', which is 0.448s long. "
        "Its source range must end by 0.448s: trim it with trim_clip, place it shorter, "
        "or slow it down, so the clip plays no more of the asset than it holds."
    )


def test_the_message_does_not_carry_the_overrun() -> None:
    first = _validate([_place("whoosh", 1.0)]).issues[0].message
    assert _validate([_place("whoosh", 0.9)]).issues[0].message == first


def test_allows_a_sub_frame_overrun() -> None:
    assert _validate([_place("whoosh", 14 / _FPS)]).valid


def test_refuses_a_trim_that_extends_a_video_clip_past_its_file() -> None:
    timeline = _timeline(picture=[_clip("c", "v", "shot", 3.0)])
    result = _validate([TrimClip(clip_id="c", start=0, end=5)], timeline)
    assert "source_past_media_end" in {issue.code for issue in result.issues}


def test_exempts_stills_unknown_lengths_and_callers_without_assets() -> None:
    assert media_length_seconds(_PHOTO) is None
    assert media_length_seconds(_UNPROBED) is None
    assert _validate([_place("photo", 1.0)]).valid
    assert _validate([_place("raw", 5.0)]).valid
    assert validate_patch(_timeline(), [_place("whoosh", 1.0)], fps=_FPS).valid


def test_a_legacy_overrun_can_still_be_split_moved_trimmed_and_restored() -> None:
    legacy = _clip("old", "sfx", "whoosh", 1.0)
    timeline = _timeline(sfx=[legacy])
    assert _validate([SplitClip(clip_id="old", at=0.5)], timeline).valid
    assert _validate([MoveClip(clip_id="old", to_track_id="sfx", to_start=3.0)], timeline).valid
    assert _validate([TrimClip(clip_id="old", start=0, end=0.8)], timeline).valid
    assert _validate([RestoreClips(track_id="sfx", clips=[legacy])]).valid


def test_a_legacy_overrun_does_not_excuse_a_clip_that_reads_further() -> None:
    timeline = _timeline(sfx=[_clip("old", "sfx", "whoosh", 1.0)])
    assert not _validate([_place("whoosh", 1.5, start=4.0)], timeline).valid


def test_refuses_the_issue_156_retime_that_reads_past_the_file() -> None:
    # A 4 s file placed as a 2 s clip from source 0.5 s, then 3x with the slot kept.
    clip = Clip.model_validate(
        {
            "id": "c",
            "assetId": "shot",
            "trackId": "v",
            "start": 0.0,
            "end": 2.0,
            "sourceStart": 0.5,
            "sourceEnd": 2.5,
        }
    )
    result = _validate(
        [
            SetClipSpeed(clip_id="c", speed=3.0),
            # Back to its 2 s slot: at 3x that reads 6 s of source, to 6.5 s.
            TrimClip(clip_id="c", start=0, end=2),
        ],
        _timeline(picture=[clip]),
    )
    assert "source_past_media_end" in {issue.code for issue in result.issues}
