/** BR4.12 re-review: 503 busy is retried with bounded backoff; timeouts are sized from the work. */
import { describe, expect, it, vi } from 'vitest';
import { DesktopMatteMediaInspector, sidecarTimeoutMs, SIDECAR_BUSY_RETRY_DELAYS_MS } from './matte-media-inspector.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('sidecar busy retries', () => {
  it('retries 503 with the backoff schedule and succeeds when the route frees up', async () => {
    const statuses = [503, 503, 200];
    const fetchImpl = vi.fn(async () => {
      const status = statuses.shift()!;
      return status === 200 ? json({ hashes: ['a'.repeat(64)] }) : json({ detail: 'busy' }, 503);
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    const inspector = new DesktopMatteMediaInspector({
      ffprobe: 'ffprobe',
      sidecarBaseUrl: 'http://127.0.0.1:1',
      fetch: fetchImpl,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(await inspector.frameHashesByPts('/p/shot.mov', [0])).toEqual(['a'.repeat(64)]);
    expect(slept).toEqual(SIDECAR_BUSY_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('gives up after the bounded retries, failing closed', async () => {
    const fetchImpl = vi.fn(async () => json({ detail: 'busy' }, 503)) as unknown as typeof fetch;
    const inspector = new DesktopMatteMediaInspector({
      ffprobe: 'ffprobe',
      sidecarBaseUrl: 'http://127.0.0.1:1',
      fetch: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(inspector.compareLockedFrames('/p/matte.mkv', [], undefined)).rejects.toMatchObject({ code: 'tool_unavailable' });
    expect(fetchImpl).toHaveBeenCalledTimes(SIDECAR_BUSY_RETRY_DELAYS_MS.length + 1);
  });

  it('sizes the client timeout beyond the engine deadline for the work asked', () => {
    expect(sidecarTimeoutMs({})).toBe(660_000);
    expect(sidecarTimeoutMs({ ptsCount: 18 })).toBe((600 + 540 + 60) * 1000);
    // A two-hour 30 fps matte locked at its last frame.
    expect(sidecarTimeoutMs({ highestFrame: 216_000 })).toBe((600 + 10_800 + 60) * 1000);
    expect(sidecarTimeoutMs({ highestFrame: 10 ** 9 })).toBe((6 * 3600 + 60) * 1000);
  });
});
