# ADR 0009: Desktop main-process architecture — small DI modules, thin glue

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Phase 3 desktop-shell work

## Context

The Electron desktop shell (ADR 0002) owns the privileged, hard-to-test concerns:
process supervision of the Python sidecar, filesystem-bound project lifecycle
(recents, crash recovery), the secure IPC boundary, and auto-update. The shell is
meant to stay **thin** (PRD §10, [desktop-shell.md](../architecture/desktop-shell.md)),
but "thin" had historically meant "all logic inline in `main.ts`," which is
effectively untestable: it requires a live Electron + Node runtime and a real
Python process, so the most security-sensitive code in the app went unverified.

We also wanted the **renderer's manual edits to flow through the exact same
validated, reversible pipeline as AI edits** (AGENTS invariant: every edit is a
typed timeline operation, validated before apply) rather than mutating the project
directly in React state.

## Decision

We will split main-process concerns into **small, dependency-injected,
unit-tested modules**, leaving `main.ts` as thin glue that wires them to Electron.
The renderer routes all edits through a **patch-engine-backed store**.

**Main-process modules** (all under `apps/desktop/electron/`):

- `ipc/contract.ts` — the **closed, typed set of channels** plus the
  `window.framepilot` bridge type. This is the security boundary and imports no
  Electron API, so the contract is a pure, testable artifact that both `preload.ts`
  and the renderer type against.
- `sidecar/manager.ts` — `SidecarManager`, a spawn / health-poll / shutdown state
  machine for the Python sidecar. Its spawn, health-probe, and sleep functions are
  **injected**, so the lifecycle is unit-tested with no real Python or Electron.
- `projects/recent-files.ts` and `projects/recovery.ts` — recents and crash
  recovery with **injected IO**. Recovery snapshots the last validated + saved
  project, clears it on a clean quit, and therefore survives a crash to offer
  reopen-on-relaunch.
- `updater/channel.ts` — auto-update **channel resolution + provider seam**. No
  updater dependency is pulled in yet; this is the scaffold that later plugs into a
  real updater (PRD Phase 8).

**Security posture** (unchanged from ADR 0002, now enforced in code):
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the renderer
reaches privileged operations **only through the preload bridge**; and project
save validates with `parseProject` before writing (AGENTS invariant 3).

**Renderer (Phase 3.2 start):**

- `apps/web-editor/src/editor/store.ts` is a **pure store** whose `applyUserPatch`
  performs **validate → apply → record** via `@framepilot/editor-core`. Manual
  edits therefore get the same validated, reversible pipeline as AI edits.
- `useEditor` is a thin `useReducer` adapter over that store.
- `App.tsx` renders a live multi-track timeline with working undo/redo.

## Consequences

**Positive**

- The security- and correctness-critical logic is now **unit-tested**: desktop has
  30 tests with 100% coverage on the logic modules, and the web-editor store is at
  100% coverage. The IPC contract being Electron-free makes the boundary itself
  reviewable in isolation.
- Dependency injection (spawn/probe/sleep, IO) lets the sidecar and project
  modules be tested deterministically without spawning Python or touching real
  disk.
- Manual and AI edits share one pipeline, so undo/redo, validation, and history
  recording behave identically regardless of edit origin.

**Negative / accepted costs**

- True glue — `main.ts`, `preload.ts`, `main.tsx` — is **excluded from coverage**:
  it needs an Electron/DOM runtime that unit tests do not provide. We accept this
  and keep the glue as thin as possible so little untested logic hides there;
  end-to-end coverage of glue is the job of the Playwright harness, not unit tests.
- More files and explicit wiring than an inline `main.ts`; justified by the
  testability and the clarity of the security boundary.

## Alternatives Considered

- **Keep logic inline in `main.ts`:** rejected — the existing untestable state;
  the most sensitive code in the app would stay unverified.
- **Mutate the project directly in React state for manual edits, reserve the
  patch engine for AI:** rejected — two divergent edit paths, and manual edits
  would bypass validation/reversibility, violating the core invariant.
- **Adopt a full auto-updater dependency now:** deferred — Phase 3 only needs the
  channel/provider seam; pulling the dependency early adds license/security
  surface (CLAUDE.md §5) before it is used.
