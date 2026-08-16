# 0120. An uncleared gate releases the work it could not clear

- Status: Accepted
- Date: 2026-08-14

## Context

An editing run stages its diffs and holds them until the perceptual gate clears them.
Four exits left that gate without clearing:

1. the reviewer was unreachable,
2. review found a repairable issue and the one bounded repair produced no patch,
3. review still failed after the repair, or the failure was never repairable,
4. semantic vision review failed.

Three of the four `return`ed with the staged diffs still in hand, destroying them. Only
(1) had been fixed, in isolation, and its reasoning — "an unreachable reviewer is not a
verdict on the edit" — was written as if it were a special case.

A desktop session made the cost concrete. The run classified the request, parsed intent,
planned five steps, mapped 34 chapters, detected 51 beats, proposed four edits, validated
them, and applied them: three transitions and a colour grade. Review found a real issue,
the bounded repair returned zero operations, and exit (2) fired. The user was left with
"Temporal repair did not produce a valid patch." and a Retry button. Two minutes of work,
four validated edits, and the concrete finding itself — all discarded, and none of it
visible.

The gate exists to stop an edit being presented as _checked_. It was instead being used to
decide whether the edit gets to exist.

## Decision

The three temporal exits share `releaseUnreviewedDiffs`. The staged diffs are emitted marked
`unverified` — which `DiffEvent` already defines as "a human-review proposal that must
never enter an auto-commit path" — preceded by a warning that names what happened: the
engine could not be reached, or review found _this_, or the repair could not fix _this_.

The run's terminal status is unchanged: it still fails. Nothing is presented as verified.

What differs between "could not check" and "checked, and this looks wrong" is how much the
user is told, not whether the work survives. So the helper takes the explanation from its
caller and the disposition stays constant.

Cancellation is the one exit that still releases nothing: the user withdrew the question,
so answering it would be wrong.

The two **vision** exits (4) deliberately stay fail-closed for now. A cloud vision review
that lacks media-egress consent refuses to run and surfaces as an ordinary
`passed === false`, indistinguishable at the call site from a genuine adverse verdict —
so releasing there would quietly reverse a privacy default rather than recover work. The
distinction exists in the report (a refusal produces `unverified` checks, a verdict
produces `fail` ones) and making the exit read it is the follow-up; see `plan/PLAN.md`
VISIONGATE. Until then vision keeps the old behaviour, and this ADR's principle is applied
only where the two cases are already distinguishable.

## Consequences

The safety property is intact and mechanically enforced elsewhere:
`shouldAutoCommitAiDiff` (`apps/desktop/electron/ai/patch-settlement.ts`) returns true only
for `verification === 'verified'`, so a released-but-uncleared diff cannot auto-commit even
under `auto_commit` policy. The person accepts or rejects it, with the finding in front of
them.

This reverses a previously deliberate expectation —
`editor-run-adapter.test.ts`'s "stops after one unsuccessful repair and **releases no
staged patch**". That test encoded destroy-on-uncleared as the intent; it now encodes
release-marked-unverified, with the reasoning inline so the reversal is not silently
re-reverted.

The risk accepted: a user can now accept an edit that review flagged. That is the correct
place for the decision — they are told what was found, in the same card as the diff — and
it is strictly better than the alternative the old behaviour actually produced, which was
not "the bad edit is prevented" but "all the edits, good and bad, are deleted and the
finding is thrown away with them".

Not addressed here: why the bounded repair produced no operations against 42 offered tools,
and whether the finding that triggered it was a true positive. Both need a repair eval
against recorded findings rather than a prompt change on a hunch. See `plan/PLAN.md`.
