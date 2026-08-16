# 0122. Review reads, it does not gate

- Status: Accepted
- Date: 2026-08-15
- Amends: [0119](0119-the-evidence-batch-ceiling-is-a-time-budget.md),
  [0120](0120-an-uncleared-gate-releases-the-work-it-could-not-clear.md),
  [0121](0121-compiled-compositions-are-borrowed-not-rebuilt.md)

## Context

An AI edit did not reach the timeline until a perceptual review had rendered real frames
and audio through the Python sidecar. The cost is documented in this repository's own
budgets, not estimated:

- `validation/temporal_evidence.py` — ~313ms per sampled frame, 3 MoviePy compiles, worst
  case **~224s**.
- `temporal-evidence-client.ts` — a *default* 48-request plan on a real sequence is
  **~134s**; the client timeout is **300s**.
- ADR 0121 — compile is ~0.8s/clip and the cache is keyed on project *content*, so an
  edited timeline is always a fresh miss (~30s on a 37-clip sequence).

`streamEditorRun` staged every valid diff and withheld it until that review cleared, and
`shouldAutoCommitAiDiff` then refused to commit anything not stamped `verified`. So the
"Auto" apply mode was not auto: on a multi-turn run the timeline showed nothing for 30s–4
minutes, then every turn's work landed at once.

ADR 0120 had already found half of this: *"The gate exists to stop an edit being presented
as checked. It was instead being used to decide whether the edit gets to exist."* It fixed
what happened to work an uncleared gate would otherwise destroy. It did not change **when**
the work appears.

### The root cause is that review could write

Review was not a reader. On a repairable finding it called back into `streamEdit`, took the
resulting patch and applied it. The run therefore had **two writers** — the turn loop and
the review's repair pass. Two writers over one project force serialization, and every
ordering question in the old design descended from that one fact: turn N+1 could not safely
start until review N had finished writing.

## Decision

**One writer.** The agent turn loop is the only thing that mutates the project. Review is a
pure reader that emits a *finding*: text, plus the revision and clip/track ids it was
computed against. A finding enters the agent's context through the existing steering queue —
the same channel a human's mid-run interjection uses — and the agent repairs it in an
ordinary turn, serialized like every other turn.

With review unable to write, turn N+1 never waits for review N, because there is nothing to
collide with. Review runs pipelined alongside the next turn and costs ~0 wall-clock.

Consequences that follow:

- Diffs are emitted and committed the moment they validate. Validation
  (`assembleEdit` → `validatePatch` → revision check) is pure, in-memory and
  sub-millisecond; it stays exactly where it was, in front of every apply.
- `shouldAutoCommitAiDiff` no longer requires `verification === 'verified'`.
- A run whose review fails now **completes** with a finding attached, rather than failing.
  The edit applied and validated; a perceptual complaint about it is a quality observation,
  not grounds for calling the user's work a failed run.
- A finding is dropped when a later turn rewrote the region it names — that region no longer
  exists as described, so acting on the finding would send the agent to fix something that
  is not there. Only a finding that was actually *delivered* to the agent can be marked
  resolved; crediting the run with a repair it never knew to make would overstate what it did.
- An unreachable reviewer neither fails the run nor lets it claim the work was checked. It
  says which of the two happened.

### There is no manual path

Auto is the only mode. Accept/Reject, "Apply all", the keep-a-subset preview and the
apply-mode dropdown are removed.

The diff-card model is borrowed from code assistants, where it works because code is text: a
diff is legible at a glance and a bad apply breaks the build. Video is not text. "Added 3
clips, trimmed 2" says nothing about whether the edit is *good*; the only real evaluation is
watching it. The card was therefore a worse version of what the user was about to do anyway
— apply it and scrub.

Manual review would earn its place for irreversible operations (there are none: every
operation has an `invert`, a core invariant), expensive ones (render/export, already a
separate explicit action), or ones reaching outside the project (already sandbox-gated,
separately). None applies.

## Consequences

The safety property is unchanged in substance and enforced where it belongs: nothing invalid
commits, every commit is revision-checked against the current timeline, and every commit is
reversible. Grouped undo (`undoProject`) already reverses a whole run in one keystroke.

**Undo is now the entire safety net**, which promotes two things from incidental to
load-bearing:

1. It gets a visible home — `Undo run` in the sidebar's run footer — shown only while the
   run is still the top of the undo stack. Past that point it would revert someone else's
   work, so it stands down rather than quietly meaning something different.
2. Undoing an AI edit sends nothing down the manual patch lane, because
   `invertProjectPatch` stamps the inverse with the original patch's `createdBy` and
   `manualPatchesForHistoryTransition` keeps only `'user'` patches. It still reaches disk,
   via the full-project autosave that runs precisely because no patch was queued. That
   fallthrough is now pinned by a test rather than left to luck.

The learning signal changes rather than disappears. `recordReviewDecision(..., 'rejected')`
was driven by a Reject button; it is now driven by Undo. That is a better signal: rejecting
a card judged an edit the user had only read about, while undoing judges the edit they
actually watched.

The risk accepted: a run whose review later finds a defect has already written to the
project file. The finding still arrives in-run and earns a repair turn, and one keystroke
reverses the run. This is the same trade ADR 0120 made when it chose to release uncleared
work rather than destroy it — the person decides, with the finding in front of them. We
changed *when* they are told, not *whether*.

Not addressed here: a finding that settles after the agent has already stopped is too late
to steer, so it surfaces unresolved for the user rather than earning an automatic repair.
Continuing a finished run to absorb late findings needs a resumable agent loop, which is a
larger change. `patchPolicy: 'review'` also remains *accepted* in `run-contracts.ts` so
durable runs recorded before this change still parse; removing the enum member is a schema
change needing its own migration.
