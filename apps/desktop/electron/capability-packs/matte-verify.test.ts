import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CapabilityPackWorkerRequest, MatteArtifactFileName } from '@framepilot/capability-packs';
import {
  constantRateTiming,
  fakeMatteInspector,
  fakeMatteWorker,
  syntheticFrameHash,
  type FakeMatteScenario,
} from './__fixtures__/fake-matte-worker.js';
import { MatteInspectorError } from './matte-media-inspector.js';
import { encodeGrayPng, decodeGrayPng, grayPixelSha256 } from './matte-png.js';
import { commitMatteStaging, createMatteStaging, matteArtifactDirectory } from './matte-staging.js';
import {
  matteByteCeiling,
  parseMatteFrames,
  verifyMatteStaging,
  type MatteVerificationInput,
  type SubjectMatteResult,
} from './matte-verify.js';

const TIMING = constantRateTiming(30);
const ALLOWED: MatteArtifactFileName[] = ['matte.mkv', 'frames.json', 'report.json'];

async function stage(
  scenario: FakeMatteScenario = 'ok',
  options: { firstFrame?: number; count?: number; lockPixels?: Uint8Array; previousDir?: string; jobId?: string; project?: string } = {},
) {
  const project = options.project ?? (await mkdtemp(path.join(tmpdir(), 'framepilot-matte-verify-')));
  const staging = await createMatteStaging(project, options.jobId ?? 'job');
  const firstFrame = options.firstFrame ?? 5;
  const count = options.count ?? 10;
  const inputFiles: string[] = [];
  const prompts: unknown[] = [{ kind: 'box', pts: TIMING.pts[firstFrame], box: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }];
  if (options.lockPixels !== undefined) {
    const lockPts = TIMING.pts[firstFrame + 2]!;
    await staging.writeInput(`locked/${lockPts}.png`, encodeGrayPng(4, 3, options.lockPixels));
    inputFiles.push(`locked/${lockPts}.png`);
    prompts.push({ kind: 'lock', pts: lockPts, file: `locked/${lockPts}.png` });
  }
  if (options.previousDir !== undefined) {
    inputFiles.push(...(await staging.clonePrevious(options.previousDir, ['matte.mkv', 'frames.json'])));
  }
  const inputs = staging.inputHandle(inputFiles);
  const request = {
    type: 'request',
    protocolVersion: 1,
    requestId: 'job',
    projectRevision: 1,
    capability: 'subject.matte',
    media: {
      handleId: 'm', assetId: 'a', absolutePath: '/media/shot.mp4',
      sourceStartSeconds: firstFrame / 30, sourceEndSeconds: (firstFrame + count) / 30, fps: 30,
      firstFrame, lastFrameExclusive: firstFrame + count,
    },
    parameters: {
      output: staging.outputHandle(ALLOWED, 10_000_000),
      ...(inputs === undefined ? {} : { inputs }),
      prompts,
      ...(options.previousDir === undefined ? {} : { previousArtifact: 'b'.repeat(64) }),
      previewHeight: 180,
    },
  } as CapabilityPackWorkerRequest;
  const result = (await fakeMatteWorker({ scenario, timing: TIMING })({
    entrypoint: '/fake', mediaRoot: '/media', request,
  })) as SubjectMatteResult;
  const input: MatteVerificationInput = {
    directory: staging.directory,
    result,
    allowedFiles: ALLOWED,
    maxBytes: 10_000_000,
    expectedSize: { width: 64, height: 36 },
    source: { timing: TIMING, firstFrame, frameCount: count },
    locks: options.lockPixels === undefined ? [] : [{ pts: TIMING.pts[firstFrame + 2]!, pixelSha256: grayPixelSha256(decodeGrayPng(encodeGrayPng(4, 3, options.lockPixels))) }],
    inspector: fakeMatteInspector(new Map()),
  };
  return { project, staging, result, input };
}

describe('host matte verification', () => {
  it('accepts a valid artifact and reports host-measured files and frames', async () => {
    const { input } = await stage();
    const verified = await verifyMatteStaging(input);
    expect(verified.files.map((file) => file.name).sort()).toEqual(['frames.json', 'matte.mkv', 'report.json']);
    expect(verified.frames).toMatchObject({ firstFrame: 5, originPts: 0, timeBase: [1, 15360] });
    expect(verified.frames.pts).toEqual(TIMING.pts.slice(5, 15));
  });

  it.each([
    ['extra_file', 'undeclared_file'],
    ['symlink', 'undeclared_file'],
    ['wrong_digest', 'digest_mismatch'],
    ['misaligned', 'frames_misaligned'],
  ] as const)('refuses the %s scenario with %s', async (scenario, code) => {
    const { input } = await stage(scenario);
    await expect(verifyMatteStaging(input)).rejects.toMatchObject({ code });
  });

  it('refuses a byte ceiling breach, a size lie and a file not on the allow list', async () => {
    const { input } = await stage();
    await expect(verifyMatteStaging({ ...input, maxBytes: 10 })).rejects.toMatchObject({ code: 'byte_ceiling_exceeded' });
    const lied = {
      ...input.result,
      artifact: {
        ...input.result.artifact,
        files: input.result.artifact.files.map((file) => (file.name === 'report.json' ? { ...file, bytes: file.bytes + 1 } : file)),
      },
    };
    await expect(verifyMatteStaging({ ...input, result: lied })).rejects.toMatchObject({ code: 'size_mismatch' });
    await expect(
      verifyMatteStaging({ ...input, allowedFiles: ['matte.mkv', 'frames.json'] }),
    ).rejects.toMatchObject({ code: 'undeclared_file' });
  });

  it('refuses frames that do not cover exactly the requested source frames', async () => {
    const { input } = await stage();
    await expect(
      verifyMatteStaging({ ...input, source: { ...input.source, firstFrame: 4 } }),
    ).rejects.toMatchObject({ code: 'frames_misaligned' });
    const vfr = { timeBase: TIMING.timeBase, pts: TIMING.pts.map((pts, index) => (index === 7 ? pts + 3 : pts)) };
    await expect(
      verifyMatteStaging({ ...input, source: { ...input.source, timing: vfr } }),
    ).rejects.toMatchObject({ code: 'frames_misaligned' });
    await expect(
      verifyMatteStaging({ ...input, source: { ...input.source, timing: { ...TIMING, timeBase: [1, 30000] } } }),
    ).rejects.toMatchObject({ code: 'frames_misaligned' });
  });

  it('refuses a matte not at the display size and a probe that disagrees with frames.json', async () => {
    const { input, staging } = await stage();
    await expect(
      verifyMatteStaging({ ...input, expectedSize: { width: 36, height: 64 } }),
    ).rejects.toMatchObject({ code: 'probe_mismatch' });
    const inspector = fakeMatteInspector(new Map());
    await expect(
      verifyMatteStaging({
        ...input,
        inspector: { ...inspector, probeVideo: async () => ({ width: 64, height: 36, pixelFormat: 'yuv420p', frameCount: 10 }) },
      }),
    ).rejects.toMatchObject({ code: 'pixel_format_unsupported' });
    await expect(
      verifyMatteStaging({
        ...input,
        inspector: { ...inspector, probeVideo: async () => ({ width: 64, height: 36, pixelFormat: 'gray', frameCount: 9 }) },
      }),
    ).rejects.toMatchObject({ code: 'frames_misaligned' });
    expect(staging.directory).toContain('.staging');
  });

  it('proves locked frames bit-identical to their inputs', async () => {
    const lock = Uint8Array.from([0, 255, 255, 0, 128, 128, 255, 0, 0, 255, 255, 255]);
    const { input } = await stage('ok', { lockPixels: lock });
    await expect(verifyMatteStaging(input)).resolves.toBeDefined();
    const broken = await stage('ignore_locks', { lockPixels: lock });
    await expect(verifyMatteStaging(broken.input)).rejects.toMatchObject({ code: 'locked_frame_changed' });
    await expect(
      verifyMatteStaging({ ...input, locks: [{ pts: 999_999, pixelSha256: 'f'.repeat(64) }] }),
    ).rejects.toMatchObject({ code: 'locked_frame_changed' });
  });

  it('proves frames locked on the previous artifact survive a partial re-run', async () => {
    const first = await stage('ok');
    await verifyMatteStaging(first.input);
    await commitMatteStaging(first.project, first.staging, 'c'.repeat(64));
    const previousDir = matteArtifactDirectory(first.project, 'c'.repeat(64))!;
    const previousFrames = parseMatteFrames(JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(path.join(previousDir, 'frames.json'), 'utf8'))));
    const lockedPts = [TIMING.pts[6]!];
    const rerun = await stage('ok', { previousDir, project: first.project, jobId: 'rerun' });
    await expect(
      verifyMatteStaging({ ...rerun.input, previous: { directory: previousDir, frames: previousFrames, lockedPts } }),
    ).resolves.toBeDefined();
    const bad = await stage('ignore_locks', { previousDir, project: first.project, jobId: 'bad' });
    await expect(
      verifyMatteStaging({ ...bad.input, previous: { directory: previousDir, frames: previousFrames, lockedPts } }),
    ).rejects.toMatchObject({ code: 'locked_frame_changed' });
  });

  it('fails closed when the host cannot decode frames', async () => {
    const lock = new Uint8Array(12);
    const { input } = await stage('ok', { lockPixels: lock });
    const inspector = fakeMatteInspector(new Map());
    await expect(
      verifyMatteStaging({
        ...input,
        inspector: {
          ...inspector,
          compareLockedFrames: async () => {
            throw new MatteInspectorError('tool_unavailable', 'engine down');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'verification_unavailable' });
  });

  it('parses frames.json exactly like the engine', async () => {
    const good = { version: 1, timeBase: [1, 15360], originPts: 0, firstFrame: 0, pts: [0, 512] };
    expect(parseMatteFrames(good).pts).toEqual([0, 512]);
    for (const bad of [
      { ...good, version: 2 },
      { ...good, timeBase: [0, 1] },
      { ...good, originPts: 1.5 },
      { ...good, firstFrame: -1 },
      { ...good, pts: [] },
      { ...good, pts: [0, 0] },
      [],
    ]) {
      expect(() => parseMatteFrames(bad)).toThrow();
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-frames-'));
    await writeFile(path.join(dir, 'frames.json'), 'not json');
    await expect(import('./matte-verify.js').then((m) => m.readMatteFrames(dir))).rejects.toMatchObject({ code: 'frames_invalid' });
    expect(syntheticFrameHash(1)).toHaveLength(64);
  });

  it('bounds the byte ceiling by frames x pixels, more with foreground', () => {
    expect(matteByteCeiling(1920, 1080, 300, true)).toBeGreaterThan(matteByteCeiling(1920, 1080, 300, false));
    expect(matteByteCeiling(1920, 1080, 300, false)).toBeGreaterThan(1920 * 1080 * 300);
  });
});
