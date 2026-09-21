import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityPackJobScheduler,
  createQuitGuard,
  FileJobJournal,
  JobCancelledError,
  type JobContext,
  type JobDescriptor,
  type JobJournal,
} from './job-scheduler.js';

const descriptor = (id: string, clipId = `clip-${id}`): JobDescriptor => ({
  id,
  kind: 'matte',
  label: `Remove background ${id}`,
  clipId,
  payload: { requestId: id },
  finishedWindows: [],
});

/** A job whose windows advance only when the test says so. */
function windowedJob(windows: number, log: string[], name: string) {
  const gates: (() => void)[] = [];
  let context: JobContext | undefined;
  const run = async (ctx: JobContext): Promise<string> => {
    context = ctx;
    for (let window = 0; window < windows; window += 1) {
      if (ctx.finishedWindows.has(window)) continue;
      await ctx.checkpoint();
      log.push(`${name}:start:${window}`);
      await new Promise<void>((resolve) => gates.push(resolve));
      log.push(`${name}:end:${window}`);
      ctx.finishWindow(window);
    }
    return `${name}:done`;
  };
  const step = async () => {
    await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
    gates.shift()!();
  };
  return { run, step, context: () => context };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CapabilityPackJobScheduler', () => {
  it('runs one GPU job at a time, in priority then FIFO order', async () => {
    const log: string[] = [];
    const scheduler = new CapabilityPackJobScheduler();
    const a = windowedJob(1, log, 'a');
    const b = windowedJob(1, log, 'b');
    const c = windowedJob(1, log, 'c');
    const done = [
      scheduler.submit(descriptor('a'), 'background', a.run),
      scheduler.submit(descriptor('b'), 'background', b.run),
      scheduler.submit(descriptor('c'), 'interactive', c.run),
    ];
    await a.step();
    await flush();
    expect(scheduler.snapshot().filter((job) => job.state === 'running').map((job) => job.id)).toEqual(['c']);
    await c.step();
    await b.step();
    expect(await Promise.all(done)).toEqual(['a:done', 'b:done', 'c:done']);
    expect(log).toEqual(['a:start:0', 'a:end:0', 'c:start:0', 'c:end:0', 'b:start:0', 'b:end:0']);
  });

  it('pre-empts only between windows, then resumes the pre-empted job', async () => {
    const log: string[] = [];
    const scheduler = new CapabilityPackJobScheduler();
    const long = windowedJob(3, log, 'long');
    const click = windowedJob(1, log, 'click');
    const longDone = scheduler.submit(descriptor('long'), 'background', long.run);
    await vi.waitFor(() => expect(log).toContain('long:start:0'));
    const clickDone = scheduler.submit(descriptor('click'), 'interactive', click.run);
    await flush();
    // The running window is never interrupted.
    expect(log).toEqual(['long:start:0']);
    await long.step();
    await vi.waitFor(() => expect(log).toContain('click:start:0'));
    expect(scheduler.snapshot().find((job) => job.id === 'long')?.state).toBe('preempted');
    await click.step();
    expect(await clickDone).toBe('click:done');
    await long.step();
    await long.step();
    expect(await longDone).toBe('long:done');
    expect(log).toEqual(['long:start:0', 'long:end:0', 'click:start:0', 'click:end:0', 'long:start:1', 'long:end:1', 'long:start:2', 'long:end:2']);
  });

  it('pauses inference during export at the next checkpoint and resumes afterwards', async () => {
    const log: string[] = [];
    const scheduler = new CapabilityPackJobScheduler();
    const job = windowedJob(2, log, 'job');
    const done = scheduler.submit(descriptor('job'), 'focused', job.run);
    await vi.waitFor(() => expect(log).toContain('job:start:0'));
    scheduler.beginExport();
    await job.step();
    await vi.waitFor(() => expect(scheduler.snapshot()[0]?.state).toBe('paused_export'));
    const queued = windowedJob(1, log, 'queued');
    const queuedDone = scheduler.submit(descriptor('queued'), 'interactive', queued.run);
    await flush();
    expect(log).toEqual(['job:start:0', 'job:end:0']);
    scheduler.endExport();
    await queued.step();
    await queuedDone;
    await job.step();
    expect(await done).toBe('job:done');
  });

  it('pauses, resumes and cancels by id; a cancelled job rejects and frees the slot', async () => {
    const log: string[] = [];
    const scheduler = new CapabilityPackJobScheduler();
    const job = windowedJob(3, log, 'job');
    const done = scheduler.submit(descriptor('job'), 'focused', job.run);
    await vi.waitFor(() => expect(log).toContain('job:start:0'));
    expect(scheduler.pause('job')).toBe(true);
    // Mid-window the job is still running: the snapshot says a pause is pending, and since when.
    expect(scheduler.snapshot()[0]).toMatchObject({ state: 'running', pausePending: true });
    expect(scheduler.snapshot()[0]?.startedAt).toBeTypeOf('number');
    await job.step();
    await vi.waitFor(() => expect(scheduler.snapshot()[0]?.state).toBe('paused'));
    expect(scheduler.snapshot()[0]?.pausePending).toBeUndefined();
    const other = windowedJob(1, log, 'other');
    const otherDone = scheduler.submit(descriptor('other'), 'background', other.run);
    await other.step();
    expect(await otherDone).toBe('other:done');
    expect(scheduler.resume('job')).toBe(true);
    await job.step();
    await vi.waitFor(() => expect(log).toContain('job:start:2'));
    const queued = scheduler.submit(descriptor('queued'), 'background', async () => 'never');
    expect(scheduler.cancel('queued')).toBe(true);
    await expect(queued).rejects.toBeInstanceOf(JobCancelledError);
    // Cancelled mid-window: the window finishes (never interrupted) and the result is discarded.
    expect(scheduler.cancel('job')).toBe(true);
    await job.step();
    await expect(done).rejects.toBeInstanceOf(JobCancelledError);
    expect(scheduler.hasActiveJobs()).toBe(false);
  });

  it('asks a job with a suspend handler to stop on pause and on export, instead of waiting for it', async () => {
    const scheduler = new CapabilityPackJobScheduler();
    const asked: string[] = [];
    let release: (() => void) | undefined;
    let working = -1;
    const done = scheduler.submit(descriptor('long'), 'focused', async (ctx) => {
      // One long stretch of work per attempt, like a worker run over a whole clip.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await ctx.checkpoint();
        ctx.onSuspendRequest(() => {
          asked.push(`attempt ${attempt}`);
          release?.();
        });
        working = attempt;
        await new Promise<void>((resolve) => (release = resolve));
      }
      return 'done';
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(scheduler.pause('long')).toBe(true);
    await vi.waitFor(() => expect(scheduler.snapshot()[0]?.state).toBe('paused'));
    expect(asked).toEqual(['attempt 0']);
    scheduler.resume('long');
    await vi.waitFor(() => expect(working).toBe(1));
    scheduler.beginExport();
    await vi.waitFor(() => expect(scheduler.snapshot()[0]?.state).toBe('paused_export'));
    expect(asked).toEqual(['attempt 0', 'attempt 1']);
    scheduler.endExport();
    await vi.waitFor(() => expect(working).toBe(2));
    release?.();
    expect(await done).toBe('done');
  });

  it('cancels a job suspended at a checkpoint', async () => {
    const log: string[] = [];
    const scheduler = new CapabilityPackJobScheduler();
    const job = windowedJob(2, log, 'job');
    const done = scheduler.submit(descriptor('job'), 'focused', job.run);
    await vi.waitFor(() => expect(log).toContain('job:start:0'));
    scheduler.pause('job');
    await job.step();
    await vi.waitFor(() => expect(scheduler.snapshot()[0]?.state).toBe('paused'));
    expect(scheduler.cancel('job')).toBe(true);
    await expect(done).rejects.toBeInstanceOf(JobCancelledError);
    expect(scheduler.snapshot()[0]?.state).toBe('cancelled');
    await expect(scheduler.submit(descriptor('x'), 'focused', async () => 1)).resolves.toBe(1);
  });

  it('journals unfinished jobs with finished windows and resumes them after a restart', async () => {
    const saved: (readonly JobDescriptor[])[] = [];
    const journal: JobJournal = { load: async () => saved.at(-1) ?? [], save: async (jobs) => void saved.push(jobs) };
    const log: string[] = [];
    const before = new CapabilityPackJobScheduler({ journal });
    const job = windowedJob(3, log, 'job');
    void before.submit(descriptor('job'), 'focused', job.run).catch(() => undefined);
    await job.step();
    await vi.waitFor(() => expect(saved.at(-1)?.[0]?.finishedWindows).toEqual([0]));
    // "Quit": a new scheduler restores from the journal; the factory rejects jobs whose clip changed.
    const after = new CapabilityPackJobScheduler({ journal });
    const resumedLog: string[] = [];
    const resumed = windowedJob(3, resumedLog, 'job');
    const factory = vi.fn(async (d: JobDescriptor) => (d.clipId === 'clip-job' ? { priority: 'background' as const, run: resumed.run } : undefined));
    expect(await after.restore(factory)).toBe(1);
    expect(after.snapshot()[0]).toMatchObject({ id: 'job', resumed: true });
    await resumed.step();
    await resumed.step();
    await vi.waitFor(() => expect(after.snapshot()[0]?.state).toBe('completed'));
    expect(resumedLog).toEqual(['job:start:1', 'job:end:1', 'job:start:2', 'job:end:2']);
    await vi.waitFor(() => expect(saved.at(-1)).toEqual([]));
    const dropped = new CapabilityPackJobScheduler({ journal: { load: async () => [descriptor('gone')], save: async () => undefined } });
    expect(await dropped.restore(async () => undefined)).toBe(0);
  });

  it('refuses a duplicate live id and reports state to observers', async () => {
    const onChange = vi.fn();
    const scheduler = new CapabilityPackJobScheduler({ onChange });
    const log: string[] = [];
    const job = windowedJob(1, log, 'job');
    const done = scheduler.submit(descriptor('job'), 'focused', job.run);
    await expect(scheduler.submit(descriptor('job'), 'focused', job.run)).rejects.toThrow(/already scheduled/);
    await job.step();
    await done;
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'job', state: 'completed' })]);
  });
});

describe('quit guard', () => {
  it('asks before quitting while a job runs, and quits only when confirmed', async () => {
    let active = true;
    const quit = vi.fn();
    const confirmQuit = vi.fn(async () => false);
    const guard = createQuitGuard({ hasActiveJobs: () => active, confirmQuit, quit });
    const event = { preventDefault: vi.fn() };
    guard(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    await flush();
    expect(quit).not.toHaveBeenCalled();
    confirmQuit.mockResolvedValueOnce(true);
    guard(event);
    await flush();
    expect(quit).toHaveBeenCalledTimes(1);
    const second = { preventDefault: vi.fn() };
    guard(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
    active = false;
    const idle = createQuitGuard({ hasActiveJobs: () => active, confirmQuit, quit });
    const idleEvent = { preventDefault: vi.fn() };
    idle(idleEvent);
    expect(idleEvent.preventDefault).not.toHaveBeenCalled();
  });
});

describe('FileJobJournal', () => {
  it('round-trips descriptors and drops malformed entries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-jobs-'));
    const file = path.join(dir, 'jobs.json');
    const journal = new FileJobJournal(file);
    expect(await journal.load()).toEqual([]);
    await journal.save([descriptor('a')]);
    expect(await journal.load()).toEqual([descriptor('a')]);
    const raw = JSON.parse(await readFile(file, 'utf8')) as { jobs: unknown[] };
    raw.jobs.push({ id: '../x', kind: 'matte', label: 'x', finishedWindows: [] }, { id: 'b', kind: 'shell', label: 'x', finishedWindows: [] });
    await writeFile(file, JSON.stringify(raw));
    expect(await journal.load()).toEqual([descriptor('a')]);
    await writeFile(file, 'not json');
    expect(await journal.load()).toEqual([]);
  });
});

describe('slotFree (BR6.11 hover gate)', () => {
  it('is false while a job holds the slot or an export runs, true otherwise', async () => {
    const scheduler = new CapabilityPackJobScheduler();
    expect(scheduler.slotFree()).toBe(true);
    let release: (() => void) | undefined;
    const done = scheduler.submit(descriptor('a'), 'focused', () => new Promise<void>((resolve) => (release = resolve)));
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(scheduler.slotFree()).toBe(false);
    release!();
    await done;
    expect(scheduler.slotFree()).toBe(true);
    scheduler.beginExport();
    expect(scheduler.slotFree()).toBe(false);
    scheduler.endExport();
    expect(scheduler.slotFree()).toBe(true);
  });
});
