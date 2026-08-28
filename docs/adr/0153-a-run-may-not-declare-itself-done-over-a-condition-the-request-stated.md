# ADR 0153 — A run may not declare itself done over a condition the request stated

**Status:** accepted
**Date:** 2026-08-28
**Related:** ADR 0022 (the Critic's content report), ADR 0075 (task memory), ADR 0081
(causal completion), ADR 0144 (an edit that renders as nothing is refused), ADR 0148 (a
service shared with a panel must not assume a person)

## Context

Captured run `4c9b5f82` answered a 12,000-character brief for "approximately 61 hiking
photos" as a "20–35 second" Instagram montage. It placed a 36.107-second music bed and
**ten photos, covering 0 → 10.008 seconds**. Twenty-six seconds — 72% of the programme —
rendered as black with music playing.

It reported **`completed`**, with a deterministic self-check reading _"Passed with 1
warning(s)"_ and one perceptual finding: `edit_range_300: Unexpected black frame(s): 301,
302`.

Frame 300 is 10.0s: the final cut. Frames 301 and 302 are the first two frames past the end
of the picture. The reviewer's entire account of twenty-six seconds of nothing was two
frames, reported as a defect in a cut.

Every layer that could have caught this had a reason not to.

### The brief stated two checkable numbers and neither was read

`acceptance.ts` reads a shot floor from ordinary creator language. Its shot nouns were
`clips|shots|moments|cuts|scenes|segments|angles`. The brief said **photos**, forty times,
and named no other kind of material — so no floor was read, `checkShotCount` reported
`skipped`, and the self-diagnosing warning it emits instead was the run's one warning.

`explicitDurationTargetSeconds` requires a deliverable anchor near the number. The brief
said `**Duration:** Approximately 20–35 seconds` under a `# FORMAT` heading, with "video"
ninety characters upstream. Worse, the range itself was unreadable by construction: the
`endsARange` guard — which exists so `0.3–0.6s per clip` is not read as a 0.6-second
deliverable — refuses the far end, and in `20–35 seconds` only the far number carries a
unit. The near end was never matched. The range was dropped whole.

With no duration target and no shot count, the run's acceptance criteria were reduced to
"SFX cannot be sourced here" and "judge the rest by hand".

### No check asked whether picture covers the programme

`picture_present` (ADR 0144) exists for the run that shipped text on black. It asks whether
ANY picture exists, and ten clips satisfy it. `contentDuration` measures the latest clip
end **across audio too**, so the programme was 36.1 seconds by every measure the battery
had. Nothing compared the two.

### The one probe aimed at "is there a film here" asserted nothing

`planTemporalEvidenceForEdit` samples three representative frames: opening, midpoint,
ending. Here that was frames 0, 541 (18.0s) and 1083 (36.1s) — two of them solid black.
All three came back with `blackRatio` populated, and `issuesFor` evaluated `kind: 'frame'`
results **only for contract conformance**: did the acquirer return the frame that was asked
for. The black-frame assertion lived in `rangeIssues`, and ranges are planned only at edit
boundaries.

### The plan agreed, so nothing asked the request

The brief was decomposed into **one objective**. The first applied patch reconciled the
whole ledger. The model then emitted prose with no tool call, and `onTurnResult`'s
early-done guard asks exactly one question — is any plan step unfinished? — found none, and
went to verify. The run's own task memory at that moment read `"nextAction": "Continue
apply"`, `"remainingObjectives": 1`.

### And the review could not have helped

`reviewTurn` is read-only by design: findings reach the agent through the steering queue and
are repaired in an ordinary turn. A review of the LAST turn's edit settles after the agent
has stopped — here, twenty-six milliseconds after the run reported `completed`. It was
published, never steered on, and described in language ("your edits are applied and
validated, but they are not perceptually clean") that reads as a verdict the run stood
behind after trying.

## Decision

**1. Picture coverage is a first-class deterministic check.** `picture_coverage` walks the
picture spans against `contentDuration` and reports the uncovered ones. It fails when the
request wanted a visual deliverable, on the same `requestWantsPicture` derivation
`picture_present` uses, so an audio-only pass is never failed for having no picture. Gaps
under a second are a beat of black rather than a missing shot — the threshold `dead_air`
already uses. It is render-free, so unlike the perceptual reviewer it can be consulted
before a run is allowed to stop.

**2. A photo is a shot, and a stated range is a length.** Photos, images, pictures and
stills join the shot nouns; "use all N" joins the floor markers. A stated duration range is
read as an interval — midpoint as target, half-width as tolerance — so anything inside the
range passes and nothing outside it does, while the per-clip guard still removes pacing
figures whether written as one number or two.

**3. "Done" answers to the request, not only to the plan.** The runtime measures the
acceptance shortfall — the checks that actually FAIL — on the turn the model declares
itself finished, and the reducer spends the same bounded recovery turn the unfinished-plan
arm already uses, under the same `actionRecoveryPending` latch. The plan is the model's
account of the work; the shortfall is the request's, measured off the timeline, and unlike
prose it cannot be talked past.

**4. A representative frame asserts what it measures.** A frame request may carry the
`checks` it will be judged against, and the three representative probes carry
`black_frames`. The finding then names what it is — "Program midpoint is black (frame
541)" — instead of being inferred from two frames beside a cut.

**5. A finding the run never reached is reported as untried, not unfixed.** Two sentences,
because they say different things to the person reading them and only one is worth asking
about again.

## Consequences

- The captured run now fails three checks — `picture_coverage`, `shot_count`,
  `duration_target` — before the model's "done" is accepted, and buys one bounded turn to
  fix them. `packages/ai-sdk/src/critic.test.ts` asserts the whole chain, brief to verdict,
  and asserts that a cut which actually answers the brief still passes.
- The three recorded golden sessions gained a `picture_coverage` warning; none states a
  visual target, so none fails. Re-recorded in its own commit.
- The terminal run status is **unchanged**. ADR 0081's decision stands: a run that
  delivered what it committed to keeps its completion, and a perceptual observation does
  not undo that. What mattered here is now caught deterministically instead.
- Not changed: `onTurnResult`'s plan-step index sweep. It marks rows `index <=
planStepIndex` complete on an applied patch and reads like the same bug, but this run's
  ledger had exactly one row — narrowing it would have caught nothing here.
