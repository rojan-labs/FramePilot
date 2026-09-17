/**
 * MK7.2: the four methods, the five directions, and the one write a track job makes.
 *
 * The parts that decide what a track MEANS are asserted here — which range each direction runs
 * and which way, which capability and geometry each method asks for, what happens to a sample a
 * pack could not measure a plane for, and that the committed file is the one the export's own
 * parser accepted. The measurement itself is the worker's, and is proved against pixels in the
 * pack's `decoded_media` suite.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTrackArtifact, trackTransformAt, trackWarpPoint } from '@framepilot/editor-core';

import {
  TRACK_FILE,
  measuredFrames,
  trackCacheKey,
  trackParameters,
  trackRanges,
  validateTrackJob,
  writeTrackArtifact,
  type TrackJobRequest,
  type TrackingSamples,
} from './track-job.js';

const GEOMETRY = { codedWidth: 200, codedHeight: 100 };
const BOUNDS = { x: 40, y: 20, width: 80, height: 40 };

function request(overrides: Partial<TrackJobRequest> = {}): TrackJobRequest {
  return {
    jobId: 'job-1',
    clipId: 'c1',
    maskId: 'm1',
    assetId: 'a1',
    method: 'position',
    direction: 'forward',
    referenceFrame: 10,
    firstFrame: 0,
    lastFrameExclusive: 30,
    fps: 25,
    bounds: BOUNDS,
    geometry: GEOMETRY,
    ...overrides,
  };
}

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fp-track-'));
  directories.push(directory);
  return directory;
}

// --- directions ------------------------------------------------------------

describe('directions', () => {
  it('runs forward from the reference frame to the clip edge', () => {
    expect(trackRanges(request())).toEqual([
      { firstFrame: 10, lastFrameExclusive: 30, reverse: false },
    ]);
  });

  it('runs backward as a REVERSE range ending on the reference frame', () => {
    // The features are detected on the frame the mask was drawn on, so that frame has to be
    // decoded first — which is what `reverse` means.
    expect(trackRanges(request({ direction: 'backward' }))).toEqual([
      { firstFrame: 0, lastFrameExclusive: 11, reverse: true },
    ]);
  });

  it('runs one frame as a two-frame forward range', () => {
    expect(trackRanges(request({ direction: 'one-frame' }))).toEqual([
      { firstFrame: 10, lastFrameExclusive: 12, reverse: false },
    ]);
  });

  it('runs both ways as two measurements sharing the reference frame', () => {
    const ranges = trackRanges(request({ direction: 'both' }));
    expect(ranges).toHaveLength(2);
    expect(ranges.every((range) => range.firstFrame <= 10 && range.lastFrameExclusive > 10)).toBe(
      true,
    );
  });

  it('has nothing to measure backwards from the clip’s first frame', () => {
    expect(trackRanges(request({ direction: 'backward', referenceFrame: 0 }))).toEqual([]);
  });

  it('refuses a reference frame outside the clip', () => {
    expect(() => trackRanges(request({ referenceFrame: 99 }))).toThrow(RangeError);
  });
});

// --- methods ---------------------------------------------------------------

describe('methods', () => {
  it.each(['position', 'position-scale-rotation', 'perspective'] as const)(
    '%s measures a plane',
    (method) => {
      const built = trackParameters(request({ method }), false);
      expect(built.capability).toBe('tracking.planar');
      const parameters = built.parameters as { corners: { x: number; y: number }[] };
      expect(parameters.corners).toHaveLength(4);
      // The mask's bounding box, normalized to the CODED frame the worker decodes.
      expect(parameters.corners[0]).toEqual({ x: 0.2, y: 0.2 });
      expect(parameters.corners[2]).toEqual({ x: 0.6, y: 0.6 });
    },
  );

  it('a shape track follows the path’s vertices in one request', () => {
    const vertices = [
      { x: 40, y: 20 },
      { x: 120, y: 20 },
      { x: 120, y: 60 },
    ];
    const built = trackParameters(request({ method: 'point-cloud', vertices }), true);
    expect(built.capability).toBe('tracking.point');
    const parameters = built.parameters as {
      points: { x: number; y: number }[];
      reverse: boolean;
      point: { x: number; y: number };
    };
    expect(parameters.points).toHaveLength(3);
    expect(parameters.reverse).toBe(true);
    // The primary point is the mask's centre, so the request is a valid point track too.
    expect(parameters.point).toEqual({ x: 0.4, y: 0.4 });
  });

  it('converts geometry through the display correction on rotated anamorphic media', () => {
    const geometry = {
      codedWidth: 100,
      codedHeight: 200,
      pixelAspectRatio: 2,
      rotationDegrees: 90,
    };
    // Display size is 200 x 200 for this source; a display point maps back into coded space.
    const built = trackParameters(
      request({ geometry, bounds: { x: 0, y: 0, width: 200, height: 200 } }),
      false,
    );
    const parameters = built.parameters as { corners: { x: number; y: number }[] };
    for (const corner of parameters.corners) {
      expect(corner.x).toBeGreaterThanOrEqual(0);
      expect(corner.x).toBeLessThanOrEqual(1);
      expect(corner.y).toBeGreaterThanOrEqual(0);
      expect(corner.y).toBeLessThanOrEqual(1);
    }
  });

  it('refuses a shape track with no path and one with too many vertices', () => {
    expect(validateTrackJob(request({ method: 'point-cloud' }))).toMatch(/path/);
    expect(
      validateTrackJob(
        request({
          method: 'point-cloud',
          vertices: new Array(600).fill({ x: 1, y: 1 }),
        }),
      ),
    ).toMatch(/Simplify the path/);
  });

  it('refuses a mask with no area', () => {
    expect(validateTrackJob(request({ bounds: { x: 0, y: 0, width: 0, height: 5 } }))).toMatch(
      /no area/,
    );
  });
});

// --- samples ---------------------------------------------------------------

function sample(frame: number, transform?: readonly number[]): TrackingSamples[number] {
  return {
    frame,
    box: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 },
    confidence: 1,
    occluded: false,
    ...(transform === undefined ? {} : { transform: [...transform] }),
  } as TrackingSamples[number];
}

describe('samples become measured frames', () => {
  it('leaves out a frame whose plane the pack never measured', () => {
    const frames = measuredFrames(
      [sample(0, [1, 0, 0, 0, 1, 0, 0, 0, 1]), sample(1)],
      request(),
      (frame) => frame,
    );
    expect(frames.map((frame) => frame.frame)).toEqual([0]);
  });

  it('converts a normalized translation into display pixels', () => {
    const frames = measuredFrames(
      [sample(0, [1, 0, 0.25, 0, 1, 0.5, 0, 0, 1])],
      request(),
      (frame) => frame,
    );
    expect(trackWarpPoint(frames[0]!.homography, 0, 0)).toEqual([50, 50]);
  });

  it('drops a frame whose measured centre sits inside an exclusion region', () => {
    const frames = measuredFrames(
      [sample(0, [1, 0, 0, 0, 1, 0, 0, 0, 1]), sample(1, [1, 0, 0, 0, 1, 0, 0, 0, 1])],
      request({ exclusions: [{ x: 80, y: 40, width: 40, height: 20 }] }),
      (frame) => frame,
    );
    expect(frames).toHaveLength(0);
  });

  it('a shape track needs no transform from the worker', () => {
    const frames = measuredFrames(
      [{ ...sample(0), points: [{ x: 0.5, y: 0.5 }] } as TrackingSamples[number]],
      request({ method: 'point-cloud' }),
      (frame) => frame,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]!.points).toEqual([{ x: 100, y: 50 }]);
  });
});

// --- the write -------------------------------------------------------------

describe('writing the artifact', () => {
  const key = 'a'.repeat(64);

  async function write(overrides: Partial<TrackJobRequest> = {}) {
    const directory = await project();
    const outcome = await writeTrackArtifact({
      projectDir: directory,
      jobId: 'job-1',
      key,
      request: request(overrides),
      frames: [
        { frame: 10, pts: 10, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1], confidence: 1 },
        { frame: 11, pts: 11, homography: [1, 0, 6, 0, 1, 0, 0, 0, 1], confidence: 0.9 },
      ],
      timeBase: [1, 25],
      originPts: 0,
    });
    return { directory, outcome };
  }

  it('commits a file the export’s own parser accepts, under the pinned digest', async () => {
    const { directory, outcome } = await write();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    const file = path.join(directory, '.framepilot-derived', 'tracks', key, TRACK_FILE);
    const bytes = await readFile(file);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(outcome.sha256);
    const artifact = parseTrackArtifact(JSON.parse(bytes.toString('utf-8')));
    expect(artifact.method).toBe('position');
    // The identity sits on the reference frame, whatever the worker anchored to.
    expect(trackTransformAt(artifact, 10 / 25)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('leaves nothing behind when the measurement cannot be anchored', async () => {
    const directory = await project();
    const outcome = await writeTrackArtifact({
      projectDir: directory,
      jobId: 'job-2',
      key,
      request: request({ referenceFrame: 12 }),
      frames: [{ frame: 10, pts: 10, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1], confidence: 1 }],
      timeBase: [1, 25],
      originPts: 0,
    });
    expect(outcome).toMatchObject({ status: 'failed', code: 'measurement_failed' });
    await expect(
      readFile(path.join(directory, '.framepilot-derived', 'tracks', key, TRACK_FILE)),
    ).rejects.toThrow();
  });

  it('refuses to write through a link planted where the store belongs', async () => {
    const directory = await project();
    const derived = path.join(directory, '.framepilot-derived');
    await writeFile(derived, 'not a directory');
    await expect(
      writeTrackArtifact({
        projectDir: directory,
        jobId: 'job-3',
        key,
        request: request(),
        frames: [{ frame: 10, pts: 10, homography: [1, 0, 0, 0, 1, 0, 0, 0, 1], confidence: 1 }],
        timeBase: [1, 25],
        originPts: 0,
      }),
    ).rejects.toMatchObject({ code: 'unsafe_path' });
  });
});

// --- the key ---------------------------------------------------------------

describe('the cache key', () => {
  const parts = {
    fingerprint: 'sha-of-the-media',
    method: 'position' as const,
    direction: 'forward' as const,
    referenceFrame: 10,
    firstFrame: 0,
    lastFrameExclusive: 30,
    bounds: BOUNDS,
    packId: 'framepilot.tracking-lite',
    packVersion: '1.0.0',
    releaseDigest: 'b'.repeat(64),
  };

  it('is stable for the same request', () => {
    expect(trackCacheKey(parts)).toBe(trackCacheKey(parts));
  });

  it.each([
    ['the method', { method: 'perspective' as const }],
    ['the direction', { direction: 'backward' as const }],
    ['the reference frame', { referenceFrame: 11 }],
    ['the geometry', { bounds: { ...BOUNDS, x: 41 } }],
    ['the pack', { packVersion: '1.1.0' }],
    ['an exclusion region', { exclusions: [{ x: 0, y: 0, width: 1, height: 1 }] }],
  ])('changes with %s', (_name, override) => {
    expect(trackCacheKey({ ...parts, ...override })).not.toBe(trackCacheKey(parts));
  });
});
