"""Reuse of compiled compositions across calls that target the same revision.

Compiled MoviePy compositions own ffmpeg readers, are not thread-safe, and must be closed
exactly once. The cache therefore lends entries under a per-entry lock, coalesces same-key
misses, bounds concurrent builds, and retires evicted entries only after their borrowers leave.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections import OrderedDict
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from framepilot_engine.brain.twelvelabs_cache import SingleFlight
from framepilot_engine.render.presets import ExportPreset
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Project

_log = logging.getLogger(__name__)

MAX_CACHED_COMPOSITIONS = 2
MAX_CONCURRENT_BUILDS = 1


@dataclass
class _Entry:
    composition: Any
    lock: threading.Lock = field(default_factory=threading.Lock)
    pinned: int = 0
    # Removed from the active LRU, waiting for its final borrower to leave. A retired entry is
    # never checked out again, which makes closing it from `_unpin` safe when pinned reaches 0.
    retired: bool = False
    closed: bool = False


def composition_key(
    project: Project,
    base_dir: Path,
    preset: ExportPreset,
    *,
    burn_captions: bool,
    max_decode_dimension: int | None = None,
) -> str:
    payload = json.dumps(
        {
            "project": project.model_dump(mode="json"),
            "base": str(base_dir),
            "preset": [preset.id, preset.width, preset.height, preset.fps],
            "captions": burn_captions,
            "decode": max_decode_dimension,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class CompositionCache:
    """A tiny LRU of compiled compositions, borrowed one caller at a time."""

    def __init__(
        self,
        max_entries: int = MAX_CACHED_COMPOSITIONS,
        max_concurrent_builds: int = MAX_CONCURRENT_BUILDS,
    ) -> None:
        self._entries: OrderedDict[str, _Entry] = OrderedDict()
        self._guard = threading.Condition()
        self._max_entries = max(1, max_entries)
        self._single_flight: SingleFlight = SingleFlight()
        self._build_slots = threading.BoundedSemaphore(max(1, int(max_concurrent_builds)))
        self.hits = 0
        self.misses = 0

    @contextmanager
    def borrow(self, key: str, build: Callable[[], Any]) -> Iterator[Any]:
        entry = self._checkout(key)
        if entry is None:
            entry = self._build_and_install(key, build)
        try:
            with entry.lock:
                yield entry.composition
        finally:
            self._unpin(entry)

    def _checkout(self, key: str) -> _Entry | None:
        with self._guard:
            entry = self._entries.get(key)
            if entry is None:
                self.misses += 1
                return None
            self._entries.move_to_end(key)
            entry.pinned += 1
            self.hits += 1
            _log.info("ACT composition cache hit: key=%s", key[:12])
            return entry

    def _build_and_install(self, key: str, build: Callable[[], Any]) -> _Entry:
        entry, joined = self._single_flight.run(key, lambda: self._gated_build(key, build))
        if not joined:
            return entry
        current = self._checkout(key)
        if current is not None:
            return current
        # A joined caller can resume after the freshly installed entry was evicted by another
        # key. Never pin that retired object: its final existing borrower is allowed to close it.
        # Re-enter the bounded build path, which first checks whether the key appeared again.
        with self._guard:
            reusable = not entry.retired and not entry.closed
            if reusable:
                entry.pinned += 1
                return entry
        return self._gated_build(key, build)

    def _gated_build(self, key: str, build: Callable[[], Any]) -> _Entry:
        with self._build_slots:
            waited = self._relookup(key)
            if waited is not None:
                return waited
            composition = build()
        return self._install(key, composition)

    def _relookup(self, key: str) -> _Entry | None:
        with self._guard:
            entry = self._entries.get(key)
            if entry is None:
                return None
            self._entries.move_to_end(key)
            entry.pinned += 1
            return entry

    def _unpin(self, entry: _Entry) -> None:
        close_now = False
        with self._guard:
            entry.pinned -= 1
            if entry.pinned < 0:
                raise RuntimeError("Composition cache entry pin count became negative.")
            if entry.pinned == 0:
                self._guard.notify_all()
                close_now = entry.retired and not entry.closed
                if close_now:
                    entry.closed = True
        if close_now:
            # borrow() has already exited entry.lock before `_unpin` runs, and pinned==0 means
            # there is no checked-out waiter still entitled to acquire it. Closing here makes
            # retirement non-blocking for the installer while keeping teardown exact.
            with entry.lock:
                close_clip_tree(entry.composition)

    def _install(self, key: str, composition: Any) -> _Entry:
        close_raw: list[Any] = []
        close_entries: list[_Entry] = []
        with self._guard:
            existing = self._entries.get(key)
            if existing is not None:
                close_raw.append(composition)
                self._entries.move_to_end(key)
                entry = existing
            else:
                entry = _Entry(composition=composition)
                self._entries[key] = entry
                while len(self._entries) > self._max_entries:
                    _, stale = self._entries.popitem(last=False)
                    stale.retired = True
                    if stale.pinned == 0 and not stale.closed:
                        stale.closed = True
                        close_entries.append(stale)
            entry.pinned += 1

        for stale in close_entries:
            with stale.lock:
                close_clip_tree(stale.composition)
        for raw in close_raw:
            close_clip_tree(raw)
        return entry

    def _retire_and_wait(self, entry: _Entry) -> None:
        """Shutdown/test path: retire and synchronously wait for outstanding borrowers."""
        with self._guard:
            entry.retired = True
            while entry.pinned > 0:
                self._guard.wait()
            if entry.closed:
                return
            entry.closed = True
        with entry.lock:
            close_clip_tree(entry.composition)

    def clear(self) -> None:
        with self._guard:
            entries = list(self._entries.values())
            self._entries.clear()
            for entry in entries:
                entry.retired = True
        for entry in entries:
            self._retire_and_wait(entry)


COMPOSITION_CACHE = CompositionCache()
