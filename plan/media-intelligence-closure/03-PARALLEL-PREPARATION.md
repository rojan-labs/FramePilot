# Phase 3 — Parallel preparation `[ ]`

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

## 3.3 Targets

Derived from the measured baselines, assuming the network is the only cost:

| Scenario                                  | Now        | Target      | Basis                                                               |
| ----------------------------------------- | ---------- | ----------- | ------------------------------------------------------------------- |
| 60 photos, built-in, no captions          | 92.7 s     | **≤ 20 s**  | 8-way embed concurrency on ~1.5 s of CPU                            |
| 56 assets, built-in, with captions        | 318.5 s    | **≤ 90 s**  | 4-way caption concurrency (VLM calls dominate)                      |
| 11 videos / 6.3 min, TwelveLabs           | 544 s      | **≤ 180 s** | 4 concurrent uploads; hosted indexing latency is not ours to remove |
| **Time to first usable map**, any project | = full run | **≤ 5 s**   | see §3.5                                                            |

These are budgets to hold, not predictions. Each is asserted by a test at the scale it
names.

## 3.4 Design

**Asset-level concurrency inside a slice, not more slices in flight.** The journal, the
cursor, and the per-project lock stay exactly as they are — they are the reason
preparation is resumable and idempotent, and they are not the bottleneck. Raise
`DEFAULT_VISUAL_SLICE` and process the slice's assets concurrently within the single
held lock. The cursor still advances by the number of assets that reached a terminal
state, so a crash mid-slice re-does at most one slice.

- **Per-asset concurrency:** default 4, bounded by a new
  `FRAMEPILOT_VISUAL_CONCURRENCY` (add to `.env.example` **and** `turbo.json`
  `globalEnv` in the same change — one source of truth, AGENTS.md).
- **Embed batch concurrency:** issue the batches of 8 concurrently rather than in a
  `for` loop, bounded by the same limit.
- **Key rotation becomes throughput.** `KeyRing` keeps its failover semantics and gains
  a checkout mode: N in-flight requests draw N _distinct_ alive keys. This is the change
  that makes the Settings hint true. A single key behaves exactly as today.
- **Backpressure:** on a `429` or a payload-too-large split, the limiter halves and
  recovers on success. The existing per-key cooldown already carries the state; the
  limiter reads it rather than inventing a second one.
- **Ordering:** results are collected and the cursor advanced in **worklist order**, so
  a partial slice is always a prefix. Concurrency must not make resume non-deterministic.

**Cost implications.** Concurrency changes the rate, not the count: the same assets are
embedded/uploaded once each. The one new cost risk is a systemic failure burning
through assets faster — which is exactly what
`TL_CONSECUTIVE_FAILURE_LIMIT` (Phase 1) already bounds, and the bound must be checked
against _completed_ assets in worklist order so concurrency cannot outrun it.

## 3.5 Progressive availability

The trade-off the brief asks about — deeper analysis vs. time-to-first-map — is
**already resolved in FramePilot's favour and merely unexposed**. `_builtin_footage_map`
derives from whatever spans exist; a 10%-prepared project already returns a real 10%
map. Nothing needs to be built for the map to be progressive.

What is missing is that nobody says it is partial. Add `coverage: {prepared, total}` to
`FootageMapResponse`, render it in the digest header ("12 of 61 assets prepared so
far"), and the agent can start reading immediately and knows not to conclude the
footage contains nothing else. This is a small change with most of the perceived-speed
win, and it lands **before** the concurrency work so the concurrency work can be
measured against it.

**Recommendation:** ship §3.5 first, then §3.4.

## 3.6 Regression guards

- A benchmark test at the user's real scale (60 photos, from the existing fixture
  generator) asserting the §3.3 budgets, marked so it can run in CI without a live key
  by stubbing the provider seam at a fixed latency — the thing being measured is
  concurrency, not the provider.
- A determinism test: the same worklist under concurrency 1 and concurrency 8 produces
  identical spans and an identical cursor sequence.
- A cost test: N assets produce exactly N provider calls under concurrency, not more.

## 3.7 Deferred

- Sampling-rate tuning and proxy reuse. The measurement says local decode is 1.6% of
  wall clock; tuning it optimizes the part that does not matter.
- GPU/local embedding models. A different product decision, not a performance one.
- Cross-project concurrency. One project at a time is the user's actual workflow.
