import { describe, expect, it } from 'vitest';
import {
  classifyLangChainError,
  classifyResponse,
  classifyStreamError,
  classifyThrown,
  kindForStatus,
  parseRetryAfterMs,
  readableErrorBody,
} from './errors.js';
import { ProviderError } from '../reliability/types.js';

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds into milliseconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = () => 1_000_000;
    const future = new Date(1_000_000 + 5_000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBeGreaterThanOrEqual(4_000);
  });

  it('returns undefined for missing, empty, or past values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
    const past = new Date(500).toUTCString();
    expect(parseRetryAfterMs(past, () => 1_000_000)).toBeUndefined();
  });
});

describe('kindForStatus', () => {
  it('maps known statuses', () => {
    expect(kindForStatus(429)).toBe('rate_limit');
    expect(kindForStatus(529)).toBe('overloaded');
    expect(kindForStatus(401)).toBe('auth');
    expect(kindForStatus(403)).toBe('auth');
    expect(kindForStatus(400)).toBe('bad_request');
    expect(kindForStatus(422)).toBe('bad_request');
    expect(kindForStatus(500)).toBe('server');
    expect(kindForStatus(503)).toBe('server');
    expect(kindForStatus(418)).toBe('bad_request');
  });
});

describe('classifyResponse', () => {
  const headers = (map: Record<string, string>) => ({
    get: (name: string) => map[name.toLowerCase()] ?? null,
  });

  it('classifies a 429 with Retry-After as retryable rate_limit', () => {
    const err = classifyResponse('Anthropic', 429, 'slow down', headers({ 'retry-after': '2' }));
    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.status).toBe(429);
  });

  it('classifies a 401 as non-retryable auth', () => {
    const err = classifyResponse('NVIDIA', 401, 'bad key');
    expect(err.kind).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('classifies a 5xx overloaded_error body as overloaded', () => {
    const err = classifyResponse('Anthropic', 503, '{"error":{"type":"overloaded_error"}}');
    expect(err.kind).toBe('overloaded');
    expect(err.retryable).toBe(true);
  });

  it('classifies a plain 500 as server', () => {
    const err = classifyResponse('Anthropic', 500, 'boom');
    expect(err.kind).toBe('server');
  });

  it('treats a 529 as overloaded regardless of body', () => {
    expect(classifyResponse('Anthropic', 529, '').kind).toBe('overloaded');
  });

  it('truncates a very long body in the message', () => {
    const err = classifyResponse('Anthropic', 400, 'x'.repeat(500));
    expect(err.message).toContain('…');
    expect(err.message.length).toBeLessThan(400);
  });
});

describe('classifyThrown', () => {
  it('passes a ProviderError through unchanged', () => {
    const original = new ProviderError('nope', 'auth');
    expect(classifyThrown('Anthropic', original)).toBe(original);
  });

  it('wraps a generic error as network', () => {
    const err = classifyThrown('NVIDIA', new Error('ECONNRESET'));
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('ECONNRESET');
  });

  it('wraps a non-Error thrown value', () => {
    expect(classifyThrown('mock', 'weird').kind).toBe('network');
  });
});

describe('classifyStreamError', () => {
  it('returns undefined for an ordinary content frame', () => {
    expect(
      classifyStreamError('Ollama', { choices: [{ delta: { content: 'hi' } }] }),
    ).toBeUndefined();
    expect(classifyStreamError('Ollama', null)).toBeUndefined();
    expect(classifyStreamError('Ollama', 'not-an-object')).toBeUndefined();
    expect(classifyStreamError('Ollama', { error: null })).toBeUndefined();
  });

  it('classifies an OpenAI-style in-stream error frame as retryable server failure', () => {
    const err = classifyStreamError('Ollama', {
      error: { message: 'Upstream server temporarily unavailable' },
    });
    expect(err?.kind).toBe('server');
    expect(err?.retryable).toBe(true);
    expect(err?.message).toContain('Ollama stream error');
    expect(err?.message).toContain('Upstream server');
  });

  it('classifies an Anthropic overloaded_error frame as overloaded', () => {
    const err = classifyStreamError('Anthropic', {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    });
    expect(err?.kind).toBe('overloaded');
    expect(err?.retryable).toBe(true);
  });

  it('maps rate-limit, auth and invalid-request frame types to their kinds', () => {
    expect(classifyStreamError('x', { error: { type: 'rate_limit_error' } })?.kind).toBe(
      'rate_limit',
    );
    expect(classifyStreamError('x', { error: { type: 'authentication_error' } })?.kind).toBe(
      'auth',
    );
    expect(classifyStreamError('x', { error: { type: 'invalid_request_error' } })?.retryable).toBe(
      false,
    );
  });

  it('reads a bare string error and serializes an unrecognized shape', () => {
    expect(classifyStreamError('x', { error: 'boom' })?.message).toContain('boom');
    expect(classifyStreamError('x', { error: { code: 7 } })?.message).toContain('"code":7');
  });

  it('truncates a very long frame message', () => {
    const err = classifyStreamError('x', { error: { message: 'y'.repeat(500) } });
    expect(err?.message).toContain('…');
    expect(err?.message.length).toBeLessThan(400);
  });
});

describe('classifyLangChainError', () => {
  /** The shape a provider SDK throws: a message plus the status it saw. */
  const apiError = (status: number, message: string): Error =>
    Object.assign(new Error(message), { status });

  it('types a wrong base URL as a permanent failure instead of a retryable one', () => {
    // The regression this exists for: pointing the app at a server that does not serve
    // the OpenAI route produced an HTML 404 that reached the sidebar verbatim, typed
    // `network`, and was retried the full budget before failing.
    const html =
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot POST /api/chat</pre>\n</body>\n</html>\n';
    const error = classifyLangChainError('openai-compatible', apiError(404, html));
    expect(error.kind).toBe('bad_request');
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(404);
    expect(error.message).toBe('openai-compatible API error 404: Cannot POST /api/chat');
    expect(error.message).not.toContain('<');
  });

  it('keeps a rate limit and a server fault retryable', () => {
    expect(classifyLangChainError('groq', apiError(429, 'slow down')).retryable).toBe(true);
    expect(classifyLangChainError('groq', apiError(503, 'upstream gone')).kind).toBe('server');
  });

  it('reads an auth failure as permanent', () => {
    const error = classifyLangChainError('nvidia', apiError(401, 'invalid api key'));
    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
  });

  it('recognises an overloaded 5xx', () => {
    expect(classifyLangChainError('anthropic', apiError(500, 'overloaded_error')).kind).toBe(
      'overloaded',
    );
  });

  it('reads the status off a nested response object', () => {
    const error = classifyLangChainError('x', { response: { status: 403 }, message: 'nope' });
    expect(error.status).toBe(403);
    expect(error.kind).toBe('auth');
  });

  it('falls back to a network error when no status is attached', () => {
    // A DNS failure or refused connection carries no HTTP status, and retrying it is
    // the right behaviour — unlike a 4xx.
    const error = classifyLangChainError('ollama', new Error('fetch failed'));
    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('ollama request failed: fetch failed');
  });

  it('handles a thrown non-object', () => {
    const error = classifyLangChainError('x', 'plain string failure');
    expect(error.kind).toBe('network');
    expect(error.message).toContain('plain string failure');
  });

  it('passes an already-typed error through untouched', () => {
    const original = new ProviderError('already typed', 'bad_request');
    expect(classifyLangChainError('x', original)).toBe(original);
  });
});

describe('readableErrorBody', () => {
  it('lifts the reason out of an HTML error page', () => {
    expect(readableErrorBody('<html><body><pre>Cannot POST /api/chat</pre></body></html>')).toBe(
      'Cannot POST /api/chat',
    );
  });

  it('falls back to the page title, then to stripped markup', () => {
    expect(readableErrorBody('<html><head><title>502 Bad Gateway</title></head></html>')).toBe(
      '502 Bad Gateway',
    );
    expect(readableErrorBody('<html><body><h1>nginx</h1></body></html>')).toBe('nginx');
  });

  it('leaves a plain (JSON) body alone', () => {
    expect(readableErrorBody('{"error":{"message":"bad model"}}')).toBe(
      '{"error":{"message":"bad model"}}',
    );
  });

  it('truncates an overlong HTML reason', () => {
    const result = readableErrorBody(`<html><body><pre>${'z'.repeat(1000)}</pre></body></html>`);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBe(301);
  });

  it('truncates an overlong body', () => {
    const result = readableErrorBody('z'.repeat(1000));
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBe(301);
  });
});
