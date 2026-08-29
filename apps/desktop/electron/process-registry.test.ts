import { describe, expect, it, vi } from 'vitest';
import { ProcessRegistry, type PidFileIO } from './process-registry.js';

/** An in-memory pidfile, so the registry's crash-recovery path is testable without disk. */
function memoryPidFile(initial: string | null = null): PidFileIO & { contents: string | null } {
  const io = {
    contents: initial,
    read: () => io.contents,
    write: (next: string) => {
      io.contents = next;
    },
    clear: () => {
      io.contents = null;
    },
  };
  return io;
}

describe('ProcessRegistry (P5.3)', () => {
  it('tracks owner, purpose and start time, and moves through its states', () => {
    let clock = 1_000;
    const registry = new ProcessRegistry({ now: () => clock });
    const id = registry.register({ owner: 'sidecar', purpose: 'python engine', pid: 4321 });

    expect(registry.get(id)).toMatchObject({
      owner: 'sidecar',
      purpose: 'python engine',
      pid: 4321,
      startedAt: 1_000,
      state: 'created',
    });

    clock = 2_000;
    registry.setState(id, 'ready');
    expect(registry.get(id)?.state).toBe('ready');
    registry.setState(id, 'running');
    expect(registry.get(id)?.state).toBe('running');
    // startedAt is when it started, not when it last changed.
    expect(registry.get(id)?.startedAt).toBe(1_000);
  });

  it('terminated is final — a late state change cannot resurrect a dead child', () => {
    const killGroup = vi.fn();
    const registry = new ProcessRegistry({ killGroup });
    const id = registry.register({ owner: 'export', purpose: 'render job', pid: 99 });

    registry.terminate(id);
    expect(registry.get(id)?.state).toBe('terminated');

    registry.setState(id, 'running');
    expect(registry.get(id)?.state).toBe('terminated');
    // And terminating twice does not kill twice.
    registry.terminate(id);
    expect(killGroup).toHaveBeenCalledTimes(1);
  });

  it('kills the process group by default and honours a custom cancel', () => {
    const killGroup = vi.fn();
    const cancel = vi.fn();
    const registry = new ProcessRegistry({ killGroup });

    const byGroup = registry.register({ owner: 'sidecar', purpose: 'engine', pid: 7 });
    const byCancel = registry.register({ owner: 'export', purpose: 'render', pid: 8, cancel });

    registry.terminate(byGroup);
    expect(killGroup).toHaveBeenCalledWith(7);
    registry.terminate(byCancel);
    expect(cancel).toHaveBeenCalledTimes(1);
    // The custom cancel replaces the group kill; it does not run in addition to it.
    expect(killGroup).toHaveBeenCalledTimes(1);
  });

  it('one child throwing on cancel does not strand the others', () => {
    const killGroup = vi.fn();
    const registry = new ProcessRegistry({ killGroup });
    registry.register({
      owner: 'a',
      purpose: 'throws',
      pid: 1,
      cancel: () => {
        throw new Error('already gone');
      },
    });
    registry.register({ owner: 'b', purpose: 'fine', pid: 2 });

    expect(() => registry.terminateAll()).not.toThrow();
    expect(registry.list().every((e) => e.state === 'terminated')).toBe(true);
    expect(killGroup).toHaveBeenCalledWith(2);
  });

  it('records live children to the pidfile and clears it on a clean shutdown', () => {
    const pidFile = memoryPidFile();
    const registry = new ProcessRegistry({ pidFile, now: () => 5 });

    registry.register({ owner: 'sidecar', purpose: 'engine', pid: 111 });
    expect(JSON.parse(pidFile.contents!).children).toEqual([
      { pid: 111, owner: 'sidecar', purpose: 'engine' },
    ]);

    registry.terminateAll();
    // A clean quit leaves nothing for the next launch to sweep.
    expect(pidFile.contents).toBeNull();
  });

  it('sweeps the children a crashed run left behind, and only those still alive', () => {
    const pidFile = memoryPidFile(
      JSON.stringify({
        startedAt: 1,
        children: [
          { pid: 111, owner: 'sidecar', purpose: 'engine' },
          { pid: 222, owner: 'export', purpose: 'render' },
        ],
      }),
    );
    const killGroup = vi.fn();
    // 222 has already exited; its pid may belong to someone else entirely by now.
    const isAlive = (pid: number) => pid === 111;
    const registry = new ProcessRegistry({ pidFile, killGroup, isAlive });

    const swept = registry.sweepOrphans();

    expect(swept).toEqual([{ pid: 111, owner: 'sidecar', purpose: 'engine' }]);
    expect(killGroup).toHaveBeenCalledTimes(1);
    expect(killGroup).toHaveBeenCalledWith(111);
    expect(pidFile.contents).toBeNull();
  });

  it('treats an unreadable pidfile as nothing to sweep rather than crashing the launch', () => {
    const pidFile = memoryPidFile('{ not json');
    const killGroup = vi.fn();
    const registry = new ProcessRegistry({ pidFile, killGroup });

    expect(registry.sweepOrphans()).toEqual([]);
    expect(killGroup).not.toHaveBeenCalled();
    expect(pidFile.contents).toBeNull();
  });

  it('sweeps nothing when there is no pidfile at all (a first launch)', () => {
    const registry = new ProcessRegistry({ pidFile: memoryPidFile(null) });
    expect(registry.sweepOrphans()).toEqual([]);
    expect(new ProcessRegistry().sweepOrphans()).toEqual([]);
  });

  it('reports children that outlived their declared timeout', () => {
    let clock = 0;
    const registry = new ProcessRegistry({ now: () => clock });
    const bounded = registry.register({
      owner: 'export',
      purpose: 'render',
      pid: 1,
      timeoutMs: 100,
    });
    registry.register({ owner: 'sidecar', purpose: 'engine', pid: 2 });

    clock = 50;
    expect(registry.overdue()).toEqual([]);

    clock = 200;
    expect(registry.overdue().map((e) => e.id)).toEqual([bounded]);

    // A terminated child is not overdue, it is finished.
    registry.terminate(bounded);
    expect(registry.overdue()).toEqual([]);
  });

  it('survives a pidfile it cannot write to', () => {
    const pidFile: PidFileIO = {
      read: () => null,
      write: () => {
        throw new Error('EROFS');
      },
      clear: () => undefined,
    };
    const registry = new ProcessRegistry({ pidFile });
    expect(() => registry.register({ owner: 'sidecar', purpose: 'engine', pid: 5 })).not.toThrow();
  });
});
