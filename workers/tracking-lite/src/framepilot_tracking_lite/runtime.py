"""One-shot runtime: read one request, emit bounded progress, emit one terminal message.

The host keeps stdin open after writing the request so a ``cancel`` line can
arrive mid-track. Input is therefore drained on a daemon reader thread while the
tracking loop runs on the main thread and polls the cancellation flag between
frames — the worker must never block on EOF to notice a cancel.

Exactly one terminal message (``result`` **or** ``failure``) is ever written.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterable
from typing import Final, Protocol, TextIO

from .backend import BackendUnavailableError, MediaUnreadableError, TrackingBackend
from .policy import Tracker, run_tracker
from .protocol import (
    CancelMessage,
    ProtocolError,
    TrackingRequest,
    TrackingSample,
    encode_line,
    failure_message,
    parse_input_line,
    progress_message,
    result_message,
)
from .trackers import PlanarTracker, PointTracker, RegionTracker

#: Frames between progress lines. Bounded so a long track cannot flood the host.
PROGRESS_INTERVAL_FRAMES: Final = 24
#: Request id used when a failure happens before a request id could be parsed.
UNIDENTIFIED_REQUEST_ID: Final = "unidentified"


class LineWriter(Protocol):
    def __call__(self, line: str) -> None: ...


class CancellationFlag:
    """Set by the input reader thread or a signal handler; polled by the tracking loop."""

    def __init__(self) -> None:
        self._cancelled = False
        self._lock = threading.Lock()

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True

    def is_cancelled(self) -> bool:
        with self._lock:
            return self._cancelled


def build_tracker(
    request: TrackingRequest, backend: TrackingBackend, width: int, height: int
) -> Tracker:
    if request.capability == "tracking.point":
        assert request.point is not None
        return PointTracker(backend, request.point, width, height)
    if request.capability == "tracking.region":
        assert request.region is not None
        return RegionTracker(backend, request.region, width, height)
    assert request.corners is not None
    return PlanarTracker(backend, request.corners, width, height)


def execute_request(
    request: TrackingRequest,
    backend: TrackingBackend,
    write: LineWriter,
    cancellation: CancellationFlag,
) -> None:
    """Run one tracking request, writing progress and exactly one terminal message."""
    total = request.media.frame_count
    write(encode_line(progress_message(request.request_id, "decode", 0, total)))
    try:
        source = backend.open_frames(
            request.media.absolute_path,
            request.media.first_frame,
            request.media.last_frame_exclusive,
        )
    except MediaUnreadableError as error:
        raise ProtocolError("media_unreadable", str(error), retryable=False) from error
    try:
        write(encode_line(progress_message(request.request_id, "initialize", 0, total)))
        tracker = build_tracker(request, backend, source.width, source.height)
        samples = _collect(
            run_tracker(request, source, tracker, should_cancel=cancellation.is_cancelled),
            request,
            write,
            total,
        )
        write(encode_line(progress_message(request.request_id, "encode", total, total)))
        write(
            encode_line(
                result_message(
                    request_id=request.request_id,
                    project_revision=request.project_revision,
                    capability=request.capability,
                    samples=samples,
                    backend=backend.name,
                )
            )
        )
    finally:
        source.close()


def _collect(
    stream: Iterable[TrackingSample],
    request: TrackingRequest,
    write: LineWriter,
    total: int,
) -> list[TrackingSample]:
    samples: list[TrackingSample] = []
    for sample in stream:
        samples.append(sample)
        if len(samples) % PROGRESS_INTERVAL_FRAMES == 0:
            write(encode_line(progress_message(request.request_id, "track", len(samples), total)))
    return samples


def _read_input(
    stdin: TextIO,
    cancellation: CancellationFlag,
    on_request: Callable[[TrackingRequest | ProtocolError], None],
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
            # A second request in one process is a protocol violation; the host
            # runs one request per worker. Ignore it rather than interleave work.
            continue
        request_seen = True
        on_request(message)
    if not request_seen:
        on_request(ProtocolError("invalid_request", "no request was provided on stdin."))


def run_worker(
    stdin: TextIO,
    stdout: TextIO,
    create_backend: Callable[[], TrackingBackend],
    cancellation: CancellationFlag | None = None,
) -> int:
    """Runtime entrypoint. Returns the process exit code."""
    flag = cancellation or CancellationFlag()
    received: list[TrackingRequest | ProtocolError] = []
    ready = threading.Event()

    def on_request(message: TrackingRequest | ProtocolError) -> None:
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

    request_id = first.request_id if isinstance(first, TrackingRequest) else UNIDENTIFIED_REQUEST_ID
    try:
        if isinstance(first, ProtocolError):
            raise first
        if flag.is_cancelled():
            raise ProtocolError("cancelled", "tracking cancelled by the host.")
        try:
            backend = create_backend()
        except BackendUnavailableError as error:
            raise ProtocolError("hardware_unsupported", str(error), retryable=False) from error
        execute_request(first, backend, write, flag)
    except ProtocolError as error:
        write(encode_line(failure_message(request_id, error.code, error.detail, error.retryable)))
        # A typed failure is a completed transaction, not a crash: the host reads
        # the failure line, so the process exits cleanly.
        return 0
    except Exception as error:
        write(
            encode_line(
                failure_message(
                    request_id,
                    "internal_error",
                    f"{type(error).__name__}: {error}",
                    False,
                )
            )
        )
        return 0
    return 0


__all__ = [
    "CancellationFlag",
    "build_tracker",
    "execute_request",
    "run_worker",
]
