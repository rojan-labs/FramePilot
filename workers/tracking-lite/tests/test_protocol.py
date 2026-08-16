"""The worker must refuse anything the host contract would reject."""

from __future__ import annotations

import json

import pytest

from framepilot_tracking_lite.protocol import (
    MAX_SAMPLES,
    PROTOCOL_VERSION,
    CancelMessage,
    NormalizedBox,
    ProtocolError,
    TrackingRequest,
    TrackingSample,
    encode_line,
    failure_message,
    parse_input_line,
    progress_message,
    result_message,
)


def request_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "type": "request",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": "req-1",
        "projectRevision": 4,
        "capability": "tracking.region",
        "media": {
            "handleId": "handle-1",
            "assetId": "asset-1",
            "absolutePath": "/approved/shot.mp4",
            "sourceStartSeconds": 0.0,
            "sourceEndSeconds": 2.0,
            "fps": 30.0,
            "firstFrame": 0,
            "lastFrameExclusive": 60,
        },
        "parameters": {"region": {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2}},
    }
    payload.update(overrides)
    return payload


def parse(payload: dict[str, object]) -> TrackingRequest | CancelMessage:
    return parse_input_line(json.dumps(payload))


def test_parses_a_valid_region_request() -> None:
    request = parse(request_payload())
    assert isinstance(request, TrackingRequest)
    assert request.capability == "tracking.region"
    assert request.project_revision == 4
    assert request.region == NormalizedBox(x=0.1, y=0.1, width=0.2, height=0.2)
    assert request.media.frame_count == 60


def test_parses_planar_corners_and_point() -> None:
    planar = parse(
        request_payload(
            capability="tracking.planar",
            parameters={
                "corners": [
                    {"x": 0.1, "y": 0.1},
                    {"x": 0.4, "y": 0.1},
                    {"x": 0.4, "y": 0.5},
                    {"x": 0.1, "y": 0.5},
                ]
            },
        )
    )
    assert isinstance(planar, TrackingRequest)
    assert planar.corners is not None and len(planar.corners) == 4
    point = parse(
        request_payload(capability="tracking.point", parameters={"point": {"x": 0.5, "y": 0.5}})
    )
    assert isinstance(point, TrackingRequest)
    assert point.point is not None


def test_parses_a_cancel_message() -> None:
    cancel = parse_input_line(
        json.dumps({"type": "cancel", "protocolVersion": PROTOCOL_VERSION, "requestId": "req-1"})
    )
    assert cancel == CancelMessage(request_id="req-1")


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"protocolVersion": 2}, "protocol version"),
        ({"capability": "subject.detect"}, "not provided by Tracking Lite"),
        ({"requestId": "req 1"}, "required format"),
        ({"projectRevision": -1}, ">= 0"),
        ({"type": "handshake"}, "request or a cancel"),
    ],
)
def test_rejects_contract_violations(overrides: dict[str, object], expected: str) -> None:
    with pytest.raises(ProtocolError) as error:
        parse(request_payload(**overrides))
    assert expected in error.value.detail
    assert error.value.code == "invalid_request"


def test_rejects_unknown_keys_and_escaped_geometry() -> None:
    with pytest.raises(ProtocolError, match="unexpected keys"):
        parse(request_payload(extra="nope"))
    with pytest.raises(ProtocolError, match="inside the frame"):
        parse(
            request_payload(
                parameters={"region": {"x": 0.9, "y": 0.1, "width": 0.5, "height": 0.2}}
            )
        )
    with pytest.raises(ProtocolError, match="normalized to"):
        # Pixel-shaped coordinates must fail before a worker does any decoding.
        parse(
            request_payload(
                parameters={"region": {"x": 120, "y": 40, "width": 0.2, "height": 0.2}}
            )
        )


def test_rejects_a_frame_range_beyond_the_sample_bound() -> None:
    media = dict(request_payload()["media"])  # type: ignore[arg-type]
    media["lastFrameExclusive"] = MAX_SAMPLES + 1
    with pytest.raises(ProtocolError, match="exceeds the"):
        parse(request_payload(media=media))


def test_rejects_a_non_positive_media_range() -> None:
    media = dict(request_payload()["media"])  # type: ignore[arg-type]
    media["lastFrameExclusive"] = 0
    with pytest.raises(ProtocolError, match="must be >= 1"):
        parse(request_payload(media=media))


def test_rejects_malformed_json_and_non_objects() -> None:
    with pytest.raises(ProtocolError, match="not valid JSON"):
        parse_input_line("{")
    with pytest.raises(ProtocolError, match="must be a JSON object"):
        parse_input_line("[1]")


def test_result_orders_samples_by_frame_and_reports_no_model_digests() -> None:
    box = NormalizedBox(x=0.1, y=0.1, width=0.2, height=0.2)
    message = result_message(
        request_id="req-1",
        project_revision=4,
        capability="tracking.point",
        samples=[
            TrackingSample(frame=3, box=box, confidence=0.5, occluded=False),
            TrackingSample(frame=1, box=box, confidence=0.9, occluded=False),
        ],
        backend="scripted-cpu",
    )
    assert [sample["frame"] for sample in message["samples"]] == [1, 3]
    assert message["modelDigests"] == {}
    assert message["backend"] == "scripted-cpu"


def test_result_refuses_to_claim_an_empty_track() -> None:
    with pytest.raises(ProtocolError, match="at least one sample"):
        result_message(
            request_id="req-1",
            project_revision=4,
            capability="tracking.point",
            samples=[],
            backend="scripted-cpu",
        )


def test_progress_can_never_exceed_its_total() -> None:
    message = progress_message("req-1", "track", 900, 100)
    assert message["completed"] == 100


def test_failure_and_encoding_stay_within_transport_bounds() -> None:
    message = failure_message("req-1", "target_lost", "x" * 5_000, False)
    assert len(message["detail"]) == 2_000
    line = encode_line(message)
    assert line.endswith("\n")
    assert json.loads(line)["code"] == "target_lost"
