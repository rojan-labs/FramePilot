"""Long work a paced slice STARTS and later slices COLLECT, with a bounded wait.

WHY: ``/brain/visual/index`` is a paced job — one bounded slice per HTTP call, the host
re-posting until ``done`` — and the slice contract is that no call holds the request
open for minutes. Two steps broke that contract, because their cost scales with the
MEDIA rather than with anything the slice can bound:

- the tier-0 measurement, a whole-file ffmpeg decode (72.7 s for a 58:51 interview);
- the TwelveLabs multipart upload (100 x 10 MB chunks, about 5.3 min on the measured
  link, and it scales with the user's bandwidth).

Both ran inside one request, which the Node client abandoned at 300 s (undici's
default ``headersTimeout``), so the asset was never indexed at all. The codebase
already had the answer for tier 2 and for a hosted task still indexing: give the slice
a time budget, keep the job cursor on the asset when the budget expires, and let the
next slice resume. What those two have that a decode or an upload does not is a
resumable unit — a described shot, a polled task. This module supplies one: the work
runs on its own thread, and every slice that asks for the same key waits on THAT work,
up to its budget, rather than starting it again.

In memory on purpose. The only thing worth remembering is "this work is running", and
that is exactly what dies with the process: after a sidecar restart the next slice
finds no unit, starts the work again, and nothing durable was ever out of step.

Not :class:`~framepilot_engine.singleflight.SingleFlight`, which coalesces concurrent
callers of work run on the FIRST caller's thread and forgets the key the moment it
ends. Here the work has to outlive the call that started it, and its result has to wait
for a call that has not been made yet.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Hashable
from enum import Enum
from typing import Final, Generic, TypeVar, cast

__all__ = ["PENDING", "Pending", "SliceWork", "Spawn"]

_log = logging.getLogger(__name__)

T = TypeVar("T")


class Pending(Enum):
    """The answer of a :meth:`SliceWork.run` whose work outlived the caller's budget.

    An enum member rather than ``None`` because ``None`` is a legitimate result of some
    work, and a caller must never confuse "not finished" with "finished with nothing".
    """

    PENDING = "pending"


#: The single :class:`Pending` value; narrow a result with ``isinstance(r, Pending)``.
PENDING: Final = Pending.PENDING

#: Starts ``target`` running in the background; ``name`` labels the thread.
Spawn = Callable[[Callable[[], None], str], None]


def _spawn_daemon(target: Callable[[], None], name: str) -> None:
    """The production :data:`Spawn`: a daemon thread per unit of work.

    Daemon, because the work belongs to a request the process can abandon: a sidecar
    told to shut down must not sit behind the last chunks of somebody's upload. The
    work is lost either way, and :class:`SliceWork` was built for losing it.
    """
    threading.Thread(target=target, name=name, daemon=True).start()


class _Unit(Generic[T]):
    """One in-flight piece of work and, once it ends, its outcome."""

    __slots__ = ("done", "error", "result", "started")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: T | None = None
        self.error: BaseException | None = None
        self.started = time.monotonic()


class SliceWork:
    """In-memory registry of long work, one unit in flight per key.

    Thread-safe: slices for different assets run on a pool, and two requests may
    reach the same key at once. The result (or the exception) is handed to the call
    that collects it — every call waiting when the work ends, or else the first to ask
    after — and the key is then forgotten, so a failure is reported, not remembered: a
    LATER job retries the work rather than inheriting the failure forever.

    A result that finishes while nobody is waiting stays until a call collects it.
    That is the point (the next slice is coming), and its size is one unit per key in
    flight — a measurement's shot list, an upload's task id.

    :param spawn: How a unit is started; defaults to a daemon thread. Tests inject one
        that runs the work on demand, so nothing has to sleep.
    """

    def __init__(self, *, spawn: Spawn = _spawn_daemon) -> None:
        self._spawn = spawn
        self._lock = threading.Lock()
        self._units: dict[Hashable, _Unit[object]] = {}

    def run(self, key: Hashable, work: Callable[[], T], *, budget: float) -> T | Pending:
        """Start ``work`` under ``key`` (or join the unit already running) and wait.

        :param key: Identifies the work; equal keys share one unit. Include everything
            that makes two pieces of work different (the bytes' hash above all), so a
            changed file is never answered with the old file's result.
        :param work: The long call. Ignored when a unit for ``key`` is already in flight.
        :param budget: Seconds this call may wait. Zero or less only checks.
        :returns: The work's result, or :data:`PENDING` when it is still running.
        :raises BaseException: Whatever ``work`` raised, to the call that collects it.
        """
        unit, created = self._unit_for(key)
        if created:
            self._start(key, unit, work)
        if not unit.done.wait(timeout=max(0.0, budget)):
            return PENDING
        with self._lock:
            if self._units.get(key) is unit:
                del self._units[key]
        _log.debug(
            "slice work collected: key=%r elapsed=%.1fs failed=%s",
            key,
            time.monotonic() - unit.started,
            unit.error is not None,
        )
        if unit.error is not None:
            raise unit.error
        return cast(T, unit.result)

    def _unit_for(self, key: Hashable) -> tuple[_Unit[object], bool]:
        with self._lock:
            existing = self._units.get(key)
            if existing is not None:
                return existing, False
            unit: _Unit[object] = _Unit()
            self._units[key] = unit
            return unit, True

    def _start(self, key: Hashable, unit: _Unit[object], work: Callable[[], object]) -> None:
        def execute() -> None:
            try:
                unit.result = work()
            except BaseException as exc:
                # Handed to the collector, never swallowed: a unit that ended without a
                # result or an error would read as a successful ``None``.
                unit.error = exc
            finally:
                unit.done.set()

        _log.debug("slice work started: key=%r", key)
        try:
            # Outside the registry lock: an injected spawn may run the work inline.
            self._spawn(execute, f"slice-work-{key!r}")
        except BaseException:
            # A unit that never started would make every later call for this key wait
            # on an event nothing will ever set.
            with self._lock:
                if self._units.get(key) is unit:
                    del self._units[key]
            raise
