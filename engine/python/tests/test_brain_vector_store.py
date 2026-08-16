"""Tests for the visual vector-store seam (plan MI2.3, decision D4).

The seam is a deterministic core module (100% branch coverage): the sqlite-vec
and brute-force backends must return the SAME top-k on the same data (the parity
guarantee), a load failure must degrade to brute force without raising, and the
asset/time filters and empty index must behave identically either way. No live
API is ever called — vectors are hand-pinned fixtures (plan §6).
"""

from __future__ import annotations

import sqlite3
import sys
from collections.abc import Callable, Iterator, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest

from framepilot_engine.brain import migrations as brain_migrations
from framepilot_engine.brain import vector_store as vector_store_module
from framepilot_engine.brain.models import VisualSpanRow, VisualVectorRow
from framepilot_engine.brain.store import BrainStore
from framepilot_engine.brain.vector_store import (
    _LOOKUP_CHUNK,
    BACKEND_BRUTE_FORCE,
    BACKEND_SQLITE_VEC,
    VisualHit,
    VisualVectorStore,
    vec_available,
)

MODEL = "nvidia/test"
_SAMPLER = 1


def _clock() -> Callable[[], datetime]:
    state = {"now": datetime(2026, 7, 18, 9, 0, 0, tzinfo=UTC)}

    def tick() -> datetime:
        now = state["now"]
        state["now"] = now + timedelta(seconds=1)
        return now

    return tick


# A small fixture set whose similarities to the test queries are all DISTINCT —
# no ties at any top-k boundary, so the two backends must agree on ordering
# exactly (a tie would let each backend break it differently). Against query
# [1,0,0] the cosines are 1.0 > 0.894 > 0.447 > 0.243 for t0 0>1>2>3.
_FIXTURE_VECTORS: dict[float, list[float]] = {
    0.0: [1.0, 0.0, 0.0],
    1.0: [2.0, 1.0, 0.0],
    2.0: [1.0, 2.0, 0.0],
    3.0: [1.0, 4.0, 0.0],
}


@pytest.fixture
def brain(tmp_path: Path) -> Iterator[BrainStore]:
    with BrainStore.open(tmp_path / "brain.sqlite", clock=_clock()) as store:
        store.upsert_asset("a1", path="a.mp4", content_sha256="sha-a1")
        store.upsert_asset("a2", path="b.mp4", content_sha256="sha-a2")
        yield store


def _seed_spans(store: BrainStore, *, asset_id: str = "a1") -> None:
    content_hash = "sha-a1" if asset_id == "a1" else "sha-a2"
    store.upsert_visual_spans(
        [
            VisualSpanRow(
                asset_id=asset_id,
                model=MODEL,
                sampler_version=_SAMPLER,
                t0=t0,
                t1=t0 + 1.0,
                scene_index=int(t0),
                keyframe_t=t0,
                phash=1,
                content_hash=content_hash,
                frame_count=1,
            )
            for t0 in _FIXTURE_VECTORS
        ]
    )


def _vector_rows(asset_id: str = "a1") -> list[VisualVectorRow]:
    return [
        VisualVectorRow(
            asset_id=asset_id,
            model=MODEL,
            sampler_version=_SAMPLER,
            t0=t0,
            dim=len(values),
            vector=values,
        )
        for t0, values in _FIXTURE_VECTORS.items()
    ]


def _keys(hits: list[VisualHit]) -> list[float]:  # t0 is the hit's identity here
    return [h.t0 for h in hits]


# --- vec_available probe ------------------------------------------------------


def test_vec_available_loads_on_this_runtime(brain: BrainStore) -> None:
    ok, reason = vec_available(brain._conn)
    if not ok:
        pytest.skip(f"sqlite-vec did not load on this runtime: {reason}")
    assert reason is None
    # Second call short-circuits on the cheap probe (already loaded).
    assert vec_available(brain._conn) == (True, None)


def test_vec_available_import_failure_degrades(
    brain: BrainStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing/broken wheel returns (False, reason) and never raises."""
    # Force a fresh connection whose module isn't loaded, then block the import.
    monkeypatch.setitem(sys.modules, "sqlite_vec", None)
    fresh = sqlite3.connect(":memory:")
    try:
        ok, reason = vec_available(fresh)
    finally:
        fresh.close()
    assert ok is False
    assert reason is not None and "sqlite_vec" in reason


def test_vec_available_extension_disabled_degrades(monkeypatch: pytest.MonkeyPatch) -> None:
    """enable_load_extension raising (compiled out) degrades, never raises."""

    class _NoExtConn:
        def execute(self, sql: str, *args: object) -> object:
            raise sqlite3.OperationalError("no such function: vec_version")

        def enable_load_extension(self, _enabled: bool) -> None:
            raise AttributeError("enable_load_extension unavailable in this build")

    ok, reason = vec_available(_NoExtConn())  # type: ignore[arg-type]
    assert ok is False
    assert reason is not None and "AttributeError" in reason


# --- frozen-bundle loader fallback (plan MI2.4) -------------------------------


def _require_real_sqlite_vec() -> None:
    """Skip a test when the sqlite-vec wheel cannot load on this runtime."""
    probe = sqlite3.connect(":memory:")
    try:
        if not vec_available(probe)[0]:
            pytest.skip("sqlite-vec did not load on this runtime")
    finally:
        probe.close()


def _raise_missing(_conn: object) -> None:
    """Stand-in for sqlite_vec.load when the package-relative path is missing."""
    raise sqlite3.OperationalError("cannot open shared object (simulated frozen relocate)")


def test_frozen_fallback_loads_from_package_subdir(monkeypatch: pytest.MonkeyPatch) -> None:
    """Frozen: package-path load fails but vec0 resolves under _MEIPASS/sqlite_vec/."""
    _require_real_sqlite_vec()
    import sqlite_vec

    # site-packages holds sqlite_vec/vec0.dylib → the first candidate resolves.
    site_packages = str(Path(sqlite_vec.__file__).parent.parent)
    monkeypatch.setattr(sys, "_MEIPASS", site_packages, raising=False)
    monkeypatch.setattr(sqlite_vec, "load", _raise_missing)
    fresh = sqlite3.connect(":memory:")
    try:
        assert vec_available(fresh) == (True, None)
    finally:
        fresh.close()


def test_frozen_fallback_loads_from_bundle_root(monkeypatch: pytest.MonkeyPatch) -> None:
    """Frozen: vec0 relocated to the bundle root → the second candidate resolves."""
    _require_real_sqlite_vec()
    import sqlite_vec

    # The package dir itself holds vec0.dylib: _MEIPASS/sqlite_vec/vec0 misses,
    # _MEIPASS/vec0 hits — exercising the loop's continue then success.
    pkg_dir = str(Path(sqlite_vec.__file__).parent)
    monkeypatch.setattr(sys, "_MEIPASS", pkg_dir, raising=False)
    monkeypatch.setattr(sqlite_vec, "load", _raise_missing)
    fresh = sqlite3.connect(":memory:")
    try:
        assert vec_available(fresh) == (True, None)
    finally:
        fresh.close()


def test_load_failure_propagates_when_not_frozen(monkeypatch: pytest.MonkeyPatch) -> None:
    """Dev (no _MEIPASS): a package-path failure degrades honestly, never a shim."""
    _require_real_sqlite_vec()
    import sqlite_vec

    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    monkeypatch.setattr(sqlite_vec, "load", _raise_missing)
    fresh = sqlite3.connect(":memory:")
    try:
        ok, reason = vec_available(fresh)
    finally:
        fresh.close()
    assert ok is False
    assert reason is not None and "OperationalError" in reason


def test_frozen_fallback_exhausted_degrades(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Frozen but vec0 nowhere under the bundle → degrade to brute force, no raise."""
    _require_real_sqlite_vec()
    import sqlite_vec

    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)  # empty dir
    monkeypatch.setattr(sqlite_vec, "load", _raise_missing)
    # Even the final package-path retry must miss, so point loadable_path nowhere.
    monkeypatch.setattr(sqlite_vec, "loadable_path", lambda: str(tmp_path / "missing" / "vec0"))
    fresh = sqlite3.connect(":memory:")
    try:
        ok, reason = vec_available(fresh)
    finally:
        fresh.close()
    assert ok is False
    assert reason is not None


# --- backend selection --------------------------------------------------------


def test_backend_reports_sqlite_vec_when_available(brain: BrainStore) -> None:
    available, _ = vec_available(brain._conn)
    expected = BACKEND_SQLITE_VEC if available else BACKEND_BRUTE_FORCE
    assert VisualVectorStore(brain).backend() == expected


def test_backend_reports_brute_force_when_forced(
    brain: BrainStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(vector_store_module, "vec_available", lambda _conn: (False, "forced"))
    assert VisualVectorStore(brain).backend() == BACKEND_BRUTE_FORCE


# --- parity: identical top-k across both backends -----------------------------


def _run_search(store: BrainStore, **search_kwargs: object) -> list[VisualHit]:
    _seed_spans(store)
    vs = VisualVectorStore(store)
    vs.upsert(_vector_rows())
    return vs.search([1.0, 0.0, 0.0], 3, **search_kwargs)  # type: ignore[arg-type]


def test_backends_agree_on_top_k_ordering(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """PARITY: the sqlite-vec and brute-force paths rank the fixture set the same."""
    # Brute-force run (loader forced off).
    with BrainStore.open(tmp_path / "bf.sqlite", clock=_clock()) as bf_store:
        bf_store.upsert_asset("a1", path="a.mp4", content_sha256="sha-a1")
        monkeypatch.setattr(vector_store_module, "vec_available", lambda _conn: (False, "forced"))
        assert VisualVectorStore(bf_store).backend() == BACKEND_BRUTE_FORCE
        bf_hits = _run_search(bf_store)
    monkeypatch.undo()

    # Real sqlite-vec run (skip that half honestly if the wheel won't load).
    with BrainStore.open(tmp_path / "vec.sqlite", clock=_clock()) as vec_store:
        vec_store.upsert_asset("a1", path="a.mp4", content_sha256="sha-a1")
        available, reason = vec_available(vec_store._conn)
        if not available:
            pytest.skip(f"sqlite-vec did not load; parity half skipped: {reason}")
        assert VisualVectorStore(vec_store).backend() == BACKEND_SQLITE_VEC
        vec_hits = _run_search(vec_store)

    assert _keys(bf_hits) == _keys(vec_hits)
    # The query points at t0=0.0; its near-neighbour t0=1.0 ranks second.
    assert _keys(vec_hits) == [0.0, 1.0, 2.0]
    # Scores line up on the same cosine scale (higher = more similar).
    assert bf_hits[0].score == pytest.approx(vec_hits[0].score, abs=1e-5)


# --- filters (run on both backends via parametrization) -----------------------


def _make_store(tmp_path: Path, name: str, force_brute: bool, monkeypatch) -> BrainStore:  # type: ignore[no-untyped-def]
    store = BrainStore.open(tmp_path / f"{name}.sqlite", clock=_clock())
    store.upsert_asset("a1", path="a.mp4", content_sha256="sha-a1")
    store.upsert_asset("a2", path="b.mp4", content_sha256="sha-a2")
    if force_brute:
        monkeypatch.setattr(vector_store_module, "vec_available", lambda _conn: (False, "forced"))
    elif not vec_available(store._conn)[0]:
        store.close()
        pytest.skip("sqlite-vec did not load; vec0 filter half skipped")
    return store


@pytest.mark.parametrize("force_brute", [True, False], ids=["brute-force", "sqlite-vec"])
def test_asset_id_filter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, force_brute: bool
) -> None:
    store = _make_store(tmp_path, "asset", force_brute, monkeypatch)
    with store:
        _seed_spans(store, asset_id="a1")
        _seed_spans(store, asset_id="a2")
        vs = VisualVectorStore(store)
        vs.upsert(_vector_rows("a1"))
        vs.upsert(_vector_rows("a2"))
        hits = vs.search([1.0, 0.0, 0.0], 10, asset_ids=["a2"])
        assert hits and {h.asset_id for h in hits} == {"a2"}


@pytest.mark.parametrize("force_brute", [True, False], ids=["brute-force", "sqlite-vec"])
def test_time_range_filter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, force_brute: bool
) -> None:
    store = _make_store(tmp_path, "time", force_brute, monkeypatch)
    with store:
        _seed_spans(store)
        vs = VisualVectorStore(store)
        vs.upsert(_vector_rows())
        # Only the span [2,3) overlaps [2.1, 2.4]; [1,2) and [3,4) fall outside.
        hits = vs.search([0.0, 1.0, 0.0], 10, time_range=(2.1, 2.4))
        assert _keys(hits) == [2.0]


# --- empty index / degenerate ------------------------------------------------


@pytest.mark.parametrize("force_brute", [True, False], ids=["brute-force", "sqlite-vec"])
def test_empty_index_returns_no_hits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, force_brute: bool
) -> None:
    store = _make_store(tmp_path, "empty", force_brute, monkeypatch)
    with store:
        vs = VisualVectorStore(store)
        assert vs.search([1.0, 0.0, 0.0], 5) == []
        # Upserting an empty batch is a no-op on both backends.
        assert vs.upsert([]) == 0
        assert vs.search([1.0, 0.0, 0.0], 5) == []


def test_non_positive_k_returns_empty(brain: BrainStore) -> None:
    _seed_spans(brain)
    vs = VisualVectorStore(brain)
    vs.upsert(_vector_rows())
    assert vs.search([1.0, 0.0, 0.0], 0) == []
    assert vs.search([1.0, 0.0, 0.0], -1) == []


def test_ensure_index_rejects_bad_dim(brain: BrainStore) -> None:
    with pytest.raises(ValueError, match="dim must be > 0"):
        VisualVectorStore(brain).ensure_index(0)


def test_ensure_index_false_when_unavailable(
    brain: BrainStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(vector_store_module, "vec_available", lambda _conn: (False, "forced"))
    assert VisualVectorStore(brain).ensure_index(3) is False


# --- re-upsert keeps the index consistent (both backends) ---------------------


@pytest.mark.parametrize("force_brute", [True, False], ids=["brute-force", "sqlite-vec"])
def test_reupsert_replaces_indexed_vector(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, force_brute: bool
) -> None:
    store = _make_store(tmp_path, "reupsert", force_brute, monkeypatch)
    with store:
        _seed_spans(store)
        vs = VisualVectorStore(store)
        vs.upsert(_vector_rows())
        # Flip the t0=0.0 vector to point at the z-axis; a z-query now ranks it first.
        vs.upsert(
            [
                VisualVectorRow(
                    asset_id="a1",
                    model=MODEL,
                    sampler_version=_SAMPLER,
                    t0=0.0,
                    dim=3,
                    vector=[0.0, 0.0, 1.0],
                )
            ]
        )
        hits = vs.search([0.0, 0.0, 1.0], 1)
        assert _keys(hits) == [0.0]
        # No duplicate rows crept into the durable table.
        assert len(store.list_visual_vectors()) == len(_FIXTURE_VECTORS)


def test_in_time_range_point_span() -> None:
    """A point/image span ([0,0)) is matched by instant containment, not overlap."""
    from framepilot_engine.brain.vector_store import _in_time_range

    assert _in_time_range(0.0, 0.0, 0.0, 1.0) is True
    assert _in_time_range(5.0, 5.0, 0.0, 1.0) is False


def test_brute_force_used_when_vec_available_but_index_missing(
    brain: BrainStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """vec available but no vec0 table yet → search falls back to durable rows."""
    if not vec_available(brain._conn)[0]:
        pytest.skip("sqlite-vec did not load")
    _seed_spans(brain)
    # Write durable rows ONLY (bypass the seam's index build).
    brain.upsert_visual_vectors(_vector_rows())
    vs = VisualVectorStore(brain)
    assert vs._index_ready() is False
    hits = vs.search([1.0, 0.0, 0.0], 2)
    assert _keys(hits) == [0.0, 1.0]


def test_migration_v3_tables_present(brain: BrainStore) -> None:
    # Guards the seam's assumption that visual_vectors/spans exist at v3.
    assert brain_migrations.SCHEMA_VERSION >= 3


def test_pack_unit_handles_zero_vector() -> None:
    """A zero vector normalizes to zeros instead of dividing by zero."""
    from framepilot_engine.brain.vector_store import _pack_unit

    assert _pack_unit([0.0, 0.0, 0.0]) == np.zeros(3, dtype="<f4").tobytes()


def test_vec_path_empty_index_returns_no_hits(brain: BrainStore) -> None:
    """vec available + index created but empty → the vec branch returns []."""
    if not vec_available(brain._conn)[0]:
        pytest.skip("sqlite-vec did not load")
    vs = VisualVectorStore(brain)
    assert vs.ensure_index(3) is True
    assert vs._index_ready() is True
    assert vs.search([1.0, 0.0, 0.0], 5) == []


def test_hit_without_span_metadata_is_skipped(
    brain: BrainStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Defensive: a scored vector whose span row is gone is dropped, not returned."""
    _seed_spans(brain)
    vs = VisualVectorStore(brain)
    vs.upsert(_vector_rows())
    monkeypatch.setattr(vs, "_span_meta_for", lambda keys: {})
    assert vs.search([1.0, 0.0, 0.0], 5) == []


def test_orphan_index_rowid_is_skipped(brain: BrainStore) -> None:
    """Defensive: a vec0 rowid missing from the map table is ignored in results."""
    if not vec_available(brain._conn)[0]:
        pytest.skip("sqlite-vec did not load")
    _seed_spans(brain)
    vs = VisualVectorStore(brain)
    vs.upsert(_vector_rows())
    # Drop one map row but leave its vec0 index row: that rowid can't resolve.
    brain._conn.execute(
        "DELETE FROM visual_vec_map WHERE t0 = ? AND asset_id = 'a1'", (0.0,)
    )
    brain._conn.commit()
    hits = vs.search([1.0, 0.0, 0.0], 10)
    assert 0.0 not in _keys(hits)  # the orphaned rowid never becomes a hit


def test_vec_path_resolves_metadata_only_for_top_k(
    brain: BrainStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression guard (MI7.1): the unfiltered vec path resolves span metadata and
    rowid→key for only the top-k hits, never the whole corpus.

    A revert to per-search full materialization of ``visual_spans`` / ``_MAP_TABLE``
    (the ~1-3 s p95 at 50k) would resolve all n rows; here we pin that the lookups
    see at most ``k`` keys/rowids even though the corpus has more spans than ``k``.
    """
    if not vec_available(brain._conn)[0]:
        pytest.skip("sqlite-vec did not load")
    _seed_spans(brain)  # 4 spans
    vs = VisualVectorStore(brain)
    vs.upsert(_vector_rows())

    k = 2
    seen_keys: list[int] = []
    seen_rowids: list[int] = []
    real_span_meta_for = vs._span_meta_for
    real_rowid_keys = vs._rowid_keys

    def spy_span_meta_for(
        keys: Sequence[tuple[str, str, int, float]],
    ) -> dict[tuple[str, str, int, float], tuple[float, int]]:
        keys = list(keys)
        seen_keys.append(len(keys))
        return real_span_meta_for(keys)

    def spy_rowid_keys(
        rowids: Sequence[int],
    ) -> dict[int, tuple[str, str, int, float]]:
        rowids = list(rowids)
        seen_rowids.append(len(rowids))
        return real_rowid_keys(rowids)

    monkeypatch.setattr(vs, "_span_meta_for", spy_span_meta_for)
    monkeypatch.setattr(vs, "_rowid_keys", spy_rowid_keys)

    hits = vs.search([1.0, 0.0, 0.0], k)
    assert _keys(hits) == [0.0, 1.0]  # correct top-k still returned
    assert seen_keys == [k]  # metadata resolved for exactly the k candidates, not all 4
    assert seen_rowids == [k]  # rowid→key resolved for exactly the k KNN hits, not all 4


def test_pk_lookups_resolve_every_key_across_chunk_boundary(brain: BrainStore) -> None:
    """MI7.1b: the batched PK lookups resolve EVERY key when a candidate set is
    larger than ``_LOOKUP_CHUNK`` — a filtered (``fetch_all``) search over a
    >200-span corpus splits into multiple ``IN (VALUES …)`` batches, and an
    off-by-one at a chunk edge would silently drop a key (its hit vanishing as a
    "hit without span metadata"). The filtered path is O(n) by construction; this
    guards its correctness, not its speed.
    """
    if not vec_available(brain._conn)[0]:
        pytest.skip("sqlite-vec did not load on this runtime")
    n = _LOOKUP_CHUNK + 50  # 250 → two batches (200 + 50), straddling the boundary
    spans = [
        VisualSpanRow(
            asset_id="a1",
            model=MODEL,
            sampler_version=_SAMPLER,
            t0=float(i),
            t1=float(i) + 1.0,
            scene_index=i,
            keyframe_t=float(i),
            phash=1,
            content_hash="sha-a1",
            frame_count=1,
        )
        for i in range(n)
    ]
    brain.upsert_visual_spans(spans)
    vs = VisualVectorStore(brain)
    vs.upsert(
        [
            VisualVectorRow(
                asset_id="a1", model=MODEL, sampler_version=_SAMPLER, t0=float(i), dim=3,
                vector=[1.0, 0.0, 0.0],
            )
            for i in range(n)
        ]
    )

    # Direct: the batched composite-PK lookup returns all n keys — none dropped at
    # the 200-key boundary — and each carries its real (t1, scene_index).
    keys = [("a1", MODEL, _SAMPLER, float(i)) for i in range(n)]
    meta = vs._span_meta_for(keys)
    assert len(meta) == n
    assert meta[("a1", MODEL, _SAMPLER, 200.0)] == (201.0, 200)  # the boundary key resolves

    # Public: a filtered search fetches all n candidates (multi-batch resolution),
    # then returns a complete, correctly-annotated top-k. Vectors are identical, so
    # the deterministic tie-break by t0 pins the result to t0 0…9.
    hits = vs.search([1.0, 0.0, 0.0], 10, asset_ids=["a1"])
    assert _keys(hits) == [float(i) for i in range(10)]
    assert all(h.t1 == h.t0 + 1.0 for h in hits)  # every hit kept its span metadata
