import type { Logger } from '@framepilot/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { installScopedConsoleRouter, type ConsoleLike } from './scoped-console.js';

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    action: vi.fn(),
    child: vi.fn(),
  };
}

function target(): ConsoleLike {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('installScopedConsoleRouter', () => {
  it('routes legacy console output through the supplied scoped logger', () => {
    const consoleTarget = target();
    const scoped = logger();
    installScopedConsoleRouter(consoleTarget, scoped);

    consoleTarget.log('startup provider', { provider: 'nvidia' });
    consoleTarget.warn('watch retry');
    consoleTarget.error(new Error('boom'));

    expect(scoped.info).toHaveBeenCalledWith('startup provider', { provider: 'nvidia' });
    expect(scoped.warn).toHaveBeenCalledWith('watch retry', undefined);
    expect(scoped.error).toHaveBeenCalledWith('legacy console output', expect.any(Error));
  });

  it('restores the original console methods', () => {
    const consoleTarget = target();
    const originalLog = consoleTarget.log;
    const restore = installScopedConsoleRouter(consoleTarget, logger());

    restore();

    expect(consoleTarget.log).toBe(originalLog);
  });
});
