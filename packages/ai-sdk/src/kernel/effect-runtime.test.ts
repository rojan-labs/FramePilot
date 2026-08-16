/**
 * Tests for the K0.3 EffectRuntime (plan/AI-ORCHESTRATION-REDESIGN.md §10).
 *
 * Verifies the idempotency-dedup policy generalized from the orchestrator's
 * `hostCache`: successful host/model effects are memoized (and re-marked `cached`),
 * failures/cancellations are NOT (a retry re-runs), concurrent duplicates share one
 * execution, model effects dedup only when explicitly keyed, and a missing executor
 * fails honestly instead of fabricating success.
 */
import { describe, expect, it } from 'vitest';
import { makeProject } from '../__fixtures__/project.js';
import type { HostToolExecutor, HostToolOutcome } from '../tool-executor.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from '../providers/types.js';
import type { StructuredEffectExecutor } from './effect-runtime.js';
import { createEffectRuntime, idempotencyKeyFor } from './effect-runtime.js';
import type {
  EffectControl,
  EffectRetryClass,
  EffectSideEffectClass,
  HostToolEffect,
  ModelEffect,
  PersistenceEffect,
} from './effects.js';

const project = makeProject();
const call = (args: Record<string, unknown> = { trackId: 'A' }): ToolCall => ({
  id: 'c1',
  name: 'analyze_silence',
  arguments: args,
});
const hostEffect = (over: Partial<HostToolEffect> = {}): HostToolEffect => ({
  kind: 'host_tool',
  call: call(),
  project,
  ...over,
});

/** An executor returning a scripted outcome and counting its invocations. */
function stubExecutor(outcome: HostToolOutcome): HostToolExecutor & { calls: number } {
  return {
    calls: 0,
    async run() {
      this.calls += 1;
      return outcome;
    },
  };
}

const okProvider = (response: AiResponse): AiProvider & { calls: number } => ({
  calls: 0,
  name: 'mock',
  async complete(_req: AiCompletionRequest) {
    (this as { calls: number }).calls += 1;
    return response;
  },
});

describe('idempotencyKeyFor', () => {
  it('keys a host-tool effect by name + args, honoring an explicit override', () => {
    expect(idempotencyKeyFor(hostEffect())).toBe('host_tool:analyze_silence:{"trackId":"A"}');
    expect(idempotencyKeyFor(hostEffect({ idempotencyKey: 'fixed' }))).toBe('fixed');
  });

  it('stays inside the run contract when a call carries a montage of arguments', () => {
    // Regression: the key was the arguments serialised in full, so one call that cut
    // thirty segments produced a multi-kilobyte key and the run snapshot failed to
    // parse — `effects.6.idempotencyKey: Too big` — after the edits had been applied.
    const segments = Array.from({ length: 40 }, (_, index) => ({
      assetId: `asset_${index}_with_a_realistically_long_identifier`,
      start: index * 0.62,
      end: index * 0.62 + 0.41,
    }));
    const key = idempotencyKeyFor(hostEffect({ call: call({ segments }) }));
    expect(key).toBeDefined();
    expect(key!.length).toBeLessThanOrEqual(256);
    // Different arguments past the readable cut-off must still key differently.
    const other = idempotencyKeyFor(
      hostEffect({ call: call({ segments: [...segments.slice(0, -1), { assetId: 'z' }] }) }),
    );
    expect(other).not.toBe(key);
  });

  it('keys a model effect only when it declares one', () => {
    const req: AiCompletionRequest = { messages: [] };
    expect(idempotencyKeyFor({ kind: 'model', request: req })).toBeUndefined();
    expect(idempotencyKeyFor({ kind: 'model', request: req, idempotencyKey: 'k' })).toBe('k');
  });

  it('never keys a model_stream effect — each stream call runs fresh', () => {
    const req: AiCompletionRequest = { messages: [] };
    expect(idempotencyKeyFor({ kind: 'model_stream', request: req })).toBeUndefined();
  });
});

describe('createEffectRuntime — host tool', () => {
  it('runs once and memoizes a success; a duplicate is served cached', async () => {
    const executor = stubExecutor({ status: 'completed', summary: 'ok', data: { silences: [] } });
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      executor,
    });

    const first = await runtime.run(hostEffect());
    const second = await runtime.run(hostEffect());

    expect(first).toMatchObject({ kind: 'host_tool', cached: false });
    expect(second.kind === 'host_tool' && second.cached).toBe(true);
    expect(second.kind === 'host_tool' && second.outcome.summary).toBe('ok');
    expect(executor.calls).toBe(1); // deduped
  });

  it('memoizes a "warning" outcome the same as a "completed" one', async () => {
    const executor = stubExecutor({ status: 'warning', summary: 'partial data' });
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      executor,
    });
    await runtime.run(hostEffect());
    const second = await runtime.run(hostEffect());
    expect(second.kind === 'host_tool' && second.cached).toBe(true);
    expect(executor.calls).toBe(1);
  });

  it('does NOT memoize a failure — a retry re-runs the executor', async () => {
    const executor = stubExecutor({ status: 'failed', summary: 'engine down' });
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      executor,
    });

    await runtime.run(hostEffect());
    await runtime.run(hostEffect());

    expect(executor.calls).toBe(2);
  });

  it('fails honestly with no executor configured (never fabricates success)', async () => {
    const runtime = createEffectRuntime({ provider: okProvider({}) });
    const result = await runtime.run(hostEffect());
    expect(result).toMatchObject({
      kind: 'host_tool',
      cached: false,
      outcome: { status: 'failed' },
    });
    expect(result.kind === 'host_tool' && result.outcome.summary).toContain('no analysis engine');
  });

  it('normalizes an executor throw (abort) into a cancelled outcome, unmemoized', async () => {
    const controller = new AbortController();
    const executor: HostToolExecutor & { calls: number } = {
      calls: 0,
      async run() {
        this.calls += 1;
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    };
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      executor,
    });
    controller.abort();

    const result = await runtime.run(hostEffect(), controller.signal);
    expect(result.kind === 'host_tool' && result.outcome.status).toBe('cancelled');
    await runtime.run(hostEffect(), controller.signal);
    expect(executor.calls).toBe(2); // cancelled outcomes are retryable
  });

  it('normalizes a non-abort executor throw (no signal) into a failed outcome', async () => {
    const executor: HostToolExecutor = {
      async run() {
        throw new Error('sidecar exploded');
      },
    };
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      executor,
    });
    const result = await runtime.run(hostEffect());
    expect(result.kind === 'host_tool' && result.outcome.status).toBe('failed');
    expect(result.kind === 'host_tool' && result.outcome.summary).toContain('sidecar exploded');
  });

  it('shares one execution across concurrent duplicates', async () => {
    let running = 0;
    let peak = 0;
    const executor: HostToolExecutor & { calls: number } = {
      calls: 0,
      async run() {
        this.calls += 1;
        running += 1;
        peak = Math.max(peak, running);
        await Promise.resolve();
        running -= 1;
        return { status: 'completed', summary: 'ok' };
      },
    };
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      executor,
    });
    const [a, b] = await Promise.all([runtime.run(hostEffect()), runtime.run(hostEffect())]);
    expect(executor.calls).toBe(1);
    expect(peak).toBe(1);
    // One caller sees the fresh run, the other the cached hit.
    expect([a.cached, b.cached].sort()).toEqual([false, true]);
  });
});

describe('createEffectRuntime — model', () => {
  const req: AiCompletionRequest = { messages: [{ role: 'user', content: 'hi' }] };

  it('does not dedup an unkeyed model effect', async () => {
    // toolCalls set (not just text) so the runtime's response-logging line exercises
    // both sides of its `toolCalls?.length ?? 0` branch across the test file.
    const provider = okProvider({
      text: 'a',
      toolCalls: [{ id: 'c1', name: 'trim_clip', arguments: {} }],
    });
    const runtime = createEffectRuntime({ provider: provider });
    const effect: ModelEffect = { kind: 'model', request: req };
    await runtime.run(effect);
    await runtime.run(effect);
    expect(provider.calls).toBe(2);
  });

  it('dedups a keyed model effect and marks the hit cached', async () => {
    const provider = okProvider({ text: 'a' });
    const runtime = createEffectRuntime({ provider: provider });
    const effect: ModelEffect = { kind: 'model', request: req, idempotencyKey: 'k1' };
    const first = await runtime.run(effect);
    const second = await runtime.run(effect);
    expect(provider.calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.kind === 'model' && second.response.text).toBe('a');
  });

  it('propagates a keyed model throw and evicts it so a retry re-runs', async () => {
    let attempts = 0;
    const provider: AiProvider = {
      name: 'mock',
      async complete() {
        attempts += 1;
        if (attempts === 1) throw new Error('network');
        return { text: 'recovered' };
      },
    };
    const runtime = createEffectRuntime({ provider: provider });
    const effect: ModelEffect = { kind: 'model', request: req, idempotencyKey: 'k2' };
    await expect(runtime.run(effect)).rejects.toThrow('network');
    const retry = await runtime.run(effect);
    expect(retry.kind === 'model' && retry.response.text).toBe('recovered');
    expect(attempts).toBe(2);
  });
});

describe('createEffectRuntime — single-provider model execution', () => {
  const req: AiCompletionRequest = { messages: [{ role: 'user', content: 'hi' }] };

  it('keeps tier labels as telemetry without changing the active provider', async () => {
    const provider = okProvider({ text: 'active-provider' });
    const runtime = createEffectRuntime({ provider });

    const smallResult = await runtime.run({ kind: 'model', request: req, tier: 'small' });
    const midResult = await runtime.run({ kind: 'model', request: req, tier: 'mid' });
    const largeResult = await runtime.run({ kind: 'model', request: req, tier: 'large' });

    expect(provider.calls).toBe(3);
    expect(smallResult.kind === 'model' && smallResult.response.text).toBe('active-provider');
    expect(midResult.kind === 'model' && midResult.response.text).toBe('active-provider');
    expect(largeResult.kind === 'model' && largeResult.response.text).toBe('active-provider');
  });
});

describe('createEffectRuntime — structured effects (retry/timeout/cancel policy)', () => {
  const control = (over: Partial<EffectControl> = {}): EffectControl => ({
    effectId: 'eff_1',
    taskId: 'task_1',
    idempotencyKey: 'idem_1',
    resourceClass: 'persistence',
    timeoutMs: 1000,
    retryClass: 'never',
    sideEffectClass: 'idempotent',
    ...over,
  });
  const persistenceEffect = (over: Partial<EffectControl> = {}): PersistenceEffect => ({
    kind: 'persistence',
    control: control(over),
    operation: 'append_event',
    payload: null,
  });
  const stubStructured = (
    impl: (effect: unknown, signal?: AbortSignal) => Promise<unknown>,
  ): StructuredEffectExecutor => ({ run: impl });

  it('fails honestly with no structuredExecutor configured (never fabricates success)', async () => {
    const runtime = createEffectRuntime({ provider: okProvider({}) });
    await expect(runtime.run(persistenceEffect())).rejects.toThrow(
      /No executor is registered for effect "persistence"/,
    );
  });

  it('rejects a non-positive or non-finite timeout before dispatching', async () => {
    const structuredExecutor = stubStructured(async () => 'ok');
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      structuredExecutor,
    });
    await expect(runtime.run(persistenceEffect({ timeoutMs: 0 }))).rejects.toThrow(
      /requires a positive timeout/,
    );
    await expect(
      runtime.run(persistenceEffect({ timeoutMs: Number.POSITIVE_INFINITY, effectId: 'eff_2' })),
    ).rejects.toThrow(/requires a positive timeout/);
  });

  it('runs a structured effect through the registered executor and returns its outcome', async () => {
    const structuredExecutor = stubStructured(async () => ({ ok: true }));
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      structuredExecutor,
    });
    const result = await runtime.run(persistenceEffect());
    expect(result).toMatchObject({
      kind: 'structured',
      effectKind: 'persistence',
      cached: false,
      outcome: { ok: true },
    });
  });

  it.each<[EffectRetryClass, EffectSideEffectClass, number]>([
    ['never', 'idempotent', 1],
    ['revision_conflict', 'idempotent', 1],
    ['transient', 'idempotent', 2],
    ['repair_once', 'idempotent', 2],
    ['rate_limited', 'idempotent', 3],
    // `commit` caps every retry class at 1 — a committed side effect must never replay.
    ['rate_limited', 'commit', 1],
  ])(
    'retries a failing %s/%s effect up to %i time(s), then rethrows',
    async (retryClass, sideEffectClass, attempts) => {
      let calls = 0;
      const structuredExecutor = stubStructured(async () => {
        calls += 1;
        throw new Error('transient failure');
      });
      const runtime = createEffectRuntime({
        provider: okProvider({}),
        structuredExecutor,
      });
      await expect(runtime.run(persistenceEffect({ retryClass, sideEffectClass }))).rejects.toThrow(
        'transient failure',
      );
      expect(calls).toBe(attempts);
    },
  );

  it('recovers on a retry within the retry budget', async () => {
    let calls = 0;
    const structuredExecutor = stubStructured(async () => {
      calls += 1;
      if (calls === 1) throw new Error('flaky');
      return { ok: true };
    });
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      structuredExecutor,
    });
    const result = await runtime.run(persistenceEffect({ retryClass: 'transient' }));
    expect(calls).toBe(2);
    expect(result).toMatchObject({ kind: 'structured', outcome: { ok: true } });
  });

  it('aborts a structured effect that outruns its timeout with EffectTimeoutError', async () => {
    const structuredExecutor = stubStructured(
      (_effect, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      structuredExecutor,
    });
    await expect(
      runtime.run(persistenceEffect({ timeoutMs: 5, retryClass: 'never' })),
    ).rejects.toThrow(/exceeded its 5ms timeout/);
  });

  it('cancel() aborts the running effect and its cancellation children', async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    const structuredExecutor = stubStructured(
      (_effect, signal) =>
        new Promise((_resolve, reject) => {
          seenSignals.push(signal);
          signal?.addEventListener('abort', () => reject(new Error('cancelled')));
        }),
    );
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      structuredExecutor,
    });
    const parent = runtime.run(persistenceEffect({ effectId: 'parent', idempotencyKey: 'parent' }));
    const child = runtime.run(
      persistenceEffect({
        effectId: 'child',
        idempotencyKey: 'child',
        cancellationParentId: 'parent',
      }),
    );
    // Let both dispatch before cancelling the tree from the parent.
    await new Promise((r) => setTimeout(r, 0));
    runtime.cancel('parent', 'user stopped');
    await expect(parent).rejects.toThrow();
    await expect(child).rejects.toThrow();
  });

  it('cancelTree tolerates a cancellation-parent cycle (visits each effect once)', async () => {
    const seenSignals = new Map<string, AbortSignal>();
    const structuredExecutor = stubStructured(
      (effect, signal) =>
        new Promise((_resolve, reject) => {
          const id = (effect as PersistenceEffect).control.effectId;
          if (signal) seenSignals.set(id, signal);
          signal?.addEventListener('abort', () => reject(new Error('cancelled')));
        }),
    );
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      structuredExecutor,
    });
    // A mutual cycle: A's cancellation parent is B, and B's is A.
    const a = runtime.run(
      persistenceEffect({ effectId: 'a', idempotencyKey: 'a', cancellationParentId: 'b' }),
    );
    const b = runtime.run(
      persistenceEffect({ effectId: 'b', idempotencyKey: 'b', cancellationParentId: 'a' }),
    );
    await new Promise((r) => setTimeout(r, 0));
    // Must terminate (not infinite-recurse) despite the cycle.
    runtime.cancel('a', 'user stopped');
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
  });

  it('relays an already-aborted parent signal into the effect immediately', async () => {
    const controller = new AbortController();
    controller.abort('stopped before dispatch');
    let seenAborted: boolean | undefined;
    const structuredExecutor = stubStructured(async (_effect, signal) => {
      seenAborted = signal?.aborted;
      throw new Error('cancelled');
    });
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      structuredExecutor,
    });
    await expect(runtime.run(persistenceEffect(), controller.signal)).rejects.toThrow();
    expect(seenAborted).toBe(true);
  });

  it('logs a retry after a non-Error throw (stringified, not `.message`)', async () => {
    let calls = 0;
    const structuredExecutor = stubStructured(async () => {
      calls += 1;
      // Deliberately non-Error, to exercise the String(error) fallback.
      if (calls === 1) throw 'stringy failure';
      return { ok: true };
    });
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      structuredExecutor,
    });
    const result = await runtime.run(persistenceEffect({ retryClass: 'transient' }));
    expect(calls).toBe(2);
    expect(result).toMatchObject({ kind: 'structured', outcome: { ok: true } });
  });
});

describe('createEffectRuntime — observer lifecycle', () => {
  const control = (over: Partial<EffectControl> = {}): EffectControl => ({
    effectId: 'eff_1',
    taskId: 'task_1',
    idempotencyKey: 'idem_1',
    resourceClass: 'persistence',
    timeoutMs: 1000,
    retryClass: 'never',
    sideEffectClass: 'idempotent',
    ...over,
  });
  const persistenceEffect = (over: Partial<EffectControl> = {}): PersistenceEffect => ({
    kind: 'persistence',
    control: control(over),
    operation: 'append_event',
    payload: null,
  });

  function recordingObserver() {
    const events: string[] = [];
    return {
      events,
      observer: {
        onRequested: () => {
          events.push('requested');
        },
        onSettled: () => {
          events.push('settled');
        },
        onFailed: () => {
          events.push('failed');
        },
      },
    };
  }

  it('notifies onRequested + onSettled around a successful run() effect', async () => {
    const { events, observer } = recordingObserver();
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      executor: stubExecutor({ status: 'completed', summary: 'ok' }),
      observer,
    });
    await runtime.run(hostEffect());
    expect(events).toEqual(['requested', 'settled']);
  });

  it('notifies onRequested + onFailed around a run() effect that throws', async () => {
    const { events, observer } = recordingObserver();
    const structuredExecutor: StructuredEffectExecutor = {
      run: async () => {
        throw new Error('boom');
      },
    };
    const runtime = createEffectRuntime({
      provider: okProvider({}),
      structuredExecutor,
      observer,
    });
    await expect(runtime.run(persistenceEffect())).rejects.toThrow('boom');
    expect(events).toEqual(['requested', 'failed']);
  });

  it('notifies onRequested + onSettled around a successful streamModel()', async () => {
    const { events, observer } = recordingObserver();
    const runtime = createEffectRuntime({
      provider: okProvider({ text: 'hi' }),
      observer,
    });
    const gen = runtime.streamModel!({ kind: 'model_stream', request: { messages: [] } });
    for (let next = await gen.next(); !next.done; next = await gen.next());
    expect(events).toEqual(['requested', 'settled']);
  });

  it('drains a complete()-only provider’s reasoning as a reasoning-delta chunk', async () => {
    const provider: AiProvider = {
      name: 'mock',
      async complete() {
        return { text: 'answer', reasoning: 'thinking it through' };
      },
    };
    const runtime = createEffectRuntime({ provider: provider });
    const gen = runtime.streamModel!({ kind: 'model_stream', request: { messages: [] } });
    const chunks = [];
    for (let next = await gen.next(); !next.done; next = await gen.next()) chunks.push(next.value);
    expect(chunks).toContainEqual({ type: 'reasoning-delta', text: 'thinking it through' });
  });

  it('notifies onRequested + onFailed when streamModel() throws mid-stream', async () => {
    const { events, observer } = recordingObserver();
    const provider: AiProvider = {
      name: 'mock',
      stream() {
        throw new Error('stream broke');
      },
    };
    const runtime = createEffectRuntime({ provider: provider, observer });
    const gen = runtime.streamModel!({ kind: 'model_stream', request: { messages: [] } });
    await expect(gen.next()).rejects.toThrow('stream broke');
    expect(events).toEqual(['requested', 'failed']);
  });

  it('notifies onFailed when a streamModel() consumer abandons the generator before settlement', async () => {
    const { events, observer } = recordingObserver();
    const provider: AiProvider = {
      name: 'mock',
      async *stream() {
        yield { type: 'text-delta', text: 'a' };
        yield { type: 'text-delta', text: 'b' };
      },
    };
    const runtime = createEffectRuntime({ provider: provider, observer });
    const gen = runtime.streamModel!({ kind: 'model_stream', request: { messages: [] } });
    await gen.next(); // consume exactly one chunk, then abandon
    await gen.return(undefined as never);
    expect(events).toEqual(['requested', 'failed']);
  });

  it('reports the real abort reason when an abandoned stream carries a tripped signal', async () => {
    const { events, observer } = recordingObserver();
    let onFailedError: unknown;
    const provider: AiProvider = {
      name: 'mock',
      async *stream() {
        yield { type: 'text-delta', text: 'a' };
        yield { type: 'text-delta', text: 'b' };
      },
    };
    const runtime = createEffectRuntime({
      provider: provider,
      observer: {
        ...observer,
        onFailed: (_effect, error) => {
          onFailedError = error;
          events.push('failed');
        },
      },
    });
    const controller = new AbortController();
    const gen = runtime.streamModel!(
      { kind: 'model_stream', request: { messages: [] } },
      controller.signal,
    );
    await gen.next();
    controller.abort('stopped by user');
    await gen.return(undefined as never);
    expect(events).toEqual(['requested', 'failed']);
    expect(onFailedError).toBe('stopped by user');
  });
});
