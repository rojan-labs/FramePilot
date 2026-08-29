import { describe, expect, it, vi } from 'vitest';
import { SidecarManager, type SidecarProcess } from './manager.js';

/** A controllable fake sidecar process. */
function fakeProcess(): SidecarProcess & {
  emitExit: (code: number | null) => void;
  emitError: (error: Error) => void;
  killed: boolean;
} {
  let exitListener: ((code: number | null) => void) | null = null;
  let errorListener: ((error: Error) => void) | null = null;
  const proc = {
    pid: 4321,
    killed: false,
    kill() {
      proc.killed = true;
    },
    onExit(listener: (code: number | null) => void) {
      exitListener = listener;
    },
    onError(listener: (error: Error) => void) {
      errorListener = listener;
    },
    emitExit(code: number | null) {
      exitListener?.(code);
    },
    emitError(error: Error) {
      errorListener?.(error);
    },
  };
  return proc;
}

/** A probe that returns each queued value in turn, then its last value forever. */
function scriptedProbe(results: boolean[]) {
  let index = 0;
  return vi.fn(async () => {
    const value = results[Math.min(index, results.length - 1)] ?? false;
    index += 1;
    return value;
  });
}

const noSleep = () => Promise.resolve();

describe('SidecarManager', () => {
  it('starts stopped with no base URL', () => {
    const manager = new SidecarManager({ spawn: fakeProcess, probe: async () => false });
    expect(manager.status).toEqual({ phase: 'stopped', baseUrl: null, detail: null });
  });

  it('becomes ready when the engine answers the first health probe', async () => {
    const proc = fakeProcess();
    const manager = new SidecarManager({
      spawn: () => proc,
      probe: scriptedProbe([true]),
      sleep: noSleep,
      host: '127.0.0.1',
      port: 9000,
    });

    const status = await manager.start();

    expect(status.phase).toBe('ready');
    expect(status.baseUrl).toBe('http://127.0.0.1:9000');
    expect(manager.baseUrl).toBe('http://127.0.0.1:9000');
  });

  it('polls until the engine is ready', async () => {
    const probe = scriptedProbe([false, false, true]);
    const manager = new SidecarManager({
      spawn: fakeProcess,
      probe,
      sleep: noSleep,
      probeIntervalMs: 50,
      startupTimeoutMs: 1000,
    });

    const status = await manager.start();

    expect(status.phase).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('treats a throwing probe as not-ready and eventually times out', async () => {
    const probe = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const proc = fakeProcess();
    const manager = new SidecarManager({
      spawn: () => proc,
      probe,
      sleep: noSleep,
      probeIntervalMs: 100,
      startupTimeoutMs: 300,
    });

    const status = await manager.start();

    expect(status.phase).toBe('failed');
    expect(status.detail).toContain('did not become ready');
    expect(proc.killed).toBe(true); // a failed startup tears down the process
  });

  it('fails fast when the process exits during startup', async () => {
    const proc = fakeProcess();
    const probe = vi.fn(async () => {
      proc.emitExit(1); // engine crashes before answering
      return false;
    });
    const manager = new SidecarManager({
      spawn: () => proc,
      probe,
      sleep: noSleep,
      probeIntervalMs: 10,
      startupTimeoutMs: 1000,
    });

    const status = await manager.start();

    expect(status.phase).toBe('failed');
    expect(status.detail).toContain('exited');
    expect(probe).toHaveBeenCalledTimes(1); // stopped polling after the exit
  });

  it('fails fast with the error message when spawn fails (e.g. ENOENT)', async () => {
    const proc = fakeProcess();
    const probe = vi.fn(async () => {
      proc.emitError(new Error('spawn uv ENOENT'));
      return false;
    });
    const manager = new SidecarManager({
      spawn: () => proc,
      probe,
      sleep: noSleep,
      probeIntervalMs: 10,
      startupTimeoutMs: 1000,
    });

    const status = await manager.start();

    expect(status.phase).toBe('failed');
    expect(status.detail).toContain('spawn uv ENOENT');
    expect(probe).toHaveBeenCalledTimes(1); // stopped polling after the error
  });

  it('is a no-op when start is called while already ready', async () => {
    const spawn = vi.fn(fakeProcess);
    const manager = new SidecarManager({ spawn, probe: async () => true, sleep: noSleep });

    await manager.start();
    const second = await manager.start();

    expect(second.phase).toBe('ready');
    expect(spawn).toHaveBeenCalledTimes(1); // did not respawn
  });

  it('kills the process and returns to stopped on stop()', async () => {
    const proc = fakeProcess();
    const manager = new SidecarManager({
      spawn: () => proc,
      probe: async () => true,
      sleep: noSleep,
    });

    await manager.start();
    manager.stop();

    expect(proc.killed).toBe(true);
    expect(manager.status).toEqual({ phase: 'stopped', baseUrl: null, detail: null });
  });

  // Was "marks failed": since P5.5 an exit after ready is RECOVERABLE, so the manager
  // reports what it is doing about it rather than a dead end. Exhausting the budget
  // still ends in `failed` — see the recovery block below.
  it('reports an exit after becoming ready as a restart in progress, naming the cause', async () => {
    const proc = fakeProcess();
    const manager = new SidecarManager({
      spawn: () => proc,
      probe: async () => true,
      sleep: () => new Promise(() => undefined), // hold the backoff open
      maxRestarts: 1,
    });

    await manager.start();
    proc.emitExit(null);

    expect(manager.status.phase).toBe('starting');
    expect(manager.status.detail).toContain('exited');
    expect(manager.status.detail).toContain('Restarting (attempt 1 of 1)');
  });

  it('marks failed when the engine keeps dying past the restart budget', async () => {
    const processes = [fakeProcess(), fakeProcess()];
    let spawned = 0;
    const manager = new SidecarManager({
      spawn: () => processes[spawned++]!,
      probe: async () => true,
      sleep: noSleep,
      maxRestarts: 1,
    });

    await manager.start();
    processes[0]!.emitExit(null);
    await vi.waitFor(() => expect(manager.status.phase).toBe('ready'));
    processes[1]!.emitExit(null);

    expect(manager.status.phase).toBe('failed');
    expect(manager.status.detail).toContain('exited');
  });

  it('stop() is safe before any start', () => {
    const manager = new SidecarManager({ spawn: fakeProcess, probe: async () => false });
    expect(() => manager.stop()).not.toThrow();
    expect(manager.status.phase).toBe('stopped');
  });

  it('uses the default (real) sleep between probes when none is injected', async () => {
    // No `sleep` override → exercises the real setTimeout-backed delay. A 1ms
    // interval keeps the test fast while still hitting the default code path.
    const manager = new SidecarManager({
      spawn: fakeProcess,
      probe: scriptedProbe([false, true]),
      probeIntervalMs: 1,
      startupTimeoutMs: 1000,
    });

    const status = await manager.start();

    expect(status.phase).toBe('ready');
  });

  // P5.5 — recovery. An engine that dies under a running app comes back on its own,
  // a bounded number of times, and every phase change is observable.
  describe('recovery (P5.5)', () => {
    it('restarts an engine that exits after becoming ready and becomes ready again', async () => {
      const processes = [fakeProcess(), fakeProcess()];
      let spawned = 0;
      const spawn = vi.fn(() => processes[spawned++]!);
      const phases: string[] = [];
      const manager = new SidecarManager({
        spawn,
        probe: scriptedProbe([true]),
        sleep: noSleep,
        onStatusChange: (status) => phases.push(status.phase),
      });
      await manager.start();
      expect(manager.status.phase).toBe('ready');

      processes[0]!.emitExit(137);
      expect(manager.status.phase).toBe('starting');
      expect(manager.status.detail).toContain('attempt 1 of 3');
      await vi.waitFor(() => expect(manager.status.phase).toBe('ready'));
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.restartCount).toBe(1);
      // Ready, lost, ready again — the exact intermediate `starting` notifications are
      // an implementation detail (cause line, then the fresh start), the shape is not.
      expect(phases.at(0)).toBe('starting');
      expect(phases.at(-1)).toBe('ready');
      expect(phases.filter((p) => p === 'ready')).toHaveLength(2);
    });

    it('gives up after maxRestarts and says so instead of looping', async () => {
      const processes = [fakeProcess(), fakeProcess()];
      let spawned = 0;
      const spawn = vi.fn(() => processes[spawned++]!);
      const manager = new SidecarManager({
        spawn,
        probe: scriptedProbe([true]),
        sleep: noSleep,
        maxRestarts: 1,
      });
      await manager.start();

      processes[0]!.emitExit(1);
      await vi.waitFor(() => expect(manager.status.phase).toBe('ready'));
      expect(spawn).toHaveBeenCalledTimes(2);

      processes[1]!.emitExit(1);
      expect(manager.status.phase).toBe('failed');
      expect(manager.status.detail).toContain('not restarting again');
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('stop() during the backoff cancels the restart and resets the budget', async () => {
      let release: () => void = () => undefined;
      const sleep = (): Promise<void> =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      const proc = fakeProcess();
      const spawn = vi.fn(() => proc);
      const manager = new SidecarManager({ spawn, probe: scriptedProbe([true]), sleep });
      await manager.start();

      proc.emitExit(9);
      expect(manager.status.phase).toBe('starting');
      manager.stop();
      release();
      await Promise.resolve();
      await Promise.resolve();

      expect(manager.status.phase).toBe('stopped');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.restartCount).toBe(0);
    });

    it('does not restart an engine that exits during startup — that is a failure to start', async () => {
      const proc = fakeProcess();
      const spawn = vi.fn(() => proc);
      const manager = new SidecarManager({ spawn, probe: scriptedProbe([false]), sleep: noSleep });
      const pending = manager.start();
      proc.emitExit(2);
      const status = await pending;
      expect(status.phase).toBe('failed');
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });
});
