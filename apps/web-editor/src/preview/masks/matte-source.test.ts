/**
 * BR5.1 / BR5.2: the preview looks matte frames up as the export does (by the picture's source
 * frame, never the nearest one), refuses what the export refuses, and reads review flags from a
 * digest-verified `report.json`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MaskLayerSchema } from '@framepilot/timeline-schema';

import {
  MatteSource,
  flaggedFromReport,
  matteFrameAligned,
  parseMatteFrames,
  type MatteFrameCache,
} from './matte-source';
import type { MatteMask } from './mask-stack';
import type { MatteFrameData } from './matte-edges';
import { isFlaggedFrame } from './mask-view';

const encoder = new TextEncoder();
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const FRAMES = {
  version: 1,
  timeBase: [1, 15360],
  originPts: 0,
  firstFrame: 10,
  pts: [5120, 5632, 6144, 6656],
};

function artifactFiles(extra: Record<string, unknown> = {}): {
  mask: MatteMask;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>([
    ['frames.json', encoder.encode(JSON.stringify(FRAMES))],
    [
      'report.json',
      encoder.encode(
        JSON.stringify({
          version: 1,
          frames: [
            { pts: 5120, verified: true, checks: [] },
            { pts: 5632, verified: false, checks: ['edge'] },
            { pts: 6144, verified: false, checks: ['edge'] },
            { pts: 6656, verified: true, checks: [] },
          ],
        }),
      ),
    ],
  ]);
  const mask = MaskLayerSchema.parse({
    id: 'm',
    kind: 'matte',
    artifact: {
      key: 'a'.repeat(64),
      files: [
        { name: 'matte.mkv', sha256: 'e'.repeat(64) },
        { name: 'frames.json', sha256: sha(files.get('frames.json')!) },
        { name: 'report.json', sha256: sha(files.get('report.json')!) },
      ],
      width: 8,
      height: 4,
      coverage: { sourceStart: 0, sourceEnd: 1 },
      packId: 'p',
      packVersion: '1',
      modelDigests: [],
    },
    decontaminate: false,
    ...extra,
  }) as MatteMask;
  return { mask, files };
}

function harness(files: Map<string, Uint8Array>, info = { width: 8, height: 4 }) {
  const store = new Map<string, MatteFrameData>();
  const cache: MatteFrameCache = {
    get: (key) => store.get(key),
    put: (key, frame) => store.set(key, frame),
  };
  const client = {
    loadMatte: vi.fn(async () => ({
      type: 'matteLoaded' as const,
      requestId: 0,
      sourceId: '',
      ...info,
      format: 'gray8' as const,
      frameCount: FRAMES.pts.length,
      intraOnly: true,
    })),
    decodeMatte: vi.fn(async (_id: string, frame: number) => ({
      type: 'matteFrame' as const,
      requestId: 0,
      sourceId: '',
      frame,
      width: 8,
      height: 4,
      format: 'gray8' as const,
      data: new Uint8Array(32).fill(frame).buffer,
    })),
    unloadSource: vi.fn(async () => undefined),
  };
  const source = new MatteSource(
    client,
    () => (key, name) => `mem://${key}/${name}`,
    cache,
    async (url) => files.get(url.split('/').pop()!) ?? null,
  );
  return { source, client };
}

describe('frames.json', () => {
  it('parses a valid document and refuses malformed ones', () => {
    expect(parseMatteFrames(FRAMES).firstFrame).toBe(10);
    expect(() => parseMatteFrames({ ...FRAMES, version: 2 })).toThrow();
    expect(() => parseMatteFrames({ ...FRAMES, pts: [3, 3] })).toThrow();
    expect(() => parseMatteFrames({ ...FRAMES, timeBase: [0, 1] })).toThrow();
  });

  it('aligns a matte frame only with its own picture time', () => {
    const frames = parseMatteFrames(FRAMES);
    expect(matteFrameAligned(frames, 1, 5632 / 15360)).toBe(true);
    expect(matteFrameAligned(frames, 1, 6144 / 15360)).toBe(false);
  });
});

describe('MatteSource', () => {
  it('reads a frame by source frame, and a frame outside the artifact is unprocessed', async () => {
    const { mask, files } = artifactFiles();
    const { source, client } = harness(files);
    expect(source.lookup(mask, 11, null).state).toBe('pending');
    await source.ensure([{ mask, sourceFrame: 11 }]);
    const ready = source.lookup(mask, 11, 5632 / 15360);
    expect(ready.state).toBe('ready');
    expect(ready.state === 'ready' && ready.frame.alpha[0]).toBe(1);
    expect(client.decodeMatte).toHaveBeenCalledWith(`matte:${'a'.repeat(64)}:matte`, 1);
    expect(source.lookup(mask, 9, null).state).toBe('unprocessed');
    expect(source.lookup(mask, 14, null).state).toBe('unprocessed');
  });

  it('refuses a misaligned frame, a digest mismatch and a size mismatch with the export remedy', async () => {
    const { mask, files } = artifactFiles();
    const aligned = harness(files);
    await aligned.source.ensure([{ mask, sourceFrame: 11 }]);
    expect(aligned.source.lookup(mask, 11, 0.9)).toMatchObject({
      state: 'refused',
      code: 'matte_frame_misaligned',
    });

    const tampered = new Map(files);
    tampered.set('frames.json', encoder.encode(JSON.stringify({ ...FRAMES, firstFrame: 11 })));
    const digest = harness(tampered);
    await digest.source.ensure([{ mask, sourceFrame: 11 }]);
    expect(digest.source.lookup(mask, 11, null)).toMatchObject({ code: 'matte_digest_mismatch' });

    const resized = harness(files, { width: 16, height: 4 });
    await resized.source.ensure([{ mask, sourceFrame: 11 }]);
    expect(resized.source.lookup(mask, 11, null)).toMatchObject({ code: 'matte_size_mismatch' });
  });

  it('reads flagged ranges from a digest-verified report', async () => {
    const { mask, files } = artifactFiles();
    const { source } = harness(files);
    const ranges = await source.flaggedRanges(mask);
    expect(ranges).toEqual([{ first: 1, last: 2 }]);
    expect(isFlaggedFrame(ranges!, 2)).toBe(true);
    expect(isFlaggedFrame(ranges!, 3)).toBe(false);

    const tampered = new Map(files);
    tampered.set('report.json', encoder.encode('{"version":1,"frames":[]}'));
    expect(await harness(tampered).source.flaggedRanges(mask)).toBeNull();
  });

  it('merges adjacent flagged frames from a report', () => {
    const frames = parseMatteFrames(FRAMES);
    expect(
      flaggedFromReport(
        {
          version: 1,
          frames: [
            { pts: 6656, checks: ['x'] },
            { pts: 5120, verified: false },
          ],
        },
        frames,
      ),
    ).toEqual([
      { first: 0, last: 0 },
      { first: 3, last: 3 },
    ]);
  });
});
