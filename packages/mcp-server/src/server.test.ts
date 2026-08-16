import { describe, expect, it } from 'vitest';
import type { EditorSession } from './session.js';
import { INSTRUCTIONS, createServer } from './server.js';

/**
 * `server.ts` is transport glue (excluded from coverage), but the top-level MCP
 * `instructions` it passes are the primary, model-facing fix for the reported
 * bypass — so we assert they are wired and say the load-bearing things.
 */
describe('createServer — MCP instructions', () => {
  const server = createServer({
    session: {} as EditorSession,
    renderClient: null,
    analysisClient: null,
  });

  it('constructs the Server WITH the top-level instructions', () => {
    // The SDK stores the option privately and echoes it in `initialize`.
    expect((server as unknown as { _instructions?: string })._instructions).toBe(INSTRUCTIONS);
  });

  it('steers the agent onto the tools and away from direct file edits', () => {
    expect(INSTRUCTIONS).toContain('get_project_state');
    expect(INSTRUCTIONS).toContain('save_project');
    expect(INSTRUCTIONS).toMatch(/do NOT/i);
    expect(INSTRUCTIONS).toContain('project.fp.json');
  });
});
