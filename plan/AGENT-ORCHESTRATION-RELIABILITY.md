# FramePilot — Reliable Agent Orchestration (end-to-end plan)

> **Sub-plan of `plan/PLAN.md`.** Read `plan/PLAN.md`, `AGENTS.md`, and `CLAUDE.md`
> before touching anything here. This is the execution source of truth for making
> FramePilot's AI orchestration — **agent / chat / edit modes, context management,
> and every AI-driven action** — _production-reliable_: resilient to provider
> failure, coherent across turns, bounded in context, resumable, observable, and
> provably regression-guarded.
>
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
> **Status:** `[~]` In progress — **R0 (contracts + tracer), R1 (resilient transport),
> and R2·B1 (history threading) have landed** (2026-07-03). The reliability core
> (`packages/ai-sdk/src/reliability/*` + `providers/errors.ts` +
> `providers/resilient-provider.ts`) ships with typed `ProviderError`,
> retry+backoff+jitter, connect/idle timeouts, usage capture, and a `TurnTracer` seam,
> all at **100% coverage on the new pure-logic modules**. `withResilience` is wired at
> every construction site (web `createOrchestrator`/`createAiSession`/agent, desktop
> `getOrchestrator`) so all three surfaces inherit one policy. Providers now throw typed
> errors (`ErrorEvent.retryable` derives from the classification) and emit `usage`
> chunks the resilient decorator consumes. Conversation history is threaded into the
> model context (`buildContext` + `historyFromEvents`) so multi-turn requests are
> coherent. **R2 B2/B3/B4 (token-budgeted tiered context + honest trim notices +
> selection-scoped timeline + agent-loop log compaction) and R3 C1/C3/C4 (blast-radius
> op caps + bounded Critic-driven auto-repair + up-front plan ledger) also landed** —
> all pure logic, no dep/schema/IPC change, 100% cov on the new modules (orchestrator +
> context-builder now 100%). **Remaining:** R2 B4's project-delta feed + B5
> prompt-caching (§7 A4); R3 C2 checkpoint/resume (§7 A1), C5 preview-in-loop (§7 A2);
> R4 (real-provider agent E2E); R5 (observability/eval matrix/guardrails/docs).
> **Owner agents:** `ai-tooling-engineer` (SDK/orchestrator), `timeline-engineer`
> (patch/checkpoint wiring), `mcp-engineer` (MCP parity), `security-reviewer`
> (transport/abort/secrets/fallback), `qa-e2e` (eval harness + e2e),
> `performance-monitor` (latency/token budgets), `docs-maintainer` (ADR/guides).
> **Last updated:** 2026-07-03
>
> **Streaming-agent parity (2026-07-04).** Closed the gap where the app (which uses
> `streamAgent` exclusively) ran a _weaker_ agent than the non-streaming `agent()`:
> `streamAgent` had accepted an `agentOptions` arg but only read `maxSteps`. It now
> honors the full set — **blast-radius caps** (R3 C1: per-turn wholesale-reject +
> per-run stop, with emitted diagnostics), **`planFirst`** (R3 C4: up-front read-only
> plan surfaced as a reasoning summary and threaded into every turn), and a **bounded
> Critic auto-repair pass** (R3 C3, reusing the shared tested `attemptRepair`) — and it
> now **surfaces the Critic self-check** as a notice + one warning per failed check
> (previously the streaming path ran no critique at all). `agent()`/`review()`/
> `streamAgent()` share one `critiqueOptions` builder. The browser `AiSession`
> (`editor/ai.ts`) forwards `selection` (R2 B3 on the browser path) and `agentOptions`
> to the run. `orchestrator.ts` at 100% coverage (ai-sdk 316 tests).
>
> **Desktop cross-surface parity (2026-07-04) — R2 B1 desktop + R4 E1 (partial).** The
> `AiStreamRequest` IPC was additively extended (`@framepilot/shared-types`:
> `AiStreamHistoryMessage`/`AiStreamSelection`/`AiStreamAgentOptions`) to carry
> **history**, **selection**, and **agentOptions**. `ai-stream.ts` validates each from
> the untrusted renderer (`parseHistory` bounded to 50 + role/content checks;
> `parseSelection` finite-non-negative + `start ≤ end`; `parseAgentOptions` numeric/
> boolean/target-platform-allowlist) and `runAiStream` threads history+selection into
> `ContextInput` and agentOptions into `streamAgent`. `DesktopAiSession.run` sends them.
> So the Electron app now gets multi-turn coherence + scoped context + the robust agent,
> matching the browser. `ai-stream.ts` at 100% coverage (desktop 172 tests).
>
> **Agent UI control (2026-07-04).** The sidebar (`AiSidebar.tsx`) now shows a
> **"Plan first"** toggle in Agent mode (default on, hidden in chat/edit), wired to
> `agentOptions.planFirst` through the browser + desktop paths — so the robust agent is
> user-drivable, not just plumbed (web-editor 625 tests).
>
> **Prompt-caching + checkpoint/resume (2026-07-04) — R2 B5 + R3 C2 done.**
> _Prompt-caching (B5, gate A4):_ the Anthropic provider marks the stable prefix (tool
> schemas + system contract) with an `ephemeral` cache breakpoint (on `system`, or the
> last tool when no system) — a real cost/latency win on long multi-turn runs; the
> per-turn context is deliberately uncached; NVIDIA unchanged. `anthropic.ts` 100% cov.
> _Checkpoint/resume (C2, gate A1):_ modelled as a new persisted `CheckpointEvent` on the
> conversation event log (**no new store**, no project-schema change). `streamAgent`
> emits one on interruption (when there is applied work) and accepts `agentOptions.resume`
> to replay the kept ops + continue from the next step; invalid replay falls back to a
> fresh run with an honest warning. The sidebar surfaces **Resume** (via `view.checkpoint`)
> and the browser session forwards it. `events.ts`/`orchestrator.ts` 100% cov (ai-sdk 328).
> Also closed pre-existing ai-sdk coverage debt (tool-registry `set_track_flags`,
> context-builder B3 branches) so `test:coverage` is fully green. **Still open:** the
> **desktop** resume hand-off (the `AiStreamAgentOptions` IPC shape carries no `ops`, so a
> desktop Resume currently starts fresh) — needs the ledger threaded over IPC; a
> duration-target UI field (plumbed end-to-end, no control yet); R4 real-provider agent
> E2E; R5 observability/eval matrix.

---

## 0. Why this plan exists (the honest starting point)

The AI layer is **feature-complete** (Phases 4, 7, 11). What already works — _reuse
it, do not rebuild_:

| Capability                                                                       | Where                                               | Status               |
| -------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------- |
| Orchestrator modes chat/plan/edit/agent/autocomplete/review + streaming variants | `packages/ai-sdk/src/orchestrator.ts`               | ✅ works             |
| Streaming event model (15 `AiEvent`s, in-place merge, `reduceEvents`)            | `packages/ai-sdk/src/events.ts`                     | ✅ 100% cov          |
| Providers (Anthropic/NVIDIA raw `fetch`, deterministic mock) + SSE               | `packages/ai-sdk/src/providers/*`                   | ✅ works             |
| Tool boundary (registry → `operationsFor` → `assembleEdit` → validate)           | `orchestrator.ts:183`, `assemble.ts`                | ✅ invariant 5 held  |
| Agent loop (bounded, no-progress halt, per-turn validated patch, self-check)     | `orchestrator.ts:359,667`                           | ✅ works             |
| Desktop streaming hub (abort, sender-scope, 10-min cap, key off-bridge)          | `apps/desktop/electron/ai/ai-stream.ts`             | ✅ security-reviewed |
| Conversation persistence (JSON-per-conversation, desktop + IndexedDB)            | `apps/web-editor/src/ai/conversationPersistence.ts` | ✅ works             |
| Cursor-class sidebar (virtualized, apply/reject/batch, retry, cancel)            | `apps/web-editor/src/components/ai/*`               | ✅ works             |

**The reliability gaps this plan closes** (all verified in-tree, 2026-07-03):

1. **No provider resilience.** Every provider `throw`s on the first non-2xx
   (`anthropic.ts:159,187`; `nvidia.ts:141,172`) — no retry, no backoff, no
   `Retry-After`/429 handling, no typed retryable classification. `ErrorEvent`
   even hardcodes `retryable: true` (`orchestrator.ts:646`) regardless of cause.
2. **No timeouts inside the SDK.** Only the desktop hub's coarse 10-minute run cap
   exists (`ai-stream.ts:121`). A stalled SSE with no bytes hangs until that cap;
   `sse.ts` only checks abort _between_ reads. No connect timeout, no idle timeout.
3. **No conversation history reaches the model.** `chat()/edit()/plan()` call
   `buildContext(input)` which emits only `[system, current-prompt]`
   (`context-builder.ts:139`). Multi-turn coherence ("make _it_ shorter",
   "undo that and try again") is impossible today — history is persisted for the
   **UI only**, never fed back to the provider.
4. **Context is not token-budgeted.** A static 600-word transcript cap
   (`context-builder.ts:23`) + a full per-layer timeline dump + fixed
   `max_tokens: 2048` (`anthropic.ts:27`). A large project or long transcript
   silently grows the prompt with no model-context-window awareness.
5. **Agent-loop context is unbounded.** Every turn re-summarizes the _entire_
   working project and feeds an ever-growing verbatim `log[]`
   (`orchestrator.ts:286,410`). A long/complex run's prompt grows every step until
   it overflows or degrades.
6. **No resume / auto-repair.** Resume is explicitly deferred (AI-SIDEBAR M6 shipped
   Retry-only); an aborted or crashed agent run restarts from scratch. The Critic
   reports problems but never gets a bounded pass to _fix_ them.
7. **Agent mode runs on the mock provider in the app** (Phase 9.3 deferred). Chat/
   plan/edit have real-provider IPC; agent does not run against a real model E2E.
8. **No reliability eval harness / telemetry.** Abort/no-progress/validator-rejection
   are unit-tested, but there is no deterministic golden-run matrix for retry,
   budget, resume, or auto-repair, and no per-turn tracing (tokens/latency/retries).
9. **Conversation records aren't schema-versioned/Zod-validated** on load
   (`parseConversation` is a lightweight guard) — a format change has no migration.

**Non-negotiable invariants (unchanged — every phase must hold all of them):**

1. **No `project.fp.json` schema change** without a migration + doc + tests. All new
   state (checkpoints, traces, conversation versioning) lives in _separate_ stores.
2. **AI edits ONLY** via tool registry → orchestrator → validated `Patch` →
   `validate→apply→record`. Nothing auto-applies; the human approves every edit.
3. **Render vs. preview:** any media preview is the Python engine, never faked.
4. **No new dependency / IPC channel / persisted store** without the §7 approval.
5. **Small, reviewable, independently-shippable PRs** — one milestone per PR, each
   with tests, 100% coverage on new pure-logic modules, CHANGELOG + plan tick + ADR
   for decisions.
6. **One policy, three surfaces.** Resilience + budgeting live at the orchestrator/
   provider _core_ so browser (direct), desktop (hub), and MCP all inherit them —
   never fork the policy per surface.

---

## 1. Target architecture (what changes)

```
                       ContextInput (+ history, +budget, +scope)
                                     │
                          ┌──────────▼───────────┐
                          │  ContextBudgeter (B)  │  tiered, token-aware assembly
                          └──────────┬───────────┘
   chat/edit/plan/agent ────────────▼──────────────  Orchestrator (unchanged gate)
                                     │  tool calls → operationsFor → assembleEdit → validate
                          ┌──────────▼───────────┐
                          │  ResilientProvider (A)│  retry · backoff · Retry-After ·
                          │   decorates any       │  connect+idle timeout · usage capture ·
                          │   AiProvider          │  typed ProviderError · optional fallback
                          └──────────┬───────────┘
                          Anthropic · NVIDIA · Mock  (dumb; unchanged)
                                     │
                          TurnTracer (F)  ── spans: tokens/latency/retries/tool outcomes
```

- **`ResilientProvider`** — a decorator implementing `AiProvider` that wraps any
  concrete provider. All resilience lives here, so `complete()`/`stream()` in the
  concrete providers stay dumb and every surface inherits the policy by construction.
- **`ContextBudgeter`** — evolves `context-builder.ts` from "dump everything,
  truncate transcript" into a priority-tiered, token-budgeted assembler that also
  threads conversation history and selection-scoped detail.
- **Agent-loop compaction + checkpoint** — bounded rolling context per turn; a
  resumable ledger persisted in the conversation store (never the project schema).
- **`TurnTracer` + eval harness** — the measurement + regression backbone that
  proves the above is actually reliable.

---

## 2. Phases (ship in order; each phase = 1–N reviewable PRs)

Each milestone lists **Goal · Files · Tests · DoD**. "DoD" always includes: affected
unit tests green, `pnpm typecheck`/`lint`/`pnpm verify` green, 100% coverage on new
pure-logic modules, CHANGELOG entry, plan checkbox ticked, ADR for decisions.

---

### R0 — Contracts, telemetry seam & eval scaffold `[~]` (Owner: ai-tooling-engineer + qa-e2e + docs-maintainer)

Lock the contracts and build the measurement backbone _before_ hardening, so every
later phase lands with a deterministic golden run and a trace.

- [x] **ADR 0035 — "Reliable agent orchestration."** Specify `ProviderError`,
      `RetryPolicy`, `ContextBudget`/tiers, `TurnTrace`, and the agent `Checkpoint`
      shape; state why none of it touches `project.fp.json`. (`docs/adr/0035-*.md`.)
- [x] `packages/ai-sdk/src/reliability/types.ts` — pure contract types:
      `ProviderError { status; kind; retryable; retryAfterMs? }`, `RetryPolicy`,
      `Usage { inputTokens; outputTokens }`, `TurnTrace`, `ContextBudget`/`CONTEXT_TIERS`.
      100% cov.
- [x] `TurnTracer` seam — `reliability/tracer.ts`: `TurnTracer` interface + `NOOP_TRACER`,
      `InMemoryTurnTracer` (bounded ring), and a `TurnTraceBuilder` that accumulates
      retries/usage/tool-calls/abort/timeout and emits one immutable `TurnTrace`. 100%
      cov. **Remaining:** call it from the orchestrator turn boundaries + wire desktop's
      opt-in telemetry sink (R5 F1).
- [ ] **Eval harness scaffold** (`packages/ai-sdk/src/__evals__/`): a deterministic
      scenario runner over `MockProvider` variants (scriptable to fail N times,
      stall, return bad args, loop, etc.). Golden-sequence assertions on the emitted
      `AiEvent` stream + final `EditResult`/`AgentRun`. **(Deferred to R5 F2.)**
- **DoD:** contracts + tracer merged; ADR landed; no behavior change from the contracts
  themselves. Orchestrator-boundary tracer calls + eval harness tracked under R5.

---

### R1 — Resilient transport `[~]` (Owner: ai-tooling-engineer + security-reviewer)

The foundation. One policy, applied at the core, inherited by all three surfaces.

- [x] `providers/errors.ts` — classify a `Response`/thrown error into a typed
      `ProviderError`: `429`→rate_limit (parse `Retry-After`, delta-seconds + HTTP-date),
      Anthropic `overloaded_error`/`529`→overloaded, `5xx`→server, fetch reject→network,
      `401/403`→auth, `400/422`→bad_request. Replaced the bare `throw new Error(...)` in
      `anthropic.ts`/`nvidia.ts` (both `complete()` and `stream()`, and thrown-error
      wrapping). 100% cov.
- [x] `reliability/retry.ts` — pure `withRetry(fn, {policy,signal,sleep,rand,onRetry})`:
      bounded attempts, exponential backoff **+ symmetric jitter**, honors `retryAfterMs`,
      aborts immediately on `signal`, never retries a non-retryable `ProviderError`.
      Final attempt runs outside the loop (no dead branch). 100% cov.
- [x] `reliability/timeout.ts` — `withConnectTimeout` (no response in N ms) and a
      resettable `IdleTimeout` (no chunk in N ms) backed by an `AbortController`; the
      resilient stream calls `beat()` on every chunk. Injectable timers. 100% cov.
      (Implemented as a per-chunk heartbeat in the decorator's iterator wrapper rather
      than editing `sse.ts`, so the raw providers stay untouched.)
- [x] `providers/resilient-provider.ts` — `ResilientProvider implements AiProvider`,
      decorating any provider. `complete()` retries fully (+ connect timeout).
      `stream()` retries **only before the first forwardable chunk** (usage chunks that
      precede content are reported, not counted); a mid-stream drop surfaces a typed
      retryable error so the turn can be re-run (no duplicate deltas); a genuine
      caller-abort ends the stream cleanly (orchestrator emits `cancelled`). Captures
      `Usage` from `usage` chunks and reports it via hooks (for the `TurnTracer`). 100%
      cov. New `reliability/signals.ts` combines the caller + idle-timeout signals.
- [x] Wire `ResilientProvider` at every construction site: web `createOrchestrator`,
      `createAiSession`, and the agent path (`editor/ai.ts` `withResilience`); desktop
      `getOrchestrator` (`main.ts`) wraps nvidia/anthropic/mock. MCP tool-exec stays
      direct (no model-backed path there yet — confirmed).
- [x] Fixed `ErrorEvent.retryable`: providers now throw typed `ProviderError`s, so the
      classification (not a hardcoded `true`) drives the flag. (The `orchestrator.ts`
      tool-invocation error at the old §646 is a _tool-arg_ error, left as-is; provider
      errors flow through the typed path.)
- [ ] **Optional provider fallback** (config, **off by default**, §7 A5): deferred —
      needs the data-egress security review before landing.
- **Tests:** 429-twice-then-succeed → 2 retries, backoff honored; non-retryable 400 →
  no retry, typed error; idle-stall → idle timeout fires + reported; abort before/at any
  attempt → stops immediately; usage captured (before + after first chunk); mid-stream
  drop → retryable error, no duplicate deltas; empty stream; no-native-stream fallback.
- **DoD:** ✅ a transient provider failure is retried transparently on all three surfaces;
  a permanent one fails fast with a typed, retryable-flagged error. (Fallback deferred.)

---

### R2 — Context management `[~]` (Owner: ai-tooling-engineer)

The explicitly-requested pillar: coherent, bounded, relevant context.

- [x] **B1 — Conversation history threading.** Added `history?: readonly AiMessage[]`
      to `ContextInput`; `buildContext` threads a bounded (`MAX_HISTORY_MESSAGES=8`)
      most-recent window of prior user/assistant turns between the system contract and
      the current context+prompt (`boundedHistory`, drops system/tool + blanks). The
      two-message shape is preserved when history is absent (backward compatible). The
      web sidebar maps the active conversation's events → messages via a pure
      `historyFromEvents` in `editor/ai.ts` and passes them through `AiSessionInput` →
      `BrowserAiSession`. **Desktop path:** threading history in the main process needs
      the `AiStreamRequest` IPC contract to carry it (§7-gated contract change) — a
      follow-up. 100% cov on the new pure helpers.
- [x] **B2 — Token-budgeted tiered builder.** `context-builder.ts` now assembles a
      priority-tiered, token-budgeted context: a pure `estimateTokens` (chars/≈4
      heuristic, no dep), `budgetTokens(budget)`, and `assembleContext(input)` which
      builds every tier and drops the lowest-priority present tiers first (order:
      transcript → timeline → memory → history → selection) to fit
      `budget = contextWindow − maxOutputTokens − headroom`. `buildContext` = the
      messages of that. The three streaming orchestrator modes emit one honest
      `NotificationEvent` per trimmed tier (`trimNotices`). `DEFAULT_CONTEXT_BUDGET`
      is deliberately generous so small/medium projects never trim (behaviour
      unchanged); callers pass a tighter `budget` on `ContextInput` to tune. 100% cov
      on the new pure logic. **(B3 selection-scoping remains open.)**
- [x] **B3 — Selection/relevance-scoped slice.** When a `selection` exists,
      `summarizeTimeline(timeline, assetKinds, focus)` shows the clips overlapping the
      range **plus their immediate neighbours** in full and collapses the remainder to a
      count/span (`focusedClipIds` + `renderTrackClips`, pure). When the focus sits in a
      gap, the clips bounding the gap are chosen. `assembleContext` passes the selection
      through, so a large timeline stays relevant + bounded around the request. 100% cov.
- [~] **B4 — Agent-loop compaction.** The unbounded verbatim `log[]` fed back each
  turn is now bounded by a pure `compactAgentLog(log, recent)` — last K notes
  verbatim + a deterministic digest line for older steps — wired into
  `agentMessages`. 100% cov. **Remaining:** feed a **project delta since the
  previous turn** instead of re-summarizing the whole working project every turn
  (needs a cheap timeline-diff summary).
- [x] **B5 — Prompt-caching seam** (Anthropic `cache_control` on the stable prefix;
      NVIDIA no-op). **(§7 A4 — approved.)** Done 2026-07-04: `anthropic.ts` marks the
      tool-schemas + system-contract prefix with an `ephemeral` breakpoint (on `system`,
      or the last tool when no system); per-turn context stays uncached. 100% cov.
- **Tests:** multi-turn "make it shorter" resolves the referent from history; budget
  overflow drops transcript before timeline before history (tier order asserted);
  selection scope includes only the right clips; agent digest stays bounded over a
  20-step run; cache prefix is byte-stable across turns.
- **DoD:** context is coherent across turns, bounded under any project size, and
  focused on what the request is about — deterministically and testably.

---

### R3 — Agent-loop robustness `[~]` (Owner: ai-tooling-engineer + timeline-engineer)

Handle AI actions safely, recover from failure, and finish the job.

- [x] **C1 — Failure budget + escalation (blast-radius caps).** Added `maxOpsPerTurn`
      (default 40) and `maxOpsPerRun` (default 200) to `AgentOptions`. A single turn
      that exceeds the per-turn cap is rejected wholesale with a diagnostic step note
      (not applied); the run stops with a diagnostic once cumulative ops reach the
      per-run cap. These sit on top of the existing signature-based no-progress halt
      and the first-rejection stop (a validator-rejected op-bearing turn already halts
      the run). 100% cov on the touched agent-loop paths. (Per-tool _consecutive_
      rejection counting is subsumed by the existing immediate-stop-on-rejection
      behaviour; revisit if that is relaxed.)
- [x] **C1b — Analysis-spin cap + edit-forcing escalation** (discovered 2026-07-09).
      The signature-based no-progress halt only caught a call repeated _verbatim_, so a
      model that re-ran the same analysis with a varied argument each turn (e.g.
      `detect_beats` at a new sensitivity) produced a novel signature every turn and
      spun on read-only work until the step cap — finishing a montage request having
      placed no clips. Fixed at the root in both agent paths: (1) a
      `consecutiveNoProgress` counter caps consecutive zero-op turns
      (`MAX_CONSECUTIVE_NO_PROGRESS = 4`, `conductor.ts`), independent of the exact
      signature; (2) once the streak crosses `NUDGE_TO_EDIT_AFTER = 2`, the per-turn
      context (`agentMessages`) escalates to require a timeline edit and forbid further
      analysis. Streaming (Conductor reducer) + non-streaming (`agent()`) kept in parity;
      new reducer tests cover the counter, cap, and reset.
- [x] **C2 — Checkpoint + true Resume.** Done 2026-07-04 (browser path; desktop
      hand-off is a follow-up). Modelled as a persisted `CheckpointEvent` on the
      conversation event log (reuse conversation persistence, **not** the project schema).
      `streamAgent` emits one on interruption (applied ops + log + steps) and accepts
      `agentOptions.resume` to replay the kept ops and continue from the next step; an
      invalid replay falls back to a fresh run with an honest warning. The combined-patch
      design keeps re-entry idempotent (one patch, one Undo). The sidebar surfaces
      **Resume** from `view.checkpoint`. Closes the AI-SIDEBAR M6 "Resume deferred".
      **Follow-up:** thread the ledger over the desktop `AiStreamRequest` IPC (its
      `AiStreamAgentOptions` shape carries no `ops` yet, so a desktop Resume starts fresh).
- [x] **C3 — Critic-driven auto-repair (bounded).** After the run, if the Critic
      reports _fixable_ findings (`FIXABLE_CHECKS` = duration_target / request_match /
      audio_clipping — render-gated black_frames is honestly excluded), `attemptRepair`
      grants the agent **exactly one** bounded pass targeting only those findings,
      through the same validate→apply gate + per-turn cap; the result is re-critiqued.
      Recorded as a `Repair pass: …` step (applied or rejected), human-approved, never
      auto-applied. Opt-out via `AgentOptions.autoRepair=false` (default on). 100% cov.
- [x] **C4 — Explicit plan ledger (optional).** `AgentOptions.planFirst` (opt-in) runs
      one read-only planning turn up front; `parsePlanLines` cleans the numbered steps
      into `AgentRun.plan`, and the plan is threaded into every loop turn's context so
      the agent follows its own committed steps. (Streaming `PlanEvent` surfacing +
      per-step reconciliation is a lighter follow-up on `streamAgent`.) 100% cov.
- [ ] **C5 — Preview render into the loop** (**§7 approval — needs the
      renderer→engine preview IPC**, the ADR 0016 export-channel pattern). Wire an
      auto preview render so the Critic sees real frames mid/post-run. Until the
      channel lands, the Critic's frame checks stay honestly `skipped` (not faked).
- **Tests (harness):** a run that fails a tool 3× stops with a diagnostic, not a
  timeout; abort → checkpoint → resume completes the goal; auto-repair fixes an
  over-duration result in one pass; ops-per-run cap enforced.
- **DoD:** an agent run recovers from tool failures, survives interruption via resume,
  self-corrects once against the Critic, and can never exceed its action budget.

---

### R4 — Real-provider agent E2E + cross-surface consistency `[ ]` (Owner: ai-tooling-engineer + security-reviewer + mcp-engineer)

- [ ] **D1 — Agent over real provider, end to end.** `streamAgent` already runs
      through the desktop hub; verify + close the Phase 9.3 gap so agent mode is
      selectable with a real provider (not just mock) and drives tools against a live
      model. Security-review: tool execution still goes through the validate→apply
      gate; nothing auto-applies; keys stay main-only.
- [ ] **E1 — One policy audit.** Confirm browser (`editor/ai.ts`), desktop
      (`ai-stream.ts`/`main.ts`), and MCP (`packages/mcp-server`) all obtain a
      `ResilientProvider` and a budgeted context — no surface bypasses the core
      policy. Add a cross-surface parity test.
- [ ] **E2 — Uniform error surfacing.** Every surface maps `ProviderError` →
      `ErrorEvent{retryable}` consistently; the sidebar Retry only offers itself when
      the error is actually retryable.
- **Tests:** agent-over-real-provider integration (recorded SSE fixtures, no live
  network); parity test asserts all three factories return a resilient, budgeted
  orchestrator.
- **DoD:** agent mode is real-provider-capable, and reliability behaves identically
  no matter which surface drives the orchestrator.

---

### R5 — Observability, guardrails, hardening & docs `[ ]` (Owner: qa-e2e + security-reviewer + docs-maintainer)

- [ ] **F1 — Trace surfacing.** Expose per-turn `TurnTrace` (tokens, latency,
      retries, tool outcomes) in a dev/diagnostics view and the opt-in local
      telemetry; a "copy diagnostics" affordance on `ErrorCard`.
- [ ] **F2 — Full eval matrix in CI.** Promote the R0 harness to a gated suite:
      happy path, retry-then-succeed, non-retryable fail, idle-timeout, no-progress
      halt, failure-budget stop, abort→resume, auto-repair, budget-overflow trim,
      multi-turn coherence. Deterministic on `mock`; runs in `pnpm verify`.
- [ ] **F3 — Latency/token budget guards.** `performance-monitor` adds non-flaky
      budget assertions (context-build time, per-turn token ceiling) mirroring the
      existing frontend perf-guard pattern (Phase 12).
- [ ] **F4 — Conversation record versioning.** Add a `version` field + Zod schema +
      forward-migration to the conversation JSON (`conversationPersistence.ts`); load
      validates and migrates instead of the lightweight `parseConversation` guard.
- [ ] **G1 — Guardrails.** Enforce the C1 ops caps at the tool boundary; add a
      "requires preview before apply" flag for high-risk ops (destructive
      `delete_range`/`ripple_delete` over large spans) — surfaced in the DiffCard.
- [ ] **G2 — Secret/path leak check.** Assert no context block or event payload
      leaks API keys or absolute project paths (extends the Phase 12 MCP `stateView`
      fix to the orchestrator context).
- [ ] **Docs:** `docs/guides/agent-reliability.md` (retry/budget/resume/traces),
      ADR 0035 finalized, CHANGELOG, README index, `PLAN.md` phase ticked.
- **DoD:** reliability is measurable, gated in CI, guard-railed, documented, and
  proven on the offline mock with recorded real-provider fixtures.

---

## 3. Definition of Done (whole sub-plan)

With the **offline mock provider** and no network, plus recorded real-provider SSE
fixtures:

- A transient provider error (429/503/network) is **retried transparently** with
  backoff + `Retry-After`; a permanent one **fails fast** with a typed,
  honestly-`retryable`-flagged error, on all three surfaces.
- A stalled stream is caught by an **idle timeout**, not a 10-minute hang.
- **Multi-turn chat/edit is coherent** — prior turns reach the model; "make it
  shorter" resolves its referent.
- Context **never overflows**: it is token-budgeted, tiered, selection-scoped, and
  the agent loop stays bounded over long runs — with an honest notice when trimmed.
- An agent run **recovers** from tool failures, **resumes** after interruption,
  **self-repairs once** against the Critic, and **cannot exceed its action budget**.
- **Agent mode runs against a real provider** end to end; nothing auto-applies.
- Every turn is **traced**; the **eval matrix + budget guards are green in CI**;
  ADR + guide + CHANGELOG landed. `pnpm verify` green.

---

## 4. Suggested branch / PR sequence

`feat/reliab-r0-contracts-evals` → `…-r1-resilient-transport` →
`…-r2-context-history` → `…-r2-context-budget` → `…-r3-agent-failure-budget` →
`…-r3-checkpoint-resume` → `…-r3-auto-repair` → `…-r4-real-provider-agent` →
`…-r5-observability-guardrails`. Never combine phases into one PR.

---

## 5. Risks & mitigations

| Risk                                          | Mitigation                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Streaming retry replays a half-emitted turn   | Retry only _before_ first chunk; mid-stream drop → retryable error, user/loop re-runs. |
| Token estimate drifts from real tokenizer     | Conservative headroom in the budget; exact tokenizer is a §7-gated optional upgrade.   |
| History threading balloons the prompt         | History is a _tier_ under the same budget; oldest turns trimmed first.                 |
| Checkpoint state bloats conversations         | Store patch ids + ops, not full snapshots; size budget; prune on completion.           |
| Auto-repair loops forever                     | Exactly one bounded repair pass; reuses the failure-budget + no-progress halts.        |
| Provider fallback leaks data to a 2nd vendor  | Off by default; explicit config + security-review (§7 A5).                             |
| Real-provider agent executes an unwanted edit | Unchanged: validate→apply gate + human approval; nothing auto-applies.                 |

---

## 6. Invariants this sub-plan must never break

Restates §0: (1) no `project.fp.json` schema change; (2) AI edits only via the
validated patch path, human-approved; (3) render vs. preview; (4) no dep/IPC/store
without §7 approval; (5) small reviewable PRs; (6) one policy across all three
surfaces; (7) **don't fake capability** — gated features (preview render, exact
tokenizer) stay honestly gated, never stubbed to look done.

---

## 7. Approvals required BEFORE crossing each gate (CLAUDE.md §5)

Resolve with the user before the relevant phase; record the decision inline.

| #   | Gate                                                                                                             | Phase | Why it needs approval                              | Decision                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A1  | **Agent-run checkpoint store** (reuse conversation persistence; new persisted data outside the project schema)   | R3    | New persisted state (CLAUDE.md §5)                 | ✅ approved 2026-07-04 — done as a `CheckpointEvent` on the conversation event log (no separate store) |
| A2  | **Renderer→engine preview IPC channel** for in-loop preview render                                               | R3    | Broadens the IPC surface + security review         | ☐ pending                                                                                              |
| A3  | **Exact tokenizer dependency** (e.g. a tiktoken/Anthropic token counter) — _optional_ upgrade over the heuristic | R2    | New runtime dependency + `pnpm license:scan`       | ☐ optional — heuristic ships first                                                                     |
| A4  | **Anthropic prompt-caching** (`cache_control`) — provider behavior change, no dep                                | R2    | Changes provider request shape                     | ✅ approved + done 2026-07-04                                                                          |
| A5  | **Provider fallback** (secondary provider on failure)                                                            | R1    | Data egress to a second vendor; off by default     | ☐ pending                                                                                              |
| A6  | **Conversation record versioning/migration**                                                                     | R5    | Changes a persisted format (needs migration guard) | ☐ pending                                                                                              |

> Everything else (retry/backoff, timeouts, typed errors, history threading, token
> budgeting, agent compaction, failure budgets, auto-repair, tracing, eval harness)
> needs **no new dependency, no schema change, and no new IPC surface** — it is pure
> logic and wiring at the existing seams, so it can proceed without a gate.
