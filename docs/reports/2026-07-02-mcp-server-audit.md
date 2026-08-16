# MCP server audit — packages/mcp-server (2026-07-02)

Two goals: (1) fix the reported behavior where an external agent (Claude Code) edits
`project.fp.json` via the filesystem instead of the MCP tools; (2) harden for safe use at
scale. Transport: Streamable HTTP, loopback `127.0.0.1:19789/mcp` (ADR 0019/0027).

## Root cause of the filesystem bypass (confirmed)
The server sends the client **no `instructions`** and no in-tool guidance to use the tools /
avoid the filesystem, **and** hands the agent everything to bypass them (absolute path + full
project JSON). An external agent with its own Read/Edit/Bash defaults to editing the file.

## Findings

### 1. Tool surface does not steer the agent
- `buildMcpTools()` `tools.ts:74-85`; session tools `tools.ts:35-63` (`open_project`,
  `save_project`, `undo`, `redo`, `get_patch_history`); registry reads
  `tool-registry.ts:192-213`; mutations `:228+`; actions `:566-567`.
- Every description is a terse one-liner (e.g. `tool-registry.ts:230`, `:194`); none says
  these tools are the only sanctioned mutation path or that direct file/media access is forbidden.

### 2. Server invites/enables filesystem bypass
- **Leaks absolute path:** `stateView` returns absolute resolved `project.fp.json` path —
  `dispatch.ts:53-63`, from `SessionState.path` (`session.ts:80-86, 110-118`), absolute via
  `resolveWithin` (`shared-types/safety.ts:62-75`). First `open_project` tells the agent the file to edit.
- **Leaks full doc + media paths:** `get_project_state` returns `ctx.project`
  (`tool-registry.ts:194-197`); `AssetSchema.path` is a raw string
  (`timeline-schema/src/index.ts:155-157`). No `file://`/resources exposed, but this is
  functionally raw-file access.

### 3. No MCP `instructions` (primary root cause, highest-leverage fix)
- `new Server({name,version},{capabilities:{tools:{}}})` — `server.ts:29-32`. SDK supports a
  top-level `instructions` field returned in `initialize` (`sdk .../server/index.js:50,279`)
  but FramePilot passes none. `docs/guides/mcp-server.md:12` documents the no-direct-mutation
  rule to humans only — it never reaches the client model.

### 4. Safety at scale
- **Path sandbox — solid** (`resolveWithin` symlink-aware, `safety.ts:35-47,62-75`) for
  `open_project` (`session.ts:126`), `save_project` (`:212`), `add_asset` (`:297-312`).
- **Active-pointer sandbox bypass:** `openActiveProject` (`session.ts:164-178`) loads the
  active-pointer path with "no sandbox gate" (`:173`); pointer only structurally validated
  (`projects-root.ts:65-75`) from `<root>/.framepilot-active.json` (`session.ts:191-200`).
  `ensureOpenProject` falls back to it for every non-`open_project` call (`dispatch.ts:141`).
  Any local process that writes the pointer can make the server open/save an arbitrary
  absolute path outside the sandbox.
- **No auth:** bind `127.0.0.1:19789` (`http.ts:29-31,175`); no token/bearer anywhere. Any
  local process/user can drive the full surface.
- **DNS-rebinding: Host-only.** `allowedHosts` set (`http.ts:103-104`) but `allowedOrigins`
  never set → SDK Origin check never runs (`webStandardStreamableHttp.js:113-125`).
- **Unbounded body:** `readJsonBody` (`http.ts:71-77`) buffers whole body, no size cap → DoS.
- **No rate limit / no session cap:** `transports` map (`http.ts:98`) grows per initialize.
- **Malformed JSON → 500** (should be 400) (`http.ts:166-171`).
- **Corruption:** through the tools, no (assembleEdit→validatePatch→commitProjectPatch,
  `session.ts:251-268`; atomic write `project-file.ts:39-45`). Around the tools, yes — the
  reported bypass skips validation, atomicity, and reversible history.

### 5. Concurrency (GUI open + MCP editing)
- **GUI side mediated:** `ProjectFileWatcher` debounce + self-write dedup
  (`apps/desktop/electron/projects/project-watcher.ts:88-131`).
- **MCP side NOT mediated — lost-update race:** `EditorSession` caches the project
  (`session.ts:88-92,140`) and never re-reads before `saveProject` (`:208-218`) → blind
  last-writer-wins overwrite of GUI autosaves / direct edits.
- **Single shared session across all HTTP clients:** one `EditorSession`/`renderClient`
  (`http.ts:90-91,97-98,116`) → one client's `open_project` repoints another's project; no
  cross-call/cross-client locking.

## Recommendations
### (a) Steer agents onto the tools — highest priority
1. Add MCP `instructions` in `server.ts:29-32`: all edits MUST go through these
   validated/reversible tools; do NOT read/write `project.fp.json` or media directly (direct
   edits bypass validation+undo, get overwritten, can corrupt). Use `get_project_state`/
   `get_timeline` to read, mutation tools to edit.
2. Tighten tool descriptions (`tool-registry.ts`, `tools.ts`) to reinforce.
3. Stop leaking the on-disk path in `stateView` (`dispatch.ts:53-63`) — return id/display name.
4. Consider returning opaque asset ids instead of raw media paths in `get_project_state`.

### (b) Harden for scale
5. Bearer/token auth (app-written shared secret, required per request).
6. Set `allowedOrigins` (`http.ts:100-108`) to the loopback allowlist.
7. Cap request-body size (413) in `readJsonBody`; cap concurrent sessions; add rate limiting.
8. Close lost-update race: re-read + compare baseline (mtime / canonical serialization from
   `session.ts:135-142`) before `saveProject`; typed conflict error; optionally watch the open file.
9. Tighten active-pointer trust (`session.ts:164-200`): resolve pointer target within a known
   root (or verify ownership) unless OS-attested app-authored.
10. Return 400 (not 500) for malformed JSON (`http.ts:166-171`).
