"""Contract tests for the compiled-composition cache.

The cache exists because compiling is ~0.8s per clip and was paid on every
read-only look at a project. What makes it safe rather than merely fast is the
part these tests pin: compositions own ffmpeg readers with seek state, so an
entry is lent to one caller at a time and closed only when nobody holds it.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from framepilot_engine.render.composition_cache import CompositionCache, composition_key
from framepilot_engine.render.presets import ExportPreset
from framepilot_engine.timeline.models import Project


class _FakeComposition:
    def __init__(self, tag: str = "c") -> None:
        self.tag = tag
        self.closed = False

    def close(self) -> None:
        self.closed = True


def _preset() -> ExportPreset:
    return ExportPreset(id="p", label="P", width=16, height=16, fps=30)


def _project(revision: int = 1, clip_end: float = 2.0) -> Project:
    return Project.model_validate(
        {
            "id": "project",
            "name": "Cache fixture",
            "fps": 30,
            "resolution": {"width": 16, "height": 16},
            "timeline": {
                "revision": revision,
                "tracks": [
                    {
                        "id": "video",
                        "type": "video",
                        "clips": [
                            {
                                "id": "clip",
                                "assetId": "asset",
                                "trackId": "video",
                                "start": 0,
                                "end": clip_end,
                                "sourceStart": 0,
                                "sourceEnd": clip_end,
                                "effects": [],
                                "keyframes": [],
                            }
                        ],
                    }
                ],
            },
            "assets": [{"id": "asset", "path": "a.mp4", "kind": "video", "durationSeconds": 10}],
            "transcript": [],
            "aiMemory": {},
            "history": [],
        }
    )


def test_compiles_once_then_reuses() -> None:
    cache = CompositionCache()
    built = 0

    def build() -> _FakeComposition:
        nonlocal built
        built += 1
        return _FakeComposition()

    for _ in range(3):
        with cache.borrow("k", build) as composition:
            assert isinstance(composition, _FakeComposition)

    assert built == 1
    assert (cache.hits, cache.misses) == (2, 1)


def test_a_changed_project_is_a_different_composition() -> None:
    """The key is content, not revision.

    Keying on the timeline revision would collide across projects (every project
    counts from zero) and would serve a stale picture for an in-memory change
    that never bumped one — which is precisely the frame a model is looking at
    to check its own edit.
    """
    base = Path("/tmp/project")
    preset = _preset()
    same = composition_key(_project(), base, preset, burn_captions=False)
    assert composition_key(_project(), base, preset, burn_captions=False) == same
    # Same revision, different content.
    assert composition_key(_project(clip_end=3.0), base, preset, burn_captions=False) != same
    # Everything else that can change a pixel.
    assert composition_key(_project(), base, preset, burn_captions=True) != same
    assert composition_key(_project(), Path("/tmp/other"), preset, burn_captions=False) != same
    assert (
        composition_key(
            _project(),
            base,
            ExportPreset(id="p", label="P", width=32, height=16, fps=30),
            burn_captions=False,
        )
        != same
    )


def test_eviction_closes_the_whole_composition() -> None:
    """Bounded, and never a leak: an evicted composition is torn down."""
    cache = CompositionCache(max_entries=1)
    first = _FakeComposition("first")
    second = _FakeComposition("second")

    with cache.borrow("a", lambda: first):
        pass
    with cache.borrow("b", lambda: second):
        pass

    assert first.closed is True
    assert second.closed is False
    cache.clear()
    assert second.closed is True


def test_one_borrower_at_a_time() -> None:
    """The property that makes sharing safe at all.

    MoviePy readers carry seek position, so two threads driving one composition
    would interleave seeks and hand back frames from the wrong time. Sidecar
    routes run in a threadpool, so this is a real concurrent path, not a
    theoretical one.
    """
    cache = CompositionCache()
    composition = _FakeComposition()
    overlapped = False
    inside = 0
    guard = threading.Lock()

    def worker() -> None:
        nonlocal overlapped, inside
        with cache.borrow("k", lambda: composition):
            with guard:
                inside += 1
                if inside > 1:
                    overlapped = True
            time.sleep(0.02)
            with guard:
                inside -= 1

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert overlapped is False


def test_eviction_waits_for_the_borrower() -> None:
    """A composition is never closed while somebody is driving it.

    Closing under an in-flight grab would pull the readers out from under it —
    the failure mode would be an intermittent, unreproducible frame error.
    """
    cache = CompositionCache(max_entries=1)
    held = _FakeComposition("held")
    closed_during_borrow: list[bool] = []
    released = threading.Event()

    def evictor() -> None:
        # Installing a second entry evicts the first, which must block until the
        # borrow below finishes.
        with cache.borrow("b", lambda: _FakeComposition("other")):
            pass

    with cache.borrow("a", lambda: held):
        thread = threading.Thread(target=evictor)
        thread.start()
        time.sleep(0.05)
        closed_during_borrow.append(held.closed)
        released.set()
    thread.join()

    assert closed_during_borrow == [False]
    assert held.closed is True


def test_checkout_survives_eviction_before_the_lock_is_taken() -> None:
    """Regression: eviction started right after checkout — before the checked-
    out caller has acquired the entry's lock — must not close the composition
    out from under it.

    Retirement is non-blocking for the evictor/installer (it marks the entry
    retired and moves on rather than waiting on `pinned`), but it must still
    never close a composition while a caller has it checked out. `pinned`
    exists precisely to close that gap: `_unpin` is the only path that closes
    a retired entry, and only once `pinned` drops to zero.
    """
    cache = CompositionCache(max_entries=1)
    held = _FakeComposition("held")
    with cache.borrow("a", lambda: held):
        pass  # populate, then release — "a" is cached but no longer pinned

    # Simulate a caller mid-borrow: checked out, but hasn't taken the lock yet.
    entry = cache._checkout("a")
    assert entry is not None

    # Evicting "a" to install "b" under max_entries=1 does not block on "a"
    # still being pinned — it marks "a" retired and returns immediately.
    with cache.borrow("b", lambda: _FakeComposition("other")):
        pass
    assert entry.retired is True
    # Still checked out (pinned), so it must not have been torn down.
    assert held.closed is False

    # Now actually use it, exactly as `borrow` would.
    with entry.lock:
        pass
    cache._unpin(entry)

    assert held.closed is True


def test_concurrent_misses_on_the_same_key_build_once() -> None:
    """Regression: concurrent cache misses on the same key must coalesce into
    one `build()` instead of every waiter independently paying the full
    compile cost before all but one result is discarded.
    """
    cache = CompositionCache()
    composition = _FakeComposition("shared")
    build_calls = 0
    build_lock = threading.Lock()
    started_building = threading.Event()
    release_build = threading.Event()

    def slow_build() -> _FakeComposition:
        nonlocal build_calls
        with build_lock:
            build_calls += 1
        started_building.set()
        release_build.wait(timeout=2)
        return composition

    results: list[_FakeComposition] = []
    results_lock = threading.Lock()

    def worker() -> None:
        with cache.borrow("k", slow_build) as got, results_lock:
            results.append(got)

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for thread in threads:
        thread.start()
    # Let the first thread start building and the rest pile up behind it
    # before the build is allowed to finish.
    assert started_building.wait(timeout=2) is True
    time.sleep(0.05)
    release_build.set()
    for thread in threads:
        thread.join()

    assert build_calls == 1
    assert results == [composition] * 5


def test_only_one_composition_is_built_at_a_time() -> None:
    """The cap on CACHED compositions never bounded the ones being BUILT.

    Every caller of this cache keys on project content, so a multi-turn agent
    run produces a fresh key per turn and concurrent builds do not coalesce —
    each allocates a full set of ffmpeg readers before any eviction policy can
    apply to it. That is how concurrent callers exhausted a machine's memory.
    Distinct keys must therefore still serialize through the build bound.
    """
    cache = CompositionCache(max_concurrent_builds=1)
    building = 0
    peak = 0
    counter_lock = threading.Lock()
    release = threading.Event()

    def build() -> _FakeComposition:
        nonlocal building, peak
        with counter_lock:
            building += 1
            peak = max(peak, building)
        release.wait(timeout=2)
        with counter_lock:
            building -= 1
        return _FakeComposition()

    def worker(key: str) -> None:
        with cache.borrow(key, build):
            pass

    threads = [threading.Thread(target=worker, args=(f"key-{i}",)) for i in range(4)]
    for thread in threads:
        thread.start()
    # Long enough for every thread to reach the gate; only one may be past it.
    time.sleep(0.1)
    with counter_lock:
        assert building == 1
    release.set()
    for thread in threads:
        thread.join()

    assert peak == 1


def test_a_caller_that_queued_for_a_build_slot_reuses_what_it_waited_for() -> None:
    """Waiting for a slot must not turn into compiling the answer twice.

    Two callers of the SAME key can both miss (the second arrives after the
    first's single-flight has already been consumed) and queue for a build
    slot. If the second compiled on waking, the bound would convert contention
    into duplicated work — the exact cost this cache exists to remove.
    """
    cache = CompositionCache(max_concurrent_builds=1)
    builds = 0
    build_lock = threading.Lock()

    def build() -> _FakeComposition:
        nonlocal builds
        with build_lock:
            builds += 1
        return _FakeComposition()

    with cache.borrow("k", build):
        pass
    with cache.borrow("k", build):
        pass

    assert builds == 1
    assert (cache.hits, cache.misses) == (1, 1)
