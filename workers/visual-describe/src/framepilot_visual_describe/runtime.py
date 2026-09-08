"""One-shot runtime: read one request, emit bounded progress, emit one terminal message.

The host keeps stdin open after writing the request so a ``cancel`` line can arrive
mid-run. Input is therefore drained on a daemon reader thread while inference runs on the
main thread and polls the cancellation flag between shots — the worker must never block on
EOF to notice a cancel, and tier 2's shots are seconds apart, so cancelling matters here
more than anywhere else.

Exactly one terminal message (``result`` **or** ``failure``) is ever written.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Final, Protocol, TextIO

from .backend import (
    BackendUnavailableError,
    DescribeBackend,
    ModelUnavailableError,
)
from .policy import describe_shots
from .protocol import (
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
from .schema import TIER2_VERSION

#: Shots between progress lines. One, unlike tier 1's four: a tier-2 shot is seconds of
#: wall clock, and a badge reading "describing 12/61" is only true if it moves per shot.
PROGRESS_INTERVAL_SHOTS: Final = 1
#: Request id used when a failure happens before a request id could be parsed.
UNIDENTIFIED_REQUEST_ID: Final = "unidentified"


class LineWriter(Protocol):
    def __call__(self, line: str) -> None: ...


class CancellationFlag:
    """Set by the input reader thread or a signal handler; polled by the run loop."""

    def __init__(self) -> None:
        self._cancelled = False
        self._lock = threading.Lock()

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True

    def is_cancelled(self) -> bool:
        with self._lock:
            return self._cancelled


def execute_request(
    request: DescribeRequest,
    backend: DescribeBackend,
    write: LineWriter,
    cancellation: CancellationFlag,
) -> None:
    """Run one request, writing progress and exactly one terminal message."""
    # The tier version is checked BEFORE any decoding: describing a hundred shots against
    # a schema the host does not speak, and only then discovering the mismatch, would cost
    # the whole batch and write facts nobody can interpret.
    if request.tier2_version != TIER2_VERSION:
        raise ProtocolError(
            "invalid_request",
            f"host asked for tier2 v{request.tier2_version}; this pack ships v{TIER2_VERSION}.",
        )
    total = len(request.shots)
    write(encode_line(progress_message(request.request_id, "initialize", 0, total)))
    described: list[ShotDescription] = []
    for shot in describe_shots(request, backend, should_cancel=cancellation.is_cancelled):
        described.append(shot)
        if len(described) % PROGRESS_INTERVAL_SHOTS == 0:
            write(
                encode_line(progress_message(request.request_id, "describe", len(described), total))
            )
    write(encode_line(progress_message(request.request_id, "encode", total, total)))
    write(
        encode_line(
            describe_result_message(
                request_id=request.request_id,
                project_revision=request.project_revision,
                tier2_version=TIER2_VERSION,
                model=backend.model_id,
                shots=described,
                backend=backend.name,
                model_digests=backend.model_digests,
            )
        )
    )


def _read_input(
    stdin: TextIO,
    cancellation: CancellationFlag,
    on_request: Callable[[DescribeRequest | ProtocolError], None],
) -> None:
    """Drain stdin: the first line is the request, later lines may cancel it."""
    request_seen = False
    for line in stdin:
        stripped = line.strip()
        if stripped == "":
            continue
        try:
            message = parse_input_line(stripped)
        except ProtocolError as error:
            if not request_seen:
                request_seen = True
                on_request(error)
            continue
        if isinstance(message, CancelMessage):
            cancellation.cancel()
            continue
        if request_seen:
            # A second request in one process is a protocol violation; the host runs one
            # request per worker. Ignore it rather than interleave work.
            continue
        request_seen = True
        on_request(message)
    if not request_seen:
        on_request(ProtocolError("invalid_request", "no request was provided on stdin."))


def run_worker(
    stdin: TextIO,
    stdout: TextIO,
    create_backend: Callable[[], DescribeBackend],
    cancellation: CancellationFlag | None = None,
) -> int:
    """Runtime entrypoint. Returns the process exit code."""
    flag = cancellation or CancellationFlag()
    received: list[DescribeRequest | ProtocolError] = []
    ready = threading.Event()

    def on_request(message: DescribeRequest | ProtocolError) -> None:
        received.append(message)
        ready.set()

    reader = threading.Thread(
        target=_read_input, args=(stdin, flag, on_request), daemon=True, name="worker-input"
    )
    reader.start()
    ready.wait()
    first = received[0]

    def write(line: str) -> None:
        stdout.write(line)
        stdout.flush()

    request_id = (
        first.request_id if not isinstance(first, ProtocolError) else UNIDENTIFIED_REQUEST_ID
    )
    try:
        if isinstance(first, ProtocolError):
            raise first
        if flag.is_cancelled():
            raise ProtocolError("cancelled", "shot description cancelled by the host.")
        try:
            backend = create_backend()
        except BackendUnavailableError as error:
            raise ProtocolError("hardware_unsupported", str(error), retryable=False) from error
        except ModelUnavailableError as error:
            raise ProtocolError("model_unavailable", str(error), retryable=False) from error
        execute_request(first, backend, write, flag)
    except ProtocolError as error:
        write(encode_line(failure_message(request_id, error.code, error.detail, error.retryable)))
        # A typed failure is a completed transaction, not a crash: the host reads the
        # failure line, so the process exits cleanly.
        return 0
    except Exception as error:
        write(
            encode_line(
                failure_message(
                    request_id, "internal_error", f"{type(error).__name__}: {error}", False
                )
            )
        )
        return 0
    return 0


__all__ = ["CancellationFlag", "execute_request", "run_worker"]
