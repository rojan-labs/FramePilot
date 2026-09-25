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
      animated: false,
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

  it('forwards a shape with its rotation flag and returns its bounds origin', async () => {
    const fetchFn = ok({ width: 1, height: 1, rgba_base64: 'AQIDBA==', x: 463, y: 258 });
    const params = { shape: 'rounded-rect', x: 50, y: 50, width: 48, height: 27 };
    const result = await previewTextRasterViaSidecar(
      'http://e',
      { kind: 'shape', params, rotates: true, frameWidth: 1280, frameHeight: 720 },
      fetchFn,
    );
    expect(result).toMatchObject({ ok: true, x: 463, y: 258 });
    const [, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'shape',
      params,
      rotates: true,
      frame_width: 1280,
      frame_height: 720,
    });
  });

  it('refuses a shape request with bad params without calling the engine', async () => {
    const fetchFn = ok({});
    for (const req of [
      { kind: 'shape', params: null, frameWidth: 10, frameHeight: 10 },
      { kind: 'shape', params: { shape: 'x'.repeat(20_000) }, frameWidth: 10, frameHeight: 10 },
      { kind: 'shape', params: {}, rotates: 'yes', frameWidth: 10, frameHeight: 10 },
    ]) {
      expect((await previewTextRasterViaSidecar('http://e', req, fetchFn)).ok).toBe(false);
    }
    expect(fetchFn).not.toHaveBeenCalled();
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

  it('forwards a styled caption with its words and frame time, and decodes the frost', async () => {
    const fetchFn = ok({
      width: 2,
      height: 1,
      rgba_base64: 'AQIDBAUGBwg=',
      x: -4,
      y: 10,
      animated: true,
      backdrop_base64: 'AP8=',
      backdrop_sigma_px: 12.5,
    });
    const result = await previewTextRasterViaSidecar(
      'http://e',
      {
        kind: 'caption',
        text: 'top 1%',
        frameWidth: 288,
        frameHeight: 512,
        trackStyle: { fontFamily: 'Anton' },
        words: [{ word: 'top', start: 1, end: 1.3 }],
        clipStart: 1,
        clipEnd: 2.5,
        frameTime: 1.4,
      },
      fetchFn,
    );
    expect(result).toMatchObject({
      ok: true,
      x: -4,
      y: 10,
      animated: true,
      backdrop: new Uint8Array([0, 255]),
      backdropSigmaPx: 12.5,
    });
    const [, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({
      kind: 'caption',
      text: 'top 1%',
      frame_width: 288,
      frame_height: 512,
      track_style: { fontFamily: 'Anton' },
      words: [{ word: 'top', start: 1, end: 1.3 }],
      clip_start: 1,
      clip_end: 2.5,
      frame_time: 1.4,
    });
  });

  it('refuses a styled caption without a span, with bad words, or a bloated style', async () => {
    const fetchFn = ok({});
    const base = { kind: 'caption', text: 'hi', frameWidth: 10, frameHeight: 10 };
    for (const req of [
      { ...base, trackStyle: { fontFamily: 'Inter' } },
      { ...base, trackStyle: {}, clipStart: 2, clipEnd: 1 },
      { ...base, trackStyle: {}, clipStart: 0, clipEnd: 1, words: [{ word: 1, start: 0, end: 1 }] },
      { ...base, trackStyle: { x: 'y'.repeat(20_000) }, clipStart: 0, clipEnd: 1 },
      { ...base, clipStyle: {}, clipStart: 0, clipEnd: 1, frameTime: Number.NaN },
    ]) {
      expect((await previewTextRasterViaSidecar('http://e', req, fetchFn)).ok).toBe(false);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a frost coverage of the wrong size', async () => {
    const fetchFn = ok({ width: 1, height: 1, rgba_base64: 'AQIDBA==', backdrop_base64: 'AP8=' });
    const req = { kind: 'caption', text: 'hi', frameWidth: 10, frameHeight: 10 };
    expect((await previewTextRasterViaSidecar('http://e', req, fetchFn)).ok).toBe(false);
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
