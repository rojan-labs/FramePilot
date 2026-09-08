# Golden baseline — goal.md Phase 0

**Status: harness built and fixture-verified; real-media baseline pending manual run.**
Nothing below is a real-media number unless it says which file it came from.

## What the fixtures prove (2026-09-02, branch `feat/golden-eval-harness`)

`pnpm --filter @framepilot/ai-sdk exec vitest run src/eval/` — 4 files, 69 tests, green.

| Claim | Evidence |
| --- | --- |
| Every goal.md category has a golden case, and every case is scorable | `golden-cases.test.ts` (20 cases: 13 required categories, a second phrasing of trim/reorder/captions, and the 6 mission scenarios) |
| Rubric checks decide correctly on synthetic timelines, incl. one-frame-off, stray-clip, gap, out-of-programme cue, unquiet music | `mission-rubric.test.ts` |
| Undo of real `editor-core` patches (`trim_clip` + `delete_range`) restores the project identically (`timeline.revision` excluded — monotonic by design) | `golden-metrics.test.ts › checkReversibility` |
| Intent is read from events (ask > edit > decline > silent; failed/cancelled from status); silent success = completed + expected edit + zero ops | `golden-metrics.test.ts › observeIntent / measureGoldenTurn` |
| Latency to first progress is the first user-visible event; p50/p95 nearest-rank | `golden-metrics.test.ts` |
| Tokens/USD are per **accepted** edit and go `null` (never 0) when any row is unpriced | `golden-metrics.test.ts › summarizeGoldenRun` |
| Cost estimate is unknown-not-partial when any case lacks a prior run | `golden-metrics.test.ts › estimateRun` |
| The gate fails on a first-pass drop, a new silent success, or +10% tokens per accepted edit without a first-pass gain | smoke run of `golden-gate.mjs` on a synthetic summary (exit 2, three regressions named) |
| Live → per-case files → recordings → `--replay` reproduces identical scores with zero model calls | smoke run with `FRAMEPILOT_AI_PROVIDER=mock` and no sidecar; artifacts deleted, not committed |

## Prior real-media numbers (the six mission scenarios only)

From `reports/system-mission/after-orchestration-merged.json` (2026-08-29, `claude-sonnet-5`
via the `trial/` bridge, 3 runs each), reduced by `golden-gate.mjs` — this is the committed
`reports/golden/floor.json` (its golden-metrics block is empty until the baseline run):

| scenario | rubric p50 | calls p50 | tokens/turn p50 |
| --- | --- | --- | --- |
| montage-30s | 1.00 | 31 | 33,503 |
| podcast-highlight-60s | 1.00 | 5 | 38,814 |
| remove-dead-air | 0.75 | 6 | 26,979 |
| beat-sync | 0.78 | 18 | 30,080 |
| refine-tighten t1 / t2 | 0.63 / 0.88 | — | — |
| memory-captions t1 / t2 / t3 | 0.63 / 0.71 / 0.43 | — | — |

These carry no intent / target / first-pass / reversibility / latency figures — that run
predates the metrics, and inventing them from it would be exactly what goal.md forbids.

## Pending manual verification

The eleven new cases (`trim-first-clip-10s`, `reorder-last-first`, `captions-plain`,
`hook-strongest-line`, `broll-first-20s`, `music-bed-quiet`, `compound-silence-captions`,
`vague-make-better`, `impossible-8k-drone`, `guard-wipe-timeline`, `clarify-which-clip`)
and all ten metrics on the whole set. Recipe: `docs/guides/golden-eval.md` → "Running";
the floor is then written with `node packages/ai-sdk/scripts/golden-gate.mjs
reports/golden/baseline/summary.json --write`.

## Leads observed while building (fixture-only; unconfirmed on real media)

- On the mock-provider smoke, a turn settled `failed` with **zero `error` events** while
  one `delete_range` had been folded in and the reply read like a success. If that shape
  reproduces on a real run it is a "fails quietly" defect (goal.md: failure quality) —
  the harness reports it as `failure quality: 0 loud`.

---

## Visual-understanding floor (VU0.1, recorded 2026-09-07)

**This is the number `plan/visual-understanding` is judged against, and it was read off
runs that already happened — no case was re-run for it.** Every per-turn result file under
`reports/golden/*/cases/` records `metrics.toolCallsByName`, which is the same evidence
`src/eval/perception-metrics.ts` computes from. Reproduce with:

```bash
node packages/ai-sdk/scripts/perception-baseline.mjs reports/golden/baseline reports/golden/session6 \
  reports/golden/session3 reports/golden/s8-replay-all reports/golden/s8-replay reports/golden/s7-gapfill
```

The four s9 runs below live on branch `fix/ai-editing-audit-2026-09-07`; they were extracted
read-only (`git archive`) for this table and are not in this tree.

| run | turns | accepted edits | frames seen | frames/edit | footage calls | calls/turn |
| --- | --- | --- | --- | --- | --- | --- |
| reports/golden/baseline | 72 | 43 | 0 | 0.00 | 0 | 0.00 |
| reports/golden/session6 | 72 | 32 | 0 | 0.00 | 0 | 0.00 |
| reports/golden/session3 | 37 | 29 | 0 | 0.00 | 0 | 0.00 |
| reports/golden/s8-replay-all | 42 | 33 | 0 | 0.00 | 0 | 0.00 |
| reports/golden/s8-replay | 9 | 3 | 0 | 0.00 | 0 | 0.00 |
| reports/golden/s7-gapfill | 10 | 8 | 0 | 0.00 | 0 | 0.00 |
| (s9 branch) s9-live-all | 24 | 21 | 0 | 0.00 | 0 | 0.00 |
| (s9 branch) s9-live-all-planfirst | 4 | 4 | 0 | 0.00 | 0 | 0.00 |
| (s9 branch) s9-live-reorder | 6 | 3 | 0 | 0.00 | 0 | 0.00 |
| (s9 branch) s9-baseline-replay | 42 | 34 | 0 | 0.00 | 0 | 0.00 |
| **all** | **318** | **210** | **0** | **0.00** | **0** | **0.00** |

Timeline reads (`get_timeline`/`get_timeline_summary`): **192**
Timeline reads per frame seen: **—**
Footage surfaces called: **none, in any run**
Grade/transition tool calls: **3** over 1 turn(s); turns that measured first: **0** ⇒ guess rate **1.00**

### What it says

- **The agent has never looked at a frame.** Across 318 scored turns and 210 accepted edits
  in ten recorded runs, `get_frame` was called **zero** times. The earlier estimate of "13"
  came from grepping report prose, not call records; the true figure is worse.
- **The footage surfaces are dead.** `search_visual`, `describe_footage`, `map_footage` and
  `measure_color`: **zero calls, in every run**. They exist, they are advertised in the tool
  registry, and no run has ever used one.
- **The timeline is read instead.** 192 `get_timeline`/`get_timeline_summary` calls — the
  agent re-reads clip geometry and has no other source of truth about the picture.
- **Every colour/transition number was guessed.** 3 `apply_color_grade`/`add_transition`
  calls, in 1 turn, none preceded by a measurement ⇒ guess rate **1.00**.

### The targets these numbers set

| Metric | Floor (2026-09-07) | VU2 exit | VU3/VU4 exit |
| --- | --- | --- | --- |
| frames seen / accepted edit | 0.00 | ≤ 0.50 | ≤ 0.50 |
| footage-surface calls / turn | 0.00 | may rise; irrelevant if rows carry facts | — |
| picture facts in prompt | 0% of rows | ≥ 90% of shown picture rows | — |
| grade/transition guess rate | 1.00 | — | ≤ 0.10 |

`frames seen` is a **ceiling, not a goal**: the plan's claim is that facts as text remove the
need to look, so a change that raises it has not worked, and the VU7 verification frames count
against this budget too.
