# Phase 1 — Orchestration and context: after

Same fixtures, same harness, same rubric as `00-baseline.md` (P0.2/P0.3):
`mission-baseline.mjs --runs 3` against the real desktop sidecar and the mission fixture
projects, scored by `eval/mission-rubric.ts`.

## Status of this measurement

**All six scenarios now have after-numbers.** They took three attempts: the auth2api
bridge 429s after roughly $4–8 of traffic, so each attempt cleared a few scenarios before
hitting the wall, and the next resumed with `--only` on what was still missing. Coverage is
uneven and the table says so per row: montage, podcast, beat-sync and refine-tighten have
all three runs; remove-dead-air has two; **memory-captions has one**, so its numbers are a
single observation, not a p50.

Turns where the provider answered nothing (`calls=1, prompt=0, ops=0`) are excluded from
the merge rather than averaged in — that is the signature of a dead bridge, not of a run
doing badly, and folding it into a median would understate the code by describing the
provider.

## Per-scenario, before → after (p50 over the runs that completed)

| scenario · turn | runs | model calls | prompt tokens | cache | ops | wall | USD | **rubric** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| montage-30s | 3/3 | 10 → 31 | 332k → 963k | 0.99 → 0.99 | **0 → 35** | 424s → 1070s | $0.57 → $1.52 | **0.25 → 1.00** |
| podcast-highlight-60s | 3/3 | **25 → 5** | **804k → 173k** | 0.99 → 1.00 | 1 → 1 | **1200s → 253s** | **$1.54 → $0.32** | 1.00 → 1.00 |
| remove-dead-air | 2/3 | 1 → 6 | 0 → 109k | — → 0.95 | **0 → 54** | 0s → 584s | $0.00 → $0.81 | **0.25 → 0.75** |
| beat-sync | 3/3 | 1 → 18 | 0 → 497k | — → 0.98 | **0 → 34** | 0s → 882s | $0.00 → $1.37 | **0.22 → 0.78** |
| refine-tighten · t1 | 3/3 | 1 → 18 | 0 → 516k | — → 0.98 | **0 → 18** | 0s → 655s | $0.00 → $0.88 | **0.25 → 0.63** |
| refine-tighten · t2 | 3/3 | 1 → 12 | 0 → 321k | — → 0.99 | 0 → 4 | 0s → 623s | $0.00 → $0.97 | **0.50 → 0.88** |
| memory-captions · t1 | 1/3 | 1 → 10 | 0 → 289k | — → 0.87 | 0 → 7 | 0s → 270s | $0.00 → $0.47 | **0.38 → 0.63** |
| memory-captions · t2 | 1/3 | 1 → 61 | 0 → 1.91M | — → 0.98 | **0 → 83** | 0s → 1192s | $0.00 → $1.74 | **0.29 → 0.71** |
| memory-captions · t3 | 1/3 | 1 → 2 | 0 → 0 | — | 0 → 0 | 0s → 72s | $0.00 → $0.00 | 0.29 → 0.43 |

**Every scenario improved, and seven of nine turns went from zero operations to a real
edit.** Prompt-cache share held throughout (0.87–1.00): none of this was bought by giving
up cache.

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

- **montage-30s costs more and is finally correct.** 0 → 35 operations, 0.25 → 1.00 on all
  three runs. The extra calls and tokens buy a montage that exists. Whether 31 calls is the
  right price is Phase 5's question, not this one — the measurement to beat is now a
  *succeeding* run.
- **beat-sync and refine-tighten close the same way.** beat-sync 0.22 → 0.78 with 34
  operations; refine-tighten's *second* turn — the refinement itself, which is what P1.4 is
  about — 0.50 → 0.88 while touching only 4 operations. A refinement that edits four things
  instead of rebuilding the cut is the behaviour that task was asking for.
- **memory-captions is the weakest row and the most honest one.** One run, and its third
  turn scored 0.43 having applied nothing. The captions work landed (turn 2: 83 operations,
  0.29 → 0.71); carrying the decision to a third turn did not. That is a real gap, not a
  measurement artefact, and it is what P1.5's remaining work is for.

## Where the remaining cost is

Repeated tool calls are still high (montage 51 of 66). The stage-scoped tool set and the
action-log window are the levers, and both sit in Phase 5. Nothing in this phase attacked
repetition directly, and the numbers say so.

## Reproducing this

```
cd packages/ai-sdk
node scripts/mission-baseline.mjs --runs 3 --label after \
  --only <scenarios> \
  --dump-events reports/system-mission/runs \
  --out reports/system-mission/after-orchestration.json
node scripts/mission-report.mjs \
  reports/system-mission/baseline-orchestration.json \
  reports/system-mission/after-orchestration-merged.json
```

All three mission scripts resolve their path arguments against the **repository root**,
not the working directory. Passing `../../reports/...` from `packages/ai-sdk` writes
outside the repo entirely — which is how one attempt's results ended up in `~/reports`.

Still worth a fuller run: memory-captions at three runs rather than one, and
remove-dead-air's third.
