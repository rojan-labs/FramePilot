/**
 * BR5.1 / BR5.2: the preview looks matte frames up as the export does (by the picture's source
 * frame, never the nearest one), refuses what the export refuses, and reads review flags from a
 * digest-verified `report.json`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MaskLayerSchema } from '@framepilot/timeline-schema';

import { MatteDecodeCancelled } from '../decode/matte-decode-pool';
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
    expect(client.decodeMatte).toHaveBeenCalledWith(
      `matte:${'a'.repeat(64)}:matte`,
      1,
      expect.any(Function),
    );
    expect(source.lookup(mask, 9, null).state).toBe('unprocessed');
    expect(source.lookup(mask, 14, null).state).toBe('unprocessed');
  });

  it('ranks wanted frames nearest first, and a dropped request is not a failed frame', async () => {
    const { mask, files } = artifactFiles();
    const { source, client } = harness(files);
    await source.ensure([{ mask, sourceFrame: 10 }]);
    source.want([
      { mask, sourceFrame: 12 },
      { mask, sourceFrame: 11 },
    ]);
    const ranks: (number | null)[] = [];
    let lastRank: () => number | null = () => 0;
    const decode = client.decodeMatte as unknown as ReturnType<typeof vi.fn>;
    decode.mockImplementation(async (_id: string, frame: number, rank: () => number | null) => {
      lastRank = rank;
      ranks.push(rank());
      // The playhead moved on before a worker was free: the pool drops the request.
      if (frame === 3) throw new MatteDecodeCancelled();
      return {
        type: 'matteFrame' as const,
        requestId: 0,
        sourceId: '',
        frame,
        width: 8,
        height: 4,
        format: 'gray8' as const,
        data: new Uint8Array(32).fill(frame).buffer,
      };
    });
    await source.ensure([{ mask, sourceFrame: 12 }]);
    await source.ensure([{ mask, sourceFrame: 11 }]);
    expect(ranks).toEqual([0, 1]);
    // Asked for outside the wanted set: ranked after it, never refused.
    await source.ensure([{ mask, sourceFrame: 13 }]);
    expect(ranks[2]).toBe(2);
    expect(source.lookup(mask, 13, null).state).toBe('pending');
    // A later `want` without it: waiting requests for it would be dropped.
    source.want([{ mask, sourceFrame: 11 }]);
    expect(lastRank()).toBeNull();
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

describe('the monitor tier (PX5.3)', () => {
  /** The decontaminating mask, pinning a foreground too, and a tier made from its masters. */
  function tiered(changes: Record<string, unknown> = {}) {
    const { mask: base, files } = artifactFiles();
    const mask = {
      ...base,
      decontaminate: true,
      artifact: {
        ...base.artifact,
        files: [...base.artifact.files, { name: 'foreground.mkv', sha256: 'f'.repeat(64) }],
      },
    } as MatteMask;
    const pinned = (name: string) => mask.artifact.files.find((file) => file.name === name)!.sha256;
    const tier = {
      version: 1,
      kind: 'framepilot.matte-monitor-tier',
      width: 4,
      height: 2,
      frameCount: FRAMES.pts.length,
      planes: {
        file: 'planes.mkv',
        bytes: 1,
        order: ['weight', 'r', 'g', 'b'],
        weightScale: 65535,
        colourScale: 257,
        layout: 'u16-hi-lo-bytes',
      },
      resample: 'swscale-bicubic-b0-c0.6-float64',
      source: {
        width: 8,
        height: 4,
        files: {
          'matte.mkv': pinned('matte.mkv'),
          'foreground.mkv': pinned('foreground.mkv'),
          'frames.json': pinned('frames.json'),
        },
      },
      ...changes,
    };
    files.set('tier.json', encoder.encode(JSON.stringify(tier)));
    const store = new Map<string, MatteFrameData>();
    const decoded: string[] = [];
    const client = {
      loadMatte: vi.fn(async (sourceId: string) => ({
        type: 'matteLoaded' as const,
        requestId: 0,
        sourceId,
        ...(sourceId.endsWith(':planes')
          ? { width: 4, height: 16, format: 'gray8' as const }
          : sourceId.endsWith(':foreground')
            ? { width: 8, height: 4, format: 'rgb24' as const }
            : { width: 8, height: 4, format: 'gray8' as const }),
        frameCount: FRAMES.pts.length,
        intraOnly: true,
      })),
      decodeMatte: vi.fn(async (sourceId: string, frame: number) => {
        decoded.push(`${sourceId.split(':').pop()}@${frame}`);
        const planes = sourceId.endsWith(':planes');
        const foreground = sourceId.endsWith(':foreground');
        return {
          type: 'matteFrame' as const,
          requestId: 0,
          sourceId,
          frame,
          width: planes ? 4 : 8,
          height: planes ? 16 : 4,
          format: foreground ? ('rgb24' as const) : ('gray8' as const),
          data: new Uint8Array(96).fill(frame).buffer,
        };
      }),
      unloadSource: vi.fn(async () => undefined),
    };
    const source = new MatteSource(
      client,
      () => (key, name) => `mem://${key}/${name}`,
      { get: (key) => store.get(key), put: (key, frame) => store.set(key, frame) },
      async (url) => files.get(url.split('/').pop()!) ?? null,
      { locateTier: () => (key, name) => `tier://${key}/${name}` },
    );
    return { mask, source, decoded };
  }

  /** Let the tier's manifest and index load. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('decontaminates from the tier where the picture was decoded at its size', async () => {
    const { mask, source, decoded } = tiered();
    await source.ensure([{ mask, sourceFrame: 10 }]);
    // The first ask of a clip knows no decode size yet: the foreground master, as before.
    expect(decoded).toEqual(['matte@0', 'foreground@0']);
    expect(source.lookup(mask, 11, null, { width: 4, height: 2 }).state).toBe('pending');
    await settle();
    await source.ensure([{ mask, sourceFrame: 11 }]);
    expect(decoded.slice(2)).toEqual(['matte@1', 'planes@1']);
    const ready = source.lookup(mask, 11, null, { width: 4, height: 2 });
    expect(ready.state === 'ready' && ready.frame.planes?.width).toBe(4);
    expect(ready.state === 'ready' && ready.frame.foreground).toBeNull();
    expect(source.debugState(mask).tier).toBe('4x2');
  });

  it('decodes the foreground master for a picture decoded at another size', async () => {
    const { mask, source, decoded } = tiered();
    expect(source.lookup(mask, 10, null, { width: 4, height: 2 }).state).toBe('pending');
    await source.ensure([{ mask, sourceFrame: 10 }]);
    await settle();
    await source.ensure([{ mask, sourceFrame: 11 }]);
    expect(decoded).toContain('planes@1');
    expect(decoded).not.toContain('foreground@1');
    // The same clip decoded larger (say, shown bigger): the tier does not fit it.
    expect(source.lookup(mask, 11, null, { width: 8, height: 4 }).state).toBe('pending');
    await source.ensure([{ mask, sourceFrame: 11 }]);
    expect(decoded).toContain('foreground@1');
    const ready = source.lookup(mask, 11, null, { width: 8, height: 4 });
    expect(ready.state === 'ready' && ready.frame.foreground).not.toBeNull();
  });

  it.each([
    ['other masters', { source: { width: 8, height: 4, files: {} } }],
    ['another frame count', { frameCount: 3 }],
    ['another quantisation', { planes: { file: 'planes.mkv', weightScale: 255 } }],
  ])('ignores a tier made from %s and decodes the masters', async (_name, changes) => {
    const { mask, source, decoded } = tiered(changes);
    source.lookup(mask, 10, null, { width: 4, height: 2 });
    await settle();
    await source.ensure([{ mask, sourceFrame: 11 }]);
    expect(source.debugState(mask).tier).toBeNull();
    expect(decoded).not.toContain('planes@1');
    expect(decoded).toContain('foreground@1');
  });
});
