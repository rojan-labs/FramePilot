# API: MCP Server (`@framepilot/mcp-server`)

The MCP server advertises FramePilot's editing tools to MCP clients over the
Streamable HTTP transport (loopback `http://127.0.0.1:19789/mcp` by default). This
document describes the request/response contract. For setup and client configuration
see the [MCP server guide](../guides/mcp-server.md); for the rationale see
[ADR 0015](../adr/0015-mcp-server-over-stdio.md) and
[ADR 0019](../adr/0019-mcp-server-streamable-http-transport.md) (transport).

## Tool surface

`tools/list` returns:

1. **Session tools** (defined in `src/tools.ts#SESSION_TOOLS`) — manage host state.
2. **Registry tools** — every _available_ tool in the canonical `TOOL_REGISTRY`
   (`@framepilot/ai-sdk`), mapped 1:1 via `buildMcpTools()`. The `inputSchema` is the
   exact JSON Schema the registry derived from each tool's Zod schema, so the MCP
   surface can never drift from the in-app AI surface. A parity test
   (`src/tools.test.ts`) enforces this. Tools with `available: false` (`generate_mask` —
   a segmentation is a bitmap, while timeline masks steer by rectangle bounds) are
   **omitted** until their engine exists. Tools marked `hostUiOnly` are also omitted, and
   refused by name in `session.ts` — hiding a tool from the list is not enforcement when a
   client can still call it directly.

   **The `hostUiOnly` boundary, stated in full.** It is not one rule but three, and they
   are worth separating because they fail differently and would be lifted differently.
   Of the 13 tools currently withheld:

   | Reason                                                                                                        | Tools                                                                                                    | Could MCP ever have these?                                                                                                                                              |
   | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | **No authoritative live editor state** — no selection, playhead, source-monitor, effect, or keyframe snapshot | the five `professional_*` controllers, `measure_color`, `track_subject_automatically`, `detect_subjects` | Only with a way to carry an explicit target instead of "what the human has selected". Explicit-target registry operations are already portable and stay on the surface. |
   | **Provider network and API keys live in the Electron main process** — the sidecar has no route for them       | `search_music`, `search_stock`, `add_music`, `add_stock`                                                 | Yes in principle: this is a wiring boundary, not a semantic one. It needs a keyed egress path outside main before it is safe, so it is deferred rather than impossible. |
   | **No human to answer**                                                                                        | `ask_user` (ADR 0059)                                                                                    | No — the tool's whole contract is a round trip to a person looking at the editor.                                                                                       |

   Treat this table as the product position, not an implementation note: an external agent
   driving FramePilot over MCP gets the full deterministic editing surface and none of the
   sourcing, professional-controller, or ask-the-editor capabilities. Do not promise MCP
   parity with in-app Agent mode without changing one of the three rows above.

### Session tools

| Name                | Input               | Result `result` payload                                       |
| ------------------- | ------------------- | ------------------------------------------------------------- |
| `open_project`      | `{ path?: string }` | `{ projectId, projectName, canUndo, canRedo, historyLength }` |
| `save_project`      | `{ path?: string }` | `{ projectId, projectName, canUndo, canRedo, historyLength }` |
| `undo`              | `{}`                | `{ projectId, projectName, canUndo, canRedo, historyLength }` |
| `redo`              | `{}`                | `{ projectId, projectName, canUndo, canRedo, historyLength }` |
| `get_patch_history` | `{}`                | `{ patches: Patch[] }`                                        |

The input `path` is resolved relative to the projects root (`FRAMEPILOT_PROJECTS_ROOT`,
default `~/Documents/FramePilot Projects`) and sandbox-checked. Omit `open_project`'s
`path` to open the project currently open in the FramePilot app; tools that need an open
project auto-open it the same way when none has been opened in the session.

The state payload identifies the open project by its stable in-project `projectId` and
display `projectName` — **never** by its absolute on-disk path. Clients do not need (and
are not given) the filesystem path: session tools always target the open project
implicitly. This is deliberate — leaking the path let agents with their own filesystem
tools edit `project.fp.json` directly and bypass validation/undo.

### Registry tools (summary)

- **read** (`get_project_state`, `get_timeline`, `get_timeline_summary`, `get_clips`,
  `get_clip`, `get_transcript`, `get_selected_range`, `list_assets`) → `result` is the
  requested project data. `get_timeline_summary` / `get_clips` / `get_clip` are the
  compact, windowed reads for long-form projects; `get_transcript` accepts an optional
  `start`/`end` window.
- **mutate** (`trim_clip`, `split_clip`, `delete_range`, `ripple_delete`,
  `delete_clip`, `delete_clips`, `move_clip`, `add_clip`, `add_track`, `remove_track`,
  `move_track`, `add_text_layer`, `add_caption_layer`, `add_keyframes`,
  `apply_color_grade`, `adjust_audio`, `add_transition`, `add_mask`, `track_object`)
  → `result` is `{ applied, patch, validation, diff }`. When `applied` is `false`
  the patch failed validation and the timeline is unchanged (`validation.issues`
  explains why). See [patch-format.md](patch-format.md) and [ai-tools.md](ai-tools.md)
  for the exact argument schemas.
- **action** (`render_preview`, `export_video`) → the server saves the project, then
  POSTs to the sidecar; `result` is `{ action, job }` where `job` is the sidecar's
  render-job JSON. Requires `FRAMEPILOT_PYTHON_API_URL`.
- **analysis** (`analyze_silence`, `detect_scenes`) → the server validates the args,
  saves the project, then POSTs to the sidecar's `/analyze-silence` / `/detect-scenes`
  routes (ffmpeg runs in the Python engine, never in Node); `result` is
  `{ analysis, result }` where `result` is the sidecar's data (silent ranges / scene
  cuts). Requires `FRAMEPILOT_PYTHON_API_URL`.

## Result shape

Every `tools/call` returns an MCP `CallToolResult`:

```jsonc
{
  "content": [{ "type": "text", "text": "<JSON-stringified result>" }],
  "structuredContent": { "result": <the result payload> },
  "isError": false
}
```

## Error model

Failures are returned as `{ isError: true }` with a `content[0].text` of the form
`[<code>] <message>` (they are not thrown across the protocol). Codes:

| Code                       | Meaning                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown_tool`             | The tool name is not registered.                                                                                                      |
| `unavailable_tool`         | Registered but its engine capability does not exist yet.                                                                              |
| `host_ui_only`             | The tool requires authoritative live FramePilot interaction state and is intentionally unavailable over MCP.                          |
| `invalid_args`             | Arguments failed the tool's schema validation.                                                                                        |
| `unsafe_path`              | A supplied path (or the active-project pointer target, or an `add_asset` media path) resolved outside the projects sandbox.           |
| `no_project`               | An edit/read/save was attempted with nothing open and no active project in the app to fall back to.                                   |
| `conflict`                 | `save_project` found the project file changed on disk since it was opened; the save is refused to avoid clobbering the external edit. |
| `render_unavailable`       | An action tool was called but `FRAMEPILOT_PYTHON_API_URL` is unset.                                                                   |
| `render_failed:<status>`   | The sidecar returned a non-2xx response for a render.                                                                                 |
| `analysis_unavailable`     | An analysis tool was called but `FRAMEPILOT_PYTHON_API_URL` is unset.                                                                 |
| `analysis_failed:<status>` | The sidecar returned a non-2xx response for an analysis.                                                                              |
| `internal_error`           | An unexpected error (surfaced, never swallowed).                                                                                      |

> Note: a **mutate** tool whose patch fails validation is **not** an error — it
> returns `isError: false` with `applied: false` so the agent can read `validation`
> and try again.

## Transport (HTTP) contract

Before any JSON-RPC dispatch, the Streamable HTTP listener applies transport-level
checks. These reply with a plain JSON-RPC error envelope and the following HTTP status:

| Status | When                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `401`  | `FRAMEPILOT_MCP_TOKEN` is set and the request lacks a matching `Authorization: Bearer <token>` (constant-time compared). |
| `403`  | DNS-rebinding guard: the `Host` is not in `allowedHosts`, or an `Origin` header is present and not in `allowedOrigins`.  |
| `400`  | Malformed JSON body, or a non-`initialize` POST with no session id.                                                      |
| `404`  | Unknown request path, or a POST/GET/DELETE carrying an unknown/expired `mcp-session-id` (clients re-`initialize`).       |
| `405`  | An HTTP method other than POST/GET/DELETE.                                                                               |
| `413`  | Request body exceeds `FRAMEPILOT_MCP_MAX_BODY_BYTES` (checked via `Content-Length` and while streaming).                 |
| `503`  | A new `initialize` would exceed `FRAMEPILOT_MCP_MAX_SESSIONS` concurrent sessions.                                       |

`resolveHttpConfig(env)` is the pure resolver for these settings; it returns
`{ host, port, path, allowedHosts, allowedOrigins, maxBodyBytes, maxSessions, token }`.
`allowedHosts`/`allowedOrigins` are derived from the bound host/port plus `localhost`;
`token` is `null` unless `FRAMEPILOT_MCP_TOKEN` is a non-blank string. See the
[MCP server guide](../guides/mcp-server.md#environment) for the environment variables.

## Public module surface

`@framepilot/mcp-server` also exports its building blocks for embedding/testing:
`EditorSession`, `RenderClient`, `buildMcpTools`, `callTool`, `resolveWithin`,
`createServer`, `resolveHttpConfig`, `startHttpServer`, and their types. See
`src/index.ts`.
