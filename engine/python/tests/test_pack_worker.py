"""The engine's side of the Capability Pack worker protocol.

Two boundaries are under test, and they are different kinds of thing:

- **The handle** is untrusted-shaped input from the host. Every malformed variant must
  degrade to "no local pack", never to a failed index slice — a machine WITH a pack must
  not index less than a machine without one.
- **The transport** is a subprocess that can lie, hang, or die. Every one of those must
  become a typed :class:`PackWorkerError`, never a partial answer written to the ledger.

Nothing here installs a pack or runs a model: the launcher is injected, so the whole
protocol surface is exercised with a scripted process.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.brain.pack_worker import (
    PROTOCOL_VERSION,
    PackHandle,
    PackWorkerError,
    parse_pack_handle,
    run_pack_request,
)

CAPABILITIES = ["visual.embed", "visual.text"]


@pytest.fixture
def entrypoint(tmp_path: Path) -> Path:
    path = tmp_path / "framepilot-visual-embed"
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    return path


def handle_json(entrypoint: Path, **overrides: Any) -> str:
    payload: dict[str, Any] = {
        "packId": "framepilot.visual-embed",
        "version": "1.0.0",
        "releaseDigest": "a" * 64,
        "entrypoint": str(entrypoint),
        "capabilities": CAPABILITIES,
        "root": str(entrypoint.parent),
    }
    payload.update(overrides)
    return json.dumps(payload)


class FakeProcess:
    """A scripted worker: emits ``lines`` on stdout, then exits with ``returncode``."""

    def __init__(self, lines: list[str], *, returncode: int = 0, stderr: str = "") -> None:
        self._stdout = "".join(f"{line}\n" for line in lines)
        self._stderr = stderr
        self.returncode: int | None = returncode
        self.stdin_written: str | None = None
        self.killed = False

    def communicate(
        self, input: str | None = None, timeout: float | None = None
    ) -> tuple[str, str]:
        self.stdin_written = input or ""
        return self._stdout, self._stderr

    def kill(self) -> None:
        self.killed = True


class HangingProcess(FakeProcess):
    def __init__(self) -> None:
        super().__init__([])
        self._first = True

    def communicate(
        self, input: str | None = None, timeout: float | None = None
    ) -> tuple[str, str]:
        if self._first:
            self._first = False
            raise subprocess.TimeoutExpired(cmd="worker", timeout=timeout or 0.0)
        return "", ""


def result_line(**overrides: Any) -> str:
    message: dict[str, Any] = {
        "type": "result",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": "embed:1",
        "projectRevision": 0,
        "capability": "visual.embed",
        "backend": "fake",
        "modelDigests": {},
        "dim": 2,
        "promptBankVersion": 1,
        "shots": [],
    }
    message.update(overrides)
    return json.dumps(message)


def request(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "request",
        "requestId": "embed:1",
        "projectRevision": 0,
        "capability": "visual.embed",
        "parameters": {},
    }
    payload.update(overrides)
    return payload


class TestParseHandle:
    def test_parses_a_complete_handle(self, entrypoint: Path) -> None:
        handle = parse_pack_handle(handle_json(entrypoint), require=CAPABILITIES)
        assert handle is not None
        assert handle.pack_id == "framepilot.visual-embed"
        assert handle.provides("visual.embed")

    @pytest.mark.parametrize("raw", [None, "", "   ", "not json", "[]", '{"packId": "x"}'])
    def test_absent_or_malformed_is_no_pack_never_an_error(self, raw: str | None) -> None:
        assert parse_pack_handle(raw) is None

    def test_a_missing_entrypoint_file_is_no_pack(self, tmp_path: Path) -> None:
        assert parse_pack_handle(handle_json(tmp_path / "gone")) is None

    def test_a_handle_without_the_required_capabilities_is_no_pack(self, entrypoint: Path) -> None:
        assert (
            parse_pack_handle(
                handle_json(entrypoint, capabilities=["visual.embed"]),
                require=CAPABILITIES,
            )
            is None
        )

    def test_the_environment_carries_the_identity_the_worker_checks(self, entrypoint: Path) -> None:
        handle = parse_pack_handle(handle_json(entrypoint))
        assert handle is not None
        env = handle.environment()
        assert env["FRAMEPILOT_CAPABILITY_PACK_ID"] == "framepilot.visual-embed"
        assert json.loads(env["FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES"]) == sorted(CAPABILITIES)
        assert env["FRAMEPILOT_CAPABILITY_PACK_ROOT"] == str(entrypoint.parent)


class TestRunRequest:
    def _handle(self, entrypoint: Path) -> PackHandle:
        handle = parse_pack_handle(handle_json(entrypoint))
        assert handle is not None
        return handle

    def test_returns_the_result_and_drops_progress(self, entrypoint: Path) -> None:
        process = FakeProcess(
            [
                json.dumps(
                    {
                        "type": "progress",
                        "protocolVersion": 1,
                        "requestId": "embed:1",
                        "phase": "embed",
                        "completed": 1,
                        "total": 2,
                    }
                ),
                result_line(),
            ]
        )
        result = run_pack_request(
            self._handle(entrypoint), request(), launch=lambda _handle: process
        )
        assert result["dim"] == 2
        assert json.loads(process.stdin_written or "")["protocolVersion"] == PROTOCOL_VERSION

    def test_a_typed_worker_failure_becomes_a_typed_error(self, entrypoint: Path) -> None:
        process = FakeProcess(
            [
                json.dumps(
                    {
                        "type": "failure",
                        "protocolVersion": 1,
                        "requestId": "embed:1",
                        "code": "model_unavailable",
                        "detail": "placeholder pin",
                        "retryable": False,
                    }
                )
            ]
        )
        with pytest.raises(PackWorkerError) as error:
            run_pack_request(self._handle(entrypoint), request(), launch=lambda _h: process)
        assert error.value.code == "model_unavailable"

    def test_a_process_that_dies_without_a_result_is_an_error_not_an_empty_answer(
        self, entrypoint: Path
    ) -> None:
        process = FakeProcess([], returncode=3, stderr="ImportError: no onnxruntime")
        with pytest.raises(PackWorkerError, match="without a result"):
            run_pack_request(self._handle(entrypoint), request(), launch=lambda _h: process)

    def test_a_hung_worker_is_killed_and_reported_retryable(self, entrypoint: Path) -> None:
        process = HangingProcess()
        with pytest.raises(PackWorkerError) as error:
            run_pack_request(self._handle(entrypoint), request(), launch=lambda _h: process)
        assert process.killed is True
        assert error.value.retryable is True

    @pytest.mark.parametrize(
        ("overrides", "match"),
        [
            ({"requestId": "somebody-else"}, "different request id"),
            ({"capability": "visual.text"}, "different capability"),
            ({"protocolVersion": 2}, "different protocol version"),
        ],
    )
    def test_an_answer_to_another_question_is_refused(
        self, entrypoint: Path, overrides: dict[str, Any], match: str
    ) -> None:
        process = FakeProcess([result_line(**overrides)])
        with pytest.raises(PackWorkerError, match=match):
            run_pack_request(self._handle(entrypoint), request(), launch=lambda _h: process)

    def test_two_terminal_messages_are_refused_rather_than_guessed_between(
        self, entrypoint: Path
    ) -> None:
        process = FakeProcess([result_line(), result_line(dim=4)])
        with pytest.raises(PackWorkerError, match="more than one terminal"):
            run_pack_request(self._handle(entrypoint), request(), launch=lambda _h: process)

    def test_a_line_that_is_not_json_is_a_protocol_error(self, entrypoint: Path) -> None:
        process = FakeProcess(["{oops"])
        with pytest.raises(PackWorkerError, match="not JSON"):
            run_pack_request(self._handle(entrypoint), request(), launch=lambda _h: process)

    def test_a_capability_the_pack_does_not_claim_is_never_launched(self, entrypoint: Path) -> None:
        launched: list[PackHandle] = []

        def launch(handle: PackHandle) -> FakeProcess:
            launched.append(handle)
            return FakeProcess([])

        with pytest.raises(PackWorkerError, match="does not provide"):
            run_pack_request(
                self._handle(entrypoint), request(capability="subject.detect"), launch=launch
            )
        assert launched == []
