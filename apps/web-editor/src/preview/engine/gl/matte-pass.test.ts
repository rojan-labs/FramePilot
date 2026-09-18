/**
 * PX5.3: the GPU matte pass runs the export's chain in the export's order, hands the shader the
 * engine's own float64-normalised bicubic weights, and says no (so the CPU twin draws) for any
 * radius a shader loop cannot carry. The pixels themselves are judged by the PX4 oracle on a
 * real GPU; this pins what can be pinned without one.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClipSchema } from '@framepilot/timeline-schema';

import type { MatteMask } from '../../masks/mask-stack';
import { gaussianFalloffTable } from '../../masks/mask-raster';
import { resampleTaps, type MatteFrameData } from '../../masks/matte-edges';
import type { GlResources } from './gl-resources';
import { MattePass, type MatteFrameGeometry } from './matte-pass';

const REPO = path.resolve(__dirname, '../../../../../..');
const document = JSON.parse(
  readFileSync(path.join(REPO, 'tests', 'fixtures', 'mask-raster', 'matte-clips.json'), 'utf8'),
) as { cases: { clip: unknown }[] };

/** A matte mask from the shared vectors, with `changes` on top. */
function matteMask(changes: Record<string, unknown> = {}): MatteMask {
  for (const entry of document.cases) {
    const clip = ClipSchema.parse(entry.clip);
    const mask = (clip.masks ?? []).find((layer) => layer.kind === 'matte');
    if (mask !== undefined) {
      const finesse = { ...mask.finesse, ...((changes.finesse as object | undefined) ?? {}) };
      return { ...mask, keyframes: [], ...changes, finesse } as MatteMask;
    }
  }
  throw new Error('matte-clips.json holds no matte mask.');
}

const IDENTITY_FINESSE = {
  denoise: 0,
  cleanBlack: 0,
  cleanWhite: 1,
  morphOpenPx: 0,
  morphClosePx: 0,
  shrinkGrowPx: 0,
  blurPx: 0,
  inOutRatio: 0,
};

interface Recorded {
  readonly passes: string[];
  readonly tables: Map<string, { width: number; height: number; data: Float32Array }>;
  readonly uploads: string[];
}

/** A `GlResources` that records the passes drawn and the tables built; no GL behind it. */
function recordingResources(): { resources: GlResources; recorded: Recorded } {
  const recorded: Recorded = { passes: [], tables: new Map(), uploads: [] };
  let current = '';
  const gl = new Proxy(
    { MAX_TEXTURE_SIZE: 0x0d33 },
    {
      get: (target, name) =>
        name === 'MAX_TEXTURE_SIZE'
          ? target.MAX_TEXTURE_SIZE
          : name === 'getParameter'
            ? () => 16384
            : () => undefined,
    },
  );
  const program = {
    handle: {},
    location: () => null,
    int: () => undefined,
    ivec2: () => undefined,
    vec4: () => undefined,
  };
  const resources = {
    gl,
    target: (width: number, height: number, format: string) => ({
      texture: {},
      framebuffer: {},
      width,
      height,
      format,
    }),
    program: (name: string) => {
      current = name;
      return program;
    },
    bind: () => undefined,
    draw: () => recorded.passes.push(current),
    keyedTexture: (key: string) => {
      recorded.uploads.push(key);
      return {};
    },
    floatTable: (key: string, width: number, height: number, build: () => Float32Array) => {
      if (!recorded.tables.has(key)) recorded.tables.set(key, { width, height, data: build() });
      return {};
    },
  };
  return { resources: resources as unknown as GlResources, recorded };
}

const frame = (width: number, height: number, foreground = false): MatteFrameData => ({
  id: 'artifact@7',
  width,
  height,
  maximum: 255,
  alpha: new Uint8Array(width * height),
  foreground: foreground ? new Uint8Array(width * height * 3) : null,
});

const geometry = (changes: Partial<MatteFrameGeometry> = {}): MatteFrameGeometry => ({
  crop: null,
  width: 96,
  height: 54,
  decodedWidth: 96,
  decodedHeight: 54,
  ...changes,
});

describe('MattePass', () => {
  it('runs edge shift, finesse, feather, resample and the layer tail in the export order', () => {
    const { resources, recorded } = recordingResources();
    const mask = matteMask({
      edgeShiftPx: 1.5,
      expansionPx: 0,
      featherInnerPx: 0,
      featherOuterPx: 4,
      finesse: { ...IDENTITY_FINESSE, denoise: 0.5, cleanBlack: 0.1, blurPx: 3, inOutRatio: 0.2 },
    });
    new MattePass(resources).layer(mask, frame(384, 216), geometry(), 0);
    expect(recorded.passes).toEqual([
      'matte-to-float',
      // A fractional shift: both integer radii, then their mix.
      'mask-morph',
      'mask-morph',
      'mask-mix-alpha',
      'mask-denoise',
      'mask-levels',
      ...Array<string>(6).fill('mask-box'),
      // The in/out ratio, after the blur.
      'mask-levels',
      'matte-row-distance',
      'matte-feather',
      'matte-resample',
      'matte-resample',
      'matte-crop',
    ]);
    expect(recorded.uploads).toEqual(['artifact@7|alpha']);
  });

  it('draws an untouched matte at the decoded size in two passes', () => {
    const { resources, recorded } = recordingResources();
    const mask = matteMask({
      edgeMode: 'soft',
      edgeShiftPx: 0,
      expansionPx: 0,
      featherInnerPx: 0,
      featherOuterPx: 0,
      finesse: IDENTITY_FINESSE,
    });
    new MattePass(resources).layer(mask, frame(96, 54), geometry(), 0);
    expect(recorded.passes).toEqual(['matte-to-float', 'matte-crop']);
  });

  it("hands the shader the engine's float64-normalised taps and first source index", () => {
    const { resources, recorded } = recordingResources();
    const mask = matteMask({ edgeShiftPx: 0, finesse: IDENTITY_FINESSE });
    new MattePass(resources).layer(mask, frame(384, 216), geometry(), 0);
    const table = recorded.tables.get('matte-taps:384>96')!;
    const { taps, weights, indices } = resampleTaps(384, 96);
    expect(table.width).toBe(taps + 1);
    expect(table.height).toBe(96);
    for (let i = 0; i < 96; i += 1) {
      const first = table.data[i * (taps + 1)]!;
      for (let tap = 0; tap < taps; tap += 1) {
        expect(table.data[i * (taps + 1) + 1 + tap]).toBe(Math.fround(weights[i * taps + tap]!));
        expect(Math.min(Math.max(first + tap, 0), 383)).toBe(indices[i * taps + tap]);
      }
    }
  });

  it('uploads the gaussian falloff as a 64 x 64 square, row-major, every entry', () => {
    const { resources, recorded } = recordingResources();
    const mask = matteMask({
      edgeShiftPx: 0,
      featherOuterPx: 6,
      falloff: 'gaussian',
      finesse: IDENTITY_FINESSE,
    });
    new MattePass(resources).layer(mask, frame(96, 54), geometry(), 0);
    const table = recorded.tables.get('matte-falloff')!;
    // WebGL2 only guarantees 2048-texel textures; the table has 4096 entries.
    expect([table.width, table.height]).toEqual([64, 64]);
    expect(table.data).toEqual(Float32Array.from(gaussianFalloffTable()));
  });

  it('decontaminates across with the band, then down, then mixes into the picture', () => {
    const { resources, recorded } = recordingResources();
    const picture = { texture: {}, framebuffer: {}, width: 96, height: 54, format: 'rgba8' };
    new MattePass(resources).decontaminate(picture as never, frame(384, 216, true), geometry());
    expect(recorded.passes).toEqual(['matte-band', 'matte-resample', 'matte-decontaminate']);
    expect(recorded.uploads).toEqual(['artifact@7|alpha', 'artifact@7|foreground']);
  });

  it('decontaminates from the monitor tier with one conversion, no band pass and no resample', () => {
    const { resources, recorded } = recordingResources();
    const picture = { texture: {}, framebuffer: {}, width: 96, height: 54, format: 'rgba8' };
    const tiered = {
      ...frame(384, 216),
      planes: { width: 96, height: 54, data: new Uint16Array(96 * 54 * 4) },
    };
    const pass = new MattePass(resources);
    expect(pass.carriesPlanes(tiered, geometry())).toBe(true);
    pass.decontaminatePlanes(picture as never, tiered, geometry());
    expect(recorded.passes).toEqual(['matte-tier-planes', 'matte-decontaminate']);
    // One 16-bit upload at the decoded size; the 4K masters are never touched.
    expect(recorded.uploads).toEqual(['artifact@7|planes']);
  });

  it('copies out and resamples a crop that disagrees with the frame', () => {
    const { resources, recorded } = recordingResources();
    const mask = matteMask({ edgeShiftPx: 0, finesse: IDENTITY_FINESSE });
    const crop = { x: 0.25, y: 0, width: 0.5, height: 1 };
    new MattePass(resources).layer(mask, frame(96, 54), geometry({ crop, width: 96 }), 0);
    // 48 cropped columns onto a 96-wide frame: crop copy, one resample across, the layer tail.
    expect(recorded.passes.slice(-3)).toEqual(['matte-crop', 'matte-resample', 'matte-crop']);
  });

  it('leaves what a shader loop cannot carry to the CPU twin', () => {
    const { resources } = recordingResources();
    const pass = new MattePass(resources);
    const small = frame(384, 216);
    const carried = matteMask({ edgeShiftPx: 16, finesse: IDENTITY_FINESSE });
    expect(pass.carries(carried, small, geometry(), 0)).toBe(true);
    const cases: Record<string, unknown>[] = [
      { edgeShiftPx: -16.5 },
      { finesse: { ...IDENTITY_FINESSE, morphOpenPx: 17 } },
      { finesse: { ...IDENTITY_FINESSE, shrinkGrowPx: -20 } },
      { finesse: { ...IDENTITY_FINESSE, blurPx: 200 } },
      { featherOuterPx: 120 },
    ];
    for (const changes of cases) {
      const mask = matteMask({ edgeShiftPx: 0, finesse: IDENTITY_FINESSE, ...changes });
      expect(pass.carries(mask, small, geometry(), 0), JSON.stringify(changes)).toBe(false);
    }
    // A kernel wider than the tap loop: 4096 source columns onto 64.
    expect(
      pass.carries(carried, frame(4096, 54), geometry({ decodedWidth: 64, width: 64 }), 0),
    ).toBe(false);
    // A plane past the GPU's texture limit.
    expect(pass.carries(carried, frame(20000, 54), geometry(), 0)).toBe(false);
  });
});
