/**
 * Lightweight lazy LangChain provider roster.
 *
 * This module intentionally imports no hosted provider SDK. The factory can load this
 * tiny roster on first AI use, then the selected wrapper imports only its concrete
 * provider module. OpenRouter/Vercel AI Gateway/NVIDIA share the OpenAI client module;
 * every other SDK is isolated in its own dynamic chunk.
 */
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ProviderChunk,
  ProviderConfig,
  ProviderName,
} from './types.js';
import {
  DEEPSEEK_DEFAULT_MODEL,
  GOOGLE_DEFAULT_MODEL,
  GROQ_DEFAULT_MODEL,
  NVIDIA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
  OPENAI_COMPATIBLE_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_MODEL,
  VERCEL_GATEWAY_DEFAULT_MODEL,
} from './provider-defaults.js';

type Loader = (config: ProviderConfig) => Promise<AiProvider>;

abstract class LazyRosterProvider implements AiProvider {
  public abstract readonly name: ProviderName;
  protected abstract readonly defaultModel: string;
  protected abstract loadConcrete(config: ProviderConfig): Promise<AiProvider>;
  private delegate: Promise<AiProvider> | null = null;

  public constructor(protected readonly config: ProviderConfig) {}

  public get modelId(): string {
    return this.config.model ?? this.defaultModel;
  }

  public complete(request: AiCompletionRequest, signal?: AbortSignal): Promise<AiResponse> {
    return this.load().then((provider) => provider.complete(request, signal));
  }

  public async *stream(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    const provider = await this.load();
    if (!provider.stream) throw new Error(`Provider "${this.name}" cannot stream.`);
    yield* provider.stream(request, signal);
  }

  private load(): Promise<AiProvider> {
    this.delegate ??= this.loadConcrete(this.config);
    return this.delegate;
  }
}

const concrete = (loader: Loader): Loader => loader;

export class LangChainGroqProvider extends LazyRosterProvider {
  public readonly name = 'groq' as const;
  protected readonly defaultModel = GROQ_DEFAULT_MODEL;
  protected loadConcrete = concrete(
    async (config) =>
      new (await import('./langchain-groq.js')).ConcreteLangChainGroqProvider(config),
  );
}

export class LangChainGoogleProvider extends LazyRosterProvider {
  public readonly name = 'google' as const;
  protected readonly defaultModel = GOOGLE_DEFAULT_MODEL;
  protected loadConcrete = concrete(
    async (config) =>
      new (await import('./langchain-google.js')).ConcreteLangChainGoogleProvider(config),
  );
}

export class LangChainOllamaProvider extends LazyRosterProvider {
  public readonly name = 'ollama' as const;
  protected readonly defaultModel = OLLAMA_DEFAULT_MODEL;
  protected loadConcrete = concrete(
    async (config) =>
      new (await import('./langchain-ollama.js')).ConcreteLangChainOllamaProvider(config),
  );
}

export class LangChainDeepSeekProvider extends LazyRosterProvider {
  public readonly name = 'deepseek' as const;
  protected readonly defaultModel = DEEPSEEK_DEFAULT_MODEL;
  protected loadConcrete = concrete(
    async (config) =>
      new (await import('./langchain-deepseek.js')).ConcreteLangChainDeepSeekProvider(config),
  );
}

export class LangChainOpenRouterProvider extends LazyRosterProvider {
  public readonly name = 'openrouter' as const;
  protected readonly defaultModel = OPENROUTER_DEFAULT_MODEL;
  protected loadConcrete = concrete(
    async (config) =>
      new (await import('./langchain-openai-compatible.js')).ConcreteLangChainOpenRouterProvider(
        config,
      ),
  );
}

export class LangChainVercelGatewayProvider extends LazyRosterProvider {
  public readonly name = 'vercel-gateway' as const;
  protected readonly defaultModel = VERCEL_GATEWAY_DEFAULT_MODEL;
  protected loadConcrete = concrete(
    async (config) =>
      new (await import('./langchain-openai-compatible.js')).ConcreteLangChainVercelGatewayProvider(
        config,
      ),
  );
}

export class LangChainNvidiaProvider extends LazyRosterProvider {
  public readonly name = 'nvidia' as const;
  protected readonly defaultModel = NVIDIA_DEFAULT_MODEL;
  protected loadConcrete = concrete(
    async (config) =>
      new (await import('./langchain-openai-compatible.js')).ConcreteLangChainNvidiaProvider(
        config,
      ),
  );
}

export class LangChainOpenAiCompatibleProvider extends LazyRosterProvider {
  public readonly name = 'openai-compatible' as const;
  protected readonly defaultModel = OPENAI_COMPATIBLE_DEFAULT_MODEL;
  protected loadConcrete = concrete(
    async (config) =>
      new (
        await import('./langchain-openai-compatible.js')
      ).ConcreteLangChainOpenAiCompatibleProvider(config),
  );
}

export const LANGCHAIN_PROVIDERS = {
  groq: LangChainGroqProvider,
  google: LangChainGoogleProvider,
  ollama: LangChainOllamaProvider,
  deepseek: LangChainDeepSeekProvider,
  openrouter: LangChainOpenRouterProvider,
  'vercel-gateway': LangChainVercelGatewayProvider,
  nvidia: LangChainNvidiaProvider,
  'openai-compatible': LangChainOpenAiCompatibleProvider,
} as const satisfies Record<string, new (config: ProviderConfig) => AiProvider>;

export type LangChainProviderName = keyof typeof LANGCHAIN_PROVIDERS;
