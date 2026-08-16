"""Deterministic TwelveLabs cache identity, persistence, and concurrency tests."""

from __future__ import annotations

import threading
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest

from framepilot_engine.brain.models import AnalysisResultRow, Provenance
from framepilot_engine.brain.twelvelabs_cache import (
    CACHE_SCHEMA_VERSION,
    CacheLookup,
    SingleFlight,
    TwelveLabsCacheKey,
    TwelveLabsResultCache,
)


class FakeStore:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str, str], AnalysisResultRow] = {}
        self.get_calls = 0
        self.record_calls = 0
        self._lock = threading.Lock()

    def get_analysis(
        self, asset_id: str, *, kind: str, params_hash: str
    ) -> AnalysisResultRow | None:
        with self._lock:
            self.get_calls += 1
            return self.rows.get((asset_id, kind, params_hash))

    def record_analysis(
        self,
        asset_id: str,
        *,
        kind: str,
        depth: str,
        params_hash: str,
        result: dict[str, Any],
        tool: str,
        source: Provenance = Provenance.MACHINE,
    ) -> AnalysisResultRow:
        with self._lock:
            self.record_calls += 1
            row = AnalysisResultRow(
                asset_id=asset_id,
                kind=kind,
                depth=depth,
                params_hash=params_hash,
                result=result,
                source=source,
                tool=tool,
                created_at="2026-08-05T00:00:00+00:00",
            )
            self.rows[(asset_id, kind, params_hash)] = row
            return row


def key(**overrides: Any) -> TwelveLabsCacheKey:
    values: dict[str, Any] = {
        "content_sha256": "abc123",
        "operation": "search",
        "params": {"query": "person enters", "range": {"start": 1, "end": 2}},
        "backend": "twelvelabs",
        "model": "marengo3.0",
        "preprocessing": {"clip_version": 2},
    }
    values.update(overrides)
    return TwelveLabsCacheKey(**values)


def test_cache_key_is_canonical_and_every_stable_input_changes_identity() -> None:
    first = key(params={"query": "person enters", "range": {"end": 2, "start": 1}})
    reordered = key(params={"range": {"start": 1, "end": 2}, "query": "person enters"})
    assert first.digest() == reordered.digest()
    assert first.payload() == {
        "backend": "twelvelabs",
        "content_sha256": "abc123",
        "model": "marengo3.0",
        "operation": "search",
        "params": {"query": "person enters", "range": {"end": 2, "start": 1}},
        "preprocessing": {"clip_version": 2},
        "schema_version": CACHE_SCHEMA_VERSION,
    }

    changed = (
        key(content_sha256="different"),
        key(operation="analyze"),
        key(params={"query": "different"}),
        key(backend="other"),
        key(model="pegasus1.2"),
        key(preprocessing={"clip_version": 3}),
        key(schema_version="twelvelabs-cache-v2"),
    )
    assert all(candidate.digest() != first.digest() for candidate in changed)


def test_cache_key_rejects_non_json_parameters() -> None:
    with pytest.raises(TypeError):
        key(params={"unsupported": {1, 2}}).digest()


def test_single_flight_returns_fresh_value_and_clears_completed_entry() -> None:
    flight = SingleFlight()
    calls = 0

    def compute() -> str:
        nonlocal calls
        calls += 1
        return "ready"

    assert flight.run("same", compute) == ("ready", False)
    assert flight.run("same", compute) == ("ready", False)
    assert calls == 2


def test_single_flight_collapses_concurrent_identical_calls() -> None:
    flight = SingleFlight()
    started = threading.Event()
    release = threading.Event()
    calls = 0

    def compute() -> str:
        nonlocal calls
        calls += 1
        started.set()
        assert release.wait(timeout=2)
        return "one-result"

    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(flight.run, "same", compute)
        assert started.wait(timeout=2)
        waiter = pool.submit(flight.run, "same", compute)
        release.set()
        results = [owner.result(timeout=2), waiter.result(timeout=2)]

    assert calls == 1
    assert {joined for _, joined in results} == {False, True}
    assert {value for value, _ in results} == {"one-result"}


def test_single_flight_shares_errors_and_allows_a_later_retry() -> None:
    flight = SingleFlight()
    started = threading.Event()
    release = threading.Event()
    calls = 0

    def fail() -> str:
        nonlocal calls
        calls += 1
        started.set()
        assert release.wait(timeout=2)
        raise RuntimeError("provider failed")

    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(flight.run, "same", fail)
        assert started.wait(timeout=2)
        waiter = pool.submit(flight.run, "same", fail)
        release.set()
        for pending in (owner, waiter):
            with pytest.raises(RuntimeError, match="provider failed"):
                pending.result(timeout=2)

    assert calls == 1
    assert flight.run("same", lambda: "recovered") == ("recovered", False)


def test_persistent_get_put_and_deterministic_empty_results() -> None:
    store = FakeStore()
    cache = TwelveLabsResultCache(store)
    cache_key = key()

    assert cache.get("asset", cache_key) is None
    assert cache.put("asset", cache_key, {"clips": []}) == {"clips": []}
    assert cache.get("asset", cache_key) == {"clips": []}
    assert store.record_calls == 1
    row = next(iter(store.rows.values()))
    assert row.kind == "twelvelabs:search"
    assert row.depth == "provider"
    assert row.tool == "twelvelabs"
    assert row.source is Provenance.MACHINE


def test_get_or_compute_serves_persistence_without_calling_provider() -> None:
    store = FakeStore()
    cache_key = key()
    first_cache = TwelveLabsResultCache(store)
    first = first_cache.get_or_compute("asset", cache_key, lambda: {"answer": "cached"})
    assert first == CacheLookup(value={"answer": "cached"}, state="fresh", key=cache_key.digest())

    calls = 0

    def should_not_run() -> Mapping[str, Any]:
        nonlocal calls
        calls += 1
        return {"answer": "new"}

    reopened_cache = TwelveLabsResultCache(store)
    reopened = reopened_cache.get_or_compute("asset", cache_key, should_not_run)
    assert reopened == CacheLookup(
        value={"answer": "cached"}, state="persistent-hit", key=cache_key.digest()
    )
    assert calls == 0
    assert store.record_calls == 1


def test_get_or_compute_rechecks_persistence_after_the_initial_miss() -> None:
    cache_key = key()

    class AppearingStore(FakeStore):
        def get_analysis(
            self, asset_id: str, *, kind: str, params_hash: str
        ) -> AnalysisResultRow | None:
            self.get_calls += 1
            if self.get_calls == 1:
                return None
            return AnalysisResultRow(
                asset_id=asset_id,
                kind=kind,
                depth="provider",
                params_hash=params_hash,
                result={"answer": "other-worker"},
                source=Provenance.MACHINE,
                tool="twelvelabs",
                created_at="2026-08-05T00:00:00+00:00",
            )

    store = AppearingStore()
    calls = 0

    def should_not_run() -> Mapping[str, Any]:
        nonlocal calls
        calls += 1
        return {"answer": "unexpected"}

    result = TwelveLabsResultCache(store).get_or_compute("asset", cache_key, should_not_run)
    assert result.state == "joined"
    assert result.value == {"answer": "other-worker"}
    assert calls == 0
    assert store.record_calls == 0


def test_get_or_compute_collapses_provider_calls_and_does_not_cache_errors() -> None:
    store = FakeStore()
    cache = TwelveLabsResultCache(store, single_flight=SingleFlight())
    cache_key = key(operation="analyze", model="pegasus1.2")
    started = threading.Event()
    release = threading.Event()
    calls = 0

    def compute() -> Mapping[str, Any]:
        nonlocal calls
        calls += 1
        started.set()
        assert release.wait(timeout=2)
        return {"answer": "grounded"}

    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(cache.get_or_compute, "asset", cache_key, compute)
        assert started.wait(timeout=2)
        waiter = pool.submit(cache.get_or_compute, "asset", cache_key, compute)
        release.set()
        results = [owner.result(timeout=2), waiter.result(timeout=2)]

    assert calls == 1
    assert {result.state for result in results} == {"fresh", "joined"}
    assert all(result.value == {"answer": "grounded"} for result in results)
    assert store.record_calls == 1

    failing_key = key(operation="embed")
    with pytest.raises(RuntimeError, match="quota"):
        cache.get_or_compute(
            "asset",
            failing_key,
            lambda: (_ for _ in ()).throw(RuntimeError("quota")),
        )
    assert cache.get("asset", failing_key) is None
