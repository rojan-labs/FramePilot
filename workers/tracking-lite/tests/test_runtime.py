"""End-to-end worker behaviour over the real JSON-line transport."""

from __future__ import annotations

import io
import json
import threading

from conftest import ScriptedBackend

from framepilot_tracking_lite.backend import BackendUnavailableError, TrackingBackend
from framepilot_tracking_lite.protocol import PROTOCOL_VERSION
from framepilot_tracking_lite.runtime import CancellationFlag, run_worker


def request_line(capability: str = "tracking.region", frames: int = 8, **overrides: object) -> str:
    parameters: dict[str, object] = {
        "tracking.region": {"region": {"x": 0.4, "y": 0.4, "width": 0.2, "height": 0.2}},
        "tracking.point": {"point": {"x": 0.5, "y": 0.5}},
        "tracking.planar": {
            "corners": [
                {"x": 0.3, "y": 0.3},
                {"x": 0.6, "y": 0.3},
                {"x": 0.6, "y": 0.7},
                {"x": 0.3, "y": 0.7},
            ]
        },
    }[capability]
    payload: dict[str, object] = {
        "type": "request",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": "req-42",
        "projectRevision": 11,
        "capability": capability,
        "media": {
            "handleId": "handle-1",
            "assetId": "asset-1",
            "absolutePath": "/approved/shot.mp4",
            "sourceStartSeconds": 0.0,
            "sourceEndSeconds": 1.0,
            "fps": 30.0,
            "firstFrame": 0,
            "lastFrameExclusive": frames,
        },
        "parameters": parameters,
    }
    payload.update(overrides)
    return f"{json.dumps(payload)}\n"


def run(stdin_text: str, backend: TrackingBackend | None = None) -> list[dict[str, object]]:
    stdout = io.StringIO()
    used = backend if backend is not None else ScriptedBackend()
    exit_code = run_worker(io.StringIO(stdin_text), stdout, lambda: used)
    assert exit_code == 0
    return [json.loads(line) for line in stdout.getvalue().splitlines() if line]


def terminal(messages: list[dict[str, object]]) -> dict[str, object]:
    terminals = [message for message in messages if message["type"] in {"result", "failure"}]
    assert len(terminals) == 1, "a worker must emit exactly one terminal message"
    return terminals[0]


def test_runs_one_request_and_emits_progress_then_one_result() -> None:
    messages = run(request_line(frames=60))
    assert messages[0]["type"] == "progress"
    phases = {message["phase"] for message in messages if message["type"] == "progress"}
    assert {"decode", "initialize", "track", "encode"} <= phases
    for message in messages:
        if message["type"] == "progress":
            assert message["completed"] <= message["total"]
    result = terminal(messages)
    assert result["type"] == "result"
    assert result["requestId"] == "req-42"
    assert result["projectRevision"] == 11
    assert result["capability"] == "tracking.region"
    assert result["backend"] == "scripted-cpu"
    assert result["modelDigests"] == {}
    frames = [sample["frame"] for sample in result["samples"]]
    assert frames == sorted(frames) == list(range(60))


def test_every_capability_answers_over_the_transport() -> None:
    for capability in ("tracking.point", "tracking.region", "tracking.planar"):
        result = terminal(run(request_line(capability)))
        assert result["type"] == "result"
        assert result["capability"] == capability


def test_an_invalid_request_fails_typed_without_running_a_tracker() -> None:
    backend = ScriptedBackend()
    messages = run('{"type":"request","protocolVersion":9}\n', backend)
    failure = terminal(messages)
    assert failure["type"] == "failure"
    assert failure["code"] == "invalid_request"
    assert backend.opened == []


def test_unreadable_media_is_reported_as_media_unreadable() -> None:
    failure = terminal(run(request_line(), ScriptedBackend(media_unreadable=True)))
    assert failure["code"] == "media_unreadable"
    assert failure["retryable"] is False


def test_a_missing_cv_runtime_is_reported_as_unsupported_hardware() -> None:
    stdout = io.StringIO()

    def unavailable() -> TrackingBackend:
        raise BackendUnavailableError("the Tracking Lite CV runtime is not installed")

    assert run_worker(io.StringIO(request_line()), stdout, unavailable) == 0
    failure = terminal([json.loads(line) for line in stdout.getvalue().splitlines() if line])
    assert failure["code"] == "hardware_unsupported"


def test_a_cancel_line_arriving_mid_track_stops_the_worker() -> None:
    """The host keeps stdin open; the worker must notice a cancel without EOF."""
    lines = [request_line(frames=5_000), json.dumps({
        "type": "cancel", "protocolVersion": PROTOCOL_VERSION, "requestId": "req-42",
    }) + "\n"]
    failure = terminal(run("".join(lines)))
    assert failure["code"] == "cancelled"


def test_a_cancel_set_before_work_starts_is_honoured() -> None:
    flag = CancellationFlag()
    flag.cancel()
    stdout = io.StringIO()
    backend = ScriptedBackend()
    assert run_worker(io.StringIO(request_line()), stdout, lambda: backend, flag) == 0
    failure = terminal([json.loads(line) for line in stdout.getvalue().splitlines() if line])
    assert failure["code"] == "cancelled"
    assert backend.opened == []


def test_a_lost_target_fails_instead_of_returning_a_fabricated_track() -> None:
    backend = ScriptedBackend(lost_frames=set(range(2, 40)))
    failure = terminal(run(request_line(frames=40), backend))
    assert failure["code"] == "target_lost"
    assert "after frame 1" in str(failure["detail"])


def test_media_is_always_closed_even_when_tracking_fails() -> None:
    backend = ScriptedBackend(lost_frames=set(range(2, 40)))
    run(request_line(frames=40), backend)
    assert backend.opened and all(source.closed for source in backend.opened)


def test_an_unexpected_fault_still_produces_one_typed_failure() -> None:
    class ExplodingBackend(ScriptedBackend):
        def open_frames(self, path: str, first_frame: int, last: int):  # type: ignore[override]
            raise RuntimeError("decoder exploded")

    failure = terminal(run(request_line(), ExplodingBackend()))
    assert failure["code"] == "internal_error"
    assert "decoder exploded" in str(failure["detail"])


def test_no_request_on_stdin_fails_rather_than_hanging() -> None:
    failure = terminal(run(""))
    assert failure["code"] == "invalid_request"
    assert "no request" in str(failure["detail"])


def test_a_second_request_in_one_process_is_ignored() -> None:
    messages = run(request_line() + request_line(capability="tracking.point"))
    result = terminal(messages)
    assert result["capability"] == "tracking.region"


def test_input_is_drained_concurrently_with_tracking() -> None:
    """A slow-arriving cancel must still reach a running track."""
    reader = _SlowInput([request_line(frames=5_000)], cancel_after_seconds=0.05)
    stdout = io.StringIO()
    # A decode cost per frame guarantees the track is still running when the
    # cancel line arrives, which is exactly the case a blocking read would miss.
    backend = ScriptedBackend(frame_delay_seconds=0.001)
    assert run_worker(reader, stdout, lambda: backend) == 0
    failure = terminal([json.loads(line) for line in stdout.getvalue().splitlines() if line])
    assert failure["code"] == "cancelled"


class _SlowInput:
    """A stdin-like iterator that emits a cancel line only after a delay."""

    def __init__(self, lines: list[str], cancel_after_seconds: float) -> None:
        self._lines = lines
        self._delay = cancel_after_seconds

    def __iter__(self):
        yield from self._lines
        threading.Event().wait(self._delay)
        yield json.dumps(
            {"type": "cancel", "protocolVersion": PROTOCOL_VERSION, "requestId": "req-42"}
        ) + "\n"
