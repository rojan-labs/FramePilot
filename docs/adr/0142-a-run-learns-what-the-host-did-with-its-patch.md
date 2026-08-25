# ADR 0142 — A run learns what the host did with its patch

**Status:** accepted
**Date:** 2026-08-26
**Related:** ADR 0074 (empty-run honesty), ADR 0075 (task memory), ADR 0080 (context
manifest), ADR 0083 (never report an edit on an unchanged timeline), ADR 0056
(per-turn diffs)

## Context

A captured agent run (`c25cfb56`, 2026-08-25) proposed two edits and had both
refused by the host with
`{state: 'stale', reason: 'The project is no longer the active authoritative project.'}`.

Its own ledger recorded, for both:

```json
{ "intent": "Added asset", "status": "succeeded", "projectRevisionAfter": 1 }
```

against a project still at revision 0 with an empty media bin.

This was not a race. Three separate designs met here, each locally reasonable:

1. **The orchestrator decides `succeeded` from its own validation.** It applies a
   patch to its own working copy of the project, and if the validator accepts it,
   the operation is recorded as succeeded (`kernel/conductor.ts#onTurnResult`).
   On the browser build and over MCP that is correct, because nothing else has an
   opinion.
2. **The desktop host re-checks every patch against the authoritative project**
   and can refuse it — the project is no longer the one the app has open, the
   revision moved, the patch references media that is not on disk.
3. **That verdict was written for the UI only.** It was stamped onto the outgoing
   `DiffEvent.commit` and never travelled back to the run.

So the run's memory and the project diverged, and the failure compounded: the
briefing lists a succeeded operation under **"ALREADY APPLIED — do not repeat"**,
which is precisely the instruction that stops the run retrying the one thing it
still owes. A run that finished rather than being cancelled would have reported
success for a project that was never modified — the overclaim ADR 0074 and the
system contract's CLAIMS OF COMPLETION rule both exist to prevent, arriving
through the run's own memory, where neither of them can reach it.

## Decision

**The host's verdict on a patch is part of the run's state, and the run waits for
it before planning the next turn.**

`packages/ai-sdk/src/kernel/commit-ledger.ts` is where a host records what it did
and a run reads it back. Three states, because two are not enough:

- `committed` — written to the authoritative project.
- `stale` — refused, with the host's own words for why.
- `deferred` — the host is **not the authority** for this patch (a `review`-policy
  run, where the renderer applies). Neither approval nor refusal.

`deferred` exists so the ledger's contract can be **"rule on every patch exactly
once"**. That contract is what lets the run _wait_ rather than guess.

### Why waiting, and not sampling

The first implementation sampled the ledger immediately after yielding the diff,
on the reasoning that the publish callback awaits its `beforePublish` hook before
resuming the generator. That is false: the graph's event queue
(`kernel/agent-graph.ts`) is a fire-and-forget push with no backpressure, so a
diff may or may not have reached the host at any point the run chooses to look.
In practice it had not, and the check silently did nothing.

Verdicts are now **awaited**, at the next turn boundary and again before verify.
There is a model call in between, so the wait is almost always already satisfied;
and waiting is the property that actually matters — _a turn is never planned
against an edit whose fate is unknown._

### What a refusal does

- **Rewinds the working copy** to before the refused patch, dropping every later
  patch with it. Those were validated against a timeline that only ever existed in
  this run's private copy; continuing to edit against it is how a run builds a
  second timeline and reports it as the user's.
- **Corrects the ledger row in place** (`recordHostRefusal`) rather than appending
  a second one: `recordOperation` keys updates on an idempotency key that carries
  the outcome, so re-recording the same work as failed would leave the false
  success standing beside its own correction. The project revision winds back to
  the one that still exists.
- **Corrects the same turn's briefing**, not just the fold after it — otherwise
  the model spends the one turn that could fix the problem being told the work is
  already done.
- **Reaches the model as prose**, carrying the host's own reason, so the next turn
  has a cause to act on rather than a hole where an edit was.

Operations now carry their `patchId`. Without it none of the above is findable.

## Consequences

- A run can no longer report success for an edit the project never received.
- A ledger passed by a host is a **promise to rule on every patch**. A host that
  can fail before recording one must record `deferred` on its way out, or the run
  waits forever. `main.ts` records on every branch of its diff arm, fall-through
  included.
- Surfaces with no arbiter — the browser build, MCP, the tests — pass no ledger
  and behave exactly as before: local validation is the last word because it is
  the only word.
- The run's terminal report gains the honest empty-run notice it should always
  have had for this case, naming the host's cause.

## Alternatives considered

**Adjudicate inline, at the yield.** Rejected: it depends on scheduling the graph
does not guarantee, and it fails silently when the ordering does not hold — which
is exactly how the first attempt at this fix passed review and did nothing.

**Reconcile only at finalize.** Simpler, and too late: the run would keep editing
against a project that had already refused its work, and the correction would
arrive after every turn that could have used it.

**Let the host rewrite the persisted `run_state` event.** Keeps the change out of
`ai-sdk`, and puts the run's memory under the control of something that is not the
run. The divergence would be hidden rather than fixed: the in-flight run would go
on believing the edit landed.
