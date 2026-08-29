# Phase 4 — Editing quality and the verification loop: after

The rubric numbers below are not a second measurement. They are the same run —
`mission-baseline.mjs --runs 3` against the real desktop sidecar and the mission fixture
projects, scored by `eval/mission-rubric.ts` — reported in
`docs/reports/system-mission/01-after.md`, read here for what it says about *editing
quality* rather than about orchestration cost. Re-running it to get a Phase 4 column of its
own would have measured the provider, not the code: the auth2api bridge 429s after roughly
$4–8 of traffic, which is why 01-after's coverage is uneven per row and says so.

## The rubric, before → after

| scenario · turn | runs | **rubric** | operations | what moved it |
| --- | --- | --- | --- | --- |
| montage-30s | 3/3 | **0.25 → 1.00** | 0 → 35 | the run finishes and the montage exists |
| podcast-highlight-60s | 3/3 | 1.00 → 1.00 | 1 → 1 | already correct; got 4.7× faster |
| remove-dead-air | 2/3 | **0.25 → 0.75** | 0 → 54 | `remove_silences` (P4.1) |
| beat-sync | 3/3 | **0.22 → 0.78** | 0 → 34 | grounded beat grid + a run that survives |
| refine-tighten · t1 | 3/3 | **0.25 → 0.63** | 0 → 18 | — |
| refine-tighten · t2 | 3/3 | **0.50 → 0.88** | 0 → 4 | the refinement edits four things instead of rebuilding |
| memory-captions · t1 | 1/3 | **0.38 → 0.63** | 0 → 7 | — |
| memory-captions · t2 | 1/3 | **0.29 → 0.71** | 0 → 83 | the captions work landed |
| memory-captions · t3 | 1/3 | 0.29 → 0.43 | 0 → 0 | carrying the decision to a third turn did not |

Nine turns, nine improvements, and **seven went from zero operations to a real edit**.
Coverage is per row and uneven: montage, podcast, beat-sync and refine-tighten have all
three runs; remove-dead-air has two; **memory-captions has one**, so its three rows are
single observations, not p50s.

## What the rubric column is actually saying

**The baseline was cheap because it was failing.** Two of the three measured baseline
scenarios landed zero operations, and every baseline row carries a `did not complete`
count. A run that dies at call 10 with an empty timeline is inexpensive; reading Phase 4's
result off tokens or wall-clock would have inverted it. The rubric is the column to read,
and the operations column beside it is the check that the rubric is scoring an edit rather
than an opinion.

## The semantic operations (P4.1) — one shipped, five not

`remove_silences` is the one that landed as a real end-to-end capability, and its evidence
is a scenario that could not previously produce an edit at all. The baseline could not
survive echoing ~110 measured silence ranges back through an 8,192-token output window: one
call, zero operations, three of three runs unfinished. Measuring once in the host and
turning the ranges into ripple deletes in the orchestrator, the same request lands **54
operations** and scores **0.75**.

It still reports `failed`, and that is the designed behaviour rather than a shortfall: the
bounded verify loop could not clear the last rubric finding — a cut opening inside a spoken
word — and settled honestly instead of claiming success. The finding was then fixed at
source rather than in the loop: `silencedetect` measures energy, not speech, so a trailing
sibilant reads as silence and a cut trimmed only by `keepSeconds` can open mid-word.
`wordSafeRange` pulls each cut edge out of any word it lands in — a start moves to the
word's end, an end to the word's start — so the correction can only ever SHRINK a cut and
never eat speech. That fix is not in the table above: it landed after the measured runs, and
claiming its effect without a re-run would be exactly the kind of unearned credit the rubric
exists to prevent.

`cut_to_beat`, `tighten_pacing`, `create_hook`, `insert_broll` and `match_reference_style`
are **not built** as named semantic operations. Beat-sync scores 0.78 and montage 1.00
without them, through the grounded beat grid (ADR 0157) and the primitive tool surface, so
the case for promoting each composition to its own op is a quality case that has to be made
against these numbers — not a completeness argument. P4.1 stays `[~]`.

## Reference-driven planning (P4.2) and the verify loop (P4.3)

Both are closed, and both are deterministic rather than model-mediated, which is why
neither needed its own row above.

- **P4.2** — analysis produced two things and only one was being spent: the `constraints`
  lines reached the model and the measurements behind them reached nobody, so "make it feel
  like this reel" was a sentence the planner read and no check could settle.
  `references/directives.ts` reduces attached profiles to targets the deterministic side
  consumes; the shot-length target goes into the run's acceptance criteria *and* into a
  `shot_length_target` Critic check, so a run is told it is off the reference pace while it
  can still re-trim. Tolerance is the reference's own p10–p90 spread. What a reference
  cannot drive is named with the reason: a logo is measured and then ignored, because
  nothing places an overlay from a reference file yet.
- **P4.3** (ADR 0159) — a failed self-check on a run that landed work routes into **one**
  findings-scoped repair turn, records each finding as a FAIL row the briefing shows, clears
  the rows the turn fixed, and settles with the list if a finding survives. The seeded
  overlap + off-grid patch the task named cannot be used as the proof: both are refused by
  the editor-core validator before any patch lands, so they never reach the Critic. The
  finding the loop is proven on is the one the baseline actually produced — an unmet stated
  duration.

## The quality gate (P4.4)

`scripts/mission-score.mjs` reduces a mission-baseline JSON to one p50 rubric score per
scenario and gates it against the committed floor, exiting 2 on a regression. **Proven both
ways**: the gate exits 0 with every scenario `held`, and lowering one scenario's recorded
score by 0.17 makes it exit 2 with `REGRESSION` against that row.

The floor committed 2026-08-29 (`reports/system-mission/mission-score.json`): montage
**1.00**, podcast **1.00**, beat-sync **0.78**, dead-air **0.75**.

The offline lane scores the harness's recorded outcomes, not a provider replay. Recording
provider streams for minutes-long fixture projects would be hundreds of MB per scenario and
would drift with every prompt edit; the goldens already cover kernel replay. Remaining: the
CI lane that runs it (P9.3), and floor rows for the two scenarios the rate limit still
blocks.

## What this phase did not close

- **Two scenarios have no floor row** — memory-captions and refine-tighten — because the
  provider rate limit blocked the runs that would produce one. memory-captions is also the
  weakest row in the table and the most honest: one run, and its third turn scored 0.43
  having applied nothing. Carrying a decision to a third turn is a real gap, not a
  measurement artefact.
- **Five of the eight semantic operations are unbuilt**, deliberately (above).
- **The `wordSafeRange` fix is unmeasured** against the rubric. The dead-air row's 0.75 is
  the score *before* it, and the finding it fixes is the one that kept the score there.
