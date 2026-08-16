# ADR 0044 — The Orchestration Kernel (graduating the RFC)

- **Status:** Accepted
- **Date:** 2026-07-08
- **Plan:** `plan/AI-ORCHESTRATION-REDESIGN.md` (Phases K0–K6) · `plan/PLAN.md` Phase K
- **Supersedes (as the umbrella decision):** the RFC in
  `plan/AI-ORCHESTRATION-REDESIGN.md`. Builds on ADR 0042 (Conductor cutover) and
  ADR 0043 (tier routing / recipes / cost meter).

## Context

FramePilot's AI layer began as a single ~370-line streaming agent loop
(`Orchestrator.streamAgent`) that tangled control flow, execution I/O, and event
emission together — testable only end-to-end through a live provider, and structurally
incapable of the things the product needs: zero-token deterministic edits, parallel
analyses, honest recovery, run replay, and a tool surface that can grow past a handful of
tools without inflating every prompt.

The `AI-ORCHESTRATION-REDESIGN.md` RFC proposed a first-principles rebuild that demotes
the LLM from **controller** to **advisor**: a four-plane kernel — a pure **Conductor**
reducer (control), an **Effect Runtime** (execution), schema-validated **proposers**
(decision), and the Project doc + Semantic Index + event-log WAL (data). It was delivered
strangler-fig style over Phases K0–K6, each phase green on `pnpm verify` and preserving
every invariant. With K5 and K6 now complete, the RFC has been fully realized and is
graduated to this Accepted ADR.

## Decision

Adopt the kernel as the canonical architecture of the AI layer.

> **Integration status (2026-07-08).** This ADR records the *architecture* and the
> per-module delivery (each phase pure, table-tested, green on `pnpm verify`). It is
> **not** a claim that every path below runs end to end on the live product yet. An
> audit found most kernel modules — the scheduler, the four proposers, the recipe/plan
> compilers, the semantic index — have **no production callers**; what runs today is the
> degenerate (linear) Conductor wrapping the original turn loop. The end-to-end wiring —
> lighting up the recipe DAG, the parallel scheduler, and the proposers on the live run
> path — is tracked in **`plan/AGENT-NATIVE-COMPLETION-PLAN.md`**. Read the "shipping
> surface" list below as *designed and unit-proven*, with live integration landing
> incrementally per that plan.

The shipping surface is:

- **Conductor (control plane)** — a pure `onCommand`/`onEffectResult` reducer owning the
  run state machine, budget caps, plan ledger, and checkpoint/resume. `streamAgent` *is*
  this path (ADR 0042); the old loop is deleted.
- **Effect Runtime (execution plane)** — the one privileged boundary for side effects,
  with idempotency-keyed dedup. Record/replay wraps it (K5.3): a run is reproducible from
  its ordered effect results with **zero provider calls**.
- **Proposers (decision plane)** — schema-validated `Planner`/`Edit`/`Intent`/`Critic`
  effects; a malformed proposal is a validation failure fed back once, never a crash.
- **Recipe-first router (K4)** — every command is classified deterministically before any
  model call. Six professional-editing verbs (remove silence, add captions, improve
  pacing, add hook, punch in, export reels) compile to a Task DAG and run with **0 tokens**.
- **Planner + Task DAG + Scheduler (K3)** — a validated acyclic DAG with resource-class
  concurrency caps runs independent analyses in parallel; the scheduler enforces token
  **and** dollar budgets (cost meter, ADR 0043).
- **Semantic Timeline Index + structured context (K2)** — bounded index-slice retrieval,
  not whole-document dumps, with a prompt-cached stable prefix.
- **Five memory scopes (K5.1)** — task (ephemeral) · run (the AiEvent WAL) · project
  (`aiMemory`) · **user** (cross-project editorial defaults) · **workflow** (taught,
  replayable recipes). Project memory overrides user memory per field.
- **Get-cheaper-as-taught (K5.2)** — a completed run saved as a named workflow routes
  future matching commands to its recipe with zero tokens.
- **Saga recovery (K5.3)** — a per-failure-class policy (retry→recipe/tier fallback,
  route-around vs fail-subgraph, pause-at-review, checkpoint-cancel, rebase-or-restart,
  self-correct) that never fabricates success.
- **Scoped tool registry (K6.2)** — capability/permission/cost/latency metadata + scoped
  descriptors, so the tool surface can grow to 100+ tools with a **flat** per-turn prompt.
- **Kernel in Electron main over IPC (K6.1)** — the main-process Orchestrator is
  Conductor-backed and streams `AiEvent`s over the hardened, sender-scoped `aiStreamStart`
  channel; the memory scopes are threaded end-to-end. MCP runs the same kernel behind the
  protocol.

## The invariants it preserves

No project-schema change across any phase; the AI emits **patches only** (validated,
reversible); render-vs-preview is untouched; one policy across surfaces (browser, desktop,
MCP); nothing fabricates a ✅ — an unavailable engine or a failed tool reports honestly.

## Consequences

**Positive.** The common editing verbs are instant and deterministic (no model, no
latency, no cost). Independent work runs in parallel with real timings. Runs are
replayable, resumable, and budget-bounded in tokens and dollars. Memory follows the user
across projects and the system gets cheaper the more it is taught. The tool surface scales
without prompt bloat. Every kernel module is pure and table-tested at 100% coverage, so
behaviour is inspectable and can't silently drift.

**Costs / follow-ups.** The deterministic recipe leaf-executors (`synth_ripple_deletes`,
`analyze_silence`, …) are inert specs until their engine lands — honoured by the
build-order invariant, not faked. Live dispatch of the router→recipe/plan path through the
Conductor, and desktop main-process threading of the remaining context scopes, are the
natural next increments on top of these now-proven seams. User/workflow memory persists in
the renderer's `localStorage` (no secrets, no new IPC); a future desktop app-profile store
can back it if cross-device sync is wanted.

## Alternatives considered

- **A better agent loop.** Rejected (RFC §2): a smarter monolith is still a monolith —
  no determinism, no parallelism, no replay, no scaling story.
- **Multi-agent controllers.** Rejected in favour of specialized proposers under one
  deterministic Conductor (RFC §6): many LLMs voting is more nondeterminism, not less.
- **Big-bang rewrite.** Rejected for strangler-fig (RFC §26): each phase shipped behind
  the invariants, green on `pnpm verify`, independently reviewable and revertible.
