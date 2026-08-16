# ADR 0053 — Persisted edit history + the project history panel

- **Status:** Accepted
- **Date:** 2026-07-12
- **Builds on:** the patch engine + undo/redo stack (PLAN §1.3, `history.ts`),
  ADR 0033 (operation descriptors — reused for human labels), ADR 0034 (MCP
  `stateView` already exposes `historyLength`/`canUndo`/`canRedo`).

## Context

FramePilot records **every** edit — manual and AI — as a validated `Patch` on one
shared undo/redo stack (`EditHistory = { entries: {patch, inverse}[], cursor }`,
`packages/editor-core/src/history.ts`). Until now the UI exposed only two booleans
(`canUndo`/`canRedo`) and single-step ⌘Z / ⌘⇧Z. Users could not *see* what they (or
the AI) changed, nor jump to an arbitrary point. Two gaps blocked a history panel:

1. **No jump-to-index primitive** — the stack only moved ±1.
2. **The web build never persisted history** — `apps/web-editor` hard-coded
   `history: []` on save (the store's `toProject`, `project.ts`, `demo.ts`) even
   though the desktop/MCP session already round-trips it via
   `toPersistedHistory`/`fromPersistedHistory` (`packages/mcp-server/src/session.ts`).
   So an edit stack — and therefore any history panel — died on reload.

## Decision 1 — add `goto`/`gotoProject`, folding the tested primitives

Jump-to-any-point is `goto(project, history, targetCursor)`: clamp the target, then
fold the existing `undoProject`/`redoProject` until the cursor reaches it. It invents
no new apply/invert path, so time-travel inherits the engine's transactional,
validated guarantees and cannot reach an invalid state. A no-op returns the same
references (so React memoization and the store's lift guard short-circuit).

## Decision 2 — persist history in the web build, reusing the desktop contract

`createEditorState` now seeds from `fromPersistedHistory(project.history)` and the
`Editor.tsx` lift writes `toPersistedHistory(editor.state.history)` into the project
on every change. This is exactly the contract the desktop/MCP session already relies
on: persist the *applied* prefix (redo tail dropped), load with `cursor = length`,
and the final timeline plus the full inverse chain make undo correct after reload.
The web build simply stops throwing history away — it does not invent a new format.

## Decision 3 — timestamps as an additive, optional `committedAt`

The history panel shows "2m ago", which needs a wall-clock time the *pure* engine
must not invent. We add an **optional** `committedAt?: number` (epoch ms) to
`HistoryEntry`, stamped by the store at commit time (injectable for deterministic
tests). It is additive and optional: entries persisted before this field load as
`undefined` and render as "earlier". `toPersistedHistory`/`fromPersistedHistory`
already carry extra fields verbatim, so nothing else changes.

## Decision 4 — no Zod schema migration

`ProjectSchema.history` is already `z.array(z.unknown()).default([])` — a deliberate
untyped placeholder that round-trips any JSON. editor-core owns the real
`HistoryEntry` shape and validates it through `fromPersistedHistory`. Because the
persisted **field** is unchanged and every addition is additive-optional, there is
**no `project.fp.json` schema bump and no migration**. Fully typing `history` in Zod
(mirroring the `Patch`/`Operation` unions) remains a possible future hardening, but
is not required for correctness and is intentionally deferred.

## Consequences

- Undo, redo, and the new history panel survive reload in the browser and desktop.
- The five invariants hold: edits still flow validate→apply→record; render-vs-preview
  is untouched; one history policy now spans browser, desktop, and MCP.
- Risk: a persisted inverse assumes the timeline it was computed against. Loading the
  final timeline + the full applied stack preserves that assumption; partial or
  reordered persistence would not — so `toPersistedHistory` remains the only writer.
