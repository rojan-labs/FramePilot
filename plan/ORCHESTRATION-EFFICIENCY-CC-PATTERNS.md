# Orchestration Efficiency — Patterns from the Claude Code Loop

> **Sub-plan convention:** tracked from `plan/PLAN.md`. Status legend matches the
> master plan: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked.
>
> **Source:** a study of the de-minified Claude Code source mirror
> (`github.com/tanbiralam/claude-code`, snapshot 2026-05) — the production
> orchestration loop behind Claude Code itself. We treat it as a **reference
> architecture to learn from**, not code to copy: the repo is Anthropic's
> proprietary source republished by a third party, so **no code may be ported
> verbatim**. Every task below is a from-scratch implementation of a *pattern*.
>
> **Scope:** `packages/ai-sdk` (Conductor/orchestrator, tool registry, context
> builder) with small ripples into `packages/shared-types` (events) and the
> web-editor sidebar. No timeline-schema changes. Desktop-first (CLAUDE.md):
> every latency win is measured against desktop-scale projects.

---

## 0. Why this doc exists

FramePilot's agent loop (Conductor reducer + effect handlers, ADR 0055–0057) is
already strong on *correctness*: per-call validation against a speculative
working copy, spin guard via novelty keys, per-run analysis/op budgets,
checkpoint/resume, wipe guard, pinned skills. The reference loop is strong on
things we haven't built yet — **latency** (concurrent read batches), **token
efficiency** (micro-compaction, cache-stable prompt prefixes, deferred tool
schemas), and **honest self-termination** (token-budget diminishing-returns
detection). This plan closes exactly that gap.

### How the reference handles orchestration efficiently (findings)

1. **Concurrency-safe tool partitioning** (`services/tools/toolOrchestration.ts`).
   A turn's tool calls are partitioned into batches: consecutive *read-only*
   calls form one batch executed **concurrently** (bounded pool, default 10,
   env-tunable); any mutating call is its own batch executed **serially**.
   Each tool self-declares via `isConcurrencySafe(parsedInput)`; a parse
   failure or a throw inside the predicate conservatively means *not* safe.
2. **Deterministic context updates under concurrency.** Concurrent tools never
   mutate shared context; they yield *context-modifier functions* that are
   queued per tool-use id and folded **after** the batch settles, in original
   call order. Concurrency never changes observable state ordering.
3. **Generator-composition streaming.** The whole loop is `AsyncGenerator`
   all the way down (`query → queryLoop → runTools → runToolUse`), with a
   fan-in combinator (`all(gens, maxConcurrency)`) that merges progress from
   concurrent tools into one ordered event stream. The UI streams per-tool
   progress live even mid-batch.
4. **Micro-compaction instead of only wholesale summarization**
   (`services/compact/microCompact.ts`). Old tool *results* from a whitelist
   of high-volume, re-derivable tools (file reads, shell output, grep/glob,
   web fetch/search) are cleared in place — `"[Old tool result content
   cleared]"` — driven by cheap token estimation, before any expensive
   summarize-everything compaction fires. Cache deletion is *notified* so the
   prompt-cache layer knows the prefix changed. Separate tiers exist
   (auto-compact, API-side micro-compact, time-based config).
5. **Prompt-cache stability as an explicit invariant** (`utils/queryContext.ts`,
   `utils/toolPool.ts`). The cache-key prefix (system prompt, user context,
   system context) is assembled by one shared helper used by *every* entry
   path, so side paths reproduce byte-identical prefixes and keep cache hits.
   The tool array is partition-sorted (built-ins as a contiguous sorted
   prefix, MCP tools after) purely so the serialized tool block is stable
   across turns.
6. **Token budget with diminishing-returns detection** (`query/tokenBudget.ts`).
   A turn may auto-continue with a nudge while under 90% of its budget, but
   stops early when three consecutive continuations each produced < 500 new
   tokens — "spinning without output" is detected *by token delta*, not just
   by repeated identical calls.
7. **Uniform background-task framework** (`Task.ts`, `tasks/*`). Every
   long-running thing (shell, subagent, remote agent, workflow, monitor) is
   one `TaskType` with disk-backed output + read offset (tail-able after
   crash), a terminal-status guard (`isTerminalTaskStatus`) protecting every
   inject/kill path, and completion that *re-invokes the model* rather than
   the model polling.
8. **Tool-surface trimming per role.** Coordinator mode filters the advertised
   tool array to an orchestration-only allowlist; deferred tools ship name-only
   until a `ToolSearch` call loads their schema. Both exist to keep the
   per-turn prompt small and the cache prefix stable.

### What FramePilot already has (do not rebuild)

| Reference pattern | Our equivalent | Verdict |
| --- | --- | --- |
| Spin guard by repeated-call detection | `callNoveltyKey` + read memo + `STALL_CONFIRM_TURNS` | ✅ have |
| Per-run budgets | analysis budget (B5.4), op budget (R3 C1) | ✅ have |
| Rolling history window | `compactAgentLog` (R2 B4) | ✅ have, extend in E2 |
| Pinned context | skills ledger (ADR 0057) | ✅ have |
| Checkpoint/resume | Conductor `resume` handler (R3 C2) | ✅ have |
| Plan-then-execute | `draftPlan` + plan ledger (R3 C4) | ✅ have |
| Streamed generator loop | `streamAgent`/Conductor emit stream | ✅ have |
| Read-only vs mutating taxonomy | `ToolKind` (`read`/`analysis`/`mutate`/`action`/`ask`) | ✅ have — E1 builds on it |

### The gaps this plan closes

- **E1** Turn tool calls run strictly serially (`executeToolCalls` awaits each
  call in order) — even pure reads (`get_timeline` + `get_transcript` +
  `read_asset_metadata` in one turn) serialize their sidecar round-trips.
- **E2** History management is *only* a rolling window; old read/analysis
  payloads inside the window are carried verbatim until they fall off the end.
- **E3** Nothing guarantees the per-turn prompt prefix is byte-stable across
  turns of one run; tool descriptor order comes from registry insertion order
  and per-turn context is re-derived each turn with no stability test.
- **E4** The run stops on op budget or stall, but a run that keeps producing
  *small, novel-looking* output can burn the whole budget; there is no
  token-delta diminishing-returns stop.
- **E5** The advertised tool surface is all-or-nothing (`agentTools()` filters
  only on vision); read-only routes (question/chat) still advertise the full
  mutating surface.

---

## 1. Non-negotiable invariants (from AGENTS.md + existing sub-plans)

- Mutating calls stay **strictly serial** — the speculative working copy
  (`turnCtx` threading in `executeToolCalls`) is the correctness backbone;
  concurrency applies to `read`/`analysis` kinds only, and only between
  mutations.
- Event stream ordering guarantees consumed by the sidebar (`emit.toolCall
  running → settled → toolResult`) hold per call; concurrent calls may
  interleave *between* calls but never within one call's lifecycle.
- No behavior change to validation, wipe guard, budgets, or the Conductor
  reducer contract without its parity harness updated in the same PR.
- 100% coverage stays on core deterministic modules; every phase lands with
  its tests in the same PR.
- No verbatim code from the reference repo (provenance — see header).

---

## 2. Phases

### E1 — Concurrent read batches in a turn `[x]` (Owner: ai-tooling-engineer) — ADR 0060

The highest-leverage latency win: desktop runs make several sidecar-backed
reads per turn and currently pay them in sequence.

- [x] `[E1.1]` Add `concurrencySafe(tool, parsedArgs): boolean` to the tool
      registry seam: `kind === 'read' || kind === 'analysis'` ⇒ safe by
      default, with a per-tool opt-out flag for reads that are stateful
      (anything touching the run's read memo stays safe — the memo is
      keyed per call and consulted before dispatch). Any predicate error ⇒
      **not** safe (conservative, like the reference).
      *Done: `concurrencySafe()` in `tool-registry.ts`; `ToolSpec.serialOnly`
      opt-out flag, applied to `load_skill` (ordered, bounded skill ledger).*
- [x] `[E1.2]` Partition a turn's `calls` into batches inside
      `executeToolCalls`: runs of consecutive concurrency-safe calls become
      one concurrent batch (bounded pool, `FRAMEPILOT_MAX_TOOL_CONCURRENCY`,
      default 4 — sidecar-friendly, measured before raising); every other
      call is a singleton serial batch. **Order of results, notes, callFacts,
      and emitted events per call must equal today's serial order** — collect
      per-call outcomes and fold them in original call order after the batch
      settles (reference pattern #2).
      *Done: `concurrency.ts` (`partitionConcurrencyBatches` + `mapBounded`);
      discovered hazard closed: duplicate novelty keys split batches so a
      repeat read still hits the memo and stays non-novel for the spin guard.*
- [x] `[E1.3]` Working-copy rule: a concurrent batch never contains a call
      that returns `project`; assert this and fall back to serial if a
      supposedly-safe call unexpectedly returns ops (fail loud in dev, safe
      in prod). *Done: dev throw / prod log + deterministic in-order fold.*
- [x] `[E1.4]` Cancellation: `signal.aborted` mid-batch settles every
      in-flight card as `cancelled` (never a checkmark) and skips remaining
      batches — matching today's single-call semantics.
- [x] `[E1.5]` Env var: add `FRAMEPILOT_MAX_TOOL_CONCURRENCY` to root
      `.env.example` + `turbo.json` `globalEnv` (CLAUDE.md §2).
- [x] `[E1.6]` Tests: batch partition unit tests (kind mix, opt-out, predicate
      throw); event-order golden test (concurrent batch yields the same
      event sequence as serial for the same outcomes); cancellation
      mid-batch; orchestrator-stream integration test with a slow fake
      sidecar proving overlap is observable.
      *Done: `concurrency.test.ts` (15), registry `concurrencySafe` suite (5),
      5 streamAgent E1 integration tests; ai-sdk 1417 tests, 100% coverage.*
- [x] `[E1.7]` Perf evidence (performance-monitor): before/after turn latency
      on a desktop-scale fixture with 3+ reads per turn.
      *Done: 3 analysis reads/turn, 120ms fake sidecar round-trip —
      pool=1 (old serial): 374ms → pool=4 (default): 123ms, **3.05×**.*

### E2 — Micro-compaction of old tool results `[x]` (Owner: ai-tooling-engineer)

- [x] `[E2.1]` Whitelist the compactable note sources (read/analysis results:
      timeline reads, transcript, asset metadata, search hits, silence/scene
      analysis) — **never** compact: mutation notes, validator rejections,
      pinned skills, steering lines, the plan block.
      *Done: the whitelist is structural — only read/analysis results carry
      the ` → payload` note shape, so mutation notes (`Trimmed … · …`),
      rejections (`Rejected "…" —`), plan/steering never match; steering
      entries and `ask_user` answers (`→ they answered:`) are spared
      explicitly on top; pinned skills never ride in the log (ADR 0057).*
- [x] `[E2.2]` In `compactAgentLog`, add an in-place clearing tier that runs
      *before* the rolling window drops lines: when the estimated log token
      size exceeds a threshold, replace the *payload* of old compactable
      notes (older than the last N turns) with a fixed marker
      (`[old result cleared — re-read if needed]`) while keeping the one-line
      "what was called and whether it succeeded" prefix. The read memo makes
      a re-read cheap if the model actually needs the data again.
      *Done: `clearNotePayloads` + threshold tier in `compactAgentLog`
      (`AGENT_LOG_CLEAR_THRESHOLD_TOKENS` 1000, `AGENT_LOG_PAYLOAD_FRESH` 2,
      payloads under 160 chars kept — nothing worth a re-read).*
- [x] `[E2.3]` Cheap token estimation helper in `ai-sdk` (chars/4 heuristic —
      same tier the reference uses for this decision); no tokenizer dep
      without §5 approval. *Done: reused the existing `estimateTokens`
      (context-builder.ts, R2 B2) — no new helper, no dep.*
- [x] `[E2.4]` Tests: clearing preserves prefixes + pinned classes; threshold
      boundaries; a cleared read followed by a repeat call is served by the
      read memo (existing behavior) — integration test proving the loop
      still converges on a long fixture run.
      *Done: 10 unit tests (mixed-entry mutation-note survival, exact
      threshold boundary, multiline digests, ask/steering sparing) + a
      streamAgent integration test (marker in the fed-back log, memo-served
      repeat, honest convergence). 1434 tests, 100% coverage.*

### E3 — Prompt-prefix cache stability `[x]` (Owner: ai-tooling-engineer + lead-prompt-engineer)

- [x] `[E3.1]` Audit `agentMessages` + `buildContext` for per-turn instability
      (anything derived from clocks, Map iteration order, unsorted lists).
      Document findings in the PR.
      *Findings: no clocks/randomness anywhere in the context path; the two
      Maps (`assetKinds` from the project index, `loadedSkills`) iterate in
      deterministic insertion order. TWO real defects: (1) the turn-varying
      steering block was interleaved BEFORE the run-stable skills block, so a
      steered turn voided the cached prefix at the steering point; (2) tool
      descriptors rode in registry insertion order with no stability
      guarantee. Both fixed below.*
- [x] `[E3.2]` Make the run-stable prefix explicit: system/instruction +
      project header + skills block assembled once per run and reused by
      every turn *and* the repair pass (one shared helper, reference pattern
      #5); only the action log / plan-ledger suffix varies per turn.
      *Done: `agentStableInstruction` (memoized per run on the skill ledger),
      composed as [stable head][steering + action log]; the repair pass
      already flows through `agentMessages`, so it shares the helper.*
- [x] `[E3.3]` Sort tool descriptors deterministically (stable name sort) in
      `toolDescriptors` so the serialized tool block is byte-identical
      across turns and runs. *Done: byte-order name sort (not localeCompare —
      locale-dependent); MCP builds from `TOOL_REGISTRY` directly, unaffected.*
- [x] `[E3.4]` Golden test: two consecutive turns of one run produce
      byte-identical message prefixes up to the first turn-varying block;
      repair pass reproduces the same prefix.
      *Done: 4 golden tests (consecutive turns, steered turn, repair pass,
      skill-pin revalidation) + 2 descriptor-ordering tests.*

### E4 — Diminishing-returns stop (token-delta) `[x]` (Owner: ai-tooling-engineer)

- [x] `[E4.1]` Track per-turn output-token delta in the Conductor's cost
      accumulator (we already fold `turn.usage` per turn — keep the last K
      deltas in reducer state).
      *Done: `AgentTurnResult.usage` (threaded from the runTurn handler) +
      `ConductorState.recentOutputDeltas` bounded to the configured K.*
- [x] `[E4.2]` Reducer rule: after ≥3 consecutive turns each under a small
      delta threshold **and** zero applied ops in those turns, stop the run
      with an honest completion note (distinct from the stall notice — this
      is "converged", not "spinning"). Thresholds as named constants;
      tunable via `AgentOptions`.
      *Done: `DIMINISHING_RETURNS_TURNS`=3, `DIMINISHING_RETURNS_MIN_OUTPUT_TOKENS`
      =120 (sized so a tool-calling working turn never trips it); tunable via
      `AgentOptions.diminishingReturns`. A turn with no reported usage resets
      the window — a streak must be provable end-to-end. Stall is checked
      first, so a genuine stall keeps its more specific notice.*
- [x] `[E4.3]` Emit the decision as a structured event so the sidebar can say
      *why* the run ended; log via `orchestratorLog.action`.
      *Done: notification with `reason: 'diminishing_returns'` + delta detail;
      the driver (the reducer stays pure) logs it via `log.action`.*
- [x] `[E4.4]` Tests: reducer unit tests (boundary, interleaved productive
      turn resets the streak); parity-harness update.
      *Done: 7 reducer table tests (streak, exact-threshold boundary,
      non-uniform window, applied/usage-gap resets, tuned options, stall
      precedence), streamAgent + legacy `agent()` mirror tests (the legacy
      loop got the same rule for path parity), and a parity-harness scenario
      proving both control paths converge at the same turn. 1446 tests, 100%
      coverage.*

### E5 — Route-scoped tool surface `[x]` (Owner: ai-tooling-engineer + lead-prompt-engineer)

> **Audit correction (2026-07-16):** this doc's gap statement ("read-only
> routes still advertise the full mutating surface") was stale — the question/
> chat route (`streamChat`, `chat()`, the gateway `chat` mode) sends **zero**
> tool descriptors today and does not execute tool calls. So the DoD invariant
> ("question route advertises no mutating tools") already held incidentally;
> E5.1 makes it an *enforced, tested* ceiling via the scope seam rather than an
> accident of the toolless implementation.

- [x] `[E5.1]` `agentTools(scope)`: the `question`/chat route advertises only
      `read`/`analysis`/`ask` kinds (it can't apply ops anyway); the agent
      route keeps the full surface. Uses the existing `tool-scope.ts` seam
      if it fits — extend, don't duplicate.
      *Done: `agentTools('agent' | 'question')` built on the K6.2 seam
      (`selectTools` under the new `QUESTION_ROUTE_PERMISSIONS` grant —
      read+analysis, never write/render); vision gate applies in both scopes;
      every existing caller keeps the `'agent'` default unchanged.*
- [x] `[E5.2]` Measure prompt-size saving on the question route (tokens per
      turn, desktop fixture) and record it in the PR.
      *Measured (chars/4 estimator over the serialized descriptor block):
      full agent surface 48 tools ≈ **5824 tokens**; question scope 16 tools
      ≈ **1775 tokens** (−70%); what the question route actually sends today
      = 0 tokens. The scope is the ceiling if/when Q&A gains tool use.*
- [x] `[E5.3]` Tests: scope filtering; a question-route run never sees a
      mutating descriptor; MCP server surface unaffected (mcp-engineer
      sign-off). *Done: 6 tests (kind whitelist, no mutating/rendering
      descriptor, vision gate, unchanged agent default, registry untouched,
      measured saving locked at <60%); mcp-server suite green (108/108 —
      builds from `TOOL_REGISTRY` directly).*
- [x] `[E5.4]` *(stretch, separate decision)* Deferred tool schemas
      (name-only until requested) — **do not build** without a measured
      prompt-size problem after E5.1; record verdict here.
      **Verdict: not built.** The question route sends zero descriptors and
      the agent surface is 48 tools ≈ 5.8k estimated tokens — real but not
      the measured problem this stretch requires, especially with E3's
      byte-stable descriptor block making it fully prompt-cacheable.
- [x] `[E5.5]` *(added 2026-07-16)* The question route gained REAL tool use
      under its E5 scope. Root cause of "ask doesn't work": `streamChat` sent
      no tools and executed no calls, so `ask_user` (P12) could never fire on
      a question/chitchat-classified turn — the model answered in plain text
      instead of presenting options. *Done: `streamChat` runs a bounded tool
      loop (`QUESTION_ROUTE_TOOL_TURNS`, final turn tool-less so it always
      ends in a real answer) over `agentTools('question')` via the shared
      `executeToolCalls` (ask event → AskUser gate pause → answer feeds next
      turn, identical to agent mode); out-of-scope mutating/render calls are
      refused with an honest failed card; `streamAuto`'s question case and
      both hosts (web `BrowserAiSession` chat mode, desktop `streamFor` chat
      case) thread `AgentRunControls` through; classifier prompt routes
      "ask me / offer options / help me decide" to `question`, never
      chitchat. Tests: 7 new streamChat tool-use tests + 1 streamAuto
      controls-threading test; ai-sdk coverage back at 100%.*
      *Follow-up (same day): with the tool available the model still wrote its
      question — options and all — as plain markdown (its chat prior), so no
      selectable UI rendered. Fixed at the prompt layer, the way reference
      harnesses do (Claude Code's AskUserQuestion): the agent contract
      (`AGENT_CONTRACT_TAIL`), a new `QUESTION_MODE_INSTRUCTION` appended on
      every question-route run, and the `ask_user` tool description all now
      state that the tool is the ONLY channel for questions — a question in
      reply text cannot be clicked or answered and just ends the run. Tests
      pin the rule in both contracts and in the question route's request.*

---

## 3. Sequencing

E1 and E3 are independent — start with E1 (biggest user-visible win). E2
depends on E3.2 (compaction must not churn the stable prefix). E4 is
reducer-only and can land any time. E5 last (smallest win, touches prompt
surface reviewed by lead-prompt-engineer).

One PR per phase (E1 may split registry seam / executor). Branch prefix:
`feat/orch-efficiency-e<N>-…`.

## 4. Definition of Done (whole sub-plan) — met 2026-07-16

- [x] Turn latency on the 3-read desktop fixture measurably improved (E1
      evidence: 374ms → 123ms, 3.05× with a 120ms fake sidecar round-trip).
- [x] Long-run prompt tokens bounded with cleared-payload markers (E2
      evidence: integration test — marker in the fed-back log past the
      threshold, memo-served repeat, honest convergence).
- [x] Prefix-stability golden tests green (E3); provider cache hits observable
      in logs where the provider reports them (the byte-stability tests are
      the invariant we own — see §5).
- [x] Runs converge with an honest "converged" notice instead of burning
      budget (E4; tagged `diminishing_returns`, parity across both loops).
- [x] Question route advertises no mutating tools (E5 — enforced ceiling;
      audit found it was already toolless, see the E5 note).
- [x] `pnpm verify` green (ai-sdk 1452 tests at 100% coverage; mcp-server
      108/108); parity harness updated (E4 scenario); docs: ADR 0060 for the
      concurrency model (E1); CHANGELOG entries for all four user-visible
      changes; PLAN.md updated per phase.

## 5. Risks

- **Sidecar contention (E1):** concurrent reads may thrash a busy sidecar —
  hence the conservative default pool of 4 and perf evidence before raising.
- **Event-order regressions (E1):** the sidebar assumes today's ordering;
  the golden event-order test is the gate.
- **Over-compaction (E2):** clearing a payload the model still needed costs a
  re-read turn — mitigated by the read memo and the "last N turns are never
  cleared" rule.
- **Cache-stability claims we can't verify (E3):** some providers don't report
  cache hits; the golden byte-stability test is the invariant we own.
- **Provenance:** patterns only, no ported code (see header).
