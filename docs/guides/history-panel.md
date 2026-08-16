# Project History Panel

The History panel is the visible, scrubbable record of every edit in a project —
manual **and** AI — with the ability to jump to any point in time. It is a *view*
over the same undo/redo engine every edit already flows through; it does not add a
second editing path.

Background reading:
[../architecture/timeline-and-patch-engine.md](../architecture/timeline-and-patch-engine.md),
[../adr/0053-persisted-edit-history-and-history-panel.md](../adr/0053-persisted-edit-history-and-history-panel.md).

---

## For users

- Open it from the **History** button in the header, or press **⌘⇧H** (Ctrl+Shift+H).
- Each row is one committed edit, oldest at the top:
  - a plain-language label and the affected clip/track/asset (e.g. "Trimmed
    Intro.mp4 · Video 1");
  - a **You** or **AI** badge — and, for AI edits, the reason the agent gave;
  - how long ago it happened.
- The **current point** is highlighted. Edits you've undone are shown **dimmed**
  below it — they're still there until your next edit replaces them.
- **Click any row to time-travel** the whole project to that state. Use the
  Undo / Redo / Jump-to-start / Jump-to-latest controls at the top too.
- **Hover a row** to preview exactly what it changed (before → after).
- Filter by **All / You / AI** to isolate the agent's work from your own.
- History is saved with the project, so it survives closing and reopening.

## For engineers

The panel is `apps/web-editor/src/components/HistoryPanel.tsx`. Key design points:

- **Single source of truth.** It reads `editor.history` (`{ entries, cursor }`)
  from the store — the same `EditHistory` the patch engine maintains
  (`packages/editor-core/src/history.ts`). `entries[0..cursor)` are applied;
  `entries[cursor..]` are the redo tail.
- **Jump = fold undo/redo.** Clicking a row calls `editor.goto(index)`, backed by
  `gotoProject` in `history.ts`, which folds the tested `undoProject`/`redoProject`
  primitives to move the cursor. Time-travel therefore inherits the engine's
  transactional, validated guarantees — it cannot reach an invalid state.
- **Labels + chips are shared with the AI sidebar.** `describeOperation(op, names)`
  (`packages/ai-sdk/src/describe.ts`) provides the label and clickable
  clip/track/asset chips; `projectNames(project)` resolves ids to friendly names.
- **Hover before/after** reconstructs the two bracketing states by folding each
  entry's already-stored `patch`/`inverse` outward from the current state (no
  re-inversion, no store mutation), then runs `diffTimeline(before, after)`.
- **Provenance + time.** `Patch.createdBy` (`'user' | 'agent'`) drives the badge
  and filter; an additive, optional `HistoryEntry.committedAt` (stamped by the
  store at commit) drives the relative timestamp.
- **Persistence.** `createEditorState` seeds from `fromPersistedHistory(project.history)`
  and `Editor.tsx` lifts `toPersistedHistory(...)` back into the project — the same
  contract the desktop/MCP session uses. No `project.fp.json` schema change.

### Adding a new operation to the panel

Nothing panel-specific is required: a new operation gets a human label
automatically once it's added to `ACTION_LABELS` in `describe.ts` (see
[adding-a-timeline-operation.md](adding-a-timeline-operation.md)). Optionally add
an icon case in `HistoryPanel.tsx`'s `opIcon` — it falls back to a generic icon.
