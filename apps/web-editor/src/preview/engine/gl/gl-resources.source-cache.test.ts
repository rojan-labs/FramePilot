/**
 * Source uploads kept across frames, and a pool that gives back the sizes a frame stopped using.
 *
 * A still, a text raster, a mask raster or a frost coverage is the same object frame after frame;
 * uploading it again every frame cost more than drawing it (a 12 MP still is 48 MB of upload per
 * frame). An animated scale makes new target sizes every frame, which the pool used to keep for
 * the whole session. These pin the counts on a fake context; the pixels are the PX4 oracle's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GlResources } from './gl-resources';

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

class FakeImageBitmap {
  constructor(
    public width: number,
    public height: number,
  ) {}

  close(): void {
    this.width = 0;
    this.height = 0;
  }
}

const MB = 1024 * 1024;

/** A WebGL2 stand-in that records texture lifetimes and what every upload read from. */
function fakeGl() {
  const calls = {
    /** The pixel source of every `texSubImage2D`, in order. */
    uploads: [] as unknown[],
    liveTextures: new Set<object>(),
    liveFramebuffers: new Set<object>(),
    createdTextures: 0,
    deletedTextures: 0,
  };
  const constants = new Map<string, number>();
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    createTexture: () => {
      const texture = {};
      calls.liveTextures.add(texture);
      calls.createdTextures += 1;
      return texture;
    },
    deleteTexture: (texture) => {
      calls.liveTextures.delete(texture as object);
      calls.deletedTextures += 1;
    },
    createFramebuffer: () => {
      const framebuffer = {};
      calls.liveFramebuffers.add(framebuffer);
      return framebuffer;
    },
    deleteFramebuffer: (framebuffer) => calls.liveFramebuffers.delete(framebuffer as object),
    texSubImage2D: (...args) => calls.uploads.push(args[args.length - 1]),
    createVertexArray: () => ({}),
    createBuffer: () => ({}),
  };
  const gl = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) => {
      if (typeof name !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) {
        if (!constants.has(name)) constants.set(name, constants.size + 1);
        return constants.get(name);
      }
      if (name === 'checkFramebufferStatus') return () => constants.get('FRAMEBUFFER_COMPLETE');
      return methods[name] ?? (() => undefined);
    },
  });
  // Resolved before any call reads it, so the status the fake returns is the one checked for.
  void (gl as { FRAMEBUFFER_COMPLETE?: number }).FRAMEBUFFER_COMPLETE;
  const uploadsOf = (source: unknown): number =>
    calls.uploads.filter((uploaded) => uploaded === source).length;
  return { gl: gl as unknown as WebGL2RenderingContext, calls, uploadsOf };
}

function image(width = 4, height = 4): ImageData {
  return new FakeImageData(
    new Uint8ClampedArray(width * height * 4),
    width,
    height,
  ) as unknown as ImageData;
}

beforeEach(() => {
  vi.stubGlobal('ImageData', FakeImageData);
  vi.stubGlobal('ImageBitmap', FakeImageBitmap);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GlResources source uploads', () => {
  it('uploads an unchanged image once however many frames draw it', () => {
    const { gl, uploadsOf } = fakeGl();
    const resources = new GlResources(gl);
    const still = image();
    const textures = new Set<WebGLTexture>();
    for (let frame = 0; frame < 30; frame += 1) {
      textures.add(resources.imageTarget(still, 4, 4).texture);
      resources.endFrame();
    }
    expect(uploadsOf(still)).toBe(1);
    expect(textures.size).toBe(1);
    expect(resources.lastFrameSources).toEqual({ uploads: 0, hits: 1 });
    expect(resources.sourceCacheEntries).toBe(1);
    expect(resources.sourceCacheBytes).toBe(4 * 4 * 4);
  });

  it('uploads a different object even when its pixels are the same', () => {
    const { gl, uploadsOf } = fakeGl();
    const resources = new GlResources(gl);
    const first = image();
    const second = image();
    resources.imageTarget(first, 4, 4);
    resources.endFrame();
    resources.imageTarget(second, 4, 4);
    resources.endFrame();
    expect(uploadsOf(first)).toBe(1);
    expect(uploadsOf(second)).toBe(1);
  });

  it('keeps mask rasters and byte uploads by identity too', () => {
    const { gl, uploadsOf } = fakeGl();
    const resources = new GlResources(gl);
    const alpha8 = new Uint8Array(16);
    const texels = new Uint8Array(64);
    const masks = new Set<WebGLTexture>();
    for (let frame = 0; frame < 10; frame += 1) {
      masks.add(resources.maskPlane(4, 4, alpha8));
      resources.bytesTarget(texels, 4, 4);
      resources.endFrame();
    }
    expect(uploadsOf(alpha8)).toBe(1);
    expect(uploadsOf(texels)).toBe(1);
    expect(masks.size).toBe(1);
  });

  it('never keeps a source that can change under the same object', () => {
    const { gl, uploadsOf } = fakeGl();
    const resources = new GlResources(gl);
    // A canvas or a VideoFrame: neither ImageData nor ImageBitmap.
    const canvas = { width: 4, height: 4 } as unknown as TexImageSource;
    for (let frame = 0; frame < 5; frame += 1) {
      resources.imageTarget(canvas, 4, 4);
      resources.endFrame();
    }
    expect(uploadsOf(canvas)).toBe(5);
    expect(resources.sourceCacheEntries).toBe(0);
  });

  it('keeps an open ImageBitmap and never keeps a closed one', () => {
    const { gl, uploadsOf } = fakeGl();
    const resources = new GlResources(gl);
    const open = new FakeImageBitmap(4, 4) as unknown as ImageBitmap;
    const closed = new FakeImageBitmap(4, 4);
    closed.close();
    for (let frame = 0; frame < 5; frame += 1) {
      resources.imageTarget(open, 4, 4);
      resources.imageTarget(closed as unknown as ImageBitmap, 4, 4);
      resources.endFrame();
    }
    expect(uploadsOf(open)).toBe(1);
    // Uploaded as before the cache (a real context refuses a closed bitmap there).
    expect(uploadsOf(closed)).toBe(5);
    expect(resources.sourceCacheEntries).toBe(1);
  });

  it('gives a raster no later frame draws back to the pool, which the next one refills', () => {
    const { gl, calls } = fakeGl();
    const resources = new GlResources(gl);
    // An animated caption: a new raster object every frame.
    for (let frame = 0; frame < 60; frame += 1) {
      resources.imageTarget(image(), 4, 4);
      resources.endFrame();
    }
    expect(calls.createdTextures).toBeLessThanOrEqual(2);
    expect(calls.deletedTextures).toBe(0);
    expect(resources.sourceCacheEntries).toBeLessThanOrEqual(1);
  });

  it('evicts the least recently drawn upload at the entry bound, never one this frame drew', () => {
    const { gl, uploadsOf } = fakeGl();
    const resources = new GlResources(gl);
    const sources = Array.from({ length: 65 }, () => image());
    const kept = sources.slice(0, 64);
    for (let frame = 0; frame < 2; frame += 1) {
      for (const source of kept) resources.imageTarget(source, 4, 4);
      resources.endFrame();
    }
    expect(resources.sourceCacheEntries).toBe(64);
    // Frame 2 draws all but the first, then a new one: the first is the only one to evict.
    for (const source of sources.slice(1)) resources.imageTarget(source, 4, 4);
    resources.endFrame();
    expect(resources.sourceCacheEntries).toBe(64);
    expect(sources.slice(1, 64).every((source) => uploadsOf(source) === 1)).toBe(true);
    resources.imageTarget(sources[0]!, 4, 4);
    resources.endFrame();
    expect(uploadsOf(sources[0])).toBe(2);
  });

  it('uploads for this frame only when every kept upload was drawn by it', () => {
    const { gl, uploadsOf } = fakeGl();
    const resources = new GlResources(gl);
    // 64 MB each: four fill the 256 MB budget.
    const stills = Array.from({ length: 5 }, () => image(4096, 4096));
    const textures = stills.map((still) => resources.imageTarget(still, 4096, 4096).texture);
    expect(resources.sourceCacheEntries).toBe(4);
    expect(resources.sourceCacheBytes).toBe(256 * MB);
    expect(new Set(textures).size).toBe(5);
    resources.endFrame();
    for (const still of stills) resources.imageTarget(still, 4096, 4096);
    resources.endFrame();
    // The four kept ones were never evicted to make room; the fifth is uploaded each frame.
    expect(stills.slice(0, 4).map(uploadsOf)).toEqual([1, 1, 1, 1]);
    expect(uploadsOf(stills[4])).toBe(2);
  });
});

describe('GlResources render-target pool', () => {
  it('allocates nothing per frame and deletes nothing on a steady timeline', () => {
    const { gl, calls } = fakeGl();
    const resources = new GlResources(gl);
    for (let frame = 0; frame < 100; frame += 1) {
      resources.target(1920, 1080, 'rgba8');
      resources.target(1920, 1080, 'rgba8');
      resources.target(960, 540, 'rgba32f');
      resources.endFrame();
    }
    expect(calls.createdTextures).toBe(3);
    expect(calls.deletedTextures).toBe(0);
  });

  it('keeps sizes a frame did not use while they fit the idle bound', () => {
    const { gl, calls } = fakeGl();
    const resources = new GlResources(gl);
    for (let frame = 0; frame < 100; frame += 1) {
      // Two sizes taking turns, 8 MB together: well inside the bound.
      resources.target(frame % 2 === 0 ? 1000 : 1001, 1000, 'rgba8');
      resources.endFrame();
    }
    expect(calls.createdTextures).toBe(2);
    expect(calls.deletedTextures).toBe(0);
  });

  it('deletes the least recently used idle sizes of an animated scale past the idle bound', () => {
    const { gl, calls } = fakeGl();
    const resources = new GlResources(gl);
    const frameBytes = 4 * MB;
    let latest: WebGLTexture | null = null;
    for (let frame = 0; frame < 200; frame += 1) {
      // A zoom: the resize lands on a new width every frame (~4 MB each).
      latest = resources.target(1024 + frame, 1024, 'rgba8').texture;
      resources.endFrame();
    }
    expect(calls.createdTextures).toBe(200);
    expect(calls.deletedTextures).toBeGreaterThan(150);
    // What is left: the frame just drawn plus the idle bound's worth (128 MB).
    expect(resources.poolBytes).toBeLessThanOrEqual(128 * MB + frameBytes * 2);
    expect(calls.liveTextures.has(latest!)).toBe(true);
    expect(calls.liveTextures.size + calls.deletedTextures).toBe(calls.createdTextures);
    expect(calls.liveFramebuffers.size).toBe(calls.liveTextures.size);
  });

  it('never deletes a target the frame is still using', () => {
    const { gl, calls } = fakeGl();
    const resources = new GlResources(gl);
    for (let frame = 0; frame < 64; frame += 1) {
      resources.target(1024 + frame, 1024, 'rgba8');
      resources.endFrame();
    }
    const deletedBefore = calls.deletedTextures;
    // Mid-frame: nothing is trimmed until the frame ends.
    const inUse = resources.target(4096, 4096, 'rgba8').texture;
    expect(calls.deletedTextures).toBe(deletedBefore);
    resources.endFrame();
    expect(calls.liveTextures.has(inUse)).toBe(true);
  });

  it('dispose deletes kept uploads, pooled and idle targets alike', () => {
    const { gl, calls } = fakeGl();
    const resources = new GlResources(gl);
    const still = image();
    for (let frame = 0; frame < 5; frame += 1) {
      resources.imageTarget(still, 4, 4);
      resources.imageTarget(image(8, 8), 8, 8);
      resources.maskPlane(4, 4, new Uint8Array(16));
      resources.target(100 + frame, 100, 'rgba8');
      resources.endFrame();
    }
    resources.target(64, 64, 'r8ui');
    resources.dispose();
    expect(calls.liveTextures.size).toBe(0);
    expect(calls.liveFramebuffers.size).toBe(0);
    expect(resources.poolBytes).toBe(0);
    expect(resources.sourceCacheEntries).toBe(0);
    expect(resources.sourceCacheBytes).toBe(0);
  });
});
