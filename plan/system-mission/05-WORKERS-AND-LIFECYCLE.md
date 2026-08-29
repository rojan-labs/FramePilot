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

## P5.1 — Typed contracts for the existing specialists — `[~]` (landed for the seven in-package specialists; desktop's tracking executor remains)

**Touches:** `packages/ai-sdk/src/controllers/*`, `kernel/proposers/types.ts`. One
shared shape: `SpecialistInput { task, context, constraints, inputs }` →
`SpecialistOutput { outputs, artifacts[], confidence, errors[] }`, zod-validated at the
boundary. Controllers stop reading the whole working state and receive only their slice.
**Done when:** every controller and proposer is called through the contract and a test
asserts its input contains no field outside its declared slice.

Landed 2026-08-29: `packages/ai-sdk/src/specialists/` — the contract, seven declared
specialists (audio, color, motion, timeline, tracking-mask, automatic-tracking,
subject-detection) and the Critic proposer. `sliceOf` projects the `ToolContext` down to a
specialist's declared slice, so a call site never sees the context to over-share from it;
the envelope is `.strict()`, so an undeclared field is a `SpecialistContractError` naming
the specialist. The five `professional_*` tools call their controller through
`runSpecialist`; `resolve*Objective` stays exported and pure for the eval cases.

The declaration that earns the change: `professional_color` is the only tool permitted to
read run-scoped host measurements, and a test now asserts that across all seven rather than
leaving it to the shape of one object literal. 23 tests, including the Done-when in both
directions — the built input carries no field outside the slice, and an input carrying one
is refused.

`Project` and the interaction snapshot are NOT re-parsed at the boundary: both were
validated by the schema that owns them, and a deep parse of a minutes-long timeline per
tool call would spend real time re-deriving that. The envelope checks identity and shape.

Remaining for `[x]`: `apps/desktop/electron/ai/automatic-tracking-executor.ts` is the only
production caller of the two tracking controllers and still calls them directly — outside
this change's scope.

## P5.2 — Bounded-context model specialists (only where earned) — `[x]` (evaluated on 585 + 706 real requests; planner already shipped, summarizer rejected, critic already one)

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
  _descriptions_ (8,748) but not _parameter schemas_ (7,553), because it emits prose, not
  tool calls — so a third of every planning request is JSON Schema that buys nothing.
  **Already shipped, and the refinement is rejected by the same rule that accepted it**
  (2026-08-29). `Orchestrator.generateAgentPlan` already sends **no tools at all** — the
  7,002-token / 30.9 % plan turn is production, not a projection. Re-measured over 706
  manifests rather than 585: p50 total 19,172, tool definitions 14,939 (77.9 %), request
  without the tool block 5,187 (27.1 %). Adding the descriptions back is therefore a COST
  against 7,002, not a saving against 22,671: it lands the plan turn at **15,750 tokens,
  69.5 % of a main turn**, over the 40 % threshold that admitted the specialist. Not
  implemented. The real gap it points at — the plan turn is told nothing about the tool
  surface — has 2,066 tokens of headroom under the rule and tool NAMES cost 339, so a
  bounded capability digest fits; it is deferred to Phase 2 because its benefit is plan
  quality and this session cannot measure that (the provider bridge rate-limits), and
  landing an unmeasurable prompt change to close a task is the failure mode this phase
  exists to avoid.
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

## P5.4 — Backpressure, limits, duplicate suppression — `[x]`

**Touches:** engine `render/queue.py`, media preparation queue (media-intelligence
closure), `evidence-store.ts`. Concurrency caps by kind (analysis N, encode 1 by default,
hardware encode 1); identical in-flight requests (same asset hash + args) join the
existing job instead of starting another; queue depth and per-job state are readable by
the sidebar (Phase 8) and by `debug:resources` (Phase 0).
**Done when:** submitting the same analysis 5× concurrently runs it once; queue caps are
respected under a 60-asset preparation burst.

Landed 2026-08-29, both clauses measured:

- **Same analysis 5× concurrently runs once.** `framepilot_engine/singleflight.py`
  coalesces identical in-flight requests on `/asset-media`, `/analyze-silence` and
  `/detect-beats`. Six identical concurrent callers produce **one** ffmpeg derivation and
  all six are served the leader's answer — including its exception, if it failed. Keys are
  released the instant the leader finishes: this is coalescing, not memoisation.
- **Caps hold under a 60-asset burst.** Sixty distinct concurrent `/asset-media` requests
  against a gate of 3 admit exactly **3** derivations at peak and all sixty are served —
  the gate queues, it never sheds. Six callers proves the gate exists; sixty proves it does
  not sag under the load it was built for (a user dragging in a shoot).

Caps that already existed and were verified rather than added: asset-media
(`FRAMEPILOT_ASSET_MEDIA_CONCURRENCY`), temporal evidence (1), visual index
(`visual_index_concurrency`), render queue (one encode). Duplicate suppression was the
missing half.

Queue depth being _readable by the sidebar_ belongs to Phase 8's "Doing" strip and is
tracked there, not here.

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

Landed 2026-08-29 (liveness) — **and this one was found by running the e2e, not by
reasoning about the code.** `failure-paths.spec.ts`'s "killing the engine mid-session" row
SIGKILLed the real engine and the app never brought it back, despite six green unit tests
for exactly that path.

The reason is a shape the unit tests could not see: the engine launches as
`uv run framepilot serve`, so the manager's direct child is the **wrapper** and the server
that answers requests is its **grandchild**. Kill the server and the wrapper lives on — no
`exit` event fires, and the manager goes on reporting `ready` while every request fails.
Watching a process is not the same as watching a service.

`SidecarManager` now also watches liveness: a ready engine is probed on an interval, and
three consecutive failures mean it is gone — the group is killed (so the port is actually
free) and the normal bounded restart runs, with the reason in `status.detail`. One missed
probe is forgiven, because a busy engine is not a dead one. It is **opt-in** rather than
defaulted: the loop's cadence comes from the injected clock, and a test that injects an
instant sleep for startup polling would otherwise spin. `main.ts` sets 5 s. Four tests,
driven by a bounded clock.

**The e2e row still does not pass, and that is the honest state.** After the liveness
change the "killing the engine mid-session" row no longer fails fast with "the engine
should come back on its own" — it now runs to its 4-minute timeout instead. Two things are
known and one is not:

- **Known:** the grandchild shape above is real, and watching the process alone could never
  have recovered from it.
- **Known:** the liveness mechanism itself behaves correctly against a controlled clock
  (four tests, including forgiving one missed probe and retiring on `stop()`).
- **Not known:** why the real app does not complete the cycle. Candidates worth checking
  in order — the SIGKILLed grandchild may leave the port bound, so the replacement engine
  never becomes ready and the restart budget exhausts into `failed`; or the app's shutdown
  path is what hangs, since the timeout moved from the poll to the whole test.

Claiming P5.5 on the unit tests would be claiming exactly the thing the e2e just
disproved once already. It stays `[~]` until the row runs green.

## P5.6 — Close — `[ ]`

`05-after.md`, ADR for the lifecycle registry, `docs/runbooks/ai-run-lifecycle.md` update.

## Discovered
