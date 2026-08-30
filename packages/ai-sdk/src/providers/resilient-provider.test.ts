import { describe, expect, it, vi } from 'vitest';
import { ResilientProvider, withResilience } from './resilient-provider.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ProviderChunk } from './types.js';
import { ProviderError, type RetryPolicy, type Usage } from '../reliability/types.js';

const request: AiCompletionRequest = { messages: [{ role: 'user', content: 'hi' }] };
// ResilientProvider uses withRetry's default realSleep internally, so keep delays ~0ms.
const fastPolicy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 };

function makeProvider(overrides: Partial<AiProvider>): AiProvider {
  return {
    name: 'mock',
    complete: async () => ({ text: 'ok' }),
    ...overrides,
  } as AiProvider;
}

async function collect(iter: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe('ResilientProvider.complete', () => {
  it('retries a retryable error then succeeds', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const inner = makeProvider({
      complete: async () => {
        calls += 1;
        if (calls < 2) throw new ProviderError('429', 'rate_limit', { retryAfterMs: 1 });
        return { text: 'done' } as AiResponse;
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy, hooks: { onRetry } });
    await expect(provider.complete(request)).resolves.toEqual({ text: 'done' });
    expect(calls).toBe(2);
    expect(onRetry).toHaveBeenCalled();
  });

  it('fails fast on a non-retryable error', async () => {
    const inner = makeProvider({
      complete: async () => {
        throw new ProviderError('401', 'auth');
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    await expect(provider.complete(request)).rejects.toThrow('401');
  });

  it('mirrors the inner provider name', () => {
    expect(withResilience(makeProvider({})).name).toBe('mock');
  });

  it('gives the inner complete() a signal the caller can abort', async () => {
    // Asserts the BEHAVIOUR, not identity. The signal handed down is now the caller's
    // combined with a connect deadline — so an abort still cancels the upstream fetch
    // rather than just the caller's await, which is the property this pins, while the
    // deadline can independently abort a request that would otherwise be left running
    // for `withRetry` to duplicate.
    // Checked WHILE the request is in flight: the combined signal is disposed once the
    // call settles (that is what stops it leaking a listener onto the caller's signal),
    // so the propagation this pins only exists for the life of the request — which is
    // exactly when it matters.
    let seen: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const inner = makeProvider({
      complete: async (_request: AiCompletionRequest, signal?: AbortSignal) => {
        seen = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { text: 'ok' } as AiResponse;
      },
    });
    const controller = new AbortController();
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    const pending = provider.complete(request, controller.signal);
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
    release?.();
    await pending.catch(() => undefined);
  });

  it('aborts the in-flight request when the connect budget expires, not just the await', async () => {
    // `withConnectTimeout` alone is a `Promise.race`: the losing promise kept running,
    // so a timed-out completion left its fetch in flight and the retry started another —
    // up to three concurrent, separately billed calls for one logical request.
    let seen: AbortSignal | undefined;
    const inner = makeProvider({
      complete: async (_request: AiCompletionRequest, signal?: AbortSignal) => {
        seen = signal;
        return await new Promise<AiResponse>(() => undefined);
      },
    });
    const provider = new ResilientProvider(inner, {
      policy: { ...fastPolicy, maxAttempts: 1 },
      timeouts: { connectMs: 5, idleMs: 0 },
    });
    await expect(provider.complete(request)).rejects.toThrow(/connect/i);
    expect(seen?.aborted).toBe(true);
  });

  it('stops retrying and rejects with AbortError once the signal fires', async () => {
    const controller = new AbortController();
    const inner = makeProvider({
      complete: async () => {
        // The user cancels while the (retryable) failure is in flight: the retry
        // loop must give up immediately instead of backing off in the background.
        controller.abort();
        throw new ProviderError('503', 'server');
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    await expect(provider.complete(request, controller.signal)).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
  });
});

describe('ResilientProvider.stream', () => {
  it('retries before the first chunk then streams', async () => {
    let attempts = 0;
    const inner = makeProvider({
      stream: async function* () {
        attempts += 1;
        if (attempts < 2) throw new ProviderError('503', 'server');
        yield { type: 'text-delta', text: 'a' };
        yield { type: 'done', text: 'a' };
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    const chunks = await collect(provider.stream(request));
    expect(attempts).toBe(2);
    expect(chunks).toEqual([
      { type: 'text-delta', text: 'a' },
      { type: 'done', text: 'a' },
    ]);
  });

  it('reports stream retries to the onRetry hook', async () => {
    const onRetry = vi.fn();
    let attempts = 0;
    const inner = makeProvider({
      stream: async function* () {
        attempts += 1;
        if (attempts < 2) throw new ProviderError('503', 'server');
        yield { type: 'done', text: 'ok' };
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy, hooks: { onRetry } });
    await collect(provider.stream(request));
    expect(onRetry).toHaveBeenCalled();
  });

  it('reports and forwards usage chunks to orchestration', async () => {
    const usages: Usage[] = [];
    const inner = makeProvider({
      stream: async function* () {
        yield { type: 'text-delta', text: 'x' };
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } };
        yield { type: 'done', text: 'x' };
      },
    });
    const provider = new ResilientProvider(inner, {
      policy: fastPolicy,
      hooks: { onUsage: (u) => usages.push(u) },
    });
    const chunks = await collect(provider.stream(request));
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    expect(usages).toEqual([{ inputTokens: 5, outputTokens: 7 }]);
  });

  it('falls back to complete() when the inner has no stream()', async () => {
    const inner = makeProvider({
      complete: async () => ({
        text: 'final',
        toolCalls: [{ id: 't1', name: 'trim_clip', arguments: {} }],
      }),
    });
    delete (inner as { stream?: unknown }).stream;
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    const chunks = await collect(provider.stream(request));
    expect(chunks).toEqual([
      { type: 'tool-call', call: { id: 't1', name: 'trim_clip', arguments: {} } },
      { type: 'done', text: 'final' },
    ]);
  });

  it('surfaces a mid-stream drop as a typed retryable error', async () => {
    const inner = makeProvider({
      stream: async function* () {
        yield { type: 'text-delta', text: 'partial' };
        throw new ProviderError('reset', 'network');
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    await expect(collect(provider.stream(request))).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });

  it('reports usage that arrives before the first content chunk', async () => {
    const usages: Usage[] = [];
    const inner = makeProvider({
      stream: async function* () {
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 0 } };
        yield { type: 'text-delta', text: 'hi' };
        yield { type: 'done', text: 'hi' };
      },
    });
    const provider = new ResilientProvider(inner, {
      policy: fastPolicy,
      hooks: { onUsage: (u) => usages.push(u) },
    });
    const chunks = await collect(provider.stream(request));
    expect(usages[0]).toEqual({ inputTokens: 3, outputTokens: 0 });
    expect(chunks.map((c) => c.type)).toEqual(['usage', 'text-delta', 'done']);
  });

  it('does not report buffered usage from a failed retry attempt', async () => {
    const usages: Usage[] = [];
    let attempts = 0;
    const inner = makeProvider({
      stream: async function* () {
        attempts += 1;
        yield { type: 'usage', usage: { inputTokens: attempts === 1 ? 99 : 3 } };
        if (attempts === 1) throw new ProviderError('503', 'server');
        yield { type: 'text-delta', text: 'hi' };
        yield { type: 'done', text: 'hi' };
      },
    });
    const provider = new ResilientProvider(inner, {
      policy: fastPolicy,
      hooks: { onUsage: (usage) => usages.push(usage) },
    });

    const chunks = await collect(provider.stream(request));

    expect(attempts).toBe(2);
    expect(usages).toEqual([{ inputTokens: 3 }]);
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 3 } },
    ]);
  });

  it('wraps a non-ProviderError mid-stream drop as a network error', async () => {
    const inner = makeProvider({
      stream: async function* () {
        yield { type: 'text-delta', text: 'a' };
        throw 'raw string failure';
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    await expect(collect(provider.stream(request))).rejects.toMatchObject({ kind: 'network' });
  });

  it('fires an idle timeout on a stalled stream and reports it', async () => {
    const onTimeout = vi.fn();
    const inner = makeProvider({
      // Never yields — simulates a dead socket after connect.
      stream: async function* () {
        await new Promise<void>(() => {}); // hang forever
        yield { type: 'done', text: '' };
      },
    });
    const provider = new ResilientProvider(inner, {
      policy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      timeouts: { connectMs: 0, idleMs: 5 },
      hooks: { onTimeout },
    });
    await expect(collect(provider.stream(request))).rejects.toMatchObject({ kind: 'network' });
    expect(onTimeout).toHaveBeenCalled();
  });

  it('surfaces an idle-timeout abort as a typed retryable timeout, never a raw AbortError', async () => {
    const onTimeout = vi.fn();
    const inner = makeProvider({
      stream: async function* (_request: AiCompletionRequest, signal?: AbortSignal) {
        yield { type: 'text-delta', text: 'a' };
        // Simulate the SSE reader: the idle watchdog's abort rejects the in-flight
        // read with the RAW DOMException-style AbortError users used to see.
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
      },
    });
    const provider = new ResilientProvider(inner, {
      policy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      timeouts: { connectMs: 0, idleMs: 5 },
      hooks: { onTimeout },
    });
    const error: unknown = await collect(provider.stream(request)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'network', retryable: true });
    expect((error as Error).message).toContain('idle timed out after 5ms');
    expect((error as Error).message).not.toContain('The operation was aborted');
    expect(onTimeout).toHaveBeenCalled();
  });

  it('still ends cleanly when a caller abort races the idle watchdog', async () => {
    const controller = new AbortController();
    const inner = makeProvider({
      stream: async function* (_request: AiCompletionRequest, signal?: AbortSignal) {
        yield { type: 'text-delta', text: 'a' };
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              // The user presses Stop in the same tick the watchdog fires: the
              // caller's cancellation must win over the idle-timeout conversion.
              controller.abort();
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
      },
    });
    const provider = new ResilientProvider(inner, {
      policy: fastPolicy,
      timeouts: { connectMs: 0, idleMs: 5 },
    });
    const chunks = await collect(provider.stream(request, controller.signal));
    expect(chunks).toEqual([{ type: 'text-delta', text: 'a' }]);
  });

  it('handles an inner iterator that lacks a return() method', async () => {
    const inner = makeProvider({
      stream: () =>
        ({
          [Symbol.asyncIterator]() {
            let sent = false;
            return {
              next: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: { type: 'done', text: 'z' } as ProviderChunk };
              },
              // no return() method
            };
          },
        }) as AsyncIterable<ProviderChunk>,
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    const chunks = await collect(provider.stream(request));
    expect(chunks).toEqual([{ type: 'done', text: 'z' }]);
  });

  it('propagates a real abort without wrapping', async () => {
    const abort = new Error('Aborted');
    abort.name = 'AbortError';
    const inner = makeProvider({
      stream: async function* () {
        yield { type: 'text-delta', text: 'a' };
        throw abort;
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    await expect(collect(provider.stream(request))).rejects.toHaveProperty('name', 'AbortError');
  });

  it('ends cleanly when the signal is already aborted at entry', async () => {
    const controller = new AbortController();
    controller.abort();
    const inner = makeProvider({
      stream: async function* () {
        yield { type: 'done', text: 'never' };
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    expect(await collect(provider.stream(request, controller.signal))).toEqual([]);
  });

  it('ends cleanly on an abort raised mid-stream', async () => {
    const controller = new AbortController();
    const inner = makeProvider({
      stream: async function* () {
        yield { type: 'text-delta', text: 'a' };
        controller.abort();
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    const chunks = await collect(provider.stream(request, controller.signal));
    expect(chunks).toEqual([{ type: 'text-delta', text: 'a' }]);
  });

  it('wraps a non-ProviderError Error mid-stream as a network error', async () => {
    const inner = makeProvider({
      stream: async function* () {
        yield { type: 'text-delta', text: 'a' };
        throw new Error('socket reset');
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    await expect(collect(provider.stream(request))).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('socket reset'),
    });
  });

  it('handles an empty stream (immediately done)', async () => {
    const inner = makeProvider({
      // eslint-disable-next-line require-yield
      stream: async function* () {
        return;
      },
    });
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    expect(await collect(provider.stream(request))).toEqual([]);
  });

  it('falls back to complete() with no tool calls', async () => {
    const inner = makeProvider({ complete: async () => ({ text: 'plain' }) });
    delete (inner as { stream?: unknown }).stream;
    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    expect(await collect(provider.stream(request))).toEqual([{ type: 'done', text: 'plain' }]);
  });

  it("reports the inner provider's model, live rather than copied at construction", () => {
    // The context meter sizes the window from `modelId`. If this wrapper answered from a
    // constructor-time copy, a provider that resolves its model lazily — which every
    // LangChain adapter does, since ADR 0105 made them the only path — would be metered
    // against the wrong window. Covered here after `model-id.test.ts` was deleted with the
    // native adapters it tested.
    let current = 'first-model';
    const inner = makeProvider({ complete: async () => ({ text: 'ok' }) });
    Object.defineProperty(inner, 'modelId', { get: () => current });

    const provider = new ResilientProvider(inner, { policy: fastPolicy });
    expect(provider.modelId).toBe('first-model');
    current = 'resolved-later';
    expect(provider.modelId).toBe('resolved-later');
  });
});
