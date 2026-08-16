"""The protocol mirror must refuse anything the host's schema would refuse."""

from __future__ import annotations

import json

import pytest

from framepilot_subject_intelligence.protocol import (
    DEFAULT_MAX_DETECTIONS,
    MAX_SAMPLES,
    Detection,
    MaskSample,
    NormalizedBox,
    ProtocolError,
    SubjectRequest,
    detection_result_message,
    encode_line,
    failure_message,
    mask_result_message,
    parse_input_line,
    progress_message,
)

MEDIA = {
    "handleId": "handle-1",
    "assetId": "asset-1",
    "absolutePath": "/approved/clip.mp4",
    "sourceStartSeconds": 0.0,
    "sourceEndSeconds": 2.0,
    "fps": 30.0,
    "firstFrame": 0,
    "lastFrameExclusive": 10,
}


def request_line(**overrides: object) -> str:
    payload: dict[str, object] = {
        "type": "request",
        "protocolVersion": 1,
        "requestId": "req-1",
        "projectRevision": 4,
        "capability": "subject.detect",
        "media": MEDIA,
        "parameters": {"labels": ["face"], "maxDetections": 5},
    }
    payload.update(overrides)
    return json.dumps(payload)


def test_a_detection_request_parses() -> None:
    parsed = parse_input_line(request_line())

    assert isinstance(parsed, SubjectRequest)
    assert parsed.capability == "subject.detect"
    assert parsed.labels == ("face",)
    assert parsed.max_detections == 5


def test_an_omitted_max_detections_takes_the_schema_default() -> None:
    parsed = parse_input_line(request_line(parameters={"labels": ["person"]}))

    assert isinstance(parsed, SubjectRequest)
    assert parsed.max_detections == DEFAULT_MAX_DETECTIONS


def test_labels_are_sorted_so_identical_requests_are_identical() -> None:
    first = parse_input_line(request_line(parameters={"labels": ["person", "face"]}))
    second = parse_input_line(request_line(parameters={"labels": ["face", "person"]}))

    assert isinstance(first, SubjectRequest) and isinstance(second, SubjectRequest)
    assert first.labels == second.labels == ("face", "person")


@pytest.mark.parametrize(
    ("parameters", "message"),
    [
        ({"labels": []}, "between 1 and 3"),
        ({"labels": ["cat"]}, "not a detectable label"),
        ({"labels": ["face", "face"]}, "distinct"),
        ({"labels": ["face"], "maxDetections": 0}, ">= 1"),
        ({"labels": ["face"], "maxDetections": 5000}, "<= 100"),
    ],
)
def test_bad_detection_parameters_are_refused(parameters: dict[str, object], message: str) -> None:
    with pytest.raises(ProtocolError, match=message):
        parse_input_line(request_line(parameters=parameters))


def test_segmentation_needs_exactly_one_prompt() -> None:
    both = {
        "region": {"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2},
        "point": {"x": 0.5, "y": 0.5},
    }

    with pytest.raises(ProtocolError, match="exactly one"):
        parse_input_line(request_line(capability="subject.segment", parameters=both))

    with pytest.raises(ProtocolError, match="exactly one"):
        parse_input_line(request_line(capability="subject.segment", parameters={}))


def test_a_segmentation_point_prompt_parses() -> None:
    parsed = parse_input_line(
        request_line(capability="subject.segment", parameters={"point": {"x": 0.5, "y": 0.25}})
    )

    assert isinstance(parsed, SubjectRequest)
    assert parsed.point is not None
    assert parsed.region is None


def test_a_tracking_capability_is_not_this_pack() -> None:
    with pytest.raises(ProtocolError, match="not provided by Subject Intelligence"):
        parse_input_line(
            request_line(capability="tracking.point", parameters={"point": {"x": 0.5, "y": 0.5}})
        )


def test_a_region_outside_the_frame_is_refused() -> None:
    with pytest.raises(ProtocolError, match="inside the frame"):
        parse_input_line(
            request_line(
                capability="subject.segment",
                parameters={"region": {"x": 0.9, "y": 0.1, "width": 0.5, "height": 0.2}},
            )
        )


def test_a_wrong_protocol_version_is_refused() -> None:
    with pytest.raises(ProtocolError, match="unsupported protocol version"):
        parse_input_line(request_line(protocolVersion=2))


def test_an_oversized_frame_range_is_refused() -> None:
    with pytest.raises(ProtocolError, match="sample bound"):
        parse_input_line(request_line(media={**MEDIA, "lastFrameExclusive": MAX_SAMPLES + 5}))


def test_an_unknown_key_is_refused_rather_than_ignored() -> None:
    with pytest.raises(ProtocolError, match="unexpected keys"):
        parse_input_line(request_line(surprise="value"))


def test_a_cancel_message_parses() -> None:
    parsed = parse_input_line(
        json.dumps({"type": "cancel", "protocolVersion": 1, "requestId": "req-1"})
    )

    assert parsed.request_id == "req-1"


def test_an_empty_detection_result_is_legal() -> None:
    # "Nobody is in this shot" is a real answer and must be expressible.
    message = detection_result_message(
        request_id="req-1",
        project_revision=2,
        detections=[],
        backend="scripted",
        model_digests={"m.onnx": "a" * 64},
    )

    assert message["detections"] == []
    assert message["modelDigests"] == {"m.onnx": "a" * 64}


def test_detections_come_out_in_a_stable_total_order() -> None:
    box = NormalizedBox(x=0.1, y=0.1, width=0.1, height=0.1)
    other = NormalizedBox(x=0.4, y=0.1, width=0.1, height=0.1)
    detections = [
        Detection(frame=2, label="face", box=box, confidence=0.7),
        Detection(frame=1, label="person", box=other, confidence=0.6),
        Detection(frame=1, label="face", box=other, confidence=0.5),
        Detection(frame=1, label="face", box=box, confidence=0.9),
    ]

    message = detection_result_message(
        request_id="req-1",
        project_revision=2,
        detections=detections,
        backend="scripted",
        model_digests={},
    )

    reported = [
        (item["frame"], item["label"], item["confidence"]) for item in message["detections"]
    ]
    assert reported == [
        (1, "face", 0.9),
        (1, "face", 0.5),
        (1, "person", 0.6),
        (2, "face", 0.7),
    ]


def test_a_segmentation_result_needs_a_mask() -> None:
    with pytest.raises(ProtocolError, match="at least one mask"):
        mask_result_message(
            request_id="req-1",
            project_revision=1,
            masks=[],
            backend="scripted",
            model_digests={},
        )


def test_masks_are_emitted_in_frame_order() -> None:
    masks = [
        MaskSample(frame=3, width=2, height=2, counts=(0, 4), confidence=0.8),
        MaskSample(frame=1, width=2, height=2, counts=(0, 4), confidence=0.8),
    ]

    message = mask_result_message(
        request_id="req-1",
        project_revision=1,
        masks=masks,
        backend="scripted",
        model_digests={},
    )

    assert [mask["frame"] for mask in message["masks"]] == [1, 3]


def test_an_impossible_mask_size_is_refused() -> None:
    with pytest.raises(ProtocolError, match="mask dimensions"):
        mask_result_message(
            request_id="req-1",
            project_revision=1,
            masks=[MaskSample(frame=0, width=99_999, height=2, counts=(0, 4), confidence=0.5)],
            backend="scripted",
            model_digests={},
        )


def test_progress_is_bounded_by_its_own_total() -> None:
    message = progress_message("req-1", "detect", 500, 10)

    assert message["completed"] == 10


def test_an_oversized_output_line_is_refused() -> None:
    with pytest.raises(ProtocolError, match="1 MiB"):
        encode_line({"type": "progress", "detail": "x" * (1024 * 1024 + 10)})


def test_a_failure_line_carries_its_code_and_retryability() -> None:
    message = failure_message("req-1", "target_lost", "nobody there", False)

    assert message["code"] == "target_lost"
    assert message["retryable"] is False
