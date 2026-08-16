"""Perf-budget guards for the visual retrieval path (plan MI7.1).

WHY: MI7.1 promises two numbers we must be able to *defend*, not just claim —

1. **Visual search p95 < 100 ms at 50k vectors** on the desktop sqlite-vec
   backend (``VisualVectorStore.search``).
2. **Indexing throughput** through the deterministic engine write path
   (``VisualVectorStore.upsert`` = durable BLOB write + ``vec0`` index maintenance)
   held above a documented floor.

Both budgets are documented in ``docs/guides/performance-budgets.md`` — this
module is their executable guard.

Non-flakiness (CLAUDE.md: "a flaky perf test is worse than none"):

- **Gate.** The strict, tight budget assertion (p95 < 100 ms at the full 50 000
  vectors) is opt-in behind the ``FRAMEPILOT_PERF=1`` environment gate. Default
  ``pnpm engine:test`` builds a small corpus, **measures and logs** the numbers,
  and asserts only a very generous regression ceiling — enough to catch a
  catastrophic O(n²)-class blow-up without failing on shared-runner jitter. The
  wired-up tight budget runs on demand / on the reference desktop
  (``FRAMEPILOT_PERF=1 uv run pytest tests/test_visual_perf.py -s``). This is the
  first mechanism the MI7.1 brief lists; the repo had no pre-existing slow/perf
  marker convention (no ``@pytest.mark.slow``/``perf`` anywhere), so an env gate
  is used rather than inventing a registered marker under ``--strict-markers``.
- **Robust statistic.** Timings are the p95 over many iterations after warmup,
  and the measured number is always printed so a regression is visible even when
  the ceiling is loose.
- **Honest skip.** sqlite-vec loadability is a property of the runtime, not the
  file (see ``vector_store``); when the ``vec0`` extension will not load the KNN
  budget is *skipped*, never failed (reuses the ``test_brain_vector_store``
  ``_skip_if_no_vec`` discipline).

Embedding dimension: :data:`EMBEDDING_DIM` is a representative CLIP-class visual
width. The production dim is **captured at runtime** from the first NVIDIA
``nvidia/llama-nemotron-embed-vl-1b-v2`` response (``VisualEmbedClient.dim``) and
is never hardcoded in the engine; KNN cost scales ~linearly in dim, so the
desktop budget spot-check must re-run against the real model's dim (see the
report note in the budgets doc).

WHAT THIS CANNOT MEASURE (flagged for the desktop): the indexing-throughput
number here bounds only the **deterministic engine write path**. It deliberately
excludes ffmpeg keyframe extraction and the NVIDIA embedding-API latency — those
are third-party costs we do not regress-gate — so the end-to-end spans/sec on
real minutes-long camera files (CLAUDE.md's desktop-scale media) must be verified
on the desktop, not in this hermetic unit test.
"""

from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

import numpy as np
import pytest

from framepilot_engine.brain.models import VisualSpanRow, VisualVectorRow
from framepilot_engine.brain.store import BrainStore
from framepilot_engine.brain.vector_store import VisualVectorStore, vec_available

# --- Budget constants (no magic numbers; the doc mirrors these) -----------------

#: The MI7.1 search budget: 95th-percentile ``search`` latency on the reference
#: desktop, sqlite-vec backend, at the corpus size below.
SEARCH_P95_BUDGET_MS = 100.0
#: Corpus size the search budget is defined at (plan MI7.1: "50k vectors").
SEARCH_BUDGET_CORPUS_SIZE = 50_000

#: The indexing-throughput floor: durable-write + ``vec0`` index maintenance must
#: sustain at least this many rows/sec on the reference desktop. Set far below the
#: measured reference rate (~4k rows/s at 50k) so runner variance never trips it —
#: it guards against a catastrophic per-row regression, not micro-drift.
INDEXING_THROUGHPUT_FLOOR_ROWS_PER_S = 500.0

#: Representative CLIP-class visual embedding width (see module docstring — the
#: production dim is captured at runtime, never hardcoded in the engine).
EMBEDDING_DIM = 1024

#: Default (CI) corpus sizes — small enough to build in ~1 s so the guard runs in
#: the normal suite while still exercising the real vec0 + scan code paths.
DEFAULT_SEARCH_CORPUS_SIZE = 2_000
DEFAULT_INDEXING_CORPUS_SIZE = 5_000

#: Generous non-strict regression ceiling for search p95 (catches an algorithmic
#: blow-up at the small default corpus; NOT the tight 100 ms budget, which is the
#: strict-gate assertion at 50k).
SEARCH_REGRESSION_CEILING_MS = 250.0

#: Query/measurement shape.
SEARCH_K = 10
SEARCH_WARMUP_ITERS = 3
SEARCH_TIMED_ITERS = 30

_MODEL = "nvidia/llama-nemotron-embed-vl-1b-v2"
_SAMPLER_VERSION = 1
_ASSET_ID = "perf-asset"
_CONTENT_HASH = "sha-perf"
_RANDOM_SEED = 20260718

#: Opt-in gate: build the full 50k corpus and assert the tight budget on demand.
PERF_STRICT = os.environ.get("FRAMEPILOT_PERF") == "1"


def _skip_if_no_vec(conn: sqlite3.Connection) -> None:
    """Skip (never fail) when the ``vec0`` extension will not load on this runtime."""
    ok, reason = vec_available(conn)
    if not ok:
        pytest.skip(f"sqlite-vec did not load on this runtime; KNN budget skipped: {reason}")


def _percentile(values: list[float], q: float) -> float:
    """Nearest-rank percentile ``q`` (0..100) of ``values`` (already a small list)."""
    ordered = sorted(values)
    idx = min(len(ordered) - 1, round((q / 100.0) * (len(ordered) - 1)))
    return ordered[idx]


def _synthetic_vectors(n: int) -> list[list[float]]:
    """``n`` deterministic, seeded ``EMBEDDING_DIM``-wide vectors (mock embedder output).

    Seeded so the corpus — and therefore the measurement — is reproducible; the
    values are irrelevant to timing (the KNN visits every indexed vector).
    """
    rng = np.random.default_rng(_RANDOM_SEED)
    vectors: list[list[float]] = rng.standard_normal((n, EMBEDDING_DIM), dtype=np.float32).tolist()
    return vectors


def _seed_spans(store: BrainStore, n: int) -> None:
    """Seed ``n`` visual spans so search hits resolve (part of the measured cost)."""
    store.upsert_visual_spans(
        [
            VisualSpanRow(
                asset_id=_ASSET_ID,
                model=_MODEL,
                sampler_version=_SAMPLER_VERSION,
                t0=float(i),
                t1=float(i) + 1.0,
                scene_index=i,
                keyframe_t=float(i),
                phash=1,
                content_hash=_CONTENT_HASH,
                frame_count=1,
            )
            for i in range(n)
        ]
    )


def _vector_rows(vectors: list[list[float]]) -> list[VisualVectorRow]:
    return [
        VisualVectorRow(
            asset_id=_ASSET_ID,
            model=_MODEL,
            sampler_version=_SAMPLER_VERSION,
            t0=float(i),
            dim=EMBEDDING_DIM,
            vector=vector,
        )
        for i, vector in enumerate(vectors)
    ]


def test_visual_search_p95_budget(tmp_path: Path) -> None:
    """Search p95 latency at corpus scale — tight 100 ms budget under ``FRAMEPILOT_PERF``.

    Default run: small corpus, measure + log, assert only the generous regression
    ceiling. Strict run (``FRAMEPILOT_PERF=1``): the full 50k budget corpus and the
    ``SEARCH_P95_BUDGET_MS`` assertion — the number defended on the desktop.
    """
    corpus_size = SEARCH_BUDGET_CORPUS_SIZE if PERF_STRICT else DEFAULT_SEARCH_CORPUS_SIZE
    with BrainStore.open(tmp_path / "search-perf.sqlite") as store:
        _skip_if_no_vec(store._conn)
        store.upsert_asset(_ASSET_ID, path="perf.mp4", content_sha256=_CONTENT_HASH)
        _seed_spans(store, corpus_size)
        vectors = _synthetic_vectors(corpus_size)
        vs = VisualVectorStore(store)
        vs.upsert(_vector_rows(vectors))
        assert vs.backend() == "sqlite-vec"  # the budget is defined for this backend

        query = _synthetic_vectors(1)[0]
        for _ in range(SEARCH_WARMUP_ITERS):
            vs.search(query, SEARCH_K)
        samples_ms: list[float] = []
        for _ in range(SEARCH_TIMED_ITERS):
            start = time.perf_counter()
            hits = vs.search(query, SEARCH_K)
            samples_ms.append((time.perf_counter() - start) * 1000.0)
        assert len(hits) == SEARCH_K  # a real top-k came back (work was done)

    p50 = _percentile(samples_ms, 50.0)
    p95 = _percentile(samples_ms, 95.0)
    print(
        f"\n[MI7.1 search] backend=sqlite-vec dim={EMBEDDING_DIM} n={corpus_size} "
        f"k={SEARCH_K} iters={SEARCH_TIMED_ITERS} p50={p50:.2f}ms p95={p95:.2f}ms "
        f"(budget={SEARCH_P95_BUDGET_MS:.0f}ms@{SEARCH_BUDGET_CORPUS_SIZE}, strict={PERF_STRICT})"
    )

    if PERF_STRICT:
        assert p95 < SEARCH_P95_BUDGET_MS, (
            f"search p95 {p95:.2f}ms exceeds the {SEARCH_P95_BUDGET_MS:.0f}ms budget "
            f"at {corpus_size} vectors"
        )
    else:
        assert p95 < SEARCH_REGRESSION_CEILING_MS, (
            f"search p95 {p95:.2f}ms blew past the {SEARCH_REGRESSION_CEILING_MS:.0f}ms "
            f"regression ceiling at {corpus_size} vectors — likely an algorithmic regression"
        )


def test_indexing_throughput_floor(tmp_path: Path) -> None:
    """Deterministic index-write throughput (rows/s) stays above the documented floor.

    Measures ``VisualVectorStore.upsert`` — durable BLOB write + ``vec0`` index
    maintenance — with pre-computed (mock-embedder) vectors, so the number
    reflects OUR engine code, not the NVIDIA embedding API or ffmpeg (both
    excluded on purpose; see module docstring).
    """
    corpus_size = SEARCH_BUDGET_CORPUS_SIZE if PERF_STRICT else DEFAULT_INDEXING_CORPUS_SIZE
    with BrainStore.open(tmp_path / "index-perf.sqlite") as store:
        _skip_if_no_vec(store._conn)
        store.upsert_asset(_ASSET_ID, path="perf.mp4", content_sha256=_CONTENT_HASH)
        _seed_spans(store, corpus_size)  # not timed — isolates the index-write cost
        rows = _vector_rows(_synthetic_vectors(corpus_size))
        vs = VisualVectorStore(store)

        start = time.perf_counter()
        written = vs.upsert(rows)
        elapsed = time.perf_counter() - start
        assert written == corpus_size

    rows_per_s = corpus_size / elapsed if elapsed > 0 else float("inf")
    print(
        f"\n[MI7.1 indexing] n={corpus_size} elapsed={elapsed:.2f}s "
        f"throughput={rows_per_s:,.0f} rows/s "
        f"(floor={INDEXING_THROUGHPUT_FLOOR_ROWS_PER_S:.0f} rows/s, strict={PERF_STRICT})"
    )

    assert rows_per_s >= INDEXING_THROUGHPUT_FLOOR_ROWS_PER_S, (
        f"index-write throughput {rows_per_s:,.0f} rows/s fell below the "
        f"{INDEXING_THROUGHPUT_FLOOR_ROWS_PER_S:.0f} rows/s floor at {corpus_size} rows"
    )
