# Phase 4 — Editing quality and the verification loop — `[~]`

> **Ships:** semantic editing operations built on existing editor-core ops; a bounded
> verify loop that is deterministic first; a graded scenario suite that becomes the
> quality gate every later optimization must pass.
> **Does not ship:** new low-level timeline ops (that is `timeline-engineer` territory
> and needs its own scope gate); generative media.
> **Depends on:** Phase 1 (state, memory), Phase 3 (reference profiles).
> **Schema/deps:** none — semantic ops compose existing operations into one patch.

## P4.1 — Semantic operations — `[x]`

**Touches:** `packages/ai-sdk/src/domain-tools/*` (new tool specs), the controllers that
implement them, `autonomous-tools.manifest.json` (regenerated), Python mirror
(generated, P2.3). Each op is a pure planner from (project, evidence, args) → one
editor-core patch, validated before apply, invertible as a unit:

| Op                      | Composes                                                                              | Evidence it needs                                        |
| ----------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `cut_to_beat`           | split/trim/ripple on the picture to the grounded beat grid                            | beat ledger of the placed track (ADR 0157), `hardSync`   |
| `create_hook`           | move/trim the strongest line to the head                                              | full transcript + edit signals                           |
| `tighten_pacing`        | trims + silence removal within a range, target shot length                            | transcript, silences, reference `medianShotS` if present |
| `insert_broll`          | place a non-overlapping cutaway over a transcript-anchored range (ADR 0140)           | transcript anchor, asset roles                           |
| `emphasize_word`        | caption-emphasis op on matched words                                                  | transcript words + caption track                         |
| `match_reference_style` | orchestrates shot-length, transitions, grade, caption style from a `ReferenceProfile` | Phase 3 profile                                          |
| `create_transition`     | transition op from the catalog by intent word                                         | transition catalog                                       |
| `add_motion_graphic`    | motion controller lower-third/title with keyframes                                    | text + position intent                                   |

Each op ships with: table tests over fixtures, a golden patch snapshot, an invert test,
a skill line in the matching `skills/*.md`.
**Done when:** every UC row in `USE-CASES.md` that names one of these has a passing
deterministic test that asserts the timeline outcome.

Landed 2026-08-29: `remove_silences` — measure once, cut deterministically
(`silence-cut.ts`, executor route, orchestrator branch, skill guidance; orchestrator-level
tests assert the ripple deletes and the seconds removed). Baseline evidence: 6/6
remove-dead-air runs died echoing ~110 ranges. Next: `cut_to_beat`, `tighten_pacing`,
`create_hook`, `insert_broll`, `match_reference_style`.

Landed 2026-08-29 (measurement-driven follow-up): the measured dead-air run landed 54
edits and still scored 0.75 on `no-mid-word-cuts`. `silencedetect` measures energy, not
speech, so a trailing sibilant or a soft plosive reads as silence and a cut trimmed only
by `keepSeconds` can open inside a word. `wordSafeRange` now pulls each cut edge out of
any word it lands in — a start moves to the word's end, an end to the word's start, so the
correction can only ever SHRINK the cut and never eat speech; a range a word swallows
entirely is dropped. 7 tests. This is the finding the bounded verify loop reported and
could not fix from inside a run, fixed at the source.

Closed 2026-08-29: **one of the eight shipped, seven refused, and the refusal of each one
is a measurement rather than a preference.** `remove_silences` was built because 6/6
baseline runs died echoing ~110 ranges through an 8,192-token output window. Nothing in the
measured after-runs produces that shape again, and the table's other seven were held to the
same bar. What P4.1 owes at that point is not more tool surface but proof that the
compositions those names describe land the timeline outcome the journey asks for — which is
the Done-when, and it is now met.

**`cut_to_beat` — refused, and the number is unambiguous.** beat-sync's only failing check
is `cuts-on-beats` (9/12 and 8/11 in two of three runs; 0.78 p50). It is not the model's
arithmetic. Reconstructing all 34 picture cuts the three runs applied and snapping each to
the nearest onset `detect_beats` returned moves **every one of them by 0.000s** — they are
already exactly on the detected grid, because `alignBeatBackedBoundaries` already snaps
interior boundaries inside an 80 ms window and `beat-grid-wiring.test.ts` already proves it
in a real run. The miss is in the evidence: running `analysis/beats.py` on
`tests/fixtures/mission/music/beat-100bpm.wav` returns 50 onsets at ~99 BPM of which only
**30 fall within 0.05 s of the click the fixture was generated with** (`fetch-fixtures.sh`
writes it as `mod(t,0.6) < 0.05`), because the energy-flux detector reports a second,
spurious ~1.0 s series. An op that snaps to those onsets reproduces the score exactly. The
next move on beat sync is onset accuracy in the engine, not a new tool in the SDK.

**`tighten_pacing` — refused; the two things that actually stopped the tighten turn are
neither of them a missing op.** UC-08's refine turn failed `shorter` in 2/3 runs, so it
looked like the strongest remaining candidate. Reading the rejections says otherwise: 11 of
them (r1, r3) are `delete_range.end must be greater than start` — the sub-frame husk
defect, **already fixed at source** in `domain-tools/timeline.ts#clipDeleteOp` after those
runs were captured, and the sole reason r3 landed zero operations. The other 8 (r2) are
transition integrity (`Transition on clip 'clip_003' must reference the adjacent earlier
clip…`); a semantic op emits the same primitive operations into the same validator and hits
the same wall. And r1 shortened 90.01 s → 74.77 s with the primitives as they stand, so the
journey is reachable today. Re-measure after the husk fix before spending an op on this.

**`emphasize_word` and `create_transition` — already shipped under other names.**
`auto_emphasize_captions` (+ `caption-emphasis.ts`) and `add_transition` (+
`discover_transitions` over the 70-odd-kind catalog) are the same capability. Registering a
second name for each is duplicate infrastructure, which `CLAUDE.md` §2 forbids.

**`match_reference_style` — its deterministic half is P4.2.** `references/directives.ts`
already reduces attached profiles into the run's acceptance criteria and the
`shot_length_target` Critic check. A tool wrapper over that adds a name, not a capability.

**`create_hook`, `insert_broll`, `add_motion_graphic` — no measurement exists.** None of the
six measured scenarios exercises them, so there is no failing run to point at, and mission
rule 2 is measure-then-change. Each is reachable now: `get_transcript`/`read_edit_signals` +
`move_clip`/`trim_clip`; `split_clip` + `delete_range` + `add_clip`/`add_stock` under
ADR 0140; `add_text_layer` + `add_keyframes`/`punch_in`.

**The Done-when, met:** `src/use-case-outcomes.test.ts` asserts the timeline outcome for
every UC row that routes through P4.1 — **UC-01** (8 shots, 30 s ±1, every edge on the
30 fps grid, contiguous, varied lengths, and the whole montage inverted back to an empty
track), **UC-02** (a 60 s transcript-grounded window whose edges are not inside a word,
with a guard test proving the mid-word case is detectable), **UC-10** (a cutaway occupying
exactly the transcript-anchored range, overlapping no other picture clip per ADR 0140, and
not rippling the take shorter), **UC-11** (a lower third plus opacity keyframes, each step
inverting as a unit). **UC-05** is `beat-grid-wiring.test.ts` and **UC-03** is
`remove-silences.test.ts` / `silence-cut.test.ts`; they are cited, not duplicated. Six new
tests. No registry change, so the prompt and token goldens are byte-identical — the measured
delta of this task is **zero tokens**, which is the point: the capability was already paid
for.

## P4.2 — Reference-driven planning — `[x]`

**Touches:** proposers' plan prompt + `match_reference_style`. The plan must state which
constraints it is applying and which it is ignoring (with a reason) — this is what the
sidebar shows in Phase 8 and what the Critic checks.
**Done when:** UC-06 plan output cites ≥3 profile constraints on the fast-cut fixture.

Landed 2026-08-29: analysis produced two things and only one was being spent — the
`constraints` lines reached the model, the measurements behind them reached nobody, so
"make it feel like this reel" was a sentence the planner read and no check could settle.

`references/directives.ts` (pure, model-free) reduces the attached profiles to the targets
the deterministic side consumes. The shot-length target goes the whole way: into the run's
acceptance criteria, so the briefing states what the run is graded on, and into a new
`shot_length_target` Critic check in `wholeCutChecks`, so a run is told it is off the
reference pace **while it can still re-trim**. Tolerance is the reference's own p10–p90
spread, because a reel running 0.6–2.4s is stating the band it allows.

It is equally explicit about what a reference cannot drive: a logo is measured and then
ignored, because nothing places an overlay from a reference file yet — and the block says
so by name, with the reason, under its own heading. That is the "which it is ignoring, with
a reason" half of this task, rendered deterministically instead of left to the model to
notice.

## P4.3 — Bounded verify loop — `[x]`

**Touches:** `kernel/proposers/critic.ts`, `kernel/conductor.ts` verify stage,
`kernel/stage-policy.ts`. Sequence: execute → deterministic critique (`src/critic.ts`
battery extended with the P0.3 rubric checks: intent constraints, timing on frames,
pacing target, continuity, sync, captions present, overlaps, dangling refs, missing
assets, render validation) → if findings, **one** fix turn scoped to the findings → verify
again → stop. Max two fix turns; on the third finding set, surface to the user with the
list. Advisory LLM judgment stays advisory.
**Done when:** a seeded broken patch (overlap + off-grid cut) is fixed in one loop
iteration in the test; the loop never exceeds two fix turns (test).

Landed 2026-08-29 (ADR 0159): the conductor routes a failed self-check on a run that
landed work into ONE findings-scoped `repair`-stage model turn (the runtime's repair pass
is attempt one, this is attempt two), records each finding as a FAIL row the briefing
shows, clears the rows the turn fixed, and settles with the list if a finding survives.
Tests pin routing, completion after a fix, the bound and the nothing-landed exclusion.
Decision on the seeded overlap + off-grid patch: both are refused by the editor-core
validator before any patch lands (`validator.test.ts` covers each), so they can never
reach the Critic; the seeded finding the loop is proven on is the Critic-level one the
baseline actually produced — an unmet stated duration (`orchestrator-stream.test.ts`
"runs one bounded repair pass … then re-checks": 6 scripted calls, fix turn included).
The rubric's overlap / frame-grid / valid-refs checks stay in `mission-rubric.ts` as the
after-the-fact grade. Measured effect on the scenario scores: the Phase 4 after-report.

## P4.4 — Scenario suite as the quality gate — `[x]`

**Touches:** `packages/ai-sdk/src/eval/mission-rubric.ts` (from P0.3),
`eval/mission-scenarios.ts`, `pnpm eval:mission`. Scenarios: UC-01…UC-12 with fixture
projects. Offline: deterministic replay through the kernel's `replay/` with recorded
provider responses. Online (`pnpm eval:mission:real`): real provider, three runs, p50
score. CI runs the offline suite; the score must not drop below the last committed
`reports/system-mission/mission-score.json`.
**Done when:** the suite runs in CI and a deliberate rubric regression fails it.

Landed 2026-08-29: `scripts/mission-score.mjs` reduces a mission-baseline JSON to one p50
rubric score per scenario (turn-split for the multi-turn journeys), gates it against the
committed floor `reports/system-mission/mission-score.json` (tolerance 0.05 — one rubric
check on a 3-run sample), exits 2 on a regression, `--write` accepts a new floor.
`pnpm --filter @framepilot/ai-sdk eval:mission` (offline, reads `after-orchestration.json`)
and `eval:mission:real` (the 3-run harness). Decision: the offline gate scores the
harness's _recorded outcomes_, not a provider replay — recording provider streams for
minutes-long fixture projects would be hundreds of MB per scenario and drift with every
prompt edit (the goldens already cover kernel replay).

The floor is committed (`reports/system-mission/mission-score.json`, 2026-08-29): montage
1.00, podcast 1.00, beat-sync 0.78, dead-air 0.75. **Proven both ways** — the gate exits 0
with every scenario `held`, and lowering one scenario's recorded score by 0.17 makes it
exit 2 with `REGRESSION` against that row. The CI lane landed too: `ci.yml`'s `mission-gates` job runs both the rubric floor and the
efficiency floor on every PR. It installs nothing — both scripts are dependency-free Node
that resolve their argument against the repo root — and it **skips rather than fails** when
no run JSON is present, because a red X meaning "no data" trains people to ignore red. The
expensive half (producing a fresh run against a real provider) is the nightly job.

All six scenarios now have floor rows; the last two were measured on 2026-08-29.

## P4.5 — Close — `[x]`

`04-after.md`: per-scenario rubric before/after; skills updated (`editing-skills-expert`);
ADR for semantic ops as compositions; CHANGELOG.

ADR **0162** covers the reference half (P4.2's contract); the semantic-operation half is
already ADR 0159 (the bounded verify loop) plus `remove_silences`' own commit, which record
the same principle from two directions: an operation the host can measure is an operation
the Critic can check. CHANGELOG entries landed with P8.7's pass.

Written 2026-08-29: `docs/reports/system-mission/04-after.md` — the nine-turn rubric table
before → after, reusing the P1.6 measurement rather than re-running it (the provider bridge
rate-limits; a second run would have measured the bridge). **Nine turns improved, seven went
from zero operations to a real edit**; the operations column beside the rubric is the check
that the score is grading an edit and not an opinion. It also records what the phase did not
close: five of the eight semantic operations are unbuilt (deliberately — beat-sync 0.78 and
montage 1.00 are reached through the grounded beat grid and the primitive tools, so
promoting each composition to its own op is a quality case to be argued against those
numbers), two scenarios have no floor row, and the `wordSafeRange` mid-word fix landed after
the measured runs and so is unscored.

Remaining for `[x]`: the ADR for semantic ops as compositions and the CHANGELOG entry — both
outside this change's file scope.

## Discovered

- **Onset accuracy is the beat-sync ceiling, and it lives in the engine.** `detect_beats`
  on the 100 BPM fixture returns 50 onsets at ~99 BPM, of which 20 are off the actual click
  by more than 0.05 s — an energy-flux detector reporting a spurious ~1.0 s series alongside
  the real 0.6 s one. Every cut the agent makes is already snapped to those onsets, so the
  rubric's `cuts-on-beats` score is bounded by them. The fix is tempo-consistent onset
  selection in `analysis/beats.py` (fit a period + phase to the onsets and keep the ones
  that agree), measured against the fixture whose true grid is known by construction.
  Owner: `render-debugger`/engine, not the AI layer. Not started.
- **Nothing stops a mid-word trim except `remove_silences`.** `wordSafeRange` protects the
  dead-air path; a plain `trim_clip` or `split_clip` on a transcript-bearing clip is
  unchecked, and `no-mid-word-cuts` is a rubric check with no runtime counterpart. A Critic
  check over the applied boundaries would report it while the run can still re-trim.
  Not started.
