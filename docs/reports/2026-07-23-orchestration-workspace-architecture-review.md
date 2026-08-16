# Orchestration and AI Workspace Architecture Review

**Date:** 2026-07-23  
**Scope:** `packages/ai-sdk`, desktop AI IPC, web-editor AI workspace, conversation
persistence, project/timeline coordination, and the plans/ADRs that define them.  
**Verdict:** the safety foundations are strong, but execution authority and durable run
state are fragmented. The next initiative must consolidate the live product around one
run engine before adding more creative capability.

## Executive assessment

FramePilot already has several unusually good foundations:

- every edit is still a typed, validated, reversible operation;
- the streaming UI is driven by typed `AiEvent`s rather than hidden component callbacks;
- the Conductor reducer makes termination, budgets, checkpoints, and plan state testable;
- provider, tool, context, sidecar, and patch boundaries are explicit;
- read/analysis concurrency, cancellation, retries, context budgeting, and truthful tool
  outcomes are covered by focused tests.

Those foundations do not yet form one production execution engine. There are currently
three partially overlapping orchestration paths:

1. the main-process streaming agent path (`streamAuto` / `streamAgent`);
2. renderer-local recipe execution on desktop;
3. the Effect Runtime + planner/DAG path (`streamRecipe` / `streamPlannedEdit`).

The AI workspace presents these as one coherent system, but the capabilities, controls,
context, persistence, and recovery semantics differ by path. This is the root of the
coordination gap: the UI is both a projection and an execution participant, while the
orchestrator's durable state is only partially represented in the event log.

The correct next move is consolidation, not another layer of prompt tuning or isolated
fixes. The proposed target is described in
[the execution-engine architecture](../architecture/orchestration-execution-engine.md),
with implementation sequencing in
[`plan/ORCHESTRATION-FOUNDATION-INITIATIVE.md`](../../plan/ORCHESTRATION-FOUNDATION-INITIATIVE.md).

## Current end-to-end flow

### Desktop agent request

1. `AiSidebar` derives history, selection, user memory, pinned entities, apply policy,
   plan-first options, and live controls.
2. `DesktopAiSession` serializes a subset into `AiStreamRequest`.
3. Electron main validates the request and constructs an `Orchestrator`.
4. `streamAuto` performs a model classification call, then dispatches to chat, recipe,
   or the sequential agent path.
5. Agent mode runs through the pure Conductor, but the handler closures in
   `orchestrator.ts` still perform model calls, tool execution, speculative project
   mutation, repair, and event emission.
6. Main pushes opaque `AiEvent` payloads to the renderer.
7. The renderer appends them to a conversation log and derives the visible workspace.
8. Diff cards are applied later by React through `editor.applyPatchChecked`.

### Browser request

The same sidebar calls `BrowserAiSession`, which constructs and runs the SDK
orchestrator in the renderer. It can additionally invoke the planned-edit path, carry
pinned context, and directly wire approval/steering controls.

### Deterministic recipe

A saved workflow is pre-routed by `AiSidebar` to `recipe`. On desktop this bypasses the
main-process orchestrator and creates a second renderer-local orchestrator. In contrast,
an `auto` request classified as a recipe runs in main. Identical creative intent can
therefore execute in different processes with different executor/provider configuration.

## Risk-ranked findings

### P0 — execution authority is split

Desktop is not a single-host system:

- ordinary agent work executes in Electron main;
- taught recipe work executes in the renderer;
- the planner/DAG path is explicitly unavailable on desktop;
- browser mode directly hosts everything.

This creates capability and configuration drift. A desktop recipe uses
`browserOrchestratorOptions()` and may have no sidecar executor unless a Vite environment
variable is present, even though the desktop main process owns a healthy sidecar. There
is no authoritative place to answer "what is this run doing now?"

### P0 — visible desktop controls are not connected to the live run

The sidebar creates `PlanApprovalGate` and `SteeringQueue` controls for `auto` and
`agent`, but `DesktopAiSession` cannot serialize them. Main receives only the
`ask_user` gate.

Consequences:

- a large plan that requires approval emits `awaiting_approval`, then the handler finds
  no resolver and automatically approves it after a warning;
- steering typed in the desktop sidebar is pushed into a renderer-local queue that the
  main-process run never reads;
- the UI can imply that a safety/coordination action took effect when it did not.

This is the most direct orchestration–workspace synchronization defect.

### P0 — the durable event log is not the authoritative run record

The conversation log persists presentation events, but not a complete command/effect
history:

- approval and steering are live objects, not typed run commands in the WAL;
- the main agent path does not run through the recording Effect Runtime;
- `RunRecording` is off by default and only wraps recipe/planned-edit effects;
- checkpoint state is emitted only on cancellation and contains flattened ops/log text,
  not the complete scheduler/effect state;
- event-log compaction/snapshot utilities are not used by conversation persistence.

The system can resume a narrow cancelled agent case, but it cannot reconstruct,
diagnose, or deterministically replay an arbitrary production run.

### P0 — the canonical planner/DAG architecture is not the canonical product path

The accepted kernel ADR describes the LLM as an advisor behind a deterministic planner,
scheduler, and Effect Runtime. The default desktop request still routes novel editing
work to the sequential model-controlled tool loop. `streamPlannedEdit` has no current
sidebar caller and is rejected by `DesktopAiSession`.

The codebase therefore contains a production loop and a production-intended kernel in
parallel. Maintaining both increases drift while the scaling benefits—task graphs,
resource scheduling, replay, typed recovery—do not reach normal users.

### P0 — review/apply state is renderer-local and non-durable

Accept/reject/failed decisions and the auto-apply idempotency set are React state. They
are not `AiEvent`s, not persisted, and not part of the run ledger. Reloading a
conversation can make already-decided diffs appear undecided. In auto mode, a remount
can attempt a proposal again; current-project validation may reject it, but that is a
late safety net, not an exact-once lifecycle.

The orchestration engine cannot tell whether a proposed patch was accepted, rejected,
partially accepted, stale, or applied after the run ended.

### P1 — project consistency is optimistic but not revisioned

Every request carries a full `Project` snapshot. Events and commands do not carry a
project revision, and the main-process run does not own a compare-and-swap commit.
Staleness is discovered only when the renderer tries to apply a patch.

This is safe against invalid mutation, but weak for long-running work:

- a run can reason for minutes against an obsolete project;
- external MCP/manual edits are not visible to the run;
- multiple runs can target the same project without a lease or rebase policy;
- failure is surfaced at review time rather than reconciled at task boundaries.

### P1 — transport is a push stream, not a resumable protocol

`AiStreamEventMessage.event` is `unknown` at the shared contract boundary. There is no
event schema version, monotonic sequence, acknowledgement cursor, replay request,
heartbeat, backpressure signal, or reconnect handshake. `DesktopAiSession` buffers every
push it receives before filtering by request id, and the hub allows independent
concurrent runs without project-level coordination.

A destroyed renderer aborts a run. A temporary renderer reload cannot reconnect to a
still-running durable job because no durable job exists.

### P1 — conversation persistence cannot carry feature-length activity

Conversation persistence rewrites the entire JSON document after a debounce. The
desktop store also performs an uncoordinated read-modify-write of the shared index.
Additional concerns:

- the conversation shape has no schema version or migration;
- validation is shallow (`id`, `events`, `uiState`);
- event-log compaction exists but is not invoked;
- the unmount cleanup clears pending timers rather than flushing pending saves;
- decisions and run commands are absent from the persisted document.

This is adequate for chat history, not for an hours-long creative execution ledger.

### P1 — scaling starts with full-document transfer

Each run structured-clones the full project through IPC and reconstructs context from
it. Context budgeting limits what reaches the model, but does not limit renderer→main
transfer, main-process memory duplication, speculative project copies, or persisted
event growth. Feature-length projects need project references, revisioned snapshots,
segment retrieval, and artifact handles instead of repeated full-document movement.

### P1 — oversized coordination modules obscure ownership

The main concentration points are:

- `orchestrator.ts`: 3,794 lines;
- `AiSidebar.tsx`: 1,394 lines;
- `events.ts`: 1,167 lines;
- `conductor.ts`: 985 lines;
- `editor/ai.ts`: 734 lines;
- desktop `ai-stream.ts`: 529 lines.

Line count is not itself a defect, but these files mix policy, transport, lifecycle,
tool execution, persistence decisions, speculative state, presentation, and error
recovery. Changes repeatedly require cross-file comments to explain which path is live.

### P2 — documentation and plan state are not trustworthy enough

`docs/architecture/ai-engine.md` still described agent/review as stubs and listed old
provider/tool availability, while accepted ADRs and multiple sub-plans variously call
the kernel complete, integrated, partially integrated, or browser-only. The live plan
contains completed historical programs beside current gaps.

For a foundational engine, architecture governance is part of runtime reliability:
engineers must be able to identify the canonical path and the source of truth without
reconstructing history from several thousand plan lines.

## What should be preserved

The initiative must not discard the parts that already work:

- `editor-core` validation/apply/invert and project-scoped patches;
- the tool registry and host-executor boundary;
- Conductor's pure state transitions and deterministic tests;
- semantic-index slices and context budgeting;
- provider resilience and typed provider errors;
- event-derived UI rendering;
- task-graph scheduler and resource classes;
- sidecar sandbox, render validation, and security boundaries;
- human review and one-step Undo.

The redesign is a strangler consolidation: promote these into one path, then delete the
duplicate paths after parity gates pass.

## Required architectural outcomes

1. **One execution authority per deployed app.** Desktop orchestration lives in main.
   Renderer code never creates an orchestrator on desktop.
2. **One durable `RunRecord`.** Commands, state transitions, effects, outcomes,
   approvals, questions, steering, patches, decisions, and terminal status share a
   versioned WAL.
3. **One typed run protocol.** Start/approve/answer/steer/cancel/resume/subscribe are
   data commands with ids, revisions, and idempotency keys.
4. **One execution runtime.** Model, analysis, render, patch proposal, patch commit,
   verification, and persistence are typed effects under common cancellation, retry,
   scheduling, and recording.
5. **One project-consistency model.** Every run binds to a project id/revision; commits
   compare-and-swap, rebase, or pause honestly.
6. **One workspace projection.** The sidebar renders a `RunView` derived from durable
   domain events. It never invents or privately owns orchestration truth.
7. **One fast path and one graph path.** Simple commands compile to a tiny graph with
   minimal overhead; complex commands expand hierarchically without changing lifecycle.
8. **One quality policy.** Deterministic validation is mandatory; preview/render
   validation and human approval are policy gates based on blast radius.
9. **One observability model.** Every run exposes timings, retries, token/cost usage,
   context trims, effect lineage, patch decisions, and recovery without exposing CoT.
10. **One canonical plan.** Older plans become historical references; the foundation
    initiative owns the remaining work and acceptance evidence.

## Verification baseline

The review is source-based. No behavior was changed. The initiative's first delivery
must add failing cross-surface contract tests for the P0 findings before changing the
runtime, then preserve the existing full-suite baseline throughout the strangler
migration.
