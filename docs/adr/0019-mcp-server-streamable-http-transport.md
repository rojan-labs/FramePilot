# ADR 0019: MCP server moves from stdio to Streamable HTTP

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** FramePilot maintainers
- **Supersedes:** the transport decision in [ADR 0015](0015-mcp-server-over-stdio.md)

## Context

[ADR 0015](0015-mcp-server-over-stdio.md) shipped `packages/mcp-server` exposing the
canonical `TOOL_REGISTRY` to external MCP clients over **stdio**. Stdio binds the host
to a single client that _spawns_ the process (`node dist/bin.js`) as a child and pipes
JSON-RPC over its stdin/stdout. In practice this has friction:

- Every client launches its **own** copy of the host, each with its own `EditorSession`
  and open-project state — the desktop app and an external agent cannot share one host.
- Configuration duplicates the absolute `node …/dist/bin.js` path and all env vars in
  each client config, and breaks when the repo path changes.
- Clients increasingly prefer attaching to a long-lived server by **URL**
  (`{ "type": "http", "url": … }`), which stdio cannot offer.

The MCP SDK (`@modelcontextprotocol/sdk`, already a dependency) ships a **Streamable
HTTP** server transport that speaks the same protocol over HTTP + SSE.

Constraints unchanged from ADR 0015: the five invariants still hold, the tool surface
is still derived from `TOOL_REGISTRY`, rendering still delegates to the Python sidecar,
and **adding a dependency requires review** (CLAUDE.md §5).

## Decision

Serve the FramePilot MCP host over the SDK's **`StreamableHTTPServerTransport`** instead
of stdio. `bin.ts` now starts an HTTP listener (new `src/http.ts`) that defaults to the
loopback address **`http://127.0.0.1:19789/mcp`**, overridable via
`FRAMEPILOT_MCP_HOST` / `FRAMEPILOT_MCP_PORT` / `FRAMEPILOT_MCP_PATH`.

Implementation notes:

- **No new dependency.** The transport is wired to Node's built-in `http` server
  (`http.createServer`); the SDK's Node wrapper pulls in `@hono/node-server`, which is
  already a transitive dependency of `@modelcontextprotocol/sdk`. `pnpm license:scan`
  stays green.
- **Loopback only + DNS-rebinding guard.** The listener binds `127.0.0.1` and enables
  the transport's `enableDnsRebindingProtection` with `allowedHosts` set to the bound
  `host:port` and `localhost:port`. A request with a foreign `Host` header is rejected
  with `403 Invalid Host header`, so a web page on another origin cannot drive the host.
- **One session per connection, shared editing state.** A `StreamableHTTPServerTransport`
  is created per MCP session (keyed by the `mcp-session-id` header), but all sessions
  share the same `EditorSession` + `RenderClient` (`ServerDeps`), so the open project
  stays consistent across reconnects — the same single-user-local model stdio had.
- **stdio is removed**, not kept in parallel — one transport, one code path to test.

The transport glue (`http.ts`, like `server.ts`/`bin.ts`) carries no business logic and
is excluded from the 100%-coverage gate; the pure listener-config resolver
(`resolveHttpConfig`) is unit-tested, and the end-to-end flow (initialize → tools/list,
plus the Host-header rejection) is verified by a manual smoke test.

## Consequences

**Positive**

- Clients attach by URL (`{ "type": "http", "url": "http://127.0.0.1:19789/mcp" }`) — no
  per-client absolute paths or duplicated env; one running host can serve multiple
  clients against one consistent project state.
- No new dependency; all ADR-0015 invariants preserved end to end.
- DNS-rebinding protection makes the local HTTP surface safe against cross-origin abuse.

**Negative / costs**

- The host must be **started explicitly** before clients connect (stdio auto-spawned it).
  Documented in the guide; a future desktop-managed lifecycle can automate it.
- A local TCP port is now listening (loopback only). Port conflicts surface as
  `EADDRINUSE`; `FRAMEPILOT_MCP_PORT` resolves them.

**Follow-ups / guardrails**

- Keep the listener **loopback-only**; broadening the bind host or adding remote access
  requires auth (e.g. a bearer token) and a fresh security review.
- The deferred MCP e2e (PLAN §4.4) should now drive the server over a real HTTP client.

## Alternatives Considered

- **Keep stdio (status quo).** Rejected: cannot share one host across clients and forces
  per-client absolute-path config; the requirement is an attachable URL endpoint.
- **Dual transport (stdio + HTTP).** Rejected for now: doubles the transport surface and
  tests for no current consumer; HTTP covers the local clients we target.
- **Add `express` (most SDK examples use it).** Rejected: a new runtime dependency
  needing license review when Node's built-in `http` plus the SDK's existing
  `@hono/node-server` wrapper already suffice.
- **Bind a token/auth now.** Deferred: loopback + DNS-rebinding protection is the
  standard, sufficient posture for a single-user local host; revisit if we ever bind a
  non-loopback host.
