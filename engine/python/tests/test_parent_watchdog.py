"""The engine must not outlive the app that spawned it.

The desktop app spawns the sidecar detached, in its own process group, so a running
encode can be signalled as a group. The cost is that a hard death of the app —
``kill -9``, Force Quit, a crash — never runs the app's shutdown, and the engine
survives still holding its port. The next launch then cannot bind and the user's app
comes back with no engine at all. Only the engine can notice this, because by then its
owner does not exist.
"""

from __future__ import annotations

import os
import signal
import threading
import time
from collections.abc import Callable

import pytest

from framepilot_engine.service import PARENT_PID_ENV, start_parent_watchdog


def test_no_watchdog_without_a_configured_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(PARENT_PID_ENV, raising=False)
    assert start_parent_watchdog() is None


def test_ignores_a_meaningless_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    # pid 1 is launchd/init: every orphan's parent, so watching it would never fire.
    # A non-numeric value is a misconfiguration, not a reason to refuse to serve.
    for value in ("", "  ", "not-a-pid", "0", "1", "-5"):
        monkeypatch.setenv(PARENT_PID_ENV, value)
        assert start_parent_watchdog() is None, value


def test_stays_quiet_while_the_owner_is_alive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(PARENT_PID_ENV, raising=False)
    signalled: list[int] = []
    monkeypatch.setattr(os, "kill", _recording_kill(signalled, alive={os.getpid()}))
    thread = start_parent_watchdog(os.getpid(), interval_seconds=0.01, grace_seconds=60)
    assert thread is not None
    time.sleep(0.1)
    assert signalled == []


def test_terminates_this_process_once_the_owner_is_gone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(PARENT_PID_ENV, raising=False)
    gone_owner = 987654321
    signalled: list[tuple[int, int]] = []
    done = threading.Event()

    def fake_kill(pid: int, sig: int) -> None:
        if pid == gone_owner and sig == 0:
            raise ProcessLookupError
        signalled.append((pid, sig))
        done.set()

    monkeypatch.setattr(os, "kill", fake_kill)
    # A long grace so the real os._exit at the end of the watchdog is never reached
    # inside the test process.
    thread = start_parent_watchdog(gone_owner, interval_seconds=0.01, grace_seconds=60)
    assert thread is not None
    assert done.wait(5), "the watchdog should signal this process when its owner is gone"
    assert signalled == [(os.getpid(), signal.SIGTERM)]


def _recording_kill(
    signalled: list[int], alive: set[int]
) -> Callable[[int, int], None]:
    def fake_kill(pid: int, sig: int) -> None:
        if sig == 0:
            if pid not in alive:
                raise ProcessLookupError
            return
        signalled.append(pid)

    return fake_kill
