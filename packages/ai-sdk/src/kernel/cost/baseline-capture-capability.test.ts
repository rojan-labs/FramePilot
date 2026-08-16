import { describe, expect, it } from 'vitest';
import { BaselineCaptureProvider } from './baseline-capture.js';
import type { AiProvider, ProviderChunk } from '../../providers/types.js';

const completionOnly: AiProvider = {
  name: 'mock',
  complete: async () => ({ text: 'ok' }),
};

const streaming: AiProvider = {
  name: 'mock',
  complete: async () => ({ text: 'ok' }),
  async *stream(): AsyncIterable<ProviderChunk> {
    yield { type: 'text-delta', text: 'ok' };
    yield { type: 'done', text: 'ok' };
  },
};

describe('BaselineCaptureProvider transport transparency', () => {
  it('does not manufacture stream support for a completion-only provider', () => {
    const measured = new BaselineCaptureProvider(completionOnly);
    expect(measured.stream).toBeUndefined();
  });

  it('preserves stream support when the wrapped provider implements it', async () => {
    const measured = new BaselineCaptureProvider(streaming);
    expect(measured.stream).toBeTypeOf('function');

    const chunks: ProviderChunk[] = [];
    if (measured.stream === undefined) throw new Error('Expected streaming capability.');
    for await (const chunk of measured.stream({ messages: [] })) chunks.push(chunk);

    expect(chunks).toEqual([
      { type: 'text-delta', text: 'ok' },
      { type: 'done', text: 'ok' },
    ]);
    expect(measured.captured()).toHaveLength(1);
    expect(measured.captured()[0]?.streamed).toBe(true);
  });
});
