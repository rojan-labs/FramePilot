import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CONFIG_TEXT_SETTLE_MS, AiConfigStore } from './ai-config.js';

describe('AiConfigStore performance boundaries', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'fp-aicfg-perf-'));
    file = join(dir, 'ai-config.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('coalesces text-input updates and persists only the settled value', () => {
    const store = new AiConfigStore(file);

    store.applyUpdate({ models: { anthropic: 'c' } });
    store.applyUpdate({ models: { anthropic: 'cl' } });
    store.applyUpdate({ models: { anthropic: 'claude-final' } });

    expect(existsSync(file)).toBe(false);
    expect(store.resolveConfig('anthropic').model).toBe('claude-final');

    vi.advanceTimersByTime(AI_CONFIG_TEXT_SETTLE_MS - 1);
    expect(existsSync(file)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      anthropic: { model: 'claude-final' },
    });
  });

  it('flushes a pending text edit before an immediate durability update', () => {
    const store = new AiConfigStore(file);
    store.applyUpdate({ baseUrls: { ollama: 'http://localhost:11434/v1' } });
    expect(existsSync(file)).toBe(false);

    store.applyUpdate({ activeProvider: 'ollama' });

    const persisted = JSON.parse(readFileSync(file, 'utf8')) as {
      activeProvider: string;
      ollama: { baseUrl?: string };
    };
    expect(persisted.activeProvider).toBe('ollama');
    expect(persisted.ollama.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('flushes the settled text state explicitly for shutdown boundaries', () => {
    const store = new AiConfigStore(file);
    store.applyUpdate({ models: { deepseek: 'deepseek-reasoner' } });
    expect(existsSync(file)).toBe(false);

    store.flush();

    expect(new AiConfigStore(file).resolveConfig('deepseek').model).toBe('deepseek-reasoner');
  });

  it('arms one synchronous process-exit flush for a pending text burst', () => {
    const once = vi.spyOn(process, 'once');
    const store = new AiConfigStore(file);

    store.applyUpdate({ models: { anthropic: 'claude-a' } });
    store.applyUpdate({ models: { anthropic: 'claude-b' } });

    const exitRegistrations = once.mock.calls.filter(([event]) => event === 'exit');
    expect(exitRegistrations).toHaveLength(1);

    const listener = exitRegistrations[0]?.[1];
    if (typeof listener === 'function') process.removeListener('exit', listener);
    store.flush();
    once.mockRestore();
  });
});
