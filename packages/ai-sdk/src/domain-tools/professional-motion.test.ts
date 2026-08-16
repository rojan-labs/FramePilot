import { describe, expect, it } from 'vitest';
import { applyPatch, type Patch } from '@framepilot/editor-core';
import type { PatchId } from '@framepilot/shared-types';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { MotionObjectiveSchema, resolveMotionObjective } from '../controllers/motion-controller.js';
import { captureEditorInteractionContext } from '../editor-context/interaction-context.js';
import { operationsForCall } from '../tool-dispatch.js';
import type { ToolContext } from '../tool-context.js';
import { PROFESSIONAL_MOTION_TOOL } from './professional-motion.js';

function project(): Project {
  return parseProject({
    id: 'motion_project',
    name: 'Motion controller fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      {
        id: 'hero_asset',
        path: 'hero.mp4',
        kind: 'video',
        durationSeconds: 20,
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
              id: 'hero',
              assetId: 'hero_asset',
              trackId: 'v1',
              start: 10,
              end: 20,
              sourceStart: 0,
              sourceEnd: 10,
              effects: [],
              keyframes: [
                { id: 'scale_1', time: 1, property: 'scale', value: 1, easing: 'linear' },
                {
                  id: 'scale_2',
                  time: 2,
                  property: 'scale',
                  value: 1.1,
                  easing: 'linear',
                },
                { id: 'x_2', time: 2, property: 'x', value: 0, easing: 'linear' },
              ],
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

function context(
  base: Project,
  options: {
    readonly playheadSeconds?: number;
    readonly selectedProperties?: readonly ('scale' | 'x')[];
  } = {},
): ToolContext {
  const selectedProperties = options.selectedProperties ?? ['scale'];
  return {
    project: base,
    interaction: captureEditorInteractionContext({
      project: base,
      projectRevision: 7,
      playheadSeconds: options.playheadSeconds ?? 12,
      selectedClipIds: ['hero'],
      primaryClipId: 'hero',
      selectedKeyframes: selectedProperties.map((property) => ({
        clipId: 'hero',
        property,
        time: 2,
      })),
    }),
  };
}

function dispatch(base: Project, ctx: ToolContext, args: Record<string, unknown>) {
  const operations = operationsForCall(
    { id: 'motion_call', name: 'professional_motion', arguments: args },
    ctx,
  );
  const patch: Patch = {
    patchId: 'motion_tool_test' as PatchId,
    createdBy: 'agent',
    reason: 'motion controller test',
    operations,
  };
  return applyPatch(base.timeline, patch);
}

describe('professional_motion domain tool', () => {
  it('animates the selected property from its playhead value in clip frames', () => {
    const base = project();
    const edited = dispatch(base, context(base), {
      intent: 'animate_to',
      value: 1.2,
      durationFrames: 15,
    });
    const scale = edited.tracks[0]!.clips[0]!.keyframes.filter(
      (keyframe) => keyframe.property === 'scale',
    );
    expect(scale.map((keyframe) => [keyframe.time, keyframe.value, keyframe.easing])).toEqual([
      [1, 1, 'linear'],
      [2, 1.1, 'ease-in-out'],
      [2.5, 1.2, 'ease-in-out'],
    ]);
  });

  it('continues the selected trajectory from its selected anchor', () => {
    const base = project();
    const objective = MotionObjectiveSchema.parse({
      intent: 'continue',
      durationFrames: 30,
    });
    const interaction = context(base).interaction!;
    const result = resolveMotionObjective({ project: base, interaction, objective });
    expect(result).toMatchObject({
      status: 'resolved',
      commands: [
        {
          type: 'animate_clip_property',
          property: 'scale',
          points: [
            { frame: 60, value: 1.1, easing: 'linear' },
            { frame: 90, value: 1.2, easing: 'linear' },
          ],
        },
      ],
    });
  });

  it('rejects multiple selected properties instead of choosing one', () => {
    const base = project();
    const objective = MotionObjectiveSchema.parse({
      intent: 'animate_to',
      value: 1.2,
      durationFrames: 15,
    });
    const interaction = context(base, { selectedProperties: ['scale', 'x'] }).interaction!;
    expect(resolveMotionObjective({ project: base, interaction, objective })).toMatchObject({
      status: 'rejected',
      code: 'property_ambiguous',
    });
  });

  it('accepts an explicit property over a multi-property selection', () => {
    const base = project();
    const objective = MotionObjectiveSchema.parse({
      intent: 'animate_to',
      property: 'x',
      value: 80,
      durationFrames: 15,
    });
    const interaction = context(base, { selectedProperties: ['scale', 'x'] }).interaction!;
    expect(resolveMotionObjective({ project: base, interaction, objective })).toMatchObject({
      status: 'resolved',
      commands: [{ property: 'x' }],
    });
  });

  it('rejects a motion window that runs past the clip', () => {
    const base = project();
    const objective = MotionObjectiveSchema.parse({
      intent: 'animate_to',
      property: 'opacity',
      value: 0,
      durationFrames: 60,
    });
    const interaction = context(base, { playheadSeconds: 19 }).interaction!;
    expect(resolveMotionObjective({ project: base, interaction, objective })).toMatchObject({
      status: 'rejected',
      code: 'motion_window_outside_clip',
    });
  });

  it('rejects canvas-cover motion that would reveal black edges', () => {
    const base = project();
    const objective = MotionObjectiveSchema.parse({
      intent: 'animate_to',
      property: 'scale',
      value: 0.9,
      durationFrames: 15,
      constraintPolicy: 'cover_canvas',
    });
    const interaction = context(base).interaction!;
    expect(resolveMotionObjective({ project: base, interaction, objective })).toMatchObject({
      status: 'rejected',
      code: 'canvas_coverage_violation',
    });
  });

  it('requires two historical points before continuing motion', () => {
    const base = project();
    base.timeline.tracks[0]!.clips[0]!.keyframes =
      base.timeline.tracks[0]!.clips[0]!.keyframes.filter((keyframe) => keyframe.id !== 'scale_1');
    const objective = MotionObjectiveSchema.parse({ intent: 'continue', durationFrames: 15 });
    const interaction = context(base).interaction!;
    expect(resolveMotionObjective({ project: base, interaction, objective })).toMatchObject({
      status: 'rejected',
      code: 'insufficient_motion_history',
    });
  });

  it('is a host-only professional mutation surface', () => {
    expect(PROFESSIONAL_MOTION_TOOL).toMatchObject({
      kind: 'mutate',
      mutates: true,
      hostUiOnly: true,
      capabilities: ['motion', 'professional-editing'],
    });
  });
});
