# ADR 0030 — Live project-file sync (watch → push → reload) and a virtualized media bin

- **Status:** Accepted
- **Date:** 2026-06-28
- **Builds on:** ADR 0027 (MCP active-project pointer), ADR 0023 (shared IPC
  contract), ADR 0016 (autosave/export), ADR 0026 (project-scoped asset/folder ops).

## Context

An external AI agent edits the user's open project through the MCP server
(ADR 0027): it opens the active `project.fp.json`, applies validated patches, and
writes the file atomically. The desktop app, however, only read that file **once**
on open — into `App`'s `project` state and the `useEditor` store. Nothing watched
the file, and the preload bridge was request/response only (no main→renderer
push). So an agent's reorganization of clips/folders never appeared until the user
re-opened the project. We want those edits to show up **live, end to end**.

Separately, the media bin (`MediaBin`) rendered its entire asset/folder tree with
`.map()` — no windowing, no row memoization, and `useAssetThumbnail` fired a
`<video>`→canvas capture for _every_ video at once. With dozens of clips/images
the bin was visibly janky.

## Decision

### 1. Watch the open file and push validated changes to the renderer

- A new tested, IO-injected `ProjectFileWatcher` (`apps/desktop/electron/projects/
project-watcher.ts`) owns the dedup + debounce logic. The Electron glue in
  `main.ts` watches the project's **containing directory** (filtered to the file
  name) — an atomic save is temp-write + rename, which replaces the inode and
  would deafen a per-file watch.
- **Self-write suppression:** the app autosaves the same file, so the watcher
  dedups on the _canonical serialization_ (`serializeProject`, now re-exported on
  the `@framepilot/timeline-schema/file` subpath). Every emit and every
  `markSelfWrite(path, project)` (called by both save handlers before writing)
  updates a baseline string; an fs event whose re-read serializes identically is
  dropped. Reads that fail mid-rename are swallowed (keep watching), never emitted.
- A new **push** IPC channel `framepilot:project:changed` carries a
  `ProjectChangedEvent { path, project }` (project `unknown` until validated). The
  preload exposes `onProjectChanged(listener) → unsubscribe`, wrapping
  `ipcRenderer.on` so the renderer only ever sees the payload, never the privileged
  `IpcRendererEvent`.

### 2. Auto-reload live (file on disk is the source of truth)

The renderer `onProjectChanged` helper validates the on-disk document with
`safeParseProject` (a malformed external write is dropped, never coerced — AGENTS.md
invariant 3). `App` subscribes once and, on a change, reloads `project`, suppresses
the autosave echo, and bumps a `reloadNonce` folded into the `Editor` key so the
`useEditor` store re-seeds from the new timeline/bin. We chose **auto-reload** over
a manual banner because the whole point of the MCP workflow is "AI edits, I watch it
happen"; the on-disk file wins and local undo history resets to it.

### 3. Virtualize the media bin

- `MediaBin` flattens the visible folder tree (honouring collapse state) into one
  ordered row list and windows it with **`@tanstack/react-virtual`** (MIT; approved
  per CLAUDE.md §5, license scan clean). Only rows in view mount.
- Rows are fixed-height for cheap, deterministic range math. The virtualizer's rect
  observer is wrapped to substitute a large fallback viewport when the scroll
  element measures `0` (jsdom / first pre-layout paint) — the virtualizer never
  renders more than `count` rows, so this only matters for one frame in the browser
  but makes every row mount under test.
- `AssetThumb` is `memo`-ised, and `useAssetThumbnail` runs video-frame captures
  through a small concurrency gate (max 4) so a fast scroll can't spawn dozens of
  decodes at once.

## Consequences

- External (MCP-agent) edits to the open project appear in the GUI within ~120 ms,
  with no re-open. The app and the agent both write the same file; this is a
  last-writer-wins, live-reload model — acceptable for the sequential
  "agent edits, then I look" workflow, not a CRDT merge.
- A new push channel widens the IPC surface by one (approved). No schema change —
  `ProjectChangedEvent.project` is validated at the boundary like every other
  transport payload.
- The bin stays responsive with large libraries. `@tanstack/react-virtual` is a new
  runtime dependency in `apps/web-editor`.
- `ProjectFileWatcher` is at 100% line/statement/function coverage (one defensive
  null-guard branch intentionally untested — no vanity coverage).
