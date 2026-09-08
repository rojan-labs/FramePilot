"""P5.4: identical concurrent requests run the work once."""

from __future__ import annotations

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from framepilot_engine.singleflight import AsyncSingleFlight, SingleFlight


def test_five_concurrent_identical_calls_compute_once() -> None:
    flight: SingleFlight[int] = SingleFlight()
    calls = 0
    started = threading.Barrier(5)

    def compute() -> int:
        nonlocal calls
        calls += 1
        time.sleep(0.05)
        return 42

    def caller() -> int:
        started.wait()
        return flight.join("silence:/a.wav:-30:0.5", compute)

    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(lambda _: caller(), range(5)))
    assert results == [42] * 5
    assert calls == 1
    assert flight.coalesced == 4
    assert flight.in_flight() == 0


def test_different_keys_do_not_coalesce_and_the_key_is_released_after() -> None:
    flight: SingleFlight[str] = SingleFlight()
    assert flight.join("a", lambda: "first") == "first"
    assert flight.join("a", lambda: "second") == "second"  # not memoised
    assert flight.join("b", lambda: "other") == "other"
    assert flight.coalesced == 0


def test_followers_see_the_leaders_exception() -> None:
    flight: SingleFlight[int] = SingleFlight()
    gate = threading.Event()

    def compute() -> int:
        gate.wait()
        raise ValueError("boom")

    with ThreadPoolExecutor(max_workers=2) as pool:
        leader = pool.submit(flight.join, "k", compute)
        time.sleep(0.02)
        follower = pool.submit(flight.join, "k", compute)
        time.sleep(0.02)
        gate.set()
        with pytest.raises(ValueError, match="boom"):
            leader.result()
        with pytest.raises(ValueError, match="boom"):
            follower.result()


def test_async_flavour_coalesces_awaiters() -> None:
    async def scenario() -> tuple[list[int], int, int]:
        flight: AsyncSingleFlight[int] = AsyncSingleFlight()
        calls = 0

        async def compute() -> int:
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            return 7

        results = await asyncio.gather(*(flight.join("media:/x.mov", compute) for _ in range(5)))
        return list(results), calls, flight.coalesced

    results, calls, coalesced = asyncio.run(scenario())
    assert results == [7] * 5
    assert calls == 1
    assert coalesced == 4


def test_a_caller_arriving_in_the_hand_off_window_still_joins() -> None:
    """The leader must signal completion before it releases the key.

    A caller landing between those two steps used to see an empty ``_flights``, become a
    second leader, and start a duplicate compute (issue #87).
    """
    flight: SingleFlight[int] = SingleFlight()
    calls = 0
    late_result: list[int] = []

    def compute() -> int:
        nonlocal calls
        calls += 1
        return 9

    def late_caller() -> None:
        late_result.append(flight.join("k", compute))

    def arm_the_window() -> int:
        # Drive a second caller through the exact instant between "leader done" and
        # "key released" by hooking the leader's own completion signal.
        pending = flight._flights["k"]
        real_set = pending.done.set

        def set_then_let_a_late_caller_in() -> None:
            real_set()
            late = threading.Thread(target=late_caller)
            late.start()
            late.join(timeout=1.0)
            assert not late.is_alive()

        pending.done.set = set_then_let_a_late_caller_in  # type: ignore[method-assign]
        return compute()

    assert flight.join("k", arm_the_window) == 9
    assert late_result == [9]
    assert calls == 1  # the late caller joined instead of computing again
    assert flight.coalesced == 1
    assert flight.in_flight() == 0
