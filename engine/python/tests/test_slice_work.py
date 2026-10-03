"""Tests for ``brain.slice_work`` — long work a slice starts and a later slice collects.

Most tests inject a spawn that queues the work and runs it when the test says so, so
"still running" is a fact the test controls rather than a race it hopes to win. The
daemon-thread tests gate the work on an :class:`threading.Event`; nothing sleeps.
"""

from __future__ import annotations

import threading
from collections.abc import Callable

import pytest

from framepilot_engine.brain.slice_work import PENDING, Pending, SliceWork

#: A wait long enough never to expire on a working machine, used only where the work is
#: already released: it bounds a hang, it is never what the test waits for.
_SAFETY_BUDGET = 10.0


class _ManualSpawn:
    """A spawn that queues each unit; :meth:`run_all` runs the queue on this thread."""

    def __init__(self) -> None:
        self.queued: list[Callable[[], None]] = []
        self.names: list[str] = []

    def __call__(self, target: Callable[[], None], name: str) -> None:
        self.queued.append(target)
        self.names.append(name)

    def run_all(self) -> None:
        queued, self.queued = self.queued, []
        for target in queued:
            target()


class _CountingWork:
    """Work that counts its calls and returns (or raises) a fixed outcome."""

    def __init__(self, result: str = "task-1", error: Exception | None = None) -> None:
        self.calls = 0
        self.result = result
        self.error = error

    def __call__(self) -> str:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.result


def test_pending_then_result_on_a_later_call() -> None:
    spawn = _ManualSpawn()
    work = SliceWork(spawn=spawn)
    upload = _CountingWork("task-1")

    assert work.run("k", upload, budget=0.0) is PENDING
    spawn.run_all()

    assert work.run("k", upload, budget=0.0) == "task-1"
    assert upload.calls == 1


def test_the_same_key_never_starts_the_work_twice() -> None:
    spawn = _ManualSpawn()
    work = SliceWork(spawn=spawn)
    first, second = _CountingWork("first"), _CountingWork("second")

    assert work.run("k", first, budget=0.0) is PENDING
    # A later slice builds a new closure for the same upload; it must join the first.
    assert work.run("k", second, budget=0.0) is PENDING
    assert len(spawn.queued) == 1

    spawn.run_all()
    assert work.run("k", second, budget=0.0) == "first"
    assert (first.calls, second.calls) == (1, 0)


def test_a_failure_reaches_the_collector_and_the_key_is_then_forgotten() -> None:
    spawn = _ManualSpawn()
    work = SliceWork(spawn=spawn)
    failing = _CountingWork(error=ValueError("chunk 37 refused"))

    assert work.run("k", failing, budget=0.0) is PENDING
    spawn.run_all()
    with pytest.raises(ValueError, match="chunk 37 refused"):
        work.run("k", failing, budget=0.0)

    # Forgotten: a later job retries the work instead of inheriting the failure.
    retry = _CountingWork("task-2")
    assert work.run("k", retry, budget=0.0) is PENDING
    spawn.run_all()
    assert work.run("k", retry, budget=0.0) == "task-2"
    assert (failing.calls, retry.calls) == (1, 1)


def test_a_collected_result_is_not_served_again() -> None:
    spawn = _ManualSpawn()
    work = SliceWork(spawn=spawn)

    work.run("k", _CountingWork("old"), budget=0.0)
    spawn.run_all()
    assert work.run("k", _CountingWork("unused"), budget=0.0) == "old"

    # A result is handed over once; the next ask is new work, not a stale answer.
    assert work.run("k", _CountingWork("new"), budget=0.0) is PENDING
    spawn.run_all()
    assert work.run("k", _CountingWork("unused"), budget=0.0) == "new"


def test_different_keys_are_independent() -> None:
    spawn = _ManualSpawn()
    work = SliceWork(spawn=spawn)

    assert work.run(("tier0", "a"), _CountingWork("a"), budget=0.0) is PENDING
    assert work.run(("tier0", "b"), _CountingWork("b"), budget=0.0) is PENDING
    assert len(spawn.queued) == 2

    # Finish only "a": "b" is still running, and "a"'s result is not "b"'s.
    spawn.queued.pop(0)()
    assert work.run(("tier0", "a"), _CountingWork("x"), budget=0.0) == "a"
    assert work.run(("tier0", "b"), _CountingWork("x"), budget=0.0) is PENDING
    spawn.run_all()
    assert work.run(("tier0", "b"), _CountingWork("x"), budget=0.0) == "b"


def test_a_spawn_that_fails_leaves_no_unit_behind() -> None:
    attempts: list[str] = []

    def refusing(target: Callable[[], None], name: str) -> None:
        attempts.append(name)
        raise RuntimeError("can't start new thread")

    work = SliceWork(spawn=refusing)
    with pytest.raises(RuntimeError, match="can't start new thread"):
        work.run("k", _CountingWork(), budget=0.0)
    # Not wedged on an event nothing will set: the next call tries to start it again.
    with pytest.raises(RuntimeError):
        work.run("k", _CountingWork(), budget=0.0)
    assert len(attempts) == 2


def test_work_runs_on_a_daemon_thread_and_is_collected_once_released() -> None:
    release = threading.Event()
    seen: dict[str, object] = {}

    def upload() -> str:
        seen["daemon"] = threading.current_thread().daemon
        seen["thread"] = threading.current_thread() is not threading.main_thread()
        release.wait(_SAFETY_BUDGET)
        return "task-1"

    work = SliceWork()
    assert work.run("k", upload, budget=0.0) is PENDING
    release.set()
    # The wait returns the moment the work ends; the budget only bounds a hang.
    assert work.run("k", upload, budget=_SAFETY_BUDGET) == "task-1"
    # A sidecar shutdown must never wait behind an upload.
    assert seen == {"daemon": True, "thread": True}


def test_concurrent_callers_register_one_unit_of_work() -> None:
    """Many slices asking at once while the work is held: exactly one start."""
    callers = 8
    release = threading.Event()
    started = threading.Barrier(callers)
    calls: list[int] = []
    calls_lock = threading.Lock()
    results: list[object] = []
    results_lock = threading.Lock()

    def measure() -> str:
        with calls_lock:
            calls.append(1)
        release.wait(_SAFETY_BUDGET)
        return "shots"

    work = SliceWork()

    def caller() -> None:
        started.wait(_SAFETY_BUDGET)
        # Budget 0: every caller asks while the work is still held, so none can collect
        # it early and let a straggler legitimately start a second unit.
        result = work.run("k", measure, budget=0.0)
        with results_lock:
            results.append(result)

    threads = [threading.Thread(target=caller) for _ in range(callers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(_SAFETY_BUDGET)
    release.set()

    assert results == [PENDING] * callers
    assert work.run("k", measure, budget=_SAFETY_BUDGET) == "shots"
    assert len(calls) == 1


def test_pending_is_a_typed_sentinel_not_none() -> None:
    # A unit of work may legitimately return None; "not finished" must not look like it.
    spawn = _ManualSpawn()
    work = SliceWork(spawn=spawn)
    pending = work.run("k", lambda: None, budget=0.0)
    assert isinstance(pending, Pending) and pending is not None
    spawn.run_all()
    assert work.run("k", lambda: None, budget=0.0) is None
