"""One-shot runtime: read one request, emit bounded progress, emit one terminal message.

The host keeps stdin open after writing the request so a ``cancel`` line can
arrive mid-run. Input is therefore drained on a daemon reader thread while
inference runs on the main thread and polls the cancellation flag between frames
— the worker must never block on EOF to notice a cancel.

Exactly one terminal message (``result`` **or** ``failure``) is ever written.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Final, Protocol, TextIO

from .backend import (
    BackendUnavailableError,
    MediaUnreadableError,
    ModelUnavailableError,
    SubjectBackend,
)
from .policy import SubjectNotFoundError, run_detection, run_segmentation
from .protocol import (
    CancelMessage,
    Detection,
    MaskSample,
    ProtocolError,
    SubjectRequest,
    detection_result_message,
    encode_line,
    failure_message,
    mask_result_message,
    parse_input_line,
    progress_message,
)

#: Frames between progress lines. Bounded so a long run cannot flood the host.
PROGRESS_INTERVAL_FRAMES: Final = 8
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
    request: SubjectRequest,
    backend: SubjectBackend,
    write: LineWriter,
    cancellation: CancellationFlag,
) -> None:
    """Run one request, writing progress and exactly one terminal message."""
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
        if request.capability == "subject.detect":
            _run_detection(request, source, backend, write, total, cancellation)
        else:
            _run_segmentation(request, source, backend, write, total, cancellation)
    except SubjectNotFoundError as error:
        # An honest "there is nothing there", not an internal error and not a
        # fabricated result.
        raise ProtocolError("target_lost", str(error), retryable=False) from error
    finally:
        source.close()


def _run_detection(
    request: SubjectRequest,
    source: object,
    backend: SubjectBackend,
    write: LineWriter,
    total: int,
    cancellation: CancellationFlag,
) -> None:
    detections: list[Detection] = []
    for processed, frame_detections in enumerate(
        run_detection(
            request,
            source,  # type: ignore[arg-type]
            backend,
            should_cancel=cancellation.is_cancelled,
        ),
        start=1,
    ):
        detections.extend(frame_detections)
        if processed % PROGRESS_INTERVAL_FRAMES == 0:
            write(encode_line(progress_message(request.request_id, "detect", processed, total)))
    write(encode_line(progress_message(request.request_id, "encode", total, total)))
    write(
        encode_line(
            detection_result_message(
                request_id=request.request_id,
                project_revision=request.project_revision,
                detections=detections,
                backend=backend.name,
                model_digests=backend.model_digests,
            )
        )
    )


def _run_segmentation(
    request: SubjectRequest,
    source: object,
    backend: SubjectBackend,
    write: LineWriter,
    total: int,
    cancellation: CancellationFlag,
) -> None:
    masks: list[MaskSample] = []
    for mask in run_segmentation(
        request,
        source,  # type: ignore[arg-type]
        backend,
        should_cancel=cancellation.is_cancelled,
    ):
        masks.append(mask)
        if len(masks) % PROGRESS_INTERVAL_FRAMES == 0:
            write(encode_line(progress_message(request.request_id, "segment", len(masks), total)))
    write(encode_line(progress_message(request.request_id, "encode", total, total)))
    write(
        encode_line(
            mask_result_message(
                request_id=request.request_id,
                project_revision=request.project_revision,
                masks=masks,
                backend=backend.name,
                model_digests=backend.model_digests,
            )
        )
    )


def _read_input(
    stdin: TextIO,
    cancellation: CancellationFlag,
    on_request: Callable[[SubjectRequest | ProtocolError], None],
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
    create_backend: Callable[[], SubjectBackend],
    cancellation: CancellationFlag | None = None,
) -> int:
    """Runtime entrypoint. Returns the process exit code."""
    flag = cancellation or CancellationFlag()
    received: list[SubjectRequest | ProtocolError] = []
    ready = threading.Event()

    def on_request(message: SubjectRequest | ProtocolError) -> None:
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

    request_id = first.request_id if isinstance(first, SubjectRequest) else UNIDENTIFIED_REQUEST_ID
    try:
        if isinstance(first, ProtocolError):
            raise first
        if flag.is_cancelled():
            raise ProtocolError("cancelled", "subject analysis cancelled by the host.")
        try:
            backend = create_backend()
        except BackendUnavailableError as error:
            raise ProtocolError("hardware_unsupported", str(error), retryable=False) from error
        except ModelUnavailableError as error:
            raise ProtocolError("model_unavailable", str(error), retryable=False) from error
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
    "execute_request",
    "run_worker",
]
