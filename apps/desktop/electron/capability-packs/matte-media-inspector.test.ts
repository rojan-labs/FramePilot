import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DesktopMatteMediaInspector,
  parseProbe,
  parseTiming,
  resolveMatteFfprobe,
} from './matte-media-inspector.js';

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

function sidecar(respond: (route: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: { route: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ route, body });
    return respond(route, body);
  }) as unknown as typeof fetch;
  const inspector = new DesktopMatteMediaInspector({
    ffprobe: 'ffprobe',
    sidecarBaseUrl: 'http://127.0.0.1:8799',
    fetch: fetchImpl,
    retryDelaysMs: [],
  });
  return { inspector, calls };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('desktop matte media inspector', () => {
  it('parses probe JSON and packet timing, dropping discarded packets', () => {
    expect(
      parseProbe('{"streams":[{"width":1920,"height":1080,"pix_fmt":"gray","nb_read_packets":"90"}]}', '/x/matte.mkv'),
    ).toEqual({ width: 1920, height: 1080, pixelFormat: 'gray', frameCount: 90 });
    expect(() => parseProbe('{"streams":[]}', '/x/matte.mkv')).toThrow(/Could not read matte.mkv/);
    expect(parseTiming('1/15360\n', '1024,K__\n-512,_D_\n512,___\nN/A,___\n0,___\n', '/m.mp4')).toEqual({
      timeBase: [1, 15360],
      pts: [0, 512, 1024],
    });
    expect(() => parseTiming('0/1', '0,K__', '/m.mp4')).toThrow();
  });

  it('asks the sidecar for frame hashes by pts, in bounded batches, as JSON fields only', async () => {
    const hostile = "/p/it's,a;[movie=/etc/passwd]/shot.mp4";
    const { inspector, calls } = sidecar((_route, body) =>
      json({ hashes: (body.pts as number[]).map((pts) => (pts === 7 ? null : 'a'.repeat(64))) }),
    );
    const pts = Array.from({ length: 300 }, (_, index) => index);
    const hashes = await inspector.frameHashesByPts(hostile, pts);
    expect(hashes).toHaveLength(300);
    expect(hashes[7]).toBeUndefined();
    expect(hashes[8]).toBe('a'.repeat(64));
    expect(calls.map((call) => [call.route, (call.body.pts as number[]).length])).toEqual([
      ['/mattes/frame-hashes', 256],
      ['/mattes/frame-hashes', 44],
    ]);
    expect(calls[0]!.body).toMatchObject({ input_path: hostile, pixel_format: 'native' });
  });

  it('compares locked frames through the sidecar without shipping previous hashes', async () => {
    const { inspector, calls } = sidecar(() => json({ expected: [true, false], carried: [true] }));
    const verdicts = await inspector.compareLockedFrames(
      '/p/.framepilot-derived/mattes/.staging/job/matte.mkv',
      [{ index: 1, sha256: 'b'.repeat(64) }, { index: 2, sha256: 'c'.repeat(64) }],
      { file: '/p/.framepilot-derived/mattes/prev/matte.mkv', carried: [{ index: 3, previousIndex: 4 }] },
    );
    expect(verdicts).toEqual({ expected: [true, false], carried: [true] });
    expect(calls[0]).toEqual({
      route: '/mattes/locked-frames',
      body: {
        matte_path: '/p/.framepilot-derived/mattes/.staging/job/matte.mkv',
        expected: [{ index: 1, sha256: 'b'.repeat(64) }, { index: 2, sha256: 'c'.repeat(64) }],
        previous_matte_path: '/p/.framepilot-derived/mattes/prev/matte.mkv',
        carried: [{ index: 3, previous_index: 4 }],
      },
    });
  });

  it('fails closed: sidecar down, unavailable, refusing, or malformed', async () => {
    const down = sidecar(() => {
      throw new TypeError('fetch failed');
    });
    await expect(down.inspector.frameHashesByPts('/m.mp4', [0])).rejects.toMatchObject({ code: 'tool_unavailable' });
    await expect(sidecar(() => json({ detail: 'x' }, 503)).inspector.compareLockedFrames('/m.mkv', [], undefined)).rejects.toMatchObject({
      code: 'tool_unavailable',
    });
    await expect(sidecar(() => json({ detail: 'outside root' }, 400)).inspector.frameHashesByPts('/m.mp4', [0])).rejects.toMatchObject({
      code: 'probe_failed',
    });
    await expect(sidecar(() => json({ hashes: [] })).inspector.frameHashesByPts('/m.mp4', [0])).rejects.toMatchObject({ code: 'probe_failed' });
    await expect(
      sidecar(() => json({ expected: ['yes'], carried: [] })).inspector.compareLockedFrames('/m.mkv', [{ index: 0, sha256: 'a'.repeat(64) }], undefined),
    ).rejects.toMatchObject({ code: 'probe_failed' });
    const controller = new AbortController();
    controller.abort();
    await expect(sidecar(() => json({ hashes: [] })).inspector.frameHashesByPts('/m.mp4', [0], controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('resolves the app’s own ffprobe: env override, bundled engine folder, then PATH', () => {
    const base = { isPackaged: true, resourcesPath: '/App/Resources', platform: 'darwin' as const };
    expect(resolveMatteFfprobe({ ...base, env: {}, fileExists: () => true })).toBe('/App/Resources/engine/ffprobe');
    expect(resolveMatteFfprobe({ ...base, env: {}, fileExists: () => false })).toBe('ffprobe');
    expect(resolveMatteFfprobe({ ...base, env: { FRAMEPILOT_FFPROBE: '/opt/ffprobe' }, fileExists: () => true })).toBe('/opt/ffprobe');
  });

  it.skipIf(!hasFfmpeg)('probes a real FFV1 matte and lists its timing (local ffprobe)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-inspector-'));
    const matte = path.join(dir, 'matte.mkv');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=32x18:rate=30,format=gray', '-frames:v', '6', '-c:v', 'ffv1', matte]);
    const inspector = new DesktopMatteMediaInspector({ ffprobe: 'ffprobe', sidecarBaseUrl: 'http://127.0.0.1:1', fetch });
    expect(await inspector.probeVideo(matte)).toEqual({ width: 32, height: 18, pixelFormat: 'gray', frameCount: 6 });
    expect((await inspector.videoTiming(matte)).pts).toHaveLength(6);
  });
});

describe('inspector errors carry base names only (BR4.12 L1)', () => {
  it('names the file, never its folder', async () => {
    const inspector = new DesktopMatteMediaInspector({
      ffprobe: 'ffprobe',
      sidecarBaseUrl: 'http://127.0.0.1:1',
      fetch,
      run: async () => ({ exitCode: 1, stdout: '' }),
    });
    const error = await inspector.probeVideo('/Users/editor/Client Secret Film/shot.mov').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'probe_failed' });
    expect(String((error as Error).message)).toBe('Could not read shot.mov.');
  });
});
