/**
 * Execution paths of `callAutonomousTool`.
 *
 * `autonomous-tools.test.ts` covers the *projection* — which capabilities are advertised
 * and with what schemas. It never called one, so the whole dispatch half of the module
 * (routing, the composite fan-out, error short-circuiting) shipped untested since the
 * capability landed.
 *
 * The router is mocked here rather than driven through real capabilities, deliberately:
 * every READY capability currently routes to a **single** registry call, so the
 * multi-call merge below cannot be reached with a real one. The module implements it
 * anyway, and code that exists is code that runs eventually — testing it against a mocked
 * route is the difference between "unproven" and "proven for the shape it claims to
 * handle". The real router keeps its own tests in `@framepilot/ai-sdk`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisClient } from './analysis-client.js';
import type { RenderClient } from './render-client.js';
import type { EditorSession } from './session.js';
import type { CallToolResult } from './dispatch.js';

const { callTool } = vi.hoisted(() => ({ callTool: vi.fn() }));
const { routeAutonomousToolCall } = vi.hoisted(() => ({ routeAutonomousToolCall: vi.fn() }));

vi.mock('./dispatch.js', () => ({ callTool }));
vi.mock('@framepilot/ai-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@framepilot/ai-sdk')>()),
  routeAutonomousToolCall,
}));

const { callAutonomousTool } = await import('./autonomous-tools.js');

const session = {} as EditorSession;
const render = null as RenderClient | null;
const analysis = null as AnalysisClient | null;

const ok = (text: string, structured?: unknown): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(structured === undefined ? {} : { structuredContent: structured }),
});

/** A name the projection actually advertises, so the support check passes. */
const ADVERTISED = 'inspect_project';

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: the latter clears recorded calls but leaves the
  // `mockResolvedValueOnce` queue intact, so an unconsumed value from one test answers
  // the first call of the next one.
  vi.resetAllMocks();
});

describe('callAutonomousTool — execution', () => {
  it('reports a routing failure as an honest error instead of throwing', async () => {
    // The model sent a capability we advertise with arguments the router rejects. That is
    // a message the model can act on, not a crash the host has to survive.
    routeAutonomousToolCall.mockImplementation(() => {
      throw new Error('Unsupported analyze_media kind "undefined".');
    });

    const result = await callAutonomousTool(session, render, {
      name: ADVERTISED,
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[autonomous_route_failed]');
    expect(result.content[0]?.text).toContain('Unsupported analyze_media kind');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('stringifies a non-Error throw rather than losing it', async () => {
    routeAutonomousToolCall.mockImplementation(() => {
      throw 'plain string';
    });

    const result = await callAutonomousTool(session, render, { name: ADVERTISED, arguments: {} });

    expect(result.content[0]?.text).toContain('plain string');
  });

  it('refuses a route that needs a host capability MCP does not expose', async () => {
    // Unreachable through a real capability today — the projection filters proposal and
    // verification tools out before this point. It is the guard that keeps that true if
    // the manifest gains one.
    routeAutonomousToolCall.mockReturnValue({ kind: 'proposal', calls: [] });

    const result = await callAutonomousTool(session, render, { name: ADVERTISED, arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[autonomous_tool_unavailable]');
  });

  it('passes a single registry call straight through, result unwrapped', async () => {
    routeAutonomousToolCall.mockReturnValue({
      kind: 'registry',
      calls: [{ name: 'get_project_state', arguments: { verbose: true } }],
    });
    callTool.mockResolvedValue(ok('project state', { fps: 30 }));

    const result = await callAutonomousTool(
      session,
      render,
      { name: ADVERTISED, arguments: {} },
      analysis,
    );

    // Threaded verbatim — a dropped render or analysis client is a capability that
    // silently stops working rather than failing.
    expect(callTool).toHaveBeenCalledWith(
      session,
      render,
      'get_project_state',
      { verbose: true },
      analysis,
    );
    expect(result).toEqual(ok('project state', { fps: 30 }));
  });

  it('stops at the first failing call and returns ITS error, not a summary', async () => {
    // The second call would run against state the first failed to produce. Continuing
    // would turn one legible failure into two, the second nonsensical.
    routeAutonomousToolCall.mockReturnValue({
      kind: 'registry',
      calls: [
        { name: 'first', arguments: {} },
        { name: 'second', arguments: {} },
      ],
    });
    callTool
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'boom' }], isError: true })
      .mockResolvedValueOnce(ok('never runs'));

    const result = await callAutonomousTool(session, render, { name: ADVERTISED, arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('boom');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('merges a multi-call route into one text body and a results array', async () => {
    routeAutonomousToolCall.mockReturnValue({
      kind: 'registry',
      calls: [
        { name: 'first', arguments: {} },
        { name: 'second', arguments: {} },
      ],
    });
    callTool
      .mockResolvedValueOnce(ok('first line', { a: 1 }))
      .mockResolvedValueOnce(ok('second line'));

    const result = await callAutonomousTool(session, render, { name: ADVERTISED, arguments: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('first line\nsecond line');
    // `null` for a call that returned no structured content, so position in the array
    // still lines up with position in the route.
    expect(result.structuredContent).toEqual({ results: [{ a: 1 }, null] });
  });
});
