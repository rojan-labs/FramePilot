import { describe, expect, it } from 'vitest';
import { createEngineCropColourSource } from './crop-colour-client.js';

const BOX = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const QUERY = {
  absolutePath: '/projects/p/media/street.mp4',
  fps: 25,
  crops: [
    { timeSeconds: 1, box: BOX },
    { timeSeconds: 2, box: BOX },
  ],
};

function engine(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  const fetchFn = (async (url: URL, init: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return createEngineCropColourSource({ baseUrl: 'http://127.0.0.1:8799', fetchFn });
}

describe('createEngineCropColourSource (AM2.7)', () => {
  it('asks the engine for every crop and reads its measurements in order', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const measured = await engine(
      200,
      {
        crops: [
          { neutral_share: 0.97, neutral_lightness: 88.2, lightness: 88, chroma: 2, pixels: 900 },
          null,
        ],
      },
      seen,
    )(QUERY);
    expect(measured).toEqual([{ neutralShare: 0.97, neutralLightness: 88.2 }, undefined]);
    expect(seen.url).toBe('http://127.0.0.1:8799/masking/crop-colour');
    expect(JSON.parse(String(seen.init?.body))).toEqual({
      input_path: '/projects/p/media/street.mp4',
      fps: 25,
      crops: [
        { time_seconds: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        { time_seconds: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      ],
    });
  });

  it('keeps a chromatic crop’s missing lightness as null', async () => {
    const measured = await engine(200, {
      crops: [
        { neutral_share: 0, neutral_lightness: null },
        { neutral_share: 0.2, neutral_lightness: 40 },
      ],
    })(QUERY);
    expect(measured[0]).toEqual({ neutralShare: 0, neutralLightness: null });
  });

  it.each([
    ['a refusal', 400, {}],
    ['a busy engine', 503, {}],
    ['an undecodable file', 422, {}],
  ])('throws on %s', async (_why, status, body) => {
    await expect(engine(status, body)(QUERY)).rejects.toThrow(/HTTP/);
  });

  it.each([
    ['too few answers', { crops: [null] }],
    ['no list', { crops: 'nope' }],
    ['a share outside 0..1', { crops: [{ neutral_share: 2, neutral_lightness: 5 }, null] }],
    ['a non-numeric lightness', { crops: [{ neutral_share: 1, neutral_lightness: 'x' }, null] }],
    ['an entry that is not an object', { crops: [7, null] }],
  ])('refuses a malformed answer: %s', async (_why, body) => {
    await expect(engine(200, body)(QUERY)).rejects.toThrow(/engine/);
  });

  it('throws when the engine cannot be reached', async () => {
    const fetchFn = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    const source = createEngineCropColourSource({ baseUrl: 'http://127.0.0.1:1', fetchFn });
    await expect(source(QUERY)).rejects.toThrow(/connection refused/);
  });
});
