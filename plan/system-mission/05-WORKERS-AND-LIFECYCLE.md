# Phase 5 — Workers and lifecycle — `[~]`

> **Ships:** specialization where the Phase 0/1 ledger shows it pays (smaller context,
> parallel time, accuracy); typed input/output contracts for every specialist; a single
> lifecycle model for every long-lived process (sidecar, FFmpeg/ffprobe, analysis jobs,
> preview workers, model calls) with timeouts, cancellation, restart, cleanup,
> backpressure, limits, duplicate suppression, orphan detection.
> **Does not ship:** a multi-agent framework, a message bus, a plugin runtime, or any
> worker without a ledger row that justifies it.
> **Depends on:** Phase 1. **Schema/deps:** none.

## The decision rule

The codebase already has the roles `PROMPT.md` §7 lists, as **in-process** pieces: the
Critic proposer (verify), domain controllers (audio, color, motion, timeline, tracking),
the sidecar (media analysis, render), the brain (visual understanding). A "worker" here
means **a specialist with its own bounded context and typed contract**, not necessarily a
process. Introduce one only when the ledger shows, for a real scenario, at least one of:
context for the step is < 40% of the main turn's; the step can run concurrently with
another; the step's error rate drops with a narrower prompt. Record the justification in
the task.

## P5.1 — Typed contracts for the existing specialists — `[ ]`

**Touches:** `packages/ai-sdk/src/controllers/*`, `kernel/proposers/types.ts`. One
shared shape: `SpecialistInput { task, context, constraints, inputs }` →
`SpecialistOutput { outputs, artifacts[], confidence, errors[] }`, zod-validated at the
boundary. Controllers stop reading the whole working state and receive only their slice.
**Done when:** every controller and proposer is called through the contract and a test
asserts its input contains no field outside its declared slice.

## P5.2 — Bounded-context model specialists (only where earned) — `[ ]`

Candidates to evaluate with the ledger — implement only those that pass the rule:
media-analysis summarizer (turns raw footage map into the P1.3 facts, small tier),
planner (plan-only prompt without tool schemas), critic judgment (already small tier).
Each runs through `proposerModelEffect` with its own manifest budget.
**Done when:** each implemented specialist has a before/after row (tokens, wall,
accuracy) in `05-after.md`; rejected candidates are listed with the number that
rejected them.

## P5.3 — Process lifecycle registry (desktop main) — `[~]`

**Touches:** `apps/desktop/electron/sidecar/manager.ts`, `spawn.ts`,
`render/export-hub.ts`, `ai/run-coordinator-base.ts`, FFmpeg/ffprobe spawns in the
engine (`subprocess_safety.py`). One `ProcessRegistry` in main: every child is
registered with owner, purpose, started-at, timeout, cancel handle; states
`created → ready → running → idle → failed → recovering → terminated`; `app.before-quit`
and run-cancel walk the registry; orphan sweep on startup by pidfile. Engine side: every
subprocess goes through `subprocess_safety` with a timeout and is tracked per job.
**Done when:** killing the app mid-export and mid-analysis leaves no FFmpeg/ffprobe/sidecar
process (test with `pgrep` in the desktop e2e); cancel reaches the child within 500 ms.

Landed 2026-08-29: the render subprocess runs in its own session and a cancel/timeout
SIGTERMs its group (python + ffmpeg); the desktop spawns the sidecar `detached` and
`stop()` kills the whole group (`killProcessGroup`, tested). Remaining: a single registry
with owner/purpose/started-at per child and the `pgrep` e2e proof.

## P5.4 — Backpressure, limits, duplicate suppression — `[ ]`

**Touches:** engine `render/queue.py`, media preparation queue (media-intelligence
closure), `evidence-store.ts`. Concurrency caps by kind (analysis N, encode 1 by default,
hardware encode 1); identical in-flight requests (same asset hash + args) join the
existing job instead of starting another; queue depth and per-job state are readable by
the sidebar (Phase 8) and by `debug:resources` (Phase 0).
**Done when:** submitting the same analysis 5× concurrently runs it once; queue caps are
respected under a 60-asset preparation burst.

## P5.5 — Recovery — `[ ]`

**Touches:** `ai/durable-run-controls.ts`, `run-store.ts`, sidecar restart path.
Sidecar crash mid-run → run enters `recovering`, sidecar restarts, analysis jobs resume
from persisted job state or are re-queued, the run continues or fails with a reason
shown in the sidebar. App restart mid-run → run is shown as interrupted with a resume
control.
**Done when:** UC-15's sidecar-crash and restart rows pass in Phase 9.

## P5.6 — Close — `[ ]`

`05-after.md`, ADR for the lifecycle registry, `docs/runbooks/ai-run-lifecycle.md` update.

## Discovered

