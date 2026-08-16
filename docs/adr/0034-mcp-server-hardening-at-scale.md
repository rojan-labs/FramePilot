# ADR 0034 — MCP server: steer agents to tools & harden the transport for scale

- **Status:** Accepted
- **Date:** 2026-07-03
- **Phase:** 12 — Performance hardening & MCP safety-at-scale
- **Relates to:** ADR 0015 (MCP server), ADR 0019 (Streamable HTTP transport),
  ADR 0027 (active-project pointer — this ADR closes two limitations it recorded),
  the shared path sandbox (`@framepilot/shared-types/safety`), and the audit
  `docs/reports/2026-07-02-mcp-server-audit.md`

## Context

Two problems surfaced when running an external AI agent (e.g. Claude Code) against
the FramePilot MCP server:

1. **The agent edited `project.fp.json` on disk instead of using the tools.** The
   server sent the client no MCP `instructions` and simultaneously handed it everything
   needed to bypass the tools: `open_project` returned the absolute project path and
   `get_project_state` returned the whole document (every media path). An agent that
   arrives with its own Read/Edit/Bash tools takes the path of least resistance and
   writes the file directly — skipping validation, atomic writes, and the reversible
   patch history.

2. **The loopback HTTP transport was under-hardened for a multi-process/multi-user
   machine.** No `instructions`; no `allowedOrigins` (only Host was checked, so the
   SDK's DNS-rebinding Origin check never ran); an unbounded request-body read;
   no session cap; no auth of any kind; malformed JSON returned 500; the
   `save_project` path blindly overwrote on-disk changes (the last-writer-wins
   limitation ADR 0027 flagged); and `openActiveProject` loaded the active-pointer
   target **without** the sandbox check (contradicting ADR 0027's stated behavior).

## Decision

**Steer the client to the tools, stop leaking the filesystem, and harden the
transport — with no schema change, no new dependency, and the editing path
(`assembleEdit → validatePatch → commitProjectPatch` + atomic save) untouched.**

- **Instructions (M1).** The `Server` is constructed with a top-level `instructions`
  string telling the client this is an active editing session: make **all** edits
  through the validated/reversible tools, read state with `get_project_state`/
  `get_timeline`, and never read/write `project.fp.json` or media directly. Tool
  descriptions (`get_project_state` + the session tools, mirrored in the Python
  registry) reinforce it.
- **No path leak (M1).** Session-tool results (`stateView`) return
  `{ projectId, projectName, canUndo, canRedo, historyLength }` — never the absolute
  on-disk path. Session tools target the open project implicitly, so the agent never
  needs it.
- **Origin + Host (M2a).** `resolveHttpConfig` computes `allowedOrigins`
  (`http://<host>:<port>` + `http://localhost:<port>`, mirroring `allowedHosts`) and
  passes it to the transport, so the SDK validates both Host and Origin (403 on a
  cross-origin request); native clients that send no `Origin` are unaffected.
- **Request hygiene (M2b).** `readJsonBody` rejects an oversized `Content-Length`
  before buffering (and counts streamed bytes as a backstop) with **413**; malformed
  JSON returns **400** (not 500). Cap is `FRAMEPILOT_MCP_MAX_BODY_BYTES` (default 4 MB).
- **Session cap + optional auth (M2c).** Concurrent MCP sessions are bounded
  (`FRAMEPILOT_MCP_MAX_SESSIONS`, default 64; **503** past it). Optional bearer auth is
  **off by default**: if `FRAMEPILOT_MCP_TOKEN` is set, every request must present a
  matching `Authorization: Bearer <token>` (constant-time compare) or **401**; unset →
  behaves exactly as before (loopback-only).
- **Save-conflict guard (M2d).** An open project captures a byte baseline; before
  `save_project` overwrites the loaded path it re-reads and compares, throwing a typed
  `conflict` error rather than clobbering an external edit (GUI autosave / direct write).
  The baseline advances after each save; a deleted-on-disk file is recreated (no false
  conflict). Atomic write preserved.
- **Active-pointer sandbox (M2d).** `openActiveProject` now resolves the pointer target
  through `resolveWithin(projectsRoot, …)` — the same sandbox as any agent-supplied
  path — so a locally-writable pointer file can no longer coerce the server into opening
  or saving an arbitrary absolute path (escapes raise `unsafe_path`). This makes the code
  match the behavior ADR 0027 already described.

## Consequences

- **The reported bypass is fixed** at its root: a client that honors MCP instructions
  edits through the tools; withholding the path removes the strongest hint to do
  otherwise. (A client that ignores instructions and has its own filesystem tools can
  still reach the file — the OS, not the MCP server, is the boundary there — but the
  default nudge is now correct and the server no longer volunteers the path.)
- **Safe on a shared/multi-process machine:** loopback + Host + Origin + optional token
  bound who can drive the surface; body/session caps bound resource use; the conflict
  guard makes concurrent GUI+agent editing safe (supersedes ADR 0027's last-writer-wins
  limitation); the pointer can no longer widen the reachable filesystem.
- **New, backward-compatible env surface:** `FRAMEPILOT_MCP_TOKEN` (opt-in auth),
  `FRAMEPILOT_MCP_MAX_BODY_BYTES`, `FRAMEPILOT_MCP_MAX_SESSIONS`. Defaults preserve
  today's loopback behavior, so existing setups are unaffected.
- **New transport statuses** clients may see: 400 (bad JSON), 401 (auth), 403 (origin),
  413 (body), 503 (session cap), and a `conflict` tool error. Documented in
  `docs/guides/mcp-server.md` and `docs/api/mcp-server.md`.
- **100% coverage** maintained on the safety core; mcp-server 80 tests green. No schema
  change, no new dependency, no change to the validated-patch editing path or
  `resolveWithin`.
- **Follow-up (not solved here):** the desktop app does not yet write/observe the bearer
  token, so enabling `FRAMEPILOT_MCP_TOKEN` requires configuring the client manually; a
  future slice can have the app mint the secret and pass it to a bundled client.
