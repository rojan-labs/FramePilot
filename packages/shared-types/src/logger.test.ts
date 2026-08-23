/**
 * Tests for the scoped logger (`./logger`), specifically the secret-redaction
 * barrier (CodeQL alert #61): sensitive keys must never reach the console sink
 * in clear text, even when callers log whole config objects.
 *
 * The logger captures the platform sinks at import time (`console.log.bind`),
 * so the stubs are installed BEFORE the module is dynamically imported.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

type Sink = (...args: unknown[]) => void;
const calls: { log: unknown[][]; warn: unknown[][]; error: unknown[][] } = {
  log: [],
  warn: [],
  error: [],
};

function record(bucket: unknown[][], original: Sink): Sink {
  return (...args: unknown[]) => {
    bucket.push(args);
    original(...args);
  };
}

vi.stubGlobal('console', {
  ...console,
  log: record(calls.log, console.log.bind(console)),
  warn: record(calls.warn, console.warn.bind(console)),
  error: record(calls.error, console.error.bind(console)),
});

const { createLogger } = await import('./logger.js');

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('createLogger redaction', () => {
  it('redacts top-level sensitive keys', () => {
    createLogger('test:redact').info('config', {
      asrApiKey: 'sk-super-secret',
      asrModel: 'legacy-model',
    });
    const [, payload] = calls.log.at(-1) ?? [];
    expect(payload).toMatchObject({ asrApiKey: '[REDACTED]', asrModel: 'legacy-model' });
  });

  it('redacts nested and array-embedded sensitive keys', () => {
    createLogger('test:redact').debug('nested', {
      providers: [{ apiKey: 'abc' }, { name: 'ollama' }],
      // A sensitive key redacts its whole subtree, not just leaf strings.
      auth: { password: 'hunter2', label: 'safe' },
      meta: { password: 'hunter2', label: 'safe' },
    });
    const [, payload] = calls.log.at(-1) ?? [];
    expect(payload).toEqual({
      providers: [{ apiKey: '[REDACTED]' }, { name: 'ollama' }],
      auth: '[REDACTED]',
      meta: { password: '[REDACTED]', label: 'safe' },
    });
  });

  it('tolerates circular structures without throwing', () => {
    const self: Record<string, unknown> = { token: 't' };
    self['self'] = self;
    expect(() => createLogger('test:redact').warn('circular', self)).not.toThrow();
    const [, payload] = calls.warn.at(-1) ?? [];
    expect(payload).toMatchObject({ token: '[REDACTED]' });
  });
});
