import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { ProjectFileWatcher, type ProjectWatcherDeps } from './project-watcher.js';

const PATH = '/projects/large.fp.json';
const DEBOUNCE_MS = 20;
const projectNamed = (name: string): Project => ({ name }) as unknown as Project;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

describe('ProjectFileWatcher open/save-path performance', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns after installing the native watch without awaiting the duplicate baseline parse', async () => {
    const baseline = deferred<Project>();
    let current = projectNamed('opened');
    let firstRead = true;
    let fire: (() => void) | undefined;
    const emit = vi.fn();
    const read = vi.fn(() => {
      if (firstRead) {
        firstRead = false;
        return baseline.promise;
      }
      return Promise.resolve(current);
    });
    const deps: ProjectWatcherDeps = {
      watch: (_path, onChange) => {
        fire = onChange;
        return () => undefined;
      },
      read,
      serialize: (project) => JSON.stringify(project),
      emit,
      debounceMs: DEBOUNCE_MS,
    };
    const watcher = new ProjectFileWatcher(deps);

    await expect(watcher.watch(PATH)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);

    current = projectNamed('external edit');
    fire?.();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();

    baseline.resolve(projectNamed('opened'));
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(read).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith({ path: PATH, project: current });
  });

  it('performs zero native watch/read work when autosave reaffirms the same project path', async () => {
    const stop = vi.fn();
    const watch = vi.fn(() => stop);
    const read = vi.fn(async () => projectNamed('opened'));
    const watcher = new ProjectFileWatcher({
      watch,
      read,
      serialize: (project) => JSON.stringify(project),
      emit: vi.fn(),
    });

    await watcher.watch(PATH);
    await Promise.resolve();
    const initialWatchCalls = watch.mock.calls.length;
    const initialReadCalls = read.mock.calls.length;

    await watcher.watch(PATH);
    await watcher.watch(PATH);
    await watcher.watch(PATH);

    expect(watch).toHaveBeenCalledTimes(initialWatchCalls);
    expect(read).toHaveBeenCalledTimes(initialReadCalls);
    expect(stop).not.toHaveBeenCalled();
  });
});
