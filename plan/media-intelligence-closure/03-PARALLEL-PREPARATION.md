# Phase 3 — Parallel preparation `[x]` shipped 2026-08-28

**User outcome.** Import 60 assets and have a usable map in seconds, not minutes,
with no manual step and no waiting on a progress bar to reach the end before anything
is readable.

**Maintainer sanction.** Parallelization is explicitly approved. This phase spends
that sanction where the measurement says the time actually goes.

---

## 3.1 Measured baseline (this machine, the user's own projects)

| Project                    | Work                                       | Wall clock  | Per asset            |
| -------------------------- | ------------------------------------------ | ----------- | -------------------- |
| `project_champadevi_hike`  | built-in, 60 photos + 1 video, no captions | **92.7 s**  | 1.55 s               |
| `project_check_indexing`   | built-in, 56 assets, 50 VLM captions       | **318.5 s** | 5.7 s                |
| `project_landspace_nature` | TwelveLabs, 11 videos, 6.3 min footage     | **544 s**   | 49 s ≈ 1.4× realtime |

Local cost of the same work, measured directly with `ffprobe`/`ffmpeg`:

| Operation                            | Cost          |
| ------------------------------------ | ------------- |
| probe a photo / extract its keyframe | 24–25 ms each |
| extract one video keyframe           | 57–134 ms     |

**60 photos ≈ 1.5 s of local CPU against 92.7 s of measured wall clock. ≈98% of
preparation time is serialized network wait.** That is the whole finding: this is not
a CPU or ffmpeg problem, and no amount of sampling-rate tuning will move it.

## 3.2 Where the serialization is

1. `DEFAULT_VISUAL_SLICE = 1` — one asset per HTTP call.
2. `runVisualIndexLoop` awaits each slice before posting the next.
3. `_visual_index_lock(project_id)` — one in-flight slice per project, by construction.
4. `VisualEmbedClient.embed_passages` walks batches of 8 sequentially
   (`visual_embed.py:195`).
5. `KeyRing.acquire` returns "the first alive key", always. **Multiple NVIDIA keys buy
   resilience, not throughput.** The brief asked whether the comma-separated keys the
   Settings field accepts are used in parallel: they are not. `docs/guides/media-intelligence.md`
   describes the ring accurately as failover; the Settings field says only
   "comma-separated" and leaves the user to guess. Making them parallel is the single
   highest-leverage change in this phase, because it is the only one that raises the
   provider-side ceiling rather than just packing the same ceiling tighter.
6. The TwelveLabs arm uploads one asset at a time and polls it for up to
   `TL_SLICE_POLL_BUDGET_SECONDS = 30` before yielding.

## 3.3 Targets, and what was actually measured

Preparation of 60 photos, driven through the real route with the provider seam stubbed
at the per-asset latency measured on the user's own project (155 ms — the measured
1.55 s/asset scaled 1/10 so the benchmark is quick; the ratio is the finding):

| Concurrency             | Measured   | Extrapolated to real latency | vs. serial |
| ----------------------- | ---------- | ---------------------------- | ---------- |
| 1 (the old behaviour)   | 10.98 s    | ~110 s                       | —          |
| **4 (shipped default)** | **2.95 s** | **~30 s**                    | **3.7×**   |
| 8                       | 2.26 s     | ~23 s                        | 4.9×       |
| 10 (`MAX_VISUAL_SLICE`) | 1.68 s     | ~17 s                        | 6.5×       |

The serial row extrapolates to ~110 s against **92.7 s measured on the real 60-photo
project**, which is the check that the harness models the real thing rather than
something else.

**The ≤20 s target is reached at concurrency 10, and the shipped default is 4.** That is
a deliberate choice, not a miss: per-asset concurrency is not bounded by the key ring
(only the embed-batch concurrency inside one call is), so eight concurrent assets on a
single NVIDIA key are eight requests against one rate limit. Four is the value that is
safe on one key. A user with several keys raises it with
`FRAMEPILOT_VISUAL_INDEX_CONCURRENCY` and gets the rest of the curve. If a rate limit is
hit anyway the ring cools that key, `alive_count` falls, embed concurrency falls with it,
and the run reports honestly rather than failing.

The hosted (TwelveLabs) path gets the same treatment — uploads now overlap — but its
remaining cost is TwelveLabs' own indexing latency, which is not ours to remove.

## 3.4 What shipped

**Asset-level concurrency inside a slice, not more slices in flight.** The journal, the
cursor and the per-project lock are untouched — they are what make preparation resumable
and idempotent, and they were never the bottleneck. `_prepare_slice` runs the slice's
assets through a bounded pool, each worker holding **its own brain connection**: the
store is not thread-safe, but the database is WAL with a 5 s busy timeout and its module
docstring already anticipated two handlers holding a connection at once.

- **`FRAMEPILOT_VISUAL_INDEX_CONCURRENCY`** (default 4), registered in `.env.example` and
  `turbo.json` `globalEnv` in the same change. `1` restores strictly serial preparation
  exactly, and is asserted to.
- **`DEFAULT_VISUAL_SLICE` moved 1 → the concurrency default.** A slice of one leaves the
  pool empty and the whole point unrealised.
- **Embed batches go out together** (`VisualEmbedClient.embed_passages`), bounded by
  `KeyRing.alive_count` — the keys that can actually serve them.
- **`KeyRing.acquire(..., exclusive=True)`** turns several keys from failover into
  throughput: N concurrent callers draw N distinct keys, where before every request
  queued behind "the first alive key". The sequential path is bit-for-bit unchanged (a
  caller that never releases sees in-flight counts of zero throughout), and the ring is
  now lock-guarded because it stopped being single-threaded.
- **Backpressure with no second limiter:** as keys cool, `alive_count` falls and embed
  concurrency falls with it. The ring's own state is the signal.
- **Ordering:** the cursor advances over a **prefix** of the worklist. If asset 3 fails
  while asset 4 has already succeeded, the cursor stops at 3 — asset 4's work is
  persisted and its re-run is a cheap no-op, and resume never has to remember a hole.

**Cost.** Concurrency changes the rate, not the count: N assets are N provider calls, and
a test asserts it. The one weakening is the hosted failure bound — assets already in
flight when `TL_CONSECUTIVE_FAILURE_LIMIT` trips still complete, so the ceiling against a
broken index is the limit plus `concurrency - 1` uploads, once, rather than exactly the
limit. Bounded, small, and documented at the constant.

## 3.5 Progressive availability — shipped

Closed in its own commit: `FootageMapResponse.coverage` reports `{prepared, total}` from
the same union `GET /brain/visual/status` counts, and the digest says "Built from 12 of
61 assets prepared so far" only while preparation is incomplete. The map was always
progressive; nothing said so, which left every reader unable to tell a thin map from thin
footage.

## 3.6 Regression guards

`engine/python/tests/test_service_visual_index_concurrency.py`:

- the same worklist yields identical spans, cursor and item order at concurrency 1, 2, 8;
- the cursor advances over a prefix even when a later asset finished first;
- N assets cost exactly N provider calls;
- the provider wait actually overlaps (asserted on observed in-flight overlap against a
  stubbed latency, so it measures our concurrency and cannot flake on a loaded runner);
- `concurrency=1` really is serial.

Plus `KeyRing` exclusive-checkout and `alive_count` coverage, and concurrent-batch
ordering coverage in `test_visual_embed.py`.

## 3.7 Deferred

- Sampling-rate tuning and proxy reuse. Local decode is 1.6% of wall clock; tuning it
  optimizes the part that does not matter.
- GPU/local embedding models. A different product decision, not a performance one.
- Cross-project concurrency. One project at a time is the actual workflow.
- Making per-asset concurrency key-ring-aware. It would let the default rise safely, but
  it needs a signal the hosted path does not have; the env var covers the case today.
