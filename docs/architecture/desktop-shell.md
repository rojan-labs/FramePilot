# Desktop Shell

The desktop shell is the **Electron** application that hosts the React editor, supervises
the Python render engine, and owns the project lifecycle (open/save/recover). It is
deliberately thin: it provides windows, secure IPC, process management, and file safety —
all editing logic lives in the frontend packages, and all rendering lives in the Python
engine.

Code lives in `apps/desktop` (main process under `apps/desktop/electron/`) and the editor
renderer in `apps/web-editor`. See [ADR 0002](../adr/0002-electron-desktop-shell.md) for
why Electron, [ADR 0009](../adr/0009-desktop-main-process-architecture.md) for how the
main process and renderer are structured, and [overview.md](overview.md) for how the shell
fits the whole system.

> **Phase 3 status — complete.** The main process is split into small,
> dependency-injected, unit-tested modules with `main.ts` as thin glue (Phase 3.1), and the
> renderer is a full manual editor built as a pure core + thin React shell (Phase 3.2/3.3).
> See [ADR 0009](../adr/0009-desktop-main-process-architecture.md) for the main process and
> [editor-ui.md](editor-ui.md) / [ADR 0010](../adr/0010-renderer-editor-pure-core-thin-shell.md)
> for the renderer.

---

## 1. Electron processes

```
┌─────────────────────────────────────────────────────────────┐
│ MAIN process (Node)                                          │
│  • app/window lifecycle    • project open/save/recent        │
│  • spawns & supervises the Python sidecar                    │
│  • owns all filesystem access (sandboxed to projects root)   │
└───────────────┬──────────────────────────┬──────────────────┘
                │ contextBridge IPC          │ child_process / HTTP
                ▼                            ▼
┌──────────────────────────────┐   ┌─────────────────────────────┐
│ PRELOAD (isolated bridge)    │   │ PYTHON SIDECAR (FastAPI)    │
│  • exposes a tiny, typed API │   │  render / preview / inspect │
│  • no raw Node in renderer   │   │  (see render-engine.md)     │
└──────────────┬───────────────┘   └─────────────────────────────┘
               ▼
┌──────────────────────────────┐
│ RENDERER (Chromium)          │
│  React editor, patch engine, │
│  HTML/canvas preview         │
└──────────────────────────────┘
```

---

## 2. Secure IPC (PRD §18.2)

The renderer is treated as untrusted. Hardening:

- **`contextIsolation: true`**, **`nodeIntegration: false`**, and **`sandbox: true`** —
  the renderer never gets raw Node/`require`.
- The **preload** script (`apps/desktop/electron/preload.ts`) uses `contextBridge` to
  expose a **small, explicit, typed** API surface (open project, save project, request
  render, etc.) — nothing more.
- All privileged operations (filesystem, spawning the sidecar) happen in the **main**
  process; the renderer can only _ask_ via the bridged API.
- File operations are **sandboxed to the projects root** (`FRAMEPILOT_PROJECTS_ROOT`)
  with safe path resolution to prevent traversal (see
  [../runbooks/security-hardening.md](../runbooks/security-hardening.md)).
- The agent can never run arbitrary shell commands — it acts only through registered tools
  ([ai-engine.md](ai-engine.md)).

### The IPC contract is a standalone, Electron-free module

`apps/desktop/electron/ipc/contract.ts` defines the **closed, typed set of IPC channels**
and the `window.framepilot` bridge type. It is the security boundary expressed as a single
artifact, and it **imports no Electron API** — so the channel set and bridge shape are a
pure, reviewable, testable contract that both `preload.ts` and the renderer type against.
Adding a channel means editing this file (and surfacing it for review per CLAUDE.md §5),
which keeps the IPC surface deliberately small and auditable.

Project save in the main process validates with `parseProject` **before writing** (AGENTS
invariant 3): the renderer can never persist an invalid `project.fp.json` through the
bridge.

---

## 3. Python sidecar lifecycle

The main process owns the Python engine ([render-engine.md](render-engine.md)) through
`SidecarManager` in `apps/desktop/electron/sidecar/manager.ts` — a
spawn / health-poll / shutdown **state machine**:

1. **Spawn** the sidecar (`framepilot serve`) on app start, bound to
   `FRAMEPILOT_PYTHON_API_HOST:PORT` (default `127.0.0.1:8765`, loopback only).
2. **Health-check** via `GET /health` (polled) before routing any render request.
3. **Supervise** — restart on unexpected exit; surface failures to the UI.
4. **Shutdown** gracefully on app quit (and cancel in-flight render jobs, which are
   cancellable by design).

`SidecarManager`'s `spawn`, health-`probe`, and `sleep` functions are **injected**, so the
entire lifecycle is unit-tested deterministically with no real Python process and no
Electron runtime. Isolating the engine as a sidecar is what lets the shell be swapped later
without touching rendering (ADR 0002).

---

## 4. Atomic save (PRD §18.3)

`project.fp.json` is the canonical document, so saving must never leave it half-written:

- write to a temp file in the project folder,
- `fsync`, then **atomically rename** over the existing file,
- keep the patch history in the document so save is also a recovery point.

Originals in `assets/` are never modified or overwritten without explicit confirmation
(PRD §18.1).

---

## 5. Recents and crash recovery (PRD §18.3)

Two small, **injected-IO**, unit-tested modules own the project lifecycle:

- `apps/desktop/electron/projects/recent-files.ts` — the recent-projects list.
- `apps/desktop/electron/projects/recovery.ts` — crash recovery. It **snapshots the last
  validated + saved project**, **clears that snapshot on a clean quit**, and therefore
  **survives a crash**: on the next launch a leftover snapshot signals an unclean exit and
  is offered for reopen.

Because every edit is a validated patch recorded in `project.history`
([timeline-and-patch-engine.md](timeline-and-patch-engine.md)), recovery reloads the
**last valid project state** and trusts the persisted history. Background jobs (render,
proxy, transcript) are **resumable/retryable**, so an interrupted render can be resumed or
safely re-queued rather than corrupting output.

---

## 6. Auto-update (scaffolded)

`apps/desktop/electron/updater/channel.ts` provides **channel resolution and a provider
seam** — the structure an auto-updater plugs into — without yet pulling in an updater
dependency (deferred per CLAUDE.md §5 until it is actually used). An auto-update channel
and **signed builds** (macOS/Windows/Linux) complete in Phase 8 hardening. See
[../runbooks/release.md](../runbooks/release.md).

---

## 7. Renderer editor UI (Phase 3.2/3.3)

The renderer is the full manual editor, built so **manual edits flow through the same
validated, reversible pipeline as AI edits** (the core reliability loop in
[overview.md](overview.md)). It is structured as a **pure, framework-agnostic core**
(`apps/web-editor/src/editor/`, 100% unit-tested) plus a **thin React shell**
(`src/components/`): `store.applyUserPatch` runs **validate → apply → record** via
`@framepilot/editor-core`, `useEditor` is a thin `useReducer` adapter, and components hold
no edit logic. The full design — the validate→apply→record invariant, render-vs-preview, and
the bridge boundary — is documented in [editor-ui.md](editor-ui.md)
([ADR 0010](../adr/0010-renderer-editor-pure-core-thin-shell.md)).
