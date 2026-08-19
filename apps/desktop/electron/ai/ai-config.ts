/**
 * AI configuration store — plaintext `ai-config.json` in the app data dir.
 *
 * The renderer may emit model/base-URL updates at text-input frequency. The desktop
 * host therefore keeps one validated in-memory snapshot for the process lifetime and
 * settles text-only persistence into one write per burst. Provider resolution and the
 * renderer-safe projection never reopen the file after hydration. A synchronous exit
 * flush closes the small settle window without making ordinary keystrokes touch disk.
 *
 * Environment variables remain fallbacks only: file-saved values win. Chat API keys
 * stay write-only across IPC; the renderer receives only ready/model/base-URL metadata.
 *
 * No `electron` import — the store takes a file path and remains unit-testable without
 * an Electron runtime.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  isAsrProviderName,
  resolveProviderConfig,
  type ProviderConfig,
} from '@framepilot/ai-sdk';
import { createLogger } from '@framepilot/shared-types';
import type {
  AiConfig,
  AiConfigUpdate,
  AiProviderInfo,
  AiProviderName,
  AsrProviderName,
} from '../ipc/contract.js';

const log = createLogger('desktop:ai-config');

/** Text inputs can update on every keypress; persist only after the edit burst settles. */
export const AI_CONFIG_TEXT_SETTLE_MS = 300;

interface ProviderEntry {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface StoredConfig {
  activeProvider: AiProviderName;
  anthropic: ProviderEntry;
  nvidia: ProviderEntry;
  openrouter: ProviderEntry;
  'vercel-gateway': ProviderEntry;
  groq: ProviderEntry;
  google: ProviderEntry;
  ollama: ProviderEntry;
  deepseek: ProviderEntry;
  'openai-compatible': ProviderEntry;
  nvidiaEmbeddings?: string;
  twelveLabs?: string;
  embeddingsAutoIndex?: boolean;
  visualCaptionProvider?: AiProviderName;
  asrApiKey?: string;
  asrProvider?: AsrProviderName;
  asrModel?: string;
}

const REAL_PROVIDERS: readonly Exclude<AiProviderName, 'mock'>[] = [
  'anthropic',
  'nvidia',
  'openrouter',
  'vercel-gateway',
  'groq',
  'google',
  'ollama',
  'deepseek',
  'openai-compatible',
];

const KEYLESS_PROVIDERS: ReadonlySet<AiProviderName> = new Set<AiProviderName>([
  'ollama',
  'openai-compatible',
]);

const URL_REQUIRED_PROVIDERS: ReadonlySet<AiProviderName> = new Set<AiProviderName>([
  'openai-compatible',
]);

const PROVIDER_NAMES: ReadonlySet<string> = new Set<AiProviderName>([...REAL_PROVIDERS, 'mock']);

const PROVIDER_META: Record<AiProviderName, { label: string; defaultModel: string }> = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: 'claude-opus-4-8' },
  nvidia: { label: 'NVIDIA NIM', defaultModel: 'meta/llama-3.1-70b-instruct' },
  openrouter: { label: 'OpenRouter', defaultModel: 'openai/gpt-4o-mini' },
  'vercel-gateway': { label: 'Vercel AI Gateway', defaultModel: 'anthropic/claude-sonnet-4.6' },
  groq: { label: 'Groq', defaultModel: 'llama-3.3-70b-versatile' },
  google: { label: 'Google (Gemini)', defaultModel: 'gemini-2.5-flash' },
  ollama: { label: 'Ollama (local)', defaultModel: 'llama3.2' },
  deepseek: { label: 'DeepSeek', defaultModel: 'deepseek-chat' },
  'openai-compatible': { label: 'OpenAI-compatible server', defaultModel: 'gpt-4o-mini' },
  mock: { label: 'Offline mock', defaultModel: 'mock' },
};

const emptyStored = (): StoredConfig => ({
  activeProvider: 'nvidia',
  anthropic: {},
  nvidia: {},
  openrouter: {},
  'vercel-gateway': {},
  groq: {},
  google: {},
  ollama: {},
  deepseek: {},
  'openai-compatible': {},
});

const isProviderName = (value: unknown): value is AiProviderName =>
  typeof value === 'string' && PROVIDER_NAMES.has(value);

function readEntry(value: unknown): ProviderEntry {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const entry: ProviderEntry = {};
  if (typeof record['apiKey'] === 'string') entry.apiKey = record['apiKey'];
  if (typeof record['model'] === 'string') entry.model = record['model'];
  if (typeof record['baseUrl'] === 'string') entry.baseUrl = record['baseUrl'];
  return entry;
}

function parseStored(raw: string): StoredConfig {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const active = parsed['activeProvider'];
  return {
    activeProvider:
      typeof active === 'string' && PROVIDER_NAMES.has(active)
        ? (active as AiProviderName)
        : 'nvidia',
    anthropic: readEntry(parsed['anthropic']),
    nvidia: readEntry(parsed['nvidia']),
    openrouter: readEntry(parsed['openrouter']),
    'vercel-gateway': readEntry(parsed['vercel-gateway']),
    groq: readEntry(parsed['groq']),
    google: readEntry(parsed['google']),
    ollama: readEntry(parsed['ollama']),
    deepseek: readEntry(parsed['deepseek']),
    'openai-compatible': readEntry(parsed['openai-compatible']),
    ...(typeof parsed['nvidiaEmbeddings'] === 'string' && parsed['nvidiaEmbeddings'] !== ''
      ? { nvidiaEmbeddings: parsed['nvidiaEmbeddings'] }
      : {}),
    ...(typeof parsed['twelveLabs'] === 'string' && parsed['twelveLabs'] !== ''
      ? { twelveLabs: parsed['twelveLabs'] }
      : {}),
    ...(typeof parsed['embeddingsAutoIndex'] === 'boolean'
      ? { embeddingsAutoIndex: parsed['embeddingsAutoIndex'] }
      : {}),
    ...(isProviderName(parsed['visualCaptionProvider'])
      ? { visualCaptionProvider: parsed['visualCaptionProvider'] }
      : {}),
    ...(typeof parsed['asrApiKey'] === 'string' && parsed['asrApiKey'] !== ''
      ? { asrApiKey: parsed['asrApiKey'] }
      : {}),
    ...(typeof parsed['asrProvider'] === 'string' && isAsrProviderName(parsed['asrProvider'])
      ? { asrProvider: parsed['asrProvider'] }
      : {}),
    ...(typeof parsed['asrModel'] === 'string' && parsed['asrModel'] !== ''
      ? { asrModel: parsed['asrModel'] }
      : {}),
  };
}

function cloneEntry(entry: ProviderEntry): ProviderEntry {
  return {
    ...(entry.apiKey === undefined ? {} : { apiKey: entry.apiKey }),
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
  };
}

function cloneStored(config: StoredConfig): StoredConfig {
  return {
    activeProvider: config.activeProvider,
    anthropic: cloneEntry(config.anthropic),
    nvidia: cloneEntry(config.nvidia),
    openrouter: cloneEntry(config.openrouter),
    'vercel-gateway': cloneEntry(config['vercel-gateway']),
    groq: cloneEntry(config.groq),
    google: cloneEntry(config.google),
    ollama: cloneEntry(config.ollama),
    deepseek: cloneEntry(config.deepseek),
    'openai-compatible': cloneEntry(config['openai-compatible']),
    ...(config.nvidiaEmbeddings === undefined ? {} : { nvidiaEmbeddings: config.nvidiaEmbeddings }),
    ...(config.twelveLabs === undefined ? {} : { twelveLabs: config.twelveLabs }),
    ...(config.embeddingsAutoIndex === undefined
      ? {}
      : { embeddingsAutoIndex: config.embeddingsAutoIndex }),
    ...(config.visualCaptionProvider === undefined
      ? {}
      : { visualCaptionProvider: config.visualCaptionProvider }),
    ...(config.asrApiKey === undefined ? {} : { asrApiKey: config.asrApiKey }),
    ...(config.asrProvider === undefined ? {} : { asrProvider: config.asrProvider }),
    ...(config.asrModel === undefined ? {} : { asrModel: config.asrModel }),
  };
}

function isTextOnlyUpdate(update: AiConfigUpdate): boolean {
  const hasText = update.models !== undefined || update.baseUrls !== undefined;
  return (
    hasText &&
    update.activeProvider === undefined &&
    update.keys === undefined &&
    update.nvidiaEmbeddings === undefined &&
    update.twelveLabs === undefined &&
    update.embeddingsAutoIndex === undefined &&
    update.visualCaptionProvider === undefined &&
    update.asrApiKey === undefined &&
    update.asrProvider === undefined &&
    update.asrModel === undefined
  );
}

/**
 * Reads and writes the AI config and resolves provider settings with environment
 * fallbacks. The first read hydrates an in-memory snapshot; all subsequent readers
 * use that snapshot. Text-only updates coalesce before disk persistence.
 */
export class AiConfigStore {
  private cached: StoredConfig | null = null;
  private dirty = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private exitFlushRegistered = false;

  public constructor(private readonly filePath: string) {}

  private current(): StoredConfig {
    if (this.cached !== null) return this.cached;
    try {
      this.cached = parseStored(readFileSync(this.filePath, 'utf8'));
    } catch {
      this.cached = emptyStored();
    }
    return this.cached;
  }

  /** Return a defensive copy so callers cannot mutate the host cache accidentally. */
  public read(): StoredConfig {
    return cloneStored(this.current());
  }

  private persistNow(): void {
    if (!this.dirty) return;
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.current(), null, 2), 'utf8');
    this.dirty = false;
  }

  private ensureExitFlush(): void {
    if (this.exitFlushRegistered) return;
    this.exitFlushRegistered = true;
    process.once('exit', () => this.persistNow());
  }

  private scheduleTextPersistence(): void {
    this.ensureExitFlush();
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.persistNow();
    }, AI_CONFIG_TEXT_SETTLE_MS);
    this.settleTimer.unref?.();
  }

  /** Flush a pending settled text edit, used by tests and shutdown/reconfiguration seams. */
  public flush(): void {
    this.persistNow();
  }

  public activeProvider(): AiProviderName {
    return this.current().activeProvider;
  }

  private resolveConfigFrom(name: AiProviderName, stored: StoredConfig): ProviderConfig {
    const base = resolveProviderConfig(name);
    if (name === 'mock') return base;
    const entry = stored[name];
    return {
      ...base,
      ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
    };
  }

  public resolveConfig(name: AiProviderName): ProviderConfig {
    return this.resolveConfigFrom(name, this.current());
  }

  public resolveEmbeddingsKeys(): string | undefined {
    const stored = this.current().nvidiaEmbeddings;
    if (stored !== undefined && stored.trim() !== '') return stored;
    const env = process.env['FRAMEPILOT_NVIDIA_EMBEDDINGS_KEYS'];
    return env !== undefined && env.trim() !== '' ? env : undefined;
  }

  public resolveTwelveLabsKey(): string | undefined {
    const stored = this.current().twelveLabs;
    if (stored !== undefined && stored.trim() !== '') return stored;
    const env = process.env['TWELVELABS_API_KEY'];
    return env !== undefined && env.trim() !== '' ? env : undefined;
  }

  public resolveAsrApiKey(): string | undefined {
    const stored = this.current().asrApiKey;
    if (stored !== undefined && stored.trim() !== '') return stored;
    const env = process.env['FRAMEPILOT_ASR_API_KEY'];
    return env !== undefined && env.trim() !== '' ? env : undefined;
  }

  public resolveAsrProvider(): AsrProviderName {
    const stored = this.current().asrProvider;
    if (stored !== undefined) return stored;
    const env = process.env['FRAMEPILOT_ASR_PROVIDER'];
    return env !== undefined && isAsrProviderName(env) ? env : 'whisper-cli';
  }

  public resolveAsrModel(): string | undefined {
    const stored = this.current().asrModel;
    return stored !== undefined && stored.trim() !== '' ? stored : undefined;
  }

  public toAiConfig(): AiConfig {
    const stored = this.current();
    const providers: AiProviderInfo[] = ([...REAL_PROVIDERS] as AiProviderName[]).map((name) => {
      const resolved = this.resolveConfigFrom(name, stored);
      return {
        name,
        label: PROVIDER_META[name].label,
        model: resolved.model ?? PROVIDER_META[name].defaultModel,
        ready: URL_REQUIRED_PROVIDERS.has(name)
          ? Boolean(resolved.baseUrl)
          : name === 'mock' || KEYLESS_PROVIDERS.has(name)
            ? true
            : Boolean(resolved.apiKey),
        ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
      };
    });

    const nvidiaEmbeddings = this.resolveEmbeddingsKeys();
    const twelveLabs = this.resolveTwelveLabsKey();
    const asrApiKey = this.resolveAsrApiKey();
    return {
      activeProvider: stored.activeProvider,
      providers,
      ...(nvidiaEmbeddings !== undefined ? { nvidiaEmbeddings } : {}),
      ...(twelveLabs !== undefined ? { twelveLabs } : {}),
      embeddingsAutoIndex: stored.embeddingsAutoIndex ?? true,
      ...(stored.visualCaptionProvider !== undefined
        ? { visualCaptionProvider: stored.visualCaptionProvider }
        : {}),
      ...(asrApiKey !== undefined ? { asrApiKey } : {}),
      ...(stored.asrProvider !== undefined ? { asrProvider: stored.asrProvider } : {}),
      ...(stored.asrModel !== undefined ? { asrModel: stored.asrModel } : {}),
    };
  }

  public applyUpdate(update: AiConfigUpdate): AiConfig {
    log.action('ai-config applyUpdate', {
      activeProvider: update.activeProvider,
      keysChanged: update.keys ? Object.keys(update.keys) : undefined,
      modelsChanged: update.models ? Object.keys(update.models) : undefined,
      baseUrlsChanged: update.baseUrls ? Object.keys(update.baseUrls) : undefined,
      nvidiaEmbeddingsChanged: update.nvidiaEmbeddings !== undefined,
      twelveLabsChanged: update.twelveLabs !== undefined,
      embeddingsAutoIndex: update.embeddingsAutoIndex,
      visualCaptionProvider: update.visualCaptionProvider,
      asrApiKeyChanged: update.asrApiKey !== undefined,
      asrProvider: update.asrProvider,
      asrModel: update.asrModel,
    });

    const config = this.current();
    if (update.activeProvider) config.activeProvider = update.activeProvider;
    for (const provider of REAL_PROVIDERS) {
      const entry = config[provider];
      const key = update.keys?.[provider];
      if (key === null) delete entry.apiKey;
      else if (typeof key === 'string' && key.trim() !== '') entry.apiKey = key.trim();

      const baseUrl = update.baseUrls?.[provider];
      if (baseUrl === null) delete entry.baseUrl;
      else if (typeof baseUrl === 'string') {
        if (baseUrl.trim() === '') delete entry.baseUrl;
        else entry.baseUrl = baseUrl.trim();
      }

      const model = update.models?.[provider];
      if (typeof model === 'string') {
        if (model.trim() === '') delete entry.model;
        else entry.model = model.trim();
      }
    }

    if (update.nvidiaEmbeddings === null) delete config.nvidiaEmbeddings;
    else if (typeof update.nvidiaEmbeddings === 'string') {
      const keys = update.nvidiaEmbeddings.trim();
      if (keys === '') delete config.nvidiaEmbeddings;
      else config.nvidiaEmbeddings = keys;
    }

    if (update.twelveLabs === null) delete config.twelveLabs;
    else if (typeof update.twelveLabs === 'string') {
      const key = update.twelveLabs.trim();
      if (key === '') delete config.twelveLabs;
      else config.twelveLabs = key;
    }

    if (typeof update.embeddingsAutoIndex === 'boolean') {
      config.embeddingsAutoIndex = update.embeddingsAutoIndex;
    }
    if (isProviderName(update.visualCaptionProvider) && update.visualCaptionProvider !== 'mock') {
      config.visualCaptionProvider = update.visualCaptionProvider;
    }

    if (update.asrApiKey === null) delete config.asrApiKey;
    else if (typeof update.asrApiKey === 'string') {
      const key = update.asrApiKey.trim();
      if (key === '') delete config.asrApiKey;
      else config.asrApiKey = key;
    }

    if (update.asrProvider !== undefined && isAsrProviderName(update.asrProvider)) {
      config.asrProvider = update.asrProvider;
    }
    if (update.asrModel === null) delete config.asrModel;
    else if (typeof update.asrModel === 'string') {
      const model = update.asrModel.trim();
      if (model === '') delete config.asrModel;
      else config.asrModel = model;
    }

    this.dirty = true;
    if (isTextOnlyUpdate(update)) this.scheduleTextPersistence();
    else this.persistNow();
    return this.toAiConfig();
  }

  /** Selected provider for VLM captions, falling back to the active provider. */
  public visualCaptionProvider(): AiProviderName {
    const stored = this.current();
    return stored.visualCaptionProvider ?? stored.activeProvider;
  }
}
