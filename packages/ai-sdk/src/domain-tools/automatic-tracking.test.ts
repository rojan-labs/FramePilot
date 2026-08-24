import { describe, expect, it } from 'vitest';
import { applyPatch, invertPatch, validatePatch } from '@framepilot/editor-core';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import {
  AUTOMATIC_TRACKING_TOOL_NAME,
  AutomaticTrackingMeasurementSchema,
  PROFESSIONAL_AUTOMATIC_TRACKING_TOOL,
  automaticTrackingOpsFromMeasurement,
  type AutomaticTrackingMeasurement,
} from './automatic-tracking.js';
import { toolContract } from '../tool-contract.js';

function projectWithMask(): Project {
  const mask = {
    id: 'shot__mask',
    type: 'mask',
    params: {
      shape: 'rectangle',
      bounds: { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
    },
    keyframes: [],
  };
  return parseProject({
    id: 'auto_tracking_project',
    name: 'Automatic tracking fixture',
    version: 1,
    fps: 24,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset', path: 'shot.mp4', kind: 'video', durationSeconds: 900 }],
    timeline: {
      revision: 7,
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
              effects: [mask],
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

/** A confident subject drifting slowly right — passes every conversion gate. */
function measurement(overrides: Partial<AutomaticTrackingMeasurement> = {}): AutomaticTrackingMeasurement {
  const samples = Array.from({ length: 12 }, (_, index) => ({
    frame: index * 8,
    box: { x: 0.2 + index * 0.01, y: 0.1, width: 0.25, height: 0.4 },
    confidence: 0.9,
    occluded: false,
  }));
  return {
    objective: { intent: 'track_subject_automatically', target: 'this', subject: 'region' },
    plan: {
      clipId: 'shot',
      maskEffectId: 'shot__mask',
      capability: 'tracking.region',
      fps: 24,
      startSeconds: 0,
    },
    samples,
    engine: 'framepilot.tracking-lite@1.0.0-dev.local',
    backend: 'opencv',
    ...overrides,
  } as AutomaticTrackingMeasurement;
}

describe('track_subject_automatically tool', () => {
  it('is registered as a host-only analysis tool that runs fresh every call', () => {
    expect(PROFESSIONAL_AUTOMATIC_TRACKING_TOOL.name).toBe(AUTOMATIC_TRACKING_TOOL_NAME);
    const contract = toolContract(PROFESSIONAL_AUTOMATIC_TRACKING_TOOL);
    expect(contract.executionPlane).toBe('host');
    expect(contract.effectClass).toBe('mutation');
    expect(contract.cacheScope).toBe('none');
    expect(contract.concurrency).toBe('serial');
    expect(PROFESSIONAL_AUTOMATIC_TRACKING_TOOL.hostUiOnly).toBe(true);
  });

  it('compiles a measured region track into a validated, exactly invertible op', () => {
    const project = projectWithMask();
    const ops = automaticTrackingOpsFromMeasurement(measurement(), { project });
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.type).toBe('track_object');
    if (op.type !== 'track_object') return;
    expect(op.clipId).toBe('shot');
    // A region follow steers the whole box.
    expect(op.target).toBe('bounding_box');
    // The measuring pack is recorded as provenance on the operation itself.
    expect(op.engine).toBe('framepilot.tracking-lite@1.0.0-dev.local');
    expect(op.keyframes?.length ?? 0).toBeGreaterThan(1);

    const patch = {
      patchId: 'test__tracking' as `${string}__${string}`,
      createdBy: 'agent' as const,
      reason: 'test',
      operations: [...ops],
    };
    const validation = validatePatch(project.timeline, patch, {
      assetIds: ['asset'],
    });
    expect(validation.valid).toBe(true);
    const edited = applyPatch(project.timeline, patch);
    const restored = applyPatch(edited, invertPatch(project.timeline, patch));
    expect(JSON.stringify({ ...restored, revision: 0 })).toBe(
      JSON.stringify({ ...project.timeline, revision: 0 }),
    );
  });

  it('steers the mask centre for a point follow', () => {
    const ops = automaticTrackingOpsFromMeasurement(
      measurement({
        objective: { intent: 'track_subject_automatically', target: 'this', subject: 'point' },
        plan: {
          clipId: 'shot',
          maskEffectId: 'shot__mask',
          capability: 'tracking.point',
          fps: 24,
          startSeconds: 0,
        },
      }),
      { project: projectWithMask() },
    );
    if (ops[0]?.type !== 'track_object') throw new Error('expected a track_object op');
    expect(ops[0].target).toBe('object');
  });

  it('reports an unusable track as refused instead of inventing an edit', () => {
    const unusable = measurement({
      samples: [
        {
          frame: 0,
          box: { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
          confidence: 0.05,
          occluded: true,
        },
      ],
    });
    expect(AutomaticTrackingMeasurementSchema.safeParse(unusable).success).toBe(true);
    expect(() =>
      automaticTrackingOpsFromMeasurement(unusable, { project: projectWithMask() }),
    ).toThrow(/unusable_track/);
  });

  it('refuses when the tracked mask is gone from the working project', () => {
    const bare = projectWithMask();
    const clip = bare.timeline.tracks[0]!.clips[0]!;
    bare.timeline.tracks[0]!.clips[0] = { ...clip, effects: [] };
    expect(() =>
      automaticTrackingOpsFromMeasurement(measurement(), { project: bare }),
    ).toThrow(/missing_mask|stale_timeline/);
  });
});
