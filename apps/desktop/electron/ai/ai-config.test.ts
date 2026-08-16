/**
 * AiConfigStore tests: round-trip read/write, key save/clear, model override, the
 * secret-free projection, env fallback, and corrupt-file tolerance.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiConfigStore } from './ai-config.js';

describe('AiConfigStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fp-aicfg-'));
    file = join(dir, 'ai-config.json');
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['NVIDIA_API_KEY'];
    delete process.env['OLLAMA_BASE_URL'];
    delete process.env['FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS'];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to NVIDIA (a real provider) with no keys when the file is absent', () => {
    const store = new AiConfigStore(file);
    const config = store.toAiConfig();
    expect(config.activeProvider).toBe('nvidia');
    const anthropic = config.providers.find((p) => p.name === 'anthropic');
    expect(anthropic?.ready).toBe(false);
    // The mock is a test/dev-only backend — never surfaced in the picker.
    expect(config.providers.find((p) => p.name === 'mock')).toBeUndefined();
    expect(config.providers.find((p) => p.name === 'nvidia')?.ready).toBe(false);
  });

  it('saves a key + model and reports the provider ready without leaking the key', () => {
    const store = new AiConfigStore(file);
    const config = store.applyUpdate({
      activeProvider: 'anthropic',
      keys: { anthropic: 'sk-test-123' },
      models: { anthropic: 'claude-x' },
    });
    expect(config.activeProvider).toBe('anthropic');
    const anthropic = config.providers.find((p) => p.name === 'anthropic');
    expect(anthropic?.ready).toBe(true);
    expect(anthropic?.model).toBe('claude-x');
    // The projection must not carry the secret.
    expect(JSON.stringify(config)).not.toContain('sk-test-123');
    // But resolveConfig (main-only) does, so the provider can authenticate.
    expect(store.resolveConfig('anthropic').apiKey).toBe('sk-test-123');
  });

  it('clears a key with null and drops a model set to empty', () => {
    const store = new AiConfigStore(file);
    store.applyUpdate({ keys: { nvidia: 'nv-1' }, models: { nvidia: 'llama' } });
    expect(store.resolveConfig('nvidia').apiKey).toBe('nv-1');
    const config = store.applyUpdate({ keys: { nvidia: null }, models: { nvidia: '' } });
    expect(config.providers.find((p) => p.name === 'nvidia')?.ready).toBe(false);
    expect(store.resolveConfig('nvidia').apiKey).toBeUndefined();
  });

  it('falls back to an environment key when none is saved', () => {
    process.env['ANTHROPIC_API_KEY'] = 'env-key';
    const store = new AiConfigStore(file);
    expect(store.resolveConfig('anthropic').apiKey).toBe('env-key');
    expect(store.toAiConfig().providers.find((p) => p.name === 'anthropic')?.ready).toBe(true);
    // A saved key overrides the env fallback.
    store.applyUpdate({ keys: { anthropic: 'saved' } });
    expect(store.resolveConfig('anthropic').apiKey).toBe('saved');
  });

  it('tolerates a corrupt file by falling back to defaults', () => {
    writeFileSync(file, '{ not json', 'utf8');
    const store = new AiConfigStore(file);
    expect(store.activeProvider()).toBe('nvidia');
    // The mock backend stays resolvable (tests/dev can force it), just not default.
    expect(store.resolveConfig('mock')).toEqual({ name: 'mock' });
  });

  it('reports Ollama ready without a key and saves/clears its base URL', () => {
    const store = new AiConfigStore(file);
    // Keyless: ready with no key configured.
    expect(store.toAiConfig().providers.find((p) => p.name === 'ollama')?.ready).toBe(true);
    // Save a base URL — it round-trips to the (secret-free) projection and resolveConfig.
    const config = store.applyUpdate({ baseUrls: { ollama: 'http://box:11434/v1' } });
    expect(config.providers.find((p) => p.name === 'ollama')?.baseUrl).toBe('http://box:11434/v1');
    expect(store.resolveConfig('ollama').baseUrl).toBe('http://box:11434/v1');
    // Clearing with null reverts to the provider default (no override stored).
    store.applyUpdate({ baseUrls: { ollama: null } });
    expect(store.resolveConfig('ollama').baseUrl).toBeUndefined();
  });

  it('gates the OpenAI-compatible provider on a server URL, not a key', () => {
    const store = new AiConfigStore(file);
    // It has no endpoint of its own, so an unset URL means unusable — reporting it
    // ready (as "keyless" alone would) offers a provider that fails on first call.
    expect(store.toAiConfig().providers.find((p) => p.name === 'openai-compatible')?.ready).toBe(
      false,
    );

    const config = store.applyUpdate({
      baseUrls: { 'openai-compatible': 'http://127.0.0.1:8317/v1' },
    });
    const entry = config.providers.find((p) => p.name === 'openai-compatible');
    expect(entry?.ready).toBe(true);
    expect(entry?.baseUrl).toBe('http://127.0.0.1:8317/v1');
    expect(store.resolveConfig('openai-compatible').baseUrl).toBe('http://127.0.0.1:8317/v1');

    // An optional key round-trips for a gateway that does check it, without crossing back.
    store.applyUpdate({ keys: { 'openai-compatible': 'gateway-key' } });
    expect(store.resolveConfig('openai-compatible').apiKey).toBe('gateway-key');
    expect(
      JSON.stringify(store.toAiConfig().providers.find((p) => p.name === 'openai-compatible')),
    ).not.toContain('gateway-key');
  });

  it('loads a config file written before the OpenAI-compatible provider existed', () => {
    // Forward compatibility for existing installs: an absent key is an empty entry,
    // never a parse failure that would reset every other provider's settings.
    writeFileSync(
      file,
      JSON.stringify({ activeProvider: 'anthropic', anthropic: { apiKey: 'k' } }),
    );
    const store = new AiConfigStore(file);
    expect(store.activeProvider()).toBe('anthropic');
    expect(store.resolveConfig('openai-compatible').baseUrl).toBeUndefined();
    expect(store.toAiConfig().providers.find((p) => p.name === 'openai-compatible')?.ready).toBe(
      false,
    );
  });

  it('surfaces OpenRouter in the picker and round-trips its key + model', () => {
    const store = new AiConfigStore(file);
    // Listed as a selectable provider, not ready until a key is saved.
    expect(store.toAiConfig().providers.find((p) => p.name === 'openrouter')?.ready).toBe(false);
    const config = store.applyUpdate({
      keys: { openrouter: 'sk-or-123' },
      models: { openrouter: 'anthropic/claude-3.5-sonnet' },
    });
    const openrouter = config.providers.find((p) => p.name === 'openrouter');
    expect(openrouter?.ready).toBe(true);
    expect(openrouter?.model).toBe('anthropic/claude-3.5-sonnet');
    // The secret-free projection must not leak the key; resolveConfig (main-only) has it.
    expect(JSON.stringify(config)).not.toContain('sk-or-123');
    expect(store.resolveConfig('openrouter').apiKey).toBe('sk-or-123');
  });

  it('surfaces DeepSeek in the picker and round-trips its key + model', () => {
    const store = new AiConfigStore(file);
    // Listed as a selectable provider, not ready until a key is saved.
    expect(store.toAiConfig().providers.find((p) => p.name === 'deepseek')?.ready).toBe(false);
    const config = store.applyUpdate({
      keys: { deepseek: 'sk-ds-123' },
      models: { deepseek: 'deepseek-reasoner' },
    });
    const deepseek = config.providers.find((p) => p.name === 'deepseek');
    expect(deepseek?.ready).toBe(true);
    expect(deepseek?.model).toBe('deepseek-reasoner');
    // The secret-free projection must not leak the key; resolveConfig (main-only) has it.
    expect(JSON.stringify(config)).not.toContain('sk-ds-123');
    expect(store.resolveConfig('deepseek').apiKey).toBe('sk-ds-123');
  });

  it('surfaces Google in the picker and round-trips its key + model', () => {
    const store = new AiConfigStore(file);
    // Listed as a selectable provider, not ready until a key is saved.
    expect(store.toAiConfig().providers.find((p) => p.name === 'google')?.ready).toBe(false);
    const config = store.applyUpdate({
      keys: { google: 'AIza-123' },
      models: { google: 'gemini-1.5-pro' },
    });
    const google = config.providers.find((p) => p.name === 'google');
    expect(google?.ready).toBe(true);
    expect(google?.model).toBe('gemini-1.5-pro');
    // The secret-free projection must not leak the key; resolveConfig (main-only) has it.
    expect(JSON.stringify(config)).not.toContain('AIza-123');
    expect(store.resolveConfig('google').apiKey).toBe('AIza-123');
  });

  it('persists across store instances (written to disk)', () => {
    new AiConfigStore(file).applyUpdate({ activeProvider: 'nvidia', keys: { nvidia: 'k' } });
    const reopened = new AiConfigStore(file);
    expect(reopened.activeProvider()).toBe('nvidia');
    expect(reopened.resolveConfig('nvidia').apiKey).toBe('k');
  });

  describe('visual-embeddings key slot (MI0.1)', () => {
    it('is absent by default and auto-index defaults on', () => {
      const config = new AiConfigStore(file).toAiConfig();
      expect(config.nvidiaEmbeddings).toBeUndefined();
      expect(config.embeddingsAutoIndex).toBe(true);
    });

    it('saves the comma-separated keys and — unlike chat keys — reads them back (D5)', () => {
      const store = new AiConfigStore(file);
      const config = store.applyUpdate({ nvidiaEmbeddings: 'nvapi-1, nvapi-2' });
      // User-mandated visible plaintext: the projection carries the value.
      expect(config.nvidiaEmbeddings).toBe('nvapi-1, nvapi-2');
      // Persisted to disk (survives a reopen).
      expect(new AiConfigStore(file).toAiConfig().nvidiaEmbeddings).toBe('nvapi-1, nvapi-2');
      // The chat NVIDIA slot is untouched — a different product's key.
      expect(store.resolveConfig('nvidia').apiKey).toBeUndefined();
    });

    it('clears the keys with null or an empty string', () => {
      const store = new AiConfigStore(file);
      store.applyUpdate({ nvidiaEmbeddings: 'nvapi-1' });
      expect(store.applyUpdate({ nvidiaEmbeddings: null }).nvidiaEmbeddings).toBeUndefined();
      store.applyUpdate({ nvidiaEmbeddings: 'nvapi-2' });
      expect(store.applyUpdate({ nvidiaEmbeddings: '  ' }).nvidiaEmbeddings).toBeUndefined();
    });

    it('falls back to FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS when nothing is saved', () => {
      process.env['FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS'] = 'env-a,env-b';
      const store = new AiConfigStore(file);
      expect(store.resolveEmbeddingsKeys()).toBe('env-a,env-b');
      expect(store.toAiConfig().nvidiaEmbeddings).toBe('env-a,env-b');
      // A saved value overrides the env fallback.
      store.applyUpdate({ nvidiaEmbeddings: 'saved-key' });
      expect(store.resolveEmbeddingsKeys()).toBe('saved-key');
    });

    it('saves, reads back, clears, and env-falls-back the TwelveLabs key', () => {
      const store = new AiConfigStore(file);
      // Saved value round-trips (visible plaintext, like the embeddings key).
      expect(store.applyUpdate({ twelveLabs: 'tlk-1' }).twelveLabs).toBe('tlk-1');
      expect(new AiConfigStore(file).toAiConfig().twelveLabs).toBe('tlk-1');
      // Cleared with null / empty.
      expect(store.applyUpdate({ twelveLabs: null }).twelveLabs).toBeUndefined();
      expect(store.applyUpdate({ twelveLabs: '   ' }).twelveLabs).toBeUndefined();
      // Env fallback when nothing saved; a saved value overrides it.
      process.env['TWELVELABS_API_KEY'] = 'tlk-env';
      expect(store.resolveTwelveLabsKey()).toBe('tlk-env');
      expect(store.toAiConfig().twelveLabs).toBe('tlk-env');
      store.applyUpdate({ twelveLabs: 'tlk-saved' });
      expect(store.resolveTwelveLabsKey()).toBe('tlk-saved');
      delete process.env['TWELVELABS_API_KEY'];
    });

    it('toggles auto-index off and persists it', () => {
      const store = new AiConfigStore(file);
      expect(store.applyUpdate({ embeddingsAutoIndex: false }).embeddingsAutoIndex).toBe(false);
      expect(new AiConfigStore(file).toAiConfig().embeddingsAutoIndex).toBe(false);
      expect(store.applyUpdate({ embeddingsAutoIndex: true }).embeddingsAutoIndex).toBe(true);
    });
  });

  describe('visual caption provider', () => {
    it('persists the selected provider without exposing its key', () => {
      const store = new AiConfigStore(file);
      const config = store.applyUpdate({ visualCaptionProvider: 'anthropic' });
      expect(config.visualCaptionProvider).toBe('anthropic');
      expect(new AiConfigStore(file).visualCaptionProvider()).toBe('anthropic');
    });
  });

  describe('hosted speech-to-text key slot (plan H0.1)', () => {
    it('is absent by default', () => {
      expect(new AiConfigStore(file).toAiConfig().asrApiKey).toBeUndefined();
    });

    it('saves the dedicated ASR key and — unlike chat keys — reads it back', () => {
      const store = new AiConfigStore(file);
      const config = store.applyUpdate({ asrApiKey: 'nvapi-asr' });
      expect(config.asrApiKey).toBe('nvapi-asr');
      // Persisted to disk (survives a reopen).
      expect(new AiConfigStore(file).toAiConfig().asrApiKey).toBe('nvapi-asr');
      // The chat NVIDIA/groq slots are untouched — a different, dedicated key.
      expect(store.resolveConfig('nvidia').apiKey).toBeUndefined();
      expect(store.resolveConfig('groq').apiKey).toBeUndefined();
    });

    it('clears the key with null or an empty string', () => {
      const store = new AiConfigStore(file);
      store.applyUpdate({ asrApiKey: 'k' });
      expect(store.applyUpdate({ asrApiKey: null }).asrApiKey).toBeUndefined();
      store.applyUpdate({ asrApiKey: 'k2' });
      expect(store.applyUpdate({ asrApiKey: '  ' }).asrApiKey).toBeUndefined();
    });

    it('falls back to FRAMEPILOT_ASR_API_KEY when nothing is saved', () => {
      process.env['FRAMEPILOT_ASR_API_KEY'] = 'env-asr-key';
      const store = new AiConfigStore(file);
      expect(store.resolveAsrApiKey()).toBe('env-asr-key');
      expect(store.toAiConfig().asrApiKey).toBe('env-asr-key');
      // A saved value overrides the env fallback.
      store.applyUpdate({ asrApiKey: 'saved-asr-key' });
      expect(store.resolveAsrApiKey()).toBe('saved-asr-key');
      delete process.env['FRAMEPILOT_ASR_API_KEY'];
    });
  });

  describe('speech-to-text provider selection (plan H0.1)', () => {
    it('defaults to local whisper-cli when nothing is saved', () => {
      const store = new AiConfigStore(file);
      expect(store.resolveAsrProvider()).toBe('whisper-cli');
      // Not surfaced in the projected config until explicitly chosen.
      expect(store.toAiConfig().asrProvider).toBeUndefined();
    });

    it('persists a hosted provider choice so the AI agent can honor it', () => {
      const store = new AiConfigStore(file);
      const config = store.applyUpdate({ asrProvider: 'nvidia' });
      expect(config.asrProvider).toBe('nvidia');
      expect(store.resolveAsrProvider()).toBe('nvidia');
      // Survives a reopen (the desktop main process reads this at transcribe time).
      expect(new AiConfigStore(file).resolveAsrProvider()).toBe('nvidia');
    });

    it('persists TwelveLabs as a first-class transcription provider', () => {
      const store = new AiConfigStore(file);
      expect(store.applyUpdate({ asrProvider: 'twelvelabs' }).asrProvider).toBe('twelvelabs');
      expect(new AiConfigStore(file).resolveAsrProvider()).toBe('twelvelabs');
    });

    it('ignores an invalid provider string and keeps the previous choice', () => {
      const store = new AiConfigStore(file);
      store.applyUpdate({ asrProvider: 'groq' });
      store.applyUpdate({ asrProvider: 'bogus' as never });
      expect(store.resolveAsrProvider()).toBe('groq');
    });

    it('falls back to FRAMEPILOT_ASR_PROVIDER when nothing is saved', () => {
      process.env['FRAMEPILOT_ASR_PROVIDER'] = 'groq';
      expect(new AiConfigStore(file).resolveAsrProvider()).toBe('groq');
      delete process.env['FRAMEPILOT_ASR_PROVIDER'];
    });
  });

  describe('hosted speech-to-text model slot', () => {
    it('is unset by default so the provider default applies', () => {
      const store = new AiConfigStore(file);
      expect(store.resolveAsrModel()).toBeUndefined();
      expect(store.toAiConfig().asrModel).toBeUndefined();
    });

    it('saves the model override and reads it back through the config', () => {
      const store = new AiConfigStore(file);
      const config = store.applyUpdate({ asrModel: 'nemotron-asr-1b' });
      expect(config.asrModel).toBe('nemotron-asr-1b');
      expect(store.resolveAsrModel()).toBe('nemotron-asr-1b');
      // Survives a reopen (main reads this at transcribe time).
      expect(new AiConfigStore(file).resolveAsrModel()).toBe('nemotron-asr-1b');
    });

    it('clears the model with null or an empty/whitespace string', () => {
      const store = new AiConfigStore(file);
      store.applyUpdate({ asrModel: 'm1' });
      expect(store.applyUpdate({ asrModel: null }).asrModel).toBeUndefined();
      store.applyUpdate({ asrModel: 'm2' });
      expect(store.applyUpdate({ asrModel: '  ' }).asrModel).toBeUndefined();
      expect(store.resolveAsrModel()).toBeUndefined();
    });
  });
});
