"""AM2.5: object detections name their COCO class — only when the host asks.

The field is additive under protocol v1. Two compatibility directions matter, and
both are pinned here:

- **An older host talking to this pack** never sends ``classes``, and its strict
  schema would refuse an unknown key on a detection. So without ``classes`` the
  result must be exactly the 1.0 shape: ``frame``, ``label``, ``box``,
  ``confidence`` and nothing else.
- **A newer host talking to an older pack** is the host's side (it only asks a pack
  that is new enough); ``packages/capability-packs`` and the desktop tracking
  service pin that.
"""

from __future__ import annotations

import io
import json

import pytest
from conftest import ScriptedBackend, detect_request

from framepilot_subject_intelligence.backend import RawDetection
from framepilot_subject_intelligence.coco_classes import (
    COCO_CLASSES,
    COCO_PERSON_CLASS,
    coco_class_name,
)
from framepilot_subject_intelligence.policy import run_detection, select_detections
from framepilot_subject_intelligence.protocol import (
    Detection,
    NormalizedBox,
    ProtocolError,
    SubjectRequest,
    detection_result_message,
    parse_input_line,
)
from framepilot_subject_intelligence.runtime import run_worker

MEDIA = {
    "handleId": "handle-1",
    "assetId": "asset-1",
    "absolutePath": "/approved/clip.mp4",
    "sourceStartSeconds": 0.0,
    "sourceEndSeconds": 1.0,
    "fps": 30.0,
    "firstFrame": 0,
    "lastFrameExclusive": 1,
}
BOX = NormalizedBox(x=0.1, y=0.2, width=0.3, height=0.4)
V1_DETECTION_KEYS = {"frame", "label", "box", "confidence"}


def car(confidence: float = 0.9, class_score: float = 0.95) -> RawDetection:
    return RawDetection(
        label="object",
        box=(100, 100, 400, 200),
        confidence=confidence,
        object_class="car",
        class_score=class_score,
    )


def request_line(parameters: dict[str, object]) -> str:
    return json.dumps(
        {
            "type": "request",
            "protocolVersion": 1,
            "requestId": "req-1",
            "projectRevision": 3,
            "capability": "subject.detect",
            "media": MEDIA,
            "parameters": parameters,
        }
    )


def encode(detections: list[Detection]) -> list[dict[str, object]]:
    message = detection_result_message(
        request_id="req-1",
        project_revision=1,
        detections=detections,
        backend="scripted",
        model_digests={},
    )
    return message["detections"]  # type: ignore[no-any-return]


# --- the class list -----------------------------------------------------------


def test_the_class_list_is_the_models_80_columns_with_person_first() -> None:
    assert len(COCO_CLASSES) == 80
    assert len(set(COCO_CLASSES)) == 80
    assert COCO_CLASSES[COCO_PERSON_CLASS] == "person"
    # Spot-check the order against the YOLOX/OpenCV Zoo layout: an off-by-one here
    # would name every class as its neighbour.
    assert coco_class_name(2) == "car"
    assert coco_class_name(7) == "truck"
    assert coco_class_name(16) == "dog"
    assert coco_class_name(39) == "bottle"
    assert coco_class_name(79) == "toothbrush"


@pytest.mark.parametrize("index", [-1, 80, 1000])
def test_a_column_the_model_does_not_have_is_refused(index: int) -> None:
    with pytest.raises(ValueError, match="80 COCO classes"):
        coco_class_name(index)


# --- request -------------------------------------------------------------------


def test_classes_are_off_unless_the_host_asks() -> None:
    parsed = parse_input_line(request_line({"labels": ["object"]}))

    assert isinstance(parsed, SubjectRequest)
    assert parsed.include_classes is False


def test_the_host_can_ask_for_classes() -> None:
    parsed = parse_input_line(request_line({"labels": ["object"], "classes": True}))

    assert isinstance(parsed, SubjectRequest)
    assert parsed.include_classes is True


@pytest.mark.parametrize("value", ["yes", 1, None, {"on": True}])
def test_a_non_boolean_classes_flag_is_refused(value: object) -> None:
    with pytest.raises(ProtocolError, match=r"parameters\.classes must be a boolean"):
        parse_input_line(request_line({"labels": ["object"], "classes": value}))


# --- result encoding ---------------------------------------------------------------


def test_an_unclassed_detection_keeps_the_v1_shape_exactly() -> None:
    [encoded] = encode([Detection(frame=0, label="object", box=BOX, confidence=0.8)])

    assert set(encoded) == V1_DETECTION_KEYS


def test_a_classed_detection_carries_its_class_and_score() -> None:
    [encoded] = encode(
        [
            Detection(
                frame=0,
                label="object",
                box=BOX,
                confidence=0.8,
                object_class="car",
                class_score=0.9,
            )
        ]
    )

    assert encoded["class"] == "car"
    assert encoded["classScore"] == 0.9
    assert set(encoded) == V1_DETECTION_KEYS | {"class", "classScore"}


@pytest.mark.parametrize(
    ("detection", "message"),
    [
        (
            Detection(frame=0, label="object", box=BOX, confidence=0.8, object_class="car"),
            "both a name and a score",
        ),
        (
            Detection(frame=0, label="object", box=BOX, confidence=0.8, class_score=0.5),
            "both a name and a score",
        ),
        (
            Detection(
                frame=0,
                label="face",
                box=BOX,
                confidence=0.8,
                object_class="person",
                class_score=0.9,
            ),
            "face detection cannot carry a class",
        ),
        (
            Detection(
                frame=0,
                label="object",
                box=BOX,
                confidence=0.8,
                object_class="sky",
                class_score=0.9,
            ),
            "not one of the model's COCO classes",
        ),
        (
            Detection(
                frame=0,
                label="object",
                box=BOX,
                confidence=0.8,
                object_class="car",
                class_score=1.5,
            ),
            r"must be in \[0, 1\]",
        ),
    ],
)
def test_a_class_the_host_would_refuse_fails_early_and_typed(
    detection: Detection, message: str
) -> None:
    with pytest.raises(ProtocolError, match=message) as raised:
        encode([detection])

    assert raised.value.code == "internal_error"


# --- policy -------------------------------------------------------------------------


def test_the_policy_passes_the_models_class_through_only_when_asked() -> None:
    asked = select_detections(
        [car()], 0, 1920, 1080, labels=("object",), max_detections=5, include_classes=True
    )
    not_asked = select_detections([car()], 0, 1920, 1080, labels=("object",), max_detections=5)

    assert (asked[0].object_class, asked[0].class_score) == ("car", 0.95)
    assert (not_asked[0].object_class, not_asked[0].class_score) == (None, None)


def test_a_detection_the_backend_did_not_class_stays_unclassed() -> None:
    # The class is the model's; the policy never fills one in.
    face = RawDetection(label="face", box=(10, 10, 80, 80), confidence=0.9)

    [kept] = select_detections(
        [face], 0, 1920, 1080, labels=("face",), max_detections=5, include_classes=True
    )

    assert kept.object_class is None
    assert kept.class_score is None


def test_run_detection_threads_the_request_flag(backend: ScriptedBackend) -> None:
    backend.frames = 1
    backend.objects = [[car()]]
    request = detect_request(labels=("object",), include_classes=True)
    source = backend.open_frames("/approved/media.mp4", 0, 1)

    [frame] = list(run_detection(request, source, backend, should_cancel=lambda: False))

    assert frame[0].object_class == "car"


# --- end to end through the runtime ---------------------------------------------------


def run_one(parameters: dict[str, object], backend: ScriptedBackend) -> dict[str, object]:
    stdout = io.StringIO()
    assert run_worker(io.StringIO(request_line(parameters) + "\n"), stdout, lambda: backend) == 0
    lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
    [result] = [line for line in lines if line["type"] in {"result", "failure"}]
    return result


def test_an_older_host_gets_exactly_the_shape_it_can_parse(backend: ScriptedBackend) -> None:
    backend.frames = 1
    backend.objects = [[car()]]

    result = run_one({"labels": ["object"]}, backend)

    assert result["type"] == "result"
    [detection] = result["detections"]  # type: ignore[misc]
    assert set(detection) == V1_DETECTION_KEYS


def test_a_newer_host_that_asks_gets_the_class(backend: ScriptedBackend) -> None:
    backend.frames = 1
    backend.objects = [
        [
            car(),
            RawDetection(
                label="person",
                box=(900, 100, 200, 800),
                confidence=0.9,
                object_class="person",
                class_score=0.97,
            ),
        ]
    ]

    result = run_one({"labels": ["object", "person"], "classes": True}, backend)

    assert result["type"] == "result"
    classes = {(item["label"], item["class"]) for item in result["detections"]}  # type: ignore[index, union-attr]
    assert classes == {("object", "car"), ("person", "person")}
