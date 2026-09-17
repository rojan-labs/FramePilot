import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FfmpegMatteMediaInspector,
  parseFramehash,
  parseProbe,
  parseTiming,
  resolveMatteMediaTools,
  type CommandRunner,
} from './matte-media-inspector.js';

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

describe('matte media inspector', () => {
  it('parses probe JSON, packet timing (dropping discarded packets) and framehash rows', () => {
    expect(
      parseProbe('{"streams":[{"width":1920,"height":1080,"pix_fmt":"gray","nb_read_packets":"90"}]}', '/x/matte.mkv'),
    ).toEqual({ width: 1920, height: 1080, pixelFormat: 'gray', frameCount: 90 });
    expect(() => parseProbe('{"streams":[]}', '/x/matte.mkv')).toThrow(/Could not read matte.mkv/);
    expect(parseTiming('1/15360\n', '1024,K__\n-512,_D_\n512,___\nN/A,___\n0,___\n', '/m.mp4')).toEqual({
      timeBase: [1, 15360],
      pts: [0, 512, 1024],
    });
    expect(() => parseTiming('0/1', '0,K__', '/m.mp4')).toThrow();
    const hash = 'a'.repeat(64);
    expect(parseFramehash(`#tb 0: 1/15360\n0,      22528,      22528,      512,    86400, ${hash}\n`)).toEqual([
      { pts: 22528, hash },
    ]);
  });

  it('passes every path as its own argv element and builds select from integers only', async () => {
    const calls: { executable: string; args: readonly string[] }[] = [];
    const run: CommandRunner = async (executable, args) => {
      calls.push({ executable, args });
      return { exitCode: 0, stdout: `0, 0, 0, 1, 4, ${'b'.repeat(64)}\n0, 1, 1, 1, 4, ${'c'.repeat(64)}\n` };
    };
    const inspector = new FfmpegMatteMediaInspector({ ffprobe: '/bin/ffprobe', ffmpeg: '/bin/ffmpeg', run });
    const hostile = "/p/it's,a;[movie=/etc/passwd]/matte.mkv";
    expect(await inspector.frameHashesByIndex(hostile, [7, 3], 'gray')).toEqual(['c'.repeat(64), 'b'.repeat(64)]);
    const args = calls[0]!.args;
    expect(args[args.indexOf('-i') + 1]).toBe(hostile);
    expect(args[args.indexOf('-vf') + 1]).toBe('select=eq(n\\,3)+eq(n\\,7)');
    await expect(inspector.frameHashesByIndex('/m.mkv', [-1], 'gray')).rejects.toThrow(RangeError);
    await expect(
      new FfmpegMatteMediaInspector({ ffprobe: '/bin/ffprobe', run }).frameHashesByIndex('/m.mkv', [1], 'gray'),
    ).rejects.toMatchObject({ code: 'tool_unavailable' });
  });

  it('treats a seek that lands on another pts as a changed frame', async () => {
    const run: CommandRunner = async () => ({ exitCode: 0, stdout: `0, 1, 1024, 512, 4, ${'d'.repeat(64)}\n` });
    const inspector = new FfmpegMatteMediaInspector({ ffprobe: 'ffprobe', ffmpeg: 'ffmpeg', run });
    expect(await inspector.frameHashesByPts('/m.mp4', { timeBase: [1, 15360], pts: [0, 512, 1024] }, [1024, 512])).toEqual([
      'd'.repeat(64),
      undefined,
    ]);
  });

  it('resolves the app’s own tools: env override, bundled engine folder, then PATH in development', () => {
    const base = { isPackaged: true, resourcesPath: '/App/Resources', platform: 'darwin' as const };
    expect(resolveMatteMediaTools({ ...base, env: {}, fileExists: () => true })).toEqual({
      ffprobe: '/App/Resources/engine/ffprobe',
      ffmpeg: '/App/Resources/engine/ffmpeg',
    });
    expect(resolveMatteMediaTools({ ...base, env: {}, fileExists: (file) => file.endsWith('ffprobe') })).toEqual({
      ffprobe: '/App/Resources/engine/ffprobe',
    });
    expect(
      resolveMatteMediaTools({ ...base, isPackaged: false, env: { FRAMEPILOT_FFMPEG: '/opt/ffmpeg' }, fileExists: () => false }),
    ).toEqual({ ffprobe: 'ffprobe', ffmpeg: '/opt/ffmpeg' });
  });

  it.skipIf(!hasFfmpeg)('hashes real decoded frames identically to raw pixels (local ffmpeg)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-inspector-'));
    const matte = path.join(dir, 'matte.mkv');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=32x18:rate=30,format=gray', '-frames:v', '6', '-c:v', 'ffv1', matte]);
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', matte, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
    const frame = (index: number) => createHash('sha256').update(raw.subarray(index * 32 * 18, (index + 1) * 32 * 18)).digest('hex');
    const inspector = new FfmpegMatteMediaInspector({ ffprobe: 'ffprobe', ffmpeg: 'ffmpeg' });
    expect(await inspector.probeVideo(matte)).toEqual({ width: 32, height: 18, pixelFormat: 'gray', frameCount: 6 });
    const timing = await inspector.videoTiming(matte);
    expect(timing.pts).toHaveLength(6);
    expect(await inspector.frameHashesByIndex(matte, [4, 1], 'gray')).toEqual([frame(4), frame(1)]);
    const byPts = await inspector.frameHashesByPts(matte, timing, [timing.pts[2]!]);
    expect(byPts[0]).toMatch(/^[0-9a-f]{64}$/u);
  });
});
