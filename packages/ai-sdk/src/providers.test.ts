/**
 * Tests for providers: the deterministic mock, the env-driven factory, and the
 * Anthropic / NVIDIA HTTP providers (with an injected `fetch`, no network).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASR_PROVIDER_NAMES,
  GroqTranscriptionProvider,
  LocalWhisperCliClient,
  MockProvider,
  NvidiaTranscriptionProvider,
  TwelveLabsTranscriptionProvider,
  PROVIDER_NAMES,
  asrSendsAudioOffDevice,
  createAsrProvider,
  createProvider,
  isAsrProviderName,
  isProviderName,
  resolveAsrProviderConfig,
  resolveProviderConfig,
} from './providers/index.js';
import { toolDescriptors } from './tool-registry.js';

describe('mock provider', () => {
  it('answers as chat when no editing tools are offered', async () => {
    const res = await new MockProvider().complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.toolCalls).toBeUndefined();
    expect(res.text).toContain('deterministic');
  });

  it('proposes a deterministic tool call when editing tools are offered', async () => {
    const res = await new MockProvider().complete({
      messages: [{ role: 'user', content: 'edit' }],
      tools: toolDescriptors((t) => t.mutates),
    });
    expect(res.toolCalls?.[0]).toMatchObject({ name: 'delete_range' });
  });

  it('stops streaming when the caller aborts', async () => {
    // The offline path must honour Stop like any other provider — it is what the browser
    // falls back to, so a mock that ignores cancellation makes "Stop" look broken.
    const controller = new AbortController();
    controller.abort();
    const chunks = [];
    for await (const chunk of new MockProvider().stream(
      { messages: [{ role: 'user', content: 'hi' }] },
      controller.signal,
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);
  });
});

describe('provider factory', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the mock provider', () => {
    expect(createProvider('mock').name).toBe('mock');
    expect(createProvider().name).toBe('mock');
  });

  it('narrows only real provider names via isProviderName', () => {
    for (const name of PROVIDER_NAMES) expect(isProviderName(name)).toBe(true);
    expect(isProviderName('anthropic-typo')).toBe(false);
    expect(isProviderName('')).toBe(false);
  });

  it('resolves config from env and constructs each provider', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-a');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-x');
    vi.stubEnv('NVIDIA_API_KEY', 'nv');
    vi.stubEnv('NVIDIA_BASE_URL', 'http://nim');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or');
    vi.stubEnv('OPENROUTER_MODEL', 'anthropic/claude-3.5-sonnet');
    vi.stubEnv('GROQ_API_KEY', 'gsk-x');
    vi.stubEnv('GROQ_MODEL', 'llama-3.3-70b-versatile');
    vi.stubEnv('GOOGLE_API_KEY', 'AIza-x');
    vi.stubEnv('GOOGLE_MODEL', 'gemini-1.5-pro');
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-ds');
    vi.stubEnv('DEEPSEEK_MODEL', 'deepseek-reasoner');
    expect(resolveProviderConfig('anthropic')).toMatchObject({ apiKey: 'sk-a', model: 'claude-x' });
    expect(resolveProviderConfig('nvidia')).toMatchObject({ apiKey: 'nv', baseUrl: 'http://nim' });
    expect(resolveProviderConfig('openrouter')).toMatchObject({
      apiKey: 'sk-or',
      model: 'anthropic/claude-3.5-sonnet',
    });
    expect(resolveProviderConfig('groq')).toMatchObject({
      apiKey: 'gsk-x',
      model: 'llama-3.3-70b-versatile',
    });
    expect(resolveProviderConfig('google')).toMatchObject({
      apiKey: 'AIza-x',
      model: 'gemini-1.5-pro',
    });
    expect(resolveProviderConfig('deepseek')).toMatchObject({
      apiKey: 'sk-ds',
      model: 'deepseek-reasoner',
    });
    expect(resolveProviderConfig('mock')).toEqual({ name: 'mock' });
    expect(createProvider('anthropic').name).toBe('anthropic');
    expect(createProvider('nvidia').name).toBe('nvidia');
    expect(createProvider('openrouter').name).toBe('openrouter');
    expect(createProvider('groq').name).toBe('groq');
    expect(createProvider('google').name).toBe('google');
    expect(createProvider('deepseek').name).toBe('deepseek');
  });

  it('honours FRAMEPILOT_AI_PROVIDER', () => {
    vi.stubEnv('FRAMEPILOT_AI_PROVIDER', 'anthropic');
    expect(createProvider().name).toBe('anthropic');
  });
});

describe('ASR provider selection (plan H0.1)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('narrows only real ASR provider names via isAsrProviderName', () => {
    for (const name of ASR_PROVIDER_NAMES) expect(isAsrProviderName(name)).toBe(true);
    expect(isAsrProviderName('whisper-typo')).toBe(false);
    expect(isAsrProviderName('')).toBe(false);
  });

  it('flags exactly the hosted providers as sending audio off-device', () => {
    expect(asrSendsAudioOffDevice('whisper-cli')).toBe(false);
    expect(asrSendsAudioOffDevice('twelvelabs')).toBe(true);
    expect(asrSendsAudioOffDevice('groq')).toBe(true);
    expect(asrSendsAudioOffDevice('nvidia')).toBe(true);
  });

  it('defaults to whisper-cli (local, offline, no consent gate)', () => {
    expect(resolveAsrProviderConfig().provider).toBe('whisper-cli');
    expect(createAsrProvider()).toBeInstanceOf(LocalWhisperCliClient);
  });

  it('resolves whisper-cli config from env with the engine base URL default', () => {
    const config = resolveAsrProviderConfig('whisper-cli');
    expect(config).toMatchObject({ provider: 'whisper-cli' });
    expect(config.baseUrl).toBeDefined();
  });

  it('honours FRAMEPILOT_ENGINE_BASE_URL and FRAMEPILOT_ASR_MODEL for whisper-cli', () => {
    vi.stubEnv('FRAMEPILOT_ENGINE_BASE_URL', 'http://localhost:9999');
    vi.stubEnv('FRAMEPILOT_ASR_MODEL', 'base.en');
    expect(resolveAsrProviderConfig('whisper-cli')).toEqual({
      provider: 'whisper-cli',
      baseUrl: 'http://localhost:9999',
      model: 'base.en',
    });
  });

  // Groq/NVIDIA ASR are retired. A stored preference naming one is migration input only:
  // it resolves to Local, so an old setting can never keep sending the user's audio to a
  // hosted provider they can no longer see or disable in the UI.
  it.each(['groq', 'nvidia'] as const)(
    'migrates the retired %s ASR name to local, ignoring any hosted ASR key',
    (legacy) => {
      vi.stubEnv('GROQ_API_KEY', 'chat-key-should-be-ignored');
      vi.stubEnv('NVIDIA_API_KEY', 'chat-key-should-be-ignored');
      vi.stubEnv('FRAMEPILOT_ASR_API_KEY', 'hosted-asr-key-should-be-ignored');
      const config = resolveAsrProviderConfig(legacy);
      expect(config.provider).toBe('whisper-cli');
      expect(config).not.toHaveProperty('apiKey');
      expect(createAsrProvider(legacy)).toBeInstanceOf(LocalWhisperCliClient);
    },
  );

  it('never constructs the retired hosted ASR adapters, whatever name is passed', () => {
    for (const name of ASR_PROVIDER_NAMES) {
      const provider = createAsrProvider(name);
      expect(provider).not.toBeInstanceOf(GroqTranscriptionProvider);
      expect(provider).not.toBeInstanceOf(NvidiaTranscriptionProvider);
    }
  });

  it('resolves TwelveLabs from its shared media-intelligence key', () => {
    vi.stubEnv('TWELVELABS_API_KEY', 'tl-key');
    vi.stubEnv('FRAMEPILOT_ENGINE_BASE_URL', 'http://localhost:9999');
    expect(resolveAsrProviderConfig('twelvelabs')).toEqual({
      provider: 'twelvelabs',
      apiKey: 'tl-key',
      baseUrl: 'http://localhost:9999',
    });
    expect(createAsrProvider('twelvelabs')).toBeInstanceOf(TwelveLabsTranscriptionProvider);
  });

  it('prefers an explicit apiKey/model override over env', () => {
    vi.stubEnv('TWELVELABS_API_KEY', 'env-key');
    expect(
      resolveAsrProviderConfig('twelvelabs', { apiKey: 'override-key', baseUrl: 'http://o:1' }),
    ).toEqual({
      provider: 'twelvelabs',
      apiKey: 'override-key',
      baseUrl: 'http://o:1',
    });
  });

  it('honours FRAMEPILOT_ASR_PROVIDER', () => {
    vi.stubEnv('FRAMEPILOT_ASR_PROVIDER', 'twelvelabs');
    vi.stubEnv('TWELVELABS_API_KEY', 'tl-key');
    expect(createAsrProvider()).toBeInstanceOf(TwelveLabsTranscriptionProvider);
  });

  it('migrates an unrecognised stored FRAMEPILOT_ASR_PROVIDER to local', () => {
    vi.stubEnv('FRAMEPILOT_ASR_PROVIDER', 'not-a-provider');
    expect(resolveAsrProviderConfig().provider).toBe('whisper-cli');
    expect(createAsrProvider()).toBeInstanceOf(LocalWhisperCliClient);
  });
});
