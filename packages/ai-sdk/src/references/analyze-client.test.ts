import { describe, expect, it } from 'vitest';
import { createReferenceAnalyzer } from './analyze-client.js';

const fetchOk = (body: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

describe('createReferenceAnalyzer', () => {
  it('turns a route response into a profile with rendered constraints', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn: typeof fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body) });
      return new Response(
        JSON.stringify({
          kind: 'video',
          contentHash: 'a'.repeat(64),
          cached: true,
          video: {
            durationS: 20,
            shotCount: 12,
            medianShotS: 1.4,
            shotLengthP10S: 0.8,
            shotLengthP90S: 2.9,
            cutsPerMinute: 33,
            width: 1080,
            height: 1920,
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const analyze = createReferenceAnalyzer({
      baseUrl: 'http://sidecar',
      fetchFn,
      now: () => new Date('2026-08-29T00:00:00Z'),
    });
    const { profile, cached } = await analyze({
      id: 'ref_1',
      inputPath: '/p/media/x/ref.mp4',
      fileName: 'ref.mp4',
      kind: 'video',
      role: 'pacing',
    });
    expect(cached).toBe(true);
    expect(calls[0]!.url).toBe('http://sidecar/references/analyze');
    expect(JSON.parse(calls[0]!.body)).toEqual({ input_path: '/p/media/x/ref.mp4', kind: 'video' });
    expect(profile.role).toBe('pacing');
    expect(profile.constraints[0]).toBe(
      'Pacing: fast — median shot 1.4s (most shots 0.8–2.9s), 33 cuts/min',
    );
    expect(profile.analyzedAt).toBe('2026-08-29T00:00:00.000Z');
  });

  it('reports a failed analysis with the file name and status', async () => {
    const fetchFn: typeof fetch = (async () =>
      new Response('ffmpeg exploded', { status: 422 })) as unknown as typeof fetch;
    const analyze = createReferenceAnalyzer({ baseUrl: 'http://sidecar', fetchFn });
    await expect(
      analyze({ id: 'r', inputPath: '/p/a.mov', fileName: 'a.mov', kind: 'video', role: 'style' }),
    ).rejects.toThrow(/a\.mov \(422\): ffmpeg exploded/);
  });

  it('rejects a malformed route payload rather than building a half profile', async () => {
    const analyze = createReferenceAnalyzer({
      baseUrl: 'http://sidecar',
      fetchFn: fetchOk({ kind: 'image', contentHash: 'x' }),
    });
    await expect(
      analyze({
        id: 'r',
        inputPath: '/p/a.png',
        fileName: 'a.png',
        kind: 'image',
        role: 'brand-logo',
      }),
    ).rejects.toThrow();
  });
});
