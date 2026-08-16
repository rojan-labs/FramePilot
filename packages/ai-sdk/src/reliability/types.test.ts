import { describe, expect, it } from 'vitest';
import {
  CONTEXT_TIERS,
  DEFAULT_RETRY_POLICY,
  ProviderError,
  isProviderError,
  isRetryableKind,
} from './types.js';

describe('ProviderError', () => {
  it('derives retryable from kind by default', () => {
    expect(new ProviderError('x', 'rate_limit').retryable).toBe(true);
    expect(new ProviderError('x', 'auth').retryable).toBe(false);
  });

  it('honors an explicit retryable override and carries status/retryAfterMs', () => {
    const err = new ProviderError('x', 'bad_request', {
      status: 400,
      retryable: true,
      retryAfterMs: 5,
    });
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(400);
    expect(err.retryAfterMs).toBe(5);
    expect(err.name).toBe('ProviderError');
  });
});

describe('isRetryableKind', () => {
  it('classifies every kind', () => {
    expect(isRetryableKind('rate_limit')).toBe(true);
    expect(isRetryableKind('overloaded')).toBe(true);
    expect(isRetryableKind('server')).toBe(true);
    expect(isRetryableKind('network')).toBe(true);
    expect(isRetryableKind('auth')).toBe(false);
    expect(isRetryableKind('bad_request')).toBe(false);
  });
});

describe('isProviderError', () => {
  it('narrows ProviderError instances', () => {
    expect(isProviderError(new ProviderError('x', 'server'))).toBe(true);
    expect(isProviderError(new Error('x'))).toBe(false);
    expect(isProviderError('x')).toBe(false);
  });
});

describe('constants', () => {
  it('exposes a conservative default policy and ordered tiers', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
    expect(CONTEXT_TIERS[0]).toBe('system');
    expect(CONTEXT_TIERS.at(-1)).toBe('transcript');
  });
});
