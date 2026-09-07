"""Edge operations are speed-aware (schema v15, ADR 0090).

The Python mirror of ``packages/editor-core/src/operations.test.ts``'s
"edge ops are speed-aware" and "trimming re-bases clip-relative keyframes" suites.

WHY a whole file: ``trim_clip``, ``split_clip``, ``delete_range`` and
``ripple_delete`` used to move a clip's source in/out by the same delta as its
timeline edges, which is only correct at 1x. On a retimed clip that breaks ADR 0046's
duration invariant, so the engine's own validator rejected patches the TS authority
had already accepted — the two runtimes disagreed precisely across the speed feature
set (constant, freeze, reverse, ramp) the stack otherwise supports.
"""

from __future__ import annotations

from framepilot_engine.effects.keyframes import evaluate_keyframes
from framepilot_engine.effects.speed_curve import clip_timeline_duration
from framepilot_engine.timeline.models import (
    Clip,
    Keyframe,
    SpeedPoint,
    Timeline,
    Track,
    TrackType,
)
from framepilot_engine.timeline.operations import (
    TEXT_OVERLAY_ASSET_ID,
    DeleteRange,
    RippleDelete,
    SetClipSpeedRamp,
    SplitClip,
    TrimClip,
    apply_operation,
    invert_operation,
)


def _clip(cid: str, start: float, end: float, **extra: object) -> Clip:
    return Clip.model_validate(
        {
            "id": cid,
            "assetId": "vid",
            "trackId": "video_1",
            "start": start,
            "end": end,
            "sourceStart": 0.0,
            "sourceEnd": end - start,
            **extra,
        }
    )


def _one(*clips: Clip) -> Timeline:
    return Timeline(tracks=[Track(id="video_1", type=TrackType.VIDEO, clips=list(clips))])


def _find(timeline: Timeline, clip_id: str) -> Clip:
    return next(c for t in timeline.tracks for c in t.clips if c.id == clip_id)


def _sped() -> Timeline:
    """A 2x clip: 10s of source in 5s of timeline."""
    return _one(_clip("a", 0, 5, sourceStart=0, sourceEnd=10, speed=2))


def _ramped(points: list[dict[str, object]], clip: Clip) -> Timeline:
    """A ramped clip built THROUGH the op, so its ``end`` is derived from the curve.

    Writing the ramp straight into a fixture would leave a clip whose stored duration
    contradicts its own curve — a state the validator rejects and the product can
    never reach.
    """
    return apply_operation(
        _one(clip),
        SetClipSpeedRamp(
            clip_id=clip.id,
            ramp=[SpeedPoint.model_validate(p) for p in points],
            keep_duration=False,
        ),
    )


# --- constant speed ----------------------------------------------------------


def test_trim_rescales_the_source_delta_by_the_speed() -> None:
    after = apply_operation(_sped(), TrimClip(clip_id="a", start=1, end=4))
    a = _find(after, "a")
    assert (a.start, a.end) == (1, 4)
    # 1s of timeline at 2x consumes 2s of source, from both ends.
    assert (a.source_start, a.source_end) == (2, 8)
    assert clip_timeline_duration(a) == a.end - a.start


def test_trim_handles_an_extension_where_the_delta_is_negative() -> None:
    timeline = _one(_clip("a", 5, 10, sourceStart=4, sourceEnd=14, speed=2))
    after = apply_operation(timeline, TrimClip(clip_id="a", start=4, end=10))
    a = _find(after, "a")
    assert a.source_start == 2  # extended 1s at 2x -> 2s more source
    assert clip_timeline_duration(a) == a.end - a.start


def test_split_divides_the_source_range_through_the_speed() -> None:
    after = apply_operation(_sped(), SplitClip(clip_id="a", at=2))
    left, right = after.tracks[0].clips
    assert left.source_end == 4  # 2s of timeline at 2x = 4s of source
    assert right.source_start == 4
    for half in (left, right):
        # Each half stays internally consistent, which is what the validator checks.
        assert abs((clip_timeline_duration(half) or 0.0) - (half.end - half.start)) < 1e-9


def test_delete_range_consumes_a_sped_clips_footage_through_its_speed() -> None:
    after = apply_operation(_sped(), DeleteRange(track_id="video_1", start=1, end=2))
    left, right = after.tracks[0].clips
    assert (left.source_start, left.source_end) == (0, 2)
    assert (right.source_start, right.source_end) == (4, 10)
    for piece in (left, right):
        assert abs((clip_timeline_duration(piece) or 0.0) - (piece.end - piece.start)) < 1e-9


def test_ripple_delete_keeps_a_sped_clip_consistent_after_closing_the_gap() -> None:
    after = apply_operation(_sped(), RippleDelete(track_id="video_1", start=0, end=1))
    a = _find(after, "a")
    assert (a.start, a.end) == (0, 4)
    assert (a.source_start, a.source_end) == (2, 10)
    assert clip_timeline_duration(a) == a.end - a.start


def test_freeze_frames_source_range_is_left_alone_when_trimmed() -> None:
    # A held frame consumes no footage however long it is held; consuming source
    # proportionally would shrink the range to nothing and make a freeze untrimmable.
    frozen = _one(_clip("a", 0, 6, sourceStart=3, sourceEnd=3.04, speed=0))
    after = apply_operation(frozen, TrimClip(clip_id="a", start=1, end=4))
    a = _find(after, "a")
    assert (a.start, a.end) == (1, 4)
    assert (a.source_start, a.source_end) == (3, 3.04)


def test_reversed_clip_consumes_its_footage_from_the_correct_end() -> None:
    # Trimming the timeline HEAD of a reversed clip consumes source from the source
    # END. Getting this backwards is invisible in the duration check and obvious in
    # the picture.
    reversed_clip = _one(_clip("a", 0, 10, sourceStart=0, sourceEnd=10, speed=-1))
    after = apply_operation(reversed_clip, TrimClip(clip_id="a", start=2, end=10))
    a = _find(after, "a")
    assert (a.source_start, a.source_end) == (0, 8)


# --- ramps -------------------------------------------------------------------


def test_split_of_a_ramped_clip_cuts_at_the_right_frame_not_the_linear_midpoint() -> None:
    ramped = _ramped(
        [
            {"id": "p1", "sourceTime": 0, "rate": 0.5, "easing": "linear"},
            {"id": "p2", "sourceTime": 10, "rate": 4, "easing": "linear"},
        ],
        _clip("a", 0, 10, sourceStart=0, sourceEnd=10),
    )
    total = _find(ramped, "a")
    after = apply_operation(ramped, SplitClip(clip_id="a", at=(total.end - total.start) / 2))
    left, right = after.tracks[0].clips
    assert left.source_end is not None and right.source_end is not None
    # The slow half consumes far LESS than half the footage.
    assert left.source_end - left.source_start < 5
    # The two halves still account for exactly the whole source range.
    assert left.source_start == 0
    assert abs(right.source_end - 10) < 1e-6
    assert abs(right.source_start - left.source_end) < 1e-9
    # The right half's ramp is RE-BASED — without which both halves would carry the
    # whole original curve and each render the wrong speeds.
    assert right.speed_ramp is not None
    assert right.speed_ramp[0].source_time == 0
    assert right.speed_ramp[0].rate > 0.5
    # And neither half keeps a point outside its own source span, which the
    # validator refuses.
    for piece in (left, right):
        span = (piece.source_end or 0.0) - piece.source_start
        for point in piece.speed_ramp or []:
            assert -1e-6 <= point.source_time <= span + 1e-6


def test_extending_a_ramped_clip_past_its_footage_uses_the_held_end_rate() -> None:
    ramped = _ramped(
        [
            {"id": "p1", "sourceTime": 0, "rate": 2, "easing": "linear"},
            {"id": "p2", "sourceTime": 10, "rate": 2, "easing": "linear"},
        ],
        _clip("a", 0, 10, sourceStart=0, sourceEnd=10),
    )
    before = _find(ramped, "a")
    assert abs((before.end - before.start) - 5) < 1e-6  # 10s source / 2x
    after = apply_operation(ramped, TrimClip(clip_id="a", start=before.start, end=before.end + 1))
    a = _find(after, "a")
    # The whole 10s of source is already spent by ``before.end``; the extra second of
    # timeline is priced at the rate held at the end of the curve, not re-derived from
    # an integral that has nothing left to give.
    assert a.source_end is not None and abs(a.source_end - (10 + 1 * 2)) < 1e-6


def test_extending_a_ramped_clip_backward_uses_the_held_start_rate() -> None:
    ramped = _ramped(
        [
            {"id": "p1", "sourceTime": 0, "rate": 2, "easing": "linear"},
            {"id": "p2", "sourceTime": 10, "rate": 2, "easing": "linear"},
        ],
        _clip("a", 5, 15, sourceStart=4, sourceEnd=14),
    )
    before = _find(ramped, "a")
    after = apply_operation(ramped, TrimClip(clip_id="a", start=before.start - 1, end=before.end))
    a = _find(after, "a")
    # 1s earlier at the held start rate (2x) reaches 2s before the clip's own source
    # start — a negative timeline delta, priced outside the (source-only) integral.
    assert abs(a.source_start - (4 - 1 * 2)) < 1e-9


def test_head_trim_rebases_a_ramp_instead_of_sliding_it_along_the_footage() -> None:
    ramped = _ramped(
        [
            {"id": "p1", "sourceTime": 0, "rate": 1, "easing": "linear"},
            {"id": "p2", "sourceTime": 4, "rate": 0.25, "easing": "linear"},
            {"id": "p3", "sourceTime": 8, "rate": 1, "easing": "linear"},
        ],
        _clip("a", 0, 8, sourceStart=0, sourceEnd=8),
    )
    before = _find(ramped, "a")
    after = apply_operation(ramped, TrimClip(clip_id="a", start=1, end=before.end))
    a = _find(after, "a")
    assert a.speed_ramp is not None
    consumed = a.source_start - before.source_start
    # The slow-motion moment stays anchored to the SAME footage: its source time
    # moves back by exactly what the head trim consumed.
    slow = next(p for p in a.speed_ramp if p.rate == 0.25)
    assert abs(slow.source_time - (4 - consumed)) < 1e-6
    # The points now before the new origin become ONE synthetic point carrying the
    # rate at the cut, so the head of the clip keeps the speed it had.
    assert a.speed_ramp[0].source_time == 0
    assert a.speed_ramp[0].id == "a__ramp_head"
    assert 0.25 < a.speed_ramp[0].rate < 1


# --- keyframes ---------------------------------------------------------------


def _animated() -> Timeline:
    """A clip animating ``scale`` 1 -> 2 across 0-4s of its own timeline."""
    return _one(
        _clip(
            "a",
            0,
            10,
            sourceStart=0,
            sourceEnd=10,
            keyframes=[
                Keyframe(id="k0", property="scale", time=0, value=1, easing="linear"),
                Keyframe(id="k4", property="scale", time=4, value=2, easing="linear"),
            ],
        )
    )


def _scale_at(timeline: Timeline, clip_time: float) -> float | None:
    return evaluate_keyframes(_find(timeline, "a").keyframes, "scale", clip_time)


def test_head_trim_keeps_the_animation_locked_to_the_footage() -> None:
    # REGRESSION: keyframe times are clip-relative, and truncation used to move only
    # start/end. A keyframe 4s into the clip stayed "4s in" after a 3s head trim — one
    # second later in the FOOTAGE than where it was put.
    after = apply_operation(_animated(), TrimClip(clip_id="a", start=3, end=10))
    keyframes = _find(after, "a").keyframes
    assert [k.time for k in keyframes] == [0, 1]
    # The frame that showed scale 2 still shows scale 2.
    assert _scale_at(after, 1) == 2


def test_head_trim_preserves_the_visible_curve_rather_than_flattening_it() -> None:
    # The keyframe now before the clip start is RESAMPLED, not dropped: the evaluator
    # interpolates from the preceding point, so losing it would open the clip on a
    # flat value instead of partway up the ramp.
    after = apply_operation(_animated(), TrimClip(clip_id="a", start=2, end=10))
    assert _scale_at(after, 0) == 1.5
    first = _find(after, "a").keyframes[0]
    assert (first.time, first.value) == (0, 1.5)


def test_tail_only_trim_leaves_keyframes_alone() -> None:
    after = apply_operation(_animated(), TrimClip(clip_id="a", start=0, end=6))
    assert [k.time for k in _find(after, "a").keyframes] == [0, 4]


def test_ripple_delete_rebases_keyframes_through_the_same_path() -> None:
    after = apply_operation(_animated(), RippleDelete(track_id="video_1", start=0, end=3))
    assert [k.time for k in _find(after, "a").keyframes] == [0, 1]


def test_trim_of_an_animated_clip_still_round_trips_through_its_inverse() -> None:
    before = _animated()
    op = TrimClip(clip_id="a", start=3, end=10)
    restored = apply_operation(before, op)
    for inverse in invert_operation(before, op):
        restored = apply_operation(restored, inverse)
    assert restored == before


# --- clips with no time-based source -----------------------------------------


def test_a_text_overlay_trims_in_both_directions() -> None:
    # A text overlay is generated at render time, so ``source_start: 0`` means
    # "nothing to say", not "the file starts here". Treating that 0 as a real in-point
    # made an overlay extendable forwards and immovable backwards.
    overlay = Timeline(
        tracks=[
            Track(
                id="video_1",
                type=TrackType.OVERLAY,
                clips=[_clip("t", 2, 4, assetId=TEXT_OVERLAY_ASSET_ID)],
            )
        ]
    )
    after = apply_operation(overlay, TrimClip(clip_id="t", start=0, end=4))
    t = _find(after, "t")
    assert (t.start, t.end) == (0, 4)
    assert (t.source_start, t.source_end) == (0, 4)
