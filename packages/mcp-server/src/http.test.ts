/**
 * Tests for the HTTP listener configuration resolver and the session-handling
 * contract of the Streamable HTTP request router. The config resolver is pure; the
 * router is exercised here against a real loopback listener because its status-code
 * behavior (404 vs 400 vs 200) is a Streamable HTTP spec requirement, not cosmetic —
 * a 404 on an unknown session id is what makes a client re-initialize after the host
 * restarts (see ADR 0015).
 */
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveHttpConfig, startHttpServer } from './http.js';
import { EditorSession } from './session.js';
import { makeSandboxProject } from './__fixtures__/project.js';

const ACCEPT = 'application/json, text/event-stream';
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1' },
  },
} as const;
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as const;

/**
 * Reserve a free loopback port and release it. The SDK's DNS-rebinding guard checks
 * the request `Host`/`Origin` against an allowlist fixed at bind time, so we cannot
 * bind port 0 (the port is unknown until after bind). Grab one, release it, reuse it.
 */
function reserveFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
}

describe('resolveHttpConfig', () => {
  it('defaults to the loopback address 127.0.0.1:19789/mcp', () => {
    const config = resolveHttpConfig({});
    expect(config).toEqual({
      host: '127.0.0.1',
      port: 19789,
      path: '/mcp',
      allowedHosts: ['127.0.0.1:19789', 'localhost:19789'],
      allowedOrigins: ['http://127.0.0.1:19789', 'http://localhost:19789'],
      maxBodyBytes: 4 * 1024 * 1024,
      maxSessions: 64,
      token: null,
    });
  });

  it('honors a FRAMEPILOT_MCP_MAX_SESSIONS override and rejects invalid values', () => {
    expect(resolveHttpConfig({ FRAMEPILOT_MCP_MAX_SESSIONS: '4' }).maxSessions).toBe(4);
    expect(() => resolveHttpConfig({ FRAMEPILOT_MCP_MAX_SESSIONS: '0' })).toThrow(
      /FRAMEPILOT_MCP_MAX_SESSIONS/,
    );
    expect(() => resolveHttpConfig({ FRAMEPILOT_MCP_MAX_SESSIONS: 'lots' })).toThrow(
      /FRAMEPILOT_MCP_MAX_SESSIONS/,
    );
  });

  it('reads FRAMEPILOT_MCP_TOKEN when set and treats blank/unset as no auth', () => {
    expect(resolveHttpConfig({ FRAMEPILOT_MCP_TOKEN: 's3cret' }).token).toBe('s3cret');
    expect(resolveHttpConfig({ FRAMEPILOT_MCP_TOKEN: '  s3cret  ' }).token).toBe('s3cret');
    expect(resolveHttpConfig({ FRAMEPILOT_MCP_TOKEN: '   ' }).token).toBeNull();
    expect(resolveHttpConfig({}).token).toBeNull();
  });

  it('honors a FRAMEPILOT_MCP_MAX_BODY_BYTES override and rejects invalid values', () => {
    expect(resolveHttpConfig({ FRAMEPILOT_MCP_MAX_BODY_BYTES: '1024' }).maxBodyBytes).toBe(1024);
    expect(() => resolveHttpConfig({ FRAMEPILOT_MCP_MAX_BODY_BYTES: '0' })).toThrow(
      /FRAMEPILOT_MCP_MAX_BODY_BYTES/,
    );
    expect(() => resolveHttpConfig({ FRAMEPILOT_MCP_MAX_BODY_BYTES: 'huge' })).toThrow(
      /FRAMEPILOT_MCP_MAX_BODY_BYTES/,
    );
  });

  it('honors host/port/path overrides and rebuilds the allowed hosts and origins', () => {
    const config = resolveHttpConfig({
      FRAMEPILOT_MCP_HOST: '127.0.0.1',
      FRAMEPILOT_MCP_PORT: '20000',
      FRAMEPILOT_MCP_PATH: '/framepilot',
    });
    expect(config.port).toBe(20000);
    expect(config.path).toBe('/framepilot');
    expect(config.allowedHosts).toEqual(['127.0.0.1:20000', 'localhost:20000']);
    expect(config.allowedOrigins).toEqual(['http://127.0.0.1:20000', 'http://localhost:20000']);
  });

  it.each(['0', '70000', 'not-a-port', '8080.5'])('rejects an invalid port %s', (port) => {
    expect(() => resolveHttpConfig({ FRAMEPILOT_MCP_PORT: port })).toThrow(/FRAMEPILOT_MCP_PORT/);
  });
});

describe('startHttpServer session routing', () => {
  let server: HttpServer;
  let sandboxRoot: string;
  let url: string;
  let origin: string;

  beforeAll(async () => {
    const { root } = await makeSandboxProject();
    sandboxRoot = root;
    const port = await reserveFreePort();
    server = await startHttpServer(
      { session: new EditorSession(root), renderClient: null, analysisClient: null },
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
        allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
        maxBodyBytes: 4 * 1024 * 1024,
        maxSessions: 64,
        token: null,
      },
    );
    url = `http://127.0.0.1:${port}/mcp`;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
    server.close();
  });

  const post = (body: unknown, sessionId?: string): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        origin,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

  it('opens a session on initialize and returns an mcp-session-id', async () => {
    const res = await post(INITIALIZE);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('serves tools/list against a live session id from the handshake', async () => {
    const init = await post(INITIALIZE);
    const sessionId = init.headers.get('mcp-session-id') ?? '';
    const res = await post(TOOLS_LIST, sessionId);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('open_project');
  });

  it('returns 404 (not 400) for a POST with an unknown session id so clients re-initialize', async () => {
    // Simulates a host restart: the client keeps its cached id, but the in-memory
    // transport map no longer holds it. The spec mandates 404 here.
    const res = await post(TOOLS_LIST, 'stale-session-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-initialize POST with no session id at all', async () => {
    const res = await post(TOOLS_LIST);
    expect(res.status).toBe(400);
  });

  it('returns 404 on a GET with no session', async () => {
    const res = await fetch(url, { method: 'GET', headers: { accept: ACCEPT, origin } });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown path with 404', async () => {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, origin },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a cross-origin initialize with 403 (DNS-rebinding guard)', async () => {
    // A browser on another origin always sends `Origin`; the SDK Origin check
    // (enabled by allowedOrigins) rejects it before any session is opened.
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        origin: 'http://evil.example.com',
      },
      body: JSON.stringify(INITIALIZE),
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 (not 500) for a malformed JSON body', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, origin },
      body: '{ not valid json',
    });
    expect(res.status).toBe(400);
  });
});

describe('startHttpServer request hygiene', () => {
  let server: HttpServer;
  let sandboxRoot: string;
  let url: string;
  let origin: string;

  beforeAll(async () => {
    const { root } = await makeSandboxProject();
    sandboxRoot = root;
    const port = await reserveFreePort();
    server = await startHttpServer(
      { session: new EditorSession(root), renderClient: null, analysisClient: null },
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
        allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
        // Tiny cap so a normal-sized body trips the 413 guard.
        maxBodyBytes: 16,
        maxSessions: 64,
        token: null,
      },
    );
    url = `http://127.0.0.1:${port}/mcp`;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
    server.close();
  });

  it('rejects an oversized request body with 413', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, origin },
      body: JSON.stringify(INITIALIZE), // well over the 16-byte cap
    });
    expect(res.status).toBe(413);
  });
});

describe('startHttpServer session cap', () => {
  let server: HttpServer;
  let sandboxRoot: string;
  let url: string;
  let origin: string;

  beforeAll(async () => {
    const { root } = await makeSandboxProject();
    sandboxRoot = root;
    const port = await reserveFreePort();
    server = await startHttpServer(
      { session: new EditorSession(root), renderClient: null, analysisClient: null },
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
        allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
        maxBodyBytes: 4 * 1024 * 1024,
        maxSessions: 1, // only one live session allowed
        token: null,
      },
    );
    url = `http://127.0.0.1:${port}/mcp`;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
    server.close();
  });

  it('rejects an initialize beyond the concurrent-session cap with 503', async () => {
    const headers = { 'content-type': 'application/json', accept: ACCEPT, origin };
    const first = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(INITIALIZE),
    });
    expect(first.status).toBe(200); // fills the single session slot
    const second = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(INITIALIZE),
    });
    expect(second.status).toBe(503);
  });
});

describe('startHttpServer optional bearer auth', () => {
  const TOKEN = 'super-secret-token';
  let server: HttpServer;
  let sandboxRoot: string;
  let url: string;
  let origin: string;

  beforeAll(async () => {
    const { root } = await makeSandboxProject();
    sandboxRoot = root;
    const port = await reserveFreePort();
    server = await startHttpServer(
      { session: new EditorSession(root), renderClient: null, analysisClient: null },
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
        allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
        maxBodyBytes: 4 * 1024 * 1024,
        maxSessions: 64,
        token: TOKEN,
      },
    );
    url = `http://127.0.0.1:${port}/mcp`;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
    server.close();
  });

  const initWith = (authorization?: string): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        origin,
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(INITIALIZE),
    });

  it('rejects a request with no Authorization header with 401', async () => {
    expect((await initWith()).status).toBe(401);
  });

  it('rejects a wrong bearer token with 401', async () => {
    expect((await initWith('Bearer wrong-token')).status).toBe(401);
  });

  it('accepts the matching bearer token', async () => {
    const res = await initWith(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });
});
