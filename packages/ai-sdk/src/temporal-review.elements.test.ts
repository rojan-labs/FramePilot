/**
 * The temporal review and a sticker (plan/elements EL8.1): a sticker added over the footage is a
 * graphic, not a shot. The review probes the frames where it appears and leaves — a flash or a
 * black frame there is still a defect — and asks nothing that treats it as picture of its own: no
 * motion measurement (that is for trackers and masks), and no request that calls it footage.
 */
import { describe, expect, it } from 'vitest';
import { makeProject } from './__fixtures__/project.js';
import type { EditResult } from './assemble.js';
import { planTemporalEvidenceForEdit } from './temporal-review.js';

const editWith = (after: ReturnType<typeof makeProject>['timeline']): EditResult => ({
  patch: { patchId: 'patch' as never, createdBy: 'agent', reason: 'test', operations: [] },
  validation: { valid: true, issues: [] },
  diff: { before: makeProject().timeline, after, summary: ['changed'] },
  text: 'test',
});

describe('planTemporalEvidenceForEdit, for a sticker', () => {
  it('probes where the sticker appears and leaves, and nothing that treats it as a shot', () => {
    const before = makeProject();
    const after = {
      ...before.timeline,
      revision: 1,
      tracks: [
        {
          id: 'overlay_1',
          type: 'overlay' as const,
          clips: [
            {
              id: 'clip_fire',
              assetId: 'element_fluent3d_fire',
              trackId: 'overlay_1',
              start: 1,
              end: 3,
              sourceStart: 0,
              sourceEnd: 2,
              effects: [],
              keyframes: [
                { id: 'kf_s', time: 0, property: 'scale', value: 0.4, easing: 'linear' as const },
              ],
            },
          ],
        },
        ...before.timeline.tracks,
      ],
    };
    const requests = planTemporalEvidenceForEdit({
      projectRevision: 1,
      edit: editWith(after),
      sequenceFps: 30,
      durationFrames: 300,
    });
    const windows = requests
      .filter((request) => request.kind === 'range')
      .map((request) => request.requestId);
    expect(windows).toContain('edit_range_30');
    expect(windows).toContain('edit_range_90');
    expect(requests.some((request) => request.kind === 'motion')).toBe(false);
    for (const request of requests) {
      expect(request.reason.toLowerCase(), request.requestId).not.toContain('footage');
    }
  });
});
