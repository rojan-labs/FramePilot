/**
 * Staleness guard for the generated Python tool descriptions (plan/system-mission P2.3).
 *
 * WHY: `engine/python/.../ai_tools/tool_descriptions_generated.py` is what the sidecar's
 * registry reads, and Python cannot execute TypeScript to check it. Rebuild the module
 * from the live registry and fail if the committed file differs — the same rule as the
 * skills and tool-parity generators.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs generator, intentionally not part of the TS build.
import { OUT_PATH, renderModule } from '../scripts/generate-tool-descriptions.mjs';
import { TOOL_REGISTRY } from './tool-registry.js';

describe('generated Python tool descriptions', () => {
  it('are not stale — regenerate with `pnpm --filter @framepilot/ai-sdk build`', () => {
    const rebuilt = renderModule(TOOL_REGISTRY) as string;
    const committed = readFileSync(OUT_PATH as string, 'utf8');
    expect(committed).toBe(rebuilt);
  });

  it('carry every registered tool, verbatim', () => {
    const rendered = renderModule(TOOL_REGISTRY) as string;
    for (const tool of TOOL_REGISTRY) {
      expect(rendered).toContain(JSON.stringify(tool.name));
      expect(rendered).toContain(JSON.stringify(tool.description.trim()));
    }
  });
});
