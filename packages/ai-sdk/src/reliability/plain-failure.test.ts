import { describe, expect, it } from 'vitest';
import { plainRunFailure } from './plain-failure.js';
import { ProviderError, type ProviderErrorKind } from './types.js';

/**
 * Replicated from `src/eval/golden-metrics.ts` (INTERNAL_LEAK / MIN_EXPLAINED_LENGTH)
 * on purpose: this module must not import the eval harness, but every sentence it
 * produces has to pass the harness's own failure-quality predicate. If the harness
 * tightens its regex, this copy is the thing that should fail first.
 */
const INTERNAL_LEAK =
  /Internal Server Error|TypeError|ReferenceError|\bundefined\b|\bat\s+\S+\s+\(.*:\d+:\d+\)/;
const MIN_EXPLAINED_LENGTH = 20;

function isExplained(message: string): boolean {
  return message.length >= MIN_EXPLAINED_LENGTH && !INTERNAL_LEAK.test(message);
}

describe('plainRunFailure', () => {
  it('tells the editor where the API key lives on an auth failure', () => {
    const result = plainRunFailure(
      new ProviderError('anthropic API error 401: invalid x-api-key', 'auth', { status: 401 }),
      'Anthropic',
    );
    expect(result.message).toBe(
      "FramePilot can't sign in to Anthropic. Check the API key in Settings → AI, then try again.",
    );
    expect(result.retryable).toBe(false);
    expect(result.detail).toBe('anthropic API error 401: invalid x-api-key (HTTP 401)');
  });

  it('names the wait from Retry-After on a rate limit', () => {
    const result = plainRunFailure(
      new ProviderError('anthropic API error 429', 'rate_limit', {
        status: 429,
        retryAfterMs: 30_000,
      }),
      'Anthropic',
    );
    expect(result.message).toBe(
      'Anthropic is rate-limiting requests. Wait 30 seconds and try again.',
    );
    expect(result.retryable).toBe(true);
  });

  it('says "a minute" when the server sent no Retry-After', () => {
    const result = plainRunFailure(new ProviderError('429', 'rate_limit'), 'OpenRouter');
    expect(result.message).toBe(
      'OpenRouter is rate-limiting requests. Wait a minute and try again.',
    );
  });

  it('rounds a sub-second Retry-After up to one second, singular', () => {
    const result = plainRunFailure(
      new ProviderError('429', 'rate_limit', { retryAfterMs: 400 }),
      'OpenRouter',
    );
    expect(result.message).toContain('Wait 1 second and try again.');
  });

  it('ignores a zero or nonsense Retry-After', () => {
    for (const retryAfterMs of [0, -5, Number.NaN]) {
      const result = plainRunFailure(
        new ProviderError('429', 'rate_limit', { retryAfterMs }),
        'OpenRouter',
      );
      expect(result.message).toContain('Wait a minute and try again.');
    }
  });

  it('reassures that the timeline is untouched when the provider is overloaded', () => {
    const result = plainRunFailure(
      new ProviderError('overloaded_error', 'overloaded'),
      'Anthropic',
    );
    expect(result.message).toBe(
      'Anthropic is having trouble right now (server error). Try again in a minute; nothing on your timeline was changed by this failure.',
    );
    expect(result.retryable).toBe(true);
  });

  it('uses the same server-trouble sentence for a 5xx', () => {
    const result = plainRunFailure(
      new ProviderError('anthropic API error 503', 'server', { status: 503 }),
      'Anthropic',
    );
    expect(result.message).toContain('is having trouble right now (server error)');
    expect(result.detail).toBe('anthropic API error 503 (HTTP 503)');
  });

  it('points at the connection on a classified network failure', () => {
    const result = plainRunFailure(new ProviderError('socket hang up', 'network'), 'Anthropic');
    expect(result.message).toBe(
      "FramePilot couldn't reach Anthropic. Check your connection (or the proxy/bridge you use) and try again.",
    );
  });

  it('points at the model or setting on a bad request', () => {
    const result = plainRunFailure(
      new ProviderError('anthropic API error 400: max_tokens too large', 'bad_request', {
        status: 400,
      }),
      'Anthropic',
    );
    expect(result.message).toBe(
      'Anthropic rejected the request. This is usually a model or setting mismatch — open the details, and try a shorter request or a different model.',
    );
    expect(result.retryable).toBe(false);
  });

  it('reads an unclassified transport TypeError as a connection problem', () => {
    const result = plainRunFailure(new TypeError('fetch failed'), 'Anthropic');
    expect(result.message).toBe(
      "FramePilot couldn't reach Anthropic. Check your connection (or the proxy/bridge you use) and try again.",
    );
    expect(result.detail).toBe('fetch failed');
    expect(result.retryable).toBe(true);
  });

  it.each(['connect ECONNREFUSED 127.0.0.1:8317', 'getaddrinfo ENOTFOUND api.anthropic.com'])(
    'recognises %s as a transport failure',
    (raw) => {
      expect(plainRunFailure(new Error(raw), 'Anthropic').message).toContain("couldn't reach");
    },
  );

  it('falls back to a generic actionable sentence for anything else', () => {
    const result = plainRunFailure(new SyntaxError('Unexpected token < in JSON at position 0'));
    expect(result.message).toBe(
      'The AI run stopped unexpectedly. Try again; if it keeps happening, copy the details below when you report it.',
    );
    expect(result.detail).toBe('Unexpected token < in JSON at position 0');
    expect(result.retryable).toBe(true);
  });

  it('stringifies a non-Error throw into detail without losing it', () => {
    expect(plainRunFailure('boom').detail).toBe('boom');
  });

  it('uses a neutral provider name when none is given', () => {
    const result = plainRunFailure(new ProviderError('401', 'auth'), undefined);
    expect(result.message).toContain('the AI provider');
    expect(plainRunFailure(new ProviderError('401', 'auth'), '   ').message).toContain(
      'the AI provider',
    );
  });

  it('omits the HTTP suffix when the status is unknown', () => {
    expect(plainRunFailure(new ProviderError('socket hang up', 'network')).detail).toBe(
      'socket hang up',
    );
  });

  it('keeps a sentence the thrower already wrote for the editor', () => {
    // The empty-response failure names its own cause and next step; the generic
    // server copy would be a downgrade, so `editorMessage` wins over `kind`.
    const written =
      'The model used its entire output allowance without producing an answer. Ask for a smaller step.';
    const result = plainRunFailure(
      new ProviderError(written, 'server', { editorMessage: written }),
      'Anthropic',
    );
    expect(result.message).toBe(written);
    expect(isExplained(result.message)).toBe(true);
  });

  it('mirrors an explicitly overridden ProviderError.retryable', () => {
    const error = new ProviderError('429 but hopeless', 'rate_limit', { retryable: false });
    expect(plainRunFailure(error, 'Anthropic').retryable).toBe(false);
  });

  const KINDS: readonly ProviderErrorKind[] = [
    'rate_limit',
    'overloaded',
    'server',
    'network',
    'auth',
    'bad_request',
  ];

  it.each(KINDS)("every %s message passes the harness's failure-quality predicate", (kind) => {
    const message = plainRunFailure(
      new ProviderError('TypeError: fetch failed — undefined at foo (bar.ts:1:2)', kind, {
        status: 500,
        retryAfterMs: 30_000,
      }),
      'Anthropic',
    ).message;
    expect(isExplained(message)).toBe(true);
  });

  it('keeps the fallback and transport sentences explained too', () => {
    expect(isExplained(plainRunFailure(new Error('kaboom')).message)).toBe(true);
    expect(isExplained(plainRunFailure(new TypeError('fetch failed')).message)).toBe(true);
  });
});
