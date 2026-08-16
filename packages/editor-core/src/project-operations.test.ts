/**
 * Tests for project-scoped operations (assets + folders) and the project-scoped
 * patch/history layer. Every op is proven reversible (apply → invert → apply
 * restores the prior project), mirroring `operations.test.ts` for timeline ops.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Folder, Marker, Project, TranscriptWord } from '@framepilot/timeline-schema';
import { asId } from '@framepilot/shared-types';
import {
  applyProjectOperation,
  invertProjectOperation,
  isProjectOperation,
  ProjectOperationError,
  wouldCreateFolderCycle,
  type ProjectOperation,
} from './project-operations.js';
import {
  applyPatch,
  applyProjectPatch,
  diffProject,
  invertPatch,
  invertProjectPatch,
  PatchError,
  type Patch,
} from './patch.js';
import {
  commitProjectPatch,
  emptyHistory,
  gotoProject,
  redoProject,
  toPersistedHistory,
  undoProject,
} from './history.js';
import { validatePatch } from './validator.js';

const asset = (id: string, folderId?: string): Asset => ({
  id,
  path: `/media/${id}.mp4`,
  kind: 'video',
  ...(folderId ? { folderId } : {}),
});

const folder = (id: string, name: string, parentId: string | null = null): Folder => ({
  id,
  name,
  parentId,
});

const marker = (id: string, time: number, label?: string, color?: string): Marker => ({
  id,
  time,
  ...(label !== undefined ? { label } : {}),
  ...(color !== undefined ? { color } : {}),
});

const baseProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Test',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [],
  folders: [],
  timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
  transcript: [],
  markers: [],
  aiMemory: {},
  history: [],
  ...overrides,
});

const patchOf = (operations: ProjectOperation[], reason = 'test'): Patch => ({
  patchId: asId<'PatchId'>('patch_test'),
  createdBy: 'agent',
  reason,
  operations,
});

/** Apply op, then apply its inverse, and assert we are back to `before`. */
const roundTrips = (before: Project, op: ProjectOperation): void => {
  const after = applyProjectOperation(before, op);
  let restored = after;
  for (const inv of invertProjectOperation(before, op)) {
    restored = applyProjectOperation(restored, inv);
  }
  expect(restored).toEqual(before);
};

describe('isProjectOperation', () => {
  it('discriminates project ops from timeline ops', () => {
    expect(isProjectOperation({ type: 'add_asset' })).toBe(true);
    expect(isProjectOperation({ type: 'move_folder' })).toBe(true);
    expect(isProjectOperation({ type: 'trim_clip' })).toBe(false);
    expect(isProjectOperation({ type: 'add_clip' })).toBe(false);
  });
});

describe('applyProjectOperation — assets', () => {
  it('add_asset appends and is reversible', () => {
    const before = baseProject();
    const op: ProjectOperation = { type: 'add_asset', asset: asset('a1') };
    const after = applyProjectOperation(before, op);
    expect(after.assets).toHaveLength(1);
    expect(after.assets[0]?.id).toBe('a1');
    roundTrips(before, op);
  });

  it('add_asset rejects a duplicate id', () => {
    const before = baseProject({ assets: [asset('a1')] });
    expect(() => applyProjectOperation(before, { type: 'add_asset', asset: asset('a1') })).toThrow(
      ProjectOperationError,
    );
  });

  it('remove_asset drops the asset and is reversible', () => {
    const before = baseProject({ assets: [asset('a1'), asset('a2')] });
    const op: ProjectOperation = { type: 'remove_asset', assetId: 'a1' };
    const after = applyProjectOperation(before, op);
    expect(after.assets.map((a) => a.id)).toEqual(['a2']);
    roundTrips(before, op);
  });

  it('remove_asset throws on a missing asset', () => {
    expect(() =>
      applyProjectOperation(baseProject(), { type: 'remove_asset', assetId: 'nope' }),
    ).toThrow(/Asset not found/);
  });

  it('move_asset sets and clears folderId and is reversible both ways', () => {
    const intoFolder = baseProject({ assets: [asset('a1')], folders: [folder('f1', 'B-roll')] });
    const moveIn: ProjectOperation = { type: 'move_asset', assetId: 'a1', folderId: 'f1' };
    expect(applyProjectOperation(intoFolder, moveIn).assets[0]?.folderId).toBe('f1');
    roundTrips(intoFolder, moveIn);

    const outOfFolder = baseProject({
      assets: [asset('a1', 'f1')],
      folders: [folder('f1', 'B-roll')],
    });
    const moveOut: ProjectOperation = { type: 'move_asset', assetId: 'a1', folderId: null };
    expect(applyProjectOperation(outOfFolder, moveOut).assets[0]?.folderId).toBeUndefined();
    roundTrips(outOfFolder, moveOut);
  });

  it('move_asset leaves sibling assets untouched', () => {
    const before = baseProject({
      assets: [asset('a1'), asset('a2')],
      folders: [folder('f1', 'A')],
    });
    const after = applyProjectOperation(before, {
      type: 'move_asset',
      assetId: 'a1',
      folderId: 'f1',
    });
    expect(after.assets.find((a) => a.id === 'a2')?.folderId).toBeUndefined();
  });

  it('move_asset throws on a missing asset', () => {
    expect(() =>
      applyProjectOperation(baseProject(), { type: 'move_asset', assetId: 'x', folderId: null }),
    ).toThrow(/Asset not found/);
  });
});

describe('applyProjectOperation — folders', () => {
  it('create_folder appends and is reversible', () => {
    const before = baseProject();
    const op: ProjectOperation = {
      type: 'create_folder',
      folderId: 'f1',
      name: 'B-roll',
      parentId: null,
    };
    expect(applyProjectOperation(before, op).folders).toEqual([folder('f1', 'B-roll')]);
    roundTrips(before, op);
  });

  it('create_folder rejects a duplicate id', () => {
    const before = baseProject({ folders: [folder('f1', 'A')] });
    expect(() =>
      applyProjectOperation(before, {
        type: 'create_folder',
        folderId: 'f1',
        name: 'B',
        parentId: null,
      }),
    ).toThrow(/already exists/);
  });

  it('rename_folder renames and is reversible', () => {
    const before = baseProject({ folders: [folder('f1', 'Old')] });
    const op: ProjectOperation = { type: 'rename_folder', folderId: 'f1', name: 'New' };
    expect(applyProjectOperation(before, op).folders[0]?.name).toBe('New');
    roundTrips(before, op);
  });

  it('rename_folder throws on a missing folder', () => {
    expect(() =>
      applyProjectOperation(baseProject(), { type: 'rename_folder', folderId: 'x', name: 'N' }),
    ).toThrow(/Folder not found/);
  });

  it('move_folder reparents and is reversible', () => {
    const before = baseProject({ folders: [folder('f1', 'A'), folder('f2', 'B')] });
    const op: ProjectOperation = { type: 'move_folder', folderId: 'f2', parentId: 'f1' };
    expect(applyProjectOperation(before, op).folders[1]?.parentId).toBe('f1');
    roundTrips(before, op);
  });

  it('move_folder throws on a missing folder', () => {
    expect(() =>
      applyProjectOperation(baseProject(), { type: 'move_folder', folderId: 'x', parentId: null }),
    ).toThrow(/Folder not found/);
  });

  it('delete_folder reparents child folders + assets and is reversible', () => {
    const before = baseProject({
      folders: [folder('root', 'Root'), folder('child', 'Child', 'root')],
      assets: [asset('a1', 'root'), asset('a2', 'child')],
    });
    const after = applyProjectOperation(before, { type: 'delete_folder', folderId: 'root' });
    // child reparents to root's parent (null); a1 (in root) → null; a2 stays in child.
    expect(after.folders).toEqual([folder('child', 'Child', null)]);
    expect(after.assets.find((a) => a.id === 'a1')?.folderId).toBeUndefined();
    expect(after.assets.find((a) => a.id === 'a2')?.folderId).toBe('child');
    roundTrips(before, { type: 'delete_folder', folderId: 'root' });
  });

  it("delete_folder reparents a nested folder's assets to a non-null parent", () => {
    const before = baseProject({
      folders: [folder('root', 'Root'), folder('mid', 'Mid', 'root')],
      assets: [asset('a1', 'mid')],
    });
    const after = applyProjectOperation(before, { type: 'delete_folder', folderId: 'mid' });
    // a1 was in mid → reparents to mid's parent 'root'.
    expect(after.assets[0]?.folderId).toBe('root');
    expect(after.folders).toEqual([folder('root', 'Root')]);
    roundTrips(before, { type: 'delete_folder', folderId: 'mid' });
  });

  it('delete_folder throws on a missing folder', () => {
    expect(() =>
      applyProjectOperation(baseProject(), { type: 'delete_folder', folderId: 'x' }),
    ).toThrow(/Folder not found/);
  });
});

describe('applyProjectOperation — transcript', () => {
  const word = (w: string, start: number, end: number): TranscriptWord => ({
    word: w,
    start,
    end,
  });

  it('set_transcript replaces the whole transcript and is reversible', () => {
    const before = baseProject({ transcript: [word('hi', 0, 0.5)] });
    const op: ProjectOperation = {
      type: 'set_transcript',
      words: [word('hello', 0, 0.4), word('world', 0.4, 0.9)],
    };
    const after = applyProjectOperation(before, op);
    expect(after.transcript).toEqual([word('hello', 0, 0.4), word('world', 0.4, 0.9)]);
    roundTrips(before, op);
  });

  it('set_transcript from an empty transcript is reversible', () => {
    const before = baseProject({ transcript: [] });
    const op: ProjectOperation = { type: 'set_transcript', words: [word('hi', 0, 0.5)] };
    roundTrips(before, op);
  });

  it("set_transcript does not mutate the caller's word array", () => {
    const before = baseProject({ transcript: [] });
    const words = [word('hi', 0, 0.5)];
    const after = applyProjectOperation(before, { type: 'set_transcript', words });
    expect(after.transcript).not.toBe(words);
    expect(after.transcript[0]).not.toBe(words[0]);
  });
});

describe('applyProjectOperation — markers', () => {
  it('add_marker appends and is reversible', () => {
    const before = baseProject();
    const op: ProjectOperation = { type: 'add_marker', id: 'm1', time: 5 };
    const after = applyProjectOperation(before, op);
    expect(after.markers).toEqual([marker('m1', 5)]);
    roundTrips(before, op);
  });

  it('add_marker carries optional label/color and is reversible', () => {
    const before = baseProject();
    const op: ProjectOperation = {
      type: 'add_marker',
      id: 'm1',
      time: 2.5,
      label: 'Intro',
      color: '#ff0000',
    };
    const after = applyProjectOperation(before, op);
    expect(after.markers).toEqual([marker('m1', 2.5, 'Intro', '#ff0000')]);
    roundTrips(before, op);
  });

  it('add_marker rejects a duplicate id', () => {
    const before = baseProject({ markers: [marker('m1', 1)] });
    expect(() => applyProjectOperation(before, { type: 'add_marker', id: 'm1', time: 2 })).toThrow(
      ProjectOperationError,
    );
  });

  it('add_marker rejects a negative time', () => {
    const before = baseProject();
    expect(() => applyProjectOperation(before, { type: 'add_marker', id: 'm1', time: -1 })).toThrow(
      /non-negative/,
    );
  });

  it('add_marker rejects a non-finite time', () => {
    const before = baseProject();
    expect(() =>
      applyProjectOperation(before, { type: 'add_marker', id: 'm1', time: Number.NaN }),
    ).toThrow(ProjectOperationError);
  });

  it('remove_marker drops the marker and restores its exact original data on undo', () => {
    const before = baseProject({ markers: [marker('m1', 1, 'Intro'), marker('m2', 5)] });
    const op: ProjectOperation = { type: 'remove_marker', id: 'm1' };
    const after = applyProjectOperation(before, op);
    expect(after.markers.map((m) => m.id)).toEqual(['m2']);

    // Re-adding a removed marker appends it (like `add_marker` always does), so
    // it lands at the END of the array rather than its original index — markers
    // have no order semantic (unlike, say, an ordered clip list), so the
    // roundtrip is checked as a set, not an ordered array equality.
    const inverse = invertProjectOperation(before, op)[0]!;
    const restored = applyProjectOperation(after, inverse);
    expect(new Set(restored.markers.map((m) => JSON.stringify(m)))).toEqual(
      new Set(before.markers.map((m) => JSON.stringify(m))),
    );
  });

  it('remove_marker of the last marker in the array round-trips with exact order', () => {
    const before = baseProject({ markers: [marker('m2', 5), marker('m1', 1, 'Intro')] });
    const op: ProjectOperation = { type: 'remove_marker', id: 'm1' };
    roundTrips(before, op);
  });

  it('remove_marker round-trips a bare marker (no label, no color)', () => {
    const before = baseProject({ markers: [marker('m1', 3)] });
    const op: ProjectOperation = { type: 'remove_marker', id: 'm1' };
    roundTrips(before, op);
  });

  it('remove_marker round-trips a marker with only a color set', () => {
    const before = baseProject({ markers: [marker('m1', 3, undefined, '#00ff00')] });
    const op: ProjectOperation = { type: 'remove_marker', id: 'm1' };
    roundTrips(before, op);
  });

  it('remove_marker throws on a missing marker', () => {
    expect(() =>
      applyProjectOperation(baseProject(), { type: 'remove_marker', id: 'nope' }),
    ).toThrow(/Marker not found/);
  });
});

describe('restore primitives', () => {
  it('restore_assets / restore_folders replace the lists and round-trip', () => {
    const before = baseProject({ assets: [asset('a1')], folders: [folder('f1', 'A')] });
    roundTrips(before, { type: 'restore_assets', assets: [asset('z')] });
    roundTrips(before, { type: 'restore_folders', folders: [folder('z', 'Z')] });
  });
});

describe('wouldCreateFolderCycle', () => {
  const folders = [folder('a', 'A'), folder('b', 'B', 'a'), folder('c', 'C', 'b')];
  it('detects a self/descendant parent link', () => {
    expect(wouldCreateFolderCycle(folders, 'a', 'c')).toBe(true); // a under its descendant c
    expect(wouldCreateFolderCycle(folders, 'a', 'a')).toBe(true); // self
  });
  it('allows a non-cyclic link', () => {
    expect(wouldCreateFolderCycle(folders, 'c', null)).toBe(false);
    expect(wouldCreateFolderCycle(folders, 'b', null)).toBe(false);
  });
  it('terminates on pre-existing corrupt cycles via the hop cap', () => {
    const corrupt = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    // 'x' is not in the corrupt loop, so the walk only exits via the hop cap.
    expect(wouldCreateFolderCycle(corrupt, 'x', 'a')).toBe(false);
  });
  it('returns false when the candidate parent does not exist', () => {
    expect(wouldCreateFolderCycle(folders, 'a', 'ghost')).toBe(false);
  });
});

describe('timeline-only applyPatch/invertPatch reject project ops', () => {
  const timeline = baseProject().timeline;
  const projectPatch = patchOf([{ type: 'add_asset', asset: asset('a1') }]);
  it('applyPatch throws a PatchError for a project-scoped op', () => {
    expect(() => applyPatch(timeline, projectPatch)).toThrow(PatchError);
  });
  it('invertPatch throws for a project-scoped op', () => {
    expect(() => invertPatch(timeline, projectPatch)).toThrow(/project-scoped/);
  });
});

describe('project-scoped patch engine', () => {
  it('applyProjectPatch mixes timeline + project ops transactionally', () => {
    const before = baseProject();
    const patch = patchOf([
      { type: 'add_asset', asset: asset('a1') },
      { type: 'create_folder', folderId: 'f1', name: 'B-roll', parentId: null },
      { type: 'move_asset', assetId: 'a1', folderId: 'f1' },
    ] as ProjectOperation[]);
    const after = applyProjectPatch(before, patch);
    expect(after.assets[0]?.folderId).toBe('f1');
    expect(after.folders).toHaveLength(1);
  });

  it('applyProjectPatch is all-or-nothing on a bad op', () => {
    const before = baseProject({ assets: [asset('a1')] });
    const patch = patchOf([{ type: 'add_asset', asset: asset('a1') }]); // duplicate
    expect(() => applyProjectPatch(before, patch)).toThrow();
    expect(before.assets).toHaveLength(1); // untouched
  });

  it('invertProjectPatch undoes a mixed patch', () => {
    const before = baseProject({ assets: [asset('a1')] });
    const patch = patchOf([
      { type: 'create_folder', folderId: 'f1', name: 'B', parentId: null },
      { type: 'move_asset', assetId: 'a1', folderId: 'f1' },
    ] as ProjectOperation[]);
    const after = applyProjectPatch(before, patch);
    const inverse = invertProjectPatch(before, patch);
    expect(applyProjectPatch(after, inverse)).toEqual(before);
  });

  it('invertProjectPatch round-trips a timeline op carried in a project patch', () => {
    const before = baseProject({
      assets: [asset('a1')],
      timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
    });
    const patch = patchOf([
      {
        type: 'add_clip',
        trackId: 'video_1',
        assetId: 'a1',
        start: 0,
        end: 5,
        sourceStart: 0,
        sourceEnd: 5,
      },
    ] as unknown as ProjectOperation[]);
    const after = applyProjectPatch(before, patch);
    expect(after.timeline.tracks[0]?.clips).toHaveLength(1);
    const inverse = invertProjectPatch(before, patch);
    const restored = applyProjectPatch(after, inverse);
    // Content round-trips; `timeline.revision` is a monotonic staleness marker
    // that counts forward through undo rather than rewinding (ADR 0076).
    expect({ ...restored, timeline: { ...restored.timeline, revision: undefined } }).toEqual({
      ...before,
      timeline: { ...before.timeline, revision: undefined },
    });
  });

  it('diffProject reports asset + folder changes', () => {
    const before = baseProject({ assets: [asset('a1')] });
    const after = applyProjectPatch(
      before,
      patchOf([
        { type: 'create_folder', folderId: 'f1', name: 'B-roll', parentId: null },
        { type: 'move_asset', assetId: 'a1', folderId: 'f1' },
        { type: 'add_asset', asset: asset('a2') },
      ] as ProjectOperation[]),
    );
    const diff = diffProject(before, after);
    expect(diff.summary).toContain('folder f1 added ("B-roll")');
    expect(diff.summary).toContain('asset a1 moved (root → f1)');
    expect(diff.summary).toContain('asset a2 added (root)');
  });

  it('diffProject keeps timeline lines alongside bin changes and reports folder removal', () => {
    const before = baseProject({ assets: [asset('a1')], folders: [folder('f1', 'Gone')] });
    const after = applyProjectPatch(
      before,
      patchOf([
        {
          type: 'add_clip',
          trackId: 'video_1',
          assetId: 'a1',
          start: 0,
          end: 5,
          sourceStart: 0,
          sourceEnd: 5,
        },
        // A second clip makes the timeline diff multi-line (length !== 1), so the
        // "no changes" filler check must not collapse real timeline lines.
        {
          type: 'add_clip',
          trackId: 'video_1',
          assetId: 'a1',
          start: 5,
          end: 10,
          sourceStart: 0,
          sourceEnd: 5,
        },
        { type: 'delete_folder', folderId: 'f1' },
      ] as unknown as ProjectOperation[]),
    );
    const diff = diffProject(before, after);
    expect(diff.summary.filter((l) => l.startsWith('[video_1] + clip')).length).toBe(2);
    expect(diff.summary).toContain('folder f1 removed');
    expect(diff.summary).not.toContain('no changes');
  });

  it('diffProject returns the bare timeline diff when only the timeline changed', () => {
    const before = baseProject({ assets: [asset('a1')] });
    const after = applyProjectPatch(
      before,
      patchOf([
        {
          type: 'add_clip',
          trackId: 'video_1',
          assetId: 'a1',
          start: 0,
          end: 5,
          sourceStart: 0,
          sourceEnd: 5,
        },
      ] as unknown as ProjectOperation[]),
    );
    const diff = diffProject(before, after);
    expect(diff.summary.some((l) => l.startsWith('[video_1] + clip'))).toBe(true);
    expect(diff.summary.some((l) => l.startsWith('asset') || l.startsWith('folder'))).toBe(false);
  });

  it('diffProject reports renames, folder moves and removals', () => {
    const before = baseProject({
      assets: [asset('a1')],
      folders: [folder('f1', 'Old'), folder('f2', 'Keep')],
    });
    const after = applyProjectPatch(
      before,
      patchOf([
        { type: 'rename_folder', folderId: 'f1', name: 'New' },
        { type: 'move_folder', folderId: 'f2', parentId: 'f1' },
        { type: 'remove_asset', assetId: 'a1' },
      ] as ProjectOperation[]),
    );
    const diff = diffProject(before, after);
    expect(diff.summary).toContain('folder f1 renamed ("Old" → "New")');
    expect(diff.summary.some((l) => l.includes('folder f2 moved'))).toBe(true);
    expect(diff.summary).toContain('asset a1 removed');
  });
});

describe('project-scoped history', () => {
  it('commit → undo → redo round-trips assets and folders', () => {
    const before = baseProject();
    const patch = patchOf([
      { type: 'add_asset', asset: asset('a1') },
      { type: 'create_folder', folderId: 'f1', name: 'B', parentId: null },
    ] as ProjectOperation[]);

    const committed = commitProjectPatch(before, emptyHistory(), patch);
    expect(committed.project.assets).toHaveLength(1);
    expect(committed.project.folders).toHaveLength(1);

    const undone = undoProject(committed.project, committed.history);
    expect(undone.project).toEqual(before);

    const redone = redoProject(undone.project, undone.history);
    expect(redone.project).toEqual(committed.project);
  });

  it('undo/redo are no-ops at the stack ends', () => {
    const p = baseProject();
    expect(undoProject(p, emptyHistory()).project).toBe(p);
    const committed = commitProjectPatch(
      p,
      emptyHistory(),
      patchOf([{ type: 'add_asset', asset: asset('a1') }]),
    );
    expect(redoProject(committed.project, committed.history).project).toBe(committed.project);
  });

  it('records committedAt on a project-scoped commit when provided', () => {
    const committed = commitProjectPatch(
      baseProject(),
      emptyHistory(),
      patchOf([{ type: 'add_asset', asset: asset('a1') }]),
      1_700_000_000_000,
    );
    expect(committed.history.entries[0]!.committedAt).toBe(1_700_000_000_000);
  });

  it('gotoProject jumps across a multi-edit stack (back, forward, clamp, no-op)', () => {
    const before = baseProject();
    const c1 = commitProjectPatch(
      before,
      emptyHistory(),
      patchOf([{ type: 'add_asset', asset: asset('a1') }]),
    );
    const c2 = commitProjectPatch(
      c1.project,
      c1.history,
      patchOf([{ type: 'add_asset', asset: asset('a2') }]),
    );

    // Jump to the very start.
    const start = gotoProject(c2.project, c2.history, 0);
    expect(start.project).toEqual(before);
    expect(start.history.cursor).toBe(0);

    // Jump forward to the intermediate point.
    const mid = gotoProject(start.project, start.history, 1);
    expect(mid.project.assets).toHaveLength(1);
    expect(mid.history.cursor).toBe(1);

    // Clamp beyond the end returns the latest state.
    const clamped = gotoProject(mid.project, mid.history, 99);
    expect(clamped.project).toEqual(c2.project);
    expect(clamped.history.cursor).toBe(2);

    // No-op when already at the target.
    expect(gotoProject(clamped.project, clamped.history, 2).project).toBe(clamped.project);
  });

  it('treats consecutive commits sharing a groupId as one undo step without flattening live entries', () => {
    const before = baseProject();
    const c1 = commitProjectPatch(
      before,
      emptyHistory(),
      patchOf([{ type: 'add_asset', asset: asset('a1') }]),
      1_700_000_000_000,
      'run_1',
    );
    const c2 = commitProjectPatch(
      c1.project,
      c1.history,
      patchOf([{ type: 'add_asset', asset: asset('a2') }]),
      undefined,
      'run_1',
    );

    // Live history stays compact: each commit keeps its own single-operation
    // entry, so an agent run no longer re-flattens a growing operation array on
    // every step. The group is collapsed once, at serialization time.
    expect(c2.history.entries).toHaveLength(2);
    expect(c2.history.cursor).toBe(2);
    expect(c2.history.entries.every((entry) => entry.groupId === 'run_1')).toBe(true);
    expect(c2.history.entries[0]!.committedAt).toBe(1_700_000_000_000);
    expect(c2.history.entries[0]!.patch.operations).toHaveLength(1);
    expect(c2.history.entries[1]!.patch.operations).toHaveLength(1);

    // Restart history still sees the run as one reversible step.
    const persisted = toPersistedHistory(c2.history);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.groupId).toBe('run_1');
    expect(persisted[0]!.committedAt).toBe(1_700_000_000_000);
    expect(persisted[0]!.patch.operations).toHaveLength(2);
    expect(persisted[0]!.inverse.operations).toHaveLength(2);
    expect(persisted[0]!.memberPatches?.map(({ patchId }) => patchId)).toEqual([
      c2.history.entries[0]!.patch.patchId,
      c2.history.entries[1]!.patch.patchId,
    ]);

    // Undoing the group reverts both operations as one user action.
    const undone = undoProject(c2.project, c2.history);
    expect(undone.project).toEqual(before);
    expect(undone.history.cursor).toBe(0);
  });

  it('merges distinct reasons when grouping commits with different patch reasons', () => {
    const before = baseProject();
    const c1 = commitProjectPatch(
      before,
      emptyHistory(),
      { ...patchOf([{ type: 'add_asset', asset: asset('a1') }]), reason: 'add a1' },
      undefined,
      'run_2',
    );
    const c2 = commitProjectPatch(
      c1.project,
      c1.history,
      { ...patchOf([{ type: 'add_asset', asset: asset('a2') }]), reason: 'add a2' },
      undefined,
      'run_2',
    );

    // Live entries keep their own reasons; the merge happens once on collapse.
    expect(c2.history.entries.map((entry) => entry.patch.reason)).toEqual(['add a1', 'add a2']);
    expect(toPersistedHistory(c2.history)[0]!.patch.reason).toBe('add a1; add a2');
  });

  it('does not group commits with different groupIds or no groupId', () => {
    const before = baseProject();
    const c1 = commitProjectPatch(
      before,
      emptyHistory(),
      patchOf([{ type: 'add_asset', asset: asset('a1') }]),
      undefined,
      'run_a',
    );
    const c2 = commitProjectPatch(
      c1.project,
      c1.history,
      patchOf([{ type: 'add_asset', asset: asset('a2') }]),
      undefined,
      'run_b',
    );
    expect(c2.history.entries).toHaveLength(2);

    const c3 = commitProjectPatch(
      c2.project,
      c2.history,
      patchOf([{ type: 'add_asset', asset: asset('a3') }]),
    );
    expect(c3.history.entries).toHaveLength(3);
    expect(c3.history.entries[2]!.groupId).toBeUndefined();
  });
});

describe('validatePatch — project ops', () => {
  const ctx = (p: Project) => ({
    assetIds: p.assets.map((a) => a.id),
    folders: p.folders,
    markers: p.markers,
  });

  it('accepts a valid organize-into-folder patch', () => {
    const p = baseProject({ assets: [asset('a1')] });
    const result = validatePatch(
      p.timeline,
      patchOf([
        { type: 'create_folder', folderId: 'f1', name: 'B', parentId: null },
        { type: 'move_asset', assetId: 'a1', folderId: 'f1' },
      ] as ProjectOperation[]),
      ctx(p),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a duplicate asset, missing folder, and folder cycle', () => {
    const p = baseProject({
      assets: [asset('a1')],
      folders: [folder('f1', 'A'), folder('f2', 'B', 'f1')],
    });
    const dup = validatePatch(
      p.timeline,
      patchOf([{ type: 'add_asset', asset: asset('a1') }]),
      ctx(p),
    );
    expect(dup.issues.some((i) => i.code === 'duplicate_asset')).toBe(true);

    const missing = validatePatch(
      p.timeline,
      patchOf([{ type: 'move_asset', assetId: 'a1', folderId: 'ghost' }]),
      ctx(p),
    );
    expect(missing.issues.some((i) => i.code === 'missing_folder')).toBe(true);

    const cycle = validatePatch(
      p.timeline,
      patchOf([{ type: 'move_folder', folderId: 'f1', parentId: 'f2' }]),
      ctx(p),
    );
    expect(cycle.issues.some((i) => i.code === 'folder_cycle')).toBe(true);
  });

  it('rejects add_asset into an unknown folder and a duplicate folder id', () => {
    const p = baseProject({ folders: [folder('f1', 'A')] });
    const badAsset = validatePatch(
      p.timeline,
      patchOf([{ type: 'add_asset', asset: asset('a1', 'ghost') }]),
      ctx(p),
    );
    expect(badAsset.issues.some((i) => i.code === 'missing_folder')).toBe(true);

    const dupFolder = validatePatch(
      p.timeline,
      patchOf([{ type: 'create_folder', folderId: 'f1', name: 'dupe', parentId: null }]),
      ctx(p),
    );
    expect(dupFolder.issues.some((i) => i.code === 'duplicate_folder')).toBe(true);
  });

  it('rejects create_folder / move_folder targeting an unknown parent', () => {
    const p = baseProject({ folders: [folder('f1', 'A')] });
    const create = validatePatch(
      p.timeline,
      patchOf([{ type: 'create_folder', folderId: 'f2', name: 'B', parentId: 'ghost' }]),
      ctx(p),
    );
    expect(create.issues.some((i) => i.code === 'missing_folder')).toBe(true);

    const move = validatePatch(
      p.timeline,
      patchOf([{ type: 'move_folder', folderId: 'f1', parentId: 'ghost' }]),
      ctx(p),
    );
    expect(move.issues.some((i) => i.code === 'missing_folder')).toBe(true);
  });

  it('rejects removing an asset that timeline clips still use', () => {
    const p = baseProject({
      assets: [asset('a1')],
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'c1',
                assetId: 'a1',
                trackId: 'video_1',
                start: 0,
                end: 5,
                sourceStart: 0,
                sourceEnd: 5,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    });
    const result = validatePatch(
      p.timeline,
      patchOf([{ type: 'remove_asset', assetId: 'a1' }]),
      ctx(p),
    );
    expect(result.issues.some((i) => i.code === 'asset_in_use')).toBe(true);
  });

  it('skips reference checks when no context is supplied', () => {
    const p = baseProject();
    const result = validatePatch(
      p.timeline,
      patchOf([
        { type: 'add_asset', asset: asset('a1', 'whatever') },
        { type: 'move_asset', assetId: 'ghost', folderId: 'ghost2' },
        { type: 'create_folder', folderId: 'f1', name: 'A', parentId: 'unknown' },
        { type: 'rename_folder', folderId: 'f1', name: 'B' },
        { type: 'delete_folder', folderId: 'f1' },
      ] as ProjectOperation[]),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts internal restore ops and advances state from them', () => {
    const p = baseProject({ assets: [asset('a1')], folders: [folder('f1', 'A')] });
    const result = validatePatch(
      p.timeline,
      patchOf([
        { type: 'restore_folders', folders: [folder('f2', 'B')] },
        { type: 'restore_assets', assets: [asset('a2')] },
        { type: 'move_asset', assetId: 'a2', folderId: 'f2' },
      ] as ProjectOperation[]),
      ctx(p),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects remove/move of a missing asset (with context)', () => {
    const p = baseProject({ assets: [asset('a1')] });
    const remove = validatePatch(
      p.timeline,
      patchOf([{ type: 'remove_asset', assetId: 'ghost' }]),
      ctx(p),
    );
    expect(remove.issues.some((i) => i.code === 'missing_asset')).toBe(true);
    const move = validatePatch(
      p.timeline,
      patchOf([{ type: 'move_asset', assetId: 'ghost', folderId: null }]),
      ctx(p),
    );
    expect(move.issues.some((i) => i.code === 'missing_asset')).toBe(true);
  });

  it('rejects rename/move/delete of a missing folder (with context)', () => {
    const p = baseProject({ folders: [folder('f1', 'A')] });
    for (const op of [
      { type: 'rename_folder', folderId: 'ghost', name: 'X' },
      { type: 'move_folder', folderId: 'ghost', parentId: null },
      { type: 'delete_folder', folderId: 'ghost' },
    ] as ProjectOperation[]) {
      const result = validatePatch(p.timeline, patchOf([op]), ctx(p));
      expect(result.issues.some((i) => i.code === 'missing_folder')).toBe(true);
    }
  });

  it('advances delete_folder state reparenting children but leaving siblings', () => {
    const p = baseProject({
      folders: [folder('root', 'Root'), folder('child', 'Child', 'root'), folder('sib', 'Sib')],
    });
    // Delete root (child reparents to null, sib untouched), then both must still
    // be addressable by a later op — proving advanceProjectState kept them.
    const result = validatePatch(
      p.timeline,
      patchOf([
        { type: 'delete_folder', folderId: 'root' },
        { type: 'rename_folder', folderId: 'child', name: 'Renamed' },
        { type: 'rename_folder', folderId: 'sib', name: 'Sib2' },
      ] as ProjectOperation[]),
      ctx(p),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts a valid add_marker/remove_marker patch', () => {
    const p = baseProject({ markers: [marker('m1', 1)] });
    const result = validatePatch(
      p.timeline,
      patchOf([
        { type: 'add_marker', id: 'm2', time: 5 },
        { type: 'remove_marker', id: 'm1' },
      ] as ProjectOperation[]),
      ctx(p),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects add_marker with a duplicate id or a negative time', () => {
    const p = baseProject({ markers: [marker('m1', 1)] });
    const dup = validatePatch(
      p.timeline,
      patchOf([{ type: 'add_marker', id: 'm1', time: 3 }]),
      ctx(p),
    );
    expect(dup.issues.some((i) => i.code === 'duplicate_marker')).toBe(true);

    const negative = validatePatch(
      p.timeline,
      patchOf([{ type: 'add_marker', id: 'm2', time: -1 }]),
      ctx(p),
    );
    expect(negative.issues.some((i) => i.code === 'invalid_marker_time')).toBe(true);
  });

  it('rejects remove_marker of a missing marker (with context)', () => {
    const p = baseProject({ markers: [marker('m1', 1)] });
    const result = validatePatch(
      p.timeline,
      patchOf([{ type: 'remove_marker', id: 'ghost' }]),
      ctx(p),
    );
    expect(result.issues.some((i) => i.code === 'missing_marker')).toBe(true);
  });

  it('skips marker reference checks when no marker context is supplied', () => {
    const p = baseProject();
    const result = validatePatch(
      p.timeline,
      patchOf([
        { type: 'add_marker', id: 'm1', time: 1 },
        { type: 'remove_marker', id: 'ghost' },
      ] as ProjectOperation[]),
      { assetIds: p.assets.map((a) => a.id), folders: p.folders },
    );
    expect(result.valid).toBe(true);
  });

  it('advances marker state so create+remove within one patch validates', () => {
    const p = baseProject();
    const result = validatePatch(
      p.timeline,
      patchOf([
        { type: 'add_marker', id: 'm1', time: 1 },
        { type: 'remove_marker', id: 'm1' },
        { type: 'add_marker', id: 'm1', time: 2 },
      ] as ProjectOperation[]),
      ctx(p),
    );
    expect(result.valid).toBe(true);
  });

  it('advances marker state carrying label/color so a later duplicate check sees them', () => {
    const p = baseProject();
    const withLabel = validatePatch(
      p.timeline,
      patchOf([
        { type: 'add_marker', id: 'm1', time: 1, label: 'Intro' },
        { type: 'add_marker', id: 'm1', time: 2 },
      ] as ProjectOperation[]),
      ctx(p),
    );
    expect(withLabel.issues.some((i) => i.code === 'duplicate_marker')).toBe(true);

    const withColor = validatePatch(
      p.timeline,
      patchOf([
        { type: 'add_marker', id: 'm2', time: 1, color: '#00ff00' },
        { type: 'add_marker', id: 'm2', time: 2 },
      ] as ProjectOperation[]),
      ctx(p),
    );
    expect(withColor.issues.some((i) => i.code === 'duplicate_marker')).toBe(true);
  });

  it('advances working state so create+use within one patch validates', () => {
    const p = baseProject({ assets: [asset('a1')] });
    const result = validatePatch(
      p.timeline,
      patchOf([
        { type: 'create_folder', folderId: 'f1', name: 'A', parentId: null },
        { type: 'create_folder', folderId: 'f2', name: 'B', parentId: 'f1' },
        { type: 'move_asset', assetId: 'a1', folderId: 'f2' },
        { type: 'delete_folder', folderId: 'f1' },
        { type: 'rename_folder', folderId: 'f2', name: 'renamed' },
      ] as ProjectOperation[]),
      ctx(p),
    );
    expect(result.valid).toBe(true);
  });
});
