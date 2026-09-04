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
