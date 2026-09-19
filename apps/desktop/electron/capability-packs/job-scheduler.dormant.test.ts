/** BR4.12 L6: journaled jobs stay dormant until their project is opened. */
import { describe, expect, it, vi } from 'vitest';
import { CapabilityPackJobScheduler, type JobDescriptor, type JobJournal } from './job-scheduler.js';

const descriptor = (id: string, projectPath: string): JobDescriptor => ({
  id,
  kind: 'matte',
  label: 'Remove background',
  projectPath,
  payload: { assetId: 'a' },
  finishedWindows: [],
});

describe('dormant journaled jobs', () => {
  it('load without running, stay journaled, and resume only for the opened project', async () => {
    const saved: (readonly JobDescriptor[])[] = [];
    const journal: JobJournal = {
      load: async () => [descriptor('one', '/p/a.fp.json'), descriptor('two', '/p/b.fp.json')],
      save: async (jobs) => void saved.push(jobs),
    };
    const scheduler = new CapabilityPackJobScheduler({ journal });
    const run = vi.fn(async () => 'done');
    expect(await scheduler.loadDormant()).toBe(2);
    expect(scheduler.snapshot()).toEqual([]);
    expect(scheduler.hasActiveJobs()).toBe(false);
    // An unrelated job's journal write keeps both dormant jobs.
    await scheduler.submit({ id: 'live', kind: 'matte', label: 'x', payload: {}, finishedWindows: [] }, 'focused', async () => 1);
    expect(saved.at(-1)?.map((item) => item.id)).toEqual(expect.arrayContaining(['one', 'two']));

    expect(await scheduler.resumeDormant((item) => item.projectPath === '/p/b.fp.json', async () => ({ priority: 'background', run }))).toBe(1);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(scheduler.snapshot().find((job) => job.id === 'two')).toMatchObject({ resumed: true });
    expect(scheduler.snapshot().some((job) => job.id === 'one')).toBe(false);
    await vi.waitFor(() => expect(saved.at(-1)?.map((item) => item.id)).toEqual(['one']));
  });

  it('drops a dormant job the factory rejects (project or asset gone), and a runner may refuse at run time', async () => {
    const saved: (readonly JobDescriptor[])[] = [];
    const scheduler = new CapabilityPackJobScheduler({
      journal: { load: async () => [descriptor('gone', '/p/a.fp.json'), descriptor('unlicensed', '/p/a.fp.json')], save: async (jobs) => void saved.push(jobs) },
    });
    await scheduler.loadDormant();
    await scheduler.resumeDormant(
      () => true,
      async (item) =>
        item.id === 'gone'
          ? undefined
          : {
              priority: 'background',
              run: async () => {
                throw new Error('A valid FramePilot license is required.');
              },
            },
    );
    await vi.waitFor(() => expect(scheduler.snapshot()).toEqual([expect.objectContaining({ id: 'unlicensed', state: 'failed' })]));
    await vi.waitFor(() => expect(saved.at(-1)).toEqual([]));
  });
});
