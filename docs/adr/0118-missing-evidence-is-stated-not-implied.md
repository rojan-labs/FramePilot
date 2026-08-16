# 0118. Missing evidence is stated, not implied

- Status: Accepted
- Date: 2026-08-14

## Context

When a planned analysis fails, `recoverHostToolFailure` routes around it: the task is
downgraded to a non-fatal skip and the plan continues. ADR-era reasoning for that is sound
and still holds — one un-analysable asset (silent footage, an un-indexed clip) must not
discard the grade, the pacing and every other step of a long plan.

But `collectAnalysisBag` folds only results that completed. A routed-around analysis
therefore reached the edit proposer as _nothing at all_: not an empty beat grid, not a
reported gap — simply an absent key in a context blob.

A model handed a hole fills it. Asked for a 30-cut beat-synced montage with its beat
detection dead, the proposer emitted thirty-three cuts of exactly 0.625s each, walking the
assets in library order, and described it as synchronised to the music. Every layer below
behaved correctly: the calls validated, the patch applied, the diff was honest. The run
was wrong at the only level nobody was checking — whether the edit was based on anything.

The absence of evidence and the absence of a beat are indistinguishable when all you
receive is silence.

## Decision

`EditProposerInput` gains `evidenceGaps`: the analyses this plan asked for that returned
nothing, each with the reason. `collectEvidenceGaps` mirrors `collectAnalysisBag` — the bag
names what arrived, the gaps name what did not — and the plan driver passes them on any
`propose_edit` task.

They are rendered as their own line, not folded into the context JSON, and they carry the
consequence explicitly: you do not have this information, do not substitute regular
intervals or library order for it, make only the edits your evidence supports, and say
which part of the request you could not carry out.

Route-around stays. What changes is that it is no longer silent to the model that has to
work around it.

## Consequences

An edit built without the analysis it asked for now says so, in the proposer's own
reasoning, where the user reads it. That is a smaller edit and a truthful one, instead of a
complete-looking edit built on an invented grid.

This is a prompt-level guarantee, not a mechanical one: the model is told, and is expected
to comply. A mechanical guarantee — failing the objective outright when evidence it names
is missing — would need the objective to declare which analyses are load-bearing, which the
planner does not express today. That is the follow-up this ADR does not take: see
`plan/PLAN.md`.

The plan driver also logs `runProposeEdit → proposing with missing evidence` with the tool
names, so the condition is visible in a support log without reconstructing it from
timeouts.
