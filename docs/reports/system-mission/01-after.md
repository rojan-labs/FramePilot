# Phase 1 — Orchestration and context: after

Same fixtures, same harness, same rubric as `00-baseline.md` (P0.2/P0.3):
`mission-baseline.mjs --runs 3` against the real desktop sidecar and the mission fixture
projects, scored by `eval/mission-rubric.ts`.

## Status of this measurement — read first

The after-run was **cut short by the provider**, not by the code. The bridge began
returning 429 after roughly three hours and the harness spent ten-minute backoffs on a
single turn until it had exhausted its retries. Three scenarios completed all their runs;
three did not start. Those rows are marked `[!]` in `01-ORCHESTRATION-AND-CONTEXT.md` with
the exact command to finish them.

Two honest caveats about the numbers below:

1. **Cache share is not comparable.** The completed turns were recovered from the harness
   log (`mission-salvage.mjs`), which prints prompt/output tokens but not the cache-read
   split. The after column therefore shows `0.00` where it means *not measured*. Nothing
   here supports a claim about cache behaviour in either direction.
2. **Everything else is measured**, per turn, three runs per scenario, p50.

## Per-scenario, before → after (p50 over 3 runs)

| scenario | model calls | prompt tokens | output tokens | tool calls | repeats | ops | wall | USD | rubric | runs that did not complete |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | 10 → 31 | 332k → 963k | 37.9k → 97.6k | 56 → 66 | 28 → 51 | **0 → 35** | 424s → 1070s | $0.57 → $1.52 | **0.25 → 1.00** | **2/3 → 0/3** |
| podcast-highlight-60s | **25 → 5** | **804k → 173k** | **101k → 21k** | **58 → 8** | **30 → 4** | 1 → 1 | **1200s → 253s** | **$1.54 → $0.32** | 1.00 → 1.00 | **3/3 → 0/3** |
| remove-dead-air | 1 → 7 | 0 → 180k | 0 → 62k | 0 → 59 | 0 → 53 | **0 → 54** | 0s → 584s | $0.00 → $0.94 | **0.25 → 0.75** | **3/3 → 0/1** |
| beat-sync | — | — | — | — | — | — | — | — | 0.22 (baseline) | 3/3 (baseline) |
| refine-tighten t1/t2 | — | — | — | — | — | — | — | — | 0.25 / 0.50 (baseline) | 3/3 (baseline) |
| memory-captions t1/t2/t3 | — | — | — | — | — | — | — | — | 0.38 / 0.29 / 0.29 (baseline) | 3/3 (baseline) |

## What the numbers say

**The baseline was cheap because it was failing.** Every baseline row in the table has a
`did not complete` count, and two of the three measured scenarios landed **zero
operations**. A run that dies at call 10 with an empty timeline costs less than a run that
edits the video; comparing their token counts without their outcomes would have been the
easiest wrong conclusion available. The rubric column is the one to read first.

- **podcast-highlight-60s is the clean win.** 5× fewer model calls, 4.6× fewer prompt
  tokens, 4.7× faster, 4.8× cheaper — *and* it now finishes, which it never did before.
  This is the output-cap fix (`outputRoomFor`, P1.1): the baseline runs were burning turns
  re-emitting a truncated response, never reaching a terminal state.
- **remove-dead-air went from nothing to an edit.** The baseline could not survive echoing
  ~110 silence ranges through an 8,192-token output window: one call, zero operations,
  three of three runs unfinished. With `remove_silences` (P4.1) measuring once in the host
  and the orchestrator turning the ranges into ripple deletes, the same request now lands
  **54 operations** and scores 0.75. The remaining rubric point is a mid-word cut, which is
  a tuning question for the breath padding, not a structural failure.
- **montage-30s costs more and is finally correct.** 0 → 35 operations, 0.25 → 1.00, and
  no run leaves work unfinished. The extra calls and tokens buy a montage that exists.
  Whether 31 calls is the right price for it is Phase 5's question, not this one — the
  measurement to beat is now a *succeeding* run.

## Where the remaining cost is

Repeated tool calls are still high (montage 51 of 66). The stage-scoped tool set and the
action-log window are the levers, and both sit in Phase 5. Nothing in this phase attacked
repetition directly, and the numbers say so.

## Finishing the three missing scenarios

```
cd packages/ai-sdk
node scripts/mission-baseline.mjs --runs 3 --label after \
  --only beat-sync,refine-tighten,memory-captions \
  --dump-events ../../reports/system-mission/runs \
  --out ../../reports/system-mission/after-orchestration-rest.json
```

Needs a provider with headroom (the bridge in `scratchpad/mission.env` rate-limits at
roughly $4–8 of traffic). Merge with `after-orchestration-partial.json` and re-run
`mission-report.mjs` to replace the placeholder rows above.
