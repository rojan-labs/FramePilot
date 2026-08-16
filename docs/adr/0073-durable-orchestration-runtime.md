# ADR 0073 — Durable orchestration runtime and synchronized AI workspace

- **Status:** Accepted
- **Date:** 2026-07-23
- **Review:** `docs/reports/2026-07-23-orchestration-workspace-architecture-review.md`
- **Plan:** `plan/ORCHESTRATION-FOUNDATION-INITIATIVE.md`
- **Builds on:** ADR 0033, ADR 0035, ADR 0044, ADR 0051, ADR 0072

## Context

FramePilot has a safe patch engine, typed AI tools, a pure Conductor, an Effect Runtime,
a planner/DAG scheduler, streaming events, and a capable AI sidebar. The live product
does not yet use them as one system.

Desktop agent work runs in Electron main, saved recipes can run in the renderer, and the
planner path is browser-only. Plan approval, steering, pinned context, patch decisions,
effect recording, event compaction, and replay have different support across those
paths. The conversation event log is a presentation history rather than a complete,
versioned run ledger.

The result is structurally prone to UI/execution drift, incomplete recovery, and
unpredictable cross-surface behavior. Continuing to add isolated capabilities would
increase the number of paths that must remain synchronized.

## Decision

Adopt a durable orchestration runtime as the only production execution authority.

1. Electron main hosts the desktop `RunCoordinator`; renderer-local desktop
   orchestration is removed.
2. Every request becomes a versioned `RunRecord` identified by `runId` and bound to a
   project revision.
3. Start, approval, answer, steering, cancel, resume, and patch decisions are typed,
   idempotent `RunCommand`s.
4. State transitions, effects, results, patch proposals/commits, and terminal outcomes
   are appended to a durable, monotonic run WAL.
5. All side effects—including the ordinary agent path—execute through one recorded
   Effect Runtime.
6. The planner/task graph is the canonical complex-work path; simple work compiles to
   a minimal graph using the same lifecycle.
7. The AI workspace derives `RunView` from the durable stream and owns presentation
   state only.
8. Project mutation uses revision-checked commit/rebase semantics through one project
   command service.
9. Browser/dev and MCP use adapters over the same command/event protocol and pass a
   shared conformance suite.
10. Existing paths are migrated by strangler fig and deleted only after event and patch
    parity tests pass.

The detailed target is
[`docs/architecture/orchestration-execution-engine.md`](../architecture/orchestration-execution-engine.md).

The F3 data-plane implementation completes this decision with restart-safe host
revisions, typed conflict classification, durable patch lifecycle events, an explicit
`auto_commit` run policy, authoritative workspace pushes, and run-grouped inverse
history. Project revisions remain execution metadata; the project schema is unchanged.

The 2026-08-03 memory hardening makes the data plane bounded in practice. A live run's
validated WAL projection is loaded once and incrementally indexed in Electron main, so an
event append never rereads or reparses the growing file. WALs have a 64 MiB safety ceiling;
legacy files above it are quarantined before JSON parsing. Tool-result details have their
own smaller transport cap. Renderer-to-host AI requests omit project undo history, while
the host merges its authoritative recovery history back into the live editable document.
This keeps the audit/undo record without copying large inverse patches through IPC.

## Consequences

### Positive

- the workspace cannot silently diverge from execution;
- interrupted and reconnected clients can restore exact run state;
- approvals and steering work identically on desktop, browser, and MCP;
- retries and recovery become effect-level policy rather than scattered catches;
- project conflicts are detected and reconciled before claiming success;
- fast deterministic edits remain cheap while complex workflows scale through the DAG;
- production runs become diagnosable without exposing raw chain of thought;
- live stream persistence is O(1) per append after one validated load, rather than
  quadratic in event count;
- duplicate orchestration paths can be removed.

### Costs

- shared IPC/MCP contracts need additive versioned changes;
- conversation persistence must be separated from the authoritative run store;
- the existing agent handler closures must be decomposed into typed effects;
- project revision/commit coordination becomes a first-class service;
- event migrations, crash/reconnect tests, and large-project fixtures add near-term work;
- some existing UI-local behavior will temporarily run behind compatibility adapters.

### Rejected alternatives

- **Continue fixing each path independently:** preserves the source of drift.
- **Make the renderer authoritative:** weakens secret isolation, crash recovery, and
  sidecar/project coordination.
- **Make the model the workflow controller:** cannot provide deterministic scheduling,
  replay, or bounded recovery.
- **Big-bang rewrite:** risks the validated patch path and blocks incremental evidence.

## Acceptance

This ADR moves to Accepted only when Foundation Gate F0 and F1 in the initiative plan
land: a versioned run protocol/store exists, desktop controls are end-to-end, and the
workspace restores an in-flight run after renderer reload without state loss or
duplicate application.
