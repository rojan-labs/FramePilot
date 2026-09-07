"""The one-shot runtime: one request in, exactly one terminal message out."""

from __future__ import annotations

import io
import json
from collections.abc import Callable
from typing import Any

import pytest
from conftest import FakeDescribeBackend, answer, request_line

from framepilot_visual_describe.backend import (
    BackendUnavailableError,
    DescribeBackend,
    ModelUnavailableError,
)
from framepilot_visual_describe.runtime import CancellationFlag, run_worker
from framepilot_visual_describe.schema import TIER2_VERSION


def _run(stdin_text: str, create_backend: Callable[[], DescribeBackend]) -> list[dict[str, Any]]:
    stdout = io.StringIO()
    assert run_worker(io.StringIO(stdin_text), stdout, create_backend) == 0
    return [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]


def _terminal(messages: list[dict[str, Any]]) -> dict[str, Any]:
    terminals = [m for m in messages if m["type"] in {"result", "failure"}]
    assert len(terminals) == 1, "exactly one terminal message"
    return terminals[0]


def test_a_full_run_produces_progress_then_one_result() -> None:
    messages = _run(request_line() + "\n", FakeDescribeBackend)
    assert [m["type"] for m in messages[:2]] == ["progress", "progress"]
    result = _terminal(messages)
    assert result["capability"] == "visual.describe"
    assert result["tier2Version"] == TIER2_VERSION
    assert [shot["shotIndex"] for shot in result["shots"]] == [0, 1]
    assert result["projectRevision"] == 3


def test_progress_moves_once_per_shot() -> None:
    messages = _run(request_line() + "\n", FakeDescribeBackend)
    describing = [m for m in messages if m.get("phase") == "describe"]
    assert [m["completed"] for m in describing] == [1, 2]


def test_a_tier_version_the_pack_does_not_ship_is_refused_before_decoding() -> None:
    backend = FakeDescribeBackend()
    body = json.loads(request_line())
    body["parameters"]["tier2Version"] = TIER2_VERSION + 1
    messages = _run(json.dumps(body) + "\n", lambda: backend)
    failure = _terminal(messages)
    assert failure["type"] == "failure"
    assert failure["code"] == "invalid_request"
    assert backend.decoded == []


def test_an_empty_stdin_is_an_invalid_request() -> None:
    failure = _terminal(_run("", FakeDescribeBackend))
    assert failure["code"] == "invalid_request"
    assert failure["requestId"] == "unidentified"


def test_a_cancel_line_before_work_stops_the_run() -> None:
    cancel = json.dumps({"type": "cancel", "protocolVersion": 1, "requestId": "describe:asset-1:0"})
    stdout = io.StringIO()
    flag = CancellationFlag()
    flag.cancel()
    assert (
        run_worker(
            io.StringIO(request_line() + "\n" + cancel + "\n"), stdout, FakeDescribeBackend, flag
        )
        == 0
    )
    failure = _terminal([json.loads(line) for line in stdout.getvalue().splitlines()])
    assert failure["code"] == "cancelled"


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (BackendUnavailableError("no Metal"), "hardware_unsupported"),
        (ModelUnavailableError("placeholder pin"), "model_unavailable"),
    ],
)
def test_backend_construction_failures_map_to_their_typed_codes(
    error: Exception, code: str
) -> None:
    def create() -> DescribeBackend:
        raise error

    failure = _terminal(_run(request_line() + "\n", create))
    assert failure["code"] == code
    assert failure["retryable"] is False


def test_an_unexpected_exception_is_reported_not_crashed() -> None:
    def create() -> DescribeBackend:
        raise RuntimeError("something else entirely")

    failure = _terminal(_run(request_line() + "\n", create))
    assert failure["code"] == "internal_error"
    assert "RuntimeError" in failure["detail"]


def test_a_second_request_on_one_process_is_ignored() -> None:
    messages = _run(request_line() + "\n" + request_line() + "\n", FakeDescribeBackend)
    assert len([m for m in messages if m["type"] == "result"]) == 1


def test_the_result_carries_the_backend_identity_and_digests() -> None:
    result = _terminal(_run(request_line() + "\n", FakeDescribeBackend))
    assert result["backend"] == "fake"
    assert result["model"] == "fake/describe-1"
    assert set(result["modelDigests"]) == {"fake.gguf"}


def test_a_shot_the_model_could_not_describe_fails_the_whole_request() -> None:
    backend = FakeDescribeBackend(answers=[answer(), answer(summary="")])
    failure = _terminal(_run(request_line() + "\n", lambda: backend))
    assert failure["type"] == "failure"
    # No partial result: a described row that was never produced must not read as coverage.
    assert failure["code"] == "internal_error"
