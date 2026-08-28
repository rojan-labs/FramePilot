# FramePilot system map

> Written 2026-08-29 for `plan/system-mission/` P0.1 and kept current by every later
> phase. One section per boundary; each names the module that owns each side and the
> shape that crosses it. Where two implementations of one policy exist, it is called out
> under **§10 Parity candidates** — that list is Phase 2's input.

## 0. The flow

```text
User
 └─ apps/web-editor (React) ── AiSidebar / Composer / TimelineView / Preview / Inspector / MediaBin / ExportDialog
      └─ window.framepilot bridge (apps/desktop/electron/preload.cts) ──── 'framepilot:*' IPC channels
           └─ apps/desktop/electron/main.ts  registerIpcHandlers()  (+ ipc/, ai/, render/, media/, sidecar/, capability-packs/)
                ├─ @framepilot/ai-sdk  Orchestrator.streamAgent → kernel/agent-graph (LangGraph shell) → kernel/conductor (pure decisions)
                │     ├─ effects: model | model_stream | host_tool | host_analysis | deterministic_transform | patch_propose | patch_validate | patch_commit | render | verification | persistence | user_wait | agent
                │     ├─ domain-tools/* (tool specs) → controllers/* (audio, color, motion, timeline, tracking) → editor-core ops → Patch
                │     └─ proposers/* (plan, edit-signals, critic) · context-builder + kernel/context (tiers, budget, manifest, invariants)
                ├─ @framepilot/editor-core  operations.ts / professional-commands.ts / patch.ts (apply · invert · validate · diff · history)
                ├─ @framepilot/timeline-schema  Project Zod schema, SCHEMA_VERSION = 21, migrations
                └─ Python sidecar (engine/python/framepilot_engine/service.py, FastAPI) — spawned by main.ts spawnSidecar()
                      ├─ analysis: /inspect-media /analyze /analyze/batch /analyze-silence /detect-beats /detect-scenes /transcribe /asr/*
                      ├─ brain: /brain/index /brain/search /brain/similar /brain/memory /brain/session-context /brain/visual/* (footage map, describe)
                      ├─ render: /render/preview /render/frame /render/jobs/{id} /render/jobs/{id}/cancel /validate-render  (pipeline.py → compiler.py → MoviePy/FFmpeg)
                      └─ misc: /health /asset-media /review/temporal-evidence
Preview: apps/web-editor/src/preview (WebCodecs demux/decode/compositor, HTML video fallback) — never MoviePy.
Export : ExportDialog → 'framepilot:render:export-start' → electron/render/export-client.ts → sidecar /render → export-hub.ts progress → export-save.ts (Save As / reveal).
```

## 1. Renderer ↔ main (IPC)

**Owner (renderer side):** `apps/desktop/electron/preload.cts` exposes `window.framepilot`;
`apps/web-editor/src/editor/bridge.ts` / `bridge-base.ts` wrap it (browser fallback in
`browser-run-store.ts`). **Owner (main side):** `main.ts` `registerIpcHandlers()` (lines
529–2868 — one function, split candidate for Phase 6 P6.3) plus `ipc/`, `ai/run-ipc.ts`.

Channel families (all prefixed `framepilot:`):

| Family | Channels | Crossing shape |
| --- | --- | --- |
| project | `project:open`, `open-dialog`, `recent`, `save`, `save-default`, `snapshot`, `commit-patch`, `changed`, `dir`, `reveal` | `Project` (schema v21), `Patch`, revision ids; **host-authoritative commit** (`ai/commit-target.ts`, `patch-settlement.ts`) |
| media | `media:import`, `import-asset`, `import-chunk` | file bytes → enrolled asset under project sandbox (`media/asset-enrolment.ts`, `asset-paths.ts`) |
| ai (legacy single-shot) | `ai:chat`, `ai:edit`, `ai:plan`, `ai:transcribe`, `ai:providers`, `ai:config-get/set` | `AiStreamRequest`-shaped payloads; keys never cross (config stays in main) |
| ai (stream) | `ai:stream-start`, `stream-event`, `stream-answer`, `stream-abort` | `ai/ai-stream.ts` (50 KB) builds host tools + context and drives `Orchestrator` |
| run (durable) | `run:start`, `command`, `event`, `ack`, `snapshot`, `subscribe`, `unsubscribe` | `ai/run-coordinator-base.ts` (49 KB), `run-store.ts`, `durable-run-controls.ts` — replayable run events |
| render | `render:export`, `export-start`, `export-progress`, `export-cancel`, `export:save-as` | `render/export-client.ts`, `export-hub.ts`, `export-save.ts`; request carries **`preset` id today** (Phase 7 replaces with `ExportSettings`) |
| stock / music | `stock:search/preview/download/…`, `music:search/preview/download/…` | `ai/stock-host.ts`; shared by UI and agent (see memory note "agent shares panel services") |
| capability-pack | `capability-pack:*` (14 channels) | `packages/capability-packs` install/track/evict |
| conversations | `conversations:list/load/save/delete` | `ai/conversation-store.ts` — persists `ConversationUiState` incl. attachment chips |
| visual-index, sidecar:status, license:*, ping | — | status/boolean payloads |

Security: `contextIsolation`, `sandbox`, `hardenRendererSession()` (main.ts:2945);
`fp-media://` protocol serves sandboxed media + derived proxies.

## 2. Main ↔ sidecar (HTTP)

**Owner:** `electron/sidecar/manager.ts`, `spawn.ts` (lifecycle), `main.ts`
`spawnSidecar()`/`probeHealth()`; engine `service.py` (243 KB, single module). Routes as
listed in §0. Request/response models are Pydantic in `service.py` + `render/pipeline.py`
(`RenderRequest`, `RenderOptions`, `RenderTask`, `RenderJob`) + `validation/`
(`ValidationReport`). Analysis results are cached in the brain DBs (SQLite under the
project) and mirrored by the ai-sdk evidence store.

Lifecycle today: one sidecar per app; render jobs via `render/queue.py`; cancel via
route; **no unified registry of FFmpeg/ffprobe children** (Phase 5 P5.3).

## 3. AI layer internals (`packages/ai-sdk`)

| Piece | Module | Crossing shape |
| --- | --- | --- |
| Entry | `orchestrator.ts` (`Orchestrator.streamAgent`, ~6k lines) | `AiStreamRequest` in; `AgentEvent` stream out |
| Runtime | `kernel/agent-graph.ts` (LangGraph nodes) → `kernel/conductor.ts` (pure decisions, 110 KB) | `ConductorEffect` / `EffectResult` |
| Effects | `kernel/effects.ts`, `effect-runtime.ts` | 13 kinds (§0) |
| State | `kernel/working-state.ts` (50 KB), `commit-ledger.ts`, `evidence-store.ts`, `event-log.ts` | run-scoped |
| Context | `context-builder.ts`, `kernel/context/{tiers,budget,manifest,invariants}`, `kernel/briefing.ts`, `kernel/semantic-index/*` | prompt blocks + token manifest |
| Policy | `kernel/stage-policy.ts`, `loop-detector.ts`, `continuation.ts`, `completion-gate.ts`, `acceptance.ts`, `agent-run-quality.ts` | stop/continue verdicts |
| Proposers | `kernel/proposers/{critic,edit-signals,…}.ts` | `ProposerResult` via `proposerModelEffect` |
| Tools | `domain-tools/*` specs → `autonomous-tool-router.ts` / `autonomous-tool-contract.ts` → `controllers/*` | tool args (zod) → ops → `Patch` |
| Memory | Memory Store (project-persisted, PRD §8.7) + `brain` `/brain/memory` | style/pacing/accepted-rejected |
| Metrics | `kernel/cost/{run-metrics,cost-meter,usage-summary,baseline-capture,analysis-caps}.ts` | `TurnSample` → percentiles |
| Eval | `eval/foundation-real-eval.ts`, `scripts/context-benchmark.mjs`, `kernel/replay/` | JSON reports |
| Mirrors | `autonomous-tools.manifest.json`, Python `ai_tools/`, `packages/mcp-server` | generated by `scripts/generate-*.mjs` |

Attachments: `apps/web-editor/src/ai/conversation.ts` `Attachment{id,kind,name}` chips in
`AiSidebar.tsx` state → persisted via `conversations:save`; **not** on `AiStreamRequest`.
Images reach the model only as `HostToolOutcome.images` from `get_frame`.

## 4. Editing engine

`packages/timeline-schema` (Zod, v21, migrations) ↔ `engine/python/.../timeline/models.py`
(Pydantic, strict version equality) — drift tests exist. `packages/editor-core`:
`operations.ts` (apply/invert per op), `professional-commands.ts`, `patch.ts` (validate,
diff), `history.ts`, `frame-grid.ts` (ADR 0146: runs for UI and AI patches),
`picture-occupancy.ts` (single picture layer, ADR 0140), `edit-boundaries.ts`.
UI builds raw ops through `apps/web-editor/src/editor/patch-builders-base.ts` (122 KB) —
the UI does **not** go through `EditorCommand` (memory note); AI goes tools → controllers.

## 5. Preview

`apps/web-editor/src/preview/{demux,decode,engine,effects,transitions,clock}` — WebCodecs
compositor with GL effect chain; HTML `<video>` fallback; `bitmapCache.ts`, `lruCache.ts`,
`frameBatcher.ts`. Proxies come from the sidecar on desktop. Never MoviePy.

## 6. Export

`ExportDialog.tsx` (preset + burn-in + loudness/EQ) → IPC `render:export-start` →
`export-client.ts` → `POST /render` → `pipeline.py` `render()` (synchronous driver:
queued → preparing_assets → rendering_frames → encoding → validating_output) →
`compiler.py` (`compile_timeline`) → MoviePy `write_videofile` (libx264/aac; **no
hardware encoder**) → `validate_render` → `export-hub.ts` progress → `export-save.ts`.
Presets: `render/presets.py` `EXPORT_PRESETS` {reels,tiktok,shorts,youtube,square}
hand-mirrored in `ExportDialog.tsx`; unknown id falls back to Reels.

## 7. Persistence

Project: `project.fp.json` (schema v21) under `FRAMEPILOT_PROJECTS_ROOT/<project>`;
autosave + recovery (`userDataFileIO`, `activeProjectIO` in main.ts). Conversations:
`conversationDirIO()` JSON per conversation. Runs: `ai/run-store.ts` (retention-tested).
View prefs: web-editor `useViewPrefs`-style hook (localStorage/keyed). Brain: SQLite
DBs per project (sidecar). Evidence: ai-sdk evidence store (run) + brain cache (durable).

## 8. Tests and CI

TS: vitest per package (`turbo run test:coverage` in CI, ADR 0110 no threshold).
Python: pytest (954 green baseline), ruff, mypy strict. E2E: `tests/e2e` Playwright,
web-editor host, 25 specs; visual snapshots. Parity: tool-parity fixture, schema drift,
caption template drift, golden token manifests. No desktop-host e2e; no resource test.

## 9. Observability

`createLogger` scoped logs (TS) / `logging.getLogger` (Python); `framepilot.runs.jsonl`
per-tool rows (ts, tool, kind, status, runtimeMs, fromCache, argsSummary); telemetry
in `electron/telemetry`; cost meter per run in the sidebar.

## 10. Parity candidates (two implementations of one policy)

1. Export presets: `presets.py` ↔ `ExportDialog.tsx` (hand-mirrored) → Phase 7 deletes both.
2. Loudness / EQ preset lists: engine `audio.filters` ↔ `ExportDialog.tsx` constants.
3. Tool descriptions: TS `domain-tools` ↔ generated Python `ai_tools` ↔ MCP — generated, but the parity fixture compares names/shapes, not descriptions → P2.3.
4. Host context assembly: desktop `ai/ai-stream.ts` vs web-editor `editor/ai.ts` (62 KB) vs eval rig → P2.4.
5. ASR: manual transcribe via IPC/TS hosted provider vs agent `transcribe` via sidecar (documented two-path) → keep, document in §"Intentional host differences".
6. `main.ts` legacy `ai:chat/edit/plan` vs `ai:stream-*` vs `run:*` — three generations of the same entry → P1/P6 candidate for deletion of the legacy pair once nothing calls it.
7. Caption style: `captionStyle.ts` ↔ `captions.py` parity contract (tested) — keep.

## Intentional host differences

- Desktop has the sidecar: local ASR, proxies, footage map, render. Browser build has none
  of these; browser-only gaps are acceptable (CLAUDE.md product focus).
