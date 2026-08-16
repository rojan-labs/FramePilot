# ADR 0035 — Reliable agent orchestration: resilient transport + budgeted context

- **Status:** Accepted (partial — R0, R1, R2·B1/B2/B3/B4, R3·C1/C3/C4 landed; R2 B5,
  R3 C2/C5, R4, R5 pending)
- **Date:** 2026-07-03
- **Phase:** Reliability sub-plan (`plan/AGENT-ORCHESTRATION-RELIABILITY.md`)
- **Relates to:** ADR 0012 (AI infra), ADR 0033 (streaming sidebar), ADR 0034 (MCP
  hardening — same "one policy, all surfaces" principle applied to the AI core)

## Context

The AI layer was feature-complete but not _reliable_. Verified in-tree (2026-07-03):

1. **No provider resilience.** Every provider `throw`ed a bare `Error` on the first
   non-2xx — no retry, no backoff, no `Retry-After`/429 handling, no way for a caller
   to tell a transient 503 from a permanent 401. `ErrorEvent.retryable` was hardcoded.
2. **No timeouts inside the SDK.** Only the desktop hub's coarse 10-minute run cap
   existed; a stalled SSE hung until that cap.
3. **No conversation history reached the model.** `buildContext` emitted only
   `[system, current-prompt]`, so "make _it_ shorter" could never resolve its referent.

These are transport/context concerns that must hold identically no matter which surface
(browser direct, desktop hub, MCP) drives the orchestrator.

## Decision

Add a small, dependency-free **reliability core** in `packages/ai-sdk/src/reliability/`
plus a provider-level error classifier, and thread conversation history into context.

### Contracts (`reliability/types.ts`)

- **`ProviderError`** — a typed error with `kind` (`rate_limit | overloaded | server |
network | auth | bad_request`), `status?`, `retryAfterMs?`, and a `retryable` flag
  **derived once** from `kind` (auth/bad_request are terminal; the rest are transient).
- **`RetryPolicy`** — bounded attempts, base/max delay, jitter fraction (default: 3
  tries, 500 ms → 4 s ceiling, 50% jitter).
- **`Usage`** `{ inputTokens, outputTokens }`, **`TurnTrace`** (mode/provider/latency/
  usage/retries/tool-calls/validator-rejections/abort/timeout), **`ContextBudget`** +
  ordered **`CONTEXT_TIERS`** (for R2's tiered budgeting).

### Resilient transport (R1)

- **`providers/errors.ts`** classifies an HTTP response or thrown error into a
  `ProviderError` (parsing `Retry-After` as delta-seconds _or_ HTTP-date). The Anthropic
  and NVIDIA providers now throw these from both `complete()` and `stream()`.
- **In-stream error frames (added 2026-07-30).** A 200 response can still fail mid-body,
  and both wire formats say so inside the stream: Anthropic sends
  `{"type":"error","error":{"type":"overloaded_error",…}}`, OpenAI-compatible gateways send
  `{"error":{"message":…}}`, and both then close the body normally. `classifyStreamError`
  turns such a frame into the same typed `ProviderError` a non-2xx produces, and
  `parseAnthropicSse`/`parseOpenAiSse` **throw** it. Before this, the frame was skipped: the
  stream ended with no content, so an upstream outage reached the orchestrator disguised as a
  successful, empty answer — which the agent loop read as "the model has nothing to add" and
  closed with "Done — no further edits." on an unchanged timeline. Because the frame arrives
  before any forwardable chunk, `ResilientProvider` retries it under the normal policy.
  Defence in depth for the same failure lives one layer up: a turn with neither prose nor a
  tool call is a failed turn, never a finished run (`orchestrator.ts#runTurn`).
- **`reliability/retry.ts`** — pure `withRetry`: exponential backoff + symmetric jitter,
  honors `retryAfterMs`, aborts instantly on signal, never retries a terminal error. The
  final attempt runs outside the loop so there is no unreachable branch.
- **`reliability/timeout.ts`** — `withConnectTimeout` (bounds the wait for response
  headers) and a resettable `IdleTimeout` (fires if no chunk arrives within N ms). Both
  use injectable timers.
- **`providers/resilient-provider.ts`** — `ResilientProvider implements AiProvider`
  decorates any provider so the concrete providers stay dumb (invariant: **one policy,
  three surfaces**). `complete()` retries fully; `stream()` retries only _before the
  first forwardable chunk_ (a half-streamed turn can't be replayed) — a mid-stream drop
  becomes a typed retryable error and a caller-abort ends the stream cleanly. It captures
  `Usage` from a new non-forwarded `usage` `ProviderChunk` variant and reports retries/
  usage/timeouts via hooks (the `TurnTracer` seam).
- Wired at every construction site via `withResilience`/`createResilientProvider`: web
  `createOrchestrator`/`createAiSession`/agent, desktop `getOrchestrator`.

### Context history (R2·B1)

- `ContextInput` gains `history?: readonly AiMessage[]`; `buildContext` threads a bounded
  most-recent window (`boundedHistory`, `MAX_HISTORY_MESSAGES=8`) between the system
  contract and the current context+prompt. The canonical two-message shape is unchanged
  when history is absent. The web sidebar maps the active conversation's events →
  messages with a pure `historyFromEvents` and passes them through the session.

### Token budgeting + agent bounding (R2·B2/B4, R3·C1)

- **B2 — tiered budgeting.** `assembleContext` builds every context tier and, when the
  estimated size (`estimateTokens`, ≈4 chars/token) would exceed
  `budget = contextWindow − maxOutputTokens − headroom`, drops the lowest-priority
  present tiers first (transcript → timeline → memory → history → selection). Each drop
  raises a `NotificationEvent` (never silent). The default budget is generous, so
  small/medium projects are unchanged; callers tighten it via `ContextInput.budget`.
- **B3 — selection-scoped timeline.** `summarizeTimeline(…, focus)` (via `focusedClipIds`)
  shows the clips overlapping a selection plus their immediate neighbours in full and
  collapses the rest to a count/span; `assembleContext` passes the selection through.
- **B4 — agent compaction.** `compactAgentLog` keeps the last K step notes verbatim and
  digests older ones into one line, so a long agent run's fed-back log stays bounded.
- **C1 — blast-radius caps.** `AgentOptions.maxOpsPerTurn`/`maxOpsPerRun` reject a
  runaway turn and stop a run that exceeds its op budget, with diagnostics — layered on
  the existing no-progress halt; nothing auto-applies.
- **C3 — bounded auto-repair.** After the run, `attemptRepair` grants exactly one pass
  targeting only the Critic's _fixable_ findings (`FIXABLE_CHECKS`; render-gated checks
  excluded, not stubbed), through the same validate→apply gate, then re-critiques. Opt
  out via `autoRepair:false`; never auto-applies.
- **C4 — plan ledger.** `AgentOptions.planFirst` runs one read-only planning turn;
  `parsePlanLines` cleans the steps into `AgentRun.plan`, threaded into each loop turn.

## Why this touches no schema / dependency / IPC surface

- **No `project.fp.json` change** (invariant 1): traces are transient; history is derived
  from the existing conversation store; the `usage` chunk is a transport detail.
- **No new runtime dependency** — the token estimate (R2) is a chars/≈4 heuristic; the
  exact tokenizer stays §7-gated.
- **No new IPC channel** — resilience is pure logic at existing seams. Desktop history
  threading is deferred because it _would_ need the `AiStreamRequest` contract to carry
  history (a §7-gated change).

## Consequences

- A transient provider failure is now retried transparently on every surface; a permanent
  one fails fast with a typed, honestly-`retryable`-flagged error. A stalled stream is
  caught by an idle timeout, not a 10-minute hang. Multi-turn chat/edit is coherent.
- New pure-logic modules are at **100% coverage**. The `TurnTracer` is built but not yet
  called from the orchestrator turn boundaries, and there is no eval harness yet — both
  are tracked under R5. Provider fallback and prompt-caching remain §7-gated.

## Alternatives considered

- **Retry inside each provider** — rejected: forks the policy per provider/surface,
  violating "one policy, three surfaces".
- **Editing `sse.ts` for the idle heartbeat** — rejected in favor of a per-chunk
  `beat()` in the decorator's iterator wrapper, so the raw SSE reader stays untouched
  and the timeout policy lives with the rest of the resilience logic.
- **Splitting context into separate context/prompt messages always** — rejected: would
  break the stable two-message shape; history is inserted only when present.
