# ADR 0033 — Streaming AI sidebar architecture (Phase 11)

- **Status:** Accepted
- **Date:** 2026-06-30
- **Phase:** 11 — Cursor-Class AI Sidebar (`apps/web-editor`, `packages/ai-sdk`, `apps/desktop`)
- **Execution plan:** [`plan/AI-SIDEBAR.md`](../../plan/AI-SIDEBAR.md) (M0–M9)
- **Relates to:** ADR 0012 (AI layer / orchestrator), ADR 0022 (agent mode & Critic),
  ADR 0023 (shared IPC contract), ADR 0025 (path sandbox / renderer CSP),
  ADR 0028 (Notion dark design system)

## Context

Through Phase 7 the AI layer (ADR 0012, 0022) shipped `chat`/`plan`/`edit`/
`autocomplete`/`agent`/`review`, but **every mode returns a complete result** — the
provider exposes only `complete()`, the orchestrator awaits a final value, and the
agent loop runs to completion before the UI sees anything. The right-rail
`AiPanel.tsx` is a single-shot request→response form.

Phase 11 turns that into a **streaming, persistent, interruptible, Cursor-class
sidebar**: reasoning summaries, an agent plan checklist, tool-activity cards, live
progress, diffs, and errors all appear _as they happen_, conversations persist across
restarts, and any long operation can be stopped and resumed.

Two forces shaped the design:

1. **The five AGENTS.md invariants still bind.** No `project.fp.json` schema change;
   AI edits land ONLY through the tool registry → orchestrator → validated `Patch` →
   `validate→apply→record` path; render-vs-preview holds; no new dependency / IPC
   channel / persisted store without approval (CLAUDE.md §5).
2. **The event model is load-bearing.** Ten milestones depend on it. If it churns,
   every layer breaks. So it is locked here, in M0, before any UI work.

## Decision

### 1. Everything the AI does becomes a typed, append-only `AiEvent`

The single architectural idea: a conversation **is** an ordered list of `AiEvent`s,
and the UI is a pure function of that log. Streaming is "append/patch events";
persistence is "save the log"; interruption is "stop emitting events". Events carry
stable string `id`s and **update in place by `id`** — a streamed delta or a tool-status
change re-emits the same `id` rather than appending a duplicate row.

The union lives in a new module `packages/ai-sdk/src/events.ts` (exported from the
barrel) and is the contract every later milestone consumes:

`UserMessageEvent`, `AssistantDeltaEvent` (`{ parentId, chunk }`), `AssistantMessageEvent`
(terminal, canonical markdown), `ReasoningEvent` (concise **summary**, never raw CoT),
`PlanEvent` (live checklist), `ToolCallEvent` (status `running→completed/warning/failed`,
mutated in place), `ToolResultEvent` (expandable detail), `TimelineActionEvent`,
`DiffEvent` (wraps an existing `EditResult`), `ProgressEvent` (0..1), `ReferenceEvent`,
`NotificationEvent`, `WarningEvent`, `ErrorEvent`, `StatusEvent` (lifecycle).

A pure `reduceEvents(events) → ConversationView` reducer folds the log into render
state: it appends delta chunks to their `parentId` message and merges tool-status by
`id`. The reducer and the union are held to 100% coverage.

**Reasoning summaries are derived deterministically from loop transitions** (a tool is
about to run → "Searching timeline"), never from the model's hidden reasoning tokens.
This honors the AGENTS.md invariant-4 spirit and the spec rule "never expose raw CoT".

### 2. Streaming providers and orchestrator — `complete()` is preserved

`AiProvider` gains `stream(request, signal?): AsyncIterable<ProviderChunk>` where
`ProviderChunk = text-delta | tool-call | done`. `complete()` stays (it can be
implemented as "drain the stream"), so nothing downstream breaks.

The orchestrator gains `streamChat`/`streamPlan`/`streamEdit`/`streamAgent` that yield
`AiEvent`s and accept an `AbortSignal`. `streamEdit` still ends in a `DiffEvent`
wrapping the existing `EditResult` — **the validated-patch path is unchanged**.
`streamAgent` emits the plan/reasoning/tool/progress/action events and a terminal
combined `DiffEvent`; it checks `signal.aborted` between steps and after each tool call,
emitting a terminal `StatusEvent{status:'cancelled'}` and returning the partial run.
Mutating tool calls still flow through `assembleEdit → validatePatch`; **nothing
auto-applies** (invariant 5).

The deterministic `MockProvider.stream()` is the default and the **test backbone** —
the whole sidebar works offline against scripted chunks. Anthropic/NVIDIA `stream()`
parse SSE, tested against captured fixtures (no network).

### 3. `FetchLike` gains a minimal SSE-readable body seam (Approval A3)

`FetchLike` today returns `text()` only. Streaming needs an incremental reader, so the
response type is extended with an **optional** `body?: ReadableStream<Uint8Array>` (Web
Streams, already in Node 18+ and the browser). `complete()` keeps using `text()`;
`stream()` reads `body`. The seam stays injectable and unit-testable offline (tests feed
a `ReadableStream` built from fixture bytes). No new dependency.

### 4. Conversations are a separate store — `project.fp.json` is untouched (Approval A1)

New types `Conversation` / `ConversationUiState` and pure helpers (`appendEvent`,
`deriveTitle`, `groupByDate`, `markRead`) in `apps/web-editor/src/ai/conversation.ts`,
plus an in-memory store + `useConversations()` hook mirroring `useEditor`. **Stream
updates must not re-render the whole list** — subscription is per-event so only the
changed row updates (the 20k-event perf requirement).

**Persistence is JSON files (A1 ✅).** One canonical JSON record **per conversation**:

- **Desktop (canonical):** a JSON file under the app data dir
  (`…/FramePilot/conversations/<id>.json`) via new IPC channels
  `conversations:list/load/save/delete`, sandboxed by mirroring the existing
  projects-root sandbox (ADR 0025/0026).
- **Browser/dev:** the **byte-identical JSON record** in IndexedDB (localStorage is too
  small for 20k-event logs). Because both sides store the same shape, the persistence
  adapter is a thin storage swap behind one `ConversationPersistence` interface — not
  two formats.

Writes are incremental (append events; debounce `uiState`). The existing `aiMemory`
field (style/accept/reject learning) is **not** touched. A per-conversation size budget
and optional prune policy are decided in M2.

### 5. `AiSession` is the one transport facade the UI depends on

`AiSession` (evolving `OrchestratorLike` in `apps/web-editor/src/editor/ai.ts`):
`run(mode, input, signal): AsyncIterable<AiEvent>` + `abort()`. Two implementations
behind the same interface:

- **Browser:** a thin wrapper over the M1 `Orchestrator.stream*` (no IPC).
- **Desktop (Approval A2 ✅):** a **streaming push channel** — `ipcMain` emits
  `framepilot:ai:event` scoped by a `requestId`, with a `framepilot:ai:abort` channel.
  The upstream `fetch` runs in the main process (Node, no sandbox); events are pushed to
  the renderer. Channel + event types are single-sourced in `@framepilot/shared-types`
  and `ipc/contract.ts`.

**security-reviewer gate (M3):** abort must actually cancel the upstream fetch (thread
the `AbortSignal` to the provider); no event may leak after abort; `requestId` scoping
prevents cross-conversation delivery; no secrets cross the bridge. The offline mock path
needs **no** IPC, so browser builds and tests never touch the bridge.

### 6. UI: a virtualized log of per-type renderers (M4–M8)

`components/ai/AiSidebar.tsx` replaces the `AiPanel` body at the existing mount point
(`Editor.tsx:351`): fixed header (mode segmented control, History, New Chat, Search,
Settings, Model selector, Collapse) over a **virtualized** event list
(`@tanstack/react-virtual`, already a dependency — **no new dep**) over a docked
composer. One renderer per `AiEvent` type with a distinct visual treatment; status
colors map to **existing** semantic tokens (running→accent, completed→green,
warning→yellow, failed→red, idle→gray — no invented colors). Auto-scroll with a "Jump to
Latest" affordance; `prefers-reduced-motion`-gated transitions; full keyboard nav and SR
labels.

Progressive assistant markdown uses a **library** (Approval A4 ✅) — a small,
well-licensed, streaming-tolerant renderer chosen and `pnpm license:scan`-cleared in the
M4 PR (named there, not here).

### 7. What is explicitly out of scope

- **Voice/mic prompt — DROPPED (Approval A5).** No mic button, no transcription path, no
  related dependency.
- **Fuzzy-search ranking — optional (Approval A6).** Ship an in-house substring/token
  index first; revisit a fuzzy library only if that proves insufficient.

## Spike notes (M0)

- **SSE through the injected seam:** confirmed both wire formats parse from an
  incremental byte reader without a network. Anthropic Messages SSE frames the stream as
  `event:`/`data:` lines with `content_block_delta` (`text_delta` / `input_json_delta`),
  `content_block_start` (tool_use id+name), and `message_delta`/`message_stop`. NVIDIA's
  OpenAI-compatible endpoint emits `data:` JSON chunks with
  `choices[].delta.{content,tool_calls}` terminated by `data: [DONE]`. Both collapse onto
  the same `ProviderChunk` union, so the mock remains the contract.
- **`FetchLike` extension is minimal:** adding `body?: ReadableStream<Uint8Array>`
  (optional) is the smallest change that unblocks streaming while leaving `complete()`
  and every existing test untouched. Decided in favor of this over a bespoke reader
  callback because Web Streams are already available in both runtimes.
- **Event-id stability:** deltas reference a `parentId`; tool lifecycle re-emits the same
  `id`. The reducer keys by `id`, so a reload that replays only terminal events
  (`AssistantMessageEvent`, final `ToolCallEvent` status) renders identically without
  replaying deltas — which is why the terminal message carries canonical markdown.

## Approvals (plan/AI-SIDEBAR.md §9) — resolved 2026-06-30

| #   | Gate                                      | Decision                                                            |
| --- | ----------------------------------------- | ------------------------------------------------------------------- |
| A1  | Conversation persistence store            | ✅ **JSON files** (desktop primary; browser same JSON in IndexedDB) |
| A2  | Streaming AI IPC channels + `AbortSignal` | ✅ **Approved**                                                     |
| A3  | `FetchLike` SSE-readable body extension   | ✅ **Approved** (optional `body` field)                             |
| A4  | Markdown renderer for progressive output  | ✅ **Approved** — library, named + license-scanned in M4            |
| A5  | Voice / mic prompt                        | ❌ **Dropped**                                                      |
| A6  | Fuzzy search ranking lib                  | ☐ **Optional** — in-house substring index first                     |

## Consequences

- **No schema change, no migration.** Conversations live in their own JSON store; the
  project file and `aiMemory` are untouched.
- The orchestrator stays the **sole** patch assembler; streaming variants reuse the same
  `operationsFor → assembleEdit → validatePatch` gate. A streamed run cannot bypass the
  tool boundary.
- `events.ts` + the reducer become a **stable contract** treated like the timeline
  schema: changes need a deliberate review, not an ad-hoc edit.
- The desktop IPC surface grows (streaming AI channel + conversation persistence
  channels); each is `requestId`/path-sandbox scoped and gated by the security-reviewer
  in M3/M2.
- Ten independently-shippable PRs (M0–M9), never combined, each with tests + 100%
  coverage on new pure modules + CHANGELOG + plan tick.

## Status update — 2026-07-01: sub-plan complete

All milestones M0–M9 have landed. M9 (final): committed the reducer perf-budget test,
added sidebar accessibility assertions, rewrote the offline Playwright E2E for the
streaming sidebar with new visual baselines, wrote the user guide
(`docs/guides/ai-sidebar.md`), and removed the retired single-shot `AiPanel`. The
sidebar was also reskinned to a Cursor-class look on the retuned design tokens (see
ADR 0028 amendment) as part of the same UI pass. This ADR is now fully realised.

## Amendment — 2026-07-25: conversations are project-owned

The original separate store was app-wide and its records had no project identifier.
That made persistence independent of `project.fp.json`, but it also meant every open
project listed every conversation. Each conversation and its lightweight index summary
now carry a required `projectId`. A project-scoped persistence guard filters list/load
and rejects cross-project save/delete before the UI store sees a record.

Legacy records without `projectId` are deliberately not assigned to whichever project
opens first: their ownership cannot be reconstructed safely, so parsing hides them.
The desktop file-per-conversation and browser IndexedDB backends remain byte-identical
and app-wide; ownership is an explicit record invariant at their shared adapter boundary.

## Amendment — 2026-07-01: progress clarity, full tool coverage & model picker

A follow-up pass closed the gap between "the sidebar streams" and "the stream is
_legible and capable_". No new invariant is introduced; all original constraints hold.

- **Progress is derived, not hardcoded.** The agent loop previously emitted a fixed
  `"Step N: analyzing the timeline"` reasoning line and an `"Agent progress"` bar keyed
  to `index/maxSteps`. It now derives reasoning summaries, the plan-step labels, the
  single progress bar's label, tool-card titles, and timeline-action cards from the
  **actual tool calls + their arguments + resolved entity names**. Two pure additions
  carry this: `projectNames(project)` (`packages/ai-sdk/src/names.ts`) resolves
  clip→asset-filename / track→"Video 1" / asset→filename; `describeToolCall` +
  an extended `describeOperation(op, names?)` produce the human phrases. Chain-of-thought
  is still never surfaced — summaries come only from tool/plan transitions. `emit.progress`
  gained an optional stable `key` so the run shows **one** moving bar (id keyed by `key`)
  rather than a new bar per label.
- **`set_track_flags` completes UI parity.** Mute/lock/hide was an editor-core op (v4)
  with no AI tool. It is now registered (TS registry + Python Pydantic mirror + handler),
  and — a gap this pass also closed — the **Python engine's operation union gained a
  `SetTrackFlags` op** (apply/invert/validator) so engine and editor share one semantics
  and the op round-trips. Surfaced automatically over MCP. No schema change (the flags
  already exist on `Track`).
- **Desktop model/provider selection.** A new read-only `ai:providers` IPC returns
  `{name,label,model,ready}[]` (the API key is **never** returned — only whether it is
  configured); `AiStreamRequest` gained an optional, allowlist-validated `provider` that
  `AiStreamHub.orchestratorFor(provider)` honors, falling back to the env default. The
  sidebar header renders a model picker from this; the browser stays mock-only. This is
  the "real-provider streaming over IPC" the original ADR deferred, now user-selectable.

## Deferred

- Fuzzy search ranking (A6) — only if the in-house index is insufficient.
- Per-conversation retention/prune policy — sized and decided in M2.
- Real-provider streaming over IPC is built in M3; until then the mock stream is the
  contract and the offline default.
- Resuming an aborted agent run from its last checkpoint (Retry re-runs instead).
