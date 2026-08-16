# ADR 0051: Plan-approval gate and mid-run steering as execution-side run controls

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** AI-SDK maintainers
- **Relates to:** `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P11.3/P11.4/P12.4/P12.5,
  ADR 0044 (orchestration kernel), ADR 0042 (Conductor cutover), ADR 0033
  (streaming AI sidebar architecture), `docs/guides/ai-sidebar.md`

## Context

Agent mode already drafts an up-front plan when **Plan first** is on, and a run
can already be stopped outright via **Stop**. Two gaps remained, both about the
*shape* of creator control over an in-flight run rather than what the run can do:

1. A drafted plan ran unconditionally once drafted, no matter how large — there
   was no moment for a creator to look at a big, multi-step plan before it
   started touching the timeline.
2. Once a run started, the only mid-run controls were **Stop** (end it) or wait
   for it to finish and start a new turn. There was no way to add guidance to a
   run already in progress without losing its progress.

Both controls need something the kernel's command boundary was deliberately
built to exclude: a live, non-serialisable handle into an in-flight run (a
Promise the run awaits before continuing; a mutable queue the run polls). The
Conductor's `Command`/`AgentOptions` types are plain, marshallable data on
purpose (`kernel/commands.ts` — no closures, no live objects beyond an optional
`AbortSignal`) so the same command can cross Electron IPC or MCP's HTTP
transport without either caring which wire it took. Putting a resolver or a
queue directly on `Command` would break that boundary for every caller, not
just the ones that want these two features.

## Decision

Add both as **execution-side run controls** in a new module,
`packages/ai-sdk/src/run-controls.ts`, threaded as a fourth parameter into
`Orchestrator.streamAgent` — never into the pure Conductor reducer or the
serialisable `Command`/`AgentOptions` boundary:

- **`PlanApprovalGate`** — a Promise-based approve/cancel gate. The pure
  Conductor only ever sees the boolean `AgentOptions.requirePlanApproval`; the
  gate that actually resolves the pause lives outside the reducer.
- **`SteeringQueue`** — a FIFO the host UI pushes into while a run streams; the
  running turn's handler `take()`s from it at its existing per-turn boundary —
  the same point that already polls `signal.aborted` between turns.
- **`AgentRunControls`** bundles both for a single call to `streamAgent`.

### The plan-approval threshold

The Conductor gates a drafted plan when it has **more than
`PLAN_APPROVAL_STEP_THRESHOLD` (3) steps** (`kernel/conductor.ts`) and
`requirePlanApproval` is set. At draft time — before any turn has executed —
the number of planned steps is the only size signal available at all: actual
ops/tracks/clips touched are only known once turns run, so there is no
finer-grained "blast radius" metric to gate on instead. Three was chosen
relative to the run's own step budget (default 8 turns): large enough to flag
genuinely bigger, multi-step asks, small enough that the common single/few-step
requests ("trim this," "add captions") stay frictionless and ungated, matching
today's behavior exactly.

When gated, the creator gets three choices, deliberately scoped smaller than a
full plan editor: **Approve** (run as drafted), **Edit request** (cancel,
nothing touched, repopulate the composer with the original prompt for a
refined re-run), **Cancel** (cancel, nothing touched, nothing repopulated). A
true per-step plan editor was considered and rejected for this slice — see
Alternatives.

### The steering queue boundary

Steering messages are folded in at the **next per-turn boundary**, not
mid-step. A message queued while a turn is mid-tool-call waits for that call
and its turn to finish, then applies before the next turn starts, with a
confirmation note in the conversation ("Steering applied: ..."). This reuses
the exact checkpoint the run already visits to check for `Stop`, so it adds no
new pause point and cannot leave a tool call in an inconsistent state.

### Scope: browser only, for now

Both features are wired for `BrowserAiSession`
(`apps/web-editor/src/editor/ai.ts`), which calls `streamAgent` in-process and
can hold the live gate/queue directly. `DesktopAiSession` marshals its run over
Electron IPC (`ipcRenderer.invoke`), which cannot carry a live Promise resolver
or a mutable queue across the bridge — only serialisable messages. Desktop
therefore stays on the un-gated, non-steerable path until that IPC parity is
built. This mirrors the same structural reason P11.2's planner-first path and
the variations/A-B-compare feature are also browser-only today; it is an
explicit, tracked gap (`plan/AGENT-NATIVE-COMPLETION-PLAN.md`), not a silent
regression.

## Consequences

- **Positive.** A high-blast-radius plan gets a review moment before it can
  touch the timeline, while everyday small edits stay exactly as frictionless
  as before. A creator can correct course mid-run without losing progress or
  waiting for completion. Neither feature required any change to the pure
  Conductor reducer, `Command`, or the project schema — both are additive,
  execution-side hooks that a caller can simply not provide (and every
  existing caller that doesn't wire them keeps today's behavior byte-for-byte,
  proven by the "no resolver wired → defaults to approved, never hangs" test
  in `orchestrator-stream.test.ts`).
- **Costs / follow-ups.** Desktop parity requires an IPC-safe way to carry an
  approve/cancel/steer signal from the main process back into a paused/running
  Conductor run (e.g. a request/response channel keyed by run id, rather than a
  literal live object) — tracked, not yet built. The step-count threshold is a
  coarse proxy for "big edit"; a more precise blast-radius signal (ops/tracks/
  clips actually touched) isn't available until after turns execute, so this
  remains the best available signal at draft time.

## Alternatives considered

- **A full per-step plan editor (reorder/edit/remove individual steps before
  approval).** Rejected for this slice: significantly larger UI and kernel
  surface (a plan becomes editable data, not just approve/reject-able) for a
  benefit ("Edit request" + a refined re-run already covers "the plan doesn't
  match what I meant") that the smaller feature already delivers honestly.
- **Instant mid-tool-call steering (redirect the agent's plan while a step is
  executing).** Rejected: requires either interrupting an in-flight tool
  effect (risking a partially-applied patch) or a much larger step-splitting
  redesign. The next-turn-boundary queue is a real, commonly used agentic-loop
  pattern that ships now without either risk.
- **Put the gate/queue on `Command`/`AgentOptions` directly.** Rejected: breaks
  the plain-data command boundary ADR 0042/0044 depend on for IPC/HTTP
  transport parity across browser, desktop, and MCP.
- **Gate on a richer blast-radius metric (ops/tracks/clips) instead of step
  count.** Rejected for this slice: that data doesn't exist until after turns
  execute, by which point the run has already started — too late to gate
  before any op touches the timeline.
