import { describe, expect, it, vi } from 'vitest';
import { previewTextRasterViaSidecar } from './preview-text-client.js';

const ok = (body: unknown): typeof globalThis.fetch =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as never;

describe('previewTextRasterViaSidecar', () => {
  it('forwards snake case and decodes the raster', async () => {
    const fetchFn = ok({ width: 1, height: 1, rgba_base64: 'AQIDBA==', x: 3, y: null });
    const result = await previewTextRasterViaSidecar(
      'http://e',
      { kind: 'caption', text: 'hi', frameWidth: 1280, frameHeight: 720 },
      fetchFn,
    );
    expect(result).toEqual({
      ok: true,
      width: 1,
      height: 1,
      rgba: new Uint8Array([1, 2, 3, 4]),
      x: 3,
      y: null,
    });
    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe('http://e/preview/text-raster');
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'caption',
      text: 'hi',
      frame_width: 1280,
      frame_height: 720,
    });
  });

  it('refuses malformed requests without calling the engine', async () => {
    const fetchFn = ok({});
    for (const req of [
      { kind: 'svg', frameWidth: 1, frameHeight: 1 },
      { kind: 'text', params: {}, frameWidth: 0, frameHeight: 720 },
      { kind: 'text', params: null, frameWidth: 10, frameHeight: 10 },
      { kind: 'caption', text: 'x'.repeat(3000), frameWidth: 10, frameHeight: 10 },
    ]) {
      expect((await previewTextRasterViaSidecar('http://e', req, fetchFn)).ok).toBe(false);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports an unavailable engine and a wrong-size raster', async () => {
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as never;
    const req = { kind: 'text', params: { text: 'a' }, frameWidth: 10, frameHeight: 10 };
    expect((await previewTextRasterViaSidecar('http://e', req, down)).ok).toBe(false);
    const short = ok({ width: 2, height: 2, rgba_base64: 'AQIDBA==' });
    expect((await previewTextRasterViaSidecar('http://e', req, short)).ok).toBe(false);
  });
});
