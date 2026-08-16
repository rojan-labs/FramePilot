/** Tests for record/replay of a run's effects (kernel/replay/replay.ts, DoD item 4, K5.3). */
import { describe, expect, it, vi } from 'vitest';
import type { EffectResult, EffectRuntime } from '../effect-runtime.js';
import type { ModelStreamEffect, RuntimeEffect } from '../effects.js';
import type { ProviderChunk } from '../../providers/types.js';
import {
  ReplayDivergenceError,
  createRecordingEffectRuntime,
  createReplayEffectRuntime,
} from './replay.js';

const hostEffect = { kind: 'host_tool' } as unknown as RuntimeEffect;
const modelEffect = { kind: 'model' } as unknown as RuntimeEffect;
const streamEffect = { kind: 'model_stream' } as unknown as ModelStreamEffect;

const hostResult: EffectResult = {
  kind: 'host_tool',
  cached: false,
  outcome: { status: 'completed', summary: 'ok' },
};
const modelResult = {
  kind: 'model',
  cached: false,
  response: { text: 'hi' },
} as unknown as EffectResult;
const streamChunks: ProviderChunk[] = [{ type: 'text-delta', text: 'hi' }];

/** A fake live runtime that returns canned results in call order. */
function fakeRuntime(results: EffectResult[]): EffectRuntime {
  let i = 0;
  return { run: vi.fn().mockImplementation(() => Promise.resolve(results[i++]!)) };
}

/** A fake live runtime whose `streamModel` yields canned chunks in call order. */
function fakeStreamingRuntime(chunks: ProviderChunk[]): EffectRuntime {
  return {
    run: vi.fn(),
    async *streamModel() {
      for (const chunk of chunks) yield chunk;
      return { kind: 'model_stream', chunks, cached: false };
    },
  };
}

describe('createRecordingEffectRuntime', () => {
  it('records every effect result in call order, transparently delegating', async () => {
    const inner = fakeRuntime([hostResult, modelResult]);
    const { runtime, takeRecording } = createRecordingEffectRuntime(inner);

    expect(await runtime.run(hostEffect)).toBe(hostResult);
    expect(await runtime.run(modelEffect)).toBe(modelResult);

    const recording = takeRecording();
    expect(recording.effects.map((e) => e.kind)).toEqual(['host_tool', 'model']);
    expect(recording.effects[0]!.result).toBe(hostResult);
    expect(inner.run).toHaveBeenCalledTimes(2);
  });

  it('takeRecording returns an immutable snapshot (later runs do not mutate it)', async () => {
    const inner = fakeRuntime([hostResult, modelResult]);
    const { runtime, takeRecording } = createRecordingEffectRuntime(inner);
    await runtime.run(hostEffect);
    const snapshot = takeRecording();
    await runtime.run(modelEffect);
    expect(snapshot.effects).toHaveLength(1);
  });

  it('streamModel transparently forwards chunks and records the settled result', async () => {
    const inner = fakeStreamingRuntime(streamChunks);
    const { runtime, takeRecording } = createRecordingEffectRuntime(inner);

    const seen: ProviderChunk[] = [];
    const gen = runtime.streamModel!(streamEffect);
    let next = await gen.next();
    while (!next.done) {
      seen.push(next.value);
      next = await gen.next();
    }
    expect(seen).toEqual(streamChunks);
    expect(next.value).toEqual({ kind: 'model_stream', chunks: streamChunks, cached: false });

    const recording = takeRecording();
    expect(recording.effects).toEqual([
      {
        kind: 'model_stream',
        result: { kind: 'model_stream', chunks: streamChunks, cached: false },
      },
    ]);
  });

  it('streamModel throws when the wrapped runtime does not support streaming', async () => {
    const { runtime } = createRecordingEffectRuntime(fakeRuntime([]));
    await expect(runtime.streamModel!(streamEffect).next()).rejects.toThrow(
      /does not support model streaming/,
    );
  });

  it('cancel delegates to the wrapped runtime', () => {
    const cancel = vi.fn();
    const inner: EffectRuntime = { run: vi.fn(), cancel };
    const { runtime } = createRecordingEffectRuntime(inner);
    runtime.cancel('effect_1', 'stopped');
    expect(cancel).toHaveBeenCalledWith('effect_1', 'stopped');
  });
});

describe('createReplayEffectRuntime', () => {
  it('replays recorded results in order with no dependencies (zero model/host calls)', async () => {
    const inner = fakeRuntime([hostResult, modelResult]);
    const rec = createRecordingEffectRuntime(inner);
    await rec.runtime.run(hostEffect);
    await rec.runtime.run(modelEffect);

    const replay = createReplayEffectRuntime(rec.takeRecording());
    expect(await replay.run(hostEffect)).toBe(hostResult);
    expect(await replay.run(modelEffect)).toBe(modelResult);
  });

  it('throws ReplayDivergenceError on a kind mismatch', async () => {
    const replay = createReplayEffectRuntime({
      effects: [{ kind: 'host_tool', result: hostResult }],
    });
    await expect(replay.run(modelEffect)).rejects.toBeInstanceOf(ReplayDivergenceError);
  });

  it('throws ReplayDivergenceError when the run over-runs the recording', async () => {
    const replay = createReplayEffectRuntime({
      effects: [{ kind: 'host_tool', result: hostResult }],
    });
    await replay.run(hostEffect);
    await expect(replay.run(hostEffect)).rejects.toThrow(/over-ran/);
  });

  it('streamModel replays the recorded chunks and settles on the recorded result', async () => {
    const inner = fakeStreamingRuntime(streamChunks);
    const rec = createRecordingEffectRuntime(inner);
    const gen = rec.runtime.streamModel!(streamEffect);
    for (let next = await gen.next(); !next.done; next = await gen.next());

    const replay = createReplayEffectRuntime(rec.takeRecording());
    const seen: ProviderChunk[] = [];
    const replayGen = replay.streamModel!(streamEffect);
    let next = await replayGen.next();
    while (!next.done) {
      seen.push(next.value);
      next = await replayGen.next();
    }
    expect(seen).toEqual(streamChunks);
    expect(next.value).toEqual({ kind: 'model_stream', chunks: streamChunks, cached: false });
  });

  it('streamModel throws ReplayDivergenceError when the recorded result is not a model stream', async () => {
    const replay = createReplayEffectRuntime({
      effects: [{ kind: 'model_stream', result: hostResult }],
    });
    await expect(replay.streamModel!(streamEffect).next()).rejects.toBeInstanceOf(
      ReplayDivergenceError,
    );
  });

  it('cancel is a no-op (replay has no live effects to interrupt)', () => {
    const replay = createReplayEffectRuntime({ effects: [] });
    expect(() => replay.cancel('effect_1', 'stopped')).not.toThrow();
  });
});
