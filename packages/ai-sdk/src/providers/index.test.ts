/**
 * Tests for the per-tier provider resolution behind `FRAMEPILOT_TIER_*`
 * (goal.md Workstream E).
 *
 * The contract that matters most is the OPT-IN one: with neither variable set for a tier
 * there must be no entry at all, because an entry is what makes a run stop using the
 * host-selected provider — and the golden-eval baseline is only comparable while an
 * unconfigured install behaves byte-identically.
 */
import { describe, expect, it } from 'vitest';
import { resolveTierProviderConfigs } from './index.js';
import type { ModelTier } from '../kernel/proposers/types.js';

type Env = Record<string, string | undefined>;

describe('resolveTierProviderConfigs', () => {
  const cases: readonly {
    readonly name: string;
    readonly env: Env;
    readonly expected: Partial<Record<ModelTier, { name: string; model?: string }>>;
  }[] = [
    { name: 'nothing set → no tier is overridden', env: {}, expected: {} },
    {
      name: 'blank values are treated as unset (a template `.env` overrides nothing)',
      env: { FRAMEPILOT_TIER_SMALL_PROVIDER: '', FRAMEPILOT_TIER_SMALL_MODEL: '  ' },
      expected: {},
    },
    {
      name: 'provider only → that provider, its own default model',
      env: { FRAMEPILOT_TIER_SMALL_PROVIDER: 'groq' },
      expected: { small: { name: 'groq' } },
    },
    {
      name: 'model only → the base provider, the overridden model',
      env: { FRAMEPILOT_TIER_SMALL_MODEL: 'claude-haiku-4-5' },
      expected: { small: { name: 'anthropic', model: 'claude-haiku-4-5' } },
    },
    {
      name: 'both → the overridden provider and model',
      env: {
        FRAMEPILOT_TIER_SMALL_PROVIDER: 'groq',
        FRAMEPILOT_TIER_SMALL_MODEL: 'llama-3.1-8b-instant',
      },
      expected: { small: { name: 'groq', model: 'llama-3.1-8b-instant' } },
    },
    {
      name: 'each tier resolves independently',
      env: {
        FRAMEPILOT_TIER_SMALL_PROVIDER: 'groq',
        FRAMEPILOT_TIER_LARGE_MODEL: 'claude-opus-4-8',
      },
      expected: {
        small: { name: 'groq' },
        large: { name: 'anthropic', model: 'claude-opus-4-8' },
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const configs = resolveTierProviderConfigs('anthropic', testCase.env);
      expect(Object.keys(configs).sort()).toEqual(Object.keys(testCase.expected).sort());
      for (const [tier, want] of Object.entries(testCase.expected)) {
        const got = configs[tier as ModelTier];
        expect(got?.name).toBe(want.name);
        if (want.model !== undefined) expect(got?.model).toBe(want.model);
      }
    });
  }

  it('names the offending variable when the provider is not a known one', () => {
    expect(() =>
      resolveTierProviderConfigs('anthropic', { FRAMEPILOT_TIER_MID_PROVIDER: 'gpt-9' }),
    ).toThrow(/FRAMEPILOT_TIER_MID_PROVIDER="gpt-9" is not a known provider/);
  });
});
