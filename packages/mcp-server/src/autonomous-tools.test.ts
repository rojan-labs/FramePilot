import { describe, expect, it } from 'vitest';
import type { AnalysisClient } from './analysis-client.js';
import {
  AUTONOMOUS_MCP_TOOL_NAMES,
  buildAutonomousMcpTools,
  callAutonomousTool,
} from './autonomous-tools.js';
import type { RenderClient } from './render-client.js';
import type { EditorSession } from './session.js';

describe('canonical autonomous MCP projection', () => {
  it('is deterministic and excludes host capabilities MCP cannot complete', () => {
    const tools = buildAutonomousMcpTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([...names].sort());
    expect(names).toEqual(AUTONOMOUS_MCP_TOOL_NAMES);
    expect(names).not.toContain('ask_user');
    expect(names).not.toContain('propose_timeline_patch');
    expect(names).not.toContain('propose_project_patch');
    expect(names).not.toContain('verify_result');
    expect(names).not.toContain('index_media');
    expect(names).toContain('inspect_project');
    expect(names).toContain('search_media');
    expect(names).toContain('analyze_media');
  });

  it('reuses canonical descriptions and object schemas', () => {
    for (const tool of buildAutonomousMcpTools()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('returns an honest error for a non-advertised autonomous capability', async () => {
    const result = await callAutonomousTool(
      {} as EditorSession,
      null as RenderClient | null,
      {
        name: 'propose_timeline_patch',
        arguments: {
          reason: 'Trim',
          operations: [
            { tool: 'trim_clip', arguments: { clipId: 'clip-a', start: 0, end: 1 } },
          ],
        },
      },
      null as AnalysisClient | null,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('autonomous_tool_unavailable');
  });
});
