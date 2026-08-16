import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from './model-capabilities.js';
import { MODEL_CATALOG } from './model-catalog.generated.js';
import { PROVIDER_NAMES } from './types.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('capabilitiesFor', () => {
  it('reports the real window for a known model, not the legacy 190K constant', () => {
    const opus = capabilitiesFor('anthropic', 'claude-opus-4-8');
    expect(opus).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      source: 'known_model',
    });
    expect(opus.contextWindow).not.toBe(190_000);
  });

  it('distinguishes models within one provider, so a model switch moves the capacity', () => {
    const opus = capabilitiesFor('anthropic', 'claude-opus-4-8');
    const haiku = capabilitiesFor('anthropic', 'claude-haiku-4-5');
    expect(haiku.contextWindow).toBe(200_000);
    expect(haiku.contextWindow).toBeLessThan(opus.contextWindow);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(capabilitiesFor('anthropic', '  CLAUDE-Opus-4-8 ')).toEqual(
      capabilitiesFor('anthropic', 'claude-opus-4-8'),
    );
  });

  it('drops an Ollama tag suffix before matching', () => {
    expect(capabilitiesFor('ollama', 'llama3.2:3b')).toMatchObject({
      contextWindow: 131_072,
      source: 'known_model',
    });
  });

  it('matches the configured GLM id without requiring its catalog vendor prefix', () => {
    const expected = {
      contextWindow: 200_000,
      maxOutputTokens: 131_072,
      source: 'known_model',
    };
    expect(capabilitiesFor('ollama', 'glm-5v-turbo')).toEqual(expected);
    expect(capabilitiesFor('openrouter', 'zhipuai/glm-5v-turbo')).toEqual(expected);
  });

  it('resolves a suffixed id to its base model by longest prefix', () => {
    expect(capabilitiesFor('anthropic', 'claude-opus-4-8-20260101')).toMatchObject({
      contextWindow: 1_000_000,
      source: 'known_model',
    });
  });

  it('prefers the longest matching prefix over a shorter one', () => {
    // `claude-opus-4-5` (200K) and `claude-opus-4-8` (1M) share the `claude-opus-4-` stem;
    // a variant of 4-5 must not inherit 4-8's much larger window.
    expect(capabilitiesFor('anthropic', 'claude-opus-4-5-preview').contextWindow).toBe(200_000);
  });

  it('keeps the longest match when a THIRD, even longer prefix also matches', () => {
    // `minimax-m2`, `minimax-m2.5` and `minimax-m2.5-highspeed` are all real catalog
    // ids and each is a prefix of the next — a suffixed id matches all three, so
    // `longestPrefixMatch` has to keep replacing its current best rather than
    // stopping at the first (or second) hit.
    expect(capabilitiesFor('anthropic', 'minimax-m2.5-highspeed-preview')).toMatchObject({
      contextWindow: 204_800, // minimax-m2.5-highspeed's window, not minimax-m2's 196_608
      source: 'known_model',
    });
  });

  it('falls back to the provider floor for an unknown model and labels it as such', () => {
    const unknown = capabilitiesFor('groq', 'some-unreleased-model');
    expect(unknown.source).toBe('provider_default');
    expect(unknown.contextWindow).toBe(131_072);
  });

  it('falls back conservatively when the provider itself is unknown', () => {
    const none = capabilitiesFor(undefined, undefined);
    expect(none).toEqual({
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      source: 'provider_default',
    });
  });

  it('never returns a zero or negative capacity for any provider', () => {
    for (const provider of PROVIDER_NAMES) {
      const caps = capabilitiesFor(provider, undefined);
      expect(caps.contextWindow).toBeGreaterThan(0);
      expect(caps.maxOutputTokens).toBeGreaterThan(0);
      // The reservation must leave room for a prompt, or the budget collapses to nothing.
      expect(caps.maxOutputTokens).toBeLessThan(caps.contextWindow);
    }
  });

  it('treats an empty model id as unknown rather than matching every prefix', () => {
    expect(capabilitiesFor('anthropic', '   ').source).toBe('provider_default');
  });

  it('covers the whole vendored catalog, not just the ids someone hand-typed', () => {
    // The point of generating from models.dev: a model the host can select is known.
    expect(Object.keys(MODEL_CATALOG).length).toBeGreaterThan(200);
    for (const model of [
      'grok-4.1',
      'kimi-k2-thinking',
      'gpt-5.1-codex',
      'gemini-3-pro',
    ] as const) {
      if (!(model in MODEL_CATALOG)) continue; // catalog refreshes may rename; skip, don't fail
      expect(capabilitiesFor('openrouter', model).source).toBe('known_model');
    }
  });

  it('ignores the vendor prefix so a prefixed and a bare id agree', () => {
    // Same model, three deployments: models.dev id, host-configured bare id, tagged variant.
    const bare = capabilitiesFor('openrouter', 'glm-5v-turbo');
    expect(capabilitiesFor('openrouter', 'zhipuai/glm-5v-turbo')).toEqual(bare);
    expect(capabilitiesFor('ollama', 'zhipuai/glm-5v-turbo:free')).toEqual(bare);
    expect(bare.source).toBe('known_model');
  });

  it('keeps prompt room when a catalog entry reserves the entire window for output', () => {
    // models.dev lists both figures as theoretical maxima, not a split of one budget.
    const caps = capabilitiesFor('openrouter', 'mistralai/mistral-large-latest');
    expect(caps.contextWindow).toBe(262_144);
    expect(caps.maxOutputTokens).toBe(131_072);
  });

  it('substitutes the provider floor when the catalog documents no output ceiling', () => {
    const caps = capabilitiesFor('nvidia', 'sakana/fugu');
    expect(caps.source).toBe('known_model');
    expect(caps.maxOutputTokens).toBe(4_096); // the nvidia floor, not an invented number
  });

  it('leaves every known model room for both a prompt and a reply', () => {
    for (const model of Object.keys(MODEL_CATALOG)) {
      const caps = capabilitiesFor('openrouter', model);
      expect(caps.contextWindow).toBeGreaterThan(0);
      expect(caps.maxOutputTokens).toBeGreaterThan(0);
      expect(caps.maxOutputTokens).toBeLessThan(caps.contextWindow);
    }
  });
});

describe('model-catalog.generated.ts', () => {
  it('is in sync with the vendored models.json', async () => {
    // Mirrors the skills generator contract: the committed module is the build output,
    // so a catalog refresh without a regenerate must fail here rather than ship stale.
    const { renderCatalogModule } = await import('../../scripts/generate-model-capabilities.mjs');
    const committed = readFileSync(
      join(pkgRoot, 'src/providers/model-catalog.generated.ts'),
      'utf8',
    );
    expect(committed).toBe(renderCatalogModule());
  });
});
