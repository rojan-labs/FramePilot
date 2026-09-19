import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parseTopMem,
  processGroupFootprint,
  stagingBytes,
  watchdogLimits,
  WorkerWatchdog,
  type WatchdogProbes,
} from './worker-watchdog.js';

const GIB = 1024 ** 3;

describe('worker watchdog limits and sampling', () => {
  it('takes the smaller of the pack limit and 0.6 x RAM; outputs to the ceiling, the folder to min(budget, free space minus 1 GB)', () => {
    const budget = 100 * GIB;
    expect(watchdogLimits({ packId: 'framepilot.smart-mask', totalMemoryBytes: 32 * GIB, byteCeiling: 10 * GIB, freeBytesAtStart: 50 * GIB, stagingBudgetBytes: budget })).toEqual({
      memoryBytes: 8 * GIB,
      stallMs: 5 * 60 * 1000,
      stagingBytes: 49 * GIB,
      outputBytes: 10 * GIB,
    });
    expect(watchdogLimits({ packId: 'framepilot.smart-mask', totalMemoryBytes: 8 * GIB, byteCeiling: 10 * GIB, freeBytesAtStart: 3 * GIB, stagingBudgetBytes: budget })).toMatchObject({
      memoryBytes: Math.floor(0.6 * 8 * GIB),
      stagingBytes: 2 * GIB,
      outputBytes: 10 * GIB,
    });
    expect(watchdogLimits({ packId: 'other', totalMemoryBytes: 10, byteCeiling: 1, freeBytesAtStart: 0, stagingBudgetBytes: budget }).stagingBytes).toBe(0);
    // Plenty free: the budget still bounds the folder.
    expect(watchdogLimits({ packId: 'other', totalMemoryBytes: 10, byteCeiling: 1, freeBytesAtStart: 500 * GIB, stagingBudgetBytes: 20 * GIB }).stagingBytes).toBe(20 * GIB);
  });

  it('bounds the folder by the budget when free space is unknown, never by nothing (F1)', () => {
    const limits = watchdogLimits({ packId: 'framepilot.smart-mask', totalMemoryBytes: 32 * GIB, byteCeiling: GIB, freeBytesAtStart: undefined, stagingBudgetBytes: 12 * GIB });
    expect(limits.stagingBytes).toBe(12 * GIB);
    expect(Number.isFinite(limits.stagingBytes)).toBe(true);
  });

  it('holds the declared outputs to the ceiling and the whole folder to the disk guard (E2E.6)', async () => {
    let staged = 0;
    let outputs = 0;
    const probes: WatchdogProbes = {
      footprintBytes: async () => undefined,
      directoryBytes: async () => staged,
      outputBytes: async () => outputs,
      now: () => 0,
    };
    const limits = { memoryBytes: 100, stallMs: 1_000, stagingBytes: 500, outputBytes: 50 };
    // A worker's scratch and window checkpoints are more than its artifact: not a breach.
    const healthy = new WorkerWatchdog(limits, probes, { stagingDirectory: '/s', onBreach: vi.fn() });
    staged = 400;
    outputs = 50;
    await healthy.tick();
    expect(healthy.breach).toBeUndefined();
    // The artifact itself past its ceiling is.
    outputs = 51;
    await healthy.tick();
    expect(healthy.breach).toBe('disk');
    // And so is a folder about to fill the disk, whatever it holds.
    const filling = new WorkerWatchdog(limits, probes, { stagingDirectory: '/s', onBreach: vi.fn() });
    staged = 501;
    outputs = 0;
    await filling.tick();
    expect(filling.breach).toBe('disk');
  });

  it('trips once, in order: stall, disk, memory; unmeasurable memory is not a breach', async () => {
    let now = 0;
    let footprint: number | undefined;
    let staged = 0;
    const probes: WatchdogProbes = { footprintBytes: async () => footprint, directoryBytes: async () => staged, now: () => now };
    const onBreach = vi.fn();
    const watchdog = new WorkerWatchdog({ memoryBytes: 100, stallMs: 1_000, stagingBytes: 50, outputBytes: 50 }, probes, { stagingDirectory: '/s', onBreach });
    watchdog.attach(7);
    await watchdog.tick();
    footprint = 99;
    staged = 50;
    now = 900;
    await watchdog.tick();
    expect(onBreach).not.toHaveBeenCalled();
    footprint = 101;
    await watchdog.tick();
    expect(onBreach).toHaveBeenCalledWith('memory');
    await watchdog.tick();
    expect(onBreach).toHaveBeenCalledTimes(1);
    const stalled = new WorkerWatchdog({ memoryBytes: 100, stallMs: 1_000, stagingBytes: 50, outputBytes: 50 }, probes, { stagingDirectory: '/s', onBreach: vi.fn() });
    now = 5_000;
    stalled.progress();
    now = 6_001;
    await stalled.tick();
    expect(stalled.breach).toBe('stalled');
  });

  it('counts staging bytes without following links', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-watchdog-'));
    await writeFile(path.join(dir, 'matte.mkv'), Buffer.alloc(1000));
    await mkdir(path.join(dir, 'inputs'));
    await writeFile(path.join(dir, 'inputs', 'x.png'), Buffer.alloc(24));
    const big = await mkdtemp(path.join(tmpdir(), 'framepilot-watchdog-big-'));
    await writeFile(path.join(big, 'huge'), Buffer.alloc(100_000));
    await symlink(big, path.join(dir, 'link'));
    const total = await stagingBytes(dir);
    expect(total).toBeGreaterThanOrEqual(1024);
    expect(total).toBeLessThan(2_000);
    // The artifact alone: the host's inputs (and the worker's private folders) are left out.
    expect(total - (await stagingBytes(dir, { exclude: ['inputs', 'windows', 'scratch'] }))).toBe(24);
  });

  it('parses macOS top physical footprint and samples each platform with its own tool', async () => {
    expect(parseTopMem('PID    MEM\n42732  1633K\n42733  1.5G\n999    9G\n', new Set(['42732', '42733']))).toBe(1633 * 1024 + 1.5 * GIB);
    expect(parseTopMem('PID MEM\n', new Set(['1']))).toBeUndefined();
    const calls: string[][] = [];
    const exec = async (file: string, args: readonly string[]) => {
      calls.push([file, ...args]);
      if (file === 'ps' && args.includes('pid=')) return '  10\n  11\n';
      if (file === 'top') return 'PID MEM\n10 100M\n11 20M\n';
      if (file === 'ps') return ' 1000\n 2000\n';
      return '"worker.exe","10","Console","1","123,456 K"\n';
    };
    expect(await processGroupFootprint('darwin', exec)(10)).toBe(120 * 1024 ** 2);
    expect(calls.at(-1)).toEqual(['top', '-l', '1', '-stats', 'pid,mem', '-pid', '10', '-pid', '11']);
    expect(await processGroupFootprint('linux', exec)(10)).toBe(3000 * 1024);
    expect(await processGroupFootprint('win32', exec)(10)).toBe(123_456 * 1024);
  });
});
