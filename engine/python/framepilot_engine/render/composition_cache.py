"""Reuse of compiled compositions across calls that target the same revision.

Compiled MoviePy compositions own ffmpeg readers, are not thread-safe, and must be closed
exactly once. The cache therefore lends entries under a per-entry lock, coalesces same-key
misses, bounds concurrent builds, and retires evicted entries only after their borrowers leave.

The build bound is PROCESS-wide for compositions that open media readers
(:data:`HEAVY_BUILD_GATE`): the whole-timeline cache, the grab's and the review's windowed
caches, and the source sheet's uncached tiles all take a slot from the same gate. A bound per
cache stopped bounding anything once there were several such caches.

Reading a frame from such a composition takes a slot too (:func:`read_frame`): a read seeks
and decodes in the ffmpeg readers the build opened, which is the same CPU a build spends, so
bounding builds alone left every concurrent grab decoding at once (AL33). With both, at most
:data:`MAX_CONCURRENT_HEAVY_BUILDS` compositions are compiling or decoding in the whole
sidecar, whatever number of agent calls arrive together.
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
#: Builds one cache with a PRIVATE gate runs at once (only the caption layers use one: they
#: hold Pillow rasters, not media readers, so they stay out of the heavy gate).
MAX_CONCURRENT_BUILDS = 1
#: Compositions that open ffmpeg readers compiled (or read from, :func:`read_frame`) at once
#: across the whole process. A reader of a 1080p source was measured at 130-450 MB resident
#: (run-3 project), so each concurrent compile is paid in hundreds of MB. Two, not one:
#: temporal-evidence batches are already serialised by their route, so a review holds at most
#: one slot and a grab or sheet tile always has the other. Measured on run-3's final project
#: (a 40-frame review + 4 scopes, alongside a 12-tile sheet and 4 grabs; three runs each): peak
#: tree RSS 2.5-3.7 GB before, 1.6-2.7 GB at one slot, 2.6-3.0 GB at two; wall 58-65 s before,
#: 63-74 s at one (the sheet 8 s -> 24-26 s, grabs doubled), 56-64 s at two (sheet 13-14 s).
MAX_CONCURRENT_HEAVY_BUILDS = 2
#: How often a caller waiting for a build slot re-checks whether it is still wanted.
_CANCEL_POLL_SECONDS = 0.05


class CompositionBuildCancelled(RuntimeError):
    """The caller stopped wanting a composition while it waited for a build slot."""


class BuildGate:
    """A bound on concurrent composition builds, shared by every cache that is given it.

    Only the wait is cancellable: a build that has started runs to completion, because a
    half-compiled composition has readers nobody would close.
    """

    def __init__(self, slots: int) -> None:
        self._slots = threading.BoundedSemaphore(max(1, int(slots)))

    def acquire(self, cancelled: Callable[[], bool] | None = None) -> bool:
        """Take a slot; ``False`` (holding nothing) if ``cancelled`` turned true first."""
        if cancelled is None:
            self._slots.acquire()
            return True
        while not self._slots.acquire(timeout=_CANCEL_POLL_SECONDS):
            if cancelled():
                return False
        return True

    def release(self) -> None:
        self._slots.release()

    @contextmanager
    def slot(self, cancelled: Callable[[], bool] | None = None) -> Iterator[None]:
        """Hold one slot for the ``with`` body.

        :raises CompositionBuildCancelled: ``cancelled`` turned true before a slot was free.
        """
        if not self.acquire(cancelled):
            raise CompositionBuildCancelled("Stopped waiting for a composition build slot.")
        try:
            yield
        finally:
            self.release()


#: The one gate for every composition that opens media readers (module docstring).
HEAVY_BUILD_GATE = BuildGate(MAX_CONCURRENT_HEAVY_BUILDS)


def read_frame(
    composition: Any,
    at: float,
    *,
    gate: BuildGate | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> Any:
    """``composition.get_frame(at)`` under a slot of the heavy gate (module docstring).

    Never call this while already holding a slot of the same gate: the gate is not reentrant,
    and a caller that compiles and reads under one slot (the source sheet's tiles) is already
    bounded.

    :param gate: The gate to take a slot of; ``None`` is :data:`HEAVY_BUILD_GATE`, looked up at
        call time so a test can swap it.
    :raises CompositionBuildCancelled: ``cancelled`` turned true before a slot was free.
    """
    with (gate or HEAVY_BUILD_GATE).slot(cancelled):
        return composition.get_frame(at)


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
    window: frozenset[str] | None = None,
) -> str:
    """The identity of one compiled composition.

    :param window: The clip ids of a windowed composite (``compile_timeline(window=...)``).
        A windowed composite holds a subset of the full one's layers, so it is keyed by that
        subset: every instant whose window names the same clips reuses it, and it can never
        answer for the full composition, whose payload has no ``window`` entry at all.
    """
    fields: dict[str, Any] = {
        "project": project.model_dump(mode="json"),
        "base": str(base_dir),
        "preset": [preset.id, preset.width, preset.height, preset.fps],
        "captions": burn_captions,
        "decode": max_decode_dimension,
    }
    if window is not None:
        fields["window"] = sorted(window)
    payload = json.dumps(fields, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class CompositionCache:
    """A tiny LRU of compiled compositions, borrowed one caller at a time."""

    def __init__(
        self,
        max_entries: int = MAX_CACHED_COMPOSITIONS,
        max_concurrent_builds: int = MAX_CONCURRENT_BUILDS,
        *,
        name: str = "composition",
        hit_log_level: int = logging.INFO,
        build_gate: BuildGate | None = None,
    ) -> None:
        """:param build_gate: The gate builds wait on; shared across caches to bound them
        together (:data:`HEAVY_BUILD_GATE`). ``None`` gives this cache a private gate of
        ``max_concurrent_builds`` slots.
        """
        self._name = name
        # A cache consulted several times a second (the monitor's caption layers) logs its hits
        # at DEBUG; the INFO line is for the expensive compositions, where a hit is news.
        self._hit_log_level = hit_log_level
        self._entries: OrderedDict[str, _Entry] = OrderedDict()
        self._guard = threading.Condition()
        self._max_entries = max(1, max_entries)
        self._single_flight: SingleFlight = SingleFlight()
        self._build_gate = build_gate or BuildGate(max_concurrent_builds)
        self.hits = 0
        self.misses = 0

    @contextmanager
    def borrow(
        self,
        key: str,
        build: Callable[[], Any],
        *,
        cancelled: Callable[[], bool] | None = None,
    ) -> Iterator[Any]:
        """Lend the composition for ``key``, building it on a miss.

        :param cancelled: Polled while waiting for a build slot; when it turns true the wait
            ends with :class:`CompositionBuildCancelled`. Never consulted once building.
        """
        entry = self._checkout(key)
        if entry is None:
            entry = self._build_and_install(key, build, cancelled)
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
            _log.log(self._hit_log_level, "ACT %s cache hit: key=%s", self._name, key[:12])
            return entry

    def _build_and_install(
        self, key: str, build: Callable[[], Any], cancelled: Callable[[], bool] | None
    ) -> _Entry:
        while True:
            flown, joined = self._single_flight.run(
                key, lambda: self._gated_build(key, build, cancelled)
            )
            if flown is not None:
                break
            # The flight's leader gave up waiting for a slot. That is the leader's answer, not
            # this caller's: a joiner still wanting the composition leads (or joins) a new one.
            if not joined or (cancelled is not None and cancelled()):
                raise CompositionBuildCancelled(
                    f"Stopped waiting for a {self._name} build slot (key={key[:12]})."
                )
        entry = flown
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
        rebuilt = self._gated_build(key, build, cancelled)
        if rebuilt is None:
            raise CompositionBuildCancelled(
                f"Stopped waiting for a {self._name} build slot (key={key[:12]})."
            )
        return rebuilt

    def _gated_build(
        self, key: str, build: Callable[[], Any], cancelled: Callable[[], bool] | None
    ) -> _Entry | None:
        """The installed, pinned entry; ``None`` when ``cancelled`` ended the wait for a slot.

        ``None`` rather than an exception so a single-flight joiner can tell the leader's
        cancellation from a failed build (which it must share) and retry for itself.
        """
        if not self._build_gate.acquire(cancelled):
            return None
        try:
            waited = self._relookup(key)
            if waited is not None:
                return waited
            composition = build()
        finally:
            self._build_gate.release()
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


COMPOSITION_CACHE = CompositionCache(build_gate=HEAVY_BUILD_GATE)

#: Windowed single-frame composites (``render/frame_grab.py``), kept apart from the full ones.
#: A grab builds a handful of readers in about a second; sharing the full cache's two entries
#: made it evict a background review's whole-timeline build. Four entries: a model inspecting
#: its edit looks at a few shots. Its builds take a :data:`HEAVY_BUILD_GATE` slot like every
#: other; the gate has room for one besides a review's (see :data:`MAX_CONCURRENT_HEAVY_BUILDS`).
MAX_CACHED_FRAME_WINDOWS = 4
FRAME_WINDOW_CACHE = CompositionCache(
    MAX_CACHED_FRAME_WINDOWS, name="frame window", build_gate=HEAVY_BUILD_GATE
)

#: Windowed composites of a post-edit temporal review (``validation/temporal_evidence.py``).
#: Apart from the grab's cache for the same reason the grab's is apart from the full one: a
#: background review sweeps several shots, and sharing four entries would evict the shots the
#: model is looking at. Six
#: entries hold a typical batch's shots (representative frames plus a few edit boundaries), so
#: re-reviewing the same revision reuses them; each holds only its own shot's readers.
MAX_CACHED_REVIEW_WINDOWS = 6
REVIEW_WINDOW_CACHE = CompositionCache(
    MAX_CACHED_REVIEW_WINDOWS, name="review window", build_gate=HEAVY_BUILD_GATE
)
