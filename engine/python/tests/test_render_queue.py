"""Tests for the background render queue (plan 2.2)."""

from __future__ import annotations

import os
import queue as std_queue
import signal
import threading
import time
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from framepilot_engine.render.pipeline import RenderJob, RenderOptions, RenderState
from framepilot_engine.render.queue import (
    JobCancelled,
    JobStatus,
    JobTimeout,
    RenderQueue,
    RenderRequest,
    subprocess_executor,
)
from framepilot_engine.timeline.models import SCHEMA_VERSION, Project


def _request(base_dir: str = "/tmp") -> RenderRequest:
    project = Project.model_validate({"id": "p1", "name": "T", "assets": [], "timeline": {}})
    return RenderRequest(project=project, opts=RenderOptions(), base_dir=base_dir)


def _wait_for(queue: RenderQueue, task_id: str, status: JobStatus, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = queue.get(task_id)
        if task and task.status == status:
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {status}; got {queue.get(task_id)}")


def _completed_job() -> RenderJob:
    return RenderJob(id="j", project_id="p1", state=RenderState.COMPLETED, progress=1.0)


def _failed_job() -> RenderJob:
    return RenderJob(id="j", project_id="p1", state=RenderState.FAILED, error="bad render")


def _project_with_source(*, width: int, height: int, peaks: list[float] | None = None) -> Project:
    """A minimal 1920x1080 project whose one video asset reports `width`x`height`."""
    return Project.model_validate(
        {
            "schemaVersion": SCHEMA_VERSION,
            "id": "p1",
            "name": "cap",
            "fps": 30,
            "resolution": {"width": 1920, "height": 1080},
            "assets": [
                {
                    "id": "a1",
                    "path": "media/clip.mp4",
                    "kind": "video",
                    "media": {
                        "width": width,
                        "height": height,
                        **({"peaks": peaks} if peaks is not None else {}),
                    },
                }
            ],
            "timeline": {"tracks": []},
        }
    )


def test_submit_runs_to_completion() -> None:
    q = RenderQueue(executor=lambda req, ev, to: _completed_job())
    try:
        task_id = q.submit(_request())
        _wait_for(q, task_id, JobStatus.COMPLETED)
        task = q.get(task_id)
        assert task is not None and task.result is not None
        assert task.result.state == RenderState.COMPLETED
        assert task.attempts == 1
    finally:
        q.shutdown()


def test_failed_render_marks_task_failed() -> None:
    q = RenderQueue(executor=lambda req, ev, to: _failed_job())
    try:
        task_id = q.submit(_request())
        _wait_for(q, task_id, JobStatus.FAILED)
        assert q.get(task_id).error == "bad render"  # type: ignore[union-attr]
    finally:
        q.shutdown()


def test_executor_crash_is_isolated() -> None:
    def boom(req: RenderRequest, ev: threading.Event, to: float | None) -> RenderJob:
        raise RuntimeError("executor exploded")

    q = RenderQueue(executor=boom)
    try:
        task_id = q.submit(_request())
        _wait_for(q, task_id, JobStatus.FAILED)
        assert "exploded" in q.get(task_id).error  # type: ignore[operator,union-attr]
    finally:
        q.shutdown()


def test_timeout_maps_to_failed() -> None:
    def slow(req: RenderRequest, ev: threading.Event, to: float | None) -> RenderJob:
        raise JobTimeout

    q = RenderQueue(executor=slow)
    try:
        task_id = q.submit(_request())
        _wait_for(q, task_id, JobStatus.FAILED)
        assert q.get(task_id).error == "timed out"  # type: ignore[union-attr]
    finally:
        q.shutdown()


def test_cancel_while_queued_skips_execution() -> None:
    started = threading.Event()
    release = threading.Event()

    def gated(req: RenderRequest, ev: threading.Event, to: float | None) -> RenderJob:
        started.set()
        release.wait(5.0)
        return _completed_job()

    q = RenderQueue(executor=gated, workers=1)
    try:
        first = q.submit(_request())
        assert started.wait(3.0)  # worker is now busy on `first`
        second = q.submit(_request())  # stays QUEUED behind it
        assert q.get(second).status == JobStatus.QUEUED  # type: ignore[union-attr]

        assert q.cancel(second) is True
        assert q.get(second).status == JobStatus.CANCELLED  # type: ignore[union-attr]

        release.set()
        _wait_for(q, first, JobStatus.COMPLETED)
        # The cancelled-while-queued job is never executed.
        assert q.get(second).status == JobStatus.CANCELLED  # type: ignore[union-attr]
    finally:
        release.set()
        q.shutdown()


def test_cancel_while_running_signals_executor() -> None:
    started = threading.Event()

    def blocking(req: RenderRequest, ev: threading.Event, to: float | None) -> RenderJob:
        started.set()
        if ev.wait(5.0):  # honour the cancel event
            raise JobCancelled
        return _completed_job()

    q = RenderQueue(executor=blocking, workers=1)
    try:
        task_id = q.submit(_request())
        assert started.wait(3.0)
        assert q.cancel(task_id) is True
        _wait_for(q, task_id, JobStatus.CANCELLED)
    finally:
        q.shutdown()


def test_cancel_unknown_or_done_returns_false() -> None:
    q = RenderQueue(executor=lambda req, ev, to: _completed_job())
    try:
        assert q.cancel("missing") is False
        task_id = q.submit(_request())
        _wait_for(q, task_id, JobStatus.COMPLETED)
        assert q.cancel(task_id) is False  # already terminal
    finally:
        q.shutdown()


def test_retry_reruns_failed_job() -> None:
    calls = {"n": 0}

    def flaky(req: RenderRequest, ev: threading.Event, to: float | None) -> RenderJob:
        calls["n"] += 1
        return _failed_job() if calls["n"] == 1 else _completed_job()

    q = RenderQueue(executor=flaky)
    try:
        task_id = q.submit(_request())
        _wait_for(q, task_id, JobStatus.FAILED)
        assert q.retry(task_id) is True
        _wait_for(q, task_id, JobStatus.COMPLETED)
        assert q.get(task_id).attempts == 2  # type: ignore[union-attr]
    finally:
        q.shutdown()


def test_retry_rejects_non_retryable() -> None:
    q = RenderQueue(executor=lambda req, ev, to: _completed_job())
    try:
        assert q.retry("missing") is False
        task_id = q.submit(_request())
        _wait_for(q, task_id, JobStatus.COMPLETED)
        assert q.retry(task_id) is False  # completed is not retryable
    finally:
        q.shutdown()


def test_auto_retry_up_to_max() -> None:
    q = RenderQueue(executor=lambda req, ev, to: _failed_job(), max_retries=2)
    try:
        task_id = q.submit(_request())
        _wait_for(q, task_id, JobStatus.FAILED)
        # Wait until retries are exhausted (1 initial + 2 retries).
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and (q.get(task_id).attempts < 3):  # type: ignore[union-attr]
            time.sleep(0.01)
        assert q.get(task_id).attempts == 3  # type: ignore[union-attr]
        assert q.get(task_id).status == JobStatus.FAILED  # type: ignore[union-attr]
    finally:
        q.shutdown()


def test_list_returns_all_tasks() -> None:
    q = RenderQueue(executor=lambda req, ev, to: _completed_job())
    try:
        ids = {q.submit(_request()) for _ in range(3)}
        for task_id in ids:
            _wait_for(q, task_id, JobStatus.COMPLETED)
        assert {t.id for t in q.list()} == ids
    finally:
        q.shutdown()


def test_get_unknown_returns_none() -> None:
    q = RenderQueue(executor=lambda req, ev, to: _completed_job())
    try:
        assert q.get("nope") is None
    finally:
        q.shutdown()


def test_shutdown_without_wait() -> None:
    q = RenderQueue(executor=lambda req, ev, to: _completed_job())
    q.shutdown(wait=False)  # returns immediately without joining workers


# --- subprocess_executor branches (fake multiprocessing context) -------------


class _FakeQueue:
    """Stand-in for an mp.Queue: returns preloaded payloads, else raises Empty."""

    def __init__(self, items: list[str] | None = None) -> None:
        self._items = list(items or [])

    def get(self, timeout: float | None = None) -> str:
        if self._items:
            return self._items.pop(0)
        raise std_queue.Empty

    def empty(self) -> bool:
        return not self._items


class _FakeProcess:
    """A stand-in render worker.

    Deliberately has NO ``pid``: ``_terminate_group``/``_stop_worker`` guard their
    ``os.getpgid``/``os.killpg`` calls on it, so a fake without one can never signal a real
    process that happens to own that number. Tests that need a pid use
    :class:`_StubbornProcess`, which is only ever used with ``os`` monkeypatched.
    """

    def __init__(self, alive: bool = True) -> None:
        self._alive = alive
        self.terminated = False

    def start(self) -> None:
        pass

    def is_alive(self) -> bool:
        return self._alive

    def terminate(self) -> None:
        self.terminated = True
        self._alive = False

    def kill(self) -> None:
        self._alive = False

    def join(self, timeout: float | None = None) -> None:
        # Real `Process.join` takes a timeout; `_stop_worker` passes one. Without this
        # parameter the fake raises TypeError and every cancellation test fails.
        self._alive = False


class _FakeContext:
    def __init__(self, fake_queue: _FakeQueue, fake_proc: _FakeProcess) -> None:
        self._q = fake_queue
        self._p = fake_proc

    def Queue(self) -> _FakeQueue:
        return self._q

    def Process(self, *, target: object, args: object, daemon: bool) -> _FakeProcess:
        return self._p


def _patch_ctx(
    monkeypatch: pytest.MonkeyPatch, fake_queue: _FakeQueue, fake_proc: _FakeProcess
) -> None:
    monkeypatch.setattr(
        "framepilot_engine.render.queue.mp.get_context",
        lambda _kind: _FakeContext(fake_queue, fake_proc),
    )


def test_subprocess_executor_returns_result(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = _completed_job().model_dump_json()
    proc = _FakeProcess(alive=True)
    _patch_ctx(monkeypatch, _FakeQueue([payload]), proc)
    job = subprocess_executor(_request(), threading.Event(), None)
    assert job.state == RenderState.COMPLETED


def test_subprocess_executor_cancel(monkeypatch: pytest.MonkeyPatch) -> None:
    proc = _FakeProcess(alive=True)
    _patch_ctx(monkeypatch, _FakeQueue([]), proc)
    event = threading.Event()
    event.set()
    with pytest.raises(JobCancelled):
        subprocess_executor(_request(), event, None)
    assert proc.terminated is True  # the live child was killed


def test_subprocess_executor_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    proc = _FakeProcess(alive=True)
    _patch_ctx(monkeypatch, _FakeQueue([]), proc)
    with pytest.raises(JobTimeout):
        subprocess_executor(_request(), threading.Event(), -1.0)  # deadline already past
    assert proc.terminated is True


def test_subprocess_executor_child_died(monkeypatch: pytest.MonkeyPatch) -> None:
    proc = _FakeProcess(alive=False)  # exited without posting a result
    _patch_ctx(monkeypatch, _FakeQueue([]), proc)
    job = subprocess_executor(_request(), threading.Event(), None)
    assert job.state == RenderState.FAILED
    assert "without a result" in (job.error or "")


# --- real subprocess executor integration ------------------------------------


@pytest.mark.usefixtures("require_ffprobe")
def test_default_subprocess_executor_real_render(
    tmp_project_dir: Path, media_factory: Callable[..., Path]
) -> None:
    src = media_factory("clip.mp4", seconds=1.0, with_audio=False)
    (tmp_project_dir / "clip.mp4").write_bytes(src.read_bytes())
    project = Project.model_validate(
        {
            "id": "p1",
            "name": "T",
            "fps": 30,
            "assets": [{"id": "a1", "path": "clip.mp4", "kind": "video"}],
            "timeline": {
                "tracks": [
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "c1",
                                "assetId": "a1",
                                "trackId": "v",
                                "start": 0.0,
                                "end": 1.0,
                                "sourceStart": 0.0,
                                "sourceEnd": 1.0,
                            }
                        ],
                    }
                ]
            },
        }
    )
    q = RenderQueue()  # default subprocess executor
    try:
        task_id = q.submit(
            RenderRequest(
                project=project,
                opts=RenderOptions(preview=True),
                base_dir=str(tmp_project_dir),
            )
        )
        _wait_for(q, task_id, JobStatus.COMPLETED, timeout=60.0)
        task = q.get(task_id)
        assert task is not None and task.result is not None
        assert task.result.output_path is not None
        assert Path(task.result.output_path).is_file()
    finally:
        q.shutdown()


def test_task_exposes_live_progress_from_an_executor_that_reports_it() -> None:
    """P7.6: an executor that accepts ``on_progress`` drives ``RenderTask.stage/progress``."""
    seen: list[tuple[str | None, float]] = []
    started = threading.Event()
    release = threading.Event()

    def reporting(
        req: RenderRequest,
        ev: threading.Event,
        to: float | None,
        on_progress: Callable[[str, float], None],
    ) -> RenderJob:
        on_progress("encoding", 0.42)
        started.set()
        release.wait(timeout=5)
        on_progress("validating_output", 0.97)
        return _completed_job()

    q = RenderQueue(executor=reporting, workers=1)
    try:
        task_id = q.submit(_request())
        assert started.wait(timeout=5)
        task = q.get(task_id)
        assert task is not None
        seen.append((task.stage, task.progress))
        release.set()
        _wait_for(q, task_id, JobStatus.COMPLETED)
        assert seen == [("encoding", 0.42)]
        final = q.get(task_id)
        assert final is not None and final.status == JobStatus.COMPLETED
    finally:
        q.shutdown()


def test_cancelling_a_render_discards_the_partial_file(tmp_path: Path) -> None:
    """A cancelled export must not leave a half-written file where a finished one goes.

    The worker dies by SIGTERM to its process group, so nothing inside it runs on the
    way out — not MoviePy's cleanup and not the pipeline's own discard, which only sees
    exceptions raised inside the worker. MoviePy writes progressively into the
    destination, so before this the desktop e2e found 4 MB of unplayable video sitting
    exactly where the finished export goes.
    """
    from framepilot_engine.render.queue import _discard_cancelled_output

    out = tmp_path / "exports" / "half-written.mp4"
    out.parent.mkdir(parents=True)
    out.write_bytes(b"\0" * 2048)

    request = SimpleNamespace(
        base_dir=str(tmp_path),
        opts=SimpleNamespace(output_path="exports/half-written.mp4"),
    )
    _discard_cancelled_output(cast("Any", request))

    assert not out.exists()


def test_discarding_a_cancelled_output_ignores_a_path_outside_the_sandbox(
    tmp_path: Path,
) -> None:
    """Cleanup is still a delete, so it obeys the same sandbox every other path does."""
    from framepilot_engine.render.queue import _discard_cancelled_output

    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"\0" * 16)
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()

    request = SimpleNamespace(
        base_dir=str(sandbox), opts=SimpleNamespace(output_path="../outside.mp4")
    )
    _discard_cancelled_output(cast("Any", request))

    assert outside.exists(), "cleanup must not escape the sandbox"


def test_discarding_a_cancelled_output_is_a_no_op_without_a_path(tmp_path: Path) -> None:
    """A render that never named an output has nothing to remove."""
    from framepilot_engine.render.queue import _discard_cancelled_output

    request = SimpleNamespace(base_dir=str(tmp_path), opts=SimpleNamespace(output_path=None))
    _discard_cancelled_output(cast("Any", request))


def test_render_worker_payload_keeps_source_dimensions_so_exports_cap(tmp_path: Path) -> None:
    """The spawn projection must not drop the fact that stops an upscale.

    `media` used to be dropped whole as "timeline-preview metadata" that "cannot change
    render semantics". It can: `source_facts` reads media.width/height to find the largest
    short edge the sources hold, and that is the cap. Without it a 2160p request against a
    640x360 source rendered a real 3840x2160 file — 148 MB of upscaled nothing. The parent
    resolved it correctly, so only the worker was ever wrong, which is how it survived.
    """
    from framepilot_engine.render.export_settings import ExportSettings
    from framepilot_engine.render.pipeline import resolve_target, source_facts
    from framepilot_engine.render.queue import project_for_render_worker

    project = _project_with_source(width=640, height=360)
    opts = RenderOptions(settings=ExportSettings(resolution="2160p"))

    worker_project = project_for_render_worker(project, opts)

    assert source_facts(worker_project).max_short_edge == 360
    target = resolve_target(worker_project, opts)
    assert (target.width, target.height) == (640, 360)
    assert target.capped_to_source is True
    # And the parent agrees — the two must never disagree about the target again.
    assert resolve_target(project, opts).height == target.height


def test_render_worker_payload_still_drops_the_waveform_peaks(tmp_path: Path) -> None:
    """Peaks are what made the payload big, and nothing in the render reads them."""
    from framepilot_engine.render.queue import project_for_render_worker

    project = _project_with_source(width=640, height=360, peaks=[0.5] * 4096)
    worker_project = project_for_render_worker(project, RenderOptions())

    media = worker_project.assets[0].media
    assert media is not None
    assert media.peaks is None
    assert media.width == 640


# --- FM-3: the render worker escapes the sidecar's process group -------------------


def test_pid_is_alive_reports_this_process() -> None:
    from framepilot_engine.render.queue import _pid_is_alive

    assert _pid_is_alive(os.getpid()) is True


def test_pid_is_alive_reports_a_missing_process_as_dead(monkeypatch: pytest.MonkeyPatch) -> None:
    from framepilot_engine.render.queue import _pid_is_alive

    def _gone(_pid: int, _sig: int) -> None:
        raise ProcessLookupError

    monkeypatch.setattr("framepilot_engine.render.queue.os.kill", _gone)
    assert _pid_is_alive(4242) is False


def test_pid_is_alive_treats_a_foreign_pid_as_alive(monkeypatch: pytest.MonkeyPatch) -> None:
    """A recycled pid owned by another user must NOT read as dead.

    Reading EPERM as "the owner is gone" would make the watchdog kill a healthy export.
    """
    from framepilot_engine.render.queue import _pid_is_alive

    def _foreign(_pid: int, _sig: int) -> None:
        raise PermissionError

    monkeypatch.setattr("framepilot_engine.render.queue.os.kill", _foreign)
    assert _pid_is_alive(4242) is True


def test_owner_pids_include_the_sidecar_and_the_desktop_app(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both owners are watched because they fail differently (force-quit vs sidecar crash)."""
    from framepilot_engine.render.queue import _owner_pids_from_environment

    monkeypatch.setenv("FRAMEPILOT_PARENT_PID", "9911")
    monkeypatch.setattr("framepilot_engine.render.queue.os.getppid", lambda: 7722)
    assert _owner_pids_from_environment() == (7722, 9911)


def test_owner_pids_tolerate_a_missing_app_pid(monkeypatch: pytest.MonkeyPatch) -> None:
    from framepilot_engine.render.queue import _owner_pids_from_environment

    monkeypatch.delenv("FRAMEPILOT_PARENT_PID", raising=False)
    monkeypatch.setattr("framepilot_engine.render.queue.os.getppid", lambda: 7722)
    assert _owner_pids_from_environment() == (7722, 0)


def test_orphan_watchdog_is_not_started_without_a_real_owner() -> None:
    from framepilot_engine.render.queue import _start_worker_orphan_watchdog

    # pid 1 is init (what a reparented orphan sees), never a real owner.
    assert _start_worker_orphan_watchdog((0, 1)) is None


def _patch_group_kill(
    monkeypatch: pytest.MonkeyPatch, *, leads_group: bool
) -> list[tuple[int, int]]:
    """Record what the watchdog would have signalled, without signalling anything.

    ``os.getpid`` is deliberately left alone — patching it would swap out a primitive the
    whole interpreter shares. Only ``getpgrp`` is faked, so ``leads_group=False`` models a
    failed ``setsid()`` (still inside the sidecar's group) without touching anything else.
    """
    signalled: list[tuple[int, int]] = []
    own_pid = os.getpid()
    monkeypatch.setattr(
        "framepilot_engine.render.queue.os.getpgrp",
        lambda: own_pid if leads_group else own_pid + 1,
    )
    monkeypatch.setattr(
        "framepilot_engine.render.queue.os.killpg",
        lambda group, sig: signalled.append((group, sig)),
    )
    return signalled


def test_orphan_watchdog_kills_its_own_group_when_an_owner_dies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from framepilot_engine.render.queue import _watch_owners_and_die

    signalled = _patch_group_kill(monkeypatch, leads_group=True)
    monkeypatch.setattr("framepilot_engine.render.queue._pid_is_alive", lambda _pid: False)
    exits: list[int] = []
    monkeypatch.setattr("framepilot_engine.render.queue.os._exit", lambda code: exits.append(code))

    _watch_owners_and_die((7722, 9911), 0.0, 0.0)

    assert signalled == [(os.getpid(), signal.SIGTERM), (os.getpid(), signal.SIGKILL)]
    assert exits == [1]


def test_orphan_watchdog_waits_while_both_owners_live(monkeypatch: pytest.MonkeyPatch) -> None:
    """Either owner dying is fatal; neither dying means keep rendering."""
    from framepilot_engine.render.queue import _watch_owners_and_die

    signalled = _patch_group_kill(monkeypatch, leads_group=True)
    exits: list[int] = []
    monkeypatch.setattr("framepilot_engine.render.queue.os._exit", lambda code: exits.append(code))
    # Alive for two polls, then the SECOND owner (the desktop app) disappears.
    alive: dict[int, bool] = {7722: True, 9911: True}
    polls = {"n": 0}

    def _alive(pid: int) -> bool:
        polls["n"] += 1
        if polls["n"] > 4:
            alive[9911] = False
        return alive[pid]

    monkeypatch.setattr("framepilot_engine.render.queue._pid_is_alive", _alive)

    _watch_owners_and_die((7722, 9911), 0.0, 0.0)

    assert polls["n"] > 4  # it really did keep waiting while both were up
    assert signalled == [(os.getpid(), signal.SIGTERM), (os.getpid(), signal.SIGKILL)]
    assert exits == [1]


def test_orphan_watchdog_never_signals_the_sidecar_group(monkeypatch: pytest.MonkeyPatch) -> None:
    """If ``os.setsid()`` failed, this process is still in the SIDECAR's group.

    Signalling that group would kill the engine and every other render. The watchdog must
    exit alone instead. This is the single most dangerous line in the whole watchdog.
    """
    from framepilot_engine.render.queue import _watch_owners_and_die

    signalled = _patch_group_kill(monkeypatch, leads_group=False)
    monkeypatch.setattr("framepilot_engine.render.queue._pid_is_alive", lambda _pid: False)
    exits: list[int] = []
    monkeypatch.setattr("framepilot_engine.render.queue.os._exit", lambda code: exits.append(code))

    _watch_owners_and_die((7722,), 0.0, 0.0)

    assert signalled == []  # the engine's group was left alone
    assert exits == [1]  # but this worker still stops


# --- FM-4: cancelling an export must not wedge the queue ---------------------------


class _StubbornProcess:
    """A worker that ignores SIGTERM. Only ever used with ``os`` monkeypatched."""

    def __init__(self, *, dies_on_kill: bool = True) -> None:
        self.pid = 31337
        self._alive = True
        self.terminated = False
        self.killed = False
        self.joins: list[float | None] = []
        self._dies_on_kill = dies_on_kill

    def start(self) -> None:
        pass

    def is_alive(self) -> bool:
        return self._alive

    def terminate(self) -> None:
        self.terminated = True  # ...and stays alive anyway.

    def kill(self) -> None:
        self.killed = True
        if self._dies_on_kill:
            self._alive = False

    def join(self, timeout: float | None = None) -> None:
        self.joins.append(timeout)


def _patch_os_signals(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, int]]:
    """Never let a test fake signal a real process that owns ``_StubbornProcess.pid``."""
    signalled: list[tuple[int, int]] = []
    monkeypatch.setattr("framepilot_engine.render.queue.os.getpgid", lambda pid: pid)
    monkeypatch.setattr(
        "framepilot_engine.render.queue.os.killpg",
        lambda group, sig: signalled.append((group, sig)),
    )
    return signalled


def test_stop_worker_returns_immediately_when_sigterm_works(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from framepilot_engine.render.queue import _stop_worker

    _patch_os_signals(monkeypatch)
    proc = _FakeProcess(alive=True)
    _stop_worker(proc, stop_grace=0.01, kill_grace=0.01)
    assert proc.terminated is True
    assert proc.is_alive() is False


def test_stop_worker_escalates_to_sigkill(monkeypatch: pytest.MonkeyPatch) -> None:
    """SIGTERM alone never escalated, so a stuck worker held the join forever."""
    from framepilot_engine.render.queue import _stop_worker

    signalled = _patch_os_signals(monkeypatch)
    proc = _StubbornProcess()

    _stop_worker(proc, stop_grace=0.01, kill_grace=0.01)

    assert signalled == [(31337, signal.SIGTERM), (31337, signal.SIGKILL)]
    assert proc.killed is True
    assert proc.is_alive() is False


def test_stop_worker_gives_up_rather_than_wedging_the_queue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With ``workers=1`` an unbounded join blocks EVERY later export, forever.

    Leaking one unkillable process is the lesser evil, so this must return.
    """
    from framepilot_engine.render.queue import _stop_worker

    _patch_os_signals(monkeypatch)
    proc = _StubbornProcess(dies_on_kill=False)

    _stop_worker(proc, stop_grace=0.01, kill_grace=0.01)

    assert proc.killed is True
    assert proc.is_alive() is True  # still there — and we returned anyway
    assert proc.joins == [0.01, 0.01]  # every join was bounded


def test_cancelling_a_render_never_joins_without_a_bound(monkeypatch: pytest.MonkeyPatch) -> None:
    """End to end through ``subprocess_executor``: the cancel path stays bounded."""
    _patch_os_signals(monkeypatch)
    proc = _StubbornProcess()
    _patch_ctx(monkeypatch, _FakeQueue([]), cast(Any, proc))
    event = threading.Event()
    event.set()

    with pytest.raises(JobCancelled):
        subprocess_executor(_request(), event, None)

    assert proc.killed is True
    assert all(timeout is not None for timeout in proc.joins)
