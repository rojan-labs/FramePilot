import type { HistoryEntry, Patch } from '@framepilot/editor-core';
import { describe, expect, it, vi } from 'vitest';
import { demoProject } from './demo.js';
import { DURABLE_HISTORY_LIMITS, persistProject, projectForPersistence } from './persistence.js';

const patch = (id: string): Patch => ({
  patchId: id as Patch['patchId'],
  createdBy: 'user',
  reason: id,
  operations: [],
});

const entry = (id: string, groupId?: string): HistoryEntry => ({
  patch: patch(id),
  inverse: patch(`${id}_inverse`),
  ...(groupId === undefined ? {} : { groupId }),
});

describe('durable history persistence boundary', () => {
  it('bounds restart history without mutating live project history', () => {
    const liveHistory = Array.from({ length: 150 }, (_, index) => entry(`edit_${index}`));
    const project = { ...demoProject, history: liveHistory };

    const durable = projectForPersistence(project);

    expect(project.history).toBe(liveHistory);
    expect(project.history).toHaveLength(150);
    expect(durable.history).toHaveLength(DURABLE_HISTORY_LIMITS.maxEntries);
    expect(durable.history).not.toBe(project.history);
  });

  it('collapses one durable run only when producing the persisted snapshot', () => {
    const liveHistory = [entry('one', 'run_1'), entry('two', 'run_1'), entry('three')];
    const project = { ...demoProject, history: liveHistory };

    const durable = projectForPersistence(project);

    expect(project.history).toHaveLength(3);
    expect(durable.history).toHaveLength(2);
    expect((durable.history as readonly HistoryEntry[])[0]?.patch.operations).toHaveLength(0);
  });

  it('sends the shaped document to the desktop bridge exactly at save time', async () => {
    const liveHistory = Array.from({ length: 130 }, (_, index) => entry(`edit_${index}`));
    const project = { ...demoProject, history: liveHistory };
    const saveProject = vi.fn(
      async (_path: string, _project: typeof project, _expectedRevision?: number) => ({
        ok: true as const,
        path: '/project.fp.json',
        revision: 4,
      }),
    );
    const bridge = { saveProject } as never;

    await persistProject('/project.fp.json', project, { bridge, expectedRevision: 3 });

    expect(saveProject).toHaveBeenCalledTimes(1);
    const persisted = saveProject.mock.calls[0]![1];
    expect(persisted.history).toHaveLength(DURABLE_HISTORY_LIMITS.maxEntries);
    expect(project.history).toHaveLength(130);
  });
});
