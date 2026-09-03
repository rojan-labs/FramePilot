# Orchestration — no silent successes

> **Sub-plan of [`plan/PLAN.md`](./PLAN.md).** Branch: `fix/orchestration-silent-success`.
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
> **Last updated:** 2026-09-03
> **Anchored on run `9835620c`** (conversation `bc8ebce8`, 2026-09-03 08:21–08:42,
> `openrouter/auto`, agent mode, 20.9 min, 13 model calls, 443,709 tokens, $4.06).

## Why

A one-shot compound brief — twenty-three distinct asks over a 9:36 single-take GoPro
source — produced five satisfied asks, an eighteen-second hole in a sixty-second
programme, a completion message narrating four moments that are not in the timeline, and
a final status of `completed`.

The run's own state is where the cause is legible:

```json
"objectives":    [{ "id": "objective_1", "description": "<truncated copy of the request>",
                    "stage": "verify", "status": "satisfied" }],
"verifications": [{ "id": "verify_1",   "criterion": "<the same truncated text>",
                    "passed": true, "detail": "Passed with 2 warning(s)." }],
"acceptance":    [{ "id": "criterion_1", "description": "Everything else the request asks
                    for — taste, pacing, structure — which no automatic check settles." }],
"stage": "complete", "integrity": { "status": "valid" }
```

**The brief was never decomposed.** Twenty-three asks collapsed into one objective whose
description is a truncation of the raw request, verified against a criterion that is the
same truncated text, and passed. Nothing in the run's structure could notice that
`detect_beats`, `measure_color`, `set_clip_speed`, `punch_in`, `add_transition`,
`add_text_layer`, `render_preview`, `export_video`, `professional_edit` and `adjust_audio`
were never called — all in domains `load_tools` had successfully pinned.

## The thesis

FramePilot **detected** most of this while the run was still alive, and reported every
detection as prose appended to a success message:

| Detection | Where | What it did |
| --- | --- | --- |
| Selection not grounded in content | `orchestrator.ts:9145` | appended "Heads up: …" to the success summary |
| 14.833s of the programme has no picture | `critic.ts` | notice, after the commit was reported |
| Perceptual review found black frames | `orchestrator.ts:7093` | warning: "came back after the run had finished, so nothing was done about it" |
| Review batch unbuildable (422) | `temporal-review.ts` | warning: "were not perceptually checked" |
| Music provider rejected the request | `add_music` | correct, actionable error — then never surfaced to the editor |

The gap is not detection. **It is that no detection is load-bearing.** The code comment at
`orchestrator.ts:7060` shows the pattern directly: a previous run (`4c9b5f82`) hit the same
late-review problem and the response was better wording, not different timing.

This sub-plan converts detections into gates and gives the run a checklist it can be held
to. It adds no new subsystem.

## Scope gate

- **User outcome:** when FramePilot says it finished, it finished — and when it did not, it
  says exactly what it did not reach. No black programmes, no narrated edits that were
  never made.
- **Current gap:** a compound brief passes verification against a paraphrase of itself; the
  run reports `completed` with 18/23 asks unattempted and a quarter of the output black.
- **Minimum vertical slice:** one golden case that reproduces run `9835620c`, then the
  smallest change per defect that turns each existing detection into a blocking condition.
- **Reuse:** the golden-eval harness already on `feat/golden-eval-harness`
  (`src/eval/golden-cases.ts`, `golden-metrics.ts`, `scripts/golden-gate.mjs`,
  `pnpm eval:golden`), the existing critic/verify stages, `ConductorConfig` budgets,
  `MAX_PINNED_SKILLS`, the novelty guard. No new runtime, store, or provider layer.
- **Deferred scope:** model quality and prompt tuning; any orchestration-framework
  migration (settled — see ADR 0110); deeper tracking/colour capability; a second
  sequence model for aspect variants beyond the disclosure in SS-9.
- **Evidence:** every task lands red-then-green on the golden case, plus the ten tracked
  metrics from `golden-metrics.ts`. Real-media effect is **pending manual verification**
  per `goal.md` until the maintainer runs it.

## What "zero issues" means here

Zero defects is not an achievable acceptance criterion for a layer with a language model in
it — the model will sometimes choose badly, and no amount of orchestration prevents that.
`goal.md` already states the achievable form, and it is the bar this sub-plan is measured
against:

> Zero incorrect silent successes — the agent never reports a completed edit that did not
> happen or happened wrongly.

Restated as the invariant every task below serves: **a defect must block, degrade visibly,
or be named in the result. It may never be appended as prose to a success.** A run that
does half the brief and says so is a pass. A run that does half the brief and reports
`completed` is a release blocker.

## Tasks

- `[ ]` **SS-0 — the run becomes a golden case.** Gates every task below. Add
  `compound-brief-long-take` to `src/eval/golden-cases.ts`: a multi-clause brief over a
  long single-take source, with checkable assertions for (a) no uncovered span in the
  committed programme, (b) every source moment named in the summary is covered by a clip,
  (c) unattempted acceptance items are enumerated in the result. **The case must fail
  today on all three.** Evidence: red before any fix, with the failing assertions recorded
  in `reports/golden/`; green after SS-1…SS-4.

- `[ ]` **SS-1 — decompose the brief into falsifiable items.** *Root cause.* Objective
  interpretation emits one acceptance item per distinct ask, each carrying either a
  checkable predicate or an explicit `judgement: true` marker. A catch-all item may exist;
  it may not be the only item when the request contains multiple imperative clauses.
  Evidence: run `9835620c`'s brief yields ≥18 items; a single-clause request still yields
  one; assertion on both in the golden case.

- `[ ]` **SS-2 — no success with unattempted items.** Every acceptance item terminates as
  `done | attempted-failed | not-attempted`. `verify_*.passed` cannot be true while any
  item is `not-attempted`, and the completion message renders the not-attempted list
  verbatim. Anchors: `kernel/conductor.ts` verify stage, `orchestrator.ts` summary
  assembly. Evidence: the golden case's result names all unattempted asks, and final
  status is not `completed`.

- `[ ]` **SS-3 — narration is reconciled against the timeline.** Source timecodes asserted
  in a proposal or completion summary must be covered by a committed clip; an unbacked
  claim is struck and replaced with what was actually placed. Anchor: `orchestrator.ts`
  `summarizeApplied` (~9120–9160) and the proposal summary path. Evidence: a summary
  claiming source `460s` cannot ship when no clip covers it — asserted directly.

- `[ ]` **SS-4 — detections become gates.** Three conversions, smallest form each:
  - `contentEvidence === false` with ≥ `UNEVIDENCED_SHOT_CAVEAT_THRESHOLD` shots
    (`orchestrator.ts:9145`) blocks the commit; the run calls a footage tool or `ask_user`
    instead of appending a caveat.
  - an uncovered programme span (`critic.ts` picture coverage) fails validation **before**
    the commit is reported, not after it.
  - a run does not settle until its own perceptual review has settled; if the review
    cannot land in time it reports `incomplete`, never `completed`
    (`orchestrator.ts:7093`, `:7106`).
  Evidence: the black-frame case cannot reach `completed`.

- `[ ]` **SS-5 — the deadline measures work, not latency.** In run `9835620c`, ten model
  calls account for 1,124s of a 1,254s run; every tool executed in single-digit
  milliseconds. The 20-minute bound (`conductor.ts:333` `maxWallMsFor`, `:1219`
  `budgetExhausted`, `reliability/deadline.ts`) is therefore an inference-latency budget.
  Keep wall-clock as a hard safety wall; make steps plus committed progress the operative
  bound, and report latency rather than charging it against the editor's brief. Pin the
  agent model — `openrouter/auto` defeats prompt caching and cost $0.31/call here.
  Evidence: `golden-metrics.ts` tokens+USD per accepted edit and latency p50/p95, before
  and after.

- `[ ]` **SS-6 — guards may not interlock into a dead end.** The novelty guard withheld
  `search_music` ("place what this run already found") minutes before `add_music`
  established that nothing could be placed — a credentials failure. Two fixes: sourcing
  credentials are preflighted at `load_tools`/search time so a dead provider fails before
  the model plans around it; and a guard may not withhold a tool whose alternative path
  has already hard-failed this run. Evidence: a credential-less sourcing run reports the
  provider failure to the editor and does not consume turns.

- `[ ]` **SS-7 — the skill budget is spent on demand.** Eight playbooks were pinned
  speculatively before any footage was read; the ninth — `titles-and-text`, for the title
  the brief asked for — was refused at `MAX_PINNED_SKILLS` (`orchestrator.ts:512`, message
  at `:4702`) and no title was ever made. Make the refusal offer eviction: the model may
  drop its least-used playbook to load the one the work needs. Evidence: a brief needing
  nine playbooks still produces the title.

- `[ ]` **SS-8 — the reviewer's requests must be valid.** `Request 'representative_0_0'
  reaches frame 0, but the timeline ends at frame 0` — a 422 on a batch the reviewer built
  itself. Guard empty and unresolved timelines in the `temporal-review.ts` request builder;
  an unbuildable review blocks the run rather than emitting "were not perceptually
  checked". Evidence: unit coverage for zero-length and unresolved timelines.

- `[ ]` **SS-9 — an ungrounded reframe says so.** All six clips carried an identical crop
  (`x 0.341797, width 0.316406` — dead-centre 9:16 of a 640px frame) applied to the master,
  against a brief that ruled out centre-cutting. Minimum slice: a reframe with no subject
  signal is disclosed as a centre crop, and is not applied destructively to the only
  sequence. Evidence: the golden case asserts either per-shot framing or the disclosure,
  and asserts the master survives.

## Order

SS-0 first and alone — nothing else may land without a failing case. Then SS-1 → SS-2 →
SS-3 → SS-4 as one vertical slice, because together they are the "no silent success"
invariant and each is weak without the others. SS-5 next; it is the root of the truncation
and is independently measurable. SS-6, SS-7, SS-8, SS-9 are independent and may land in
any order.

## Release gate mapping (`goal.md`)

| `goal.md` bar | Served by |
| --- | --- |
| Zero incorrect silent successes | SS-1, SS-2, SS-3, SS-4 |
| Every applied edit fully reversible | unchanged; asserted by the golden case |
| Preview and export agree | SS-4 (picture coverage), SS-9 |
| Cost and latency inside budget at p95 | SS-5 |
| Every failure mode recovers or explains | SS-6, SS-7, SS-8 |
| First-pass acceptance clears the bar | measured by SS-0, not asserted by it |

## Not in scope

Prompt and model-quality work; any orchestration-framework migration; new tool domains;
deeper tracking, colour or reframe capability; a second-sequence model for aspect variants.
Each is a separate decision, and none is required to stop a run from reporting a completed
edit it did not make.
