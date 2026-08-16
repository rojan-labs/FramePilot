# FramePilot — Agent-Native Editor UX (truthful orchestration, Cursor-grade sidebar, timeline performance)

> **Sub-plan of `plan/PLAN.md` Phase 16.** Read `plan/AGENT-ORCHESTRATION-RELIABILITY.md`
> (Phase 13, transport/context/loop robustness) and `plan/AI-SIDEBAR.md` (Phase 11,
> sidebar shell) first — this plan builds ON those, it does not replace them.
>
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
> **Status:** `[x]` (2026-07-06) — Phases T, U, P (P0 partial/manual, P4 deferred), B shipped;
> see ADR 0041. Original note: root-cause analysis done (2026-07-06); Phase B0 (collapsed-rail
> chrome) done; Phases T/U/P not started.
>
> **Mission:** make the agent experience *truthful* first, then *legible* (Cursor-grade),
> then *fast*. FramePilot must serve video/movie creators the way Cursor serves
> programmers: every claim in the UI is backed by work that actually happened, every
> step is visible while it happens, and the editor never lags under a real project.

---

## 0. Root-cause analysis (evidence, 2026-07-06)

From the live session transcript (`references/d634b706-9906-40cd-b680-fb59d9ce0d31.md`)
plus a code audit. Each finding cites the exact source.

### RC1 — Analysis/action tools NEVER execute in the app's agent loop (P0, the big one)

`Orchestrator.runAgentCall` (`packages/ai-sdk/src/orchestrator.ts:441-447`): a tool of
kind `action` or `analysis` (`analyze_silence`, `detect_scenes`, `render_preview`,
`export_video`) returns **instantly** with `status: 'completed'` and the note
"`<call> (runs on the host)`" — **no host ever runs it**. The sidecar HTTP client that
CAN run analysis exists only in `packages/mcp-server/src/analysis-client.ts` and is not
wired into the browser/desktop agent loop.

Observed consequences (all visible in the transcript):
- The model never receives silence/scene/beat data, so it **re-requests the same
  analysis over and over** ("Analyze silence audio_1_asset_rise_up" 2–3× per turn,
  every turn) and then edits blind — the "beat-sync montage" it promised is physically
  impossible on the data it has (none).
- The UI shows an instant ✅ checkmark for work that never ran — the user's
  "showing checkmark but its running".
- Turns settle before any real analysis could have finished — the user's "even if
  the tool is running, agent stopped".

### RC2 — Tool execution is synchronous, so "running" is never a real state

`orchestrator.ts:1112-1126`: `emit.toolCall(..., 'running')` and
`emit.toolCall(..., outcome.status)` are yielded back-to-back around a **synchronous**
`this.runAgentCall(...)`. There is no awaited boundary, no per-tool cancellation, no
real `runtimeMs`. The spinner exists in the UI (`EventNode.tsx` `ToolStatusIcon`) but
can never be seen. There is also no `cancelled` tool status: aborting a run leaves
whatever was last emitted (usually a checkmark).

### RC3 — No beat-detection capability exists

`packages/ai-sdk/src/tool-registry.ts` registers `analyze_silence` and `detect_scenes`
only. "Align image changes to beats" has no tool to call, so the model substitutes
silence analysis (visible in the transcript) and fakes the rest. The Python engine has
no `/detect-beats` route either.

### RC4 — Mid-run assistant prose is buried in the Reasoning accordion

`orchestrator.ts:1096-1102`: the model's between-tools narration (`turn.text`) is
pushed into the `reasoning` node (collapsed accordion) instead of being emitted as an
interleaved assistant message. Cursor interleaves prose ↔ tool cards; we hide it.
The event model already supports this — `events.ts` orders nodes by first appearance
and keys them by id, so emitting a **new assistant id per text segment** just works;
only the orchestrator routes text wrongly. Markdown rendering already exists
(`Markdown.tsx`, react-markdown, streaming-tolerant).

### RC5 — The plan checklist is not a live todo ledger

`agentOptions.planFirst` drafts a real plan (`orchestrator.ts:1050-1060`) but flattens
it into ONE reasoning line ("Planned 3 steps: …"). The `plan` node steps shown in the
UI are instead derived per-turn from tool-call intents (`:1108-1110`) — so the user
never sees "the plan" as a pinned, progressing todo list (Cursor's To-dos card).

### RC6 — Timeline thumbnail zoom lag (M3/32GB visibly lags)

Suspects from code audit (must be *measured* before fixing — Phase P0):
- `ClipFilmstrip.tsx` renders up to 16 `div`s **per clip** with
  `style={{ backgroundImage: url(...) }}`; the browser-capture fallback tiles a
  **base64 data-URL JPEG** (`useAssetThumbnail.ts` `captureVideoFrame` →
  `canvas.toDataURL`) into every slot of every clip cut from that asset — huge inline
  style strings, re-rasterized on every size change during a zoom gesture.
- Zoom changes every clip's width every frame → every filmstrip re-lays-out; slot
  count is quantized but frame sampling (`clipFilmstripFrames`, `selectors.ts:1156`)
  recomputes and re-picks URLs per render.
- Placeholder canvases repaint per ResizeObserver tick (rAF-coalesced, but still one
  full repaint per clip per frame during zoom).
- Data-URLs are never decoded once and shared — the same JPEG decodes N times.
- Horizontal windowing (ADR 0040) bounds *how many* clips mount, but every mounted
  clip still pays the above on every zoom tick.

### RC7 — Collapsed side-rail chrome reads as a "big border" (fixed 2026-07-06)

`useRailLayout.ts` `COLLAPSED_WIDTH` was 40px of empty `bg-raised` panel + splitter +
hairline. Fixed: 24px, `bg-app`, whole strip is the expand affordance. (Phase B0.)

---

## 1. Target architecture (what changes)

```
                       ┌──────────────────────────────────────────┐
                       │  Orchestrator (streamAgent)              │
                       │  await executor.run(call, signal) ───────┼──► HostToolExecutor (seam)
                       │  ▲ results feed the model's next turn    │      ├─ Browser: fetch → FastAPI sidecar
                       │  │ emit running → (await) → done/failed/ │      ├─ Desktop: IPC → main → sidecar
                       │  │        cancelled (REAL timings)       │      └─ None: honest 'failed' (never fake ✅)
                       └──────────────────────────────────────────┘
Events: interleaved assistant segments · pinned todo (plan) node · tool cards with
real lifecycle · completion report — reduced by the existing events.ts (unchanged shape,
additive event fields only).
```

Invariants that hold throughout: no `project.fp.json` schema change; AI emits patches
only (validate→apply→record); **render-vs-preview** (no ffmpeg in JS — analysis runs in
the Python sidecar); one policy across browser/desktop/MCP; no new store.

---

## 2. Phases (ship in order; each phase = 1–N reviewable PRs)

### Phase T — Truthful tool execution `[x]` (P0 — everything else is cosmetic until this lands)
Owner: ai-tooling-engineer + mcp-engineer. **Fixes RC1/RC2/RC3.**

- [x] **T1 — `HostToolExecutor` seam.** New `packages/ai-sdk/src/tool-executor.ts`:
      `interface HostToolExecutor { run(call: ToolCall, signal?: AbortSignal): Promise<HostToolOutcome> }`
      with `HostToolOutcome = { status: 'completed'|'failed'|'warning'; summary: string; data?: unknown }`.
      Passed via `Orchestrator` constructor options (dependency-injected, mockable).
      `ToolContext` stays read-only/pure — the executor lives beside it, not in it
      (sandbox: tools still can't reach the network; only the orchestrator can).
- [x] **T2 — Async agent-call path.** Make `runAgentCall` async; for `analysis`/`action`
      kinds **await the executor** between the `running` and terminal `toolCall` events,
      thread the run's `AbortSignal`, report REAL `runtimeMs`. No executor configured →
      `status: 'failed'`, summary "analysis engine not available" — **never a fake
      `completed`**. Feed `outcome.data` (bounded preview, R2 B4 style) into the agent
      `log[]` so the model actually consumes the results next turn.
- [x] **T3 — Wire executors on both surfaces.** Extract the sidecar client from
      `packages/mcp-server/src/analysis-client.ts` into a shared module (ai-sdk or a
      small shared package; mcp-server re-uses it — one client, one policy).
      Browser (`editor/ai.ts` `BrowserAiSession`): executor → `fetch` to the sidecar
      (`/analyze-silence`, `/detect-scenes`) with the session's project. Desktop
      (`DesktopAiSession`): main-process executor over the existing AI IPC hub
      (**IPC surface change → maintainer approval per CLAUDE.md §5 before merging**).
- [x] **T4 — Cancellation semantics.** New `ToolStatus` value `'cancelled'` (additive,
      event-log compatible). Stop/abort mid-tool: abort the executor fetch, emit
      `toolCall(..., 'cancelled')`, plan step → `failed` with detail "stopped by user",
      run status → `cancelled`. The UI can then never show ✅ for interrupted work.
- [x] **T5 — In-run analysis dedup.** Cache identical (tool, args-hash) analysis results
      within a run; a repeat call returns the cached data with summary "(cached)".
      Kills the transcript's 2–3× duplicate "Analyze silence" per turn.
- [x] **T6 — `detect_beats` end to end.** Python engine: beat/onset detection route
      (`/detect-beats`; energy-flux onset via numpy over decoded PCM — no new heavy dep
      without `pnpm license:scan` + approval; librosa only if approved). Registry:
      `analysisTool('detect_beats', …)` returning beat timestamps + BPM. This is the
      missing capability the montage use case (the transcript's actual goal) needs.
- [x] **T7 — Tests.** Unit: executor seam (mock executor: await ordering,
      abort → cancelled, failure honesty); orchestrator-stream test extended to assert
      running→completed emission spans the awaited executor. Golden: agent run with
      mocked sidecar returns beat data → the resulting patch places cuts on beats.
      E2E (qa-e2e): stop-mid-analysis shows `cancelled`, never ✅.

### Phase U — Cursor-grade sidebar legibility `[x]`
Owner: ai-tooling-engineer + frontend. **Fixes RC4/RC5; needs T only for honest data.**

- [x] **U1 — Interleaved assistant segments.** Orchestrator: mint a NEW assistant node
      id per between-tools text segment (stream deltas into it live), instead of
      pushing `turn.text` into `reasoning`. Reasoning keeps ONLY actual model
      *thinking* (reasoning deltas from providers that emit them). The reducer already
      supports interleaving — orchestrator-only change + tests.
- [x] **U2 — Live todo ledger.** When `planFirst` produces a plan, emit it as the
      `plan` node immediately (all steps `pending`), then update step status as the
      loop maps turns onto steps (running → completed/failed). Per-turn derived intents
      become the step *detail*, not a replacement checklist. Sidebar pins the todo card
      below the latest user message while the run is live (Cursor's To-dos card).
- [x] **U3 — Timing + completion report.** Reasoning header gains "Thought for Ns"
      (event timestamps already exist). On terminal status, emit a completion-report
      assistant message: what changed (ops applied, clips/tracks touched via
      `describeOperation`), what was skipped and why, next suggestions. Markdown.
- [x] **U4 — Tool-card fidelity.** Card title keeps the human intent; add a compact
      args line (from the schema-validated args) and live elapsed time while
      `running`; `cancelled` gets its own icon/tone. Details modal unchanged.
- [x] **U5 — Header/status truthfulness sweep.** The run spinner, composer state, and
      Stop button must reflect the *event-log* status (single source), including the
      thrown-error and abort paths — audit + e2e for each terminal path.
- [x] **U6 — Docs + changelog.** `docs/guides/` agent-UX guide; ADR for the executor
      seam + event additions; user-facing CHANGELOG entry; changelog-maintainer entry
      for the website.

### Phase P — Timeline thumbnail performance to the root `[x]` (P4 deferred pending measurements)
Owner: performance-optimizer + performance-monitor. **Fixes RC6. Measure → fix → gate.**

- [~] **P0 — Profile first (no fixes in this PR).** *(Superseded in part: RC6 attribution was established by code analysis — per-slot background-image re-rasterization + unbounded decode; the fps budget capture on a reference project remains an e2e/manual follow-up for performance-monitor.)* Reproduce: thumbnails ON, zoom
      in/out on a multi-clip project. Capture a React Profiler + Chrome performance
      trace; attribute main-thread time (style/layout/paint/decode vs React render).
      Publish findings in this file. Budgets set by performance-monitor: zoom gesture
      ≥ 55fps with thumbnails on, 20-clip timeline.
- [x] **P1 — One decoded-bitmap cache.** Decode each thumbnail/captured frame ONCE:
      `createImageBitmap` (worker where available), LRU-bounded (asset count × ~1
      bitmap), keyed by source. Kills N× JPEG re-decode of the same data-URL.
- [x] **P2 — Canvas filmstrip.** Replace the per-clip 16×`background-image` divs with
      ONE `<canvas>` per clip drawn from cached bitmaps. Redraw only when the
      quantized slot count or source window changes (zoom-end / bucket crossings), not
      per zoom tick; DPR-capped backing store (respect the ADR 0040 clamps).
- [x] **P3 — Zoom-gesture coalescing.** During an active zoom gesture, freeze
      filmstrip content (CSS-stretch the last drawn canvas) and redraw once on
      settle (~120ms debounce) — the CapCut/Resolve behavior.
- [ ] **P4 — Engine sprite-sheet (optional, gated on P1–P3 measurements).** If decode
      cost still dominates: engine emits one sprite-sheet per asset instead of N
      thumbnail files; filmstrip blits sub-rects. Schema-adjacent (media metadata) —
      needs migration review if `media.thumbnailPaths` shape changes.
- [x] **P5 — Regression gates.** *(Done 2026-07-06: `ClipFilmstrip.perf.test.tsx` bounds zoom-tick work to slot-bucket crossings; `bitmapCache.test.ts` asserts the one-decode cache-hit guarantee; trace evidence to attach at PR time.)* Non-flaky perf tests (existing `Editor.perf.test.tsx`
      pattern): bounded re-render counts during simulated zoom; bitmap-cache hit
      assertions; before/after trace evidence attached to the PR.

### Phase B — Chrome polish `[x]`
- [x] **B0 — Collapsed rail strip.** `COLLAPSED_WIDTH` 40→24px; strip is `bg-app`,
      whole height is the expand affordance (hover highlight). Both sides. Done 2026-07-06.
- [x] **B1 — Rail transition smoothness.** Collapse/expand animates width
      (`--dur-med`), respecting reduced-motion; splitter hidden while collapsed
      (drag-to-expand retained).

### Phase C — Cursor-parity completion `[~]` (2026-07-08)
Owner: ai-tooling-engineer + frontend. **Reconciliation:** Phase U shipped the *routing
away from* reasoning (U1) and a live ledger (U2), but a live desktop montage run still
showed conversational prose **and a "Would you like me to proceed?" question rendered as
todo rows**, and the Reasoning accordion never streamed real model thinking. Root causes:
`generateAgentPlan` returned free-form prose that `parsePlanLines` swept wholesale into
the ledger; and **no provider emits a reasoning channel** (`ProviderChunk` had no
reasoning type), so U1's "reasoning keeps only real thinking" left the accordion empty.
These three slices finish the Cursor-parity surface split.

- [x] **C1 — Clean todo, prose to chat.** `parseAgentPlan` splits a plan-draft response
      into actionable list items (→ the todo ledger) vs. prose/questions (→ a chat
      assistant message). `generateAgentPlan` prompt hardened to keep questions out of the
      numbered list; the streaming `draftPlan` handler emits the prose as its own assistant
      segment. Unit + stream tests. **Done 2026-07-08.**
- [ ] **C2 — Real reasoning tokens.** Add a `reasoning-delta` `ProviderChunk`; route it in
      `streamAssistant` → the existing `reasoningDelta` emitter (reducer already appends).
      Settle the reasoning node without clobbering streamed thinking. Desktop Anthropic
      client maps extended-thinking deltas → `reasoning-delta` (provider-level, no IPC
      surface change — the event stream already forwards `reasoning_delta`). Mock emits a
      scripted thought so the accordion works offline. Additive: providers that don't emit
      it produce byte-identical streams (parity suite unaffected).
- [ ] **C3 — Interactive ask-and-wait.** An `ask_user` capability: when the agent needs
      confirmation/clarification it posts the question to chat, the run PAUSES (a `waiting`
      terminal state persisting a resume checkpoint with applied ops + remaining plan), and
      the user's next message RESUMES the run with the answer threaded in. Sidebar keeps the
      composer live in `waiting`. **Approvals (CLAUDE.md §5):** new agent tool = tool-
      permission surface; desktop resume-with-answer may touch the AI IPC contract — ask
      before merging.

---

## 3. Definition of Done (whole sub-plan)

1. A montage request like the reference transcript's ("cut to the beat") produces:
   real `detect_beats` data → visible running tool cards with true durations → an
   interleaved narrated run → a todo ledger that completes → a reviewable patch whose
   cuts land on the returned beats. No fabricated ✅ anywhere.
2. Stop at ANY moment yields `cancelled` states — tool card, plan step, run status —
   within one frame batch; Resume still works from the checkpoint.
3. Zoom in/out with thumbnails on holds the agreed fps budget on the reference
   project; perf gates in CI.
4. `pnpm verify` green; 100% coverage on the executor seam + event reducer additions;
   docs/ADR/CHANGELOG updated; plan files reconciled.

## 4. Approvals required BEFORE crossing gates (CLAUDE.md §5)

- **T3 desktop executor:** broadens the IPC surface — ask first.
- **T6 beat detection:** any new Python dep (librosa etc.) — `license:scan` + ask;
  prefer numpy-only onset detection (no new dep).
- **P4 sprite-sheet:** if it touches `media` metadata shape — migration + ask.

## 5. Suggested PR sequence

1. T1+T2 (seam + async loop, mock-executor tests) — pure ai-sdk, no surface change.
2. T3 browser wiring + T5 dedup. 3. T3 desktop wiring (after approval) + T4 cancelled.
4. T6 beats (engine → registry → golden test). 5. U1+U2. 6. U3+U4+U5+U6.
7. P0 (findings only). 8. P1+P2. 9. P3+P5 (+P4 if warranted). 10. B1.
