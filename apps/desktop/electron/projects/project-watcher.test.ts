/**
 * Tests for {@link ProjectFileWatcher} — the dedup + debounce logic that turns
 * raw filesystem events on `project.fp.json` into validated external-change
 * pushes, while suppressing the app's own writes (ADR 0030). All IO is faked;
 * fake timers drive the debounce so no wall-clock time passes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { ProjectFileWatcher, type ProjectWatcherDeps } from './project-watcher.js';

const PATH = '/projects/demo.fp.json';
const DEBOUNCE = 20;

/** A throwaway project whose `name` is the only field the tests vary. */
const projectNamed = (name: string): Project => ({ name }) as unknown as Project;

interface Harness {
  watcher: ProjectFileWatcher;
  deps: ProjectWatcherDeps;
  /** Simulate a filesystem event on the watched file. */
  fire(): void;
  /** Set what the next `read` returns (a project) or throws (an Error). */
  setFile(value: Project | Error): void;
  emitted: { path: string; project: Project }[];
  errors: unknown[];
  watchStops: number;
}

function harness(initial: Project | Error = projectNamed('initial')): Harness {
  let fileValue = initial;
  let onChange: (() => void) | null = null;
  let watchStops = 0;
  const emitted: { path: string; project: Project }[] = [];
  const errors: unknown[] = [];

  const deps: ProjectWatcherDeps = {
    watch: (_path, cb) => {
      onChange = cb;
      return () => {
        watchStops += 1;
        onChange = null;
      };
    },
    read: (_path) =>
      fileValue instanceof Error ? Promise.reject(fileValue) : Promise.resolve(fileValue),
    serialize: (project) => JSON.stringify(project),
    emit: (change) => emitted.push({ path: change.path, project: change.project }),
    onError: (error) => errors.push(error),
    debounceMs: DEBOUNCE,
  };

  return {
    watcher: new ProjectFileWatcher(deps),
    deps,
    fire: () => onChange?.(),
    setFile: (value) => {
      fileValue = value;
    },
    emitted,
    errors,
    get watchStops() {
      return watchStops;
    },
  };
}

/** Advance past the debounce window and flush the async flush() microtasks. */
const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(DEBOUNCE);

describe('ProjectFileWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits a validated change when the file is edited externally', async () => {
    const h = harness(projectNamed('v1'));
    await h.watcher.watch(PATH);

    h.setFile(projectNamed('v2'));
    h.fire();
    await settle();

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toEqual({ path: PATH, project: projectNamed('v2') });
  });

  it('does not emit the project it just started watching (baseline)', async () => {
    const h = harness(projectNamed('same'));
    await h.watcher.watch(PATH);

    // An event that re-reads identical content is a no-op.
    h.fire();
    await settle();

    expect(h.emitted).toHaveLength(0);
  });

  it('suppresses the app’s own writes via markSelfWrite', async () => {
    const h = harness(projectNamed('v1'));
    await h.watcher.watch(PATH);

    // The app saves v2 and pre-declares it; the resulting fs event must not echo.
    h.setFile(projectNamed('v2'));
    h.watcher.markSelfWrite(PATH, projectNamed('v2'));
    h.fire();
    await settle();

    expect(h.emitted).toHaveLength(0);

    // A subsequent *external* edit (v3) is still delivered.
    h.setFile(projectNamed('v3'));
    h.fire();
    await settle();
    expect(h.emitted).toEqual([{ path: PATH, project: projectNamed('v3') }]);
  });

  it('ignores markSelfWrite for a path it is not watching', async () => {
    const h = harness(projectNamed('v1'));
    await h.watcher.watch(PATH);

    h.watcher.markSelfWrite('/projects/other.fp.json', projectNamed('v2'));
    h.setFile(projectNamed('v2'));
    h.fire();
    await settle();

    // The stale path did not move the baseline, so the real edit still emits.
    expect(h.emitted).toEqual([{ path: PATH, project: projectNamed('v2') }]);
  });

  it('coalesces a burst of events into a single read + emit', async () => {
    const h = harness(projectNamed('v1'));
    await h.watcher.watch(PATH);
    const readSpy = vi.spyOn(h.deps, 'read');

    h.setFile(projectNamed('v2'));
    h.fire();
    h.fire();
    h.fire();
    await settle();

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(h.emitted).toHaveLength(1);
  });

  it('swallows a transient read failure and keeps watching', async () => {
    const h = harness(projectNamed('v1'));
    await h.watcher.watch(PATH);

    // A read mid-rename fails — no emit, but the error is reported.
    h.setFile(new Error('half-written'));
    h.fire();
    await settle();
    expect(h.emitted).toHaveLength(0);
    expect(h.errors).toHaveLength(1);

    // Once the write settles, the next event delivers the change.
    h.setFile(projectNamed('v2'));
    h.fire();
    await settle();
    expect(h.emitted).toEqual([{ path: PATH, project: projectNamed('v2') }]);
  });

  it('tolerates an invalid file at watch-start, then emits the first valid read', async () => {
    const h = harness(new Error('missing at start'));
    await h.watcher.watch(PATH); // baseline is null (no valid content yet)

    h.setFile(projectNamed('first'));
    h.fire();
    await settle();

    expect(h.emitted).toEqual([{ path: PATH, project: projectNamed('first') }]);
  });

  it('switching to a new path stops the old watch and re-baselines', async () => {
    const h = harness(projectNamed('a'));
    await h.watcher.watch(PATH);
    expect(h.watchStops).toBe(0);

    await h.watcher.watch('/projects/b.fp.json');
    expect(h.watchStops).toBe(1);

    // Re-watching the same path is a no-op (no extra stop).
    await h.watcher.watch('/projects/b.fp.json');
    expect(h.watchStops).toBe(1);
  });

  it('falls back to the default debounce when none is configured', async () => {
    const h = harness(projectNamed('v1'));
    // Rebuild deps without an explicit debounceMs so the default window applies.
    const { debounceMs: _omitted, ...rest } = h.deps;
    const watcher = new ProjectFileWatcher(rest);
    await watcher.watch(PATH);

    h.setFile(projectNamed('v2'));
    h.fire();
    // The default window (>DEBOUNCE) has not elapsed yet — nothing emitted.
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(h.emitted).toHaveLength(0);
    // After the full default window the change is delivered.
    await vi.advanceTimersByTimeAsync(200);
    expect(h.emitted).toEqual([{ path: PATH, project: projectNamed('v2') }]);
  });

  it('stop() cancels a pending flush and stops watching', async () => {
    const h = harness(projectNamed('v1'));
    await h.watcher.watch(PATH);

    h.setFile(projectNamed('v2'));
    h.fire(); // schedules a flush
    h.watcher.stop(); // …which stop() must cancel
    await settle();

    expect(h.emitted).toHaveLength(0);
    expect(h.watchStops).toBe(1);
  });
});
