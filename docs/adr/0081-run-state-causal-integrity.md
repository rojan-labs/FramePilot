# 0081. Run-state causal integrity and mutation barrier

- Status: Accepted
- Date: 2026-07-28

## Context

The task-memory schema contained an objective, decision ledger, objectives, operation
records, and verification records, but the production conductor populated only facts and
coarse operation summaries. It could advance to `apply`, surface a warning that no
committed decision or objective existed, continue running mutating tools, run the Critic,
and finally report success. Durable desktop snapshots stored harness status and effects,
but not the causal working state; Resume also dropped the checkpoint's working ledger.

The project could therefore contain real edits that the run could not trace back to an
authoritative objective or decision. Continuing from that state risks duplicate edits,
stale-position mutations, false verification, and false completion.

## Decision

One versioned `RunWorkingState` is the causal authority for automated mutation. A new run
persists its raw request, normalized objective, conversation/project/run/attempt identity,
and an execution plan before the first mutating tool is exposed. The detailed plan turn is
used when enabled; otherwise a minimal plan is committed from the persisted user request,
never from assistant prose.

Every execution-stage entry requires a committed plan, committed decisions, authorization,
and a matching project revision. Each successful speculative operation records its plan,
decision, objective, deterministic idempotency key, and before/after project revision.
Exact retries return the existing outcome. Verification reconciles the committed plan's
deliverables and records evidence per objective; completion is forbidden unless the ledger
contains a successful traceable operation and all required verification passes.

The conductor emits a machine-authored `run_state` projection at reducer boundaries.
Electron appends it to the run WAL and projects it into the durable snapshot. Run-state
versions are monotonic; reused versions with different content, regressed versions, and
run/project identity mismatches fail closed. Working-state schema v1 migrates to v2 only
from authoritative fields: committed decision records may restore a legacy plan; edits
without such evidence become orphaned and require review.

An unrecoverable invariant is an execution barrier. The model and mutating tools are not
called, verification is inconclusive, the run ends failed rather than completed, and the
existing project mutations are preserved for reconciliation. Host project-revision
conflicts also abort later automation instead of allowing stale execution.

## Consequences

Valid runs retain a complete causal chain from request through completion and survive
compaction, retries, cancellation, durable replay, and renderer reload without relying on
chat prose. Integrity failures become visible and actionable in the developer inspector.

The working-state schema and event stream gain additive data, and persisted v1 working
states require deterministic migration. Old runs with untraceable edits cannot resume
automatically. A dedicated regression-test round remains required before the plan task can
be marked complete.
