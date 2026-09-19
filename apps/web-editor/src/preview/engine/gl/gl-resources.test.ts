/**
 * PX5.3: a matte frame's decoded planes are uploaded once per frame and replaced ~30 times a
 * second. Recreating a 25 MB texture at that rate let the driver's deferred frees pile up, so an
 * evicted texture of the same shape is re-filled instead. This pins the counts; no GPU needed.
 */
import { describe, expect, it } from 'vitest';

import { GlResources } from './gl-resources';

function countingGl() {
  const calls = { created: 0, deleted: 0, storage: 0, uploads: 0 };
  let next = 1;
  const gl = new Proxy({} as Record<string | symbol, unknown>, {
    get: (_target, name) => {
      if (name === 'createTexture')
        return () => {
          calls.created += 1;
          return { id: next++ };
        };
      if (name === 'deleteTexture') return () => (calls.deleted += 1);
      if (name === 'texStorage2D') return () => (calls.storage += 1);
      if (name === 'texSubImage2D') return () => (calls.uploads += 1);
      if (name === 'createVertexArray' || name === 'createBuffer') return () => ({});
      if (typeof name === 'string' && /^[A-Z0-9_]+$/.test(name)) return name.length;
      return () => undefined;
    },
  });
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

describe('GlResources.keyedTexture', () => {
  it('uploads a key once and serves repeats from the cache', () => {
    const { gl, calls } = countingGl();
    const resources = new GlResources(gl);
    const data = new Uint8Array(16);
    const first = resources.keyedTexture('m@1|alpha', 4, 4, 'r8', data);
    expect(resources.keyedTexture('m@1|alpha', 4, 4, 'r8', data)).toBe(first);
    expect(calls.uploads).toBe(1);
  });

  it('re-fills evicted textures of the same shape instead of creating and deleting', () => {
    const { gl, calls } = countingGl();
    const resources = new GlResources(gl);
    const alpha = new Uint8Array(16);
    const colour = new Uint8Array(48);
    for (let frame = 0; frame < 120; frame += 1) {
      resources.keyedTexture(`m@${frame}|alpha`, 4, 4, 'r8', alpha);
      resources.keyedTexture(`m@${frame}|foreground`, 4, 4, 'rgb8', colour);
    }
    // Every frame is uploaded; the texture objects are a small bounded set, never churned.
    expect(calls.uploads).toBe(240);
    expect(calls.created).toBeLessThanOrEqual(6);
    expect(calls.deleted).toBe(0);
    const bytes = resources.poolBytes;
    for (let frame = 120; frame < 240; frame += 1) {
      resources.keyedTexture(`m@${frame}|alpha`, 4, 4, 'r8', alpha);
      resources.keyedTexture(`m@${frame}|foreground`, 4, 4, 'rgb8', colour);
    }
    expect(resources.poolBytes).toBe(bytes);
  });
});
