import { describe, expect, it } from 'vitest';
import { InMemoryTurnTracer, NOOP_TRACER, TurnTraceBuilder } from './tracer.js';

describe('NOOP_TRACER', () => {
  it('accepts records without error', () => {
    expect(() =>
      NOOP_TRACER.record({
        mode: 'chat',
        provider: 'mock',
        latencyMs: 1,
        retries: 0,
        toolCalls: [],
        validatorRejections: 0,
        aborted: false,
        timedOut: false,
      }),
    ).not.toThrow();
  });
});

describe('InMemoryTurnTracer', () => {
  const trace = (mode: string) =>
    ({
      mode,
      provider: 'mock',
      latencyMs: 1,
      retries: 0,
      toolCalls: [],
      validatorRejections: 0,
      aborted: false,
      timedOut: false,
    }) as const;

  it('retains traces oldest-first and exposes last()', () => {
    const tracer = new InMemoryTurnTracer();
    tracer.record(trace('a'));
    tracer.record(trace('b'));
    expect(tracer.list().map((t) => t.mode)).toEqual(['a', 'b']);
    expect(tracer.last()?.mode).toBe('b');
  });

  it('bounds the ring buffer', () => {
    const tracer = new InMemoryTurnTracer(2);
    tracer.record(trace('a'));
    tracer.record(trace('b'));
    tracer.record(trace('c'));
    expect(tracer.list().map((t) => t.mode)).toEqual(['b', 'c']);
  });

  it('clear() empties the buffer', () => {
    const tracer = new InMemoryTurnTracer();
    tracer.record(trace('a'));
    tracer.clear();
    expect(tracer.list()).toEqual([]);
    expect(tracer.last()).toBeUndefined();
  });
});

describe('TurnTraceBuilder', () => {
  it('accumulates observations and builds an immutable trace', () => {
    let clock = 1000;
    const builder = new TurnTraceBuilder('agent', 'anthropic', 100, 'claude-opus-4-8', () => clock);
    builder.addRetry();
    builder.addRetry();
    builder.addValidatorRejection();
    builder.addToolCall('trim_clip');
    builder.setUsage({ inputTokens: 10, outputTokens: 20 });
    clock = 1500;
    const built = builder.build();
    expect(built).toMatchObject({
      mode: 'agent',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      latencyMs: 1400,
      retries: 2,
      toolCalls: ['trim_clip'],
      validatorRejections: 1,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it('omits optional fields and records abort/timeout/errorKind', () => {
    const tracer = new InMemoryTurnTracer();
    const builder = new TurnTraceBuilder('chat', 'mock', 0, undefined, () => 42);
    builder.markAborted();
    builder.markTimedOut();
    builder.setErrorKind('network');
    const built = builder.finish(tracer);
    expect(built.model).toBeUndefined();
    expect(built.usage).toBeUndefined();
    expect(built.aborted).toBe(true);
    expect(built.timedOut).toBe(true);
    expect(built.errorKind).toBe('network');
    expect(tracer.last()).toBe(built);
  });
});
