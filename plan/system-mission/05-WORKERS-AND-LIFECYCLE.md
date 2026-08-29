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

## P5.2 — Bounded-context model specialists (only where earned) — `[~]` (evaluated on 585 real requests; planner accepted, summarizer rejected, critic already one)

Candidates to evaluate with the ledger — implement only those that pass the rule:
media-analysis summarizer (turns raw footage map into the P1.3 facts, small tier),
planner (plan-only prompt without tool schemas), critic judgment (already small tier).
Each runs through `proposerModelEffect` with its own manifest budget.
**Done when:** each implemented specialist has a before/after row (tokens, wall,
accuracy) in `05-after.md`; rejected candidates are listed with the number that
rejected them.

Evaluated 2026-08-29 against **585 real requests** (`context_usage` manifests from the
mission runs) — `docs/reports/system-mission/05-after.md` carries the table.

- **planner — PASSES.** A request without the tool block is 7,002 tokens, **30.9 %** of a
  main turn, under the 40 % rule. Refinement the data suggests: a planner needs tool
  *descriptions* (8,748) but not *parameter schemas* (7,553), because it emits prose, not
  tool calls — so a third of every planning request is JSON Schema that buys nothing.
  **Accepted, not yet landed:** it changes the proposer layer in `packages/ai-sdk`, which
  concurrent work in the same session was already editing, and landing two changes to
  prompt assembly at once regenerates goldens against a moving target.
- **media-analysis summarizer — REJECTED.** The footage map is not in the ten largest
  sections at all and `source media` is **240 tokens, 1.1 %** of a request. There is
  nothing to save; a specialist would add a call, a contract and a failure mode for a fifth
  of a percent of context.
- **critic judgment — already a specialist**, on a small tier through `proposerModelEffect`
  with its own 140-token prompt and manifest budget.

## P5.3 — Process lifecycle registry (desktop main) — `[~]` (registry + pidfile sweep landed; crash-case pgrep proof remains)

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
`stop()` kills the whole group (`killProcessGroup`, tested).

Landed 2026-08-29 (registry): `electron/process-registry.ts` — every child registered with
owner, purpose, started-at, optional timeout and a cancel handle, moving through
`created → ready → running → idle → failed → recovering → terminated` with `terminated`
final. `will-quit` calls `terminateAll()` as a **backstop**, not a replacement for the
existing owners: anything they forget, or any child added by code written after that
handler, still dies. 10 tests.

The part that could not be done any other way is the **pidfile**: every live child's pid is
written synchronously (the one sync write in `userData`, because its whole job is to be
readable after a process died without running a single quit handler), and the next launch
sweeps what the previous one left. Only pids this app recorded are touched, and each is
checked for liveness first — a pid is reused by the OS, and killing a stranger's process
because it inherited a number is a worse failure than leaving an orphan.

`recovering` is a state of its own rather than a flavour of `failed` because P5.5 restarts
an engine that dies mid-session, and a reader has to tell "it is coming back" from "it is
gone".

Remaining for `[x]`: the `pgrep` e2e proof (kill the app mid-export and mid-analysis, assert
no ffmpeg/ffprobe/sidecar survives) — `tests/e2e-desktop/specs/failure-paths.spec.ts`
already asserts the clean-close case, and the crash case is being added with the rest of
the UC-15 rows.

## P5.4 — Backpressure, limits, duplicate suppression — `[~]`

**Touches:** engine `render/queue.py`, media preparation queue (media-intelligence
closure), `evidence-store.ts`. Concurrency caps by kind (analysis N, encode 1 by default,
hardware encode 1); identical in-flight requests (same asset hash + args) join the
existing job instead of starting another; queue depth and per-job state are readable by
the sidebar (Phase 8) and by `debug:resources` (Phase 0).
**Done when:** submitting the same analysis 5× concurrently runs it once; queue caps are
respected under a 60-asset preparation burst.

Landed 2026-08-29: `framepilot_engine/singleflight.py` (sync + async in-flight
coalescing, keyed on the request's inputs, nothing memoised) wired into `/asset-media`,
`/analyze-silence` and `/detect-beats`; six identical concurrent asset-media requests
derive once and all six are served (test), the concurrency gate test now uses distinct
requests so it measures the gate. Caps already existed: asset-media
`FRAMEPILOT_ASSET_MEDIA_CONCURRENCY`, temporal evidence 1, visual index
`visual_index_concurrency`, render queue 1 encode. Remaining: queue depth / per-job
state readable by the sidebar (Phase 8 Doing) and the 60-asset burst measurement.

## P5.5 — Recovery — `[~]`

**Touches:** `ai/durable-run-controls.ts`, `run-store.ts`, sidecar restart path.
Sidecar crash mid-run → run enters `recovering`, sidecar restarts, analysis jobs resume
from persisted job state or are re-queued, the run continues or fails with a reason
shown in the sidebar. App restart mid-run → run is shown as interrupted with a resume
control.
**Done when:** UC-15's sidecar-crash and restart rows pass in Phase 9.

Landed 2026-08-29: `SidecarManager` now RECOVERS from an engine that dies after becoming
ready — bounded restarts (default 3) with 1s/2s/4s backoff, the cause and attempt number
in `status.detail`, `stop()` during the backoff cancels and resets the budget, an exit
during startup is still a plain start failure, and every phase change is observable via
`onStatusChange` (main logs it). Six tests. Note: the renderer has no production caller
of `sidecarStatus` today — nothing shows the phase to the user — so the "reason shown in
the sidebar" half of this task rides Phase 8's Doing strip rather than a new IPC push
nobody reads. Remaining: run-level `recovering` state and job resume (`durable-run-controls`),
and the UC-15 rows in Phase 9.

## P5.6 — Close — `[ ]`

`05-after.md`, ADR for the lifecycle registry, `docs/runbooks/ai-run-lifecycle.md` update.

## Discovered

