import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AUTONOMOUS_TOOL_MANIFEST } from './autonomous-tool-contract.js';

interface Mirror {
  readonly version: number;
  readonly tools: readonly {
    readonly name: string;
    readonly stages: readonly string[];
    readonly status: string;
    readonly kind: string;
    readonly internalRoutes: readonly string[];
  }[];
}

function routingIndex(): Mirror {
  return {
    version: AUTONOMOUS_TOOL_MANIFEST.version,
    tools: AUTONOMOUS_TOOL_MANIFEST.tools.map(({ name, stages, status, kind, internalRoutes }) => ({
      name,
      stages,
      status,
      kind,
      internalRoutes,
    })),
  };
}

describe('generated Python autonomous tool mirror', () => {
  it('matches the canonical TypeScript manifest routing metadata', async () => {
    const pythonUrl = new URL(
      '../../../engine/python/framepilot_engine/ai_tools/autonomous_contract.py',
      import.meta.url,
    );
    const source = await readFile(pythonUrl, 'utf8');
    const match = source.match(/AUTONOMOUS_TOOL_INDEX_JSON = r'''([\s\S]*?)'''/);
    expect(match?.[1]).toBeDefined();
    const mirror = JSON.parse(match![1]!) as Mirror;

    expect(mirror).toEqual(routingIndex());
  });
});
