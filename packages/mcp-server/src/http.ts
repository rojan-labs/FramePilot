/**
 * @framepilot/mcp-server/http — serve MCP over Streamable HTTP.
 *
 * WHY HTTP instead of stdio: the Streamable HTTP transport lets clients attach to
 * a long-lived FramePilot host with a single URL (`http://127.0.0.1:19789/mcp`)
 * instead of each client spawning its own `node dist/bin.js` child over stdio.
 * That matches how Claude Code/Desktop register an `"type": "http"` server and lets
 * the desktop app and external agents share one running host. See ADR 0015.
 *
 * Security posture: the default listener binds loopback (`127.0.0.1`). If an
 * operator explicitly binds a non-loopback interface, bearer authentication becomes
 * mandatory so the privileged editing surface is never exposed to the network
 * anonymously. The SDK's DNS-rebinding protection (`allowedHosts`/`allowedOrigins`)
 * remains enabled for browser-originated requests. Every edit still flows through
 * the validated, reversible patch pipeline in {@link EditorSession}; this module is
 * pure transport wiring (excluded from coverage like `server.ts`/`bin.ts`).
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer, type ServerDeps } from './server.js';

/** Default loopback host the MCP HTTP listener binds to. */
const DEFAULT_HOST = '127.0.0.1';
/** Default TCP port (override with `FRAMEPILOT_MCP_PORT`). */
const DEFAULT_PORT = 19789;
/** Default request path clients POST/GET against. */
const DEFAULT_PATH = '/mcp';
/** Header the Streamable HTTP transport uses to carry the session id. */
const SESSION_HEADER = 'mcp-session-id';
const MIN_PORT = 1;
const MAX_PORT = 65535;
/**
 * Default cap on a single request body (~4 MB). A JSON-RPC MCP request is tiny;
 * this only exists to reject a hostile/broken client streaming an unbounded body
 * (memory-exhaustion DoS) before we buffer it. Override with
 * `FRAMEPILOT_MCP_MAX_BODY_BYTES`.
 */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Default cap on concurrent MCP sessions. Each `initialize` allocates a transport +
 * MCP Server kept in memory until the client disconnects; bounding the map stops a
 * client from opening sessions without limit (resource-exhaustion DoS). Override with
 * `FRAMEPILOT_MCP_MAX_SESSIONS`.
 */
const DEFAULT_MAX_SESSIONS = 64;

/** Bearer scheme prefix required in the `Authorization` header when a token is set. */
const BEARER_PREFIX = 'Bearer ';

/**
 * A transport-level failure carrying the HTTP status to reply with. Used so
 * request hygiene (oversized body → 413, malformed JSON → 400) short-circuits with
 * the right status instead of bubbling to the generic 500 handler.
 */
class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Resolved listener settings for the MCP Streamable HTTP server. */
export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** `host:port` values permitted in the `Host` header (DNS-rebinding guard). */
  readonly allowedHosts: readonly string[];
  /**
   * `scheme://host:port` values permitted in the `Origin` header. The SDK only
   * enforces this when a request actually carries an `Origin` (native clients
   * like Claude Code/Desktop do not), so setting it closes the browser
   * DNS-rebinding vector without breaking non-browser clients.
   */
  readonly allowedOrigins: readonly string[];
  /** Maximum accepted request-body size in bytes; larger bodies are rejected with 413. */
  readonly maxBodyBytes: number;
  /** Maximum number of concurrent MCP sessions; a further `initialize` gets 503. */
  readonly maxSessions: number;
  /**
   * Optional on loopback and mandatory on non-loopback binds. When set
   * (`FRAMEPILOT_MCP_TOKEN`), every request must carry
   * `Authorization: Bearer <token>` or it is rejected with 401.
   */
  readonly token: string | null;
}

/** True only for the explicit loopback names accepted for anonymous local use. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

/**
 * Resolve the HTTP listener configuration from the environment.
 *
 * Defaults to the loopback address `127.0.0.1:19789/mcp`. `allowedHosts` always
 * pairs the bound host and `localhost` with the port so the DNS-rebinding guard
 * accepts local clients while rejecting cross-origin `Host` headers; `allowedOrigins`
 * mirrors that allowlist as `http://` origins so the SDK's Origin check runs too.
 * A non-loopback `FRAMEPILOT_MCP_HOST` requires `FRAMEPILOT_MCP_TOKEN` because
 * Host/Origin checks do not authenticate native or direct HTTP clients.
 *
 * @param env - Process environment (injectable for tests).
 * @returns The resolved {@link HttpConfig}.
 * @throws If a listener limit is invalid, or a non-loopback bind has no bearer token.
 */
export function resolveHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const host = env.FRAMEPILOT_MCP_HOST?.trim() || DEFAULT_HOST;
  const path = env.FRAMEPILOT_MCP_PATH ?? DEFAULT_PATH;
  const port = env.FRAMEPILOT_MCP_PORT ? Number(env.FRAMEPILOT_MCP_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `FRAMEPILOT_MCP_PORT must be a TCP port in [${MIN_PORT}, ${MAX_PORT}]; got "${env.FRAMEPILOT_MCP_PORT}".`,
    );
  }
  const maxBodyBytes = env.FRAMEPILOT_MCP_MAX_BODY_BYTES
    ? Number(env.FRAMEPILOT_MCP_MAX_BODY_BYTES)
    : DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error(
      `FRAMEPILOT_MCP_MAX_BODY_BYTES must be a positive integer; got "${env.FRAMEPILOT_MCP_MAX_BODY_BYTES}".`,
    );
  }
  const maxSessions = env.FRAMEPILOT_MCP_MAX_SESSIONS
    ? Number(env.FRAMEPILOT_MCP_MAX_SESSIONS)
    : DEFAULT_MAX_SESSIONS;
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error(
      `FRAMEPILOT_MCP_MAX_SESSIONS must be a positive integer; got "${env.FRAMEPILOT_MCP_MAX_SESSIONS}".`,
    );
  }
  // Trim so accidental whitespace does not create a token that can never match; an
  // empty/blank value means "no auth" (null), never a matchable empty secret.
  const trimmedToken = env.FRAMEPILOT_MCP_TOKEN?.trim();
  const token = trimmedToken ? trimmedToken : null;
  if (!isLoopbackHost(host) && token === null) {
    throw new Error(
      'FRAMEPILOT_MCP_TOKEN is required when FRAMEPILOT_MCP_HOST binds a non-loopback interface.',
    );
  }
  return {
    host,
    port,
    path,
    allowedHosts: [`${host}:${port}`, `localhost:${port}`],
    allowedOrigins: [`http://${host}:${port}`, `http://localhost:${port}`],
    maxBodyBytes,
    maxSessions,
    token,
  };
}

/**
 * Constant-time check that an `Authorization` header carries the expected bearer
 * token. Length is compared first (timingSafeEqual requires equal-length buffers);
 * the comparison itself is constant-time to avoid leaking the secret byte by byte.
 */
function bearerTokenMatches(expected: string, header: string | undefined): boolean {
  if (!header || !header.startsWith(BEARER_PREFIX)) return false;
  const provided = Buffer.from(header.slice(BEARER_PREFIX.length));
  const secret = Buffer.from(expected);
  return provided.length === secret.length && timingSafeEqual(provided, secret);
}

/**
 * Read and JSON-parse a request body, or `undefined` when empty.
 *
 * Enforces `maxBytes`: a `Content-Length` over the cap is rejected *before* any
 * buffering, and the streamed bytes are counted so a client that lies about (or
 * omits) `Content-Length` is still cut off. Both cases raise a 413 {@link HttpError};
 * a non-JSON body raises a 400 so the caller never returns 500 for client mistakes.
 *
 * @throws {HttpError} 413 when the body exceeds `maxBytes`, 400 when it is not JSON.
 */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `Request body exceeds the ${maxBytes}-byte limit.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new HttpError(413, `Request body exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

/** Reply with a JSON-RPC error envelope (no session bound). */
function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Start the FramePilot MCP server over Streamable HTTP.
 *
 * One {@link StreamableHTTPServerTransport} is created per MCP session (keyed by the
 * `mcp-session-id` header). All sessions share the same {@link ServerDeps} — the
 * single local {@link EditorSession} and render client — so the open project stays
 * consistent across reconnects, exactly like the stdio host did for one client.
 *
 * @param deps - The editing session and (optional) render client.
 * @param config - Resolved listener settings (see {@link resolveHttpConfig}).
 * @returns The listening Node HTTP server (resolved once bound).
 */
export function startHttpServer(deps: ServerDeps, config: HttpConfig): Promise<HttpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const createTransport = (): StreamableHTTPServerTransport => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: [...config.allowedHosts],
      allowedOrigins: [...config.allowedOrigins],
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    // Each transport binds its own MCP Server, but all share the same EditorSession.
    // The SDK class types `onclose` as `(() => void) | undefined`, which our stricter
    // `exactOptionalPropertyTypes` rejects against `Transport`'s optional field; the
    // runtime contract is identical, so we bridge the structural mismatch here.
    void createServer(deps).connect(transport as unknown as Transport);
    return transport;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Optional bearer auth on loopback, mandatory for non-loopback binds: gate every
    // request before any routing so an unauthenticated caller learns nothing.
    if (config.token && !bearerTokenMatches(config.token, req.headers.authorization)) {
      sendJsonRpcError(res, 401, 'Missing or invalid bearer token.');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`);
    if (url.pathname !== config.path) {
      sendJsonRpcError(res, 404, `Unknown path; POST/GET ${config.path}.`);
      return;
    }
    const sessionId = req.headers[SESSION_HEADER] as string | undefined;
    const existing = sessionId ? transports.get(sessionId) : undefined;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req, config.maxBodyBytes);
      } catch (err) {
        if (err instanceof HttpError) {
          sendJsonRpcError(res, err.status, err.message);
          return;
        }
        throw err;
      }
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      // The client presented a session id we don't recognize — typically because the
      // host restarted and wiped the in-memory `transports` map while the client kept
      // its cached id. The Streamable HTTP spec requires HTTP 404 here so a compliant
      // client (Claude Code/Desktop) re-initializes automatically; returning 400 would
      // strand it on a hard error ("can't list tools") until the client itself restarts.
      if (sessionId) {
        sendJsonRpcError(res, 404, 'Unknown or expired MCP session; re-initialize.');
        return;
      }
      // No session id at all: only a fresh initialize request may open one.
      if (!isInitializeRequest(body)) {
        sendJsonRpcError(res, 400, 'No valid session; send an initialize request first.');
        return;
      }
      // Bound the number of live sessions so a client cannot open them without limit.
      if (transports.size >= config.maxSessions) {
        sendJsonRpcError(res, 503, 'Too many active MCP sessions; try again later.');
        return;
      }
      await createTransport().handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) {
        sendJsonRpcError(res, 404, 'Unknown or expired MCP session.');
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }

    sendJsonRpcError(res, 405, 'Method not allowed; use POST, GET, or DELETE.');
  };

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      process.stderr.write(
        `[framepilot-mcp] request error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (!res.headersSent) sendJsonRpcError(res, 500, 'Internal server error.');
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(config.port, config.host, () => resolve(httpServer));
  });
}
