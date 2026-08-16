import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import type { Patch } from './patch.js';
import {
  collapseHistoryGroups,
  commitProjectPatch,
  emptyHistory,
  gotoProject,
  redoProject,
  toPersistedHistory,
  undoProject,
} from './history.js';

const project = (): Project => ({
  id: 'project',
  name: 'Project',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  aiMemory: {},
  history: [],
  timeline: { tracks: [] },
  assets: [],
  folders: [],
  markers: [],
  transcript: [],
});

const markerPatch = (n: number): Patch => ({
  patchId: `p${n}` as Patch['patchId'],
  createdBy: 'agent',
  reason: `marker ${n}`,
  operations: [{ type: 'add_marker', id: `m${n}`, time: n }],
});

describe('durable-run history grouping', () => {
  it('keeps grouped patches compact instead of repeatedly flattening operations', () => {
    let state = project();
    let history = emptyHistory();
    for (let i = 0; i < 100; i += 1) {
      const step = commitProjectPatch(state, history, markerPatch(i), i, 'run_1');
      state = step.project;
      history = step.history;
    }
    expect(history.entries).toHaveLength(100);
    expect(history.entries.every((entry) => entry.patch.operations.length === 1)).toBe(true);
    expect(history.entries.every((entry) => entry.groupId === 'run_1')).toBe(true);
  });

  it('undoes and redoes one contiguous run as a single user action', () => {
    let state = project();
    let history = emptyHistory();
    for (let i = 0; i < 3; i += 1) {
      const step = commitProjectPatch(state, history, markerPatch(i), i, 'run_1');
      state = step.project;
      history = step.history;
    }
    expect(state.markers).toHaveLength(3);
    const undone = undoProject(state, history);
    expect(undone.history.cursor).toBe(0);
    expect(undone.project.markers).toEqual([]);
    const redone = redoProject(undone.project, undone.history);
    expect(redone.history.cursor).toBe(3);
    expect(redone.project.markers).toHaveLength(3);
  });

  it('keeps explicit history time-travel precise inside a group', () => {
    let state = project();
    let history = emptyHistory();
    for (let i = 0; i < 3; i += 1) {
      const step = commitProjectPatch(state, history, markerPatch(i), i, 'run_1');
      state = step.project;
      history = step.history;
    }
    const middle = gotoProject(state, history, 1);
    expect(middle.history.cursor).toBe(1);
    expect(middle.project.markers.map((marker) => marker.id)).toEqual(['m0']);
  });

  it('collapses a long live run once for restart persistence instead of dropping it at the entry cap', () => {
    let state = project();
    let history = emptyHistory();
    for (let i = 0; i < 150; i += 1) {
      const step = commitProjectPatch(state, history, markerPatch(i), i, 'run_1');
      state = step.project;
      history = step.history;
    }
    const persisted = toPersistedHistory(history, { maxEntries: 1 });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.patch.operations).toHaveLength(150);
    expect(persisted[0]?.inverse.operations).toHaveLength(150);
    expect(persisted[0]?.groupId).toBe('run_1');
  });

  it('preserves forward and inverse operation order when a group is serialized', () => {
    let state = project();
    let history = emptyHistory();
    for (let i = 0; i < 3; i += 1) {
      const step = commitProjectPatch(state, history, markerPatch(i), i, 'run_1');
      state = step.project;
      history = step.history;
    }
    const grouped = collapseHistoryGroups(history.entries)[0]!;
    expect(
      grouped.patch.operations.map((operation) => operation.type === 'add_marker' && operation.id),
    ).toEqual(['m0', 'm1', 'm2']);
    expect(
      grouped.inverse.operations.map(
        (operation) => operation.type === 'remove_marker' && operation.id,
      ),
    ).toEqual(['m2', 'm1', 'm0']);
  });

  it('leaves a one-commit run and its neighbours as their own entries', () => {
    let state = project();
    let history = emptyHistory();
    // A manual edit, a single-commit run, then a different single-commit run.
    // None of these can be merged: collapsing needs two contiguous entries that
    // share a groupId, and a lone grouped commit is already its own step.
    for (const groupId of [undefined, 'run_1', 'run_2']) {
      const step = commitProjectPatch(state, history, markerPatch(history.cursor), 0, groupId);
      state = step.project;
      history = step.history;
    }

    const collapsed = collapseHistoryGroups(history.entries);
    expect(collapsed).toHaveLength(3);
    expect(collapsed.map((entry) => entry.groupId)).toEqual([undefined, 'run_1', 'run_2']);
    expect(collapsed.every((entry) => entry.patch.operations.length === 1)).toBe(true);
    // Collapsing copies entries rather than handing back the live objects.
    expect(collapsed[1]).not.toBe(history.entries[1]);
    expect(collapsed[1]).toEqual(history.entries[1]);
  });

  it('still lets a newer manual undo step win a tight persisted entry budget', () => {
    let state = project();
    let history = emptyHistory();
    for (let i = 0; i < 3; i += 1) {
      const step = commitProjectPatch(state, history, markerPatch(i), i, 'run_1');
      state = step.project;
      history = step.history;
    }
    const manual = commitProjectPatch(state, history, {
      ...markerPatch(9),
      patchId: 'manual' as Patch['patchId'],
      createdBy: 'user',
    });
    const persisted = toPersistedHistory(manual.history, { maxEntries: 1 });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.patch.patchId).toBe('manual');
  });
});
