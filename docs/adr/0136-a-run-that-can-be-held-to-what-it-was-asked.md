# ADR 0136 — A run that can be held to what it was asked

**Status:** accepted
**Date:** 2026-08-22
**Closes:** the self-misreporting a captured agent run (`run.md`) demonstrated across all five
of its turns.

## Context

One run, twenty-eight minutes, five turns, and at the end the editor's timeline was unchanged.
Reading its own record back, four separate mechanisms were reporting things that were not true:

1. **The objective was a copy of the request.** `setObjective` had exactly one caller — the
   deterministic seed in `onCommand` — so `objective.provisional`'s documented promise to
   "yield to the first real interpretation" had no producer. The outcome, the single acceptance
   criterion, the committed decision and the criterion verification reported against were all
   the same sentence the editor typed. A request for "at least of 20+ different best moments"
   was therefore satisfied, as far as the ledger knew, by an eight-shot timeline.
2. **A failed verification was filed with a passing detail.** The `detail` arm looked only at
   `planReconciled`, so a run that failed for "no traceable mutation" was recorded as
   `{ passed: false, detail: "Passed with 1 warning(s)." }`.
3. **Perceptual findings were re-steered without bound.** The same unfixable defect (ADR 0135's
   black frames) was pushed at the agent on three separate turns and re-filed four times.
4. **A clean deterministic self-check was reported as a clean run.** "Self-check: All checks
   passed" reached the editor while the run's own perceptual review still held an unresolved
   finding, published moments later.

Two more mechanisms turned provider failures into lost runs: an empty completion and a reply
the provider cut off mid-clause both land *after* a 200, where `ResilientProvider` — which
replays a stream only before its first chunk — cannot see them. The first failed a whole run
the UI had labelled "Retryable: true"; the second ended the run on the words "Rebuilding the
30 seconds as a 23-shot" and published that fragment as its final message.

## Decision

Each mechanism reports what actually happened.

- **Acceptance criteria are read from the request** (`acceptance.ts`): a stated deliverable
  length and a stated minimum shot count, recorded on the objective *and* fed to the Critic,
  which gains a `shot_count` check. One reading, so the criterion the ledger reports against
  and the check that settles it cannot be two different things. Extraction is deliberately
  narrow — the number must sit next to a shot noun, a duration cannot be mistaken for a count —
  because a wrong criterion fails a run that did the work, which is worse than a missing one.
- **Taste is not extracted.** "Make it nice", "attractive", "beat synced", "retaining watchers"
  are real parts of the request and they belong to the model's judgement. A mechanical proxy for
  them would pass or fail runs on a measurement nobody asked for. The request stays the last
  acceptance criterion always — it is the part no check settles — and `provisional` still marks
  a reading with nothing checkable in it.
- **One failure reason, two consumers.** The verification record's `detail` and the blocking
  diagnostic are derived from the same function, so they cannot disagree.
- **One steering attempt per defect class.** A finding is still published — the editor must see
  it — but after one correction attempt it stops buying turns, and the run says plainly that it
  is not retrying. The class deliberately ignores the numbers in a finding's wording, so "black
  frames at 90, 91, 92" and "black frames at 300" count as one cause rather than two.
- **The completion account is amended** when findings remain unresolved at the end, and the
  deterministic notice now says "Deterministic self-check" rather than implying the perceptual
  checks passed too.
- **A dropped or cut-off step retries once, in place**, with its own assistant segment so a
  retry cannot overwrite the attempt it replaces. Truncation is taken from the provider's own
  stop reason (`finish_reason: 'length'` / `stop_reason: 'max_tokens'`), plumbed through
  `ProviderChunk`'s `done` chunk: judging the prose instead would retry finished two-word
  answers ("all done") and still miss a fragment that ends on a period. A truncated reply after
  work has landed, or at `verify`/`complete`, is left alone — the edits are the deliverable and
  a finished run is allowed to end on prose.

## Consequences

A run can now fail for a reason the editor can read, and can no longer claim a request was met
because *something* was applied. The shot-count check is the first acceptance condition the
Critic can settle that came from the request rather than from a caller-supplied option, so a
montage that under-delivers is caught where a duration miss already was.

**Evidence.** `acceptance.test.ts` (extraction, including the captured run's own words and the
"30 second video" false positive it must refuse), `critic.test.ts` (an eight-shot timeline
fails a twenty-shot request and passes an eight-shot one), `conductor.test.ts` (criteria
recorded, `provisional` cleared only when something is checkable), `review-findings.test.ts`
(one steering attempt per class; a genuinely different defect still steers),
`orchestrator-stream.test.ts` (a dropped step retried and used; two empties fail honestly; a
provider-reported truncation never becomes the run's last word; a truncated reply after an edit
is left alone). 3157 ai-sdk tests pass.

## Limitations

Only two acceptance conditions are read today. Aspect ratio and platform are already carried as
caller-supplied options and were not folded in; nothing reads "vertical" or "instagram story"
out of a request yet.

The steering cap is a run-level count, not a per-project memory: a later run can steer the same
defect class once again. That is deliberate — a new run may be working on different material —
but it means a persistently unfixable defect is re-attempted once per run until the underlying
cause is fixed.
