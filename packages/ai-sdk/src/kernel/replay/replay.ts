/**
 * @framepilot/ai-sdk/kernel/replay — record a run's effects, replay it with no model
 * (plan/AI-ORCHESTRATION-REDESIGN.md §16.1 / DoD item 4, Phase K5.3).
 *
 * The kernel is deterministic *given its effect results*: the Conductor is a pure reducer
 * and the driver just threads effect outcomes back through it. So a run is fully
 * reproducible from the **ordered list of {@link EffectResult}s** the runtime produced —
 * no provider, no host tool, no clock. That is the redesign's replay property (DoD item 4:
 * "run replay reproduces a recorded run with no provider calls").
 *
 * {@link createRecordingEffectRuntime} wraps a live runtime and captures each result in
 * call order; {@link createReplayEffectRuntime} is a runtime with **no dependencies at
 * all** that hands those recorded results back in the same order. Replaying asserts the
 * effect *kind* matches what was recorded, so a divergence (the code changed and now asks
 * for a model call where a host tool was recorded) fails loudly instead of silently
 * returning the wrong result.
 */
import type { EffectResult, EffectRuntime, ModelStreamEffectResult } from '../effect-runtime.js';
import type { ModelStreamEffect, RuntimeEffect } from '../effects.js';
import type { ProviderChunk } from '../../providers/types.js';

/** One recorded effect: the requested kind + its settled result (order is significant). */
export interface RecordedEffect {
  readonly kind: RuntimeEffect['kind'];
  readonly result: EffectResult;
}

/** An ordered recording of every effect a run executed — the replay input. */
export interface RunRecording {
  readonly effects: readonly RecordedEffect[];
}

/** A recording runtime plus an accessor for the recording captured so far. */
export interface RecordingEffectRuntime {
  readonly runtime: EffectRuntime;
  /** A snapshot of everything recorded up to now (immutable copy). */
  takeRecording(): RunRecording;
}

/**
 * Wrap a live {@link EffectRuntime} so every effect it runs is captured in call order.
 * The wrapper is transparent — it delegates to `inner.run` and records the settled
 * result — so recording a run changes nothing about how it executes.
 *
 * @param inner - The real runtime (model provider + host executor).
 * @returns A runtime that records, plus {@link RecordingEffectRuntime.takeRecording}.
 */
export function createRecordingEffectRuntime(inner: EffectRuntime): RecordingEffectRuntime {
  const effects: RecordedEffect[] = [];
  return {
    runtime: {
      async *streamModel(effect, signal) {
        if (!inner.streamModel) {
          throw new Error('The wrapped Effect Runtime does not support model streaming.');
        }
        const chunks: ProviderChunk[] = [];
        for await (const chunk of inner.streamModel(effect, signal)) {
          chunks.push(chunk);
          yield chunk;
        }
        const result: ModelStreamEffectResult = {
          kind: 'model_stream',
          chunks,
          cached: false,
        };
        effects.push({ kind: effect.kind, result });
        return result;
      },
      async run(effect, signal) {
        const result = await inner.run(effect, signal);
        effects.push({ kind: effect.kind, result });
        return result;
      },
    },
    takeRecording() {
      return { effects: [...effects] };
    },
  };
}

/** Raised when replay diverges from the recording (over-run or kind mismatch). */
export class ReplayDivergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayDivergenceError';
  }
}

/**
 * A runtime that replays a {@link RunRecording} with **no dependencies** — it never
 * touches a provider or host executor, so a replayed run provably makes zero model/host
 * calls. Each `run` returns the next recorded result, after asserting its kind matches the
 * requested effect; running past the end, or a kind mismatch, throws
 * {@link ReplayDivergenceError} (the run has diverged from what was recorded).
 *
 * @param recording - The ordered recording to replay.
 * @returns A dependency-free {@link EffectRuntime}.
 */
export function createReplayEffectRuntime(recording: RunRecording): EffectRuntime {
  let cursor = 0;
  return {
    async *streamModel(effect: ModelStreamEffect) {
      const recorded = effectAtCursor(effect, cursor, recording);
      cursor += 1;
      if (recorded.result.kind !== 'model_stream') {
        throw new ReplayDivergenceError(
          `Replay result for "${effect.kind}" is not a model stream.`,
        );
      }
      for (const chunk of recorded.result.chunks) yield chunk;
      return recorded.result;
    },
    async run(effect): Promise<EffectResult> {
      const recorded = effectAtCursor(effect, cursor, recording);
      cursor += 1;
      return recorded.result;
    },
  };
}

function effectAtCursor(
  effect: RuntimeEffect,
  cursor: number,
  recording: RunRecording,
): RecordedEffect {
  const recorded = recording.effects[cursor];
  if (!recorded) {
    throw new ReplayDivergenceError(
      `Replay over-ran the recording at effect #${String(cursor)} (kind "${effect.kind}") — ` +
        `the run asked for more effects than were recorded (${String(recording.effects.length)}).`,
    );
  }
  if (recorded.kind !== effect.kind) {
    throw new ReplayDivergenceError(
      `Replay divergence at effect #${String(cursor)}: recorded a "${recorded.kind}" effect ` +
        `but the run requested a "${effect.kind}" effect.`,
    );
  }
  return recorded;
}
