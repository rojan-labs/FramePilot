/**
 * Test-only stand-ins for the Smart Mask worker (BR3 does not exist yet) and for ffmpeg.
 *
 * The fake worker writes a structurally valid artifact into the host's staging directory:
 * `matte.mkv` is a small JSON "container" listing one decoded-pixel sha256 per frame, which the
 * fake inspector reads back, so digest, frame-count, size and locked-frame checks all run
 * against real bytes on disk. Scenarios break exactly one rule each.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CapabilityPackWorkerProgress,
  CapabilityPackWorkerRequest,
  CapabilityPackWorkerResult,
} from '@framepilot/capability-packs';
import type { CapabilityPackWorkerRunOptions } from '@framepilot/capability-packs/node';
import { CapabilityPackWorkerRuntimeError } from '@framepilot/capability-packs/node';
import type { MatteMediaInspector, MatteVideoTiming } from '../matte-media-inspector.js';
import { decodeGrayPng, grayPixelSha256 } from '../matte-png.js';

export type FakeMatteScenario =
  | 'ok'
  | 'extra_file'
  | 'symlink'
  | 'wrong_digest'
  | 'misaligned'
  | 'ignore_locks'
  | 'output_unwritable'
  | 'hang';

export interface FakeMatteWorkerOptions {
  readonly scenario?: FakeMatteScenario;
  readonly timing: MatteVideoTiming;
  readonly width?: number;
  readonly height?: number;
  readonly onRequest?: (request: CapabilityPackWorkerRequest) => void;
}

interface FakeContainer {
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: string;
  readonly frames: readonly string[];
}

export function syntheticFrameHash(pts: number, salt = 'alpha'): string {
  return createHash('sha256').update(`${salt}:${pts}`).digest('hex');
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A `runWorker` replacement with the real client's signature. */
export function fakeMatteWorker(options: FakeMatteWorkerOptions) {
  const width = options.width ?? 64;
  const height = options.height ?? 36;
  return async (run: CapabilityPackWorkerRunOptions): Promise<CapabilityPackWorkerResult> => {
    const request = run.request;
    options.onRequest?.(request);
    if (request.capability !== 'subject.matte') {
      throw new Error(`fake matte worker got ${request.capability}`);
    }
    const scenario = options.scenario ?? 'ok';
    if (scenario === 'hang') {
      await new Promise<void>((_resolve, reject) => {
        run.signal?.addEventListener('abort', () =>
          reject(new CapabilityPackWorkerRuntimeError('cancelled', 'Capability Pack request cancelled.')),
        );
      });
    }
    if (scenario === 'output_unwritable') {
      throw new CapabilityPackWorkerRuntimeError('worker_failed', 'No space left on device.', 'output_unwritable');
    }
    const progress = (phase: CapabilityPackWorkerProgress['phase'], completed: number, total: number): void =>
      run.onProgress?.({
        type: 'progress',
        protocolVersion: 1,
        requestId: request.requestId,
        phase,
        completed,
        total,
      });
    const { media, parameters } = request;
    const firstFrame = media.firstFrame;
    const count = media.lastFrameExclusive - media.firstFrame;
    const pts = options.timing.pts.slice(firstFrame, firstFrame + count);
    progress('decode', 0, count);
    const lockedHash = new Map<number, string>();
    for (const prompt of parameters.prompts) {
      if (prompt.kind !== 'lock' || parameters.inputs === undefined) continue;
      const bytes = await readFile(path.join(parameters.inputs.absolutePath, prompt.file));
      lockedHash.set(prompt.pts, grayPixelSha256(decodeGrayPng(bytes)));
    }
    let previous: Map<number, string> | undefined;
    if (parameters.inputs?.files.includes('previous/matte.mkv') === true) {
      const container = JSON.parse(
        await readFile(path.join(parameters.inputs.absolutePath, 'previous', 'matte.mkv'), 'utf8'),
      ) as FakeContainer;
      const frames = JSON.parse(
        await readFile(path.join(parameters.inputs.absolutePath, 'previous', 'frames.json'), 'utf8'),
      ) as { pts: number[] };
      previous = new Map(frames.pts.map((value, index) => [value, container.frames[index]!]));
    }
    const salt = `${parameters.prompts.map((prompt) => prompt.kind).join('+')}:${parameters.previousArtifact ?? 'first'}`;
    const frameHashes = pts.map((value) => {
      if (scenario !== 'ignore_locks' && lockedHash.has(value)) return lockedHash.get(value)!;
      if (scenario !== 'ignore_locks' && previous?.has(value) === true) return previous.get(value)!;
      return syntheticFrameHash(value, salt);
    });
    progress('matte', count, count);
    const dir = parameters.output.absolutePath;
    const container: FakeContainer = { width, height, pixelFormat: 'gray', frames: frameHashes };
    const files: Record<string, string> = {
      'matte.mkv': JSON.stringify(container),
      'frames.json': JSON.stringify({
        version: 1,
        timeBase: options.timing.timeBase,
        originPts: options.timing.pts[0],
        firstFrame,
        pts: scenario === 'misaligned' ? pts.map((value) => value + 1) : pts,
      }),
      'report.json': JSON.stringify({ frames: count }),
    };
    if (parameters.output.allowedFiles.includes('foreground.mkv')) {
      files['foreground.mkv'] = JSON.stringify({ ...container, pixelFormat: 'gbrp' });
    }
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(dir, name), body);
    }
    if (scenario === 'extra_file') await writeFile(path.join(dir, 'run.sh'), 'echo pwned');
    const descriptorFiles = [];
    for (const [name, body] of Object.entries(files)) {
      const bytes = (await lstat(path.join(dir, name))).size;
      descriptorFiles.push({
        name: name as 'matte.mkv',
        bytes,
        sha256: scenario === 'wrong_digest' && name === 'matte.mkv' ? '0'.repeat(64) : sha256(body),
      });
    }
    if (scenario === 'symlink') {
      // The claim stays right; the file on disk becomes a link out of the staging directory.
      await rm(path.join(dir, 'report.json'));
      await symlink('/etc/hosts', path.join(dir, 'report.json'));
    }
    return {
      type: 'result',
      protocolVersion: 1,
      requestId: request.requestId,
      projectRevision: request.projectRevision,
      capability: 'subject.matte',
      backend: 'fake-smart-mask',
      modelDigests: { sam: 'a'.repeat(64) },
      artifact: {
        files: descriptorFiles,
        width,
        height,
        frameCount: count,
        firstPts: pts[0]!,
        lastPts: pts[pts.length - 1]!,
        timeBase: [options.timing.timeBase[0], options.timing.timeBase[1]],
      },
      executionProvider: 'cpu',
      summary: { verifiedFrames: count - 1, flaggedFrames: 1, lockedFrames: lockedHash.size, selfCorrectionRounds: 1 },
      needsReview: [{ startPts: pts[0]!, endPts: pts[0]!, reason: 'occlusion' }],
    };
  };
}

export interface FakeSourceMedia {
  readonly timing: MatteVideoTiming;
  readonly width?: number;
  readonly height?: number;
  /** Decoded-frame hash per pts; defaults to `syntheticFrameHash(pts, 'source')`. */
  readonly frameHash?: (pts: number) => string | undefined;
}

/** Inspector over fake containers plus declared source media. */
export function fakeMatteInspector(sources: ReadonlyMap<string, FakeSourceMedia>): MatteMediaInspector & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  const container = async (file: string): Promise<FakeContainer> =>
    JSON.parse(await readFile(file, 'utf8')) as FakeContainer;
  return {
    calls,
    async probeVideo(file) {
      calls.push(`probe:${path.basename(file)}`);
      const source = sources.get(file);
      if (source !== undefined) {
        return { width: source.width ?? 64, height: source.height ?? 36, pixelFormat: 'yuv420p', frameCount: source.timing.pts.length };
      }
      const parsed = await container(file);
      return { width: parsed.width, height: parsed.height, pixelFormat: parsed.pixelFormat, frameCount: parsed.frames.length };
    },
    async videoTiming(file) {
      calls.push(`timing:${path.basename(file)}`);
      const source = sources.get(file);
      if (source === undefined) throw new Error('no timing for this file');
      return source.timing;
    },
    async compareLockedFrames(file, expected, previous) {
      calls.push(`locked:${path.basename(file)}`);
      const parsed = await container(file);
      const before = previous === undefined ? undefined : await container(previous.file);
      return {
        expected: expected.map((check) => parsed.frames[check.index] === check.sha256),
        carried: (previous?.carried ?? []).map(
          (check) => parsed.frames[check.index] !== undefined && parsed.frames[check.index] === before?.frames[check.previousIndex],
        ),
      };
    },
    async frameHashesByPts(file, pts) {
      calls.push(`hashPts:${path.basename(file)}`);
      const source = sources.get(file);
      if (source === undefined) throw new Error('no source for this file');
      return pts.map((value) => (source.frameHash ?? ((p: number) => syntheticFrameHash(p, 'source')))(value));
    },
  };
}

export function constantRateTiming(frames: number, step = 512, timeBase: readonly [number, number] = [1, 15360]): MatteVideoTiming {
  return { timeBase, pts: Array.from({ length: frames }, (_, index) => index * step) };
}
