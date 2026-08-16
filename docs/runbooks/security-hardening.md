# Runbook: Security Hardening

FramePilot is a local-first desktop app that runs an AI agent over the user's files and
shells out to a render engine. The threat model is mostly about **not harming the user's
machine or data**: never destroy originals, never escape the project sandbox, never let
the agent run arbitrary code. This runbook is the checklist; the policy summary is in
[`../../SECURITY.md`](../../SECURITY.md) and the source rules are PRD §18.

Companion: the `security-hardening` skill (`.agents/skills/security-hardening/`).

---

## Local file safety (PRD §18.1)

- [ ] **Never delete original assets.** Edits are timeline operations, not file deletes.
- [ ] **Never overwrite user files without confirmation.** Renders go to the project
      `renders/` folder.
- [ ] **Safe path resolution** for every filesystem op; resolve and canonicalize before
      use.
- [ ] **Prevent path traversal** — reject any path that resolves outside
      `FRAMEPILOT_PROJECTS_ROOT`. Test with `../`, symlinks, absolute paths, and
      Unicode/encoding tricks.
- [ ] **Atomic saves** for `project.fp.json` (temp file → fsync → rename); see
      [../architecture/desktop-shell.md](../architecture/desktop-shell.md).

## Agent sandbox (PRD §18.2)

- [ ] The agent **cannot run arbitrary shell commands** in the app runtime.
- [ ] The agent acts **only through registered tools**
      ([../api/ai-tools.md](../api/ai-tools.md)).
- [ ] **All tool inputs are schema-validated** (reject, don't coerce).
- [ ] File operations are **sandboxed to the project directory**.
- [ ] Render jobs have a **timeout** (`FRAMEPILOT_RENDER_TIMEOUT_SECONDS`) and are
      **cancellable**.

## Secrets

- [ ] Secrets live in `.env`, which is **never committed** (`.gitignore`).
- [ ] API keys (`ANTHROPIC_API_KEY`, `NVIDIA_API_KEY`, `OPENAI_API_KEY`) are read from env
      only; never logged, never written to project files, never sent to other providers.
- [ ] Default config (`provider=mock`, no keys) must run fully offline.

## Electron hardening

- [ ] `contextIsolation: true`, `nodeIntegration: false`.
- [ ] Renderer gets only a **minimal, typed preload bridge** — no raw Node, no `require`.
- [ ] Privileged ops (filesystem, spawning the sidecar) happen only in the main process.
- [ ] The Python sidecar binds to **loopback** (`127.0.0.1`) only.
- [x] **Sidecar routes sandbox caller-supplied paths.** Every FastAPI route that
      takes a filesystem path (`/render`, `/render/preview`, `/inspect-media`,
      `/validate-render`) resolves it through `resolve_within(projects_root, …)`
      before any disk access (finding 1.2). See incident note below.
- [ ] Restrict navigation / disable opening untrusted external content in the renderer.

## Dependency / license review (PRD §17)

- [ ] **No new dependency without a license review** (blocking CI rule).
- [ ] License scan runs in CI ([ci-cd.md](ci-cd.md)).
- [ ] Keep dependencies current; watch for advisories.

## Reliability (PRD §18.3)

- [ ] Background jobs are **resumable/retryable**.
- [ ] Failed renders emit **useful logs** (`logs/`).
- [ ] **Undo/redo** and **crash recovery** from last valid project state work.

---

## Incident notes

When a security issue is found or reported (see disclosure process in
[`../../SECURITY.md`](../../SECURITY.md)), record here: date, summary, affected component,
root cause, fix + PR link, and the regression test added. Treat a sandbox escape or
original-asset loss as **critical**.

### 2026-06-26 — Sidecar accepted arbitrary filesystem paths (CRITICAL, finding 1.2)

- **Summary:** The Python FastAPI sidecar routes accepted arbitrary caller-supplied
  paths with no sandbox containment, even though `Settings.projects_root` existed for
  exactly this purpose. A local process could POST `{"input_path": "/etc/passwd"}` to
  `/inspect-media` to probe arbitrary files, or point `/render`'s `project_path`
  anywhere on disk.
- **Affected component:** `engine/python/framepilot_engine/service.py`
  (`/render`, `/render/preview`, `/inspect-media`, `/validate-render`).
- **Root cause:** Routes did `Path(req.input_path)` etc. directly and never called
  the existing `resolve_within` sandbox primitive; `projects_root` was defined but
  never enforced.
- **Fix:** Added a `sandbox()` guard in `create_app` that routes every caller-supplied
  path through `resolve_within(settings.projects_root, …)` before any disk access,
  returning HTTP 400 on `PathTraversalError`. When `projects_root` is unset (optional
  `FRAMEPILOT_PROJECTS_ROOT`, defaults to `None`) the previous un-contained behaviour
  is preserved for backward-compat but a warning is logged; the packaged desktop shell
  always configures the root, so containment is strict in production.
- **Regression test:** `engine/python/tests/test_service.py` — traversal (`../../etc/passwd`)
  and out-of-root absolute (`/etc/passwd`) paths now return 400 on every guarded route;
  in-sandbox paths still succeed. `service.py` at 100% coverage.

### 2026-06-26 — Phase 8 security audit (full record)

A pass over every place a renderer/agent/network-supplied path or input reaches the
filesystem or the renderer. Findings below; each is marked **RESOLVED** with its fix
location or listed in the **hardening backlog** (not yet done). The remaining
high-severity TS/renderer items are recorded in
[ADR 0025](../adr/0025-path-sandbox-unification-and-renderer-csp.md); the sidecar item
is the incident note above.

**Resolved**

- **1.1 — Electron IPC accepted arbitrary paths (CRITICAL). RESOLVED.** The main-process
  handlers `projectOpen`/`projectSave`/`projectReveal`/`renderExport`
  (`apps/desktop/electron/main.ts`) passed a renderer-supplied absolute path straight to
  the filesystem. They now route every path through the projects sandbox via
  `sandboxProjectPath` (`apps/desktop/electron/ipc/sandbox.ts`, unit-tested) before any
  disk access, surfacing `{ ok: false }` on escape. See ADR 0025.
- **1.2 — Sidecar accepted arbitrary paths (CRITICAL). RESOLVED.** Every FastAPI route
  that takes a path now resolves it through `resolve_within(projects_root, …)` before
  disk access (HTTP 400 on escape). See the incident note above and
  `engine/python/framepilot_engine/service.py`.
- **1.3 — Sandbox symlinked-tail bypass. RESOLVED.** The TS `resolveWithin` realpaths the
  deepest existing portion of the resolved target **including a final symlinked
  component**, so a symlinked file (not just a symlinked parent dir) whose target leaves
  the sandbox is rejected. Covered by the safety tests in
  `packages/shared-types/src/safety.test.ts`.
- **1.4 — Two divergent TS sandboxes. RESOLVED.** A correct `resolveWithin`/
  `PathTraversalError` existed only in the MCP server; the Electron handlers had none.
  The primitive is now the single source in `@framepilot/shared-types/safety` (node-only
  subpath), mirroring the engine's `resolve_within`; `packages/mcp-server/src/safety.ts`
  re-exports it. See ADR 0025.
- **3.2 — No renderer CSP, raw `file://` media (HIGH). RESOLVED.** A strict
  Content-Security-Policy is now served on every renderer response
  (`onHeadersReceived` + `buildCsp`), and clip media is served through a privileged
  `fp-media://` scheme whose handler resolves each request through the sandbox before
  streaming (`apps/desktop/electron/security/media-protocol.ts`), replacing `file://`.
  See ADR 0025.

**Hardening backlog (NOT yet done)**

- [ ] **Windows / UNC path traversal tests** for the sandbox (current tests are POSIX-
      shaped).
- [ ] **Zod-validate `AiRequest` / `ExportRequest` at the IPC boundary**, including the
      free-form `userPrompt`, before the main process acts on them.
- [ ] **Redact upstream provider error bodies** before they are logged or surfaced
      (they may echo prompt content or keys).
- [ ] **Agent token / wall-clock budget** — bound an agent run by tokens and time, not
      only by step count.
- [ ] **SPDX-aware license logic + a `pnpm audit` CI gate** wired into the existing
      license scan.
- [ ] **Explicit `renders/` / `exports/` gitignore** so rendered output is never
      accidentally committed.
- [ ] **TS ↔ Python sandbox algorithm reconciliation + shared golden vectors** so both
      implementations are proven to agree on the same cases.
- [x] **Main-process native open/save dialog** for choosing a location **outside** the
      projects folder (the trusted way to broaden the sandbox; see ADR 0025). Done:
      export's Save As (`framepilot:export:save-as`) shows a main-process
      `dialog.showSaveDialog` and copies the sandboxed render there — the renderer
      never supplies the destination path directly, and the source path is still
      re-checked against the projects sandbox before the copy
      (`apps/desktop/electron/render/export-save.ts`).
