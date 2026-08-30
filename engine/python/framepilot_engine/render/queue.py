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

#: How often a render worker checks that the processes that own it are still alive.
_ORPHAN_WATCH_INTERVAL_SECONDS = 2.0
#: Seconds a worker's own group gets to die from SIGTERM before the watchdog SIGKILLs it.
_ORPHAN_WATCH_GRACE_SECONDS = 5.0
#: Env var carrying the Electron main-process pid; set by the desktop app when it spawns
#: the sidecar (``apps/desktop/electron/sidecar/spawn.ts``) and inherited all the way down
#: here, because ``mp.get_context("spawn")`` copies ``os.environ`` into the child.
_PARENT_PID_ENV = "FRAMEPILOT_PARENT_PID"
#: Seconds a cancelled render's process gets to die politely before SIGKILL.
_WORKER_STOP_GRACE_SECONDS = 5.0
#: Seconds to wait for the process to be reaped after SIGKILL before giving up on it.
_WORKER_KILL_GRACE_SECONDS = 5.0


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


def _pid_is_alive(pid: int) -> bool:
    """Is ``pid`` a live process?

    ``PermissionError`` counts as ALIVE: it means the pid exists but belongs to another
    user, which is what an OS-recycled pid looks like. Reading that as "dead" would make
    the orphan watchdog kill a perfectly healthy export.
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


def _watch_owners_and_die(owner_pids: tuple[int, ...], interval: float, grace: float) -> None:
    """Kill this render's own process group once any owning process is gone.

    WHY this exists at all: this worker calls :func:`os.setsid`, which is what lets a
    per-job cancel signal its ffmpeg without touching the engine — but it also puts the
    worker permanently OUTSIDE the sidecar's process group. The desktop app kills the
    sidecar group on quit and sweeps registered pids on the next launch; this process is
    in neither. Quit the app mid-export and ffmpeg kept running, kept burning cores, and
    kept writing into the user's project. Only the worker can notice, because it is the
    one that outlived its owners.

    Both owners are watched, and EITHER dying is fatal, because they fail differently:

    * ``os.getppid()`` is the sidecar. It owns the result queue — if it dies, this render
      has no reader and its output can never be delivered. A sidecar crash kills this one.
    * ``FRAMEPILOT_PARENT_PID`` is the Electron main process. A Force Quit or ``kill -9``
      of the app kills that pid while the sidecar (spawned detached) may briefly survive.

    :param owner_pids: The pids to watch; the worker exits when any is gone.
    :param interval: Seconds between liveness polls.
    :param grace: Seconds to wait after SIGTERM before escalating to SIGKILL.
    """
    while all(_pid_is_alive(pid) for pid in owner_pids):
        time.sleep(interval)
    _log.warning(
        "ACT render worker orphaned (owners %s); stopping so ffmpeg cannot outlive the app",
        owner_pids,
    )
    # Signal the GROUP, not just this process: ffmpeg is the child doing the actual work.
    #
    # Guarded on `pgid == os.getpid()` because the `os.setsid()` in `_run_job_to_queue` is
    # ALLOWED TO FAIL — it raises when this process already leads a group. If it did fail we
    # are still in the SIDECAR's group, and killpg would take down the engine and every
    # other render with it. So in that case exit alone and leave the group untouched: not
    # leading our own group means we are inside the app's detached group, which is exactly
    # the case `killProcessGroup` already covers.
    with suppress(OSError):
        pgid = os.getpgrp()
        if pgid == os.getpid():
            os.killpg(pgid, signal.SIGTERM)
            time.sleep(grace)
            os.killpg(pgid, signal.SIGKILL)
    os._exit(1)


def _start_worker_orphan_watchdog(
    owner_pids: tuple[int, ...],
    *,
    interval: float = _ORPHAN_WATCH_INTERVAL_SECONDS,
    grace: float = _ORPHAN_WATCH_GRACE_SECONDS,
) -> threading.Thread | None:
    """Start :func:`_watch_owners_and_die` in a daemon thread, if there is anything to watch.

    :param owner_pids: Candidate owner pids; non-positive and pid 1 are dropped (pid 1 is
        init/reparenting, never a real owner).
    :returns: The running thread, or ``None`` when no usable owner pid was found.
    """
    watched = tuple(sorted({pid for pid in owner_pids if pid > 1}))
    if not watched:
        return None
    thread = threading.Thread(
        target=_watch_owners_and_die,
        args=(watched, interval, grace),
        name="framepilot-render-orphan-watchdog",
        daemon=True,
    )
    thread.start()
    return thread


def _owner_pids_from_environment() -> tuple[int, ...]:
    """The sidecar pid and the desktop app pid, read BEFORE :func:`os.setsid` runs."""
    raw_app_pid = os.environ.get(_PARENT_PID_ENV, "").strip()
    app_pid = int(raw_app_pid) if raw_app_pid.isdigit() else 0
    return (os.getppid(), app_pid)


def _run_job_to_queue(
    process_request_json: str,
    result_queue: MPQueue[str],
    progress_queue: MPQueue[str] | None = None,
) -> None:  # pragma: no cover
    # Captured BEFORE setsid: `getppid()` is only guaranteed to name the sidecar while this
    # process is still in its group and family as spawned.
    owner_pids = _owner_pids_from_environment()
    # Own process group: ffmpeg is this process's child, and a cancel must reach it too.
    # Allowed to fail (it raises if we already lead a group) — `_watch_owners_and_die`
    # re-checks rather than assuming this succeeded.
    with suppress(OSError, AttributeError):
        os.setsid()
    _start_worker_orphan_watchdog(owner_pids)
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


def _stop_worker(
    proc: Any,
    *,
    stop_grace: float = _WORKER_STOP_GRACE_SECONDS,
    kill_grace: float = _WORKER_KILL_GRACE_SECONDS,
) -> None:
    """Terminate a render worker within a bounded time, and never block forever.

    WHY bounded: this used to be ``_terminate_group(proc); proc.join()`` with no timeout,
    and ``_terminate_group`` only ever sends SIGTERM — it never escalates. A worker stuck
    in an uninterruptible read, or one whose ffmpeg ignores SIGTERM, therefore held the
    joining thread forever. With ``workers=1`` that thread IS the queue: one cancelled
    export and every later export sat at ``queued`` for the rest of the session.

    Escalation is SIGTERM (so MoviePy/ffmpeg can close their files) → SIGKILL → give up.
    Giving up LEAKS one process, which is bad; wedging the only worker is worse, and the
    process is logged loudly so the leak is diagnosable rather than silent.

    :param proc: The multiprocessing process to stop.
    :param stop_grace: Seconds allowed for the polite SIGTERM to work.
    :param kill_grace: Seconds allowed for the process to be reaped after SIGKILL.
    """
    _terminate_group(proc)
    proc.join(stop_grace)
    if not proc.is_alive():
        return

    pid = getattr(proc, "pid", None)
    _log.warning("render worker %s ignored SIGTERM; escalating to SIGKILL", pid)
    if pid:
        with suppress(OSError, ProcessLookupError, AttributeError):
            os.killpg(os.getpgid(pid), signal.SIGKILL)
    with suppress(OSError, AttributeError, ValueError):
        proc.kill()
    proc.join(kill_grace)
    if proc.is_alive():
        # Returning leaks this process. Blocking would take the queue down with it.
        _log.error(
            "ACT render worker %s survived SIGKILL; abandoning it to keep the render "
            "queue alive (it may still hold CPU/files)",
            pid,
        )


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
        _stop_worker(proc)


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
