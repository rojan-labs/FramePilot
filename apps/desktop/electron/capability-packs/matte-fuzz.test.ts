/**
 * BR4.12 fuzzed inputs against the desktop matte host: typed errors, main-process event loop kept
 * responsive (≤ 250 ms delay), nothing followed or committed. Everything is generated at test time.
 *
 * Adversarial fake-worker variants live next to the code they attack: lingering child
 * (`worker-client.test.ts`), memory growth, silence and ceiling overrun (`matte.test.ts`, host
 * watchdog), and the symlink swap after the result (below and `matte-staging.test.ts`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { InstalledCapabilityPack } from '@framepilot/capability-packs';
import type { Project } from '@framepilot/timeline-schema';
import { constantRateTiming, fakeMatteInspector, fakeMatteWorker } from './__fixtures__/fake-matte-worker.js';
import { CapabilityPackMatteService, SMART_MASK_PACK_ID } from './matte.js';
import { DesktopMatteMediaInspector, MatteInspectorError } from './matte-media-inspector.js';
import { decodeGrayPng, encodeGrayPng, MattePngError, pngChunk } from './matte-png.js';
import { matteStagingRoot } from './matte-staging.js';
import { MatteStoreError, saveMatteInput } from './matte-store.js';
import { MatteVerificationError, readMatteFrames } from './matte-verify.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EVENT_LOOP_DELAY_BOUND_MS = 250;

function ihdr(width: number, height: number): Buffer {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(width, 0);
  body.writeUInt32BE(height, 4);
  body[8] = 8;
  return pngChunk('IHDR', body);
}

/** The PNG set from the review: bad CRC, IDAT bomb, trailing data, ancillary, oversize, duplicate IHDR. */
function pngCorpus(): Record<string, Buffer> {
  const valid = encodeGrayPng(64, 36, new Uint8Array(64 * 36));
  const badCrc = Buffer.from(valid);
  badCrc[20] = (badCrc[20] ?? 0) ^ 0x55;
  const idat = (raw: Buffer) => pngChunk('IDAT', deflateSync(raw, { level: 9 }));
  const end = pngChunk('IEND', Buffer.alloc(0));
  return {
    bad_crc: badCrc,
    idat_bomb: Buffer.concat([SIGNATURE, ihdr(64, 36), idat(Buffer.alloc(64 * 1024 * 1024)), end]),
    trailing_data: Buffer.concat([valid, Buffer.alloc(4096, 0x41)]),
    ancillary_chunks: Buffer.concat([SIGNATURE, ihdr(64, 36), pngChunk('tEXt', Buffer.from('k\0v')), idat(Buffer.alloc(65 * 36)), end]),
    oversize: Buffer.concat([SIGNATURE, ihdr(8192, 8192), idat(Buffer.alloc(8193)), end]),
    duplicate_ihdr: Buffer.concat([SIGNATURE, ihdr(64, 36), ihdr(64, 36), idat(Buffer.alloc(65 * 36)), end]),
  };
}

async function framesCorpus(root: string): Promise<Record<string, string>> {
  const valid = { version: 1, timeBase: [1, 30], originPts: 0, firstFrame: 0, pts: [0, 1] };
  const cases: Record<string, Buffer | number> = {
    over_64mb: 64 * 1024 * 1024 + 1,
    deep_nesting: Buffer.from(`${'['.repeat(200_000)}${']'.repeat(200_000)}`),
    float_overflow: Buffer.from(JSON.stringify({ ...valid, pts: [0] }).replace('[0]', '[1e400]')),
    non_integer: Buffer.from(JSON.stringify({ ...valid, pts: [0, 1.5] })),
    bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(valid))]),
    huge_integer: Buffer.from(JSON.stringify(valid).replace('[0,1]', '[0,1000000000000000000000000000000]')),
  };
  const out: Record<string, string> = {};
  for (const [name, content] of Object.entries(cases)) {
    const folder = path.join(root, name);
    await import('node:fs/promises').then((fs) => fs.mkdir(folder));
    const file = path.join(folder, 'frames.json');
    if (typeof content === 'number') {
      const { open } = await import('node:fs/promises');
      const handle = await open(file, 'w');
      await handle.truncate(content); // sparse: costs no disk
      await handle.close();
    } else {
      await writeFile(file, content);
    }
    out[name] = folder;
  }
  return out;
}

async function withEventLoopBound<T>(run: () => Promise<T>): Promise<T> {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  try {
    return await run();
  } finally {
    histogram.disable();
    expect(histogram.max / 1e6).toBeLessThanOrEqual(EVENT_LOOP_DELAY_BOUND_MS);
  }
}

describe('matte host fuzz corpus (BR4.12)', () => {
  it('refuses every hostile correction PNG with a typed error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-fuzz-png-'));
    await withEventLoopBound(async () => {
      for (const [name, bytes] of Object.entries(pngCorpus())) {
        expect(() => decodeGrayPng(bytes, { expectedWidth: 64, expectedHeight: 36 }), name).toThrow(MattePngError);
        await expect(saveMatteInput(dir, bytes, { width: 64, height: 36, kind: 'lock' }), name).rejects.toBeInstanceOf(MatteStoreError);
        // Yield between cases, as IPC would.
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
  });

  it('refuses every hostile frames.json with frames_invalid', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'framepilot-fuzz-frames-'));
    const corpus = await framesCorpus(root);
    await withEventLoopBound(async () => {
      for (const [name, folder] of Object.entries(corpus)) {
        const error = await readMatteFrames(folder).catch((caught: unknown) => caught);
        expect(error, name).toBeInstanceOf(MatteVerificationError);
        expect((error as MatteVerificationError).code, name).toBe('frames_invalid');
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasFfmpeg)('probes hostile media with typed results and never follows a playlist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-fuzz-media-'));
    const real = path.join(dir, 'real.mkv');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=30', '-frames:v', '6', '-c:v', 'ffv1', real]);
    const truncated = path.join(dir, 'truncated.mkv');
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(real);
    await writeFile(truncated, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
    const hls = path.join(dir, 'playlist.mp4');
    await writeFile(hls, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${real}\n#EXT-X-ENDLIST\n`);
    const concat = path.join(dir, 'concat.mov');
    await writeFile(concat, `ffconcat version 1.0\nfile '${real}'\n`);
    const huge = path.join(dir, 'huge.png');
    await writeFile(huge, Buffer.concat([SIGNATURE, ihdr(60_000, 60_000), pngChunk('IDAT', deflateSync(Buffer.alloc(64))), pngChunk('IEND', Buffer.alloc(0))]));
    const inspector = new DesktopMatteMediaInspector({ ffprobe: 'ffprobe', sidecarBaseUrl: 'http://127.0.0.1:1', fetch });
    await withEventLoopBound(async () => {
      for (const file of [truncated, hls, concat, huge]) {
        const probe = await inspector.probeVideo(file).catch((caught: unknown) => caught);
        const timing = await inspector.videoTiming(file).catch((caught: unknown) => caught);
        for (const outcome of [probe, timing]) {
          if (outcome instanceof Error) {
            expect(outcome, file).toBeInstanceOf(MatteInspectorError);
            expect(outcome.message).not.toContain(dir);
          }
        }
        if (file === hls || file === concat) {
          // The playlist must not have been resolved to the real file's six frames.
          expect(probe instanceof MatteInspectorError || (probe as { frameCount: number }).frameCount !== 6, file).toBe(true);
        }
      }
    });
  });

  it('refuses a symlink swapped in after the worker returned, before commit', async () => {
    const TIMING = constantRateTiming(30);
    const projectDir = await mkdtemp(path.join(tmpdir(), 'framepilot-fuzz-swap-'));
    const mediaPath = path.join(projectDir, 'shot.mp4');
    await writeFile(mediaPath, 'bytes');
    const record = {
      identity: { id: SMART_MASK_PACK_ID, version: '1.0.0', releaseDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64), os: 'darwin', arch: 'arm64' },
      state: 'installed',
      installRelativePath: 'x',
      installedBytes: 1,
      installedAt: '2026-09-17T00:00:00.000Z',
      lastUsedAt: '2026-09-17T00:00:00.000Z',
      pinnedProjectIds: [],
      activeLeaseCount: 0,
      health: { checkedAt: '2026-09-17T00:00:00.000Z', workerProtocolVersion: 1, status: 'healthy' },
      acquisition: { catalogDigest: 'c'.repeat(64), approvedAt: '2026-09-17T00:00:00.000Z', licenseSpdx: ['MIT'], mediaEgressApproved: false },
    } as InstalledCapabilityPack;
    const service = new CapabilityPackMatteService({
      storageRoot: '/packs',
      store: { list: async () => [record], acquireLease: async () => ({ release: async () => undefined }) as never },
      platform: { os: 'darwin', arch: 'arm64' },
      propose: async () => ({ ok: false, code: 'x', error: 'x' }),
      inspector: fakeMatteInspector(new Map([[mediaPath, { timing: TIMING }]])),
      runWorker: fakeMatteWorker({ timing: TIMING }),
      isFile: async () => true,
      freeDiskBytes: async () => Number.MAX_SAFE_INTEGER,
      watchdog: { footprintBytes: async () => 1024, killGroup: () => undefined },
    });
    const project = { assets: [{ id: 'asset-1', path: mediaPath, kind: 'video', media: { width: 64, height: 36 } }], timeline: { tracks: [], revision: 0 } } as unknown as Project;
    const outcome = await service.run(
      {
        requestId: 'swap',
        assetId: 'asset-1',
        sourceStart: 0,
        sourceEnd: 0.5,
        prompts: [{ kind: 'box', sourceTime: 0, box: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }],
        foreground: false,
        timelineRevision: 0,
      },
      {
        projectDir,
        project,
        projectRevision: 0,
        // Runs after verification and before the commit: the attacker's window.
        readCurrent: async () => {
          const staged = path.join(matteStagingRoot(projectDir), 'swap', 'report.json');
          await rm(staged);
          await symlink('/etc/hosts', staged);
          return { revision: 0, project };
        },
      },
    );
    expect(outcome).toMatchObject({ status: 'failed', code: 'verification_failed', verificationCode: 'changed_after_verify' });
  });
});
