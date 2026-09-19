import { describe, expect, it } from 'vitest';
import { AI_MASKING_TOOL_NAMES, MockProvider, Orchestrator } from '@framepilot/ai-sdk';
import { AI_MASKING_ENV_VAR, desktopAiMaskingDisabledTools } from './ai-masking-switch.js';

describe('desktopAiMaskingDisabledTools (RD2.1)', () => {
  it('is on unpackaged and off in a packaged release until RD3', () => {
    expect(desktopAiMaskingDisabledTools({ env: {}, packaged: false })).toEqual([]);
    expect(desktopAiMaskingDisabledTools({ env: {}, packaged: true })).toEqual(
      AI_MASKING_TOOL_NAMES,
    );
  });

  it('lets the variable force either way, and ignores a typo', () => {
    const packaged = (value: string) =>
      desktopAiMaskingDisabledTools({ env: { [AI_MASKING_ENV_VAR]: value }, packaged: true });
    expect(packaged('on')).toEqual([]);
    expect(packaged('yes')).toEqual(AI_MASKING_TOOL_NAMES);
    expect(
      desktopAiMaskingDisabledTools({ env: { [AI_MASKING_ENV_VAR]: 'off' }, packaged: false }),
    ).toEqual(AI_MASKING_TOOL_NAMES);
  });

  it('reads the environment on every call, so support can switch a running build off', () => {
    const env: Record<string, string | undefined> = {};
    const source = { env, packaged: false };
    const orchestrator = new Orchestrator(new MockProvider(), {
      disabledTools: () => desktopAiMaskingDisabledTools(source),
    });
    // With the masking domain pinned, so "not offered" is the switch and not progressive
    // disclosure.
    const offered = () =>
      orchestrator
        .agentTools('agent', undefined, new Set(['masking']) as never)
        .map((tool) => tool.name);
    const loadTools = () =>
      orchestrator.agentTools('agent').find((tool) => tool.name === 'load_tools')!.description;
    expect(loadTools()).toContain('remove backgrounds');
    expect(offered()).toContain('create_mask');
    env[AI_MASKING_ENV_VAR] = 'off';
    expect(loadTools()).not.toContain('remove backgrounds');
    expect(offered()).not.toContain('create_mask');
    env[AI_MASKING_ENV_VAR] = 'on';
    expect(loadTools()).toContain('remove backgrounds');
  });
});
