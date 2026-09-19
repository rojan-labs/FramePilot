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
  TrackArtifactReadError,
  measuredFrames,
  readTrackArtifact,
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

  it('sends the exclusion regions to the worker, normalized to the coded frame (MK7.7)', () => {
    const exclusions = [{ x: 20, y: 10, width: 40, height: 20 }];
    const planar = trackParameters(request({ exclusions }), false);
    const [box] = (planar.parameters as { exclusions: Record<string, number>[] }).exclusions;
    expect(box!['x']).toBeCloseTo(0.1, 12);
    expect(box!['y']).toBeCloseTo(0.1, 12);
    expect(box!['width']).toBeCloseTo(0.2, 12);
    expect(box!['height']).toBeCloseTo(0.2, 12);
    const shape = trackParameters(
      request({ method: 'point-cloud', vertices: [{ x: 40, y: 20 }], exclusions }),
      false,
    );
    expect(shape.parameters).toMatchObject({ exclusions: [{ x: 0.1, y: 0.1 }] });
    // Clipped to the frame; a box wholly outside it is not sent at all.
    const clipped = trackParameters(
      request({
        exclusions: [
          { x: 180, y: 90, width: 100, height: 100 },
          { x: 500, y: 500, width: 10, height: 10 },
        ],
      }),
      false,
    );
    const sent = (clipped.parameters as { exclusions: { x: number; width: number }[] }).exclusions;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.x + sent[0]!.width).toBeCloseTo(1, 12);
    expect(trackParameters(request(), false).parameters).not.toHaveProperty('exclusions');
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

  it('keeps every measured frame: exclusions are the worker’s, not a reason to drop one', () => {
    const frames = measuredFrames(
      [sample(0, [1, 0, 0, 0, 1, 0, 0, 0, 1]), sample(1, [1, 0, 0, 0, 1, 0, 0, 0, 1])],
      request({ exclusions: [{ x: 80, y: 40, width: 40, height: 20 }] }),
      (frame) => frame,
    );
    expect(frames).toHaveLength(2);
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

  it('writes a joined re-track exactly as built, without re-anchoring it', async () => {
    const directory = await project();
    // A re-track continued from a correction: nothing is the identity on the request's frame.
    const built = {
      version: 1,
      method: 'position' as const,
      timeBase: [1, 25] as const,
      originPts: 0,
      firstFrame: 10,
      pts: [10, 11],
      transforms: [...[1, 0, 3, 0, 1, 1, 0, 0, 1], ...[1, 0, 9, 0, 1, 1, 0, 0, 1]],
      confidence: [0.4, 0.95],
    };
    const outcome = await writeTrackArtifact({
      projectDir: directory,
      jobId: 'job-4',
      key,
      request: request(),
      frames: [],
      built: { artifact: built, residualPx: [0.2] },
      timeBase: [1, 25],
      originPts: 0,
    });
    expect(outcome).toMatchObject({ status: 'completed', worstResidualPx: 0.2 });
    const artifact = await readTrackArtifact(directory, {
      key,
      sha256: (outcome as { sha256: string }).sha256,
    });
    expect(artifact.transforms).toEqual(built.transforms);
    expect(artifact.confidence).toEqual(built.confidence);
  });

  it('reads a pinned track back only when its bytes are the ones pinned', async () => {
    const { directory, outcome } = await write();
    if (outcome.status !== 'completed') throw new Error('write failed');
    await expect(
      readTrackArtifact(directory, { key, sha256: outcome.sha256 }),
    ).resolves.toMatchObject({ method: 'position' });
    await expect(readTrackArtifact(directory, { key, sha256: 'c'.repeat(64) })).rejects.toThrow(
      /Track the mask again/,
    );
    await expect(
      readTrackArtifact(directory, { key: '../escape', sha256: outcome.sha256 }),
    ).rejects.toBeInstanceOf(TrackArtifactReadError);
    await expect(
      readTrackArtifact(directory, { key: 'd'.repeat(64), sha256: outcome.sha256 }),
    ).rejects.toBeInstanceOf(TrackArtifactReadError);
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
