"""Keyframe choice and answer normalisation — the pack's honesty rules."""

from __future__ import annotations

import pytest
from conftest import FakeDescribeBackend, answer, request_line

from framepilot_visual_describe.backend import DescribeFailedError
from framepilot_visual_describe.policy import (
    MIN_MULTI_FRAME_SPAN,
    describe_shots,
    keyframe_times,
    normalise,
)
from framepilot_visual_describe.protocol import (
    DescribeRequest,
    ProtocolError,
    ShotSpan,
    parse_input_line,
)


def _request() -> DescribeRequest:
    parsed = parse_input_line(request_line())
    assert isinstance(parsed, DescribeRequest)
    return parsed


class TestKeyframeTimes:
    def test_a_long_span_gets_first_middle_and_last(self) -> None:
        times = keyframe_times(ShotSpan(shot_index=0, t0=10.0, t1=20.0))
        assert len(times) == 3
        assert times == sorted(times)
        assert all(10.0 <= t < 20.0 for t in times)
        assert times[1] == pytest.approx(15.0)

    def test_a_short_span_gets_one_frame_at_its_midpoint(self) -> None:
        span = ShotSpan(shot_index=0, t0=4.0, t1=4.0 + MIN_MULTI_FRAME_SPAN / 2)
        assert keyframe_times(span) == [pytest.approx(4.0 + MIN_MULTI_FRAME_SPAN / 4)]

    def test_a_still_gets_one_frame(self) -> None:
        # A still is sampled as a one-second span by the host; one picture is all it has.
        assert len(keyframe_times(ShotSpan(shot_index=0, t0=0.0, t1=0.2))) == 1

    def test_every_time_stays_strictly_inside_the_span(self) -> None:
        span = ShotSpan(shot_index=0, t0=0.0, t1=0.6)
        times = keyframe_times(span)
        assert all(span.t0 <= t < span.t1 for t in times)

    def test_max_frames_is_honoured(self) -> None:
        span = ShotSpan(shot_index=0, t0=0.0, t1=10.0)
        assert len(keyframe_times(span, max_frames=1)) == 1
        assert len(keyframe_times(span, max_frames=2)) == 2

    def test_an_impossible_frame_count_is_a_programming_error(self) -> None:
        with pytest.raises(ValueError, match="max_frames must be"):
            keyframe_times(ShotSpan(shot_index=0, t0=0.0, t1=1.0), max_frames=9)


class TestNormalise:
    def test_a_well_formed_answer_survives_intact(self) -> None:
        described = normalise(answer(), 3)
        assert described.shot_index == 3
        assert described.camera.shot_size == "MS"
        assert described.quality == ("well-lit",)

    def test_out_of_vocabulary_quality_is_dropped_never_mapped(self) -> None:
        described = normalise(answer(quality=["well-lit", "cinematic", "well-lit"]), 0)
        assert described.quality == ("well-lit",)

    def test_unknown_camera_values_become_absent(self) -> None:
        described = normalise(
            answer(camera={"shotSize": "unknown", "angle": "sideways", "movement": "pan"}), 0
        )
        assert described.camera.shot_size is None
        assert described.camera.angle is None
        assert described.camera.movement == "pan"

    def test_on_screen_text_is_kept_verbatim(self) -> None:
        described = normalise(answer(onScreenText=["Ship  it", "  ", 7]), 0)
        assert described.on_screen_text == ("Ship it",)

    def test_on_screen_text_drops_a_decoder_stutter(self) -> None:
        # Measured on SmolVLM2-2.2B against `workers/visual-describe/eval/media/slate.mp4`, a
        # card reading "SCENE 4 TAKE 2": the constrained decoder filled the array to its bound
        # with SIXTEEN identical copies rather than closing it. The bound stops the runaway; it
        # does not make the value useful, and quoting a stutter back to the editor as sixteen
        # separate readings is not what "verbatim" promises.
        described = normalise(answer(onScreenText=["SCENE 4 TAKE 2"] * 16), 0)
        assert described.on_screen_text == ("SCENE 4 TAKE 2",)
        keeps_both = normalise(answer(onScreenText=["TOP", "TOP", "BOTTOM", "TOP"]), 0)
        assert keeps_both.on_screen_text == ("TOP", "BOTTOM")

    def test_a_missing_summary_is_not_a_description(self) -> None:
        with pytest.raises(DescribeFailedError, match="no summary"):
            normalise(answer(summary="   "), 0)

    def test_a_non_object_answer_is_refused(self) -> None:
        with pytest.raises(DescribeFailedError, match="did not return an object"):
            normalise("A man at a desk.", 0)

    def test_an_unreadable_confidence_defaults_to_medium(self) -> None:
        assert normalise(answer(confidence="very sure"), 0).confidence == "medium"
        assert normalise(answer(confidence="HIGH"), 0).confidence == "high"

    def test_free_text_fields_default_to_empty_not_to_a_sentence(self) -> None:
        described = normalise({"summary": "A shot."}, 0)
        assert (described.subject, described.action, described.setting, described.mood) == (
            "",
            "",
            "",
            "",
        )


class TestDescribeShots:
    def test_every_requested_shot_is_described_in_order(self) -> None:
        backend = FakeDescribeBackend()
        described = list(describe_shots(_request(), backend))
        assert [shot.shot_index for shot in described] == [0, 1]
        assert len(backend.decoded) == 2
        assert backend.described == [3, 3]

    def test_the_schema_is_handed_to_the_model_every_call(self) -> None:
        backend = FakeDescribeBackend()
        list(describe_shots(_request(), backend))
        assert all(schema["type"] == "object" for schema in backend.schemas)

    def test_cancellation_stops_before_the_first_model_call(self) -> None:
        backend = FakeDescribeBackend()
        with pytest.raises(ProtocolError) as caught:
            list(describe_shots(_request(), backend, should_cancel=lambda: True))
        assert caught.value.code == "cancelled"
        assert backend.described == []

    def test_an_undecodable_keyframe_fails_the_request(self) -> None:
        backend = FakeDescribeBackend(decode_error="no frame at 2.0s")
        with pytest.raises(ProtocolError) as caught:
            list(describe_shots(_request(), backend))
        assert caught.value.code == "media_unreadable"

    def test_a_short_decode_fails_rather_than_describing_fewer_frames(self) -> None:
        backend = FakeDescribeBackend(frames_per_call=1)
        with pytest.raises(ProtocolError) as caught:
            list(describe_shots(_request(), backend))
        assert caught.value.code == "media_unreadable"

    def test_an_unusable_model_answer_fails_the_request_retryably(self) -> None:
        backend = FakeDescribeBackend(describe_error="the model looped")
        with pytest.raises(ProtocolError) as caught:
            list(describe_shots(_request(), backend))
        assert caught.value.code == "internal_error"
        assert caught.value.retryable is True

    def test_a_summaryless_shot_is_skipped_and_its_neighbours_still_describe(self) -> None:
        # The damage the old "fail the whole request" rule did, at the unit level: a batch
        # is up to 16 shots, and one blank frame took every describable shot beside it down.
        backend = FakeDescribeBackend(answers=[answer(summary=""), answer()])
        described = list(describe_shots(_request(), backend))
        assert [shot.shot_index for shot in described] == [1]

    def test_every_shot_declining_fails_because_there_is_no_empty_result(self) -> None:
        backend = FakeDescribeBackend(answers=[answer(summary="")])
        with pytest.raises(ProtocolError, match="no summary"):
            list(describe_shots(_request(), backend))

    def test_a_summaryless_answer_is_NOT_retryable_because_the_frame_will_not_change(
        self,
    ) -> None:
        # The distinction the two failures above and this one exist to draw. A malformed
        # answer is a hiccup worth one more pass; an object that PARSED and simply has
        # nothing in it is the model declining, and the cause is the frame. Measured on
        # SmolVLM2-2.2B against `eval/media/flat-grey.mp4`: a featureless frame returns a
        # parseable, summaryless object every single time. Marked retryable, that failed
        # the whole batch on every pass forever, spending a model call each time to be told
        # the same nothing.
        backend = FakeDescribeBackend(answers=[answer(summary="")])
        with pytest.raises(ProtocolError) as caught:
            list(describe_shots(_request(), backend))
        assert caught.value.code == "internal_error"
        assert caught.value.retryable is False
