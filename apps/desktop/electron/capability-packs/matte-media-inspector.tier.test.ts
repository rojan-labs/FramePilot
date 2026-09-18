/**
 * PX5.9: the host's `/mattes/monitor-tier` call — the pinned artifact and the proxy go out as
 * the engine's request, a busy route is retried on the tier's longer schedule, the timeout is
 * sized from the frame count, and every refusal comes back typed.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DesktopMatteMediaInspector,
  MONITOR_TIER_BUSY_RETRY_DELAYS_MS,
  monitorTierTimeoutMs,
  type MonitorTierRequest,
} from './matte-media-inspector.js';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

const REQUEST: MonitorTierRequest = {
  projectDir: '/projects/demo',
  artifact: {
    key: 'a'.repeat(64),
    files: [
      { name: 'matte.mkv', sha256: '1'.repeat(64) },
      { name: 'foreground.mkv', sha256: '2'.repeat(64) },
      { name: 'frames.json', sha256: '3'.repeat(64) },
    ],
    width: 3840,
    height: 2160,
  },
  proxyPath: 'demo/proxies/shot.mp4',
  rotation: 90,
  frameCount: 5_400,
};

function inspectorWith(responses: Response[]) {
  const bodies: unknown[] = [];
  const routes: string[] = [];
  const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
    routes.push(url.pathname);
    bodies.push(JSON.parse(String(init.body)));
    return responses.shift()!;
  }) as unknown as typeof fetch;
  const slept: number[] = [];
  const inspector = new DesktopMatteMediaInspector({
    ffprobe: 'ffprobe',
    sidecarBaseUrl: 'http://127.0.0.1:1',
    fetch: fetchImpl,
    sleep: async (ms) => void slept.push(ms),
  });
  return { inspector, bodies, routes, slept, fetchImpl };
}

describe('DesktopMatteMediaInspector.deriveMonitorTier', () => {
  it('sends the pins and the picture, and reads the answer', async () => {
    const { inspector, bodies, routes } = inspectorWith([
      json({ status: 'written', width: 540, height: 960, frame_count: 5_400, alpha: true }),
    ]);
    await expect(inspector.deriveMonitorTier(REQUEST)).resolves.toEqual({
      status: 'written',
      width: 540,
      height: 960,
      frameCount: 5_400,
      alpha: true,
    });
    expect(routes).toEqual(['/mattes/monitor-tier']);
    expect(bodies[0]).toEqual({
      project_dir: '/projects/demo',
      artifact: REQUEST.artifact,
      proxy_path: 'demo/proxies/shot.mp4',
      rotation: 90,
    });
  });

  it('waits out a busy route on the tier schedule, then gives up typed', async () => {
    const busy = () => json({ detail: 'A monitor tier is already being made.' }, 503);
    const { inspector, slept } = inspectorWith([
      busy(),
      busy(),
      json({ status: 'current', width: 960, height: 540, frame_count: 5_400, alpha: true }),
    ]);
    await expect(inspector.deriveMonitorTier(REQUEST)).resolves.toMatchObject({
      status: 'current',
    });
    expect(slept).toEqual(MONITOR_TIER_BUSY_RETRY_DELAYS_MS.slice(0, 2));

    const always = inspectorWith(
      Array.from({ length: MONITOR_TIER_BUSY_RETRY_DELAYS_MS.length + 1 }, busy),
    );
    await expect(always.inspector.deriveMonitorTier(REQUEST)).rejects.toMatchObject({
      code: 'tool_unavailable',
    });
    expect(always.fetchImpl).toHaveBeenCalledTimes(MONITOR_TIER_BUSY_RETRY_DELAYS_MS.length + 1);
    // Bounded: about 8 minutes of waiting, never indefinitely.
    const total = MONITOR_TIER_BUSY_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(10 * 60_000);
  });

  it.each([
    [409, 'probe_failed'],
    [422, 'probe_failed'],
    [400, 'probe_failed'],
    [504, 'tool_unavailable'],
  ])('reports HTTP %i as %s', async (status, code) => {
    const { inspector } = inspectorWith([json({ detail: 'no' }, status)]);
    await expect(inspector.deriveMonitorTier(REQUEST)).rejects.toMatchObject({ code });
  });

  it('refuses a malformed answer', async () => {
    const { inspector } = inspectorWith([json({ status: 'written', width: 0 })]);
    await expect(inspector.deriveMonitorTier(REQUEST)).rejects.toMatchObject({
      code: 'probe_failed',
    });
  });

  it('sizes the client timeout from the frame count, beyond the engine deadline', () => {
    expect(monitorTierTimeoutMs(0)).toBe(660_000);
    // A 3-minute 30 fps clip: 600 s + 0.5 s per frame, and a minute more.
    expect(monitorTierTimeoutMs(5_400)).toBe((600 + 2_700 + 60) * 1000);
    expect(monitorTierTimeoutMs(10 ** 9)).toBe((6 * 3600 + 60) * 1000);
  });
});
