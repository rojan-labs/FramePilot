import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPatch,
  compileMaskCommand,
  maskGeometryAt,
  trackStateAt,
  trackTransformAt,
  trackWarpPoint,
  type MaskCommand,
} from '@framepilot/editor-core';
import { masksOf, parseProject, type Project } from '@framepilot/timeline-schema';
import { runMaskTrackJob } from './mask-track-service.js';
import { readTrackArtifact } from './track-job.js';
import type { CapabilityPackTrackingService } from './tracking.js';
import type { MaskTrackIntent } from './track-run.js';

const FPS = 24;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fp-mask-track-'));
  dirs.push(dir);
  return dir;
}

function project(dir: string, masks: unknown[]): Project {
  return parseProject({
    id: 'track_service',
    name: 'Track service',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [
      {
        id: 'asset',
        path: path.join(dir, 'shot.mp4'),
        kind: 'video',
        durationSeconds: 10,
        media: { width: 1920, height: 1080, fps: FPS },
      },
    ],
    timeline: {
      revision: 4,
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
              end: 2,
              sourceStart: 0,
              sourceEnd: 2,
              effects: [],
              masks,
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

const ELLIPSE = { kind: 'ellipse', id: 'm1', cx: 900, cy: 400, rx: 120, ry: 160 };

const intent = (over: Partial<MaskTrackIntent> = {}): MaskTrackIntent => ({
  requestId: 'job-1',
  clipId: 'shot',
  maskId: 'm1',
  method: 'position',
  direction: 'forward',
  referenceSourceTime: 0,
  ...over,
});

type Run = CapabilityPackTrackingService['run'];
const service = (run: Run): (() => Promise<CapabilityPackTrackingService>) => {
  return async () => ({ run }) as unknown as CapabilityPackTrackingService;
};

describe('runMaskTrackJob', () => {
  it('refuses a mask the project does not hold, before any worker runs', async () => {
    const dir = await projectDir();
    let ran = false;
    const result = await runMaskTrackJob({
      project: project(dir, []),
      projectDir: dir,
      intent: intent(),
      tracking: service(async () => {
        ran = true;
        throw new Error('unreachable');
      }),
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it('tracks a mask that exists only in the project it is handed (the agent’s working copy)', async () => {
    const dir = await projectDir();
    const progress: number[] = [];
    const result = await runMaskTrackJob({
      project: project(dir, [ELLIPSE]),
      projectDir: dir,
      intent: intent(),
      tracking: service(async (request, context) => {
        context.onProgress?.({
          requestId: request.requestId,
          phase: 'measuring',
          completed: 1,
          total: 2,
        } as never);
        const first = request.media.firstFrame;
        const count = request.media.lastFrameExclusive - first;
        return {
          status: 'completed',
          identity: {
            id: 'framepilot.tracking-lite',
            version: '1.2.0',
            releaseDigest: 'a'.repeat(64),
          },
          result: {
            backend: 'opencv',
            samples: Array.from({ length: count }, (_, index) => ({
              frame: first + index,
              box: { x: 0.4 + index * 0.001, y: 0.22, width: 0.125, height: 0.3 },
              confidence: 0.95,
              occluded: false,
              // A measured plane: a slow drift to the right, in normalized coordinates.
              transform: [1, 0, index * 0.001, 0, 1, 0, 0, 0, 1],
            })),
          },
        } as never;
      }),
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p.completed),
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.engine).toBe('framepilot.tracking-lite@1.2.0');
    expect(result.method).toBe('position');
    expect(result.frames).toBeGreaterThan(1);
    expect(result.artifact.key).toMatch(/^[0-9a-f]{64}$/);
    expect(result.projectRevision).toBe(4);
    expect(progress).toEqual([1]);
    // The artifact is on disk under the project, where the export reads it from.
    expect(await readdir(path.join(dir, '.framepilot-derived'))).toContain('tracks');
  });

  it('hands a missing pack back as the signed proposal, untouched', async () => {
    const dir = await projectDir();
    const proposal = { ok: true, proposal: { proposalId: 'p1', displayName: 'Tracking Lite' } };
    const result = await runMaskTrackJob({
      project: project(dir, [ELLIPSE]),
      projectDir: dir,
      intent: intent(),
      tracking: service(async () => ({ status: 'pack_missing', proposal }) as never),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ ok: false, code: 'pack_missing', proposal });
  });

  it('forwards a worker failure with the authority’s own retry verdict', async () => {
    const dir = await projectDir();
    const result = await runMaskTrackJob({
      project: project(dir, [ELLIPSE]),
      projectDir: dir,
      intent: intent(),
      tracking: service(
        async () =>
          ({
            status: 'failed',
            code: 'timed_out',
            detail: 'The worker timed out.',
            retryable: true,
          }) as never,
      ),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      ok: false,
      code: 'timed_out',
      error: 'The worker timed out.',
      retryable: true,
    });
  });

  it('turns a thrown worker error into a typed failure', async () => {
    const dir = await projectDir();
    const result = await runMaskTrackJob({
      project: project(dir, [ELLIPSE]),
      projectDir: dir,
      intent: intent(),
      tracking: service(async () => {
        throw new Error('spawn failed');
      }),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      ok: false,
      code: 'worker_failed',
      error: 'spawn failed',
      retryable: false,
    });
  });

  it('re-tracks from a correction: continues the pinned track, with the exclusion, and keeps the rest (MK7.7)', async () => {
    const dir = await projectDir();
    const identity = {
      id: 'framepilot.tracking-lite',
      version: '1.0.0',
      releaseDigest: 'a'.repeat(64),
    };
    // The first track: a steady drift, unsure on frames 10-19 (something passed in front).
    const first = await runMaskTrackJob({
      project: project(dir, [ELLIPSE]),
      projectDir: dir,
      intent: intent(),
      tracking: service(async (request) => {
        const from = request.media.firstFrame;
        const count = request.media.lastFrameExclusive - from;
        return {
          status: 'completed',
          identity,
          result: {
            backend: 'opencv',
            samples: Array.from({ length: count }, (_, index) => ({
              frame: from + index,
              box: { x: 0.4, y: 0.2, width: 0.1, height: 0.3 },
              confidence: from + index >= 10 && from + index < 20 ? 0.2 : 0.95,
              occluded: false,
              transform: [1, 0, index * 0.001, 0, 1, 0, 0, 0, 1],
            })),
          },
        } as never;
      }),
      signal: new AbortController().signal,
    });
    if (!first.ok) throw new Error(JSON.stringify(first));
    // Microsecond pts: the range is the frames' own instants, to the microsecond.
    expect(first.flagged).toHaveLength(1);
    expect(first.flagged[0]!.start).toBeCloseTo(10 / FPS, 6);
    expect(first.flagged[0]!.end).toBeCloseTo(20 / FPS, 6);
    let tracked = project(dir, [
      {
        ...ELLIPSE,
        tracking: {
          artifact: first.artifact,
          method: 'position',
          referenceSourceTime: 0,
          constraints: [],
          review: { flagged: first.flagged, approved: [], locked: [] },
        },
      },
    ]);
    const previous = await readTrackArtifact(dir, first.artifact);

    // The editor puts the mask where it belongs on frame 15, on screen, and boxes the occluder.
    const fixedAt = 15 / FPS;
    const onScreen = { kind: 'ellipse', cx: 1000, cy: 420, rx: 120, ry: 160, rotation: 0 };
    const compiled = compileMaskCommand({
      timeline: tracked.timeline,
      assets: tracked.assets ?? [],
      command: {
        type: 'correct_tracked_mask',
        timelineRevision: 4,
        clipId: 'shot',
        maskId: 'm1',
        sourceTime: fixedAt,
        geometry: onScreen,
        track: trackStateAt(previous, fixedAt),
      } as unknown as MaskCommand,
    });
    if (compiled.status !== 'compiled') throw new Error(compiled.detail);
    tracked = { ...tracked, timeline: applyPatch(tracked.timeline, compiled.patch) };

    const requests: { firstFrame: number; parameters: Record<string, unknown> }[] = [];
    const retracked = await runMaskTrackJob({
      project: tracked,
      projectDir: dir,
      intent: intent({
        referenceSourceTime: fixedAt,
        fromConstraints: true,
        exclusions: [{ x: 700, y: 200, width: 150, height: 400, sourceTime: fixedAt }],
      }),
      tracking: service(async (request) => {
        const from = request.media.firstFrame;
        const count = request.media.lastFrameExclusive - from;
        const parameters = request.parameters as Record<string, unknown>;
        requests.push({ firstFrame: from, parameters });
        const reverse = parameters['reverse'] === true;
        return {
          status: 'completed',
          identity,
          result: {
            backend: 'opencv',
            // Measured from the corrected frame: the plane keeps drifting right.
            samples: Array.from({ length: count }, (_, index) => {
              const steps = reverse ? index - (count - 1) : index;
              return {
                frame: from + index,
                box: { x: 0.4, y: 0.2, width: 0.1, height: 0.3 },
                confidence: 0.95,
                occluded: false,
                transform: [1, 0, steps * 0.001, 0, 1, 0, 0, 0, 1],
              };
            }),
          },
        } as never;
      }),
      signal: new AbortController().signal,
    });
    if (!retracked.ok) throw new Error(JSON.stringify(retracked));

    // One measurement each way from the constraint, over the flagged stretch only, each carrying
    // the box drawn on that frame.
    expect(requests.map((request) => request.firstFrame).sort((a, b) => a - b)).toEqual([10, 15]);
    for (const request of requests) {
      const [box] = request.parameters['exclusions'] as Record<string, number>[];
      expect(box!['x']).toBeCloseTo(700 / 1920, 12);
      expect(box!['y']).toBeCloseTo(200 / 1080, 12);
      expect(box!['width']).toBeCloseTo(150 / 1920, 12);
      expect(box!['height']).toBeCloseTo(400 / 1080, 12);
    }
    expect(retracked.flagged).toEqual([]);

    const after = await readTrackArtifact(dir, retracked.artifact);
    // Outside the stretch the pinned track is kept exactly.
    for (const frame of [0, 5, 9, 20, 30, 47]) {
      expect(trackTransformAt(after, frame / FPS)).toEqual(trackTransformAt(previous, frame / FPS));
    }
    // On the corrected frame, the track composed with the correction draws exactly what the
    // editor put on screen — through the same point warp both renderers use.
    const mask = masksOf(tracked.timeline.tracks[0]!.clips[0]!)[0]!;
    const own = maskGeometryAt(mask, fixedAt) as { cx: number; cy: number };
    const [x, y] = trackWarpPoint(trackTransformAt(after, fixedAt), own.cx, own.cy);
    expect(x).toBeCloseTo(1000, 9);
    expect(y).toBeCloseTo(420, 9);
    // And the stretch carries it by the motion measured from there: 0.001 of the frame a frame.
    const [later] = trackWarpPoint(trackTransformAt(after, 19 / FPS), own.cx, own.cy);
    expect(later).toBeCloseTo(1000 + 4 * 0.001 * 1920, 6);
  });
});
