import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { createLogger } from '@framepilot/shared-types';
import { ProviderError } from '../reliability/types.js';
import { OpenAiStyleProvider, baseOptions } from './langchain-provider-shared.js';
import {
  NVIDIA_BASE_URL,
  NVIDIA_DEFAULT_MODEL,
  OPENAI_COMPATIBLE_DEFAULT_MODEL,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  VERCEL_GATEWAY_BASE_URL,
  VERCEL_GATEWAY_DEFAULT_MODEL,
} from './provider-defaults.js';
import type { AiCompletionRequest, AiResponse, ProviderChunk } from './types.js';

const log = createLogger('ai-sdk:providers:openai-compatible');

abstract class OpenAiCompatibleProvider extends OpenAiStyleProvider {
  /**
   * The endpoint to use when the host configured none. `undefined` for a provider that
   * has no service of its own to fall back to — see {@link resolveBaseUrl}.
   */
  protected abstract get defaultBaseUrl(): string | undefined;

  /**
   * The endpoint this request will actually go to.
   *
   * Throws rather than defaulting when there is nothing to fall back to. `bad_request`
   * makes it non-retryable (`isRetryableKind`), because a missing URL is a settings
   * problem: retrying it three times only delays the message the user needs to read.
   */
  private resolveBaseUrl(): string {
    const resolved = this.config.baseUrl ?? this.defaultBaseUrl;
    if (resolved === undefined || resolved.trim() === '') {
      throw new ProviderError(
        `Provider "${this.name}" has no server URL configured. Set one in Settings → AI (for example http://127.0.0.1:8317/v1), or via the FRAMEPILOT_OPENAI_COMPATIBLE_BASE_URL environment variable.`,
        'bad_request',
      );
    }
    return resolved;
  }

  /** The key sent as `Authorization: Bearer`. Absent when the host configured none. */
  protected get resolvedApiKey(): string | undefined {
    return this.config.apiKey;
  }

  /**
   * Set once this endpoint has told us it rejects `temperature`, so the whole
   * session stops sending it. Per instance: two configured endpoints can disagree.
   */
  private temperatureRejected = false;

  protected buildModel(request: AiCompletionRequest, streaming: boolean): BaseChatModel {
    const temperature = this.temperatureRejected ? undefined : request.temperature;
    return new ChatOpenAI({
      ...baseOptions(this.modelId, this.resolvedApiKey, streaming),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      configuration: { baseURL: this.resolveBaseUrl() },
    }) as unknown as BaseChatModel;
  }

  /**
   * Learn, once, that this endpoint does not take `temperature` when it says so.
   *
   * "OpenAI-compatible" is a wire format, not a guarantee about which parameters a
   * given model accepts. A reasoning model behind a local gateway answers
   * `Unsupported parameter: temperature` and fails the call outright — which is why
   * the line building it had been commented out locally: with it, every request to
   * such an endpoint failed, so nothing worked at all.
   *
   * Deleting the parameter for everyone is the wrong trade (it silently ignores the
   * temperature every other endpoint honours), and guessing from the model name is
   * worse here than elsewhere: this provider exists to address arbitrary servers by
   * URL, so the name tells us nothing. The endpoint already knows the answer and
   * says so, so ask it once and remember.
   */
  private rejectsTemperature(error: unknown, request: AiCompletionRequest): boolean {
    if (this.temperatureRejected || request.temperature === undefined) return false;
    const message = error instanceof Error ? error.message : String(error);
    return /unsupported[^.]*\btemperature\b|\btemperature\b[^.]*not supported/i.test(message);
  }

  /**
   * Turn a temperature-rejection into a retry `resilient-provider.ts` will actually
   * run, instead of a second call made from inside this one.
   *
   * `ResilientProvider` is documented as the single retry authority (§5.1,
   * `langchain-chat.ts`): every retry is supposed to go through its `withRetry`, so
   * its retry-count telemetry sees it and its connect timeout is sized per attempt.
   * A `bad_request` `ProviderError` is non-retryable by default (correctly — most
   * bad requests won't succeed on a replay), so this overrides `retryable` for this
   * one instance: `temperatureRejected` is already set by the time this throws, so
   * the attempt `ResilientProvider` makes calls back into `buildModel` without the
   * parameter and succeeds — one genuine retry, accounted for where every other
   * retry in this system is.
   */
  private asRetryableAfterLearning(error: unknown): ProviderError {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof ProviderError
      ? new ProviderError(message, error.kind, {
          ...(error.status !== undefined ? { status: error.status } : {}),
          retryable: true,
        })
      : new ProviderError(message, 'bad_request', { retryable: true });
  }

  public override async complete(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): Promise<AiResponse> {
    try {
      return await super.complete(request, signal);
    } catch (error) {
      if (!this.rejectsTemperature(error, request)) throw error;
      this.temperatureRejected = true;
      log.action('endpoint rejects temperature — retrying without it', {
        provider: this.name,
        model: this.modelId,
      });
      throw this.asRetryableAfterLearning(error);
    }
  }

  public override async *stream(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ProviderChunk> {
    let yielded = false;
    try {
      for await (const chunk of super.stream(request, signal)) {
        yielded = true;
        yield chunk;
      }
    } catch (error) {
      // Only retry a request that never produced output; replaying a partially
      // consumed stream would duplicate tokens and tool calls.
      if (yielded || !this.rejectsTemperature(error, request)) throw error;
      this.temperatureRejected = true;
      log.action('endpoint rejects temperature — retrying stream without it', {
        provider: this.name,
        model: this.modelId,
      });
      throw this.asRetryableAfterLearning(error);
    }
  }
}

export class ConcreteLangChainOpenRouterProvider extends OpenAiCompatibleProvider {
  public readonly name = 'openrouter' as const;
  public get modelId(): string {
    return this.config.model ?? OPENROUTER_DEFAULT_MODEL;
  }
  protected get defaultBaseUrl(): string {
    return OPENROUTER_BASE_URL;
  }
}

export class ConcreteLangChainVercelGatewayProvider extends OpenAiCompatibleProvider {
  public readonly name = 'vercel-gateway' as const;
  public get modelId(): string {
    return this.config.model ?? VERCEL_GATEWAY_DEFAULT_MODEL;
  }
  protected get defaultBaseUrl(): string {
    return VERCEL_GATEWAY_BASE_URL;
  }
}

export class ConcreteLangChainNvidiaProvider extends OpenAiCompatibleProvider {
  public readonly name = 'nvidia' as const;
  public get modelId(): string {
    return this.config.model ?? NVIDIA_DEFAULT_MODEL;
  }
  protected get defaultBaseUrl(): string {
    return NVIDIA_BASE_URL;
  }
}

/**
 * A server the host runs or chose, addressed only by URL.
 *
 * The wire format is identical to OpenRouter's and NVIDIA's above — the difference is
 * entirely in configuration: no endpoint of its own, and no key required, because the
 * usual target is a process on localhost.
 */
export class ConcreteLangChainOpenAiCompatibleProvider extends OpenAiCompatibleProvider {
  public readonly name = 'openai-compatible' as const;
  public get modelId(): string {
    return this.config.model ?? OPENAI_COMPATIBLE_DEFAULT_MODEL;
  }
  protected get defaultBaseUrl(): undefined {
    return undefined;
  }
  /**
   * A local server usually wants no credential, but the OpenAI client refuses to start
   * without one ("OpenAI or Azure OpenAI API key not found"). Sending a placeholder keeps
   * a keyless gateway reachable; a server that does check the header gets the real key.
   */
  protected override get resolvedApiKey(): string {
    return this.config.apiKey ?? PLACEHOLDER_API_KEY;
  }
}

/** Sent when the host configured no key, purely to satisfy the OpenAI client's own check. */
const PLACEHOLDER_API_KEY = 'not-needed';
