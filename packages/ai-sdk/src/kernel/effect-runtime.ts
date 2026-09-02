/**
 * @framepilot/ai-sdk/kernel/effect-runtime — the execution plane
 * (plan/AI-ORCHESTRATION-REDESIGN.md §4/§10, Phase K0.3).
 *
 * The Effect Runtime is the one privileged boundary where side effects happen —
 * the kernel's "syscall" layer. The pure Conductor emits inert RuntimeEffect
 * descriptions; the runtime interprets them: it runs the host tool executor or
 * model provider, relays the caller's {@link AbortSignal} (the only cancellation
 * channel — see {@link EffectRuntime}), and dedups only effects whose canonical
 * tool contract permits caching and that declare a safe idempotency key.
 */
import { createLogger } from '@framepilot/shared-types';
import type { AiProvider, AiResponse, ProviderChunk } from '../providers/types.js';
import { MAX_IDENTITY_KEY_CHARS, boundedKeySegment } from '../stable-key.js';
import { toolContract } from '../tool-contract.js';
import { getTool } from '../tool-registry.js';
import {
  type HostToolExecutor,
  type HostToolOutcome,
  outcomeFromExecutorError,
} from '../tool-executor.js';
import type {
  HostToolEffect,
  ModelEffect,
  ModelStreamEffect,
  NonStreamingRuntimeEffect,
  RuntimeEffect,
  StructuredRuntimeEffect,
} from './effects.js';
import type { ModelTier } from './proposers/types.js';
import type { JsonValue } from '../run-contracts.js';

const log = createLogger('ai-sdk:kernel:effect-runtime');
const DEFAULT_MODEL_TIER: ModelTier = 'mid';

export interface HostToolEffectResult {
  readonly kind: 'host_tool';
  readonly outcome: HostToolOutcome;
  readonly cached: boolean;
}

export interface ModelEffectResult {
  readonly kind: 'model';
  readonly response: AiResponse;
  readonly cached: boolean;
}

export interface ModelStreamEffectResult {
  readonly kind: 'model_stream';
  readonly chunks: readonly ProviderChunk[];
  readonly cached: boolean;
}

export interface StructuredEffectResult {
  readonly kind: 'structured';
  readonly effectKind: StructuredRuntimeEffect['kind'];
  readonly outcome: JsonValue;
  readonly cached: boolean;
}

export type EffectResult =
  | HostToolEffectResult
  | ModelEffectResult
  | ModelStreamEffectResult
  | StructuredEffectResult;

export interface StructuredEffectExecutor {
  run(effect: StructuredRuntimeEffect, signal?: AbortSignal): Promise<JsonValue>;
}

export interface EffectRuntimeObserver {
  onRequested(effect: RuntimeEffect): void | Promise<void>;
  onSettled(effect: RuntimeEffect, result: EffectResult): void | Promise<void>;
  onFailed(effect: RuntimeEffect, error: unknown): void | Promise<void>;
}

export interface EffectRuntimeDeps {
  readonly provider: AiProvider;
  /**
   * Per-{@link ModelTier} provider overrides (goal.md Workstream E). A model effect
   * stamped with a tier present here runs on that provider; every other effect — and
   * every tier absent from this map — runs on {@link EffectRuntimeDeps.provider}.
   *
   * Opt-in and normally absent: hosts build it from `resolveTierProviderConfigs`, which
   * returns nothing unless `FRAMEPILOT_TIER_*` is set. With it absent, this runtime
   * behaves exactly as it did when tiers were telemetry-only.
   */
  readonly tierProviders?: Partial<Record<ModelTier, AiProvider>>;
  readonly executor?: HostToolExecutor;
  readonly structuredExecutor?: StructuredEffectExecutor;
  readonly observer?: EffectRuntimeObserver;
}

/**
 * The runtime's interface. Note what is NOT on it: a `cancel(effectId)` method.
 *
 * **`AbortSignal` is the only cancellation channel.** Every entry point takes the run's
 * signal and threads it to the provider, the host executor and the structured executor;
 * the user's Stop, the orchestrator's own teardown and a structured effect's timeout all
 * travel that way, and it is the mechanism that actually ends a run today.
 *
 * There used to be a second one — `cancel`/`cancelTree`, backed by a registry of live
 * effects — and it was inert in the way that matters most: `host_tool` and `model` effects
 * carry no {@link EffectControl}, so they have no `effectId` to be cancelled BY, were never
 * registered, and could not be reached by it at all. It had no production caller in this
 * repo; the only callers were its own tests and a pass-through in `kernel/replay`. Two
 * cancellation mechanisms where one cannot reach the effects that do the work is how the
 * next reader wires the wrong one and believes a run is stoppable when it is not.
 *
 * If a future scheduler genuinely needs to cancel ONE effect out of many in flight, the
 * missing piece is an identity on host/model effects, not a second channel: give them an
 * `EffectControl` and the existing signal plumbing carries it.
 */
export interface EffectRuntime {
  run(effect: NonStreamingRuntimeEffect, signal?: AbortSignal): Promise<EffectResult>;
  streamModel?(
    effect: ModelStreamEffect,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderChunk, ModelStreamEffectResult>;
}

export class EffectTimeoutError extends Error {
  public override readonly name = 'EffectTimeoutError';

  public constructor(
    public readonly effectId: string,
    timeoutMs: number,
  ) {
    super(`Effect "${effectId}" exceeded its ${timeoutMs}ms timeout.`);
  }
}

/**
 * Readable characters of a tool call's arguments kept in its cache key, before the rest
 * is replaced by a digest. The remaining budget under {@link MAX_IDENTITY_KEY_CHARS}
 * (the run contract's cap, `run-contracts.ts`'s `identityKeySchema`) covers `host_tool:`
 * and the tool name, with headroom kept deliberately: it was sized when keys also carried
 * a `:rev:N` suffix, and a reserve that leaves the cap unbreached is not worth re-tuning
 * for a few characters of readability.
 */
const TOOL_ARGUMENT_KEY_RESERVE_CHARS = 106;
const TOOL_ARGUMENT_KEY_CHARS = MAX_IDENTITY_KEY_CHARS - TOOL_ARGUMENT_KEY_RESERVE_CHARS;

/**
 * The idempotency key for an effect, or `undefined` when it must always run fresh.
 *
 * The tool's canonical {@link ToolContract} — not the caller — decides whether a result
 * may be reused at all, and what state its identity must include:
 *
 *  - `none` ⇒ never memoized, and an explicit key CANNOT override that. This is what
 *    keeps `render_preview`/`export_video` (which take `{}`, so every call would
 *    otherwise collide) and the `transcribe`/`index_media` host mutations honest — and
 *    now also every host read of the timeline, the bin or the transcript, because a run
 *    changes all three underneath its own questions.
 *  - `asset_content`/`run` ⇒ keyed by name + args, since the answer depends on media
 *    content rather than on timeline state (this is the orchestrator's T5 per-run
 *    analysis cache, generalized). Sound only because originals are never mutated.
 *
 * There is no revision-keyed tier. It existed, `tool-contract.ts#ToolCacheScope` says why
 * it went, and re-adding one here would need that argument answered first: the key would
 * have to name state the tool's answer actually depends on, and `Timeline.revision` does
 * not.
 *
 * A model effect is deduped only when it declares an explicit key — model calls are
 * non-deterministic, so silent memoization would be surprising.
 */
export function idempotencyKeyFor(effect: RuntimeEffect): string | undefined {
  if (effect.kind === 'host_tool') {
    const tool = getTool(effect.call.name);
    if (!tool) return undefined;
    const { cacheScope } = toolContract(tool);
    if (cacheScope === 'none') return undefined;
    if (effect.idempotencyKey !== undefined) return effect.idempotencyKey;
    // Bounded, not verbatim: this key is recorded in the run snapshot, whose contract
    // caps it at 256 characters. Serialising the arguments in full made the cap a
    // function of how much editing one call did — a montage call carrying thirty
    // segments breached it and took the whole run's snapshot down with it.
    return `host_tool:${effect.call.name}:${boundedKeySegment(
      JSON.stringify(effect.call.arguments),
      TOOL_ARGUMENT_KEY_CHARS,
    )}`;
  }
  if (effect.kind === 'model') return effect.idempotencyKey;
  if (effect.kind === 'model_stream') return undefined;
  return effect.control.idempotencyKey;
}

/** Whether a settled result may be memoized (only successes are cacheable). */
function isCacheable(result: EffectResult): boolean {
  if (result.kind === 'host_tool') {
    return result.outcome.status === 'completed' || result.outcome.status === 'warning';
  }
  return true;
}

async function* streamProvider(
  provider: AiProvider,
  effect: ModelStreamEffect,
  signal?: AbortSignal,
): AsyncGenerator<ProviderChunk> {
  if (provider.stream) {
    yield* provider.stream(effect.request, signal);
    return;
  }
  const response = await provider.complete(effect.request, signal);
  if (response.reasoning) yield { type: 'reasoning-delta', text: response.reasoning };
  if (response.text) yield { type: 'text-delta', text: response.text };
  for (const call of response.toolCalls ?? []) yield { type: 'tool-call', call };
  if (response.usage) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
      },
    };
  }
  yield { type: 'done', text: response.text };
}

export function createEffectRuntime(deps: EffectRuntimeDeps): EffectRuntime {
  const memo = new Map<string, Promise<EffectResult>>();

  const runHostTool = async (
    effect: HostToolEffect,
    signal?: AbortSignal,
  ): Promise<HostToolEffectResult> => {
    log.action('runHostTool → dispatching', {
      tool: effect.call.name,
      args: effect.call.arguments,
    });
    if (!deps.executor) {
      log.warn('runHostTool → no executor connected', { tool: effect.call.name });
      return {
        kind: 'host_tool',
        cached: false,
        outcome: {
          status: 'failed',
          summary: `Cannot run "${effect.call.name}" — no analysis engine is connected.`,
        },
      };
    }
    let outcome: HostToolOutcome;
    try {
      outcome = await deps.executor.run(
        effect.call,
        {
          project: effect.project,
          ...(effect.interaction === undefined ? {} : { interaction: effect.interaction }),
          ...(effect.analysisBudget === undefined ? {} : { analysisBudget: effect.analysisBudget }),
        },
        signal,
      );
    } catch (error) {
      outcome = outcomeFromExecutorError(effect.call, error, signal?.aborted ?? false);
    }
    log.action('runHostTool ← settled', {
      tool: effect.call.name,
      status: outcome.status,
      summary: outcome.summary,
    });
    return { kind: 'host_tool', outcome, cached: false };
  };

  /** The provider serving one tier: its override when configured, else the base. */
  const providerForTier = (tier: ModelTier): AiProvider =>
    deps.tierProviders?.[tier] ?? deps.provider;

  const runModel = async (
    effect: ModelEffect,
    signal?: AbortSignal,
  ): Promise<ModelEffectResult> => {
    const tier = effect.tier ?? DEFAULT_MODEL_TIER;
    const provider = providerForTier(tier);
    log.action('runModel → request', {
      tier,
      provider: provider.name,
      model: provider.modelId,
      messages: effect.request.messages.length,
    });
    const response = await provider.complete(effect.request, signal);
    log.action('runModel ← response', {
      tier,
      provider: provider.name,
      model: provider.modelId,
      textChars: response.text.length,
      toolCalls: response.toolCalls?.length ?? 0,
      usage: response.usage,
    });
    return { kind: 'model', response, cached: false };
  };

  const runStructured = async (
    effect: StructuredRuntimeEffect,
    signal?: AbortSignal,
  ): Promise<StructuredEffectResult> => {
    if (!deps.structuredExecutor) {
      throw new Error(`No executor is registered for effect "${effect.kind}".`);
    }
    log.action('runStructured → dispatching', {
      effectId: effect.control.effectId,
      kind: effect.kind,
      resourceClass: effect.control.resourceClass,
    });
    const outcome = await deps.structuredExecutor.run(effect, signal);
    log.action('runStructured ← settled', {
      effectId: effect.control.effectId,
      kind: effect.kind,
    });
    return { kind: 'structured', effectKind: effect.kind, outcome, cached: false };
  };

  const execute = (
    effect: NonStreamingRuntimeEffect,
    signal?: AbortSignal,
  ): Promise<EffectResult> => {
    if (effect.kind === 'host_tool') return runHostTool(effect, signal);
    if (effect.kind === 'model') return runModel(effect, signal);
    return runStructured(effect, signal);
  };

  const retryAttempts = (effect: StructuredRuntimeEffect): number => {
    if (effect.control.sideEffectClass === 'commit') return 1;
    switch (effect.control.retryClass) {
      case 'never':
      case 'revision_conflict':
        return 1;
      case 'transient':
      case 'repair_once':
        return 2;
      case 'rate_limited':
        return 3;
    }
  };

  const runStructuredWithPolicy = async (
    effect: StructuredRuntimeEffect,
    parentSignal?: AbortSignal,
  ): Promise<EffectResult> => {
    if (!Number.isFinite(effect.control.timeoutMs) || effect.control.timeoutMs <= 0) {
      throw new Error(`Effect "${effect.control.effectId}" requires a positive timeout.`);
    }
    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) relayAbort();
    else parentSignal?.addEventListener('abort', relayAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(new EffectTimeoutError(effect.control.effectId, effect.control.timeoutMs)),
      effect.control.timeoutMs,
    );
    try {
      const attempts = retryAttempts(effect);
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          return await execute(effect, controller.signal);
        } catch (error) {
          if (controller.signal.aborted || attempt >= attempts) throw error;
          log.warn('effect attempt failed; retrying', {
            effectId: effect.control.effectId,
            kind: effect.kind,
            attempt,
            attempts,
            retryClass: effect.control.retryClass,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (controller.signal.reason instanceof EffectTimeoutError) {
        throw controller.signal.reason;
      }
      throw error;
      /* v8 ignore start */
    } finally {
      /* v8 ignore stop */
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', relayAbort);
    }
  };

  const executeWithPolicy = (
    effect: NonStreamingRuntimeEffect,
    signal?: AbortSignal,
  ): Promise<EffectResult> =>
    effect.kind === 'host_tool' || effect.kind === 'model'
      ? execute(effect, signal)
      : runStructuredWithPolicy(effect, signal);

  const asHit = (memoized: Promise<EffectResult>): Promise<EffectResult> =>
    memoized.then((result) => ({ ...result, cached: true }));

  return {
    async *streamModel(effect, signal) {
      await deps.observer?.onRequested(effect);
      const tier = effect.tier ?? DEFAULT_MODEL_TIER;
      const provider = providerForTier(tier);
      const chunks: ProviderChunk[] = [];
      let terminalObserved = false;
      try {
        log.action('streamModel → request', {
          tier,
          provider: provider.name,
          model: provider.modelId,
          messages: effect.request.messages.length,
        });
        for await (const chunk of streamProvider(provider, effect, signal)) {
          chunks.push(chunk);
          yield chunk;
        }
        const result: ModelStreamEffectResult = {
          kind: 'model_stream',
          chunks,
          cached: false,
        };
        terminalObserved = true;
        await deps.observer?.onSettled(effect, result);
        log.action('streamModel ← settled', {
          tier,
          provider: provider.name,
          model: provider.modelId,
          chunks: chunks.length,
        });
        return result;
      } catch (error) {
        terminalObserved = true;
        await deps.observer?.onFailed(effect, error);
        throw error;
        /* v8 ignore start */
      } finally {
        /* v8 ignore stop */
        if (!terminalObserved) {
          await deps.observer?.onFailed(
            effect,
            signal?.reason ?? new Error('Model stream consumption ended before settlement.'),
          );
        }
      }
    },
    async run(effect, signal) {
      await deps.observer?.onRequested(effect);
      const key = idempotencyKeyFor(effect);
      try {
        let pending: Promise<EffectResult>;
        if (key !== undefined) {
          const hit = memo.get(key);
          if (hit) {
            log.action('effect served from cache', { key, kind: effect.kind });
            pending = asHit(hit);
          } else {
            pending = executeWithPolicy(effect, signal);
            memo.set(key, pending);
          }
        } else {
          pending = executeWithPolicy(effect, signal);
        }
        const result = await pending;
        if (key !== undefined && !isCacheable(result)) memo.delete(key);
        await deps.observer?.onSettled(effect, result);
        return result;
      } catch (error) {
        if (key !== undefined) memo.delete(key);
        await deps.observer?.onFailed(effect, error);
        throw error;
      }
    },
  };
}
