"""Worker runtime: one request per process, or a warm loop for interactive segmentation.

The host keeps stdin open after writing the request so a ``cancel`` line can arrive mid-run.
Input is therefore drained on a daemon reader thread while work runs on the main thread and
polls the cancellation flag between frames — the worker never blocks on EOF to notice a
cancel. Exactly one terminal message (``result`` or ``failure``) is written per request.

``--framepilot-worker-warm`` (BR3.13) serves ``subject.segment_frame`` requests one after
another until stdin closes, so the image encoder and its embedding cache stay loaded between
hover and click requests. A ``subject.matte`` request is refused there: a full-clip job is a
separate, cancellable process with its own memory ceiling.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Protocol, TextIO

from .backend import (
    BackendUnavailableError,
    MediaUnreadableError,
    ModelUnavailableError,
    ToolUnavailableError,
)
from .protocol import (
    CancelMessage,
    MatteOutcome,
    MatteRequest,
    ProgressPhase,
    ProtocolError,
    SegmentFrameRequest,
    WorkerRequest,
    encode_line,
    failure_message,
    matte_result_message,
    parse_input_line,
    progress_message,
    segment_frame_result_message,
)

_log = logging.getLogger(__name__)

UNIDENTIFIED_REQUEST_ID: Final = "unidentified"
#: At most one progress line per phase per this many seconds, plus every phase change.
PROGRESS_MIN_INTERVAL_SECONDS: Final = 0.5


class CancellationFlag:
    """Set by the input reader thread, a signal handler or a watchdog; polled by the pipeline."""

    def __init__(self) -> None:
        self._cancelled = False
        self._reason: ProtocolError | None = None
        self._lock = threading.Lock()

    def cancel(self, reason: ProtocolError | None = None) -> None:
        with self._lock:
            self._cancelled = True
            if reason is not None and self._reason is None:
                self._reason = reason

    def is_cancelled(self) -> bool:
        with self._lock:
            return self._cancelled

    def raise_if_cancelled(self) -> None:
        with self._lock:
            if not self._cancelled:
                return
            reason = self._reason
        if reason is not None:
            raise reason
        raise ProtocolError("cancelled", "Background removal was cancelled by the host.")


class ProgressSink(Protocol):
    def __call__(
        self,
        phase: ProgressPhase,
        completed: int,
        total: int,
        *,
        round_number: int | None = None,
        detail: str | None = None,
        overall: tuple[int, int] | None = None,
    ) -> None: ...


@dataclass(frozen=True, slots=True)
class SegmentFrameOutcome:
    pts: int
    width: int
    height: int
    mask_png_base64: str
    score: float


class WorkerServices(Protocol):
    """What the runtime needs from the pipeline. Tests inject a scripted implementation."""

    @property
    def backend_label(self) -> str: ...

    @property
    def model_digests(self) -> dict[str, str]: ...

    def run_matte(
        self, request: MatteRequest, progress: ProgressSink, cancellation: CancellationFlag
    ) -> MatteOutcome: ...

    def segment_frame(
        self, request: SegmentFrameRequest, cancellation: CancellationFlag
    ) -> SegmentFrameOutcome: ...


#: The host kills a worker after 5 minutes without progress (BR4.12); model loading and a slow
#: window count. The last progress line is repeated at least this often while a request runs.
HEARTBEAT_SECONDS: Final = 20.0


class ProgressChannel:
    """Throttled progress plus a heartbeat that repeats the last line while work is silent.

    Phase changes and completions always pass; repeats of one phase are limited to one per
    :data:`PROGRESS_MIN_INTERVAL_SECONDS`. :meth:`start_heartbeat` re-sends the most recent
    line (initially ``prepare 0/1``) every ``interval`` seconds until :meth:`stop`, which must
    run before the terminal line so no progress ever follows a result.
    """

    def __init__(
        self,
        request_id: str,
        write: Callable[[str], None],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._request_id = request_id
        self._write = write
        self._clock = clock
        self._lock = threading.Lock()
        self._phase: str | None = None
        self._at = 0.0
        self._last: dict[str, object] = {"phase": "prepare", "completed": 0, "total": 1}
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None

    def __call__(
        self,
        phase: ProgressPhase,
        completed: int,
        total: int,
        *,
        round_number: int | None = None,
        detail: str | None = None,
        overall: tuple[int, int] | None = None,
    ) -> None:
        with self._lock:
            if self._stopped.is_set():
                return
            now = self._clock()
            changed = self._phase != phase
            finished = completed >= total
            self._last = {
                "phase": phase,
                "completed": completed,
                "total": total,
                "round_number": round_number,
                "overall": overall,
            }
            if (
                not changed
                and not finished
                and detail is None
                and now - self._at < PROGRESS_MIN_INTERVAL_SECONDS
            ):
                return
            self._phase = phase
            self._at = now
            self._emit(phase, completed, total, round_number, detail, overall)

    def _emit(
        self,
        phase: ProgressPhase,
        completed: int,
        total: int,
        round_number: int | None,
        detail: str | None,
        overall: tuple[int, int] | None = None,
    ) -> None:
        self._write(
            encode_line(
                progress_message(
                    self._request_id,
                    phase,
                    completed,
                    total,
                    round_number=round_number,
                    detail=detail,
                    overall=overall,
                )
            )
        )

    def beat(self) -> None:
        """Repeat the last progress line now (used by the heartbeat thread)."""
        with self._lock:
            if self._stopped.is_set():
                return
            last = self._last
            phase = last["phase"]
            round_number = last.get("round_number")
            self._emit(
                phase,  # type: ignore[arg-type]
                int(last["completed"]),  # type: ignore[call-overload]
                int(last["total"]),  # type: ignore[call-overload]
                round_number if phase == "self_correct" else None,  # type: ignore[arg-type]
                None,
                last.get("overall"),  # type: ignore[arg-type]
            )
            self._at = self._clock()

    def start_heartbeat(self, interval: float = HEARTBEAT_SECONDS) -> None:
        if self._thread is not None:
            return

        def loop() -> None:
            while not self._stopped.wait(interval):
                self.beat()

        self.beat()
        self._thread = threading.Thread(target=loop, daemon=True, name="progress-heartbeat")
        self._thread.start()

    def stop(self) -> None:
        with self._lock:
            self._stopped.set()
        if self._thread is not None:
            self._thread.join(timeout=5)


def throttled_progress(
    request_id: str, write: Callable[[str], None], clock: Callable[[], float] = time.monotonic
) -> ProgressChannel:
    """A progress sink that never floods the host (no heartbeat until started)."""
    return ProgressChannel(request_id, write, clock)


def _translate(error: Exception) -> ProtocolError:
    if isinstance(error, ProtocolError):
        return error
    if isinstance(error, MediaUnreadableError):
        return ProtocolError("media_unreadable", str(error))
    if isinstance(error, ModelUnavailableError):
        return ProtocolError("model_unavailable", str(error))
    if isinstance(error, (BackendUnavailableError, ToolUnavailableError)):
        return ProtocolError("hardware_unsupported", str(error))
    return ProtocolError("internal_error", f"{type(error).__name__}: {error}")


def execute_request(
    request: WorkerRequest,
    services: WorkerServices,
    write: Callable[[str], None],
    cancellation: CancellationFlag,
    heartbeat_seconds: float = HEARTBEAT_SECONDS,
) -> None:
    """Run one request and write exactly one terminal line (result or failure).

    Progress heartbeats run for the whole request, model loading included, and stop before the
    terminal line.
    """
    progress = ProgressChannel(request.request_id, write)
    progress.start_heartbeat(heartbeat_seconds)
    try:
        cancellation.raise_if_cancelled()
        if isinstance(request, MatteRequest):
            outcome = services.run_matte(request, progress, cancellation)
            line = encode_line(
                matte_result_message(
                    request_id=request.request_id,
                    project_revision=request.project_revision,
                    outcome=outcome,
                    backend=services.backend_label,
                    model_digests=services.model_digests,
                )
            )
        else:
            frame = services.segment_frame(request, cancellation)
            line = encode_line(
                segment_frame_result_message(
                    request_id=request.request_id,
                    project_revision=request.project_revision,
                    pts=frame.pts,
                    width=frame.width,
                    height=frame.height,
                    mask_png_base64=frame.mask_png_base64,
                    score=frame.score,
                    backend=services.backend_label,
                    model_digests=services.model_digests,
                )
            )
    except Exception as error:
        progress.stop()
        failure = _translate(error)
        if failure.code == "internal_error":
            _log.exception("smart-mask request failed")
        else:
            _log.warning("smart-mask request refused: %s", failure.code)
        write(
            encode_line(
                failure_message(request.request_id, failure.code, failure.detail, failure.retryable)
            )
        )
        return
    progress.stop()
    write(line)


def _reader(
    stdin: TextIO,
    inbox: queue.Queue[WorkerRequest | ProtocolError | None],
    on_cancel: Callable[[str], None],
) -> None:
    for line in stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            message = parse_input_line(stripped)
        except ProtocolError as error:
            inbox.put(error)
            continue
        if isinstance(message, CancelMessage):
            on_cancel(message.request_id)
            continue
        inbox.put(message)
    inbox.put(None)


def _line_writer(stdout: TextIO) -> Callable[[str], None]:
    lock = threading.Lock()

    def write(line: str) -> None:
        with lock:
            stdout.write(line)
            stdout.flush()

    return write


def run_worker(
    stdin: TextIO,
    stdout: TextIO,
    create_services: Callable[[], WorkerServices],
    cancellation: CancellationFlag | None = None,
) -> int:
    """One-shot runtime: the first line is the request; later lines may cancel it."""
    flag = cancellation or CancellationFlag()
    inbox: queue.Queue[WorkerRequest | ProtocolError | None] = queue.Queue()
    current: dict[str, str] = {}

    def on_cancel(request_id: str) -> None:
        if current.get("id") in (None, request_id):
            flag.cancel()

    threading.Thread(
        target=_reader, args=(stdin, inbox, on_cancel), daemon=True, name="worker-input"
    ).start()
    first = inbox.get()
    write = _line_writer(stdout)
    if first is None:
        first = ProtocolError("invalid_request", "no request was provided on stdin.")
    if isinstance(first, ProtocolError):
        write(
            encode_line(
                failure_message(UNIDENTIFIED_REQUEST_ID, first.code, first.detail, first.retryable)
            )
        )
        return 0
    current["id"] = first.request_id
    try:
        services = create_services()
    except Exception as error:
        failure = _translate(error)
        write(
            encode_line(
                failure_message(first.request_id, failure.code, failure.detail, failure.retryable)
            )
        )
        return 0
    execute_request(first, services, write, flag)
    return 0


def run_warm_worker(
    stdin: TextIO,
    stdout: TextIO,
    create_services: Callable[[], WorkerServices],
) -> int:
    """Serve ``subject.segment_frame`` requests until stdin closes (BR3.13)."""
    inbox: queue.Queue[WorkerRequest | ProtocolError | None] = queue.Queue()
    flags: dict[str, CancellationFlag] = {}
    flags_lock = threading.Lock()

    def on_cancel(request_id: str) -> None:
        with flags_lock:
            flag = flags.get(request_id)
        if flag is not None:
            flag.cancel()

    threading.Thread(
        target=_reader, args=(stdin, inbox, on_cancel), daemon=True, name="warm-input"
    ).start()
    write = _line_writer(stdout)
    services: WorkerServices | None = None
    while True:
        message = inbox.get()
        if message is None:
            return 0
        if isinstance(message, ProtocolError):
            write(
                encode_line(
                    failure_message(
                        UNIDENTIFIED_REQUEST_ID, message.code, message.detail, message.retryable
                    )
                )
            )
            continue
        if isinstance(message, MatteRequest):
            write(
                encode_line(
                    failure_message(
                        message.request_id,
                        "invalid_request",
                        "the warm worker serves subject.segment_frame only; "
                        "run subject.matte as its own job.",
                        False,
                    )
                )
            )
            continue
        flag = CancellationFlag()
        with flags_lock:
            flags[message.request_id] = flag
        try:
            if services is None:
                try:
                    services = create_services()
                except Exception as error:
                    failure = _translate(error)
                    write(
                        encode_line(
                            failure_message(
                                message.request_id, failure.code, failure.detail, failure.retryable
                            )
                        )
                    )
                    continue
            execute_request(message, services, write, flag)
        finally:
            with flags_lock:
                flags.pop(message.request_id, None)


__all__ = [
    "HEARTBEAT_SECONDS",
    "CancellationFlag",
    "ProgressChannel",
    "ProgressSink",
    "SegmentFrameOutcome",
    "WorkerServices",
    "execute_request",
    "run_warm_worker",
    "run_worker",
    "throttled_progress",
]
