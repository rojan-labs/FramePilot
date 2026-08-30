"""Background render queue: cancellation, retry and bounded process transport.

The parent queue may receive the fully validated Project, but the spawned render worker
never receives editor-only/derived state. Its JSON payload contains exactly the Project
slices the deterministic render compiler consumes: timeline, render-relevant asset fields,
and transcript only when captions are burned. This keeps multiprocessing transport
independent of waveform peaks, thumbnails, folders, markers, AI memory and undo history.
"""

from __future__ import annotations

import inspect
import json
import logging
import multiprocessing as mp
import os
import queue as queue_mod
import signal
import threading
import time
import uuid
from collections import deque
from collections.abc import Callable
from contextlib import suppress
from enum import StrEnum
from multiprocessing.queues import Queue as MPQueue
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from framepilot_engine.render.pipeline import (
    RenderJob,
    RenderOptions,
    RenderState,
    render,
    resolve_target,
)
from framepilot_engine.safety import resolve_within
from framepilot_engine.timeline.models import Project

_log = logging.getLogger(__name__)

_PROCESS_POLL_SECONDS = 0.05
DEFAULT_RETRY_PAYLOAD_LIMIT = 8


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobCancelled(Exception):
    pass


class JobTimeout(Exception):
    pass


def project_for_render_worker(project: Project, opts: RenderOptions) -> Project:
    """Return the exact render-relevant projection of a validated Project.

    Folders/markers/AI memory/history are editor/agent state, and the compiler reads
    transcript only for burned captions. Dropping those from the spawn payload keeps
    process-copy size from growing with waveform/history/session state.

    ``media`` is KEPT, minus its waveform peaks. It used to be dropped whole, on the
    reasoning that it is "timeline-preview metadata" that "cannot change render
    semantics". It can, and did: ``source_facts`` reads ``media.width``/``media.height``
    to work out the largest short edge the sources actually hold, and that is the cap
    that stops an export upscaling. With ``media`` gone the worker saw no source
    dimensions, so the cap was ``None`` and a 2160p request against a **640x360** source
    rendered a real 3840x2160 file — 148 MB of upscaled nothing, the exact thing
    ``resolve_frame`` documents as "nothing is upscaled quietly". The parent resolved it
    correctly the whole time, which is why it survived: only the spawned worker was wrong.

    The peaks and thumbnail paths are what actually made the payload big (one float per
    waveform sample; one string per bin thumbnail), and nothing in the render reads either
    — the compiler only ever touches ``media.width``/``height`` — so they still go.
    """
    assets = [
        asset.model_copy(
            update={
                "media": (
                    None
                    if asset.media is None
                    else asset.media.model_copy(
                        update={"peaks": None, "peaks_per_second": None, "thumbnail_paths": None}
                    )
                ),
                "folder_id": None,
            }
        )
        for asset in project.assets
    ]
    return project.model_copy(
        update={
            "assets": assets,
            "folders": [],
            "markers": [],
            "ai_memory": {},
            "history": [],
            "transcript": project.transcript if opts.burn_captions else [],
        }
    )


class RenderProcessRequest(BaseModel):
    """Compact data actually copied through multiprocessing spawn."""

    project: Project
    opts: RenderOptions = Field(default_factory=RenderOptions)
    base_dir: str


class RenderRequest(BaseModel):
    """Parent-process request. Full Project lifetime is bounded by :class:`RenderQueue`."""

    project: Project
    opts: RenderOptions = Field(default_factory=RenderOptions)
    base_dir: str = Field(description="Project sandbox root (assets + output).")

    def process_payload_json(self) -> str:
        return RenderProcessRequest(
            project=project_for_render_worker(self.project, self.opts),
            opts=self.opts,
            base_dir=self.base_dir,
        ).model_dump_json()


class RenderTask(BaseModel):
    id: str
    status: JobStatus = JobStatus.QUEUED
    attempts: int = 0
    error: str | None = None
    result: RenderJob | None = Field(default=None)
    #: Live progress while running: the render stage and a 0..1 fraction (plan/system-mission P7.6).
    stage: str | None = None
    progress: float = Field(default=0.0, ge=0.0, le=1.0)


JobExecutor = Callable[..., RenderJob]
ProgressSink = Callable[[str, float], None]


def _run_job_to_queue(
    process_request_json: str,
    result_queue: MPQueue[str],
    progress_queue: MPQueue[str] | None = None,
) -> None:  # pragma: no cover
    # Own process group: ffmpeg is this process's child, and a cancel must reach it too.
    with suppress(OSError, AttributeError):
        os.setsid()
    request = RenderProcessRequest.model_validate_json(process_request_json)

    def report(stage: str, fraction: float) -> None:
        if progress_queue is None:
            return
        with suppress(Exception):
            progress_queue.put_nowait(json.dumps({"stage": stage, "progress": fraction}))

    job = render(request.project, request.opts, base_dir=Path(request.base_dir), progress=report)
    result_queue.put(job.model_dump_json())


def _drain_progress(progress_queue: MPQueue[str], on_progress: ProgressSink | None) -> None:
    """Forward every queued progress message; the newest wins."""
    get_nowait = getattr(progress_queue, "get_nowait", None)
    if get_nowait is None:
        return
    while True:
        try:
            raw = get_nowait()
        except queue_mod.Empty:
            return
        if on_progress is None:
            continue
        with suppress(ValueError, TypeError, KeyError):
            message = json.loads(raw)
            on_progress(str(message["stage"]), float(message["progress"]))


def _terminate_group(proc: Any) -> None:
    """SIGTERM the render's whole process group (python + its ffmpeg), then the process."""
    pid = getattr(proc, "pid", None)
    if pid:
        with suppress(OSError, ProcessLookupError, AttributeError):
            os.killpg(os.getpgid(pid), signal.SIGTERM)
    if proc.is_alive():
        proc.terminate()


def _discard_cancelled_output(request: RenderRequest) -> None:
    """Remove the partial file a cancelled or timed-out render was writing.

    Narrow on purpose: it deletes only the path THIS request named, only when that
    path is inside the request's own sandbox, and it never runs for a job that
    finished — a completed render returns through the result queue and never reaches
    here. A failure to delete is swallowed: the export is already over, and a second
    error about cleanup would replace the reason the editor needs to see.
    """
    try:
        base = Path(request.base_dir)
        if request.opts.output_path is not None:
            path = resolve_within(base, request.opts.output_path)
        else:
            # Most callers name no path — the HTTP API does not — so the pipeline picks
            # `exports/<project id>.<container>`. Recomputing it here is what makes this
            # cleanup work at all: keyed only on an explicit `output_path` it returned
            # early for every real export and the partial survived.
            preset = resolve_target(request.project, request.opts)
            path = base / "exports" / f"{request.project.id}.{preset.container}"
        if path.is_file():
            size = path.stat().st_size
            path.unlink()
            _log.info("render cancelled → discarded partial output (%d bytes)", size)
    except Exception:  # cleanup must never mask the cancellation
        _log.warning("render cancelled → could not discard partial output", exc_info=True)


def subprocess_executor(
    request: RenderRequest,
    cancel_event: threading.Event,
    timeout: float | None,
    on_progress: ProgressSink | None = None,
) -> RenderJob:
    ctx = mp.get_context("spawn")
    result_queue: MPQueue[str] = ctx.Queue()
    progress_queue: MPQueue[str] = ctx.Queue()
    proc = ctx.Process(
        target=_run_job_to_queue,
        args=(request.process_payload_json(), result_queue, progress_queue),
        daemon=True,
    )
    proc.start()
    deadline = time.monotonic() + timeout if timeout else None
    try:
        while True:
            _drain_progress(progress_queue, on_progress)
            try:
                payload = result_queue.get(timeout=_PROCESS_POLL_SECONDS)
                _drain_progress(progress_queue, on_progress)
                return RenderJob.model_validate_json(payload)
            except queue_mod.Empty:
                pass
            if cancel_event.is_set():
                raise JobCancelled
            if deadline is not None and time.monotonic() > deadline:
                raise JobTimeout
            if not proc.is_alive() and result_queue.empty():
                return RenderJob(
                    id=uuid.uuid4().hex,
                    project_id=request.project.id,
                    state=RenderState.FAILED,
                    error="render process exited without a result",
                )
    except (JobCancelled, JobTimeout):
        # The worker dies by SIGTERM to its process group, so NOTHING in it runs on the
        # way out — not MoviePy's cleanup, and not the pipeline's own partial-file
        # discard, which only ever sees exceptions raised inside the worker. MoviePy
        # writes progressively into the destination, so a cancelled export left a
        # half-written file exactly where a finished one goes: 4 MB of unplayable video
        # that looks like the export until someone opens it. The parent is the only
        # thing still alive to clean it up.
        _discard_cancelled_output(request)
        raise
    finally:
        _terminate_group(proc)
        proc.join()


class RenderQueue:
    def __init__(
        self,
        *,
        executor: JobExecutor | None = None,
        workers: int = 1,
        default_timeout: float | None = None,
        max_retries: int = 0,
        retry_payload_limit: int = DEFAULT_RETRY_PAYLOAD_LIMIT,
    ) -> None:
        self._executor = executor or subprocess_executor
        self._default_timeout = default_timeout
        self._max_retries = max_retries
        self._retry_payload_limit = max(0, retry_payload_limit)
        self._lock = threading.Lock()
        self._tasks: dict[str, RenderTask] = {}
        self._requests: dict[str, RenderRequest] = {}
        self._cancels: dict[str, threading.Event] = {}
        self._retry_payload_order: deque[str] = deque()
        self._pending: queue_mod.Queue[str] = queue_mod.Queue()
        self._stopping = threading.Event()
        self._threads = [
            threading.Thread(target=self._worker, daemon=True, name=f"render-worker-{i}")
            for i in range(max(1, workers))
        ]
        for thread in self._threads:
            thread.start()

    def submit(self, request: RenderRequest) -> str:
        task_id = uuid.uuid4().hex
        with self._lock:
            self._tasks[task_id] = RenderTask(id=task_id)
            self._requests[task_id] = request
            self._cancels[task_id] = threading.Event()
        self._pending.put(task_id)
        return task_id

    def get(self, task_id: str) -> RenderTask | None:
        with self._lock:
            task = self._tasks.get(task_id)
            return task.model_copy(deep=True) if task else None

    def list(self) -> list[RenderTask]:
        with self._lock:
            return [task.model_copy(deep=True) for task in self._tasks.values()]

    def retained_request_count(self) -> int:
        with self._lock:
            return len(self._requests)

    def _run_executor(
        self,
        task_id: str,
        request: RenderRequest,
        cancel_event: threading.Event,
        timeout: float | None,
    ) -> RenderJob:
        def on_progress(stage: str, fraction: float) -> None:
            with self._lock:
                task = self._tasks.get(task_id)
                if task is not None and task.status == JobStatus.RUNNING:
                    task.stage = stage
                    task.progress = max(0.0, min(1.0, fraction))

        accepts_progress = "on_progress" in inspect.signature(self._executor).parameters
        if accepts_progress:
            return self._executor(request, cancel_event, timeout, on_progress=on_progress)
        return self._executor(request, cancel_event, timeout)

    def cancel(self, task_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or task.status in _TERMINAL:
                return False
            cancel_event = self._cancels.get(task_id)
            if cancel_event is None:
                return False
            cancel_event.set()
            if task.status == JobStatus.QUEUED:
                task.status = JobStatus.CANCELLED
                self._retain_retry_payload_locked(task_id)
            return True

    def retry(self, task_id: str) -> bool:
        with self._lock:
            task = self._tasks.get(task_id)
            request = self._requests.get(task_id)
            if (
                task is None
                or request is None
                or task.status not in (JobStatus.FAILED, JobStatus.CANCELLED)
            ):
                return False
            self._remove_retry_order_locked(task_id)
            task.status = JobStatus.QUEUED
            task.error = None
            task.result = None
            self._cancels[task_id] = threading.Event()
        self._pending.put(task_id)
        return True

    def shutdown(self, *, wait: bool = True) -> None:
        self._stopping.set()
        if wait:
            for thread in self._threads:
                thread.join(timeout=5.0)

    def _remove_retry_order_locked(self, task_id: str) -> None:
        with suppress(ValueError):
            self._retry_payload_order.remove(task_id)

    def _release_request_locked(self, task_id: str) -> None:
        self._requests.pop(task_id, None)
        self._cancels.pop(task_id, None)
        self._remove_retry_order_locked(task_id)

    def _retain_retry_payload_locked(self, task_id: str) -> None:
        self._cancels.pop(task_id, None)
        self._remove_retry_order_locked(task_id)
        if task_id not in self._requests or self._retry_payload_limit == 0:
            self._requests.pop(task_id, None)
            return
        self._retry_payload_order.append(task_id)
        while len(self._retry_payload_order) > self._retry_payload_limit:
            evicted = self._retry_payload_order.popleft()
            self._requests.pop(evicted, None)
            self._cancels.pop(evicted, None)

    def _worker(self) -> None:
        while not self._stopping.is_set():
            try:
                task_id = self._pending.get(timeout=_PROCESS_POLL_SECONDS)
            except queue_mod.Empty:
                continue
            self._run_one(task_id)

    def _run_one(self, task_id: str) -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            request = self._requests.get(task_id)
            cancel_event = self._cancels.get(task_id)
            if task is None or request is None or cancel_event is None:
                return
            if task.status == JobStatus.CANCELLED or cancel_event.is_set():
                task.status = JobStatus.CANCELLED
                self._retain_retry_payload_locked(task_id)
                return
            task.status = JobStatus.RUNNING
            task.attempts += 1
            timeout = request.opts.timeout_seconds or self._default_timeout
        _log.info("ACT render job %s running (attempt %d)", task_id, task.attempts)
        try:
            job = self._run_executor(task_id, request, cancel_event, timeout)
            status = JobStatus.COMPLETED if job.state == RenderState.COMPLETED else JobStatus.FAILED
            self._finish(task_id, status, result=job, error=job.error)
        except JobCancelled:
            self._finish(task_id, JobStatus.CANCELLED, error="cancelled")
        except JobTimeout:
            self._finish(task_id, JobStatus.FAILED, error="timed out")
        except Exception as exc:
            self._finish(task_id, JobStatus.FAILED, error=str(exc))

    def _finish(
        self,
        task_id: str,
        status: JobStatus,
        *,
        result: RenderJob | None = None,
        error: str | None = None,
    ) -> None:
        retry_now = False
        with self._lock:
            task = self._tasks[task_id]
            task.status = status
            task.result = result
            task.error = error
            if status == JobStatus.FAILED and task.attempts <= self._max_retries:
                task.status = JobStatus.QUEUED
                task.error = None
                self._cancels[task_id] = threading.Event()
                retry_now = True
                _log.warning(
                    "ACT render job %s failed (attempt %d/%d), retrying: %s",
                    task_id,
                    task.attempts,
                    self._max_retries,
                    error,
                )
            elif status == JobStatus.COMPLETED:
                _log.info("ACT render job %s completed", task_id)
                self._release_request_locked(task_id)
            elif status == JobStatus.FAILED:
                _log.error("ACT render job %s failed: %s", task_id, error)
                self._retain_retry_payload_locked(task_id)
            else:
                _log.info("ACT render job %s %s", task_id, status.value)
                self._retain_retry_payload_locked(task_id)
        if retry_now:
            self._pending.put(task_id)


_TERMINAL = frozenset({JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED})
