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
    assets: [{ id: 'asset', path: 'shot.mp4', kind: 'video', durationSeconds: 4 }],
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
              effects: withMask
                ? [
                    {
                      id: 'shot__mask',
                      type: 'mask',
                      params: {
                        shape: 'ellipse',
                        bounds: { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
                      },
                      keyframes: [
                        { id: 'mx0', time: 0, property: 'x', value: 0.2 },
                        { id: 'mx1', time: 4, property: 'x', value: 0.5 },
                      ],
                    },
                  ]
                : [],
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
    expect(edited.tracks[0]!.clips[0]!.effects).toEqual([
      expect.objectContaining({ id: 'shot__mask', type: 'mask' }),
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
