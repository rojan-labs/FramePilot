/**
 * Browser/dev persistence for the AI configuration (Settings → AI).
 *
 * On desktop the canonical store is a plaintext `ai-config.json` in the app data dir
 * (main process); the renderer talks to it over IPC and never reads chat-provider keys
 * back. In a browser build there is no main process, so the same configuration lives
 * in localStorage. This module owns that browser store and its secret-free projection.
 */
import type {
  AiConfig,
  AiConfigUpdate,
  AiProviderInfo,
  AiProviderName,
} from '@framepilot/shared-types';
import { migrateAsrProviderName, type UserAsrProviderName } from '@framepilot/ai-sdk';

/** The real chat/reasoning providers. This roster is unrelated to STT choices. */
export const REAL_PROVIDERS: readonly Exclude<AiProviderName, 'mock'>[] = [
  'anthropic',
  'nvidia',
  'openrouter',
  'groq',
  'google',
  'ollama',
  'deepseek',
  'openai-compatible',
];

/**
 * Providers whose endpoint the user supplies.
 *
 * Ollama's is optional (it defaults to the local daemon); `openai-compatible` has no
 * default at all, so its field is the entire configuration.
 */
export const BASE_URL_PROVIDERS: readonly AiProviderName[] = ['ollama', 'openai-compatible'];

/**
 * Providers that run without an API key configured in-app — both are servers the user
 * runs, where a credential is the exception rather than the rule.
 */
export const KEYLESS_PROVIDERS: readonly AiProviderName[] = ['ollama', 'openai-compatible'];

/**
 * Providers with no endpoint of their own, which are therefore NOT usable until the
 * user supplies one — the readiness signal is the URL rather than a key.
 */
export const URL_REQUIRED_PROVIDERS: readonly AiProviderName[] = ['openai-compatible'];

/** Display label + default model per chat/reasoning provider. */
export const PROVIDER_META: Record<AiProviderName, { label: string; defaultModel: string }> = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: 'claude-opus-4-8' },
  nvidia: { label: 'NVIDIA NIM', defaultModel: 'meta/llama-3.1-70b-instruct' },
  openrouter: { label: 'OpenRouter', defaultModel: 'openai/gpt-4o-mini' },
  groq: { label: 'Groq', defaultModel: 'llama-3.3-70b-versatile' },
  google: { label: 'Google (Gemini)', defaultModel: 'gemini-2.5-flash' },
  ollama: { label: 'Ollama (local)', defaultModel: 'llama3.2' },
  deepseek: { label: 'DeepSeek', defaultModel: 'deepseek-chat' },
  'openai-compatible': { label: 'OpenAI-compatible server', defaultModel: 'gpt-4o-mini' },
  mock: { label: 'Offline mock', defaultModel: 'mock' },
};

/** Browser-side configuration. Chat-provider keys are needed by the direct SDK path. */
export interface BrowserAiConfig {
  activeProvider: AiProviderName;
  keys: Partial<Record<AiProviderName, string>>;
  models: Partial<Record<AiProviderName, string>>;
  baseUrls: Partial<Record<AiProviderName, string>>;
  /** Built-in NVIDIA visual-index key(s), separate from the NVIDIA chat key. */
  nvidiaEmbeddings?: string;
  /** TwelveLabs media-understanding and native-transcription key. */
  twelveLabs?: string;
  /** Optional eager warming after import. Semantic operations still index implicitly. */
  embeddingsAutoIndex?: boolean;
  /** Legacy hosted STT key retained only until desktop migration removes old callers. */
  asrApiKey?: string;
  /** Exactly Local or TwelveLabs after load/update migration. */
  asrProvider?: UserAsrProviderName;
  /** Legacy hosted STT model retained only until old desktop callers are removed. */
  asrModel?: string;
}

const STORAGE_KEY = 'framepilot.aiConfig';

const empty = (): BrowserAiConfig => ({
  activeProvider: 'mock',
  keys: {},
  models: {},
  baseUrls: {},
});

const isProvider = (value: unknown): value is AiProviderName =>
  value === 'mock' ||
  value === 'anthropic' ||
  value === 'nvidia' ||
  value === 'openrouter' ||
  value === 'groq' ||
  value === 'google' ||
  value === 'ollama' ||
  value === 'deepseek' ||
  value === 'openai-compatible';

/** Read the browser AI config, tolerating absent/corrupt and legacy storage. */
export function loadBrowserAiConfig(): BrowserAiConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<BrowserAiConfig> & {
      readonly visualCaptionProvider?: unknown;
      readonly asrProvider?: unknown;
    };
    return {
      activeProvider: isProvider(parsed.activeProvider) ? parsed.activeProvider : 'mock',
      keys: pickStrings(parsed.keys),
      models: pickStrings(parsed.models),
      baseUrls: pickStrings(parsed.baseUrls),
      ...(typeof parsed.nvidiaEmbeddings === 'string' && parsed.nvidiaEmbeddings !== ''
        ? { nvidiaEmbeddings: parsed.nvidiaEmbeddings }
        : {}),
      ...(typeof parsed.twelveLabs === 'string' && parsed.twelveLabs !== ''
        ? { twelveLabs: parsed.twelveLabs }
        : {}),
      ...(typeof parsed.embeddingsAutoIndex === 'boolean'
        ? { embeddingsAutoIndex: parsed.embeddingsAutoIndex }
        : {}),
      ...(parsed.asrProvider === undefined
        ? {}
        : { asrProvider: migrateAsrProviderName(parsed.asrProvider) }),
      ...(typeof parsed.asrModel === 'string' && parsed.asrModel !== ''
        ? { asrModel: parsed.asrModel }
        : {}),
      ...(typeof parsed.asrApiKey === 'string' && parsed.asrApiKey !== ''
        ? { asrApiKey: parsed.asrApiKey }
        : {}),
      // `visualCaptionProvider` is intentionally ignored. Captioning follows the
      // active vision-capable provider, so older storage loses only the selector,
      // never generated captions or caption-track content.
    };
  } catch {
    return empty();
  }
}

/** Keep only string values for real providers. */
function pickStrings(
  value: Partial<Record<AiProviderName, unknown>> | undefined,
): Partial<Record<AiProviderName, string>> {
  const out: Partial<Record<AiProviderName, string>> = {};
  for (const provider of REAL_PROVIDERS) {
    const candidate = value?.[provider];
    if (typeof candidate === 'string' && candidate !== '') out[provider] = candidate;
  }
  return out;
}

function save(config: BrowserAiConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* Storage unavailable. Configuration remains in the current session. */
  }
}

/** Apply an update and persist it; legacy-only fields normalize or are ignored. */
export function applyBrowserUpdate(update: AiConfigUpdate): BrowserAiConfig {
  const config = loadBrowserAiConfig();
  if (update.activeProvider) config.activeProvider = update.activeProvider;
  for (const provider of REAL_PROVIDERS) {
    const key = update.keys?.[provider];
    if (key === null) delete config.keys[provider];
    else if (typeof key === 'string' && key.trim() !== '') config.keys[provider] = key.trim();

    const model = update.models?.[provider];
    if (typeof model === 'string') {
      if (model.trim() === '') delete config.models[provider];
      else config.models[provider] = model.trim();
    }

    const baseUrl = update.baseUrls?.[provider];
    if (baseUrl === null) delete config.baseUrls[provider];
    else if (typeof baseUrl === 'string') {
      if (baseUrl.trim() === '') delete config.baseUrls[provider];
      else config.baseUrls[provider] = baseUrl.trim();
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

  // `visualCaptionProvider` updates are deliberately ignored. The active provider
  // is the one source of captioning-model selection after this migration.

  if (update.asrApiKey === null) delete config.asrApiKey;
  else if (typeof update.asrApiKey === 'string') {
    const key = update.asrApiKey.trim();
    if (key === '') delete config.asrApiKey;
    else config.asrApiKey = key;
  }

  if (update.asrProvider !== undefined) {
    config.asrProvider = migrateAsrProviderName(update.asrProvider);
  }

  if (update.asrModel === null) delete config.asrModel;
  else if (typeof update.asrModel === 'string') {
    const model = update.asrModel.trim();
    if (model === '') delete config.asrModel;
    else config.asrModel = model;
  }

  save(config);
  return config;
}

/**
 * Whether a provider can be used right now.
 *
 * "Ready" means the one thing that provider cannot run without is configured: a key for
 * hosted services, an endpoint for a server the user runs. Reporting a URL-less
 * `openai-compatible` as ready would put a provider in the picker that fails on its
 * first call, which is the failure this readiness flag exists to prevent.
 */
function isProviderReady(config: BrowserAiConfig, name: AiProviderName): boolean {
  if (name === 'mock') return true;
  if (URL_REQUIRED_PROVIDERS.includes(name)) return Boolean(config.baseUrls[name]);
  return KEYLESS_PROVIDERS.includes(name) || Boolean(config.keys[name]);
}

/** Project browser configuration to the secret-free Settings view. */
export function toAiConfig(config: BrowserAiConfig): AiConfig {
  const providers: AiProviderInfo[] = ([...REAL_PROVIDERS, 'mock'] as AiProviderName[]).map(
    (name) => ({
      name,
      label: PROVIDER_META[name].label,
      model: config.models[name] ?? PROVIDER_META[name].defaultModel,
      ready: isProviderReady(config, name),
      ...(config.baseUrls[name] ? { baseUrl: config.baseUrls[name] } : {}),
    }),
  );

  return {
    activeProvider: config.activeProvider,
    providers,
    ...(config.nvidiaEmbeddings !== undefined ? { nvidiaEmbeddings: config.nvidiaEmbeddings } : {}),
    ...(config.twelveLabs !== undefined ? { twelveLabs: config.twelveLabs } : {}),
    embeddingsAutoIndex: config.embeddingsAutoIndex ?? true,
    ...(config.asrApiKey !== undefined ? { asrApiKey: config.asrApiKey } : {}),
    ...(config.asrProvider !== undefined ? { asrProvider: config.asrProvider } : {}),
    ...(config.asrModel !== undefined ? { asrModel: config.asrModel } : {}),
  };
}
