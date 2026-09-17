/**
 * Host verification of a matte job's staging directory, independent of the worker's claims.
 *
 * The worker says what it wrote; nothing it says is taken on trust before the rename into the
 * project (plan 03, MD-3). In order, cheapest first:
 *
 * 1. Only declared, allowed, regular files exist (plus the host's own `inputs/`). A link, a
 *    sub-folder, or any other name refuses the artifact.
 * 2. Byte sizes match the claim and the total stays under the job's ceiling.
 * 3. sha256 of every file matches the claim (these digests are what the mask pins).
 * 4. `frames.json` is the engine's format (`render/mattes.py`) and its pts are EXACTLY the
 *    source's decoded pts over the requested frames (same time base and clock origin).
 * 5. ffprobe: matte and foreground size equal the expected display size, pixel formats are
 *    ones the engine reads, and frame counts equal `frames.json`.
 * 6. Locked frames: the decoded matte frame is bit-identical to the locked input, and to the
 *    previous artifact's frame at that pts when one exists.
 *
 * Codes are stable and never carry magnitudes (see the error-text-is-a-guard-key lesson).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityPackWorkerResult, MatteArtifactFileName } from '@framepilot/capability-packs';
import { MatteInspectorError, type MatteMediaInspector, type MatteVideoTiming } from './matte-media-inspector.js';

export type SubjectMatteResult = Extract<CapabilityPackWorkerResult, { capability: 'subject.matte' }>;

export const MATTE_FRAMES_VERSION = 1;
/** frames.json is small (one integer per frame); anything bigger is not a frames document. */
const FRAMES_MAX_BYTES = 64 * 1024 * 1024;
/** Pixel formats `render/mattes.py` reads. */
export const MATTE_PIXEL_FORMATS: ReadonlySet<string> = new Set(['gray', 'gray16le']);
export const FOREGROUND_PIXEL_FORMATS: ReadonlySet<string> = new Set(['gbrp', 'bgr0', 'rgb24', 'bgra', 'rgba', '0rgb']);
/** Worst-case FFV1 bytes per raw byte, plus container overhead headroom. */
const FFV1_BOUND = 1.1;
const PREVIEW_AND_JSON_ALLOWANCE_BYTES = 256 * 1024 * 1024;

export type MatteVerificationCode =
  | 'undeclared_file'
  | 'missing_required_file'
  | 'byte_ceiling_exceeded'
  | 'size_mismatch'
  | 'digest_mismatch'
  | 'frames_invalid'
  | 'frames_misaligned'
  | 'probe_mismatch'
  | 'pixel_format_unsupported'
  | 'locked_frame_changed'
  | 'verification_unavailable';

export class MatteVerificationError extends Error {
  public constructor(
    public readonly code: MatteVerificationCode,
    message: string,
  ) {
    super(message);
    this.name = 'MatteVerificationError';
  }
}

/** The parsed `frames.json`. */
export interface MatteFramesDocument {
  readonly version: 1;
  readonly timeBase: readonly [number, number];
  readonly originPts: number;
  readonly firstFrame: number;
  readonly pts: readonly number[];
}

export interface VerifiedMatteFile {
  readonly name: MatteArtifactFileName;
  readonly bytes: number;
  readonly sha256: string;
}

export interface VerifiedMatteArtifact {
  readonly files: readonly VerifiedMatteFile[];
  readonly frames: MatteFramesDocument;
  readonly width: number;
  readonly height: number;
  readonly matteBytes: number;
}

export interface MatteLockCheck {
  readonly pts: number;
  /** sha256 of the locked input's decoded 8-bit pixels. */
  readonly pixelSha256: string;
}

export interface MatteVerificationInput {
  readonly directory: string;
  readonly result: SubjectMatteResult;
  readonly allowedFiles: readonly MatteArtifactFileName[];
  readonly maxBytes: number;
  /** The artifact must be written at the source's display size (BR2.6), when measured. */
  readonly expectedSize?: { readonly width: number; readonly height: number };
  /** The source's decoded timing and the frames this job was asked for. */
  readonly source: {
    readonly timing: MatteVideoTiming;
    readonly firstFrame: number;
    readonly frameCount: number;
  };
  readonly locks: readonly MatteLockCheck[];
  /** Frames locked on the previous artifact must survive a re-run bit for bit. */
  readonly previous?: {
    readonly directory: string;
    readonly frames: MatteFramesDocument;
    readonly lockedPts: readonly number[];
  };
  readonly inspector: MatteMediaInspector;
  readonly signal?: AbortSignal;
}

/**
 * The byte ceiling one job may write: frames x pixels x an FFV1 bound, plus RGB foreground
 * when requested, plus a fixed allowance for previews and JSON.
 */
export function matteByteCeiling(width: number, height: number, frameCount: number, foreground: boolean): number {
  const pixels = width * height * frameCount;
  const rawBytes = pixels * (foreground ? 1 + 3 : 1);
  return Math.ceil(rawBytes * FFV1_BOUND) + PREVIEW_AND_JSON_ALLOWANCE_BYTES;
}

/** Validate a `frames.json` document exactly as `render/mattes.py::parse_frames` does. */
export function parseMatteFrames(document: unknown): MatteFramesDocument {
  const fail = (message: string): never => {
    throw new MatteVerificationError('frames_invalid', message);
  };
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return fail('frames.json must be an object.');
  }
  const record = document as Record<string, unknown>;
  if (record.version !== MATTE_FRAMES_VERSION) fail('frames.json must be version 1.');
  const timeBase = record.timeBase;
  if (
    !Array.isArray(timeBase) || timeBase.length !== 2 ||
    !timeBase.every((value) => Number.isSafeInteger(value) && (value as number) > 0)
  ) {
    fail('frames.json timeBase must be two positive integers.');
  }
  if (!Number.isSafeInteger(record.originPts)) fail('frames.json originPts must be an integer.');
  if (!Number.isSafeInteger(record.firstFrame) || (record.firstFrame as number) < 0) {
    fail('frames.json firstFrame must be a non-negative integer.');
  }
  const pts = record.pts;
  if (!Array.isArray(pts) || pts.length === 0 || !pts.every((value) => Number.isSafeInteger(value))) {
    fail('frames.json pts must be a non-empty list of integers.');
  }
  const list = pts as number[];
  for (let index = 1; index < list.length; index += 1) {
    if (list[index]! <= list[index - 1]!) fail('frames.json pts must be strictly increasing.');
  }
  return {
    version: 1,
    timeBase: [(timeBase as number[])[0]!, (timeBase as number[])[1]!],
    originPts: record.originPts as number,
    firstFrame: record.firstFrame as number,
    pts: list,
  };
}

export async function readMatteFrames(directory: string): Promise<MatteFramesDocument> {
  const file = path.join(directory, 'frames.json');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > FRAMES_MAX_BYTES) {
    throw new MatteVerificationError('frames_invalid', 'frames.json is not a bounded regular file.');
  }
  let document: unknown;
  try {
    document = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new MatteVerificationError('frames_invalid', 'frames.json is not valid JSON.');
  }
  return parseMatteFrames(document);
}

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file, signal === undefined ? {} : { signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Verify a staged matte artifact. Resolves with the host-measured facts or throws a typed error. */
export async function verifyMatteStaging(input: MatteVerificationInput): Promise<VerifiedMatteArtifact> {
  const { result, directory } = input;
  const claimed = new Map(result.artifact.files.map((file) => [file.name as string, file]));
  const allowed = new Set<string>(input.allowedFiles);

  // 1. Exactly the declared files, each a regular file.
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'inputs' && entry.isDirectory()) continue;
    if (!claimed.has(entry.name) || !allowed.has(entry.name) || !entry.isFile()) {
      throw new MatteVerificationError('undeclared_file', 'The worker wrote a file it did not declare or may not create.');
    }
  }
  for (const name of claimed.keys()) {
    if (!allowed.has(name)) {
      throw new MatteVerificationError('undeclared_file', 'The worker declared a file it may not create.');
    }
    if (!entries.some((entry) => entry.name === name && entry.isFile())) {
      throw new MatteVerificationError('missing_required_file', 'A declared matte file is missing.');
    }
  }
  if (!claimed.has('matte.mkv') || !claimed.has('frames.json')) {
    throw new MatteVerificationError('missing_required_file', 'matte.mkv and frames.json are required.');
  }

  // 2. Sizes and the ceiling, from lstat rather than the claim.
  let total = 0;
  for (const file of claimed.values()) {
    const stat = await lstat(path.join(directory, file.name));
    if (!stat.isFile() || stat.size !== file.bytes) {
      throw new MatteVerificationError('size_mismatch', 'A matte file’s size differs from what the worker declared.');
    }
    total += stat.size;
  }
  if (total > input.maxBytes) {
    throw new MatteVerificationError('byte_ceiling_exceeded', 'The matte job wrote more than its byte ceiling.');
  }

  // 3. Digests.
  for (const file of claimed.values()) {
    if ((await sha256File(path.join(directory, file.name), input.signal)) !== file.sha256) {
      throw new MatteVerificationError('digest_mismatch', 'A matte file’s digest differs from what the worker declared.');
    }
  }

  // 4. frames.json against the source's own decoded pts.
  const frames = await readMatteFrames(directory);
  verifyFramesAgainstSource(frames, result, input.source);

  // 5. Streams.
  const width = result.artifact.width;
  const height = result.artifact.height;
  if (input.expectedSize !== undefined && (input.expectedSize.width !== width || input.expectedSize.height !== height)) {
    throw new MatteVerificationError('probe_mismatch', 'The matte is not at the source’s display size.');
  }
  await withInspector(async () => {
    const matte = await input.inspector.probeVideo(path.join(directory, 'matte.mkv'), input.signal);
    if (!MATTE_PIXEL_FORMATS.has(matte.pixelFormat)) {
      throw new MatteVerificationError('pixel_format_unsupported', 'matte.mkv uses a pixel format the export cannot read.');
    }
    assertStream(matte, width, height, frames.pts.length);
    if (claimed.has('foreground.mkv')) {
      const foreground = await input.inspector.probeVideo(path.join(directory, 'foreground.mkv'), input.signal);
      if (!FOREGROUND_PIXEL_FORMATS.has(foreground.pixelFormat)) {
        throw new MatteVerificationError('pixel_format_unsupported', 'foreground.mkv uses a pixel format the export cannot read.');
      }
      assertStream(foreground, width, height, frames.pts.length);
    }
    for (const preview of ['preview.webm', 'foreground.preview.webm'] as const) {
      if (!claimed.has(preview)) continue;
      const probe = await input.inspector.probeVideo(path.join(directory, preview), input.signal);
      if (probe.frameCount !== frames.pts.length) {
        throw new MatteVerificationError('probe_mismatch', 'A matte preview does not have one frame per matte frame.');
      }
    }
  });

  // 6. Locked frames.
  await verifyLockedFrames(input, frames);

  const files: VerifiedMatteFile[] = [...claimed.values()].map((file) => ({
    name: file.name,
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  return { files, frames, width, height, matteBytes: total };
}

function verifyFramesAgainstSource(
  frames: MatteFramesDocument,
  result: SubjectMatteResult,
  source: MatteVerificationInput['source'],
): void {
  const misaligned = (message: string): never => {
    throw new MatteVerificationError('frames_misaligned', message);
  };
  const artifact = result.artifact;
  if (
    frames.pts.length !== artifact.frameCount ||
    frames.pts[0] !== artifact.firstPts ||
    frames.pts[frames.pts.length - 1] !== artifact.lastPts ||
    frames.timeBase[0] !== artifact.timeBase[0] ||
    frames.timeBase[1] !== artifact.timeBase[1]
  ) {
    misaligned('frames.json disagrees with the worker’s own descriptor.');
  }
  const timing = source.timing;
  if (frames.timeBase[0] !== timing.timeBase[0] || frames.timeBase[1] !== timing.timeBase[1]) {
    misaligned('frames.json time base is not the source stream’s.');
  }
  if (frames.originPts !== timing.pts[0]) misaligned('frames.json clock origin is not the source’s first frame.');
  if (frames.firstFrame !== source.firstFrame || frames.pts.length !== source.frameCount) {
    misaligned('frames.json does not cover exactly the requested frames.');
  }
  for (let index = 0; index < frames.pts.length; index += 1) {
    if (timing.pts[frames.firstFrame + index] !== frames.pts[index]) {
      misaligned('frames.json pts differ from the source’s decoded pts.');
    }
  }
}

function assertStream(
  probe: { readonly width: number; readonly height: number; readonly frameCount: number },
  width: number,
  height: number,
  frameCount: number,
): void {
  if (probe.width !== width || probe.height !== height) {
    throw new MatteVerificationError('probe_mismatch', 'A matte stream’s size differs from the declared size.');
  }
  if (probe.frameCount !== frameCount) {
    throw new MatteVerificationError('frames_misaligned', 'A matte stream’s frame count differs from frames.json.');
  }
}

async function verifyLockedFrames(input: MatteVerificationInput, frames: MatteFramesDocument): Promise<void> {
  const indexOf = new Map(frames.pts.map((pts, index) => [pts, index]));
  const checks: { index: number; expected: string }[] = [];
  for (const lock of input.locks) {
    const index = indexOf.get(lock.pts);
    if (index === undefined) {
      throw new MatteVerificationError('locked_frame_changed', 'A locked frame is missing from the new matte.');
    }
    checks.push({ index, expected: lock.pixelSha256 });
  }
  const previous = input.previous;
  const carried: { index: number; previousIndex: number }[] = [];
  if (previous !== undefined) {
    const previousIndexOf = new Map(previous.frames.pts.map((pts, index) => [pts, index]));
    for (const pts of previous.lockedPts) {
      const index = indexOf.get(pts);
      const previousIndex = previousIndexOf.get(pts);
      // A locked frame outside the new coverage is not carried; one inside must be identical.
      if (index === undefined || previousIndex === undefined) continue;
      carried.push({ index, previousIndex });
    }
  }
  if (checks.length === 0 && carried.length === 0) return;
  await withInspector(async () => {
    const matte = path.join(input.directory, 'matte.mkv');
    const actual = await hashInBatches(input.inspector, matte, [
      ...checks.map((check) => check.index),
      ...carried.map((check) => check.index),
    ], input.signal);
    checks.forEach((check, position) => {
      if (actual[position] !== check.expected) {
        throw new MatteVerificationError('locked_frame_changed', 'A locked frame changed in the new matte.');
      }
    });
    if (carried.length === 0 || previous === undefined) return;
    const before = await hashInBatches(
      input.inspector,
      path.join(previous.directory, 'matte.mkv'),
      carried.map((check) => check.previousIndex),
      input.signal,
    );
    carried.forEach((_check, position) => {
      if (actual[checks.length + position] !== before[position]) {
        throw new MatteVerificationError('locked_frame_changed', 'A frame locked on the previous matte changed.');
      }
    });
  });
}

async function hashInBatches(
  inspector: MatteMediaInspector,
  file: string,
  indexes: readonly number[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const out: string[] = [];
  for (let start = 0; start < indexes.length; start += 256) {
    out.push(...(await inspector.frameHashesByIndex(file, indexes.slice(start, start + 256), 'gray', signal)));
  }
  return out;
}

/** Inspector failures become a typed refusal; a verification the host cannot run fails closed. */
async function withInspector(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MatteVerificationError) throw error;
    if (error instanceof MatteInspectorError && error.code === 'cancelled') throw error;
    throw new MatteVerificationError(
      error instanceof MatteInspectorError && error.code === 'tool_unavailable'
        ? 'verification_unavailable'
        : 'probe_mismatch',
      error instanceof Error ? error.message : 'The matte could not be inspected.',
    );
  }
}
