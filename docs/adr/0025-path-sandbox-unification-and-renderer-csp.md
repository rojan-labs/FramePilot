# ADR 0025 — Path-sandbox unification, Electron IPC sandboxing, and renderer CSP

- **Status:** Accepted
- **Date:** 2026-06-26
- **Phase:** 8 — Production Hardening & Release
- **Relates to:** ADR 0023 (single-source IPC contract), the Phase 3.1 secure IPC
  contract (`apps/desktop/electron/ipc/contract.ts`), the MCP path sandbox (ADR 0015),
  the engine sandbox `resolve_within` (Phase 2), and the
  [security-hardening runbook](../runbooks/security-hardening.md)

## Context

The Phase 8 security audit examined every place a renderer/agent/network-supplied path
or input reaches the filesystem or the renderer. It found several escapes from the
local-first threat model (PRD §18.1: never escape the project sandbox, never read or
overwrite arbitrary files). The most serious were on the desktop shell:

- **Finding 1.1 (CRITICAL) — Electron IPC accepted arbitrary paths.** The main-process
  handlers `projectOpen` / `projectSave` / `projectReveal` / `renderExport` in
  `apps/desktop/electron/main.ts` passed a **renderer-supplied absolute path** straight
  to the filesystem. The renderer is a web context (it loads media and AI-influenced
  data), so a compromised renderer could read or overwrite any file on disk.
- **Finding 1.4 — two divergent TS sandboxes.** A correct `resolveWithin` /
  `PathTraversalError` containment primitive existed **only** in the MCP server; the
  Electron handlers had none. Two hand-maintained TS copies could drift, and one
  surface had no check at all.
- **Finding 3.2 (HIGH) — no renderer CSP, raw `file://` media.** The renderer had no
  Content-Security-Policy and loaded clip media via raw `file://` URLs. A stored-XSS
  vector combined with the unsandboxed IPC would give an attacker arbitrary file read.
- **Finding 1.2 (CRITICAL) — sidecar accepted arbitrary paths.** The Python FastAPI
  routes used caller-supplied paths verbatim. (Fixed separately; recorded in the
  security-hardening runbook incident note.)

This ADR records the **TS-side and renderer** hardening (1.1, 1.4, 3.2); 1.2 is
cross-referenced for completeness.

## Decision

### One TS sandbox (finding 1.4)

Promote `resolveWithin` / `PathTraversalError` into
`@framepilot/shared-types/safety` — a **node-only subpath export** (imported via
`@framepilot/shared-types/safety` so browser bundles never pull in `node:fs`/
`node:path`) — as the single source of truth. It is a faithful mirror of the engine's
`framepilot_engine.safety.resolve_within`, so the MCP host, the Electron main process,
and the Python engine all enforce the **same** containment rule (resolve, then reject
any path whose realpathed existing prefix — including a final symlinked component —
leaves the sandbox root). `packages/mcp-server/src/safety.ts` now **re-exports** from
shared-types, so its importers (`session.ts`, `index.ts`) are unchanged.

### Sandbox the Electron IPC (finding 1.1)

Add a tested helper `apps/desktop/electron/ipc/sandbox.ts` exposing
`sandboxProjectPath(projectsDir, candidate)`, which routes every renderer-supplied
path through `resolveWithin` and returns a typed `{ ok: false }` (surfaced to the
renderer) on a traversal/escape instead of throwing. The four handlers
(`projectOpen` / `projectSave` / `projectReveal` / `renderExport`) now resolve their
path through this helper, against the default projects folder, **before** any disk
access.

### CSP + a privileged `fp-media://` scheme (finding 3.2)

Harden the renderer session in `main.ts`:

- Serve a strict **Content-Security-Policy** header on every renderer response via
  `session.defaultSession.webRequest.onHeadersReceived` (`buildCsp` in
  `apps/desktop/electron/security/media-protocol.ts`): scripts/styles locked to
  `self`, media only from the `fp-media:` scheme + `blob:`/`data:` preview object
  URLs, connections only to the local engine sidecar (plus the Vite dev origin + HMR
  websocket in dev), `object-src`/`frame-src` `none`.
- Replace raw `file://` clip media with a privileged **`fp-media://`** scheme
  (registered via `registerSchemesAsPrivileged` before `app` is ready so `<video>`
  streaming/range works). Its `protocol.handle` resolves **every** request through
  `resolveWithin(projectsRoot, …)` before streaming bytes, returning `403 Forbidden`
  on anything outside the projects folder. The pure helpers (`buildCsp`,
  `mediaUrlForPath`, `pathFromMediaUrl`) are unit-tested; only the Electron glue lives
  in `main.ts`.

## Consequences

- **The renderer can no longer reach arbitrary files.** Path IPC is contained to the
  projects folder, media is fetched only through a sandbox-checked scheme (no
  `file://`), and a CSP limits script/connect/media origins — closing audit findings
  1.1 and 3.2.
- **One containment rule across three runtimes.** Desktop, MCP, and the Python engine
  share `resolveWithin`/`resolve_within`; a future drift on the TS side is now a single
  change, not two copies (finding 1.4). The sidecar route fix (finding 1.2) lands the
  same rule on the Python service (runbook incident note).
- **No new dependency, no schema change, no IPC-contract shape change.** The
  request/response shapes from ADR 0023 are untouched; this adds main-process
  guards and a new local media scheme.
- **Out-of-scope follow-up (tracked in the runbook):** opening or saving a project at
  a user-chosen location **outside** the projects folder should go through a
  main-process **native open/save dialog** (a trusted channel), not by letting the
  renderer hand the main process an arbitrary path. Today such a path is rejected by
  the sandbox; the dialog is the intended way to broaden it.
