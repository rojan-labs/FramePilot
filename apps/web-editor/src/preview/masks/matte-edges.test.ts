/**
 * BR5.1: a clip's matte layers evaluate to the same float64 alpha, and decontaminate to the same
 * bytes, as the export (`tests/fixtures/mask-raster/matte-clips.json`, `pnpm mask-raster:vectors`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClipSchema } from '@framepilot/timeline-schema';

import {
  TIER_COLOUR_SCALE,
  TIER_WEIGHT_SCALE,
  applyFinesse,
  decontaminate,
  decontaminateFromPlanes,
  finesseIsIdentity,
  resample,
  type CropFractions,
  type MaskFinesseValues,
  type MatteFrameData,
  type MattePlanes,
} from './matte-edges';
import {
  clipMaskStack,
  stackAlphaAt,
  type MaskStackTarget,
  type MatteStackInputs,
} from './mask-stack';

const REPO = path.resolve(__dirname, '../../../../..');

interface MatteCase {
  id: string;
  clip: unknown;
  media: { width: number; height: number };
  maximum: number;
  matte: string;
  foreground: string;
  effects?: string[];
  expected: ({
    decoded: [number, number];
    width: number;
    height: number;
    time: number;
    alpha: string | null;
    decontaminated: string;
  } & Record<string, unknown>)[];
}

const document = JSON.parse(
  readFileSync(path.join(REPO, 'tests', 'fixtures', 'mask-raster', 'matte-clips.json'), 'utf8'),
) as { cases: MatteCase[] };

const bytes = (base64: string): Uint8Array => new Uint8Array(Buffer.from(base64, 'base64'));

const digest = (data: ArrayBufferView | null): string | null =>
  data === null
    ? null
    : createHash('sha256')
        .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        .digest('hex');

/** `matte_picture(width, height)` of the vector generator. */
function picture(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      out[i] = (x * 13 + y * 7) & 255;
      out[i + 1] = (x * 5 + y * 3 + 40) & 255;
      out[i + 2] = (x ^ y) & 255;
    }
  }
  return out;
}

function frameOf(vector: MatteCase): MatteFrameData {
  const raw = bytes(vector.matte);
  const alpha =
    vector.maximum > 255
      ? new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
      : raw;
  return {
    id: `${vector.id}@0`,
    width: vector.media.width,
    height: vector.media.height,
    maximum: vector.maximum,
    alpha,
    foreground: bytes(vector.foreground),
  };
}

describe('matte layer vectors (float64-exact vs the export)', () => {
  it('reproduces every matte clip at every decode size and time', () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const vector of document.cases) {
      const clip = ClipSchema.parse(vector.clip);
      const stack = clipMaskStack(clip, vector.media);
      expect(stack?.refusal ?? null, vector.id).toBeNull();
      const frame = frameOf(vector);
      for (const expected of vector.expected) {
        const mattes: MatteStackInputs = {
          decodedWidth: expected.decoded[0],
          decodedHeight: expected.decoded[1],
          frames: new Map(stack!.mattes.map((mask) => [mask.id, frame])),
        };
        const targets: [string, MaskStackTarget][] = [
          ['alpha', { kind: 'alpha' }],
          ...(vector.effects ?? []).map((effectId): [string, MaskStackTarget] => [
            `effect:${effectId}`,
            { kind: 'effect', effectId },
          ]),
        ];
        const where = `${vector.id} @${expected.decoded.join('x')} t=${expected.time}`;
        for (const [field, target] of targets) {
          const actual = digest(
            stackAlphaAt(stack!, target, expected.width, expected.height, expected.time, mattes),
          );
          if (actual !== expected[field]) mismatches.push(`${where} ${field}`);
          checked += 1;
        }
        const cleaned = picture(expected.width, expected.height);
        for (const mask of [...stack!.mattes].reverse()) {
          if (!mask.decontaminate) continue;
          decontaminate(
            cleaned,
            expected.width,
            expected.height,
            3,
            frame,
            clip.crop,
            expected.decoded[0],
            expected.decoded[1],
          );
        }
        if (digest(cleaned) !== expected.decontaminated) mismatches.push(`${where} decontaminated`);
        checked += 1;
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(50);
  });

  it('leaves a matte whose frame is still processing out of the stack', () => {
    const vector = document.cases.find((c) => c.id === 'matte/cropped-minus-rectangle')!;
    const clip = ClipSchema.parse(vector.clip);
    const stack = clipMaskStack(clip, vector.media)!;
    const processing: MatteStackInputs = {
      decodedWidth: 48,
      decodedHeight: 27,
      frames: new Map([['m', null]]),
    };
    // Only the subtracted rectangle remains: nothing is added, so the stack keeps nothing.
    const alpha = stackAlphaAt(stack, { kind: 'alpha' }, 34, 20, 0, processing)!;
    expect(Math.max(...alpha)).toBe(0);
    const alone = clipMaskStack(
      ClipSchema.parse({
        ...(vector.clip as object),
        masks: [(vector.clip as { masks: unknown[] }).masks[0]],
      }),
      vector.media,
    )!;
    expect(stackAlphaAt(alone, { kind: 'alpha' }, 34, 20, 0, processing)).toBeNull();
  });

  it('draws matte finesse rather than refusing it (MK6.2)', () => {
    const vector = document.cases[0]!;
    const raw = structuredClone(vector.clip) as { masks: Record<string, unknown>[] };
    raw.masks[0]!.finesse = { blurPx: 2 };
    const stack = clipMaskStack(ClipSchema.parse(raw), vector.media)!;
    expect(stack.refusal).toBeNull();
  });
});

// --- The finesse group (MK6.2) ----------------------------------------------------------------

describe('matte finesse vs the export', () => {
  interface FinesseCase {
    id: string;
    finesse: Partial<MaskFinesseValues>;
    levels: [number, number];
    identity: boolean;
    digest: string;
  }
  const document = JSON.parse(
    readFileSync(path.join(REPO, 'tests', 'fixtures', 'mask-raster', 'finesse.json'), 'utf8'),
  ) as { width: number; height: number; alpha: number[]; cases: FinesseCase[] };

  const DEFAULTS: MaskFinesseValues = {
    denoise: 0,
    morphOpenPx: 0,
    morphClosePx: 0,
    shrinkGrowPx: 0,
    blurPx: 0,
    inOutRatio: 0,
    cleanBlack: 0,
    cleanWhite: 1,
  };

  it('reproduces every case float64-byte-exactly', () => {
    const source = Float64Array.from(document.alpha);
    for (const vectorCase of document.cases) {
      const finesse = { ...DEFAULTS, ...vectorCase.finesse };
      const result = applyFinesse(
        source,
        document.width,
        document.height,
        finesse,
        vectorCase.levels,
      );
      expect(digest(result), vectorCase.id).toBe(vectorCase.digest);
      expect(finesseIsIdentity(finesse, vectorCase.levels), vectorCase.id).toBe(
        vectorCase.identity,
      );
    }
    expect(document.cases.length).toBeGreaterThanOrEqual(12);
  });

  it('covers every control of the group', () => {
    const touched = new Set(document.cases.flatMap((entry) => Object.keys(entry.finesse)));
    expect([...touched].sort()).toEqual([
      'blurPx',
      'denoise',
      'inOutRatio',
      'morphClosePx',
      'morphOpenPx',
      'shrinkGrowPx',
    ]);
    // Clean levels ride on `levels`, which an `edgeMode` can supply instead of the group.
    expect(document.cases.some((entry) => entry.levels[0] !== 0 || entry.levels[1] !== 1)).toBe(
      true,
    );
  });
});

describe('decontamination from the monitor tier (PX5.3)', () => {
  /** A soft ring matte and a random foreground at the artifact's size. */
  function artifactFrame(width: number, height: number): MatteFrameData {
    const alpha = new Uint8Array(width * height);
    const foreground = new Uint8Array(width * height * 3);
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % 256;
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const distance = Math.hypot(x - width * 0.45, y - height * 0.5);
        const ring = Math.min(Math.max((Math.min(width, height) * 0.3 - distance) / 3, 0), 1);
        alpha[y * width + x] = Math.round(ring * 255);
        for (let ch = 0; ch < 3; ch += 1) foreground[(y * width + x) * 3 + ch] = next();
      }
    }
    return { id: 'a@0', width, height, maximum: 255, alpha, foreground };
  }

  /** `render/matte_tier.py`'s `tier_planes`, through the float64 twin of `resample`. */
  function tierPlanes(frame: MatteFrameData, width: number, height: number): MattePlanes {
    const pixels = frame.width * frame.height;
    const band = new Float64Array(pixels);
    const colour = new Float64Array(pixels * 3);
    for (let i = 0; i < pixels; i += 1) {
      const inBand = frame.alpha[i]! > 0 && frame.alpha[i]! < frame.maximum ? 1 : 0;
      band[i] = inBand;
      for (let ch = 0; ch < 3; ch += 1)
        colour[i * 3 + ch] = frame.foreground![i * 3 + ch]! * inBand;
    }
    const plane = (data: Float64Array, channels: number) => ({
      width: frame.width,
      height: frame.height,
      channels,
      data,
    });
    const weight = resample(plane(band, 1), width, height, 1).data;
    const premultiplied = resample(plane(colour, 3), width, height, 255).data;
    // `split_bytes`: each 16-bit plane as its high-byte rows, then its low-byte rows.
    const data = new Uint8Array(width * height * 8);
    const n = width * height;
    const store = (plane: number, i: number, value: number): void => {
      data[2 * plane * n + i] = value >> 8;
      data[(2 * plane + 1) * n + i] = value & 0xff;
    };
    for (let i = 0; i < n; i += 1) {
      store(0, i, Math.round(weight[i]! * TIER_WEIGHT_SCALE));
      for (let ch = 0; ch < 3; ch += 1) {
        store(ch + 1, i, Math.round(premultiplied[i * 3 + ch]! * TIER_COLOUR_SCALE));
      }
    }
    return { width, height, data };
  }

  const cases: { name: string; crop: CropFractions | null; frame: [number, number] }[] = [
    { name: 'uncropped', crop: null, frame: [32, 18] },
    {
      name: 'cropped to its own slice',
      crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      frame: [22, 10],
    },
    {
      name: 'cropped and resampled',
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      frame: [32, 18],
    },
  ];

  it.each(cases)(
    'moves no byte more than one level from the masters ($name)',
    ({ crop, frame }) => {
      const artifact = artifactFrame(96, 54);
      const [width, height] = frame;
      const picture = new Uint8Array(width * height * 4).map((_v, i) => (i * 37) % 256);
      const fromMasters = picture.slice();
      decontaminate(fromMasters, width, height, 4, artifact, crop, 32, 18);
      const fromTier = picture.slice();
      decontaminateFromPlanes(fromTier, width, height, 4, tierPlanes(artifact, 32, 18), crop);
      let worst = 0;
      let equal = 0;
      for (let i = 0; i < picture.length; i += 1) {
        const difference = Math.abs(fromTier[i]! - fromMasters[i]!);
        worst = Math.max(worst, difference);
        if (difference === 0) equal += 1;
      }
      expect(worst).toBeLessThanOrEqual(1);
      expect(equal / picture.length).toBeGreaterThanOrEqual(0.99);
      // The alpha channel is never touched.
      for (let i = 3; i < picture.length; i += 4) expect(fromTier[i]).toBe(picture[i]);
    },
  );
});
