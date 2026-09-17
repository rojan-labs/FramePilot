/** `relink_asset`: point an asset at another file, undoably (BR4.14). */
import { describe, expect, it } from 'vitest';
import type { Project } from '@framepilot/timeline-schema';
import { asId } from '@framepilot/shared-types';
import { applyProjectOperation, invertProjectOperation, isProjectOperation, ProjectOperationError } from './project-operations.js';
import { applyProjectPatch, invertProjectPatch, type Patch } from './patch.js';
import { validatePatch } from './validator.js';

const project = (): Project =>
  ({
    id: 'p1',
    name: 'Test',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'a1', path: '/old/shot.mov', kind: 'video', media: { width: 1920, height: 1080 } },
      { id: 'a2', path: '/old/other.mov', kind: 'video' },
    ],
    folders: [],
    timeline: {
      tracks: [{ id: 'video_1', type: 'video', clips: [{ id: 'c1', assetId: 'a1', start: 0, end: 1, sourceStart: 0, sourceEnd: 1 }] }],
    },
    transcript: [],
    markers: [],
    aiMemory: {},
    history: [],
  }) as unknown as Project;

const patch = (operations: Patch['operations']): Patch => ({
  patchId: asId<'PatchId'>('patch_relink'),
  createdBy: 'user',
  reason: 'relink',
  operations,
});

describe('relink_asset', () => {
  it('changes only the asset path; clips, masks and derived media follow the id', () => {
    const before = project();
    const after = applyProjectOperation(before, { type: 'relink_asset', assetId: 'a1', path: '/new/shot.mov' });
    expect(after.assets[0]).toEqual({ ...before.assets[0], path: '/new/shot.mov' });
    expect(after.assets[1]).toBe(before.assets[1]);
    expect(after.timeline).toBe(before.timeline);
    expect(isProjectOperation({ type: 'relink_asset' })).toBe(true);
  });

  it('inverts to the previous path and round-trips through a patch', () => {
    const before = project();
    const forward = patch([{ type: 'relink_asset', assetId: 'a1', path: '/new/shot.mov' }]);
    const inverse = invertProjectPatch(before, forward);
    expect(inverse.operations).toEqual([{ type: 'relink_asset', assetId: 'a1', path: '/old/shot.mov' }]);
    expect(invertProjectOperation(before, forward.operations[0] as never)).toEqual(inverse.operations);
    expect(applyProjectPatch(applyProjectPatch(before, forward), inverse)).toEqual(before);
  });

  it('refuses an unknown asset and an empty or padded path, in apply and in validation', () => {
    expect(() => applyProjectOperation(project(), { type: 'relink_asset', assetId: 'nope', path: '/x.mov' })).toThrow(ProjectOperationError);
    for (const bad of ['', ' /x.mov', '/x\0.mov']) {
      expect(() => applyProjectOperation(project(), { type: 'relink_asset', assetId: 'a1', path: bad })).toThrow(/non-empty file path/);
    }
    const issues = validatePatch(
      project().timeline,
      patch([
        { type: 'relink_asset', assetId: 'nope', path: '/x.mov' },
        { type: 'relink_asset', assetId: 'a1', path: '' },
      ]),
      { assetIds: ['a1', 'a2'] },
    ).issues.map((issue) => issue.code);
    expect(issues).toEqual(['missing_asset', 'invalid_asset_path']);
    expect(validatePatch(project().timeline, patch([{ type: 'relink_asset', assetId: 'a1', path: '/new.mov' }]), { assetIds: ['a1'] }).valid).toBe(true);
  });
});
