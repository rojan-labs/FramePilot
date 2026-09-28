# ADR 0187 — A finished run's review is a skippable phase, not part of the run

- **Status:** Accepted.
- **Date:** 2026-09-25
- **Relates to:** ADR 0120 (reviews never destroy applied work), ADR 0122 (review reads, it does
  not gate), ADR 0123 (reviews are admitted), the detached review queue
  (`packages/ai-sdk/src/review-findings.ts`), EQ19 (messages queued during a run), plan `EQ24` in
  [`plan/PLAN.md`](../../plan/PLAN.md).

## Context

When an agent run finishes, the orchestrator waits for the perceptual review of its last edit
before it reports the run's terminal status, so a finding that lands late can still be shown next
to the work it is about. The wait is deliberate and happens after the editor already has every
edit and the written reply.

It had no status of its own. The panel kept showing the last status the run reported, usually
"Generating…", under a reply that was already complete. In run `fb90e58d` the review of a
caption rebuild rendered for 77 seconds. The editor read it as a hang and pressed Stop. That:

- cancelled the review and reported it as a failure ("Review could not run: Temporal evidence
  acquisition was cancelled");
- stamped the finished turn `cancelled` in the conversation, because Stop's finalizer only
  checked for an earlier `cancelled` or `failed` status, not `completed`;
- settled the durable run `cancelled` on the desktop host for the same reason.

Since EQ19, a message sent during a run waits in the queue until the run ends. During this wait it
sat behind a render the editor had not asked for.

## Decision

The post-run review is a separate, skippable phase of a run that has already done its work.

- **The orchestrator reports it.** Before waiting on pending reviews, it emits the existing
  `verifying` run status. The panel shows it as "Checking the edit…". Nothing else emits
  `verifying` today, and the panel treats it as "the reply is written".
- **Ending it is not cancelling the run.** If the run's signal is aborted during the wait, the
  orchestrator emits one "Review skipped" notification instead of a reviewer failure per batch,
  and still reports the run's own terminal status.
- **The sidebar never overwrites a completed turn.** The turn-signal fold records `completed`, and
  Stop's finalizer appends nothing after it. A stream that ends during `verifying` without a
  terminal event of its own (the desktop transport can end on `done`) is closed out `completed`.
- **A new message skips the review.** Sending while the run is `verifying` queues the message as
  EQ19 does and also aborts the run, so the message goes out now. In every other phase the queue
  waits for the run, as before. Stop still hands a queued message back to the composer.
- **The durable run agrees.** A `cancel` command that reaches a durable run whose snapshot is
  `verifying` settles it `completed` with a `completed_with_warnings` outcome ("the review of the
  last edit was skipped") instead of `cancelled`, and the later settlement keeps that outcome. A
  legacy (non-durable) run is settled `completed` by the hub when its stream reported `completed`
  before the stop.

## Consequences

- A skipped review leaves the last edit perceptually unchecked. The notification says so, in the
  same terms as an unreachable reviewer.
- `verifying` now carries a meaning the panel relies on. A future mid-run verification step that
  wants a status of its own must use another one, or Stop during it would read as "after the
  reply".
- The review still runs and still reports when nobody interrupts it. Nothing about when or what it
  checks changed.

## Amendment (2026-09-28): one bounded wait while the model can still act

Run `d8d2e445` ended with "The review of the last edit came back after the run had finished, so
nothing was done about it". The loop collected only reviews that had already finished at an edit
boundary, and the post-run wait above came after the agent had stopped, so a finding about the
final edit could be reported but never fixed.

- When the model declares itself done and the run is about to verify (no open item in its own
  plan, no unmet request measure), the agent loop waits for this run's pending reviews once, for
  at most `LATE_REVIEW_WAIT_MS` (60 s). The editor's Stop and the run's wall-clock budget end the
  wait early. It reports `verifying` while it waits: the reply is written, so Stop during it means
  what this ADR already says it means.
- Findings that arrive in that window go through the same steering path as mid-run findings
  (`REVIEW_STEERING_PREAMBLE`, once per defect class) and buy the model ONE more turn
  (`AgentTurnResult.lateReviewSteering`). A second declaration settles through verification with
  no second wait.
- Reviews still rendering when the budget runs out are neither cancelled nor dropped: the
  post-run wait above collects and reports them exactly as before.
