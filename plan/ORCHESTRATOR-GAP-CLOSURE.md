# FramePilot — Orchestrator + AI Sidebar Gap Closure

> **Sub-plan of `plan/PLAN.md`.** Read `plan/PLAN.md`, `AGENTS.md`, and `CLAUDE.md`
> before touching anything here. This document tracks remediation of a 2026-07-13
> three-agent audit of the AI orchestration layer (`packages/ai-sdk`), the desktop
> transport (`apps/desktop/electron/ai/ai-stream.ts`, `packages/shared-types/src/ipc.ts`),
> and the AI sidebar UI (`apps/web-editor/src/components/ai`). It complements, not
> replaces, `plan/AI-ORCHESTRATION-REDESIGN.md` (kernel architecture, ADR 0044) and
> `plan/AI-SIDEBAR.md` (sidebar build, M0–M9 complete) — this doc closes gaps found
> *within* that already-shipped architecture, not a rearchitecture.
>
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
>
> **Status:** `[x]` §2 (all bounded fixes) complete — 2026-07-13. §3's larger
> control-flow items remain deliberately deferred; see that section for why.

---

## 0. Why this doc exists

An audit (three parallel `Explore` passes over the orchestrator/kernel, the transport,
and the sidebar UI) found that the shipped architecture is sound — deterministic
Conductor reducer, per-call patch validation, honest degradation, a replay harness —
but several of its best pieces are **only wired to paths the default Agent-mode run
never takes**: the cost meter, the recovery/saga table, model-tier routing, and the
Semantic Index context source all exist and are tested, but `streamAgent` (the
dominant path since ADR 0055 routes nearly every edit through it) bypasses all four.
Symmetrically, the sidebar has UI (task DAG view, five `RunStatus` labels, persisted
`ConversationUiState`) with no event or wiring that ever drives it.

This doc splits findings into two buckets:

- **§2 Closing this pass** — bounded, single-package-or-two, testable in one PR each,
  no schema change, no new dependency. Landed slice by slice, one commit per item.
- **§3 Tracked, not attempted this pass** — real architecture work (recovery-table
  wiring into the agent loop, budget enforcement, tier routing for the agent path,
  swapping the agent loop's context source to the Semantic Index, live bidirectional
  desktop steering/approval) that the redesign doc already scopes at kernel-phase
  granularity. Attempting these as a side-quest inside a gap-closure pass would be
  exactly the "large unreviewed rewrite" CLAUDE.md §5/§6 warns against. They're
  recorded here so they aren't lost, with a pointer to where the real work belongs.

---

## 1. Audit findings this doc addresses (source)

1. Agent-mode runs (`streamAgent`) never emit `usage` — cost chip / session total
   silently incomplete for the dominant run type. (`orchestrator.ts:1884,1939,2079`
   emit it; `streamAgent`/`streamChat` don't.)
2. Five `RunStatus` values (`searching`/`reading`/`generating`/`running_tool`/
   `rendering`) have UI labels (`statusTone.ts:39-68`) but are never emitted.
3. `runOutcome.ts`'s `foldTurnEvent`/`emptyRunNotice` never checks `status === 'cancelled'`
   (only `'failed'`) — a user-stopped run that applied no edit falls through to
   `NO_EDIT_NOTICE` ("I couldn't turn this into an applicable timeline edit"), which
   reads as an AI failure rather than the user's own Stop click. **Correction after
   re-reading the source (2026-07-13):** the wire itself is fine — every stream path
   already `yield emit.status('cancelled')` before the generator ends
   (`orchestrator.ts` all six `stream*` methods + `conductor.ts` `cancelFinalize`),
   and `DesktopAiSession` yields that event before returning, so `AiSidebar.tsx:807`
   already sees `view.status === 'cancelled'` correctly. No transport/IPC change is
   needed — this is a one-file fix in `runOutcome.ts`.
4. `AiStreamEventMessage.event` is typed `unknown` (`ipc.ts:472`) and blind-cast to
   `AiEvent` in the renderer (`ai.ts:516`). **Correction after re-reading the source
   (2026-07-13):** `ipc.ts` documents *why* — `@framepilot/shared-types` cannot import
   `AiEvent` from `@framepilot/ai-sdk` without inverting the dependency (ai-sdk already
   depends on shared-types). That part of the design is intentional and correct, not a
   gap. The actual duplicate-literal drift risk the audit found lives one level down:
   `apps/desktop/electron/ai/ai-stream.ts` hand-declared its own 9-member `PROVIDERS`
   array instead of importing ai-sdk's canonical `PROVIDER_NAMES` (which that file
   already has access to, since it imports `Orchestrator` from the same package) — a
   real, fixable duplicate with a single source of truth one import away.
5. Six AI tools exist in the TS registry but not the Python engine registry
   (`set_caption_style`, `set_clip_speed`, `set_clip_crop`, `set_clip_blend_mode`,
   `add_marker`, `remove_marker`) — the Python dispatcher's `extra="forbid"` rejects
   them outright if a model driving the Python/MCP path names one.
6. `error.retryable`/`error.detail` are carried into `NoticeNode` but never read by
   any component — no inline Retry/Copy-details affordance on a retryable error;
   `detail` renders as a raw `<pre>` dump.
7. `ConversationUiState` (composer draft, tool-expansion, scroll offset) is
   schema-and-persistence-ready (`conversation.ts:41-49`, `useConversations.ts:210`)
   but the sidebar keeps all of it in local component state and never calls
   `setUiState` — reload silently loses draft/expansion/scroll.
8. `aria-live="polite"` sits on the same element `AiSidebar` virtualizes
   (`AiSidebar.tsx:1086-1090`) — screen readers hear row-mount churn from scrolling,
   not just new content; `ToolDetailsModal` has Escape handling but no focus trap.
9. `maxOpsPerTurn` default drift: 100 in `orchestrator.ts:135` vs. 40 in
   `conductor.ts:52`. **Confirmed live bug, not cosmetic (2026-07-13):**
   `conductor.ts:50`'s own comment claims "Defaults mirror the orchestrator's
   agent-loop constants exactly" — true for `maxSteps`/`maxOpsPerRun`, false for
   this one. Because the reducer's `onTurnResult` (`conductor.ts:617`) rejects a
   turn against `state.config.maxOpsPerTurn` independently of the orchestrator's
   own handler-level check, an agent run with no explicit `agentOptions.maxOpsPerTurn`
   was silently capped at 40 ops/turn, not the documented 100.

## 2. Closing this pass

### Phase A — Transport correctness (shared-types, desktop)

- [x] **A1. Dedupe the provider-name allowlist.** `ai-stream.ts`'s `PROVIDERS`
  constant now imports and re-uses ai-sdk's `PROVIDER_NAMES` instead of
  hand-declaring the same 9 names a second time — a provider rename/add/remove now
  fails typecheck on the assignment instead of silently drifting between two
  independently-maintained lists. `AiStreamEventMessage.event: unknown` is left as
  documented/correct (see corrected finding #4 above) — fixing it would require
  inverting the shared-types↔ai-sdk dependency, which is out of scope for a gap
  patch.
- [x] **A2. Distinguish a cancelled run from an empty edit in `runOutcome.ts`.**
  Add a `cancelled` flag to `TurnSignals`, set it on `status === 'cancelled'` in
  `foldTurnEvent`, and short-circuit `emptyRunNotice` to return `null` when
  cancelled (same priority as the existing `failed` short-circuit) so a stopped
  run doesn't show `NO_EDIT_NOTICE`. No IPC/transport change — the wire already
  carries the `cancelled` status correctly (see corrected finding #3 above).

### Phase B — Python tool registry parity (engine)

- [x] **B1. Register the six missing tools** (`set_caption_style`, `set_clip_speed`,
  `set_clip_crop`, `set_clip_blend_mode`, `add_marker`, `remove_marker`) in
  `engine/python/framepilot_engine/ai_tools/registry.py` + `handlers.py` +
  `dispatch.py`, reusing `CaptionStyle`/`CropRect`/`BlendMode` from
  `timeline.models` verbatim (no drift-prone re-declaration) and returning raw
  operation dicts per the existing project-scoped-op pattern (these six, like
  `add_asset`/`manage_assets`, aren't part of the Python `Operation` union —
  applied/validated on the TS editor-core side). New
  `test_tool_registry_ts_parity.py` parses `tool-registry.ts` source directly
  (mirrors `test_schema_parity.py`'s no-build-step convention) and fails loudly
  on any future name-set divergence in either direction. `pnpm engine:test`
  (654 passed), `engine:lint`, `engine:typecheck` all green.

### Phase C — Orchestrator event richness (ai-sdk)

- [x] **C1. Emit `usage` from `streamAgent`.** Accumulates real token/cost across
  the ADR 0055 classifier call (threaded in as `streamAgent`'s new optional
  `initialCost` param), each turn's `streamAssistant` call, and the Critic repair
  pass; emits `emit.usage(...)` once at `finalize` **and** at the mid-throw
  `settle` path, alongside the terminal diff — mirroring `streamRecipe`/
  `streamEditVariations`'s shape exactly. Also fixed a latent bug where a
  `complete()`-only (non-streaming) provider's real usage never reached any
  caller at all (`providerChunks` dropped it). Priced at the `'mid'` tier, same
  untiered default `editVariations` already uses for analogous calls.
- [x] **C2. Emit the unused `RunStatus` values where they already apply.** New
  `statusForToolCalls` emits `reading` for all-read turns, `searching` for
  read/analysis-only turns with an ffmpeg-backed analysis call, `running_tool`
  otherwise (conservative default for mutating/action/unknown calls); `generating`
  fires once per turn right before `streamAssistant`, before tool calls are known.
  Only the five values the UI already renders — no new vocabulary. The frozen
  `streamAgent-golden.test.ts.snap` was deliberately regenerated and diffed by
  hand to confirm it contains exactly the new `usage`/status events plus
  consequent id renumbering. `pnpm --filter @framepilot/ai-sdk test`
  (1181 passed), `typecheck`, `lint` all green.
- [x] **C3. Fix `maxOpsPerTurn` default drift** — `conductor.ts`'s
  `DEFAULT_MAX_OPS_PER_TURN` corrected from `40` to `100` to match
  `orchestrator.ts` and the file's own "mirrors the orchestrator's constants
  exactly" comment. A live behavioral bug, not cosmetic: the Conductor reducer
  enforces its own cap independently of the orchestrator's handler-level check, so
  the tighter (wrong) default was the one actually governing every agent run that
  didn't pass an explicit `agentOptions.maxOpsPerTurn`.

### Phase D — Sidebar UI (web-editor)

- [x] **D1. Retry / copy-details on retryable errors.** `Notice` (`EventNode.tsx`)
  reads `node.retryable` and renders an inline **Retry** button wired to the SAME
  `retry` callback `AiSidebar.tsx`'s action bar already uses (passed down as
  `onRetryNotice`/`retryDisabled`, not a second implementation) plus a **Copy
  details** button; the `<pre>` detail stays collapsed behind a **Show details**
  toggle by default (progressive disclosure). Tests in `EventNode.test.tsx`
  (button presence/disable/callback) and `AiSidebar.test.tsx` (end-to-end retry
  through a flaky session).
- [x] **D2. Wire persisted `ConversationUiState`.** `AiSidebar.tsx` now seeds
  composer draft / expanded-tool-ids / scroll offset from `active.uiState` via a
  `useLayoutEffect` keyed on the conversation id (so a streamed token never resets
  mid-typing state), and writes them back through the existing debounced
  `setUiState` (`useConversations.ts`) whenever they actually change. Fixed a
  latent staleness bug this surfaced: the auto-scroll-to-bottom effect read the
  `atBottom` **state** (stale across the synchronous re-render a `useLayoutEffect`
  update triggers) instead of the always-current `stickRef.current` the sibling
  ResizeObserver effect already used — now both read the ref. Test in
  `AiSidebar.test.tsx` simulates type-draft/expand-tool/scroll → reload (unmount +
  remount against the same persistence) → reopen from history → asserts restored.
- [x] **D3. Accessibility fixes.** (a) The live-region announcer moved off the
  virtualized/plain list container (`role="list"`, no `aria-live`) into a
  dedicated `sr-only` element outside it, scoped to the latest streamed assistant
  text only while it is still `streaming` (extracted as a pure, unit-tested
  `latestStreamingAssistantText` in `apps/web-editor/src/ai/liveAnnouncement.ts`
  so it doesn't need the real frame-batched streaming pipeline to test). (b) A
  hand-rolled `useModalFocusTrap` (`apps/web-editor/src/components/ai/`) — no
  existing `Dialog`/focus-trap primitive was found in `packages/ui` or elsewhere
  — is shared by `ToolDetailsModal` (`EventNode.tsx`) and `DiffPreviewModal.tsx`:
  focus moves in on open, Tab/Shift+Tab wraps within the modal, and focus returns
  to the trigger on close.

## 3. Tracked, not attempted this pass

These are real findings, not dismissed — they need their own scoped plan/PR the way
every K-phase in `AI-ORCHESTRATION-REDESIGN.md` did, because each is a control-flow or
product-policy change, not a bounded patch:

- **Recovery/saga table wired into `streamAgent`.** Today only the planner path
  (`plan-driver.ts:129`) consults `recovery.ts`; `fallback_tier`/`fallback_recipe`
  aren't implemented anywhere. Wiring the agent loop through the same table means
  deciding what "route around a failed tool" or "rebase on stale base" *means* for a
  sequential turn loop — a Conductor-state change, not a patch.
- **Budget/cost-cap enforcement on the agent loop.** No live path enforces
  `maxUsd`/`maxTokens` today (`usage-summary.ts:14`); enforcing one needs a product
  decision on what the cap *is* per subscription tier before there's anything to code.
- **Model-tier routing for the classifier + agent turns.** `effect-runtime.ts`'s tier
  routing only serves the DAG/planner path; routing the classifier and per-turn model
  calls through `perTierProviders` is themable but changes latency/cost tradeoffs
  that should be measured, not assumed.
- **Semantic-Index-backed context for the agent loop.** The agent loop still dumps
  whole-project digests (`orchestrator.ts:860`) instead of retrieval slices
  (`semantic-index.ts`, used today only by `streamPlannedEdit`). Swapping the context
  source for the dominant path is exactly the §9/§10 work the redesign doc scopes
  separately — worth doing, but as its own reviewed slice with before/after token
  measurements, not folded into this pass.
- **Desktop parity for mid-run steering + plan-approval + pinned context.**
  `SteeringInput`/plan-approval controls are browser-only (`AiSidebar.tsx:1057`);
  bringing live bidirectional steering to desktop needs a new IPC channel shape
  (main→renderer prompt-for-input, not just renderer→main abort) — a real feature
  build, not a gap patch. Threading `pinned` context read-only over the existing
  request shape is smaller and could be a fast-follow once A1/A2 land.
- **Task DAG / parallel-tool progress UI.** `TaskRunView` renders `task_started`/
  `task_finished`/`effect_progress`, but only the graph-executor emits them and no
  sidebar-reachable path runs tools through it — concurrent tool execution in the
  agent loop is the scheduler-integration work `AI-ORCHESTRATION-REDESIGN.md` already
  scopes; faking events to light up the UI without real concurrency would be
  dishonest instrumentation.
- **Composer attachments never reach the model request.** Pasted-file chips render
  but `attachments` isn't threaded into `runInputFor` (`AiSidebar.tsx:577-607`) —
  this is really "is multimodal input a supported capability yet", a product/provider
  decision, not a wiring bug.

## 4. Branch / PR sequence

One branch, one commit per checked item above (`fix/orchestrator-sidebar-gaps`),
each commit runs the affected package's tests before landing. Do not batch Phase
A–D into one commit — each phase (and often each item) is independently revertable.

## 5. Context-window visibility + provider continuity (2026-07-27) — `[x]` complete

- [x] **E1. Keep one provider for every user-request model call.** The provider/model
  selected by the host owns classification, planning, editing, and bounded repair.
  Remove tier routing from Settings, persistence, IPC, environment configuration, and
  effect dispatch; retain tier labels only as non-routing cost metadata (ADR 0078).
- [x] **E2. Emit honest context-window occupancy.** Add a typed orchestration event for
  each active model call, reporting the configured context window plus estimated prompt
  tokens immediately and provider-reported input tokens when available. Keep aggregate
  cost reporting separate.
- [x] **E3. Put a compact context ring immediately left of Send/Stop.** The ring must
  expose used/total tokens on hover and to assistive technology, update from the latest
  event in the active conversation, and degrade to an empty configured window before the
  first call.
- [x] **E4. Verify and document end to end.** Cover SDK events, single-provider
  execution, browser/desktop config removal, composer rendering/accessibility, and the
  real sidebar stream path; update provider docs, ADR, developer/customer changelogs,
  and the master plan. **Last updated:** 2026-07-27
