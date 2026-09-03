/**
 * @framepilot/ai-sdk/providers — provider factory.
 *
 * Resolves the active provider from FRAMEPILOT_AI_PROVIDER (default `mock`) and
 * provider-specific env vars. See plan/PLAN.md Phase 4.1.
 *
 * **Every hosted provider is served by LangChain** (ADR 0105). The hand-written `fetch`
 * adapters this SDK shipped with were deleted on 2026-08-07, after the M0.1 capture showed
 * the LangChain path faster on every latency measure and the only one reporting
 * prompt-cache counts at all.
 *
 * `mock` is the sole exception and stays native by design: the offline path must not need
 * a network client, and it is what the browser falls back to when no key is saved.
 */
import {
  ANTHROPIC_DEFAULT_MODEL,
  CLAUDE_AGENT_SDK_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_MODEL,
  GOOGLE_DEFAULT_MODEL,
  GROQ_DEFAULT_MODEL,
  NVIDIA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
  OPENAI_COMPATIBLE_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_MODEL,
  VERCEL_GATEWAY_DEFAULT_MODEL,
} from './provider-defaults.js';
import { MockProvider } from './mock.js';
import {
  ResilientProvider,
  withResilience,
  type ResilientProviderOptions,
} from './resilient-provider.js';
import {
  isProviderName,
  PROVIDER_NAMES,
  type AiProvider,
  type ProviderChunk,
  type ProviderConfig,
  type ProviderName,
} from './types.js';
import type { ModelTier } from '../kernel/proposers/types.js';
import { DEFAULT_ENGINE_BASE_URL, LocalWhisperCliClient } from './local-asr.js';
import { TwelveLabsTranscriptionProvider } from './twelvelabs-asr.js';
import {
  DEFAULT_ASR_PROVIDER,
  migrateAsrProviderName,
  type AsrProviderConfig,
  type AsrProviderName,
  type UserAsrProviderName,
} from './asr-types.js';

export * from './types.js';
export * from './model-capabilities.js';
export * from './errors.js';
export * from './asr-types.js';
export { LocalWhisperCliClient, DEFAULT_ENGINE_BASE_URL } from './local-asr.js';
export type {
  LocalAsrRequest,
  LocalAsrSetupProgress,
  LocalAsrSetupState,
  LocalAsrStatus,
} from './local-asr.js';
/** @deprecated Kept only for stored-config/source compatibility. New runs cannot select it. */
export { GroqTranscriptionProvider } from './groq-asr.js';
/** @deprecated Kept only for stored-config/source compatibility. New runs cannot select it. */
export type { AudioInput, AudioFetchLike, GroqAsrConfig } from './groq-asr.js';
/** @deprecated Kept only for stored-config/source compatibility. New runs cannot select it. */
export { NvidiaTranscriptionProvider, NVIDIA_ASR_BASE_URL } from './nvidia-asr.js';
/** @deprecated Kept only for stored-config/source compatibility. New runs cannot select it. */
export type { NvidiaAsrConfig } from './nvidia-asr.js';
export * from './music-types.js';
export * from './stock-types.js';
export {
  OpenverseMusicProvider,
  createMusicProvider,
  normalizeOpenverseTrack,
  safeFormat,
  OPENVERSE_API_BASE,
  openverseApiBase,
} from './openverse-music.js';
export {
  PexelsStockProvider,
  createStockProvider,
  normalizePexelsPhoto,
  normalizePexelsVideo,
  PEXELS_API_BASE,
  pexelsApiBase,
  PEXELS_PHOTO_SEARCH_URL,
  PEXELS_VIDEO_SEARCH_URL,
} from './pexels-stock.js';
export type { PexelsStockConfig } from './pexels-stock.js';
export { TwelveLabsTranscriptionProvider } from './twelvelabs-asr.js';
export type { TwelveLabsAsrConfig, TwelveLabsAsrRequest } from './twelvelabs-asr.js';
export { parseAsrKeyRing, transcribeWithKeyRing } from './asr-keyring.js';
export { sliceWavIntoChunks, type WavChunk } from './wav-chunks.js';
export {
  transcribeWavInChunks,
  type ChunkTranscriber,
  type ChunkedTranscribeOptions,
} from './chunked-transcribe.js';
export { MockProvider };
export * from './provider-defaults.js';
export { ResilientProvider, withResilience, type ResilientProviderOptions };

const DEFAULT_PROVIDER: ProviderName = 'mock';

const readEnv = (key: string): string | undefined => {
  // `process` may be absent in browser bundles; guard defensively.
  const env = typeof process !== 'undefined' ? process.env : undefined;
  return env?.[key];
};

/**
 * Build a config from env keys, omitting absent values entirely so the result
 * satisfies `exactOptionalPropertyTypes` (optional props are never `undefined`).
 */
function buildConfig(
  name: ProviderName,
  keys: { apiKey?: string; model?: string; baseUrl?: string },
): ProviderConfig {
  const config: { name: ProviderName; apiKey?: string; model?: string; baseUrl?: string } = {
    name,
  };
  const apiKey = keys.apiKey !== undefined ? readEnv(keys.apiKey) : undefined;
  const model = keys.model !== undefined ? readEnv(keys.model) : undefined;
  const baseUrl = keys.baseUrl !== undefined ? readEnv(keys.baseUrl) : undefined;
  if (apiKey !== undefined) config.apiKey = apiKey;
  if (model !== undefined) config.model = model;
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  return config;
}

/** Resolve provider config from environment variables. */
export function resolveProviderConfig(name: ProviderName): ProviderConfig {
  switch (name) {
    case 'anthropic':
      return buildConfig(name, { apiKey: 'ANTHROPIC_API_KEY', model: 'ANTHROPIC_MODEL' });
    // No API key by design — the credential is the user's Claude Code login, which the
    // Agent SDK reads from the OS keychain. Reading `ANTHROPIC_API_KEY` here would be
    // actively wrong: the SDK prefers an env key over the login, so a stale key in the
    // environment would silently bill an API account the user did not choose.
    case 'claude-agent-sdk':
      return buildConfig(name, { model: 'FRAMEPILOT_CLAUDE_AGENT_SDK_MODEL' });
    case 'nvidia':
      return buildConfig(name, {
        apiKey: 'NVIDIA_API_KEY',
        model: 'NVIDIA_MODEL',
        baseUrl: 'NVIDIA_BASE_URL',
      });
    case 'openrouter':
      return buildConfig(name, {
        apiKey: 'OPENROUTER_API_KEY',
        model: 'OPENROUTER_MODEL',
        baseUrl: 'OPENROUTER_BASE_URL',
      });
    // `AI_GATEWAY_API_KEY` is Vercel's own name for this credential (what `vercel env
    // pull` writes and what the gateway docs use), so a host that already runs other
    // Vercel tooling needs no second variable. OIDC tokens are deliberately not read:
    // they are short-lived and refreshed by the Vercel CLI, which a desktop editor
    // cannot assume is installed.
    case 'vercel-gateway':
      return buildConfig(name, {
        apiKey: 'AI_GATEWAY_API_KEY',
        model: 'AI_GATEWAY_MODEL',
        baseUrl: 'AI_GATEWAY_BASE_URL',
      });
    case 'groq':
      return buildConfig(name, {
        apiKey: 'GROQ_API_KEY',
        model: 'GROQ_MODEL',
        baseUrl: 'GROQ_BASE_URL',
      });
    case 'google':
      return buildConfig(name, {
        apiKey: 'GOOGLE_API_KEY',
        model: 'GOOGLE_MODEL',
        baseUrl: 'GOOGLE_BASE_URL',
      });
    case 'ollama':
      return buildConfig(name, {
        apiKey: 'OLLAMA_API_KEY',
        model: 'OLLAMA_MODEL',
        baseUrl: 'OLLAMA_BASE_URL',
      });
    case 'deepseek':
      return buildConfig(name, {
        apiKey: 'DEEPSEEK_API_KEY',
        model: 'DEEPSEEK_MODEL',
        baseUrl: 'DEEPSEEK_BASE_URL',
      });
    case 'openai-compatible':
      return buildConfig(name, {
        apiKey: 'FRAMEPILOT_OPENAI_COMPATIBLE_API_KEY',
        model: 'FRAMEPILOT_OPENAI_COMPATIBLE_MODEL',
        baseUrl: 'FRAMEPILOT_OPENAI_COMPATIBLE_BASE_URL',
      });
    case 'mock':
      return { name };
  }
}

/**
 * The LangChain adapter for a provider, loaded on first use.
 *
 * WHY lazy rather than a plain import: a static import puts every chat SDK into every
 * consumer's module graph, including the browser bundle, whether or not the user has
 * selected that provider. It also broke the web-editor build outright — Rollup cannot
 * resolve the Anthropic SDK's `lib/transform-json-schema` subpath export.
 *
 * This mattered more once the native adapters were deleted (ADR 0105) and this became
 * the only path: the browser now genuinely runs these adapters, so what loads is a real
 * download rather than dead weight. `loadLangChainAdapter` therefore imports **one
 * provider's module**, not the roster.
 *
 * `modelId` is answered without loading anything, from the same config field and
 * default the real adapter uses, so context-occupancy sizing is correct from the
 * first render rather than after the first model call.
 */
class LazyLoadedProvider implements AiProvider {
  public readonly name: ProviderName;

  private delegate: AiProvider | null = null;

  public constructor(
    private readonly config: ProviderConfig,
    private readonly defaultModel: string,
    /** Imports the concrete adapter. Deferred so nothing loads until a call is made. */
    private readonly loader: (config: ProviderConfig) => Promise<AiProvider>,
  ) {
    this.name = config.name;
  }

  public get modelId(): string {
    return this.config.model ?? this.defaultModel;
  }

  public async complete(
    ...args: Parameters<AiProvider['complete']>
  ): ReturnType<AiProvider['complete']> {
    return (await this.load()).complete(...args);
  }

  public async *stream(
    request: Parameters<NonNullable<AiProvider['stream']>>[0],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    const provider = await this.load();
    /* v8 ignore next -- every LangChain adapter implements stream() */
    if (provider.stream === undefined) throw new Error('LangChain provider cannot stream.');
    yield* provider.stream(request, signal);
  }

  private async load(): Promise<AiProvider> {
    this.delegate ??= await this.loader(this.config);
    return this.delegate;
  }
}

/**
 * The default model each provider reports before its adapter loads.
 *
 * `modelId` is read synchronously — `model-capabilities.ts` sizes context occupancy from
 * it before any call is made — so it cannot wait on the lazy import. The values come from
 * `provider-defaults.ts`, the single source both this table and the adapters read, so
 * there is nothing left to drift.
 */
const LANGCHAIN_DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  groq: GROQ_DEFAULT_MODEL,
  google: GOOGLE_DEFAULT_MODEL,
  ollama: OLLAMA_DEFAULT_MODEL,
  deepseek: DEEPSEEK_DEFAULT_MODEL,
  openrouter: OPENROUTER_DEFAULT_MODEL,
  'vercel-gateway': VERCEL_GATEWAY_DEFAULT_MODEL,
  nvidia: NVIDIA_DEFAULT_MODEL,
  'openai-compatible': OPENAI_COMPATIBLE_DEFAULT_MODEL,
};

/** Provider names the LangChain path can serve — everything except `mock`. */
export const LANGCHAIN_SERVABLE: readonly ProviderName[] = Object.keys(
  LANGCHAIN_DEFAULT_MODELS,
) as ProviderName[];

/**
 * Import one provider's adapter.
 *
 * Anthropic is its own module because it carries the cache-breakpoint message shaping no
 * other provider has. The rest share `langchain-providers.ts`, which today statically
 * imports all six chat SDKs — so selecting DeepSeek still downloads Groq, Google, Ollama
 * and OpenAI with it (~104 kB gzip for the group). That is one lazy chunk fetched on first
 * real AI use, not startup cost, and splitting it per provider is tracked as follow-up
 * work: it is a self-contained bundling change whose diff is only legible on its own.
 */
async function loadLangChainAdapter(config: ProviderConfig): Promise<AiProvider> {
  if (config.name === 'anthropic') {
    return new (await import('./langchain.js')).LangChainAnthropicProvider(config);
  }
  const { LANGCHAIN_PROVIDERS } = await import('./langchain-providers.js');
  const Adapter = LANGCHAIN_PROVIDERS[config.name as keyof typeof LANGCHAIN_PROVIDERS];
  return new Adapter(config);
}

/**
 * Instantiate a provider from a fully-resolved {@link ProviderConfig}.
 *
 * Every hosted provider goes through {@link LazyLoadedProvider}, which defers loading
 * the chat SDK until the first call. That laziness is load-bearing in the browser: the
 * adapters are one dynamic `import()` per provider, so selecting DeepSeek does not also
 * download Groq, Google, Ollama and OpenAI.
 */
function instantiateProvider(config: ProviderConfig): AiProvider {
  if (config.name === 'mock') return new MockProvider();
  // Not a LangChain provider and not an HTTP one: it spawns the `claude` binary, so it
  // is Node-only. The dynamic import is what keeps it out of the renderer's module graph
  // (`claude-agent-sdk.ts` explains why its own SDK specifiers are non-analyzable too).
  if (config.name === 'claude-agent-sdk') {
    return new LazyLoadedProvider(config, CLAUDE_AGENT_SDK_DEFAULT_MODEL, async (resolved) => {
      const { ConcreteClaudeAgentSdkProvider } = await import('./claude-agent-sdk.js');
      return new ConcreteClaudeAgentSdkProvider(resolved);
    });
  }
  const defaultModel = LANGCHAIN_DEFAULT_MODELS[config.name];
  /* v8 ignore next 3 -- unreachable: every non-mock ProviderName has a default above, and
     the roster test asserts exactly that. Kept as a typed guard rather than a `!`. */
  if (defaultModel === undefined) {
    throw new Error(`No LangChain adapter is registered for provider "${config.name}".`);
  }
  return new LazyLoadedProvider(config, defaultModel, async (resolved) =>
    loadLangChainAdapter(resolved),
  );
}

/** Create an {@link AiProvider} by name (defaults to env, then `mock`). */
export function createProvider(name?: ProviderName): AiProvider {
  const resolved: ProviderName =
    name ?? (readEnv('FRAMEPILOT_AI_PROVIDER') as ProviderName | undefined) ?? DEFAULT_PROVIDER;
  return instantiateProvider(resolveProviderConfig(resolved));
}

/**
 * Build a provider from a config the **host** already resolved, rather than from env.
 *
 * The desktop main process and the browser renderer each own their own settings store
 * (electron-store / localStorage), so neither can go through {@link createProvider}'s
 * env resolution. Before ADR 0105 both worked around that by importing the concrete
 * native adapter classes and constructing them directly — which meant three places knew
 * how to map a provider name to an implementation, and the LangChain path reached none
 * of them. This is the one seam, so a host supplies configuration and nothing else.
 */
export function createProviderFromConfig(config: ProviderConfig): AiProvider {
  return instantiateProvider(config);
}

/**
 * Env var prefix for each {@link ModelTier}'s provider/model override.
 *
 * WHY a table rather than `tier.toUpperCase()`: the env names are a published contract
 * (`.env.example`, `turbo.json` `globalEnv`), so the mapping is written out where a
 * reader can compare it against those files by eye.
 */
const TIER_ENV_PREFIX: Readonly<Record<ModelTier, string>> = {
  small: 'FRAMEPILOT_TIER_SMALL',
  mid: 'FRAMEPILOT_TIER_MID',
  large: 'FRAMEPILOT_TIER_LARGE',
};

const TIER_ORDER: readonly ModelTier[] = ['small', 'mid', 'large'];

/**
 * Resolve the per-tier provider overrides (`FRAMEPILOT_TIER_<TIER>_PROVIDER` / `_MODEL`).
 *
 * The point of tiering is that the cheap, mechanical calls — today the ADR 0055 route
 * classifier, which is stamped `tier: 'small'` — need not run on the same expensive model
 * as the editing turns. This is the one place that reads those variables.
 *
 * **Opt-in by construction.** A tier with neither variable set yields NO entry, and a
 * runtime with no entry for a tier uses the host-selected provider exactly as before. That
 * is what keeps an unconfigured install — and the golden-eval baseline — byte-identical.
 *
 * The tier's config starts from that provider's own env resolution, so its API key and
 * base URL come from the same variables the provider always used; only the model is
 * layered on top. An unset `_MODEL` therefore means "whatever that provider's configured
 * or default model is", not "no model".
 *
 * @param base - The host-selected provider, used when only `_MODEL` is overridden.
 * @param env - Environment to read (injectable for tests).
 * @returns One {@link ProviderConfig} per overridden tier; tiers left alone are absent.
 * @throws If a `_PROVIDER` value is not a known {@link ProviderName}.
 */
export function resolveTierProviderConfigs(
  base: ProviderName,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = typeof process !== 'undefined'
    ? process.env
    : {},
): Partial<Record<ModelTier, ProviderConfig>> {
  const configs: Partial<Record<ModelTier, ProviderConfig>> = {};
  for (const tier of TIER_ORDER) {
    const prefix = TIER_ENV_PREFIX[tier];
    const providerVar = `${prefix}_PROVIDER`;
    const modelVar = `${prefix}_MODEL`;
    const providerRaw = env[providerVar]?.trim();
    const modelRaw = env[modelVar]?.trim();
    if (!providerRaw && !modelRaw) continue;
    let name: ProviderName = base;
    if (providerRaw) {
      if (!isProviderName(providerRaw)) {
        throw new Error(
          `${providerVar}="${providerRaw}" is not a known provider. Expected one of: ${PROVIDER_NAMES.join(', ')}.`,
        );
      }
      name = providerRaw;
    }
    const resolved = resolveProviderConfig(name);
    configs[tier] = modelRaw ? { ...resolved, model: modelRaw } : resolved;
  }
  return configs;
}

/** Create a provider already wrapped in the shared reliability policy. */
export function createResilientProvider(
  name?: ProviderName,
  options?: ResilientProviderOptions,
): ResilientProvider {
  return withResilience(createProvider(name), options);
}

// ---------------------------------------------------------------------------
// ASR (speech-to-text) provider selection
// ---------------------------------------------------------------------------

/** Explicit app-config overrides layered on top of environment resolution. */
export interface AsrConfigOverrides {
  /** TwelveLabs API key. Local transcription ignores it. */
  readonly apiKey?: string;
  /** Local model id override. TwelveLabs chooses its indexed transcription model. */
  readonly model?: string;
  /** Engine sidecar base URL. */
  readonly baseUrl?: string;
}

/**
 * Resolve the only two active speech-to-text choices: Local and TwelveLabs.
 * Legacy Groq/NVIDIA values are migration input only and deterministically become Local,
 * ensuring an old stored preference never sends media to a different hosted provider.
 */
export function resolveAsrProviderConfig(
  name?: AsrProviderName,
  overrides?: AsrConfigOverrides,
): AsrProviderConfig {
  const persisted =
    name ??
    (readEnv('FRAMEPILOT_ASR_PROVIDER') as AsrProviderName | undefined) ??
    DEFAULT_ASR_PROVIDER;
  const resolved: UserAsrProviderName = migrateAsrProviderName(persisted);

  if (resolved === 'twelvelabs') {
    const config: { provider: 'twelvelabs'; apiKey?: string; baseUrl?: string } = {
      provider: 'twelvelabs',
    };
    const apiKey = overrides?.apiKey ?? readEnv('TWELVELABS_API_KEY');
    const baseUrl = overrides?.baseUrl ?? readEnv('FRAMEPILOT_ENGINE_BASE_URL');
    if (apiKey !== undefined) config.apiKey = apiKey;
    if (baseUrl !== undefined) config.baseUrl = baseUrl;
    return config;
  }

  const config: { provider: 'whisper-cli'; baseUrl: string; model?: string } = {
    provider: 'whisper-cli',
    baseUrl: overrides?.baseUrl ?? readEnv('FRAMEPILOT_ENGINE_BASE_URL') ?? DEFAULT_ENGINE_BASE_URL,
  };
  const model = overrides?.model ?? readEnv('FRAMEPILOT_ASR_MODEL');
  if (model !== undefined) config.model = model;
  return config;
}

/**
 * Construct Local or TwelveLabs transcription. New runs cannot instantiate the retired
 * Groq/NVIDIA adapters even when a legacy name is passed: it is migrated to Local first.
 */
export function createAsrProvider(
  name?: AsrProviderName,
  overrides?: AsrConfigOverrides,
  fetchFn?: typeof fetch,
): LocalWhisperCliClient | TwelveLabsTranscriptionProvider {
  const config = resolveAsrProviderConfig(name, overrides);
  if (config.provider === 'twelvelabs') {
    return new TwelveLabsTranscriptionProvider(
      config,
      fetchFn as ConstructorParameters<typeof TwelveLabsTranscriptionProvider>[1],
    );
  }
  return new LocalWhisperCliClient(
    config.baseUrl ?? DEFAULT_ENGINE_BASE_URL,
    fetchFn as ConstructorParameters<typeof LocalWhisperCliClient>[1],
  );
}
