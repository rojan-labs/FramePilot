import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { runMaskTrackJob } from './mask-track-service.js';
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
});
