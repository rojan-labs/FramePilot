"""Unexpected route failures must say what went wrong.

WHY THIS FILE EXISTS. FastAPI answers an unhandled exception with the literal body
``Internal Server Error``, and ``sidecar-executor.ts`` puts that body in front of the
model verbatim. Measured in ``framepilot.runs.jsonl`` over four days of real agent runs:
**132 of 388 ``get_frame`` calls failed, 100 of them with exactly that sentence.** The
agent's only way to LOOK at its own edit failed a third of the time and told nobody —
not the model, which could only call again, and not us, because the cause reached
stderr and nothing else. Every route in the service was equally silent.
"""

from __future__ import annotations

import logging

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from framepilot_engine.service import (
    MAX_FAILURE_DETAIL_CHARS,
    create_app,
    describe_engine_failure,
)


class TestDescribeEngineFailure:
    def test_names_the_exception_type_and_message(self) -> None:
        assert describe_engine_failure(ValueError("bad codec")) == "ValueError: bad codec"

    def test_keeps_the_type_when_there_is_no_message(self) -> None:
        # Strictly more than "Internal Server Error": the class of problem is named.
        assert describe_engine_failure(RuntimeError()) == "RuntimeError"

    def test_reduces_absolute_paths_to_a_basename(self) -> None:
        # The string is read by a model and echoed into a chat transcript; neither needs
        # this machine's directory layout.
        described = describe_engine_failure(
            FileNotFoundError("/Users/someone/Projects/media/take-1.mp4 is missing")
        )
        assert described == "FileNotFoundError: take-1.mp4 is missing"
        assert "/Users/" not in described

    def test_collapses_multi_line_engine_output_to_one_line(self) -> None:
        described = describe_engine_failure(ValueError("ffmpeg exited 1:\n   bad codec"))
        assert described == "ValueError: ffmpeg exited 1: bad codec"

    def test_bounds_a_runaway_stderr(self) -> None:
        described = describe_engine_failure(OSError("x" * 5_000))
        assert len(described) <= MAX_FAILURE_DETAIL_CHARS + len("… (truncated)")
        assert described.endswith("… (truncated)")


class TestUnhandledRouteErrors:
    @staticmethod
    def _client_raising(exc: BaseException) -> TestClient:
        app = create_app()

        @app.get("/_boom")
        def _boom() -> None:  # pragma: no cover - body is the raise
            raise exc

        # `raise_server_exceptions=False` makes TestClient behave like a real HTTP
        # client: it returns the 500 the handler produced instead of re-raising, which
        # is the whole thing under test.
        return TestClient(app, raise_server_exceptions=False)

    def test_an_unexpected_failure_says_what_it_was(self) -> None:
        response = self._client_raising(
            FileNotFoundError("/tmp/projects/media/take-1.mp4 is missing")
        ).get("/_boom")
        assert response.status_code == 500
        detail = response.json()["detail"]
        # The regression, stated exactly: this is what the model used to be handed.
        assert detail != "Internal Server Error"
        assert detail == "FileNotFoundError: take-1.mp4 is missing"

    def test_carries_an_id_that_correlates_with_the_logged_traceback(
        self,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.ERROR, logger="framepilot_engine.service"):
            response = self._client_raising(RuntimeError("decoder gave up")).get("/_boom")
        error_id = response.json()["errorId"]
        assert error_id
        # The full traceback stays in the log, addressable by the id the caller was given.
        record = next(r for r in caplog.records if error_id in r.getMessage())
        assert record.exc_info is not None

    def test_never_returns_a_traceback(self) -> None:
        response = self._client_raising(RuntimeError("decoder gave up")).get("/_boom")
        body = response.text
        assert "Traceback" not in body
        assert "service.py" not in body

    def test_leaves_deliberate_http_errors_alone(self) -> None:
        # Every considered 4xx in the service raises HTTPException, and FastAPI's own
        # handler answers those. Swallowing them here would turn a precise 422 into a
        # generic 500 and lose the wording the route chose.
        response = self._client_raising(
            HTTPException(status_code=422, detail="time is past the end of the timeline")
        ).get("/_boom")
        assert response.status_code == 422
        assert response.json()["detail"] == "time is past the end of the timeline"
