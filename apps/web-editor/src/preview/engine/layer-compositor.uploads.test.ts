/**
 * The program monitor composites every frame, and a caption, a title or a still is the same
 * object on each of them. These pin that `LayerCompositor.render` uploads such a source once, and
 * scans and uploads a frosted chip's coverage once, on a fake context (the pixels are the PX4
 * oracle's).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayerCompositor, frostCoverageStep, type CompositeLayer } from './layer-compositor';
import type { PictureRasterStep } from './layer-raster';
import { PreviewTelemetry } from './preview-telemetry';

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

class FakeImageBitmap {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
}

const FRAME = { width: 32, height: 18 };

/** A compositor on a WebGL2 stand-in that records what every upload read from. */
function compositor() {
  const uploads: unknown[] = [];
  const constants = new Map<string, number>();
  const gl = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) => {
      if (typeof name !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) {
        if (!constants.has(name)) constants.set(name, constants.size + 1);
        return constants.get(name);
      }
      if (name === 'texSubImage2D') return (...args: unknown[]) => uploads.push(args.at(-1));
      if (name === 'checkFramebufferStatus') return () => constants.get('FRAMEBUFFER_COMPLETE');
      if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true;
      if (name.startsWith('create') || name === 'getUniformLocation') return () => ({});
      return () => undefined;
    },
  });
  void (gl as { FRAMEBUFFER_COMPLETE?: number }).FRAMEBUFFER_COMPLETE;
  const canvas = { width: 1, height: 1, getContext: () => gl };
  const instance = new LayerCompositor(() => canvas as unknown as HTMLCanvasElement);
  const uploadsOf = (source: unknown): number =>
    uploads.filter((uploaded) => uploaded === source).length;
  return { instance, uploads, uploadsOf };
}

function raster(image: ImageData, frost?: { coverage: Uint8Array; sigmaPx: number }) {
  return {
    kind: 'raster',
    key: 'caption:1',
    image,
    width: image.width,
    height: image.height,
    x: 4,
    y: 4,
    aboveEffects: true,
    ...(frost === undefined ? {} : { frost }),
  } satisfies CompositeLayer;
}

function image(width = 8, height = 4): ImageData {
  return new FakeImageData(
    new Uint8ClampedArray(width * height * 4),
    width,
    height,
  ) as unknown as ImageData;
}

/** A still drawn at its own size, then resized, as `pictureRasterStep` plans an image clip. */
function stillStep(): PictureRasterStep {
  return {
    assetId: 'still',
    assetKind: 'image',
    frame: null,
    decode: { kind: 'native' },
    crop: null,
    opacity: null,
    mask: null,
    maskRefusal: null,
    effectIds: [],
    blurRadius: 0,
    wipe: null,
    transitions: [],
    resize: { width: 16, height: 9 },
    rotation: 0,
    x: 0,
    y: 0,
    blendMode: 'normal',
    effects: [],
    edgeStyles: [],
    ownAlphaEdges: null,
  };
}

beforeEach(() => {
  vi.stubGlobal('ImageData', FakeImageData);
  vi.stubGlobal('ImageBitmap', FakeImageBitmap);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LayerCompositor source uploads', () => {
  it('uploads an unchanged caption raster once across frames, and reports it', () => {
    const { instance, uploadsOf } = compositor();
    const telemetry = new PreviewTelemetry();
    instance.setTelemetry(telemetry);
    const caption = image();
    for (let frame = 0; frame < 6; frame += 1) instance.render(FRAME, [raster(caption)]);
    expect(uploadsOf(caption)).toBe(1);
    const { gauges } = telemetry.snapshot();
    expect(gauges.glSourceUploads).toEqual({ current: 0, peak: 1 });
    expect(gauges.glSourceCacheHits.current).toBe(1);
    expect(gauges.glSourceCacheBytes.current).toBe(8 * 4 * 4);
  });

  it('uploads a new raster object when the caption changes', () => {
    const { instance, uploadsOf } = compositor();
    const first = image();
    const second = image();
    instance.render(FRAME, [raster(first)]);
    instance.render(FRAME, [raster(second)]);
    instance.render(FRAME, [raster(second)]);
    expect(uploadsOf(first)).toBe(1);
    expect(uploadsOf(second)).toBe(1);
  });

  it('uploads a still picture layer once however many frames draw it', () => {
    const { instance, uploadsOf } = compositor();
    const bitmap = new FakeImageBitmap(32, 18) as unknown as ImageBitmap;
    const layer: CompositeLayer = {
      kind: 'picture',
      step: stillStep(),
      source: { kind: 'image', key: 'image:still', image: bitmap, width: 32, height: 18 },
    };
    for (let frame = 0; frame < 6; frame += 1) instance.render(FRAME, [layer]);
    expect(uploadsOf(bitmap)).toBe(1);
  });

  it('scans and uploads a frosted chip coverage once', () => {
    const { instance, uploads } = compositor();
    const caption = image();
    let reads = 0;
    const bytes = new Uint8Array(8 * 4).fill(255);
    // Counts index reads, so a rescan of the chip would show.
    const coverage = new Proxy(bytes, {
      get: (target, name) => {
        if (typeof name === 'string' && /^\d+$/.test(name)) reads += 1;
        return target[name as keyof Uint8Array];
      },
    });
    const layer = raster(caption, { coverage, sigmaPx: 1 });
    instance.render(FRAME, [layer]);
    const readsAfterFirst = reads;
    const texelUploads = (): number =>
      uploads.filter((uploaded) => uploaded instanceof Uint8Array && uploaded.length === 8 * 4 * 4)
        .length;
    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(texelUploads()).toBe(1);
    for (let frame = 0; frame < 5; frame += 1) instance.render(FRAME, [layer]);
    expect(reads).toBe(readsAfterFirst);
    expect(texelUploads()).toBe(1);
  });
  it("places a text overlay's frosted coverage with the layer and uploads it once", () => {
    const { instance, uploadsOf } = compositor();
    const letters = new FakeImageBitmap(32, 18) as unknown as ImageBitmap;
    const coverage = image(32, 18);
    const layer: CompositeLayer = {
      kind: 'picture',
      step: stillStep(),
      source: { kind: 'image', key: 'text:1', image: letters, width: 32, height: 18 },
      frost: { key: 'text-frost:1', coverage, width: 32, height: 18, sigmaPx: 2 },
    };
    for (let frame = 0; frame < 6; frame += 1) instance.render(FRAME, [layer]);
    expect(uploadsOf(letters)).toBe(1);
    expect(uploadsOf(coverage)).toBe(1);
  });
});

describe('frostCoverageStep', () => {
  it("keeps the layer's geometry and envelope, and drops what reads its colours", () => {
    const step: PictureRasterStep = {
      ...stillStep(),
      opacity: 0.5,
      rotation: 12,
      x: 3,
      y: 4,
      blurRadius: 2,
      effects: [{ type: 'color_grade', params: {} }] as unknown as PictureRasterStep['effects'],
      effectIds: ['g'],
      edgeStyles: [{}] as unknown as PictureRasterStep['edgeStyles'],
      ownAlphaEdges: { scale: 1 },
    };
    const coverage = frostCoverageStep(step);
    expect(coverage).toMatchObject({
      opacity: 0.5,
      rotation: 12,
      x: 3,
      y: 4,
      resize: step.resize,
      blurRadius: 0,
      effects: [],
      effectIds: [],
      edgeStyles: [],
      ownAlphaEdges: null,
      mask: null,
    });
  });
});
