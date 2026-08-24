/**
 * Browser AI-config storage tests: provider readiness, media intelligence,
 * migration of retired settings, and corrupt-storage tolerance.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BASE_URL_PROVIDERS,
  REAL_PROVIDERS,
  applyBrowserUpdate,
  loadBrowserAiConfig,
  toAiConfig,
} from './aiConfigStorage.js';

describe('aiConfigStorage', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to mock with no keys', () => {
    const config = toAiConfig(loadBrowserAiConfig());
    expect(config.activeProvider).toBe('mock');
    expect(config.providers.find((provider) => provider.name === 'anthropic')?.ready).toBe(false);
  });

  it('saves and clears a key and reflects ready state', () => {
    applyBrowserUpdate({ activeProvider: 'anthropic', keys: { anthropic: 'sk-1' } });
    let config = toAiConfig(loadBrowserAiConfig());
    expect(config.activeProvider).toBe('anthropic');
    expect(config.providers.find((provider) => provider.name === 'anthropic')?.ready).toBe(true);
    expect(loadBrowserAiConfig().keys.anthropic).toBe('sk-1');

    applyBrowserUpdate({ keys: { anthropic: null } });
    config = toAiConfig(loadBrowserAiConfig());
    expect(config.providers.find((provider) => provider.name === 'anthropic')?.ready).toBe(false);
  });

  it('surfaces hosted chat providers independently from the STT roster', () => {
    const config = toAiConfig(loadBrowserAiConfig());
    expect(config.providers.find((provider) => provider.name === 'openrouter')).toMatchObject({
      model: 'openai/gpt-4o-mini',
      ready: false,
    });
    expect(config.providers.find((provider) => provider.name === 'deepseek')).toMatchObject({
      model: 'deepseek-chat',
      ready: false,
    });
    expect(config.providers.find((provider) => provider.name === 'google')).toMatchObject({
      model: 'gemini-2.5-flash',
      ready: false,
    });

    applyBrowserUpdate({
      keys: { openrouter: 'sk-or-1', deepseek: 'sk-ds-1', google: 'AIza-1' },
    });
    const ready = toAiConfig(loadBrowserAiConfig());
    expect(ready.providers.find((provider) => provider.name === 'openrouter')?.ready).toBe(true);
    expect(ready.providers.find((provider) => provider.name === 'deepseek')?.ready).toBe(true);
    expect(ready.providers.find((provider) => provider.name === 'google')?.ready).toBe(true);
  });

  it('overrides the model and restores the default on empty', () => {
    applyBrowserUpdate({ models: { nvidia: 'custom-model' } });
    expect(
      toAiConfig(loadBrowserAiConfig()).providers.find((provider) => provider.name === 'nvidia')
        ?.model,
    ).toBe('custom-model');
    applyBrowserUpdate({ models: { nvidia: '' } });
    expect(
      toAiConfig(loadBrowserAiConfig()).providers.find((provider) => provider.name === 'nvidia')
        ?.model,
    ).toBe('meta/llama-3.1-70b-instruct');
  });

  it('tolerates corrupt storage', () => {
    localStorage.setItem('framepilot.aiConfig', '{ broken');
    expect(loadBrowserAiConfig().activeProvider).toBe('mock');
  });

  describe('openai-compatible (a server the user supplies)', () => {
    it('is not ready until a server URL is configured', () => {
      // Unlike Ollama it has no default endpoint, so "keyless" does not mean "usable":
      // reporting it ready would put a provider in the picker that fails on first call.
      const before = toAiConfig(loadBrowserAiConfig()).providers.find(
        (provider) => provider.name === 'openai-compatible',
      );
      expect(before?.ready).toBe(false);

      applyBrowserUpdate({ baseUrls: { 'openai-compatible': 'http://127.0.0.1:8317/v1' } });
      const after = toAiConfig(loadBrowserAiConfig()).providers.find(
        (provider) => provider.name === 'openai-compatible',
      );
      expect(after?.ready).toBe(true);
      expect(after?.baseUrl).toBe('http://127.0.0.1:8317/v1');
    });

    it('stays ready with no key, and keeps one when the server wants it', () => {
      applyBrowserUpdate({ baseUrls: { 'openai-compatible': 'http://localhost:1234/v1' } });
      applyBrowserUpdate({ keys: { 'openai-compatible': 'gateway-key' } });
      expect(loadBrowserAiConfig().keys['openai-compatible']).toBe('gateway-key');
      expect(
        toAiConfig(loadBrowserAiConfig()).providers.find(
          (provider) => provider.name === 'openai-compatible',
        )?.ready,
      ).toBe(true);
    });

    it('is offered as a selectable provider', () => {
      expect(REAL_PROVIDERS).toContain('openai-compatible');
      expect(BASE_URL_PROVIDERS).toContain('openai-compatible');
    });
  });

  describe('ollama (local, keyless, configurable URL)', () => {
    it('is ready without a key and defaults to the local model', () => {
      const ollama = toAiConfig(loadBrowserAiConfig()).providers.find(
        (provider) => provider.name === 'ollama',
      );
      expect(ollama?.ready).toBe(true);
      expect(ollama?.model).toBe('llama3.2');
    });

    it('saves and clears the base URL', () => {
      applyBrowserUpdate({ baseUrls: { ollama: 'http://box:11434/v1' } });
      expect(loadBrowserAiConfig().baseUrls.ollama).toBe('http://box:11434/v1');
      expect(
        toAiConfig(loadBrowserAiConfig()).providers.find((provider) => provider.name === 'ollama')
          ?.baseUrl,
      ).toBe('http://box:11434/v1');
      applyBrowserUpdate({ baseUrls: { ollama: '' } });
      expect(loadBrowserAiConfig().baseUrls.ollama).toBeUndefined();
    });

    it('keeps an optional proxy key without changing readiness', () => {
      applyBrowserUpdate({ keys: { ollama: 'proxy-secret' } });
      expect(loadBrowserAiConfig().keys.ollama).toBe('proxy-secret');
      expect(
        toAiConfig(loadBrowserAiConfig()).providers.find((provider) => provider.name === 'ollama')
          ?.ready,
      ).toBe(true);
    });
  });

  describe('media intelligence', () => {
    it('is unconfigured by default and eager import warming defaults on', () => {
      const config = toAiConfig(loadBrowserAiConfig());
      expect(config.nvidiaEmbeddings).toBeUndefined();
      expect(config.twelveLabs).toBeUndefined();
      expect(config.embeddingsAutoIndex).toBe(true);
    });

    it('round-trips NVIDIA indexing keys without touching the chat key', () => {
      applyBrowserUpdate({ nvidiaEmbeddings: 'nvapi-1, nvapi-2' });
      expect(loadBrowserAiConfig().nvidiaEmbeddings).toBe('nvapi-1, nvapi-2');
      expect(toAiConfig(loadBrowserAiConfig()).nvidiaEmbeddings).toBe('nvapi-1, nvapi-2');
      expect(loadBrowserAiConfig().keys.nvidia).toBeUndefined();
    });

    it('clears NVIDIA indexing keys with null or whitespace', () => {
      applyBrowserUpdate({ nvidiaEmbeddings: 'nvapi-1' });
      applyBrowserUpdate({ nvidiaEmbeddings: null });
      expect(loadBrowserAiConfig().nvidiaEmbeddings).toBeUndefined();
      applyBrowserUpdate({ nvidiaEmbeddings: 'nvapi-2' });
      applyBrowserUpdate({ nvidiaEmbeddings: '  ' });
      expect(loadBrowserAiConfig().nvidiaEmbeddings).toBeUndefined();
    });

    it('round-trips and clears the shared TwelveLabs key', () => {
      applyBrowserUpdate({ twelveLabs: 'tlk-secret' });
      expect(loadBrowserAiConfig().twelveLabs).toBe('tlk-secret');
      expect(toAiConfig(loadBrowserAiConfig()).twelveLabs).toBe('tlk-secret');
      applyBrowserUpdate({ twelveLabs: null });
      expect(loadBrowserAiConfig().twelveLabs).toBeUndefined();
      applyBrowserUpdate({ twelveLabs: 'tlk-2' });
      applyBrowserUpdate({ twelveLabs: '   ' });
      expect(loadBrowserAiConfig().twelveLabs).toBeUndefined();
    });

    it('persists the optional eager import-warming preference', () => {
      applyBrowserUpdate({ embeddingsAutoIndex: false });
      expect(loadBrowserAiConfig().embeddingsAutoIndex).toBe(false);
      expect(toAiConfig(loadBrowserAiConfig()).embeddingsAutoIndex).toBe(false);
      applyBrowserUpdate({ embeddingsAutoIndex: true });
      expect(toAiConfig(loadBrowserAiConfig()).embeddingsAutoIndex).toBe(true);
    });

    it('ignores the retired visual-caption-provider setting on load and update', () => {
      localStorage.setItem(
        'framepilot.aiConfig',
        JSON.stringify({
          activeProvider: 'anthropic',
          keys: {},
          models: {},
          baseUrls: {},
          visualCaptionProvider: 'nvidia',
        }),
      );
      const loaded = loadBrowserAiConfig();
      expect(loaded).not.toHaveProperty('visualCaptionProvider');
      expect(toAiConfig(loaded)).not.toHaveProperty('visualCaptionProvider');

      applyBrowserUpdate({ visualCaptionProvider: 'google' });
      expect(loadBrowserAiConfig()).not.toHaveProperty('visualCaptionProvider');
    });
  });

  describe('speech-to-text migration', () => {
    it('keeps Local and TwelveLabs choices', () => {
      applyBrowserUpdate({ asrProvider: 'twelvelabs' });
      expect(loadBrowserAiConfig().asrProvider).toBe('twelvelabs');
      expect(toAiConfig(loadBrowserAiConfig()).asrProvider).toBe('twelvelabs');
      applyBrowserUpdate({ asrProvider: 'whisper-cli' });
      expect(loadBrowserAiConfig().asrProvider).toBe('whisper-cli');
    });

    it('migrates Groq, NVIDIA, and unknown provider values to Local', () => {
      applyBrowserUpdate({ asrProvider: 'nvidia' });
      expect(loadBrowserAiConfig().asrProvider).toBe('whisper-cli');
      applyBrowserUpdate({ asrProvider: 'groq' });
      expect(loadBrowserAiConfig().asrProvider).toBe('whisper-cli');
      applyBrowserUpdate({ asrProvider: 'bogus' as never });
      expect(loadBrowserAiConfig().asrProvider).toBe('whisper-cli');

      localStorage.setItem(
        'framepilot.aiConfig',
        JSON.stringify({
          activeProvider: 'mock',
          keys: {},
          models: {},
          baseUrls: {},
          asrProvider: 'nvidia',
        }),
      );
      expect(loadBrowserAiConfig().asrProvider).toBe('whisper-cli');
    });

    it('retains the legacy key in-session but never persists it to storage', () => {
      const updated = applyBrowserUpdate({ asrApiKey: 'legacy-key', asrModel: 'legacy-model' });
      // Old callers keep reading the key within the session that set it…
      expect(updated.asrApiKey).toBe('legacy-key');
      expect(updated.asrModel).toBe('legacy-model');
      // …but only the non-secret model field survives a reload: the key must
      // never land in localStorage in clear text (CodeQL alert #60).
      const raw = JSON.parse(localStorage.getItem('framepilot.aiConfig') ?? '{}') as Record<
        string,
        unknown
      >;
      expect(raw).not.toHaveProperty('asrApiKey');
      expect(raw.asrModel).toBe('legacy-model');
      const loaded = loadBrowserAiConfig();
      expect(loaded).not.toHaveProperty('asrApiKey');
      expect(toAiConfig(loaded)).not.toHaveProperty('asrApiKey');
      applyBrowserUpdate({ asrApiKey: null, asrModel: null });
      expect(loadBrowserAiConfig().asrApiKey).toBeUndefined();
      expect(loadBrowserAiConfig().asrModel).toBeUndefined();
      applyBrowserUpdate({ asrApiKey: 'x', asrModel: 'x' });
      expect(loadBrowserAiConfig().asrModel).toBe('x');
      applyBrowserUpdate({ asrApiKey: '  ', asrModel: '  ' });
      expect(loadBrowserAiConfig().asrApiKey).toBeUndefined();
      expect(loadBrowserAiConfig().asrModel).toBeUndefined();
    });
  });
});
