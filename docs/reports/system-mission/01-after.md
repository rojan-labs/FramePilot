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

**Correction, same day.** An earlier draft of this table was rebuilt from the harness log
(`mission-salvage.mjs`) on the belief that the harness only writes its JSON at the end. It
writes incrementally, so `reports/system-mission/after-orchestration.json` had the real
rows all along — including two fields the log does not carry. The numbers below now come
from that file, and two of them changed materially:

- **Cache share did not collapse.** The salvaged rows showed `0.00` because the log has no
  cache split; the real figures are montage **0.99 → 0.99** (held), podcast **0.99 → 1.00**,
  dead-air **0.97**. The earlier draft refused to claim anything from the `0.00`, which was
  the right call — this is what it actually was.
- **"Runs that did not complete" was too generous.** The salvage assumed every turn the log
  printed had completed. Two had not: one montage run was **cancelled** at the harness's own
  1200s wall-clock cap (it still scored 1.00 with 30 operations), and the single dead-air run
  reported **failed** after landing 54 operations and scoring 0.75 — the bounded verify loop
  settling honestly on a finding it could not clear, which is the designed behaviour, not a
  crash.

## Per-scenario, before → after (p50 over 3 runs)

| scenario | model calls | prompt tokens | output tokens | cache | tool calls | repeats | ops | wall | USD | rubric | did not complete |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | 10 → 31 | 332k → 963k | 37.9k → 97.6k | 0.99 → 0.99 | 56 → 66 | 28 → 51 | **0 → 35** | 424s → 1070s | $0.57 → $1.52 | **0.25 → 1.00** | 2/3 → 1/3 (a cancel at the harness cap) |
| podcast-highlight-60s | **25 → 5** | **804k → 173k** | **101k → 21k** | 0.99 → 1.00 | **58 → 8** | **30 → 4** | 1 → 1 | **1200s → 253s** | **$1.54 → $0.32** | 1.00 → 1.00 | **3/3 → 0/3** |
| remove-dead-air | 1 → 7 | 0 → 180k | 0 → 62k | — → 0.97 | 0 → 59 | 0 → 53 | **0 → 54** | 0s → 584s | $0.00 → $0.94 | **0.25 → 0.75** | 3/3 → 1/1 (settled `failed` after editing) |
| beat-sync | — | — | — | — | — | — | — | — | — | 0.22 (baseline) | 3/3 (baseline) |
| refine-tighten t1/t2 | — | — | — | — | — | — | — | — | — | 0.25 / 0.50 (baseline) | 3/3 (baseline) |
| memory-captions t1/t2/t3 | — | — | — | — | — | — | — | — | — | 0.38 / 0.29 / 0.29 (baseline) | 3/3 (baseline) |

Every montage run scored **1.00** with 30–44 operations, including the cancelled one — the
cancellation is the harness's clock, not the edit's quality.

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
  **54 operations** and scores 0.75. It still reports `failed` — the bounded verify loop
  (ADR 0159) could not clear the last rubric finding (a mid-word cut) and settled honestly
  rather than claiming success. That is the designed behaviour; the fix is breath-padding
  tuning, not structure.

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
roughly $4–8 of traffic). Merge with `after-orchestration.json` and re-run
`mission-report.mjs` to replace the placeholder rows above.
