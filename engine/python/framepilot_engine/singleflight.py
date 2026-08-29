"""In-flight request coalescing (plan/system-mission P5.4).

Five identical analysis requests arriving together — the sidebar, the agent, a retry and
two panels asking for the same waveform — used to spawn five ffmpeg pipelines that all
produced the same answer. Everything here is keyed on the request's *inputs* (route, media
path, parameters); callers that ask the same question while the first answer is still
being computed wait for that answer instead of starting their own.

Two flavours share one contract, ``join(key, compute)``:

* :class:`SingleFlight` — for sync route bodies that run on Starlette's threadpool. The
  first caller runs ``compute`` on its own thread; later callers block on the leader's
  :class:`threading.Event` and receive the same result (or the same exception).
* :class:`AsyncSingleFlight` — for ``async def`` routes. Followers ``await`` the leader's
  :class:`asyncio.Future` without holding a threadpool slot.

Results are NOT cached: the moment the leader finishes, the key is released and the next
caller computes afresh. Coalescing is about concurrent duplicates, not memoisation — the
per-endpoint caches (asset media, footage map) own the persistent case.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass
class _Flight(Generic[T]):
    done: threading.Event = field(default_factory=threading.Event)
    result: T | None = None
    error: BaseException | None = None
    followers: int = 0


class SingleFlight(Generic[T]):
    """Thread-safe coalescing for synchronous work."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._flights: dict[str, _Flight[T]] = {}
        self.coalesced = 0
        """How many callers received a leader's answer instead of computing their own."""

    def in_flight(self) -> int:
        with self._lock:
            return len(self._flights)

    def join(self, key: str, compute: Callable[[], T]) -> T:
        with self._lock:
            flight = self._flights.get(key)
            if flight is not None:
                flight.followers += 1
                self.coalesced += 1
                leader = False
            else:
                flight = _Flight()
                self._flights[key] = flight
                leader = True
        if not leader:
            flight.done.wait()
            if flight.error is not None:
                raise flight.error
            return flight.result  # type: ignore[return-value]
        try:
            flight.result = compute()
            return flight.result
        except BaseException as exc:
            flight.error = exc
            raise
        finally:
            with self._lock:
                self._flights.pop(key, None)
            flight.done.set()


class AsyncSingleFlight(Generic[T]):
    """Coalescing for ``async`` work on one event loop."""

    def __init__(self) -> None:
        self._flights: dict[str, asyncio.Future[T]] = {}
        self.coalesced = 0

    def in_flight(self) -> int:
        return len(self._flights)

    async def join(self, key: str, compute: Callable[[], Awaitable[T]]) -> T:
        existing = self._flights.get(key)
        if existing is not None:
            self.coalesced += 1
            return await asyncio.shield(existing)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[T] = loop.create_future()
        self._flights[key] = future
        try:
            result = await compute()
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
            raise
        else:
            if not future.done():
                future.set_result(result)
            return result
        finally:
            self._flights.pop(key, None)
