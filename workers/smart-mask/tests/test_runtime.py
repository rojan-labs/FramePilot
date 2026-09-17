"""One terminal line per request, typed failures, cancellation, and the warm loop."""

from __future__ import annotations

import io
import json
import threading
from dataclasses import dataclass, field

from conftest import SHA, line, matte_request, segment_frame_request

from framepilot_smart_mask.backend import MediaUnreadableError, ModelUnavailableError
from framepilot_smart_mask.protocol import (
    ArtifactFile,
    MatteArtifact,
    MatteOutcome,
    MatteRequest,
    MatteSummary,
    SegmentFrameRequest,
)
from framepilot_smart_mask.runtime import (
    CancellationFlag,
    ProgressSink,
    SegmentFrameOutcome,
    run_warm_worker,
    run_worker,
    throttled_progress,
)


@dataclass
class ScriptedServices:
    matte_error: Exception | None = None
    frame_error: Exception | None = None
    seen: list[str] = field(default_factory=list)
    backend_label: str = "scripted"
    model_digests: dict[str, str] = field(default_factory=lambda: {"sam.onnx": SHA})

    def run_matte(
        self, request: MatteRequest, progress: ProgressSink, cancellation: CancellationFlag
    ) -> MatteOutcome:
        self.seen.append(request.request_id)
        progress("decode", 0, 48)
        progress("segment", 48, 48)
        cancellation.raise_if_cancelled()
        if self.matte_error is not None:
            raise self.matte_error
        return MatteOutcome(
            artifact=MatteArtifact(
                files=(ArtifactFile("matte.mkv", 1, SHA), ArtifactFile("frames.json", 1, SHA)),
                width=64,
                height=36,
                frame_count=48,
                first_pts=0,
                last_pts=47,
                time_base=(1, 24),
            ),
            execution_provider="cpu",
            summary=MatteSummary(48, 0, 0, 0),
        )

    def segment_frame(
        self, request: SegmentFrameRequest, cancellation: CancellationFlag
    ) -> SegmentFrameOutcome:
        self.seen.append(request.request_id)
        if self.frame_error is not None:
            raise self.frame_error
        return SegmentFrameOutcome(
            pts=request.pts, width=640, height=360, mask_png_base64="iVBORw0KGgo=", score=0.9
        )


def run(
    stdin_text: str, services: ScriptedServices, flag: CancellationFlag | None = None
) -> list[dict[str, object]]:
    out = io.StringIO()
    assert run_worker(io.StringIO(stdin_text), out, lambda: services, flag) == 0
    return [json.loads(item) for item in out.getvalue().splitlines()]


def test_matte_request_emits_progress_then_one_result() -> None:
    lines = run(line(matte_request()) + "\n", ScriptedServices())
    assert [item["type"] for item in lines] == ["progress", "progress", "result"]
    assert lines[-1]["capability"] == "subject.matte"
    assert lines[-1]["backend"] == "scripted"


def test_typed_backend_errors_become_protocol_failures() -> None:
    lines = run(
        line(matte_request()) + "\n", ScriptedServices(matte_error=MediaUnreadableError("bad file"))
    )
    assert lines[-1] == {
        "type": "failure",
        "protocolVersion": 1,
        "requestId": "req-1",
        "code": "media_unreadable",
        "detail": "bad file",
        "retryable": False,
    }
    lines = run(
        line(matte_request()) + "\n", ScriptedServices(matte_error=ModelUnavailableError("gone"))
    )
    assert lines[-1]["code"] == "model_unavailable"
    lines = run(line(matte_request()) + "\n", ScriptedServices(matte_error=RuntimeError("boom")))
    assert lines[-1]["code"] == "internal_error"


def test_invalid_first_line_is_a_failure_not_a_crash() -> None:
    lines = run("not json\n", ScriptedServices())
    assert lines == [
        {
            "type": "failure",
            "protocolVersion": 1,
            "requestId": "unidentified",
            "code": "invalid_request",
            "detail": lines[0]["detail"],
            "retryable": False,
        }
    ]
    assert run("", ScriptedServices())[0]["code"] == "invalid_request"


def test_services_that_cannot_start_fail_typed() -> None:
    out = io.StringIO()

    def broken() -> ScriptedServices:
        raise ModelUnavailableError("no weights")

    run_worker(io.StringIO(line(matte_request()) + "\n"), out, broken)
    assert json.loads(out.getvalue())["code"] == "model_unavailable"


def test_cancel_before_work_reports_cancelled() -> None:
    flag = CancellationFlag()
    flag.cancel()
    lines = run(line(matte_request()) + "\n", ScriptedServices(), flag)
    assert lines[-1]["code"] == "cancelled"


def test_cancel_line_for_the_running_request_sets_the_flag() -> None:
    reader, writer = io.StringIO(), None
    started = threading.Event()
    release = threading.Event()

    class Blocking(ScriptedServices):
        def run_matte(
            self, request: MatteRequest, progress: ProgressSink, cancellation: CancellationFlag
        ) -> MatteOutcome:
            started.set()
            release.wait(2)
            return super().run_matte(request, progress, cancellation)

    stdin_text = (
        line(matte_request()) + "\n" + '{"type":"cancel","protocolVersion":1,"requestId":"req-1"}\n'
    )
    services = Blocking()
    flag = CancellationFlag()
    out = io.StringIO()
    worker = threading.Thread(
        target=run_worker, args=(io.StringIO(stdin_text), out, lambda: services, flag)
    )
    worker.start()
    started.wait(2)
    for _ in range(100):
        if flag.is_cancelled():
            break
        threading.Event().wait(0.01)
    release.set()
    worker.join(2)
    assert json.loads(out.getvalue().splitlines()[-1])["code"] == "cancelled"
    del reader, writer


def test_throttled_progress_keeps_phase_changes_and_completion() -> None:
    written: list[str] = []
    now = [0.0]
    emit = throttled_progress("r", written.append, clock=lambda: now[0])
    for index in range(10):
        emit("segment", index, 100)
    emit("segment", 100, 100)
    emit("refine", 0, 5)
    phases = [json.loads(item)["phase"] for item in written]
    assert phases == ["segment", "segment", "refine"]


def test_warm_worker_serves_many_frames_and_refuses_mattes() -> None:
    services = ScriptedServices()
    builds: list[int] = []

    def create() -> ScriptedServices:
        builds.append(1)
        return services

    stdin_text = (
        "\n".join(
            [
                line(segment_frame_request()),
                line(matte_request()),
                line({**segment_frame_request(), "requestId": "seg-2"}),
            ]
        )
        + "\n"
    )
    out = io.StringIO()
    assert run_warm_worker(io.StringIO(stdin_text), out, create) == 0
    lines = [json.loads(item) for item in out.getvalue().splitlines()]
    assert [(item["type"], item["requestId"]) for item in lines] == [
        ("result", "seg-1"),
        ("failure", "req-1"),
        ("result", "seg-2"),
    ]
    assert builds == [1], "the warm worker keeps one set of loaded models"
