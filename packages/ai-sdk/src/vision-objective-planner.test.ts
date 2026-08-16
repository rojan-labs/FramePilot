import { describe, expect, it } from 'vitest';
import { asId } from '@framepilot/shared-types';
import { applyProjectPatch, type AnyOperation, type Patch } from '@framepilot/editor-core';
import { makeProject } from './__fixtures__/project.js';
import type { EditResult } from './assemble.js';
import { planVisionObjectivesForEdit } from './vision-objective-planner.js';

function edit(operations: readonly AnyOperation[]): EditResult {
  const patch: Patch = {
    patchId: asId<'PatchId'>('patch_vision'),
    createdBy: 'agent',
    reason: 'Professional visual edit',
    operations,
  };
  return {
    patch,
    validation: { valid: true, issues: [] },
    text: patch.reason,
  };
}

describe('planVisionObjectivesForEdit', () => {
  it('declares bounded framing evidence for authored transform motion', () => {
    const result = edit([
      {
        type: 'add_keyframes',
        clipId: 'clip_a',
        keyframes: [
          { id: 'x0', property: 'x', time: 0, value: 0, easing: 'linear' },
          { id: 'x1', property: 'x', time: 5, value: 0.3, easing: 'linear' },
        ],
      },
    ]);
    const project = applyProjectPatch(makeProject(), result.patch);
    const requests = planVisionObjectivesForEdit({ project, edit: result });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: 'patch_vision:motion-framing:clip_a',
      frames: [0, 150, 90, 179],
    });
    expect(requests[0]?.frames).toHaveLength(4);
  });

  it('declares tracking, mask, crop, and transition questions but not measured-only edits', () => {
    const semantic = edit([
      { type: 'set_clip_crop', clipId: 'clip_a', crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } },
      { type: 'add_mask', clipId: 'clip_a', shape: 'ellipse' },
      { type: 'track_object', clipId: 'clip_a', target: 'face', engine: 'manual' },
      {
        type: 'add_transition',
        trackId: 'video_1',
        fromClipId: 'clip_a',
        toClipId: 'clip_b',
        kind: 'dissolve',
        durationSeconds: 0.5,
      },
    ]);
    const requests = planVisionObjectivesForEdit({ project: makeProject(), edit: semantic });
    expect(requests.map((request) => request.requestId)).toEqual([
      'patch_vision:crop-framing:clip_a',
      'patch_vision:mask-subject:clip_a',
      'patch_vision:tracked-subject:clip_a',
      'patch_vision:transition-coherence:clip_b',
    ]);

    const measured = edit([
      { type: 'adjust_audio', clipId: 'clip_a', gainDb: -6 },
      {
        type: 'apply_color_grade',
        clipId: 'clip_a',
        effect: { id: 'grade', type: 'color_grade', params: { exposure: 0.2 }, keyframes: [] },
      },
    ]);
    expect(planVisionObjectivesForEdit({ project: makeProject(), edit: measured })).toEqual([]);
  });
});
