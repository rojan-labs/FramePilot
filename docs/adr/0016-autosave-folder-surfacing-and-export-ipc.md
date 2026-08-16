# 0016 — Autosave, projects-folder surfacing, and the renderer→engine export IPC channel

- **Status:** Accepted
- **Date:** 2026-06-25
- **Phase:** 8 (Production Hardening) — closes three discovered follow-ups
- **Supersedes / relates to:** [0009](0009-desktop-main-process-architecture.md)
  (desktop main-process architecture / IPC), [0010](0010-renderer-editor-pure-core-thin-shell.md)
  (renderer pure-core + thin shell), [0011](0011-caption-burn-in-render-wiring.md)
  (caption burn-in already honoured by the sidecar).

## Context

Three user-facing gaps remained in the editor shell, all tracked under Phase 8:

1. **Save persisted the wrong timeline.** The `useEditor` store owns the working
   timeline, but `App` saved the app-level `Project` whose `timeline` was only the
   initial seed — the store's edits were never lifted back up. Save (and the AI
   context, which also reads `Project`) therefore saw the _un-edited_ timeline.
2. **There was no autosave and no way to save without typing a path.** A fresh
   project had no location, the Save menu item was disabled until a path was typed
   by hand, and nothing wrote automatically. The projects folder was never
   surfaced.
3. **Export did not exist.** The renderer had no export affordance and there was no
   render/export IPC channel. The Python sidecar could already render and validate
   (`POST /render`, PRD §9.4), but nothing in the UI reached it.

The editor ships in **two runtimes** — the Electron desktop shell (with
`window.framepilot` + the Python sidecar) and a plain browser (Vite dev server,
tests, the eventual web build) — so any solution must work in both and degrade,
never throw, where a capability is absent.

## Decision

### 1. Lift the store timeline into the Project (single source of truth)

`Editor` mirrors `editor.state.timeline` up to `App` via `onProjectChange` in a
`useEffect` keyed **only** on the timeline reference. The store remains the single
source of truth; the effect just keeps the saved/AI-visible `Project` in sync. The
store returns a stable timeline reference between edits, so the effect fires once
per committed edit/undo/redo and the sibling panels (MediaBin/AiPanel) — which
spread `project` and preserve that reference — never trigger a spurious lift or a
loop.

### 2. One persistence path with debounced autosave

A new `editor/persistence.ts` unifies saving across runtimes:

- **Desktop:** writes a real `project.fp.json`. A path-less project autosaves under
  the **default projects folder** via a new `saveProjectDefault` IPC handler, which
  derives a safe, bare file name from the project id (no path separators, no `..`)
  and sandboxes it under `FRAMEPILOT_PROJECTS_ROOT` (or `~/Documents/FramePilot
Projects`). So the user never has to choose a location first.
- **Browser:** persists to `localStorage` keyed by project id, returning a
  `local://<id>` pseudo-path, and restores the last project on reload.

`App` runs a **debounced autosave** (2 s after the last change). Opening/restoring
suppresses one tick so a freshly loaded file is not immediately re-written. A
save-state chip (Saved / Unsaved / Saving…) replaces the old "Draft" chip.

### 3. Surface the folder

`App` exposes a `revealProject` path: the status-bar location is a button, and the
File menu gains "Reveal in folder" / "Open projects folder". A new `projectReveal`
IPC handler uses Electron `shell.showItemInFolder` (file) / `shell.openPath`
(folder). A `projectsDir` handler returns the folder for display.

### 4. Renderer→engine export IPC channel

A new `renderExport` IPC handler delegates to the sidecar from the **main process**
(the render engine never runs in the renderer — AGENTS.md render-vs-preview rule).
The pure `render/export-client.ts` POSTs to `/render` (or `/render/preview`),
passing the chosen preset and the caption **burn-in** flag the engine already
honours. Because `/render` returns HTTP 200 with a `RenderJob` even on failure,
success is decided by `job.state`, not the HTTP code — a failed/invalid render is
reported, never returned as a usable output. Export requires the project saved on
disk (the sidecar loads `project_path`), so the Export dialog saves first.

## IPC surface change (security boundary)

This **broadens the IPC surface** — `CLAUDE.md §5` requires explicit approval,
which was obtained. Four channels were added to the closed contract
(`ipc/contract.ts`), the preload bridge, and the renderer bridge:

| Channel                           | Purpose                       | Safety                                                    |
| --------------------------------- | ----------------------------- | --------------------------------------------------------- |
| `framepilot:project:save-default` | Autosave a path-less project  | File name sanitised + sandboxed under the projects folder |
| `framepilot:project:dir`          | Report the projects folder    | Read-only path                                            |
| `framepilot:project:reveal`       | Reveal file/folder in the OS  | Opens the OS file manager only                            |
| `framepilot:render:export`        | Render/export via the sidecar | Validates input is a saved path; render stays in Python   |

No timeline/project **schema** change was needed (caption style/template
persistence stays deferred to a future migration, as before).

## Consequences

- **Save is now correct** (the edited timeline is what gets written) and effortless
  (autosave, no manual path), in both runtimes.
- **Export works end-to-end** from the UI, reusing the deterministic, auto-validated
  sidecar render path and the existing caption burn-in.
- Pure logic (`projects-dir.ts`, `export-client.ts`, `persistence.ts`) is unit-
  tested to ~100%; `main.ts`/`preload.cts` stay thin glue. web-editor: 304 tests;
  desktop: 44 tests.
- The renderer↔desktop bridge type still **duplicates** the contract (no compile-time
  cross-check); collapsing that remains a Phase 8 item, now with a wider surface.
- A media **preview render** inside the AI Review UX can now reuse `renderExport`
  with `preview: true` (not yet wired into that panel).
