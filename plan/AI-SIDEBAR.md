# FramePilot — Cursor-Class AI Sidebar (Phase 11 sub-plan)

> **Sub-plan of `plan/PLAN.md`.** Read `plan/PLAN.md`, `AGENTS.md`, and `CLAUDE.md`
> before touching anything here. This document is the execution source of truth for
> turning the current single-shot `AiPanel` into a **streaming, persistent,
> interruptible, Cursor-class AI workspace**. Every rule in `AGENTS.md` (the five
> invariants) and `CLAUDE.md` (§2 edit rules, §5 ASK-before-acting) still binds.
>
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
>
> **Status:** `[x]` **Complete** — M0–M9 done. The sidebar streams, persists, is
> interruptible, reviewable, searchable, accessible, and (2026-07-01) reskinned to a
> Cursor-class look on the retuned design tokens.
> **Follow-up (2026-07-23) — step-local agent activity, done:** a multi-step agent
> run now emits one reasoning accordion per step, immediately before that step's tool
> activity, instead of overwriting one turn-level accordion. Unplanned runs no longer
> display a synthesized checklist that grows for the lifetime of the run; the bounded
> checklist remains only when **Plan first** drafted it up front. The sidebar presents
> reasoning and tool rows on a restrained shared activity rail; focused renderer and
> sidebar regressions cover chronological steps, no unplanned plan node, and the
> retained drafted plan. See ADR 0072. No project schema, patch path, or IPC change.
> **Follow-up (2026-07-01) — orchestration clarity + capability, done:** the agent
> stream now emits **real, specific** reasoning/plan/progress/tool/action text derived
> from the actual tool calls and resolved clip/track/asset names (pure `projectNames` +
> `describeToolCall`/`describeOperation`; one in-place progress bar via `emit.progress`
> `key`) instead of the hardcoded "Step N: analyzing the timeline" / "Agent progress".
> Added the `set_track_flags` tool (mute/lock/hide) with a full TS+Python engine mirror
> (op apply/invert/validator) for UI parity. Added a **desktop model/provider picker**
> (`ai:providers` IPC + validated `provider` on `AiStreamRequest`; key never crosses the
> bridge) and a Cursor-style empty state. See ADR 0033 amendment. No schema change.
> **Follow-up (2026-07-01) — settings-owned model/keys + full-height rail, done:**
> the in-header model picker is replaced by a single **Settings → AI** panel that owns
> the active provider, per-provider **model**, and **API key** input. Keys persist to a
> plaintext `ai-config.json` in the app data dir on desktop (env vars remain a fallback)
> and to `localStorage` in the browser; on desktop they are **write-only over the bridge**
> (new `ai:config-get`/`ai:config-set` channels; `config-get` returns no secret). The
> sidebar shows a read-only active-model **badge** that opens Settings → AI. The right AI
> rail is now **full-height** (a sibling of the left+center main column), so it spans the
> timeline dock instead of sitting above it. MCP↔orchestrator tool parity is locked with
> an exact set-equality test (`buildMcpTools` already auto-syncs the registry). No
> project-schema change; the `validate→apply→record` invariant is untouched.
> **Follow-up (2026-07-12) — editor-first sidebar polish + per-change review popup, done:**
> three UX asks landing the sidebar squarely on *video editors*, not programmers.
> **(1) Streaming feel:** the stream now smart-auto-scrolls while a message streams
> (a `ResizeObserver` on the growing message follows it, fixing the case where a
> single streaming node — unchanged node count — didn't stick to the bottom), and
> pauses the moment the reviewer scrolls up, re-arming only when they return to the
> bottom. The "thinking" accordion auto-collapses the instant reasoning completes
> (and stops auto-collapsing once the user has toggled it by hand). **(2) De-programmered
> UI:** no more raw JSON / ids / `ms` runtimes / tool argument dumps — runtimes read
> "instant"/"2s", the tool details popup is a plain-language recap (What happened /
> Clips / Tracks / Files / Heads up), and diff wording speaks edits ("Suggested edit",
> "changes", "Can't apply this edit") with premium decision pills. **(3) Per-operation
> review popup** (`DiffPreviewModal.tsx`): "Show preview" opens a **Review changes**
> dialog — a left rail lists every change in plain language with its `m:ss` timecode
> and a Keep/Remove toggle; the right stage is the real `AiReviewPlayer` (HTML-video,
> render-vs-preview rule) previewing exactly the kept subset, **seeked to the selected
> change** so playback starts ON the edit, never at 0:00; "Jump to timeline" reveals +
> seeks the real playhead. **Invariant-safe subset apply:** keeping a subset re-assembles
> a *brand-new validated* patch from only the kept ops via `assembleEdit` and applies it
> atomically (`onApplyPatch` → `editor.applyPatchChecked`) — never a half-applied patch;
> a subset that can't stand alone fails validation and is surfaced honestly. New
> `AiReviewPlayer` `startAt` prop (live re-seek without remount). Tests: rewritten
> `EventNode`/`AiSidebar` specs + new `DiffPreviewModal.test.tsx` (per-op toggle, seek-to-op,
> honest invalid-subset state, decided read-only, Escape/backdrop close). Full web-editor
> suite green (1051), typecheck + lint clean. No schema change; `validate→apply→record`
> untouched.
> **Follow-up (2026-07-12b) — editor-first review UX pass (partial):** shipped 7
> of 11 requested items, all test-covered (web-editor 1054 green, typecheck + lint
> clean): per-change **Keep/Remove** as a two-button check/cross control (was one
> ambiguous toggle); compare controls reworded + tooltipped ("Overlay" / "Peek
> original" / "Side by side"); **read-only before/after popup** from clicking a
> clip/caption/image chip (`DiffPreviewModal` gained a `compare` variant +
> `initialSelected`); diff-card **Accept/Reject** restyled as a compact attached
> footer (secondary Show-preview/Jump ghosted left, primary pair right); sidebar
> **Analysis-engine badge removed** + batch **Apply all/Reject all** moved right,
> no counts (added `rejectAll`); context chips → rounded **badges** + circular
> composer send. **STILL OPEN (need live desktop repro, not blind fixes per rule
> #10):** (a) Review-modal preview renders black on desktop for all edit types —
> `PreviewPlayer` static path looks correct (`showBuffers`/`assetById`/video-img
> all resolve), so it's a runtime issue (fp-media:// in the portal, shadow-editor
> asset wiring, or readiness timing); (b) applied edits not persisting on desktop
> — the store→`Editor` lift→`onProjectChange`→debounced-autosave path reads
> correct in code, so needs reproduction to find the real gap (candidate: the
> memory-record's separate stale-timeline `onProjectChange` racing the lift).
> **Owner agents:** `ai-tooling-engineer` (engine/sdk), `timeline-engineer` (patch
> wiring), a UI implementer (use the `frontend-design` skill + `web-design-guidelines`),
> `qa-e2e` (tests), `docs-maintainer` (ADR/docs), `security-reviewer` (IPC/abort).
> **Last updated:** 2026-07-23

---

## 0. TL;DR for the executing agent

You are upgrading the **right-rail AI panel** of the web editor
(`apps/web-editor`) from a request→response form into a live, streaming sidebar
that matches the interaction model of Cursor while staying original.

The single most important architectural idea: **everything the AI does becomes a
typed, append-only `AiEvent` that streams into a conversation and updates _in
place_ by `id`.** The UI is a pure function of an ordered event log. Persistence
is "save the event log." Streaming is "append/patch events." Interruption is "stop
emitting events." Get the event model right (M1) and every later milestone becomes
mechanical.

**Hard constraints (do not violate):**

1. **No project-schema change.** Conversations are a _separate_ store, never the
   `project.fp.json` schema. The existing `aiMemory` field (style/accept/reject
   learning) is untouched. (AGENTS.md invariant 4; CLAUDE.md §5.)
2. **AI edits ONLY through the tool registry → orchestrator → validated `Patch` →
   `validate→apply→record` store path.** The sidebar never mutates the timeline
   directly. Apply/Reject/Undo reuse the existing `useEditor` store. (AGENTS.md
   invariant 5.)
3. **Render vs. preview rule** holds — any media preview is the Python engine, not
   a faked canvas render.
4. **No new runtime dependency, no broadened IPC surface, no new persisted store
   without flagging it and getting approval first** (CLAUDE.md §5). The "Approvals
   required" table (§9) lists every such gate; do not silently cross one.
5. **Small reviewable patches.** Each milestone is independently shippable, tested,
   and merged on its own branch. Do not land M1–M9 as one mega-PR.

---

## 1. Current state (what already exists — reuse it, do not rebuild)

| Concern            | Where it lives today                                                                                      | Reuse / status                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| AI panel UI        | `apps/web-editor/src/components/AiPanel.tsx`                                                              | **Replace incrementally.** Single-shot form with modes chat/plan/edit/agent.                                    |
| Orchestrator       | `packages/ai-sdk/src/orchestrator.ts`                                                                     | `chat/plan/edit/autocomplete/agent/review` — all return **complete** results, no streaming. Extend, don't fork. |
| Providers          | `packages/ai-sdk/src/providers/`\* (`AiProvider.complete()`)                                              | No streaming method. **Add** `stream()`; keep `complete()`.                                                     |
| Agent loop         | `packages/ai-sdk/src/agent.ts` (`AgentRun`/`AgentStep`)                                                   | Runs to completion, returns log. **Add** event emission + `AbortSignal`.                                        |
| Tool registry      | `packages/ai-sdk/src/tool-registry.ts` (+ Python mirror)                                                  | Source of tool names/icons/metadata for activity cards. **Read-only.**                                          |
| Patch apply        | `apps/web-editor/src/editor/store.ts` + `useEditor.ts` (`applyPatch`)                                     | The ONLY way edits land. Diff/accept/reject reuse this.                                                         |
| Editor↔AI glue     | `apps/web-editor/src/editor/ai.ts` (`OrchestratorLike`, `createOrchestrator`, `toReviewCard`)             | **Evolve** `OrchestratorLike` → streaming `AiSession`.                                                          |
| Desktop AI IPC     | `apps/desktop/electron/main.ts` + `preload.cts` + `ipc/contract.ts` (`aiChat/aiPlan/aiEdit` via `invoke`) | Request/response only. **Add** a streaming push channel (M3).                                                   |
| Diff for review    | `packages/editor-core` `diffTimeline`/`diffProject` + `toReviewCard`                                      | Reuse verbatim for diff cards.                                                                                  |
| Virtualization     | `@tanstack/react-virtual` (already a dep, used by `MediaBin`)                                             | Reuse for the event list — **no new dep**.                                                                      |
| Markdown           | **none today**                                                                                            | New need (progressive markdown). See Approval A4.                                                               |
| Conversation store | **none today**                                                                                            | New store (M2). See Approval A1.                                                                                |
| Styling/tokens     | `apps/web-editor/src/styles.css` (Notion dark, ADR 0028), `Button`/`Select`/`Tooltip`/`icons.tsx`         | Reuse tokens + primitives. Status colors map to existing semantic tokens.                                       |

**Gap summary:** no streaming, no conversation persistence/history/list, no
tool-activity cards, no live progress/reasoning, no interruptibility, no context
panel, no global search, no virtualization of the AI log, no auto-scroll/jump.

---

## 2. Target architecture

```
                       ┌────────────────────────────────────────────┐
                       │  apps/web-editor  (renderer / browser)      │
                       │                                             │
  user prompt ───────► │  AiSidebar (M4)                             │
                       │    ├─ ConversationStore (M2, in-memory VM)  │
                       │    │     ▲ append/patch AiEvent             │
                       │    │     │                                  │
                       │    └─ AiSession (M3 facade) ──┐             │
                       └──────────────────────────────┼─────────────┘
                                                       │ AsyncIterable<AiEvent> + AbortSignal
                  ┌────────────────────────────────────┴──────────────┐
   browser path   │                                                    │  desktop path
   (direct)       ▼                                                    ▼  (IPC push, M3)
        Orchestrator.stream*() (M1)                     preload bridge → main process
        packages/ai-sdk                                 ipcMain stream channel → Orchestrator
                  │                                                    │
                  ▼                                                    ▼
        AiProvider.stream() (M1) ── Anthropic/NVIDIA SSE · Mock deterministic stream
                  │
                  ▼
        Tool calls → assembleEdit → validatePatch → EditResult  (unchanged invariant path)
                  │
                  ▼  (events only — application of the patch stays user-gated)
        Diff card → user Apply → useEditor.applyPatch → validate→apply→record (existing)
```

**Three layers, three owners:**

- **Engine/SDK (`packages/ai-sdk`)** — streaming providers + streaming orchestrator
  that _emit `AiEvent`s_ and honor `AbortSignal`. Pure, deterministic with `mock`,
  100% covered. Owner: `ai-tooling-engineer`.
- **Transport (`apps/desktop` + `editor/ai.ts`)** — one `AiSession` interface the UI
  consumes; browser calls the SDK directly, desktop streams over an IPC push
  channel. Owner: `ai-tooling-engineer` + `security-reviewer` (abort/sandbox).
- **UI (`apps/web-editor/src/components` + `src/editor`)** — conversation store,
  sidebar shell, event renderers, composer, history, search. Owner: UI implementer.

---

## 3. The core data model (define this FIRST — M1)

Put these in a new module `packages/ai-sdk/src/events.ts` (exported from
`index.ts`). They are the contract every later milestone depends on. All ids are
stable strings; the UI keys React lists by `id` and **updates in place** (spec:
"every streamed event updates in place instead of creating duplicate entries").

```ts
/** Monotonic, append-only. A conversation IS an ordered list of these. */
export type AiEvent =
  | UserMessageEvent // the prompt the user sent
  | AssistantDeltaEvent // streamed token chunk for an assistant message
  | AssistantMessageEvent // terminal: assistant message complete (markdown)
  | ReasoningEvent // high-level reasoning SUMMARY (never raw CoT)
  | PlanEvent // the live agent checklist (steps + status)
  | ToolCallEvent // a tool invocation: status running→done/failed
  | ToolResultEvent // structured result attached to a ToolCallEvent
  | TimelineActionEvent // a produced edit op (add/trim/split/transition…)
  | DiffEvent // a reviewable patch (what/why/before-after)
  | ProgressEvent // 0..1 progress for a long op (analyze/render/export)
  | ReferenceEvent // clickable file/clip/track chips the AI read
  | NotificationEvent // info/system notice
  | WarningEvent
  | ErrorEvent // failure card: what/why/retry/copy-logs
  | StatusEvent; // lifecycle: idle→thinking→…→completed/failed (§ animations)

export interface AiEventBase {
  readonly id: string; // stable; deltas reference their parent id
  readonly conversationId: string;
  readonly ts: number; // epoch ms, for ordering + date grouping
  readonly turnId: string; // groups all events of one user turn
}

export type ToolStatus = 'running' | 'completed' | 'warning' | 'failed';
export type RunStatus =
  | 'idle'
  | 'thinking'
  | 'searching'
  | 'reading'
  | 'planning'
  | 'editing'
  | 'generating'
  | 'running_tool'
  | 'rendering'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

> **Design rules for the union (enforce in code review):**
>
> - Streaming text is `AssistantDeltaEvent` (carries `{ parentId, chunk }`); the UI
>   appends `chunk` to the message keyed by `parentId`. The closing
>   `AssistantMessageEvent` carries the final canonical markdown (so a reload
>   renders identically without replaying deltas).
> - `ToolCallEvent` is mutated in place across its lifecycle by re-emitting the same
>   `id` with a new `status`/`runtimeMs`. `ToolResultEvent` carries the expandable
>   detail (input/summary/result/files/clips/tracks/logs/warnings).
> - `ReasoningEvent` is a **concise summary string list** ("Analyzing timeline",
>   "Looking for caption track"), updated in place. **Never emit raw
>   chain-of-thought** (AGENTS.md invariant 4 spirit; spec "Never expose raw CoT").
>   With the `mock` provider these are deterministic canned summaries; with a real
>   provider they are derived from tool-call/plan transitions, not the model's hidden
>   reasoning tokens.
> - `DiffEvent` wraps an `EditResult` (existing). Apply/Reject reuse `toReviewCard`
>   - `useEditor.applyPatch`. Batch accept = apply N `DiffEvent`s in order.

### 3.1 Conversation / session model (M2)

New module `apps/web-editor/src/ai/conversation.ts` (or a small `packages/ai-sdk`
type if it must be shared with desktop persistence — decide in M2 ADR):

```ts
export interface Conversation {
  readonly id: string;
  title: string; // auto-derived from first prompt; renamable
  readonly createdAt: number;
  updatedAt: number;
  model: string; // provider/model label used
  mode: 'agent' | 'chat' | 'edit';
  pinned: boolean;
  favorite: boolean;
  unread: boolean;
  readonly events: AiEvent[]; // the append-only log (may exceed 20k)
  uiState: ConversationUiState; // collapsed/expanded/scroll/draft/etc.
}

export interface ConversationUiState {
  collapsedToolIds: string[];
  expandedToolIds: string[];
  scrollOffset: number;
  selectedEventId: string | null;
  composerDraft: string;
  attachments: Attachment[];
  context: ContextItem[]; // included-context chips
}
```

**Persistence (Approval A1 — ✅ APPROVED: JSON files):** the canonical store is a
**JSON file per conversation** under the app data dir on desktop via a new IPC
channel (e.g. `~/Library/Application Support/FramePilot/conversations/<id>.json`),
**never** inside `project.fp.json`. The browser/dev path persists the **same JSON
shape** in IndexedDB (localStorage is too small for 20k-event logs) so a web build
still survives reload — the on-disk and IndexedDB records are byte-identical JSON, so
the persistence adapter is a thin storage swap, not two formats. One file/record per
conversation so restoring the open conversation is O(1). Persist incrementally
(append events; debounce `uiState`).

---

## 4. Milestones

Each milestone: **Goal · Files · Tests · DoD · Owner**. Ship in order; each is a
PR. "DoD" always includes: affected unit tests green, `pnpm typecheck`/`lint`
green, 100% coverage on new pure-logic modules, CHANGELOG entry, plan checkbox
ticked, and (for architectural decisions) an ADR.

---

### M0 — Spike, decisions & ADR `[x]` (Owner: ai-tooling-engineer + docs-maintainer)

No production code. De-risk the unknowns and lock the contracts.

- [x] Write **ADR 0033 — "Streaming AI sidebar architecture"**: the `AiEvent` model,
      the `AiSession` facade, the conversation store + persistence location, the
      streaming-IPC approach, and why no project-schema change.
      (`docs/adr/0033-streaming-ai-sidebar-architecture.md`)
- [x] Resolve every row in the **Approvals table (§9)** with the user before M1.
      ✅ Done 2026-06-30: A1 JSON files · A2 streaming · A3 SSE seam · A4 markdown lib
      — all approved; A5 voice dropped; A6 fuzzy-search optional (in-house index first).
- [x] Throwaway spike: confirmed Anthropic + NVIDIA SSE parse cleanly through the
      injected `FetchLike` seam. Minimal extension chosen: an **optional**
      `body?: ReadableStream<Uint8Array>` on the response (Web Streams, no new dep);
      `complete()` keeps using `text()`. Spike notes captured in ADR 0033 §"Spike notes".

- **DoD:** ADR merged; approvals recorded in §9; spike notes captured in the ADR.

---

### M1 — Streaming engine in `packages/ai-sdk` `[x]` (Owner: ai-tooling-engineer)

The heart. Make the SDK _emit events_ instead of only returning final values.

- [x] `events.ts`: the full `AiEvent` union (§3) + a pure `reduceEvents(events) →
  ```
  ConversationView` reducer (in-place merge of deltas/tool-status by id). 100% cov.
  ```
- [x] Extend `AiProvider` with `stream(request, signal?): AsyncIterable<ProviderChunk>`
  ```
  where `ProviderChunk` = text-delta | tool-call | done. Keep `complete()` (it can
  be implemented as "drain stream"). Extend `FetchLike` minimally to expose a
  readable body for SSE (injectable; still unit-testable offline).
  ```
  - [x] `MockProvider.stream()` — **deterministic** scripted chunks (text deltas +
    ```
    a scripted tool call) so the whole sidebar works offline and tests are
    reproducible. This is the default and the test backbone.
    ```
  - [x] `AnthropicProvider.stream()` — parse Messages API SSE
    ```
    (`content_block_delta`, `message_delta`, tool-use blocks).
    ```
  - [x] `NvidiaProvider.stream()` — parse OpenAI-compatible SSE chunks.
- [x] Orchestrator streaming variants that yield `AiEvent`s and accept an
  ```
  `AbortSignal`:
  ```
  - [x] `streamChat`, `streamPlan`, `streamEdit` (edit still ends in a `DiffEvent`
    ```
    wrapping the existing `EditResult` — the validated-patch path is unchanged).
    ```
  - [x] `streamAgent` — the existing agent loop, but emitting `PlanEvent`,
    ```
    `ReasoningEvent`, `ToolCallEvent`/`ToolResultEvent`, `ProgressEvent`,
    `TimelineActionEvent`, and a terminal `DiffEvent` (the combined patch). It
    checks `signal.aborted` between steps and after each tool call → emits a
    terminal `StatusEvent{status:'cancelled'}` and returns the partial run.
    **Invariant 5 still holds:** mutating tool calls still go through
    `assembleEdit → validatePatch`; nothing auto-applies.
    ```
- [x] Reasoning summaries are derived deterministically from loop transitions (tool

  ```
  about to run → "Searching timeline", etc.), never from hidden model tokens.
  ```

- **Tests:** stream→event golden sequences for each mode with `mock`; abort mid-run
  yields a `cancelled` terminal and a valid partial; SSE parsers unit-tested with
  captured fixture payloads (no network). 100% cov on `events.ts`, reducer, parsers.
- **DoD:** SDK can stream a full agent run as events, offline, deterministically,
  interruptibly. No UI yet.

---

### M2 — Conversation store + persistence `[x]` (Owner: ai-tooling-engineer + UI)

- [x] `apps/web-editor/src/ai/conversation.ts`: `Conversation`/`ConversationUiState`
  ```
  types + pure helpers (`appendEvent`, `deriveTitle`, `groupByDate` →
  Today/Yesterday/Previous 7/30/Older, `markRead`).
  ```
- [x] `apps/web-editor/src/ai/conversationStore.ts`: an in-memory store +
  ```
  `useConversations()` hook (mirrors the `useEditor` store shape/conventions).
  Append events from a stream; expose current view via the `reduceEvents` reducer.
  **Stream updates must not re-render the whole list** — only the changed event
  (selector-per-event subscription). (Perf req.)
  ```
- [x] Persistence adapters behind one `ConversationPersistence` interface — both
      read/write the **same JSON shape** (Approval A1 ✅ JSON files):
  - [x] `DesktopPersistence` (Electron, **canonical**) — JSON file per conversation
        via new IPC channels `conversations:list/load/save/delete`; files under the
        app data dir, sandboxed (mirror the existing projects-root sandbox).
  - [x] `IndexedDbPersistence` (browser/dev) — stores the identical JSON record;
        append-friendly; debounced `uiState` writes.
- [x] Restore-on-open: instant load of the active conversation; lazy-load others.
- [x] Persist per the spec: collapsed/expanded tool state, scroll offset, selected

  ```
  event, composer draft, attachments, context — all in `ConversationUiState`.
  ```

- **Tests:** date grouping, title derivation, append/restore round-trip, debounce,
  "20k events restore" perf assertion. 100% cov on pure helpers.
- **DoD:** create/restore conversations across reload; nothing in `project.fp.json`.
- **Done 2026-06-30.** Shipped `conversation.ts` (pure helpers), `conversationStore.ts`
  (pure store + selectors), `conversationPersistence.ts` (`ConversationPersistence`
  interface + `Memory`/`IndexedDb`/`Desktop` adapters + resolver), `useConversations`
  (reducer adapter + debounced autosave + hydrate). Desktop path: sandboxed
  file-per-conversation store (`electron/ai/conversation-store.ts`, id traversal-guarded)
  behind new `conversations:list/load/save/delete` IPC (contract + preload + main +
  shared-types). 52 tests; the 20k-event round-trip is asserted via `MemoryPersistence`.
  **Deferred to M4/M9:** the `reduceEvents` per-event selector subscription (render
  wiring) and true lazy-load of inactive conversations (`hydrate` loads all today).

---

### M3 — `AiSession` transport facade + streaming IPC `[x]` (Owner: ai-tooling-engineer + security-reviewer)

- [x] Define `AiSession` in `apps/web-editor/src/editor/ai.ts` (evolve
  ```
  `OrchestratorLike`): `run(mode, input, signal): AsyncIterable<AiEvent>` +
  `abort()`. The UI depends ONLY on this.
  ```
- [x] Browser impl: thin wrapper over the M1 `Orchestrator.stream*`.
- [x] Desktop impl: **streaming push channel** (Approval A2). Options — `MessageChannel`
  ```
  transferred via preload, or `ipcMain` emitting `framepilot:ai:event` with a
  `requestId` + an `framepilot:ai:abort` channel. Fetch runs in main (Node, no
  sandbox), events pushed to renderer. Add to `ipc/contract.ts`, `preload.cts`,
  `@framepilot/shared-types` (single-source the event/contract types).
  ```
  - [x] **security-reviewer gate:** abort must actually cancel the upstream fetch
    ```
    (thread `AbortSignal` to the provider); no event leaks after abort; requestId
    scoping prevents cross-conversation delivery; no secrets cross the bridge.
    ```
- [x] Keep the offline mock path working with **no** IPC (browser/tests).

- **Tests:** fake-bridge streaming test (events arrive in order, abort stops them);
  contract parity test (channels match shared-types). Desktop handler unit-tested.
- **DoD:** one `AiSession` interface; identical event stream in browser and desktop.
- **Done 2026-06-30 (security-reviewed).** `AiSession` (`editor/ai.ts`) with `BrowserAiSession`
  (direct SDK) + `DesktopAiSession` (push→pull queue, subscribe-before-start race buffer,
  requestId filter). Desktop: `framepilot:ai:stream-start/-event/-abort` channels +
  `AiStreamHub` (`electron/ai/ai-stream.ts`). **Security review gates 1/2/4 PASS as built;
  findings fixed before merge:** (1) `requestId` is now `randomUUID()` and **abort is
  sender-scoped** (a renderer can't cancel another's run); (2) runs are **aborted on
  `webContents` destroy** and bounded by a **timeout**; (3) the renderer `AiStreamRequest`
  is **validated** (`parseAiStreamRequest`) and `project` re-parsed. Also threaded the
  abort `signal` into the provider `fetch` itself (prompt cancellation, not just the SSE
  reader). 38 tests incl. hub security behaviors; ai-sdk back to 100%.

---

### M4 — Sidebar shell + event renderers (the visible product) `[x]` (Owner: UI implementer)

> Use the `frontend-design` skill and check output with the `web-design-guidelines`
>
> - `frontend-accessibility-auditor`. Reuse `styles.css` tokens, `Button`, `Select`,
>   `Tooltip`, `icons.tsx`. **No new icon/animation dependency** (CSS + rAF only — see
>   existing motion-token convention in ADR 0014/0028).

- [x] `components/ai/AiSidebar.tsx` — fixed **Header** (mode segmented Agent/Chat/Edit,
  ```
  History, New Chat, Search, Settings, Model selector, Collapse) over a scrollable
  **Conversation/Activity** area over a docked **Composer**. Replaces `AiPanel`'s
  body; mount point stays `Editor.tsx:351`.
  ```
- [x] **Virtualized event list** with `@tanstack/react-virtual` (variable-size; only
  ```
  changed rows re-render). Target 60fps while streaming, 20k+ events.
  ```
- [x] One renderer component per `AiEvent` type, each with a \*\*distinct visual
  ```
  treatment** (spec "Message Types"):
  `UserMessage`, `AssistantMessage` (progressive markdown via a library — Approval
  A4 ✅; pick a small, well-licensed, streaming-tolerant renderer + `pnpm license:scan`,
  name it in this PR),
  `ReasoningPanel` (collapsed by default; Thinking… + live summary list + elapsed),
  `PlanChecklist` (✓/running-animated/pending), `ToolCard` (icon/name/status/
  runtime/expand → input/summary/result/files/clips/tracks/logs/warnings),
  `TimelineActionCard`, `DiffCard`, `ProgressBar`, `ReferenceChips`, `Notice`,
  `WarningCard`, `ErrorCard`, `SystemMessage`.
  ```
- [x] **Status color mapping** to existing semantic tokens (do not invent colors):
  ```
  running→blue/accent, completed→green, warning→yellow, failed→red, idle→gray.
  ```
- [x] **Auto-scroll** while streaming; on user scroll-up, disable + show a
  ```
  **"Jump to Latest"** affordance that re-enables.
  ```
- [x] **State-transition animations** (idle→thinking→…→completed/failed): subtle,
  ```
  no flashing, **no layout jumps**, `prefers-reduced-motion`-gated.
  ```
- [x] **Accessibility:** full keyboard nav, arrow navigation across events, logical

  ```
  tab order, screen-reader labels (`aria-live` on the stream, already partly
  present), visible focus rings, high-contrast + reduced-motion support.
  ```

- **Tests:** a renderer test per event type; virtualization smoke; auto-scroll/jump
  behavior; reduced-motion; a11y (roles/labels) via testing-library queries.
- **DoD:** a streamed mock agent run renders live, in place, smooth, accessible.

---

### M5 — Tool-call cards, references & timeline-action cards `[x]` (Owner: UI + ai-tooling-engineer)

- [x] Map every registry tool to an icon + label table (derive from
  ```
  `tool-registry.ts`; one mapping module). Covers the spec's tool list
  (Search Project, Read Timeline, Inspect Clip, Generate Subtitle/Voice,
  Analyze Audio, Find Silence, Extract Transcript, Generate B-roll/Music,
  Search/Download Asset, Write Timeline, Update Clip, Apply Transition,
  Export Project, …). Tools that are `available:false` render but are visibly
  gated (don't fake capability — build-order rule).
  ```
- [x] Expanded tool card: input · summary · result · affected **files/clips/tracks**
  ```
  · duration · logs · warnings. Collapsible; state persisted (M2).
  ```
- [x] **Reference chips**: clickable `timeline.fp` / `voiceover.wav` / `Intro Clip` /
  ```
  `Track 3` / `Subtitle Layer` / `Transition 4`. Clicking dispatches an existing
  editor selection/seek action (reuse `useEditor.selectClip` / `seek` / track
  focus; wire a `framepilot:reveal` intent if needed). Hover → metadata preview
  via existing `Tooltip`.
  ```
- [x] **Timeline-action cards** (Added/Deleted/Moved/Split/Trimmed/Changed-duration/

  ```
  Added-transition/Generated-captions/Created-animation/Updated-audio) derived
  from the patch ops in a `DiffEvent`/`TimelineActionEvent`; expand to op detail.
  ```

- **Tests:** tool→icon mapping exhaustiveness (every registry tool mapped); chip
  click invokes the right editor action; action-card derivation from ops.
- **DoD:** every tool execution is a transparent, inspectable, navigable card.

---

### M6 — Diff review, accept/reject/batch, progress & interruptibility `[x]` (Owner: timeline-engineer + UI)

- [x] `DiffCard`: before→after using existing `diffTimeline`/`toReviewCard`; actions
  ```
  **Accept · Reject · Undo · Preview · Jump to Timeline**. Accept →
  `useEditor.applyPatch` (validate→apply→record, so global Undo reverts it).
  Reject → `recordRejected` (existing learning signal). **Batch acceptance**:
  apply multiple `DiffEvent` patches in order, each validated; stop + surface on
  first failure (transactional per patch, never half-apply one patch).
  ```
- [x] **Preview** = the existing engine render path (render-vs-preview rule); if the
  ```
  renderer→engine export IPC isn't wired for this surface, show the timeline diff
  and mark media-preview as gated (don't fake it). (Matches PLAN.md Phase 4.3/8.)
  ```
- [x] **Live progress**: `ProgressBar` driven by `ProgressEvent` (Analyzing /
  ```
  Generating Captions / Rendering Preview / Exporting). Continuous, no spinner-lies.
  ```
- [x] **Interruptibility controls** on any running op/agent: \*\*Stop · Cancel · Retry ·

  ```
  Resume**, wired to `AiSession.abort()` (M3) + a `Retry` that re-runs the turn and
  a `Resume` that continues an aborted agent run from its last applied step. The UI
  never locks (all async; the composer stays usable).
  ```

- **Tests:** accept commits + global-undo reverts; reject records signal; batch
  accept order + first-failure stop; abort→cancelled→resume continues; progress
  monotonicity.
- **DoD:** every generated change is inspectable, reversible, batchable; every long
  op is interruptible and resumable; nothing freezes.
- **Done 2026-06-30.** `DiffCard` gained **Accept / Reject / Jump to timeline**; Accept
  commits via `useEditor.applyPatch` (validate→apply→record, so global Undo reverts it),
  Reject records `recordRejected` (learning signal). Decisions are owned by the sidebar
  per node id, so **batch "Apply all"** (`applyDiffsInOrder`, transactional, stop-on-first-
  invalid) and single accepts stay consistent. Progress bars drive off `ProgressEvent`
  (M4). Interruptibility: **Stop** (M4 abort) + **Retry** (re-runs the last turn); the
  composer never locks. **Honestly gated (not faked):** **Preview** (disabled — renders
  via the engine, not yet wired to this surface; render-vs-preview rule) and **Resume**
  (the streaming engine doesn't checkpoint a partial agent run yet — Retry re-runs instead).
  17 diff/interrupt tests.

---

### M7 — Conversation list, history, search `[x]` (Owner: UI)

- [x] **History drawer / conversation list**: grouped Today/Yesterday/Previous 7/30/
  ```
  Older. Each row: title, last-activity, model, agent badge, unread dot, pinned
  state. Hover actions: Rename · Duplicate · Delete · Pin · Export · Favorite.
  ```
- [x] **Instant filter** of the list as you type.
- [x] **Global search** across conversation titles, message text, tool outputs,
  ```
  timeline-edit summaries, asset/file names. Build a lightweight in-memory index
  over the event log; highlight matches. (No search dependency — substring/token
  index is enough for local data; flag if fuzzy ranking is wanted → Approval.)
  ```
- [x] **Export** a conversation (markdown/JSON) via existing save/download paths.

- **Tests:** grouping boundaries, filter, search across event kinds + highlight,
  pin/favorite/delete/duplicate/rename state, export round-trip.
- **DoD:** unlimited conversations, instant restore, instant search.

---

### M8 — Composer power features & context panel `[x]` (Owner: UI)

- [x] **Composer**: plain chat + **slash commands** (reuse the FramePilot command set
  ```
  — `/create-short`, `/remove-silence`, `/add-captions`, etc.; a palette over the
  existing skills/commands), drag media, paste (screenshot/timeline/code/logs),
  **Quick actions** (Improve Edit, Create B-roll, Fix Audio, Generate Titles, Make
  Viral, Trim Silence, Animate Captions) that pre-fill a prompt/tool intent.
  ```
- [x] **Attachments** as compact chips (image/video/audio/timeline/project/document)
  ```
  with hover preview; threaded into the orchestrator context.
  ```
- [x] **Context panel** above the composer: Included Context — Current Timeline,
  ```
  Selected Clips, Selected Audio, Current Project, Open Assets, Referenced Files —
  each removable. Feeds the existing `context-builder.ts` inputs.
  ```
- ~~Mic / voice prompt~~ — **DROPPED (Approval A5, 2026-06-30):** not building voice.
  Do **not** add a mic button, transcription path, or any related dependency.

- **Tests:** slash palette, quick-action prefill, attachment chip lifecycle, context
  add/remove → reflected in the built context, paste handlers.
- **DoD:** the composer feels like a workspace input, not a chat box.

---

### M9 — Performance, accessibility, polish, docs & e2e `[x]` (Owner: qa-e2e + UI + docs-maintainer)

- [x] **Performance:** virtualized long conversations (M4); reducer perf-budget test
  ```
  committed (`packages/ai-sdk/src/events.perf.test.ts` — 20k deltas fold in one pass,
  under budget); streamed updates merge by id without rebuilding the list.
  ```
- [x] **Accessibility:** landmark region + mode `tablist` + `aria-live` stream +
  ```
  `progressbar` roles + accessible names on every icon control + focus rings +
  full `prefers-reduced-motion` (opacity/transform-only motion). Asserted in
  `AiSidebar.test.tsx`.
  ```
- [x] **E2E (Playwright, offline mock provider):** rewrote the flow for the streaming
  ```
  sidebar (Edit/Chat modes → streamed diff → Accept → global Undo reverts; Reject;
  chat text). Revived the whole offline suite by booting the demo via `?demo`
  (App.tsx). Added visual baselines for the sidebar idle + streamed-diff states.
  ```
- [x] **Docs:** `docs/guides/ai-sidebar.md` (user guide) + README index link + ADR

  ```
  0033 finalized + CHANGELOG M8/M9 + this plan + PLAN.md Phase 11 ticked.
  ```

- **DoD:** ✅ 592 web-editor unit tests + 23 non-visual + 7 visual E2E green; docs landed.
- **Done 2026-07-01.** Shipped alongside the Cursor-class UI pass: retuned design
  tokens (ADR 0028 amendment), Cursor-identical sidebar restyle, and a Premiere-style
  full-width timeline dock (`Editor.tsx`).

---

## 5. Definition of Done (whole sub-plan)

The sidebar is "done" when, with the **offline mock provider** and no network:

- A user can hold **unlimited persistent conversations**, restored instantly across
  app restarts (events + UI state), with **nothing stored in `project.fp.json`**.
- Every AI action **streams live as in-place events** — reasoning summary, agent
  plan checklist, tool cards, progress, references, diffs, errors — never freezing,
  never duplicating, **never exposing raw chain-of-thought**.
- Every generated edit is **inspectable (diff), reversible (global Undo), and
  batch-acceptable**, applied only through the existing validated patch path.
- Every long op is **interruptible (Stop/Cancel) and resumable (Retry/Resume)**.
- The composer supports slash commands, attachments, quick actions, and a removable
  **context panel**.
- **Global search** spans titles/messages/tool output/edits/assets with highlight.
- **60fps at 20k+ events**, fully keyboard-navigable, SR-labeled, reduced-motion and
  high-contrast safe.
- `pnpm verify` + the new e2e suite are green; ADR + guide + CHANGELOG landed.

---

## 6. Invariants this sub-plan must never break

1. **No `project.fp.json` schema change.** (Conversations are a separate store.)
2. **AI edits only via tool registry → orchestrator → validated `Patch` →
   `validate→apply→record`.** The sidebar never mutates the timeline directly.
3. **Render vs. preview:** media previews are the Python engine, never faked.
4. **No new dependency / IPC channel / persisted store without the §9 approval.**
5. **Small, reviewable, independently-shippable PRs** — one per milestone, each with
   tests + 100% coverage on new pure modules + CHANGELOG + plan tick.
6. **Don't fake capability:** `available:false` tools render as gated, not working.

---

## 7. Risks & mitigations

| Risk                                      | Mitigation                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Event model churns and breaks every layer | Lock it in M0/M1 behind an ADR before any UI work; treat `events.ts` as a stable contract.                                              |
| 20k-event lists drop frames               | Virtualize from day one (M4); per-event selector subscriptions; deltas merge by id, never rebuild the array identity wholesale.         |
| Streaming over Electron IPC leaks/races   | `requestId`-scoped channels; abort threads to the upstream fetch; security-reviewer gate in M3.                                         |
| Real-provider streaming differs from mock | Mock is the contract + test backbone; SSE parsers tested against captured fixtures; real providers conform to the same `ProviderChunk`. |
| Scope creep blocks core                   | Voice is **dropped** (A5); fuzzy search stays optional (A6) — ship the in-house substring index first. Core works without either.       |
| Persisted conversations bloat disk        | One file per conversation; size budget + optional retention/prune policy (decide in M2 ADR).                                            |

---

## 8. Suggested branch / PR sequence

`feat/ai-sidebar-m0-adr` → `…-m1-streaming-engine` → `…-m2-conversation-store` →
`…-m3-session-ipc` → `…-m4-shell` → `…-m5-tool-cards` → `…-m6-diff-interrupt` →
`…-m7-history-search` → `…-m8-composer` → `…-m9-perf-a11y-e2e`. Never combine.

---

## 9. Approvals required BEFORE crossing each gate (CLAUDE.md §5)

Resolve these with the user during **M0**; record the decision inline.

| #   | Gate                                                                                                                                                   | Why it needs approval                                      | Decision                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------ |
| A1  | New **conversation persistence store** — **JSON files** (desktop primary; browser uses the same JSON shape in IndexedDB so a web build still persists) | New persisted store outside the project schema             | ✅ **APPROVED (2026-06-30):** JSON files on desktop          |
| A2  | New **streaming AI IPC channels** + `AbortSignal` over the bridge                                                                                      | Broadens the IPC surface (CLAUDE.md §5)                    | ✅ **APPROVED (2026-06-30)**                                 |
| A3  | Minimal **`FetchLike` extension** to expose an SSE-readable body                                                                                       | Changes a core provider seam (required by A2 streaming)    | ✅ **APPROVED (2026-06-30)** — implied by approved streaming |
| A4  | A **markdown renderer** for progressive assistant output                                                                                               | New runtime dependency (`pnpm license:scan` before adding) | ✅ **APPROVED (2026-06-30):** use a library                  |
| A5  | ~~**Voice / mic** prompt~~                                                                                                                             | —                                                          | ❌ **DROPPED (2026-06-30):** not needed                      |
| A6  | **Fuzzy search ranking** lib (if substring index is deemed insufficient)                                                                               | New dependency                                             | ☐ optional — start with in-house substring index             |

> **Decisions locked 2026-06-30.** Persistence = **JSON files** (one file per
> conversation, app data dir on desktop, sandboxed; browser persists the same JSON
> shape via IndexedDB so a web build still works — see M2). Streaming IPC + the
> `FetchLike` SSE seam are **approved** — build them. Progressive markdown uses a
> **library** (pick a small, well-licensed, streaming-tolerant renderer and run
> `pnpm license:scan` before adding — flag the specific lib in the M4 PR). **Voice/mic
> is dropped** — remove it from M8 entirely (no gated button). Fuzzy search stays
> optional: ship the in-house substring/token index first and only revisit A6 if it's
> insufficient.
