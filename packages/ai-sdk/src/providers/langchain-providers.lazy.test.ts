import { describe, expect, it, vi } from 'vitest';
import type { AiProvider, ProviderChunk, ProviderConfig } from './types.js';

/**
 * Each hosted adapter lives in its own dynamic chunk, so selecting one provider must
 * not pull the other SDKs in. These counters record which concrete module the roster
 * actually imported; a shared chunk would light up more than one.
 */
const loads = vi.hoisted(() => ({
  deepseek: 0,
  groq: 0,
  google: 0,
  ollama: 0,
  openaiCompatible: 0,
}));

/** A concrete stand-in whose `complete` echoes the provider that answered. */
const fake = (name: string, streams = true) =>
  class implements AiProvider {
    readonly name = name as AiProvider['name'];
    readonly modelId = `${name}-test`;
    constructor(_config: ProviderConfig) {}
    async complete(): Promise<{ text: string }> {
      return { text: name };
    }
    stream = streams
      ? async function* (): AsyncIterable<ProviderChunk> {
          yield { text: name } as ProviderChunk;
        }
      : undefined;
  };

vi.mock('./langchain-deepseek.js', () => {
  loads.deepseek += 1;
  return { ConcreteLangChainDeepSeekProvider: fake('deepseek') };
});

vi.mock('./langchain-groq.js', () => {
  loads.groq += 1;
  // No `stream` — proves the roster reports an unstreamable provider honestly
  // instead of yielding nothing.
  return { ConcreteLangChainGroqProvider: fake('groq', false) };
});

vi.mock('./langchain-google.js', () => {
  loads.google += 1;
  return { ConcreteLangChainGoogleProvider: fake('google') };
});

vi.mock('./langchain-ollama.js', () => {
  loads.ollama += 1;
  return { ConcreteLangChainOllamaProvider: fake('ollama') };
});

vi.mock('./langchain-openai-compatible.js', () => {
  loads.openaiCompatible += 1;
  return {
    ConcreteLangChainOpenRouterProvider: fake('openrouter'),
    ConcreteLangChainNvidiaProvider: fake('nvidia'),
    ConcreteLangChainOpenAiCompatibleProvider: fake('openai-compatible'),
  };
});

import {
  LANGCHAIN_PROVIDERS,
  LangChainDeepSeekProvider,
  LangChainGoogleProvider,
  LangChainGroqProvider,
  LangChainNvidiaProvider,
  LangChainOllamaProvider,
  LangChainOpenAiCompatibleProvider,
  LangChainOpenRouterProvider,
} from './langchain-providers.js';

describe('lazy provider roster', () => {
  it('resolves model ids without importing a hosted SDK module', () => {
    const deepseek = new LangChainDeepSeekProvider({ name: 'deepseek', model: 'custom' });
    const groq = new LangChainGroqProvider({ name: 'groq' });
    expect(deepseek.modelId).toBe('custom');
    expect(groq.modelId.length).toBeGreaterThan(0);
    // Every roster entry must answer `modelId` from the defaults table alone.
    for (const Provider of Object.values(LANGCHAIN_PROVIDERS)) {
      expect(new Provider({ name: 'x' as ProviderConfig['name'] }).modelId.length).toBeGreaterThan(
        0,
      );
    }
    expect(loads).toEqual({
      deepseek: 0,
      groq: 0,
      google: 0,
      ollama: 0,
      openaiCompatible: 0,
    });
  });

  it('loads only the concrete provider selected by the first call', async () => {
    const deepseek = new LangChainDeepSeekProvider({ name: 'deepseek' });
    await expect(deepseek.complete({ messages: [] })).resolves.toEqual({ text: 'deepseek' });
    expect(loads.deepseek).toBe(1);
    expect(loads.groq).toBe(0);
    expect(loads.google).toBe(0);
    expect(loads.ollama).toBe(0);
    expect(loads.openaiCompatible).toBe(0);
  });

  it('memoizes the concrete provider across repeated calls', async () => {
    const google = new LangChainGoogleProvider({ name: 'google' });
    await google.complete({ messages: [] });
    await google.complete({ messages: [] });
    expect(loads.google).toBe(1);
  });

  it('routes each roster entry to its own chunk', async () => {
    const ollama = new LangChainOllamaProvider({ name: 'ollama' });
    await expect(ollama.complete({ messages: [] })).resolves.toEqual({ text: 'ollama' });
    expect(loads.ollama).toBe(1);

    // OpenRouter and NVIDIA deliberately share the OpenAI-compatible client.
    const openrouter = new LangChainOpenRouterProvider({ name: 'openrouter' });
    const nvidia = new LangChainNvidiaProvider({ name: 'nvidia' });
    await expect(openrouter.complete({ messages: [] })).resolves.toEqual({ text: 'openrouter' });
    await expect(nvidia.complete({ messages: [] })).resolves.toEqual({ text: 'nvidia' });
    expect(loads.openaiCompatible).toBe(1);

    // …as does the generic one, which is the same client with the endpoint supplied.
    const custom = new LangChainOpenAiCompatibleProvider({
      name: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8317/v1',
    });
    await expect(custom.complete({ messages: [] })).resolves.toEqual({
      text: 'openai-compatible',
    });
    expect(loads.openaiCompatible).toBe(1);
  });

  it('streams through the lazily loaded provider', async () => {
    const deepseek = new LangChainDeepSeekProvider({ name: 'deepseek' });
    const chunks: ProviderChunk[] = [];
    for await (const chunk of deepseek.stream({ messages: [] })) chunks.push(chunk);
    expect(chunks).toEqual([{ text: 'deepseek' }]);
  });

  it('reports a provider that cannot stream instead of yielding nothing', async () => {
    const groq = new LangChainGroqProvider({ name: 'groq' });
    await expect(async () => {
      for await (const _chunk of groq.stream({ messages: [] })) void _chunk;
    }).rejects.toThrow('Provider "groq" cannot stream.');
  });
});
