# ADR 0042 — Cut `streamAgent` over to the Conductor Kernel

- **Status:** Accepted
- **Date:** 2026-07-07
- **Plan:** `plan/AI-ORCHESTRATION-REDESIGN.md` (Phase K1, K1.3) · `plan/PLAN.md` Phase K

## Context

The agent run was a single ~370-line imperative loop inside
`Orchestrator.streamAgent`: it owned the turn cycle, every stop/continue
decision (step cap, per-turn/per-run op caps, no-progress spin guard,
cancellation), the plan-ledger, planFirst/resume/autoRepair, and all event
emission — control logic and I/O tangled together, testable only end-to-end
through a live provider. Phase K0–K1.2 built the kernel alongside it: a pure
`Conductor` reducer (control plane — owns the run state machine and emits inert
effect descriptions + structural events), an `EffectRuntime`/handlers
(execution plane — model stream, tools, patch assembly), and `runConductor`
(the driver binding them). K1.2 proved, over 16 parity scenarios, that the
Conductor path reproduces `streamAgent`'s event stream byte-for-byte. K1.3 is
the cutover: make the shipping `streamAgent` **be** the Conductor path and
delete the old loop — the strangler-fig moment where the wrapped-around loop
is finally removed.

The risk: `streamAgent` is the shipping agent surface (chat sidebar, MCP,
`/create-short` et al.). Any behavioral drift — a reordered event, a shifted
id, a dropped terminal status — is a user-visible regression. A live-vs-live
parity test cannot guard the deletion, because once the old loop is gone there
is only one implementation left to compare.

## Decision

1. **Freeze the gate before cutover.** `src/kernel/streamAgent-golden.test.ts`
   snapshots the **old loop's** full `AiEvent[]` for every scenario under a
   fixed clock — `ts` *and* ids included, no normalization — captured while the
   old loop still produces it. This turns "two live impls agree" into "the
   Conductor-backed `streamAgent` reproduces today's shipping bytes." It
   explicitly covers the try/catch/finally paths the cutover deletes: the throw
   path (provider throws → retryable error card + partial diff → `failed`), the
   non-`Error` throw, the abort-races-a-non-streaming-call → `cancelled` branch,
   and the `finally` settle (reasoning done + terminal status) on every exit.

2. **Delegate, don't reimplement.** `streamAgent` compiles the run into a
   Conductor `Command` + execution handlers (`agentRun`) and delegates to
   `runConductor`, wrapping it in a throw-settling generator that reproduces the
   old `catch`/`finally`. The ~398-line loop is deleted. Its turn mechanics
   survive **only** in the shared methods the handlers reuse
   (`streamAssistant` · `executeToolCalls` · `applyAgentTurn` ·
   `generateAgentPlan` · `attemptRepair` · `critique` · `assembleEdit`), so the
   run's control flow cannot diverge from how a turn actually executes.

3. **One shared throw-time seq reader.** For byte-identical ids on the error
   path, `settle` must continue the run's monotonic one-off sequence from
   wherever a throw interrupted it. Rather than each handler minting its own
   `seqAtThrow` arrow (only coverable on a per-handler throw, and leaving a dead
   `() => 0` default), a single reader reads the **active handler's** emitter via
   a mutable `activeEmit` reference, seeded with a zero-seq emitter that
   preserves the old `() => 0` fallback for the (unreachable) pre-handler case.

4. **Keep `agentConductorHandlers` as the public kernel seam.** It exposes the
   run's handlers without the `streamAgent` wrapper — used today by the parity
   harness, and the intended entry point for K6.1 (the same kernel behind MCP /
   Electron-main IPC). The post-cutover `parity.test.ts` guards that this direct
   seam stays behavior-equivalent to the shipping `streamAgent`.

## Consequences

- **No user-facing change** — behavior is byte-identical by construction and by
  the frozen golden; there is nothing to add to the customer changelog.
- The control plane is now a pure, table-tested reducer; adding a real Task DAG
  (K3), a recipe router (K4), or replay (K5) is a change to the Conductor, not
  surgery on a live streaming loop.
- **What did NOT change:** no schema change (timeline-schema / Pydantic /
  `AiEvent` shapes); no new dependency; non-`agent` modes still route to the K0
  gateway path; Electron/IPC untouched (K6.1 remains sign-off-gated).
- 507 ai-sdk tests green; 100% statements/branches/functions/lines on
  `orchestrator.ts`, `conductor.ts`, `driver.ts`, `events.ts`;
  typecheck/lint/build + `web-editor` typecheck clean; `ai-sdk` dist rebuilt.
- Realizes redesign Definition-of-Done item 1: the monolithic loop is replaced
  by Conductor + handlers, its event output a strict superset guarded by parity.
