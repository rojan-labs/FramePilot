import { describe, expect, it, vi } from 'vitest';
import { importAssetViaSidecar } from './asset-media-client.js';

const BASE = 'http://127.0.0.1:8765';

/** A `fetch` stub returning a JSON body with a given status. */
const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response;

describe('importAssetViaSidecar', () => {
  it('POSTs to /asset-media and maps a video response (with thumbnails)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        durationSeconds: 12.5,
        kind: 'video',
        peaks: [0.1, 0.2],
        peaksPerSecond: 10,
        thumbnailPaths: ['media/p/t0.jpg', 'media/p/t1.jpg'],
      }),
    );
    const result = await importAssetViaSidecar(
      BASE,
      { inputPath: 'media/p/clip.mp4', thumbnails: 8 },
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({
      ok: true,
      durationSeconds: 12.5,
      kind: 'video',
      media: {
        peaks: [0.1, 0.2],
        peaksPerSecond: 10,
        thumbnailPaths: ['media/p/t0.jpg', 'media/p/t1.jpg'],
      },
    });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${BASE}/asset-media`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      input_path: 'media/p/clip.mp4',
      thumbnails: 8,
      proxy: false,
    });
  });

  it('forwards projectId/assetId so the sidecar records the import in the brain (B0.4)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ kind: 'video', durationSeconds: 1 }));
    await importAssetViaSidecar(
      BASE,
      { inputPath: 'media/p/clip.mp4', projectId: 'proj_1', assetId: 'asset_clip' },
      fetchFn as unknown as typeof fetch,
    );
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      projectId: 'proj_1',
      assetId: 'asset_clip',
    });
  });

  it('omits brain ids from the body unless BOTH projectId and assetId are set', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ kind: 'video', durationSeconds: 1 }));
    await importAssetViaSidecar(
      BASE,
      { inputPath: 'media/p/clip.mp4', projectId: 'proj_1' },
      fetchFn as unknown as typeof fetch,
    );
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('projectId');
    expect(body).not.toHaveProperty('assetId');
  });

  it('requests a proxy when asked and maps proxyPath into media (H3)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        durationSeconds: 12.5,
        kind: 'video',
        proxyPath: '.framepilot-derived/abc/proxy.mp4',
      }),
    );
    const result = await importAssetViaSidecar(
      BASE,
      { inputPath: 'media/p/clip.mp4', proxy: true },
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({
      ok: true,
      durationSeconds: 12.5,
      kind: 'video',
      media: { proxyPath: '.framepilot-derived/abc/proxy.mp4' },
    });
    const [, init] = fetchFn.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string).proxy).toBe(true);
  });

  it('defaults the thumbnail count when omitted and maps an audio response (null thumbs)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ durationSeconds: 30, kind: 'audio', peaks: [0.3], peaksPerSecond: 5 }),
    );
    const result = await importAssetViaSidecar(
      BASE,
      { inputPath: 'media/p/voice.wav' },
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({
      ok: true,
      durationSeconds: 30,
      kind: 'audio',
      media: { peaks: [0.3], peaksPerSecond: 5 },
    });
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      input_path: 'media/p/voice.wav',
      thumbnails: 5,
      proxy: false,
    });
  });

  it('maps a non-2xx response to an error WITHOUT leaking the upstream body', async () => {
    // The sidecar's sandbox error embeds the absolute projects-root path; the
    // client must surface only the status, never the body (security review).
    const fetchFn = vi.fn(async () =>
      jsonResponse('Path escapes sandbox. base=/Users/secret', false, 404),
    );
    const result = await importAssetViaSidecar(
      BASE,
      { inputPath: 'media/p/missing.mp4' },
      fetchFn as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('404');
      expect(result.error).not.toContain('secret');
      expect(result.error).not.toContain('sandbox');
    }
  });

  it('maps a malformed (non-JSON) body to an error', async () => {
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('Unexpected end of JSON input');
          },
          text: async () => 'not json',
        }) as Response,
    );
    const result = await importAssetViaSidecar(
      BASE,
      { inputPath: 'media/p/clip.mp4' },
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: 'Unexpected end of JSON input' });
  });

  it('rejects a 2xx body that lacks a valid kind', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ durationSeconds: 1, peaks: [] }));
    const result = await importAssetViaSidecar(
      BASE,
      { inputPath: 'media/p/clip.mp4' },
      fetchFn as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('valid kind');
  });

  it('maps a transport failure (sidecar down) to an error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await importAssetViaSidecar(
      BASE,
      { inputPath: 'media/p/clip.mp4' },
      fetchFn as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});
