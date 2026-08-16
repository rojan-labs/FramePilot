/**
 * The M0.1 measuring rig.
 *
 * A measurement instrument that is subtly wrong is worse than none: it produces a budget
 * that looks authoritative and quietly validates regressions. So these tests pin the
 * definitions — what counts as time-to-first-token, what an unreported count means — not
 * just that numbers come out.
 */
import { describe, expect, it } from 'vitest';
import { BaselineCaptureProvider, DEFAULT_TIER_PRICING } from './baseline-capture.js';
import { summarizeRunMetrics } from './run-metrics.js';
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ProviderChunk,
} from '../../providers/types.js';

/** A clock the test advances by hand, so timings are exact rather than flaky. */
function clock() {
  let value = 0;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/** A provider that yields scripted chunks, advancing the clock between them. */
function scripted(
  steps: readonly { chunk?: ProviderChunk; advance: number }[],
  time: ReturnType<typeof clock>,
): AiProvider {
  return {
    name: 'mock',
    modelId: 'test-model',
    complete: async () => ({ text: 'ok' }),
    async *stream() {
      for (const step of steps) {
        time.advance(step.advance);
        if (step.chunk) yield step.chunk;
      }
    },
  } as AiProvider;
}

const request: AiCompletionRequest = { messages: [{ role: 'user', content: 'hi' }] };

const drain = async (stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> => {
  const out: ProviderChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};

describe('what counts as time-to-first-token', () => {
  it('measures to the first CONTENT chunk, not the first chunk of any kind', async () => {
    // Anthropic sends usage on `message_start`. Counting that would report a TTFT no
    // user ever experienced — and would make every later comparison optimistic.
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted(
        [
          { advance: 10, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 0 } } },
          { advance: 40, chunk: { type: 'text-delta', text: 'hello' } },
          { advance: 50, chunk: { type: 'done', text: 'hello' } },
        ],
        time,
      ),
      { now: time.now },
    );

    await drain(provider.stream(request));
    const [sample] = provider.captured();
    expect(sample?.ttftMs).toBe(50);
    expect(sample?.wallMs).toBe(100);
  });

  it('counts a reasoning delta as first content — the user sees the panel move', async () => {
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted(
        [
          { advance: 30, chunk: { type: 'reasoning-delta', text: 'thinking' } },
          { advance: 20, chunk: { type: 'done', text: '' } },
        ],
        time,
      ),
      { now: time.now },
    );
    await drain(provider.stream(request));
    expect(provider.captured()[0]?.ttftMs).toBe(30);
  });

  it('records ttft === wall for a stream that produced no content at all', async () => {
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted([{ advance: 25, chunk: { type: 'done', text: '' } }], time),
      { now: time.now },
    );
    await drain(provider.stream(request));
    const [sample] = provider.captured();
    expect(sample?.ttftMs).toBe(sample?.wallMs);
  });

  it('marks a non-streaming call so its ttft is never mistaken for a real one', async () => {
    // `complete()` has no first-token moment. Mixing those into a TTFT percentile
    // without knowing would understate real latency.
    const time = clock();
    const inner: AiProvider = {
      name: 'mock',
      modelId: 'test-model',
      complete: async (): Promise<AiResponse> => {
        time.advance(70);
        return { text: 'ok', usage: { inputTokens: 5, outputTokens: 2 } };
      },
    };
    const provider = new BaselineCaptureProvider(inner, { now: time.now });
    await provider.complete(request);
    const [sample] = provider.captured();
    expect(sample?.streamed).toBe(false);
    expect(sample?.ttftMs).toBe(70);
    expect(sample?.wallMs).toBe(70);
  });
});

describe('honesty rules', () => {
  it('records zero tokens and NO usd when the provider reported no usage', async () => {
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted([{ advance: 10, chunk: { type: 'done', text: 'x' } }], time),
      { now: time.now, prices: DEFAULT_TIER_PRICING },
    );
    await drain(provider.stream(request));
    const [sample] = provider.captured();
    expect(sample?.inputTokens).toBe(0);
    expect(sample?.usd).toBe(0);
  });

  it('omits usd entirely when no price table was supplied', async () => {
    // An unpriced baseline is honest. A fabricated $0 would set a budget any later
    // phase could "meet" by spending anything at all.
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted(
        [
          { advance: 10, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } } },
          { advance: 5, chunk: { type: 'done', text: 'x' } },
        ],
        time,
      ),
      { now: time.now },
    );
    await drain(provider.stream(request));
    expect(provider.captured()[0]).not.toHaveProperty('usd');
  });

  it('keeps unreported cache counts ABSENT rather than zero', async () => {
    // run-metrics excludes unreported turns from the hit-rate denominator. A zero here
    // would let a provider gap masquerade as a measured 0% that a later phase "matches".
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted(
        [
          { advance: 5, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } } },
          { advance: 5, chunk: { type: 'done', text: 'x' } },
        ],
        time,
      ),
      { now: time.now },
    );
    await drain(provider.stream(request));
    const [sample] = provider.captured();
    expect(sample).not.toHaveProperty('cacheReadInputTokens');
    expect(summarizeRunMetrics(provider.captured()).cacheHitRate).toBeUndefined();
  });

  it('carries cache counts through when the provider DID report them', async () => {
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted(
        [
          {
            advance: 5,
            chunk: {
              type: 'usage',
              usage: {
                inputTokens: 60,
                outputTokens: 10,
                cacheReadInputTokens: 40,
                cacheCreationInputTokens: 5,
              },
            },
          },
          { advance: 5, chunk: { type: 'done', text: 'x' } },
        ],
        time,
      ),
      { now: time.now },
    );
    await drain(provider.stream(request));
    const [sample] = provider.captured();
    expect(sample?.cacheReadInputTokens).toBe(40);
    expect(sample?.cacheCreationInputTokens).toBe(5);
    // 40 cached of (60 uncached + 40 cached) — the denominator M1 had to correct.
    expect(summarizeRunMetrics(provider.captured()).cacheHitRate).toBeCloseTo(0.4, 5);
  });

  it('prices a turn from the supplied table, not a hardcoded one', async () => {
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted(
        [
          {
            advance: 1,
            chunk: { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 0 } },
          },
          { advance: 1, chunk: { type: 'done', text: 'x' } },
        ],
        time,
      ),
      {
        now: time.now,
        prices: { ...DEFAULT_TIER_PRICING, mid: { inputPerMTok: 7, outputPerMTok: 0 } },
      },
    );
    await drain(provider.stream(request));
    expect(provider.captured()[0]?.usd).toBeCloseTo(7, 5);
  });
});

describe('transparency', () => {
  it('forwards every chunk unchanged and in order', async () => {
    const time = clock();
    const chunks: ProviderChunk[] = [
      { type: 'text-delta', text: 'a' },
      { type: 'text-delta', text: 'b' },
      { type: 'done', text: 'ab' },
    ];
    const provider = new BaselineCaptureProvider(
      scripted(
        chunks.map((chunk) => ({ chunk, advance: 1 })),
        time,
      ),
      { now: time.now },
    );
    expect(await drain(provider.stream(request))).toEqual(chunks);
  });

  it('uses the real clock when none was injected', async () => {
    // The default clock is what the script actually runs with; leaving it untested would
    // mean the harness's real-world timing path never executes here.
    const provider = new BaselineCaptureProvider({
      name: 'mock',
      complete: async () => ({ text: 'ok' }),
    } as AiProvider);
    await provider.complete(request);
    const [sample] = provider.captured();
    expect(sample?.wallMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(sample?.wallMs)).toBe(true);
  });

  it('reports the inner provider’s name and model, not its own', async () => {
    const time = clock();
    const provider = new BaselineCaptureProvider(scripted([], time), { now: time.now });
    expect(provider.name).toBe('mock');
    expect(provider.modelId).toBe('test-model');
  });

  it('still records a sample when the stream is abandoned part-way', async () => {
    // A cancelled turn's partial timing is real data. Dropping it would bias the
    // baseline toward runs that happened to finish.
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted(
        [
          { advance: 10, chunk: { type: 'text-delta', text: 'a' } },
          { advance: 10, chunk: { type: 'text-delta', text: 'b' } },
        ],
        time,
      ),
      { now: time.now },
    );
    for await (const _chunk of provider.stream(request)) break;
    expect(provider.captured()).toHaveLength(1);
  });

  it('records a sample even when complete() throws, then rethrows', async () => {
    const time = clock();
    const inner: AiProvider = {
      name: 'mock',
      complete: async () => {
        time.advance(15);
        throw new Error('network exploded');
      },
    };
    const provider = new BaselineCaptureProvider(inner, { now: time.now });
    await expect(provider.complete(request)).rejects.toThrow('network exploded');
    expect(provider.captured()[0]?.wallMs).toBe(15);
  });

  it('accumulates one sample per model call, so a run yields many', async () => {
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted([{ advance: 5, chunk: { type: 'done', text: 'x' } }], time),
      { now: time.now },
    );
    await drain(provider.stream(request));
    await drain(provider.stream(request));
    await drain(provider.stream(request));
    expect(provider.captured()).toHaveLength(3);
    expect(summarizeRunMetrics(provider.captured()).turnCount).toBe(3);
  });

  it('returns a copy, so a caller cannot mutate the recorded samples', async () => {
    const time = clock();
    const provider = new BaselineCaptureProvider(
      scripted([{ advance: 1, chunk: { type: 'done', text: 'x' } }], time),
      { now: time.now },
    );
    await drain(provider.stream(request));
    provider.captured().splice(0, 1);
    expect(provider.captured()).toHaveLength(1);
  });
});
