# FramePilot MCP Server

The **FramePilot MCP server** exposes FramePilot's editing engine to external AI
agents over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).
With it, an agent in **Claude Desktop**, **Claude Code**, or any MCP client can open
a project, edit the timeline (trim, split, add clips/captions/overlays, color, audio,
transitions…), undo/redo, save, and trigger a render — all through the _same_ typed,
validated, reversible patch pipeline the desktop app uses.

> **Why this is safe.** The MCP server is a trusted local host process. Every edit
> still flows `tool → typed operations → assembled patch → validate → apply → atomic
save`. It never mutates `project.fp.json` directly, never touches original media,
> sandboxes all file paths to your projects root, and delegates rendering to the
> Python sidecar (no MoviePy in the MCP process). The server listens on **loopback
> only** (`127.0.0.1`) with DNS-rebinding protection. See
> [ADR 0015](../adr/0015-mcp-server-over-stdio.md) and
> [ADR 0019](../adr/0019-mcp-server-streamable-http-transport.md) (transport).

> **Steering the agent.** On `initialize` the server returns top-level MCP
> `instructions` telling the client model that this is an active editing session and
> that **all** edits must go through the FramePilot tools — never by reading or
> writing `project.fp.json` (or media) with the agent's own filesystem/Bash/Edit
> tools, because direct edits skip validation and undo, get overwritten by the app or
> `save_project`, and can corrupt the project. The session-state payload never
> includes the project's on-disk path (only its `projectId`/`projectName`), so a
> compliant agent has no path to edit directly and no reason to leave the tools.

## What it exposes

The editing tools are **derived from FramePilot's canonical tool registry**
(`@framepilot/ai-sdk`), so they always match what the in-app AI can do — adding a new
registered tool exposes it over MCP automatically. On top of those, the server adds a
few **session tools** that manage the open project.

| Tool                                                                                                                                                                                                                           | Kind     | Purpose                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `open_project`                                                                                                                                                                                                                 | session  | Open a `project.fp.json` (path relative to the projects root). **Omit `path`** to open the project currently open in the FramePilot app |
| `save_project`                                                                                                                                                                                                                 | session  | Save atomically (optional target path inside the root)                                                                                  |
| `undo` / `redo`                                                                                                                                                                                                                | session  | Step the patch history of the open project                                                                                              |
| `get_patch_history`                                                                                                                                                                                                            | session  | List applied patches (oldest first)                                                                                                     |
| `get_project_state`, `get_timeline`, `get_timeline_summary`, `get_clips`, `get_clip`, `get_transcript`, `get_selected_range`, `list_assets`                                                                                     | read     | Inspect the project (`get_timeline_summary`/`get_clips`/`get_clip` are compact, windowed reads for long-form projects)                  |
| `trim_clip`, `split_clip`, `delete_range`, `ripple_delete`, `delete_clip`, `delete_clips`, `move_clip`, `add_clip`, `add_track`, `remove_track`, `move_track`, `add_text_layer`, `add_caption_layer`, `add_keyframes`, `apply_color_grade`, `adjust_audio`, `add_transition`, `add_mask`, `track_object` | mutate   | Edit the timeline; each returns a validated, reversible patch that is applied                                                           |
| `render_preview`, `export_video`                                                                                                                                                                                               | action   | Render via the Python sidecar                                                                                                           |
| `analyze_silence`, `detect_scenes`                                                                                                                                                                                             | analysis | ffmpeg analysis (silent ranges / scene cuts) via the Python sidecar                                                                     |

A full machine-readable reference is in [docs/api/mcp-server.md](../api/mcp-server.md).
Tools whose engine does not exist yet (`detect_faces`, `generate_mask` — dependency-gated
CV) are **not** exposed until their capability lands — the server never fakes a result.

## Prerequisites

```bash
pnpm install
pnpm --filter @framepilot/mcp-server build   # produces dist/bin.js
```

### Environment

| Variable                        | Required | Purpose                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRAMEPILOT_PROJECTS_ROOT`      | no       | Sandbox root. Every project path must resolve inside this directory; traversal/symlink escapes are rejected. **Defaults to `~/Documents/FramePilot Projects`** — the same folder the desktop app saves into — so the server edits real projects with no extra config. Set it (in both the app and the server) if you keep projects elsewhere. |
| `FRAMEPILOT_PYTHON_API_URL`     | no       | Base URL of the running [Python render sidecar](python-engine-api.md) (e.g. `http://127.0.0.1:8765`). Without it, `render_preview`/`export_video` report that rendering is unavailable; all editing still works.                                                                                                                              |
| `FRAMEPILOT_MCP_HOST`           | no       | Host the listener binds to. Defaults to `127.0.0.1` (loopback).                                                                                                                                                                                                                                                                               |
| `FRAMEPILOT_MCP_PORT`           | no       | Port the listener binds to. Defaults to `19789`.                                                                                                                                                                                                                                                                                              |
| `FRAMEPILOT_MCP_PATH`           | no       | Request path. Defaults to `/mcp`.                                                                                                                                                                                                                                                                                                             |
| `FRAMEPILOT_MCP_TOKEN`          | no       | **Optional** shared bearer secret. When set, every request must carry `Authorization: Bearer <token>` or it is rejected with **401**. Unset (the default) means no auth — behavior is unchanged. Set it to lock the loopback endpoint against other local processes/users.                                                                    |
| `FRAMEPILOT_MCP_MAX_BODY_BYTES` | no       | Maximum accepted request-body size in bytes; a larger body is rejected with **413** before it is buffered. Defaults to `4194304` (4 MB).                                                                                                                                                                                                      |
| `FRAMEPILOT_MCP_MAX_SESSIONS`   | no       | Maximum number of concurrent MCP sessions; a further `initialize` gets **503**. Defaults to `64`.                                                                                                                                                                                                                                             |

The executable is `framepilot-mcp` (`packages/mcp-server/dist/bin.js`). It serves MCP
over **Streamable HTTP** on `http://127.0.0.1:19789/mcp` by default and writes only
diagnostics to stderr.

## Start the server

Unlike a stdio server (which each client spawns), the HTTP server is a long-lived
process you start once; clients then attach to its URL.

```bash
# FRAMEPILOT_PROJECTS_ROOT is optional — it defaults to ~/Documents/FramePilot Projects.
FRAMEPILOT_PYTHON_API_URL=http://127.0.0.1:8765 \
node /absolute/path/to/FramePilot/packages/mcp-server/dist/bin.js
# → [framepilot-mcp] ready on http://127.0.0.1:19789/mcp
```

## Editing the project open in the app

You don't have to tell the agent which file to edit. When you open or save a
project in the FramePilot desktop app, the app writes a small pointer file
(`.framepilot-active.json`) into the projects folder naming that project. The MCP
server reads it, so:

- `open_project` **with no `path`** opens whatever project the app currently has open.
- Any tool (e.g. `get_timeline`, `trim_clip`) **auto-targets that same project** when
  no project has been opened in the session yet — so _"tighten the pacing of my video"_
  just works against the file you're looking at in the app.

The pointer only names the file; it carries no project data. A project you opened in
the app from **outside** the projects folder (via the native file picker) is reported
but **cannot** be edited over MCP — it lies outside the sandbox, and the server returns
an `unsafe_path` error rather than reaching outside `FRAMEPILOT_PROJECTS_ROOT`.

> **Note:** the app and the server each read/write the `.fp.json` independently. The
> server guards against silently clobbering an external edit: it snapshots the file
> when it opens it and re-checks before every save, so if the app (or another process)
> wrote the file in the meantime, `save_project` fails with a `conflict` error instead
> of overwriting those changes. Re-open the project to pick up the external edit, then
> re-apply and save.

## Use it with Claude Code

With the server running, register its URL (note `--transport http`):

```bash
claude mcp add --transport http framepilot http://127.0.0.1:19789/mcp
```

Then, in a Claude Code session, the FramePilot tools appear under the `framepilot`
server. Confirm with `/mcp`. The equivalent `.mcp.json` entry is:

```json
{
  "mcpServers": {
    "framepilot": {
      "type": "http",
      "url": "http://127.0.0.1:19789/mcp"
    }
  }
}
```

## Use it with Claude Desktop

With the server running, edit `claude_desktop_config.json` (Settings → Developer →
Edit Config) and add an HTTP server entry:

```json
{
  "mcpServers": {
    "framepilot": {
      "type": "http",
      "url": "http://127.0.0.1:19789/mcp"
    }
  }
}
```

Restart Claude Desktop; the FramePilot tools appear in the tools menu. (If you change
`FRAMEPILOT_MCP_PORT`/`FRAMEPILOT_MCP_PATH`, update the `url` to match.)

## Example session

A typical agent flow (tool name → arguments):

1. `open_project` → `{ "path": "demo/project.fp.json" }`
2. `get_timeline` → `{}` — inspect tracks/clips and grab clip ids.
3. `trim_clip` → `{ "clipId": "clip_a", "start": 0, "end": 4 }` — returns
   `{ applied: true, patch, validation, diff }`. A patch that fails validation comes
   back with `applied: false` and the timeline is left untouched.
4. `split_clip` → `{ "clipId": "clip_b", "at": 7 }`
5. `undo` → `{}` if you change your mind; `redo` → `{}` to reapply.
6. `save_project` → `{}` — atomic write; patch history is persisted.
7. `export_video` → `{}` — saves, then asks the sidecar to render and auto-validate.

## Safety notes

- **Sandbox.** Paths are resolved with the same containment rule as the engine
  (`resolveWithin` ↔ `framepilot_engine.safety.resolve_within`). `../`, absolute
  escapes, and symlinks pointing outside `FRAMEPILOT_PROJECTS_ROOT` are rejected.
- **Non-destructive.** Edits are timeline operations; originals are never modified.
  Renders go to the project's render output via the sidecar.
- **Validated + reversible.** Every mutation is validated before apply and recorded
  for undo. Rendering happens only in the Python engine.
- **Loopback + DNS-rebinding.** The listener binds `127.0.0.1` and enables the SDK's
  DNS-rebinding protection on **both** the `Host` **and** `Origin` headers, so a page
  on another origin cannot drive the server even though it runs on your machine.
- **Request hygiene.** Oversized bodies are rejected with **413** before buffering,
  malformed JSON returns **400** (not 500), and concurrent sessions are capped (**503**
  past the limit) so a runaway client cannot exhaust memory or session slots.
- **Lost-update guard.** `save_project` refuses to overwrite a project file that
  changed on disk since it was opened, returning a `conflict` error.
- **Optional auth.** Set `FRAMEPILOT_MCP_TOKEN` to require a bearer token on every
  request (constant-time compared); unset, the endpoint stays open on loopback as before.

## Troubleshooting

- _Client can't connect / tools don't appear_ — make sure the server process is
  running (`[framepilot-mcp] ready on …`) and the `url` matches its host/port/path.
  A bare `curl http://127.0.0.1:19789/mcp` returning `Unknown or expired MCP session`
  is **expected**, not a fault: MCP requires an `initialize` POST handshake before any
  other request, which `claude mcp list` / Claude Desktop perform automatically.
- _Tools stop listing after the host restarts_ — sessions live in memory, so a restart
  invalidates the client's cached `mcp-session-id`. The server answers a request carrying
  an unknown session id with **HTTP 404**, which the spec requires so the client
  re-initializes transparently; you should not need to restart the client.
- _`EADDRINUSE`_ — another process holds the port; set `FRAMEPILOT_MCP_PORT` to a free
  port and update the client `url` to match.
- _`Invalid Host header` / `Invalid Origin header` (HTTP 403)_ — the DNS-rebinding
  guard rejected a non-loopback `Host` or a cross-origin `Origin`. Connect via
  `127.0.0.1`/`localhost`; do not put the server behind a different hostname, reverse
  proxy, or a browser page served from another origin.
- _`Missing or invalid bearer token` (HTTP 401)_ — `FRAMEPILOT_MCP_TOKEN` is set on
  the server; the client must send `Authorization: Bearer <token>` with the same value.
- _`Request body exceeds …` (HTTP 413)_ — the request body is larger than
  `FRAMEPILOT_MCP_MAX_BODY_BYTES`; raise the cap only if you have a legitimate reason.
- _`Too many active MCP sessions` (HTTP 503)_ — more than `FRAMEPILOT_MCP_MAX_SESSIONS`
  sessions are live; close idle clients or raise the cap.
- _`[conflict] Project file changed on disk …`_ — the `.fp.json` was written by the app
  or another process after the session opened it. Re-open the project, re-apply, save.
- _"No active project"_ — nothing is open in this session and the app has no project
  open (no pointer file). Open a project in the FramePilot app, or call `open_project`
  with an explicit `path`.
- _Rendering reports unavailable_ — set `FRAMEPILOT_PYTHON_API_URL` and start the
  sidecar (`pnpm --filter @framepilot/engine ...` / `framepilot serve`; see the
  [Python engine API guide](python-engine-api.md)).
- _Path errors_ — the path must be **inside** `FRAMEPILOT_PROJECTS_ROOT`; pass it
  relative to that root.
