# ADR 0015: MCP server exposing the tool registry over stdio

- **Status:** Accepted — **transport superseded by [ADR 0019](0019-mcp-server-streamable-http-transport.md)**
- **Date:** 2026-06-24
- **Deciders:** FramePilot maintainers

> **Update (2026-06-25):** the _transport_ decision below (stdio) was superseded by
> [ADR 0019](0019-mcp-server-streamable-http-transport.md), which moves the server to
> the **Streamable HTTP** transport on loopback (`http://127.0.0.1:19789/mcp`).
> Everything else in this ADR — the derived tool surface, `EditorSession` invariants,
> the path sandbox, and sidecar render delegation — still holds.

## Context

FramePilot's editing capabilities (trim, split, captions, color, audio, transitions,
render/export) are defined once as a canonical, schema-validated **tool registry**
(`TOOL_REGISTRY` in `@framepilot/ai-sdk`, PRD §8.3). Until now the only caller was the
in-app AI orchestrator. We want **external** AI agents — Claude Desktop, Claude Code,
and any [Model Context Protocol](https://modelcontextprotocol.io) client — to drive the
same editing engine end to end: open a project, edit, undo/redo, save, and render.

Forces and constraints:

- The five invariants in [`../../AGENTS.md`](../../AGENTS.md) must hold: non-destructive,
  typed operations only, validate-before-apply, automatic render validation, and
  "edits only via registered tools returning reversible patches — never raw
  `project.fp.json` mutation."
- The canonical tool source is **TypeScript**; the patch engine
  (`@framepilot/editor-core`) and project IO (`@framepilot/timeline-schema`) are TS too.
- The render engine is **Python MoviePy + FFmpeg** and must stay isolated from any JS
  process (the render-vs-preview hard rule).
- A user requirement: adding a new registered tool must surface over MCP **automatically**,
  with no second list to maintain.
- Adding dependencies requires a license review ([`../../CLAUDE.md`](../../CLAUDE.md) §5).

## Decision

We will ship a new **TypeScript package `packages/mcp-server`** that runs an MCP server
over **stdio** using the official `@modelcontextprotocol/sdk` (MIT). Its tool surface is
**derived from `TOOL_REGISTRY`** (`buildMcpTools()` maps every _available_ tool, reusing
the JSON Schema the registry already derives from each Zod schema), plus a small set of
**session tools** (`open_project`, `save_project`, `undo`, `redo`, `get_patch_history`)
that manage host state. A parity test guards the auto-sync contract.

A stateful `EditorSession` enforces the invariants: a mutating tool produces typed
`Operation[]`, which are assembled into a patch by the shared `assembleEdit` helper (now
extracted from the orchestrator so both callers use one assembler), validated with
`validatePatch`, applied with `commitPatch` (reversible undo/redo), and saved atomically
with `writeProjectFile`. All file paths resolve through `resolveWithin`, a TS mirror of
the engine's `framepilot_engine.safety.resolve_within`, sandboxed to
`FRAMEPILOT_PROJECTS_ROOT`. The `render_preview`/`export_video` action tools **delegate**
to the Python sidecar over HTTP (`FRAMEPILOT_PYTHON_API_URL`); no rendering happens in the
MCP process.

The MCP server is a **trusted local host** (the same role as the desktop app), distinct
from the in-app AI runtime sandbox — but it still routes every edit through the validated
patch pipeline.

## Consequences

**Positive**

- External agents get full, safe editing with zero duplicated tool definitions; new
  registry tools appear over MCP automatically (parity-tested).
- One patch-assembly path (`assembleEdit`) shared by the orchestrator and the MCP host.
- Invariants preserved end to end: sandboxed paths, validate→apply→save, reversible
  history, render isolated in Python with automatic validation.
- 100% coverage on the editing-safety core (safety/session/tools/dispatch/render-client).

**Negative / costs**

- A new dependency, `@modelcontextprotocol/sdk` (MIT; `pnpm license:scan` green).
- The MCP host can write project files within the sandbox; it is meant to run locally
  under the user's control. Broadening the tool/IPC surface requires review.
- Rendering requires the sidecar to be running; otherwise action tools report
  `render_unavailable` (editing still works).

**Follow-ups / guardrails**

- Keep `resolveWithin` equivalent to the Python `resolve_within`.
- When a tool is added to the registry (and its Python mirror), the `mcp-engineer`
  agent verifies MCP exposure and updates docs/tests.

## Alternatives Considered

- **Python MCP server reusing `ai_tools/dispatch`.** Rejected: the canonical tool source
  is the TS registry; a Python server would risk TS/Python drift for new tools and could
  not reuse the TS patch engine directly.
- **Hand-roll the MCP JSON-RPC protocol (no dependency).** Rejected: hundreds of lines to
  maintain and a protocol-drift risk for no benefit over the official MIT SDK.
- **Propose-only (no apply/save).** Rejected: the goal is for an agent to _do_ edits end
  to end; the validated, reversible, sandboxed apply path makes full editing safe.
- **Expose unavailable tools as stubs.** Rejected: violates the build-order invariant —
  we never fake a capability.
