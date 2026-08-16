/** Tests for the hosted-ASR comma-separated key-ring failover helper. */
import { describe, expect, it, vi } from 'vitest';
import { parseAsrKeyRing, transcribeWithKeyRing } from './asr-keyring.js';
import { ProviderError } from '../reliability/types.js';
import type { AsrResult } from './asr-types.js';
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('test:asr-keyring');
const ok: AsrResult = { available: true, words: [] };

describe('parseAsrKeyRing', () => {
  it('returns an empty ring for undefined/blank', () => {
    expect(parseAsrKeyRing(undefined)).toEqual([]);
    expect(parseAsrKeyRing('   ')).toEqual([]);
    expect(parseAsrKeyRing(', ,')).toEqual([]);
  });

  it('splits, trims, and de-duplicates while preserving order', () => {
    expect(parseAsrKeyRing('k1')).toEqual(['k1']);
    expect(parseAsrKeyRing(' k1 , k2 ,k1, k3 ')).toEqual(['k1', 'k2', 'k3']);
  });
});

describe('transcribeWithKeyRing', () => {
  it('returns the first key that succeeds without trying the rest', async () => {
    const attempt = vi.fn(async () => ok);
    const result = await transcribeWithKeyRing(['a', 'b', 'c'], attempt, log);
    expect(result).toBe(ok);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith('a');
  });

  it('rotates through keys on retryable failures until one works', async () => {
    const attempt = vi.fn(async (key: string) => {
      if (key !== 'c') throw new ProviderError('x', 'rate_limit');
      return ok;
    });
    const result = await transcribeWithKeyRing(['a', 'b', 'c'], attempt, log);
    expect(result).toBe(ok);
    expect(attempt.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
  });

  it('fails fast on a bad_request without burning the rest of the ring', async () => {
    const attempt = vi.fn(async () => {
      throw new ProviderError('x', 'bad_request');
    });
    await expect(transcribeWithKeyRing(['a', 'b'], attempt, log)).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('rotates past a non-ProviderError failure (network error, etc.)', async () => {
    const attempt = vi.fn(async (key: string) => {
      if (key !== 'b') throw new Error('fetch failed');
      return ok;
    });
    const result = await transcribeWithKeyRing(['a', 'b'], attempt, log);
    expect(result).toBe(ok);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error for an empty ring instead of silently resolving', async () => {
    const attempt = vi.fn(async () => ok);
    await expect(transcribeWithKeyRing([], attempt, log)).rejects.toThrow(
      /requires at least one key/,
    );
    expect(attempt).not.toHaveBeenCalled();
  });

  it('rethrows the last error when the whole ring is exhausted', async () => {
    const errors = [new ProviderError('first', 'auth'), new ProviderError('last', 'server')];
    let i = 0;
    const attempt = vi.fn(async () => {
      throw errors[i++];
    });
    await expect(transcribeWithKeyRing(['a', 'b'], attempt, log)).rejects.toBe(errors[1]);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
