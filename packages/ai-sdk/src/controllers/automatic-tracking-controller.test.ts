import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { captureEditorInteractionContext } from '../editor-context/interaction-context.js';
import {
  AutomaticTrackingObjectiveSchema,
  resolveAutomaticTrackingObjective,
  type AutomaticTrackingObjective,
} from './automatic-tracking-controller.js';

interface Options {
  readonly shape?: string;
  readonly bounds?: Record<string, number>;
  readonly withMask?: boolean;
  readonly sourceEnd?: number;
  readonly assetKind?: 'video' | 'audio';
}

function project(options: Options = {}): Project {
  const mask = {
    id: 'shot__mask',
    type: 'mask',
    params: {
      shape: options.shape ?? 'rectangle',
      bounds: options.bounds ?? { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
    },
    keyframes: [],
  };
  return parseProject({
    id: 'auto_tracking_project',
    name: 'Automatic tracking fixture',
    version: 1,
    fps: 24,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'asset', path: 'shot.mp4', kind: options.assetKind ?? 'video', durationSeconds: 900 },
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
              end: options.sourceEnd ?? 4,
              sourceStart: 0,
              sourceEnd: options.sourceEnd ?? 4,
              effects: options.withMask === false ? [] : [mask],
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

function resolve(
  base: Project,
  objective: Partial<AutomaticTrackingObjective> = {},
  selectedClipIds: string[] = ['shot'],
  playheadSeconds = 2,
) {
  return resolveAutomaticTrackingObjective({
    project: base,
    interaction: captureEditorInteractionContext({
      project: base,
      projectRevision: 9,
      playheadSeconds,
      selectedClipIds,
      primaryClipId: selectedClipIds.at(-1),
    }),
    objective: AutomaticTrackingObjectiveSchema.parse({
      intent: 'track_subject_automatically',
      ...objective,
    }),
  });
}

describe('resolveAutomaticTrackingObjective', () => {
  it('plans a region request from the mask the editor actually drew', () => {
    const result = resolve(project());

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.plan).toMatchObject({
      clipId: 'shot',
      maskEffectId: 'shot__mask',
      assetId: 'asset',
      capability: 'tracking.region',
      firstFrame: 0,
      lastFrameExclusive: 96,
      fps: 24,
    });
    expect(result.plan.parameters).toEqual({
      region: { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
    });
  });

  it('derives a point request from the mask centre', () => {
    const result = resolve(project(), { subject: 'point' });

    if (result.status !== 'resolved') throw new Error('expected resolution');
    expect(result.plan.capability).toBe('tracking.point');
    expect(result.plan.parameters).toEqual({ point: { x: 0.325, y: 0.30000000000000004 } });
  });

  it('derives a planar request from the mask corners in stable order', () => {
    const result = resolve(project(), { subject: 'plane' });

    if (result.status !== 'resolved') throw new Error('expected resolution');
    expect(result.plan.capability).toBe('tracking.planar');
    expect(result.plan.parameters).toEqual({
      corners: [
        { x: 0.2, y: 0.1 },
        { x: 0.45, y: 0.1 },
        { x: 0.45, y: 0.5 },
        { x: 0.2, y: 0.5 },
      ],
    });
  });

  it('tracks only the range the clip actually shows', () => {
    const base = project({ sourceEnd: 2 });

    const result = resolve(base);

    if (result.status !== 'resolved') throw new Error('expected resolution');
    expect(result.plan.lastFrameExclusive).toBe(48);
  });

  it('carries resolution evidence and countable facts', () => {
    const result = resolve(project());

    if (result.status !== 'resolved') throw new Error('expected resolution');
    expect(result.evidence).toHaveLength(1);
    expect(result.facts).toContainEqual({ name: 'capability', value: 'tracking.region' });
    expect(result.facts).toContainEqual({ name: 'trackedFrameCount', value: 96 });
  });

  it('refuses to invent a region when no mask exists', () => {
    const result = resolve(project({ withMask: false }));

    expect(result).toMatchObject({ status: 'rejected', code: 'mask_unresolved' });
    if (result.status !== 'rejected') return;
    expect(result.detail).toContain('Draw a rectangle or ellipse mask');
  });

  it('refuses a mask shape it cannot start a box tracker from', () => {
    expect(resolve(project({ shape: 'polygon' }))).toMatchObject({
      status: 'rejected',
      code: 'unsupported_mask_shape',
    });
  });

  it('refuses mask bounds that are not inside the frame', () => {
    expect(
      resolve(project({ bounds: { x: 0.8, y: 0.1, width: 0.5, height: 0.2 } })),
    ).toMatchObject({ status: 'rejected', code: 'missing_region' });
  });

  it('refuses a non-video clip', () => {
    expect(resolve(project({ assetKind: 'audio' }))).toMatchObject({
      status: 'rejected',
      code: 'unsupported_media',
    });
  });

  it('refuses a range longer than one tracking pass allows', () => {
    expect(resolve(project({ sourceEnd: 800 }))).toMatchObject({
      status: 'rejected',
      code: 'range_too_long',
    });
  });

  it('refuses an unresolved target rather than guessing which clip was meant', () => {
    // Ambiguity between several clips is the shared resolver's contract; what
    // matters here is that this controller never substitutes a guess for it.
    // Nothing selected and the playhead parked past every clip: there is no
    // referent, and the controller must say so instead of picking something.
    expect(resolve(project({ sourceEnd: 1 }), {}, [], 30)).toMatchObject({
      status: 'rejected',
      code: 'target_unresolved',
    });
  });

  it('rejects an objective the schema does not describe', () => {
    expect(() =>
      AutomaticTrackingObjectiveSchema.parse({
        intent: 'track_subject_automatically',
        subject: 'face',
      }),
    ).toThrow();
  });
});
