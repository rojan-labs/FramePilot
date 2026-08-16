"""The one-shot runtime: exactly one terminal message, always."""

from __future__ import annotations

import io
import json
import threading
import time

from conftest import ScriptedBackend, solid_mask

from framepilot_subject_intelligence.backend import (
    BackendUnavailableError,
    MediaUnreadableError,
    ModelUnavailableError,
    RawDetection,
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
    "lastFrameExclusive": 3,
}


def request_json(**overrides: object) -> str:
    payload: dict[str, object] = {
        "type": "request",
        "protocolVersion": 1,
        "requestId": "req-1",
        "projectRevision": 9,
        "capability": "subject.detect",
        "media": MEDIA,
        "parameters": {"labels": ["face"]},
    }
    payload.update(overrides)
    return json.dumps(payload) + "\n"


def run(stdin: str, backend: ScriptedBackend) -> list[dict[str, object]]:
    stdout = io.StringIO()
    code = run_worker(io.StringIO(stdin), stdout, lambda: backend)
    assert code == 0
    return [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]


def terminal(messages: list[dict[str, object]]) -> dict[str, object]:
    found = [message for message in messages if message["type"] in {"result", "failure"}]
    assert len(found) == 1, f"expected exactly one terminal message, got {len(found)}"
    return found[0]


def test_a_detection_request_produces_one_result(backend: ScriptedBackend) -> None:
    backend.frames = 3
    backend.faces = [[RawDetection(label="face", box=(10, 10, 80, 80), confidence=0.9)], [], []]

    messages = run(request_json(), backend)
    result = terminal(messages)

    assert result["type"] == "result"
    assert result["capability"] == "subject.detect"
    assert result["projectRevision"] == 9
    assert len(result["detections"]) == 1
    assert result["modelDigests"] == backend.model_digests


def test_progress_arrives_before_the_result(backend: ScriptedBackend) -> None:
    backend.frames = 3
    messages = run(request_json(), backend)

    phases = [message["phase"] for message in messages if message["type"] == "progress"]
    assert phases[0] == "decode"
    assert "encode" in phases
    assert messages[-1]["type"] == "result"


def test_unreadable_media_fails_typed(backend: ScriptedBackend) -> None:
    backend.media_unreadable = True

    result = terminal(run(request_json(), backend))

    assert result["type"] == "failure"
    assert result["code"] == "media_unreadable"


def test_a_malformed_request_fails_before_any_work(backend: ScriptedBackend) -> None:
    result = terminal(run("{not json}\n", backend))

    assert result["code"] == "invalid_request"
    assert result["requestId"] == "unidentified"


def test_no_request_at_all_is_a_typed_failure(backend: ScriptedBackend) -> None:
    result = terminal(run("", backend))

    assert result["code"] == "invalid_request"


def test_a_missing_backend_reports_unsupported_hardware() -> None:
    def broken() -> ScriptedBackend:
        raise BackendUnavailableError("no OpenCV in this runtime")

    stdout = io.StringIO()
    run_worker(io.StringIO(request_json()), stdout, broken)
    result = terminal([json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()])

    assert result["code"] == "hardware_unsupported"


def test_unverified_weights_report_model_unavailable() -> None:
    def tampered() -> ScriptedBackend:
        raise ModelUnavailableError("weights do not match their pin")

    stdout = io.StringIO()
    run_worker(io.StringIO(request_json()), stdout, tampered)
    result = terminal([json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()])

    assert result["code"] == "model_unavailable"


def test_a_segmentation_with_nothing_there_is_target_lost(backend: ScriptedBackend) -> None:
    from framepilot_subject_intelligence.backend import RawMask

    backend.frames = 1
    backend.masks = [RawMask(width=4, height=4, values=[0] * 16, confidence=0.1)]

    result = terminal(
        run(
            request_json(
                capability="subject.segment",
                parameters={"region": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5}},
            ),
            backend,
        )
    )

    assert result["type"] == "failure"
    assert result["code"] == "target_lost"


def test_a_segmentation_request_produces_masks(backend: ScriptedBackend) -> None:
    backend.frames = 2
    backend.masks = [solid_mask(), solid_mask()]

    result = terminal(
        run(
            request_json(
                capability="subject.segment",
                parameters={"region": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5}},
            ),
            backend,
        )
    )

    assert result["type"] == "result"
    assert [mask["frame"] for mask in result["masks"]] == [0, 1]


def test_an_unexpected_crash_still_produces_one_failure_line(backend: ScriptedBackend) -> None:
    class Exploding(ScriptedBackend):
        def detect_faces(self, frame: object) -> tuple[()]:
            raise RuntimeError("kaboom")

    result = terminal(run(request_json(), Exploding()))

    assert result["code"] == "internal_error"
    assert "kaboom" in result["detail"]


def test_a_cancel_arriving_mid_run_stops_the_work() -> None:
    """The cancel must be noticed without stdin reaching EOF."""

    class SlowBackend(ScriptedBackend):
        def detect_faces(self, frame: object) -> tuple[()]:
            time.sleep(0.01)
            return ()

    backend = SlowBackend(frames=500)
    reader, writer = _pipe()
    writer.write(request_json(media={**MEDIA, "lastFrameExclusive": 500}))
    writer.flush()

    stdout = io.StringIO()
    finished = threading.Event()

    def worker() -> None:
        run_worker(reader, stdout, lambda: backend)
        finished.set()

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    time.sleep(0.15)
    writer.write(json.dumps({"type": "cancel", "protocolVersion": 1, "requestId": "req-1"}) + "\n")
    writer.flush()

    assert finished.wait(timeout=20), "the worker never noticed the cancel"
    result = terminal([json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()])
    assert result["code"] == "cancelled"


def _pipe() -> tuple[io.TextIOWrapper, io.TextIOWrapper]:
    import os

    read_fd, write_fd = os.pipe()
    return (
        io.TextIOWrapper(io.FileIO(read_fd, "r"), encoding="utf-8"),
        io.TextIOWrapper(io.FileIO(write_fd, "w"), encoding="utf-8"),
    )


def test_media_that_cannot_be_decoded_mid_run_is_typed(backend: ScriptedBackend) -> None:
    class Failing(ScriptedBackend):
        def detect_faces(self, frame: object) -> tuple[()]:
            raise MediaUnreadableError("frame 2 is corrupt")

    result = terminal(run(request_json(), Failing()))

    # Not a typed protocol failure code by itself, so it surfaces as an internal
    # error with the real reason attached rather than a silent empty result.
    assert result["type"] == "failure"
    assert "corrupt" in result["detail"]
