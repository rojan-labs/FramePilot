import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { CapabilityPackJobScheduler } from './job-scheduler.js';
import { scheduleMatteJob } from './matte-ipc.js';
import type { CapabilityPackMatteService, MatteRunContext, MatteRunOutcome } from './matte.js';

const intent = {
  requestId: 'job1',
  assetId: 'asset-1',
  sourceStart: 0,
  sourceEnd: 1,
  prompts: [],
  foreground: false,
  timelineRevision: 2,
};
const project = { assets: [], timeline: { tracks: [], revision: 2 } } as unknown as Project;
const cancelled: MatteRunOutcome = { status: 'failed', code: 'cancelled', detail: 'Background removal cancelled.', retryable: false };
const completed = { status: 'completed' } as unknown as MatteRunOutcome;

/** A matte service whose worker "runs" until it is suspended or cancelled, then finishes. */
function fakeService() {
  const runs: MatteRunContext[] = [];
  let stop: ((outcome: MatteRunOutcome) => void) | undefined;
  const service = {
    run: vi.fn(async (_intent: unknown, context: MatteRunContext) => {
      runs.push(context);
      if (runs.length > 1) return completed;
      return new Promise<MatteRunOutcome>((resolve) => (stop = resolve));
    }),
    suspend: vi.fn(() => {
      stop?.(cancelled);
      return true;
    }),
    cancel: vi.fn(() => stop?.(cancelled)),
  };
  return { service: service as unknown as CapabilityPackMatteService, runs, spies: service };
}

describe('pausing a background-removal job (plan 13)', () => {
  it('stops the worker, holds at the checkpoint, and resumes the same job from its finished windows', async () => {
    const { service, runs, spies } = fakeService();
    const scheduler = new CapabilityPackJobScheduler();
    const deps = { matte: async () => service, readProject: async () => project, scheduler };
    const done = scheduleMatteJob(deps, '/p/edit.fp.json', intent, 'focused', false);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]?.resume).toBeUndefined();

    expect(scheduler.pause('job1')).toBe(true);
    await vi.waitFor(() => expect(scheduler.snapshot()[0]?.state).toBe('paused'));
    expect(spies.suspend).toHaveBeenCalledWith('job1');
    expect(spies.cancel).not.toHaveBeenCalled();

    scheduler.resume('job1');
    expect(await done).toMatchObject({ status: 'completed' });
    expect(runs).toHaveLength(2);
    expect(runs[1]?.resume).toBe(true);
  });

  it('an export suspends the running job and gives the slot back afterwards', async () => {
    const { service, runs } = fakeService();
    const scheduler = new CapabilityPackJobScheduler();
    const deps = { matte: async () => service, readProject: async () => project, scheduler };
    const done = scheduleMatteJob(deps, '/p/edit.fp.json', intent, 'focused', false);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    scheduler.beginExport();
    await vi.waitFor(() => expect(scheduler.snapshot()[0]?.state).toBe('paused_export'));
    scheduler.endExport();
    expect(await done).toMatchObject({ status: 'completed' });
  });

  it('a cancel is final: the job is not run again', async () => {
    const { service, runs } = fakeService();
    const scheduler = new CapabilityPackJobScheduler();
    const deps = { matte: async () => service, readProject: async () => project, scheduler };
    const done = scheduleMatteJob(deps, '/p/edit.fp.json', intent, 'focused', false);
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    scheduler.cancel('job1');
    expect(await done).toMatchObject({ status: 'failed', code: 'cancelled' });
    expect(runs).toHaveLength(1);
  });
});
