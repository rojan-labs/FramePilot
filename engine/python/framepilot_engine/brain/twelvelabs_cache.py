"""Versioned persistent cache and single-flight for TwelveLabs operations.

The project Brain remains the only persistent owner. Cache entries are stored in
``analysis_results`` and keyed by media bytes plus the complete effective request,
so renaming or reopening a project never re-bills an identical completed call.
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Callable, Mapping
from concurrent.futures import Future
from dataclasses import dataclass
from typing import Any, Generic, Protocol, TypeVar, cast

from framepilot_engine.brain.models import AnalysisResultRow, Provenance

CACHE_SCHEMA_VERSION = "twelvelabs-cache-v1"
CACHE_KIND_PREFIX = "twelvelabs:"

T = TypeVar("T")


class AnalysisCacheStore(Protocol):
    """The existing BrainStore methods the cache needs."""

    def get_analysis(
        self, asset_id: str, *, kind: str, params_hash: str
    ) -> AnalysisResultRow | None: ...

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
    ) -> AnalysisResultRow: ...


def _canonical_json(value: Any) -> str:
    """Stable JSON used for cache identity, rejecting unsupported values."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True, slots=True)
class TwelveLabsCacheKey:
    """Every stable input that can change a paid TwelveLabs result."""

    content_sha256: str
    operation: str
    params: Mapping[str, Any]
    backend: str
    model: str
    preprocessing: Mapping[str, Any]
    schema_version: str = CACHE_SCHEMA_VERSION

    def payload(self) -> dict[str, Any]:
        """Canonical, inspectable key payload for traces and diagnostics."""
        return {
            "backend": self.backend,
            "content_sha256": self.content_sha256,
            "model": self.model,
            "operation": self.operation,
            "params": dict(self.params),
            "preprocessing": dict(self.preprocessing),
            "schema_version": self.schema_version,
        }

    def digest(self) -> str:
        """SHA-256 identity suitable for ``analysis_results.params_hash``."""
        return hashlib.sha256(_canonical_json(self.payload()).encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class CacheLookup(Generic[T]):
    """A result plus where it came from."""

    value: T
    state: str  # persistent-hit | fresh | joined
    key: str


class SingleFlight:
    """Collapse simultaneous identical synchronous calls into one execution."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._calls: dict[str, Future[Any]] = {}

    def run(self, key: str, compute: Callable[[], T]) -> tuple[T, bool]:
        """Return ``(value, joined)``. All waiters receive the same result/error."""
        with self._lock:
            future = self._calls.get(key)
            owner = future is None
            if owner:
                future = Future()
                self._calls[key] = future

        assert future is not None
        if owner:
            try:
                future.set_result(compute())
            except BaseException as exc:
                future.set_exception(exc)
            finally:
                with self._lock:
                    self._calls.pop(key, None)

        return cast(T, future.result()), not owner


class TwelveLabsResultCache:
    """Two-layer cache: BrainStore persistence plus in-process single-flight."""

    def __init__(
        self,
        store: AnalysisCacheStore,
        *,
        single_flight: SingleFlight | None = None,
    ) -> None:
        self._store = store
        self._single_flight = single_flight or SingleFlight()

    @staticmethod
    def _kind(operation: str) -> str:
        return f"{CACHE_KIND_PREFIX}{operation}"

    def get(self, asset_id: str, key: TwelveLabsCacheKey) -> dict[str, Any] | None:
        """Read a completed cached result from the authoritative project Brain."""
        row = self._store.get_analysis(
            asset_id,
            kind=self._kind(key.operation),
            params_hash=key.digest(),
        )
        return None if row is None else dict(row.result)

    def put(
        self,
        asset_id: str,
        key: TwelveLabsCacheKey,
        value: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Persist a completed or deterministic-empty result without a normal TTL."""
        result = dict(value)
        self._store.record_analysis(
            asset_id,
            kind=self._kind(key.operation),
            depth="provider",
            params_hash=key.digest(),
            result=result,
            tool="twelvelabs",
            source=Provenance.MACHINE,
        )
        return result

    def get_or_compute(
        self,
        asset_id: str,
        key: TwelveLabsCacheKey,
        compute: Callable[[], Mapping[str, Any]],
    ) -> CacheLookup[dict[str, Any]]:
        """Serve persistence first, then make at most one identical provider call."""
        digest = key.digest()
        cached = self.get(asset_id, key)
        if cached is not None:
            return CacheLookup(value=cached, state="persistent-hit", key=digest)

        def compute_and_persist() -> tuple[dict[str, Any], bool]:
            # A request that joined after the first miss re-checks persistence in
            # case another process/thread completed before it became the owner.
            repeated = self.get(asset_id, key)
            if repeated is not None:
                return repeated, True
            return self.put(asset_id, key, compute()), False

        (value, persisted_during_flight), joined = self._single_flight.run(
            digest, compute_and_persist
        )
        state = "joined" if joined or persisted_during_flight else "fresh"
        return CacheLookup(value=value, state=state, key=digest)
