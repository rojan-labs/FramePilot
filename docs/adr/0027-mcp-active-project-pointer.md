# ADR 0027 — MCP server targets the app's projects folder & currently-open project

- **Status:** Accepted
- **Date:** 2026-06-26
- **Phase:** 8 — Production Hardening & Release
- **Relates to:** ADR 0015 (MCP server), ADR 0025 (path-sandbox unification),
  the desktop main process (`apps/desktop/electron`), and the shared path sandbox
  (`@framepilot/shared-types/safety`)

## Context

Driving FramePilot edits through the MCP server had two rough edges that made an
external AI agent operate on the _wrong_ project:

1. **Default projects folder mismatch.** The MCP server resolved its sandbox root
   **only** from `FRAMEPILOT_PROJECTS_ROOT` and **threw** when it was unset
   (`sessionFromEnv`). The desktop app, meanwhile, defaults to
   `~/Documents/FramePilot Projects` (`projects-dir.ts`). With no env var an agent
   ended up pointed at whatever root happened to be configured (often the repo) —
   never the folder the app actually saves into.

2. **No notion of the "currently open" project.** The desktop app and the MCP server
   are deliberately decoupled processes with **no** shared state about which project
   the GUI has open. An agent had to call `open_project` with a guessed path and could
   edit a different file than the one on screen. The user wanted: _"edit the project I
   have open in the app."_

The constraint that shaped the design: the two processes share **nothing at runtime**
except the filesystem. The MCP server cannot see Electron's `userData` dir (where
recents/recovery live) and the app does not launch the server. The only thing both
compute identically is the **projects root**.

## Decision

**One shared resolver, one shared pointer file — both keyed off the projects root.**

- A new node-only module `@framepilot/shared-types/projects-root` owns the canonical
  `DEFAULT_PROJECTS_FOLDER`, `resolveProjectsRoot(env, documentsDir)` (env var wins,
  else `<documents>/FramePilot Projects`), and the active-pointer filename/helpers.
  The desktop `resolveProjectsDir` now delegates to it; the MCP `sessionFromEnv` calls
  it with `os.homedir()/Documents`, so both default to the same folder.

- The desktop app publishes which project the GUI has open by writing a small pointer
  file, `<projectsRoot>/.framepilot-active.json` (`{ path, projectId, updatedAt }`),
  on every open/save (the `projectOpen`, `projectOpenDialog`, `projectSave`,
  `projectSaveDefault` IPC handlers). It lives **inside the projects root** because
  that is the one location both processes agree on; the dot-prefix keeps it out of the
  `*.fp.json` listing.

- The MCP server reads that pointer: `open_project` with **no `path`** opens the active
  project, and any tool **auto-opens** it when nothing is open yet
  (`EditorSession.openActiveProject` / `ensureOpenProject`, wired in `dispatch.callTool`).
  The recorded path is run through the **same `resolveWithin` sandbox check** as any
  other open — a project opened in the app from outside the projects folder is reported
  but rejected with `unsafe_path`, never reached.

## Consequences

- **Out of the box:** start `framepilot-mcp` with no env config and it edits the same
  `~/Documents/FramePilot Projects` the app uses; "edit my open project" needs no path.
- **Security unchanged:** the pointer carries no project data and only ever names a
  file; the existing sandbox still gates every read/write, so the pointer cannot widen
  the reachable filesystem.
- **`FRAMEPILOT_PROJECTS_ROOT` is now optional** (was required) — a behavior change for
  the server's startup contract, documented in `bin.ts` and the MCP guide.
- **Known limitations (documented, not solved here):** the app and server read/write the
  `.fp.json` independently, so concurrent edits are last-writer-wins; and if a user has
  relocated their OS Documents folder, the app (`app.getPath('documents')`) and the
  server (`os.homedir()/Documents`) could diverge — setting `FRAMEPILOT_PROJECTS_ROOT`
  in both is the escape hatch.
