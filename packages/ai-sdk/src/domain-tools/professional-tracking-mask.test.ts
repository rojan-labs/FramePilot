import { describe, expect, it } from 'vitest';
import { applyPatch, type Patch } from '@framepilot/editor-core';
import type { PatchId } from '@framepilot/shared-types';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { captureEditorInteractionContext } from '../editor-context/interaction-context.js';
import { operationsForCall } from '../tool-dispatch.js';
import type { ToolContext } from '../tool-context.js';
import {
  resolveTrackingMaskObjective,
  TrackingMaskObjectiveSchema,
} from '../controllers/tracking-mask-controller.js';

function project(withMask = true): Project {
  return parseProject({
    id: 'tracking_project',
    name: 'Tracking controller fixture',
    version: 1,
    fps: 24,
    resolution: { width: 1920, height: 1080 },
    assets: [
      {
        id: 'asset',
        path: 'shot.mp4',
        kind: 'video',
        durationSeconds: 4,
        media: { width: 1920, height: 1080 },
      },
    ],
    timeline: {
      revision: 2,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'shot',
              assetId: 'asset',
              trackId: 'v1',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              // Schema v22: an ellipse around {x 0.2, y 0.1, w 0.25, h 0.4}, sweeping right.
              ...(withMask
                ? {
                    masks: [
                      {
                        kind: 'ellipse',
                        id: 'shot__mask',
                        cx: 624,
                        cy: 324,
                        rx: 240,
                        ry: 216,
                        keyframes: [
                          { id: 'mx0', sourceTime: 0, property: 'cx', value: 624 },
                          { id: 'mx1', sourceTime: 4, property: 'cx', value: 1200 },
                        ],
                      },
                    ],
                  }
                : {}),
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

function context(base: Project, selectedClipIds = ['shot']): ToolContext {
  return {
    project: base,
    interaction: captureEditorInteractionContext({
      project: base,
      projectRevision: 9,
      playheadSeconds: 2,
      selectedClipIds,
      primaryClipId: selectedClipIds.at(-1),
    }),
  };
}

function dispatch(base: Project, ctx: ToolContext, args: Record<string, unknown>) {
  const operations = operationsForCall(
    { id: 'tracking_call', name: 'professional_tracking_mask', arguments: args },
    ctx,
  );
  const patch: Patch = {
    patchId: 'tracking_tool_test' as PatchId,
    createdBy: 'agent',
    reason: 'tracking controller test',
    operations,
  };
  return applyPatch(base.timeline, patch);
}

describe('professional_tracking_mask domain tool', () => {
  it('tracks the selected shot from its existing mask geometry and corrections', () => {
    const base = project();
    const edited = dispatch(base, context(base), { intent: 'track_existing_mask' });
    // Schema v22: the mask stays on the clip's mask stack; the tracker is the one effect.
    expect(edited.tracks[0]!.clips[0]!.masks?.map((mask) => mask.id)).toEqual(['shot__mask']);
    expect(edited.tracks[0]!.clips[0]!.effects).toEqual([
      expect.objectContaining({
        id: 'shot__track',
        type: 'object_track',
        params: {
          target: 'object',
          engine: 'manual',
          region: { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
        },
        keyframes: expect.arrayContaining([
          expect.objectContaining({ property: 'x', time: 4, value: 0.5 }),
          expect.objectContaining({ property: 'height', time: 0, value: 0.4 }),
        ]),
      }),
    ]);
  });

  it('rejects missing masks and absent live interaction instead of guessing a region', () => {
    const base = project(false);
    const objective = TrackingMaskObjectiveSchema.parse({ intent: 'track_existing_mask' });
    expect(
      resolveTrackingMaskObjective({
        project: base,
        interaction: context(base).interaction!,
        objective,
      }),
    ).toMatchObject({ status: 'rejected', code: 'mask_unresolved' });
    expect(() =>
      operationsForCall(
        {
          id: 'tracking_call',
          name: 'professional_tracking_mask',
          arguments: { intent: 'track_existing_mask' },
        },
        { project: base },
      ),
    ).toThrow(/live editor interaction/i);
  });

  it('exposes only the real manual engine and bounded-mask targets', () => {
    expect(() =>
      TrackingMaskObjectiveSchema.parse({ intent: 'track_existing_mask', engine: 'auto' }),
    ).toThrow();
    expect(() =>
      TrackingMaskObjectiveSchema.parse({ intent: 'track_existing_mask', subject: 'face' }),
    ).toThrow();
  });
});
