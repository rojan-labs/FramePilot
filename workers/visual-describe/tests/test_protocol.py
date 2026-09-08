"""The worker's mirror of the frozen JSON-line protocol."""

from __future__ import annotations

import json

import pytest
from conftest import media, request_body, request_line

from framepilot_visual_describe.protocol import (
    CAPABILITY,
    MAX_SHOTS,
    Camera,
    CancelMessage,
    DescribeRequest,
    ProtocolError,
    ShotDescription,
    describe_result_message,
    encode_line,
    failure_message,
    parse_input_line,
    progress_message,
)
from framepilot_visual_describe.schema import TIER2_VERSION


def test_parses_a_well_formed_request() -> None:
    parsed = parse_input_line(request_line())
    assert isinstance(parsed, DescribeRequest)
    assert parsed.capability == CAPABILITY
    assert parsed.tier2_version == TIER2_VERSION
    assert [shot.shot_index for shot in parsed.shots] == [0, 1]
    assert parsed.media.absolute_path == "/media/asset-1.mp4"


def test_shots_are_sorted_by_source_time_not_request_order() -> None:
    body = request_body()
    body["parameters"]["shots"] = [
        {"shotIndex": 7, "t0": 20.0, "t1": 24.0},
        {"shotIndex": 2, "t0": 1.0, "t1": 3.0},
    ]
    parsed = parse_input_line(json.dumps(body))
    assert isinstance(parsed, DescribeRequest)
    # Byte-identical output for an identically-meant request, and one forward seek pass.
    assert [shot.shot_index for shot in parsed.shots] == [2, 7]


def test_a_span_outside_the_approved_media_is_refused_not_clamped() -> None:
    body = request_body(media=media(sourceEndSeconds=5.0))
    body["parameters"]["shots"] = [{"shotIndex": 0, "t0": 1.0, "t1": 9.0}]
    with pytest.raises(ProtocolError) as caught:
        parse_input_line(json.dumps(body))
    assert caught.value.code == "invalid_request"
    assert "outside the approved media range" in caught.value.detail


@pytest.mark.parametrize(
    ("shots", "message"),
    [
        ([], "between 1 and"),
        (
            [{"shotIndex": i, "t0": float(i), "t1": i + 1.0} for i in range(MAX_SHOTS + 1)],
            "between 1 and",
        ),
        ([{"shotIndex": 0, "t0": 2.0, "t1": 2.0}], "span must be positive"),
        ([{"shotIndex": 0, "t0": -1.0, "t1": 2.0}], "non-negative"),
        ([{"shotIndex": 0, "t0": 0.0}], "requires t1"),
    ],
)
def test_shot_list_bounds(shots: list[dict[str, object]], message: str) -> None:
    body = request_body()
    body["parameters"]["shots"] = shots
    with pytest.raises(ProtocolError, match=message):
        parse_input_line(json.dumps(body))


def test_duplicate_shot_indices_are_refused() -> None:
    body = request_body()
    body["parameters"]["shots"] = [
        {"shotIndex": 3, "t0": 0.0, "t1": 1.0},
        {"shotIndex": 3, "t0": 1.0, "t1": 2.0},
    ]
    with pytest.raises(ProtocolError, match="must be distinct"):
        parse_input_line(json.dumps(body))


def test_another_capability_is_refused() -> None:
    with pytest.raises(ProtocolError, match="not provided by Visual Describe"):
        parse_input_line(request_line(capability="visual.embed"))


def test_another_protocol_version_is_refused() -> None:
    with pytest.raises(ProtocolError, match="unsupported protocol version"):
        parse_input_line(request_line(protocolVersion=2))


def test_unexpected_keys_are_refused() -> None:
    with pytest.raises(ProtocolError, match="unexpected keys"):
        parse_input_line(request_line(sneak="value"))


def test_a_cancel_line_parses() -> None:
    parsed = parse_input_line(
        json.dumps({"type": "cancel", "protocolVersion": 1, "requestId": "describe:asset-1:0"})
    )
    assert parsed == CancelMessage(request_id="describe:asset-1:0")


def test_a_non_json_line_is_an_invalid_request() -> None:
    with pytest.raises(ProtocolError) as caught:
        parse_input_line("{not json")
    assert caught.value.code == "invalid_request"


def test_result_normalises_vocabulary_and_orders_by_shot_index() -> None:
    message = describe_result_message(
        request_id="r1",
        project_revision=3,
        tier2_version=TIER2_VERSION,
        model="fake/describe-1",
        shots=[
            ShotDescription(shot_index=4, summary="Later shot."),
            ShotDescription(
                shot_index=1,
                summary="  Two   spaces  collapsed. ",
                camera=Camera(shot_size="MS", angle=None, movement="pan"),
                on_screen_text=("SALE  50%",),
                quality=("well-lit", "not-a-word"),
            ),
        ],
        backend="fake",
        model_digests={"fake.gguf": "a" * 64},
    )
    shots = message["shots"]
    assert [shot["shotIndex"] for shot in shots] == [1, 4]
    assert shots[0]["summary"] == "Two spaces collapsed."
    # An unset closed-vocabulary field travels as the explicit sentinel, never as a
    # missing key: the schema requires every property.
    assert shots[0]["camera"] == {"shotSize": "MS", "angle": "unknown", "movement": "pan"}
    assert shots[0]["onScreenText"] == ["SALE 50%"]
    assert shots[0]["quality"] == ["well-lit"]
    assert message["tier2Version"] == TIER2_VERSION
    assert message["model"] == "fake/describe-1"


def test_an_empty_result_is_refused() -> None:
    with pytest.raises(ProtocolError, match="at least one shot"):
        describe_result_message(
            request_id="r1",
            project_revision=0,
            tier2_version=TIER2_VERSION,
            model="m",
            shots=[],
            backend="fake",
            model_digests={},
        )


def test_a_summaryless_shot_is_refused_rather_than_reported_as_described() -> None:
    with pytest.raises(ProtocolError, match="no summary"):
        describe_result_message(
            request_id="r1",
            project_revision=0,
            tier2_version=TIER2_VERSION,
            model="m",
            shots=[ShotDescription(shot_index=0, summary="   ")],
            backend="fake",
            model_digests={},
        )


def test_an_unknown_confidence_level_is_refused() -> None:
    with pytest.raises(ProtocolError, match="not a confidence level"):
        describe_result_message(
            request_id="r1",
            project_revision=0,
            tier2_version=TIER2_VERSION,
            model="m",
            shots=[ShotDescription(shot_index=0, summary="A shot.", confidence="certain")],
            backend="fake",
            model_digests={},
        )


def test_progress_is_bounded_by_its_total() -> None:
    message = progress_message("r1", "describe", 99, 4)
    assert message["completed"] == 4


def test_failure_carries_its_typed_code() -> None:
    message = failure_message("r1", "media_unreadable", "no frame", True)
    assert message["code"] == "media_unreadable"
    assert message["retryable"] is True


def test_an_oversized_output_line_is_refused() -> None:
    with pytest.raises(ProtocolError, match="1 MiB bound"):
        encode_line({"type": "result", "blob": "x" * (1024 * 1024)})
