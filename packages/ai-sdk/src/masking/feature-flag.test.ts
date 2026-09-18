import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import { MockProvider } from '../providers/mock.js';
import { DOMAIN_INDEX, LOADABLE_DOMAINS, domainIndexFor } from '../tool-domains.js';
import type { HostToolExecutor } from '../tool-executor.js';
import {
  AI_MASKING_TOOL_NAMES,
  aiMaskingEnabled,
  aiMaskingSetting,
  aiMaskingUnroutableTools,
} from './feature-flag.js';

const executor = (unroutable: readonly string[]): HostToolExecutor => ({
  run: async (call) => ({ status: 'completed', summary: call.name }),
  unroutableTools: () => new Set(unroutable),
});

const everyDomain = new Set(LOADABLE_DOMAINS);
const offered = (unroutable: readonly string[]) =>
  new Orchestrator(new MockProvider(), { executor: executor(unroutable) }).agentTools(
    'agent',
    undefined,
    everyDomain,
  );

describe('aiMaskingSetting (RD2.1)', () => {
  it('is on in development and OFF in a release until the default is flipped', () => {
    expect(aiMaskingSetting({ development: true })).toBe('on');
    expect(aiMaskingSetting({ development: false })).toBe('off');
  });

  it('lets an explicit on or off win in either build', () => {
    expect(aiMaskingSetting({ explicit: 'off', development: true })).toBe('off');
    expect(aiMaskingSetting({ explicit: ' ON ', development: false })).toBe('on');
  });

  it('never lets a typo enable the tools in a release', () => {
    for (const explicit of ['true', '1', 'yes', 'enabled', '']) {
      expect(aiMaskingEnabled({ explicit, development: false })).toBe(false);
      expect(aiMaskingEnabled({ explicit, development: true })).toBe(true);
    }
  });
});

describe('the kill switch, end to end', () => {
  const off = aiMaskingUnroutableTools({ explicit: 'off', development: true });

  it('removes every new masking tool from what the model is offered', () => {
    expect(aiMaskingUnroutableTools({ development: true })).toEqual([]);
    expect(off).toEqual(AI_MASKING_TOOL_NAMES);
    expect(off).toEqual(
      expect.arrayContaining([
        'find_mask_targets',
        'create_mask',
        'remove_background',
        'refine_mask',
        'follow_subject',
      ]),
    );
    const names = offered(off).map((tool) => tool.name);
    for (const name of AI_MASKING_TOOL_NAMES) expect(names).not.toContain(name);
    expect(offered([]).map((tool) => tool.name)).toContain('create_mask');
  });

  it('does not take the two older tools the domain absorbed with it', () => {
    const names = offered(off).map((tool) => tool.name);
    expect(names).toContain('professional_tracking_mask');
    expect(names).toContain('track_subject_automatically');
    expect(off).not.toContain('professional_tracking_mask');
  });

  it('stops the domain index promising what no offered tool can do', () => {
    const description = offered(off).find((tool) => tool.name === 'load_tools')!.description;
    expect(description).not.toContain('remove backgrounds');
    expect(description).toContain('masking: make a mask the editor drew follow its subject');
    expect(offered([]).find((tool) => tool.name === 'load_tools')!.description).toContain(
      'remove backgrounds',
    );
  });

  it('leaves a domain out of the index when none of its tools can be offered', () => {
    const index = domainIndexFor(
      new Set([
        ...AI_MASKING_TOOL_NAMES,
        'professional_tracking_mask',
        'track_subject_automatically',
      ]),
    );
    expect(index).not.toContain('masking:');
    expect(index).toContain('captions:');
  });

  it('changes nothing when nothing is unroutable, so the token goldens cannot move', () => {
    expect(domainIndexFor(new Set())).toBe(DOMAIN_INDEX);
    expect(domainIndexFor(new Set(['render_preview']))).toBe(DOMAIN_INDEX);
  });
});
