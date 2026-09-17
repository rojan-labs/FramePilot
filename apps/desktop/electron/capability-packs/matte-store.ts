/**
 * Project-owned matte state outside the artifact folders (MD-4):
 *
 * - `.framepilot-derived/mattes/.inputs/<sha256>.png`: brush corrections and locked alpha,
 *   content-addressed so a prompt can pin one by digest and undo can keep referencing it.
 * - `.framepilot-derived/mattes/.results/<key>.json`: the host's record of a verified artifact
 *   (summary, review ranges, provenance, source samples), which a cache hit returns.
 *
 * Plus the source content fingerprint the cache key is built from.
 */
import { createHash } from 'node:crypto';
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MatteArtifactRecordSchema,
  type MatteArtifactRecord,
} from '@framepilot/capability-packs';
import type { MatteVideoTiming } from './matte-media-inspector.js';
import { BRUSH_VALUES, decodeGrayPng, MattePngError, type GrayPng } from './matte-png.js';
import {
  ensureRealDirectory,
  existingRealDirectory,
  isMatteCacheKey,
  MATTE_INPUTS_STORE_DIR,
  MATTES_RELATIVE_DIR,
} from './matte-staging.js';

export const MATTE_RESULTS_DIR = '.results';
const RECORD_MAX_BYTES = 8 * 1024 * 1024;
/** Bytes hashed from each end of the source for its fingerprint. */
const FINGERPRINT_EDGE_BYTES = 8 * 1024 * 1024;

export class MatteStoreError extends Error {
  public constructor(
    public readonly code: 'invalid_png' | 'wrong_size' | 'invalid_brush' | 'input_missing' | 'input_corrupt' | 'record_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'MatteStoreError';
  }
}

export interface SavedMatteInput {
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Validate and store one correction input. The PNG must be 8-bit gray at the artifact's size;
 * a brush may hold only keep (255), remove (0) and untouched (128).
 */
export async function saveMatteInput(
  projectDir: string,
  png: Uint8Array,
  expected: { readonly width: number; readonly height: number; readonly kind: 'brush' | 'lock' },
): Promise<SavedMatteInput> {
  const image = decodeInput(png);
  if (image.width !== expected.width || image.height !== expected.height) {
    throw new MatteStoreError('wrong_size', 'The correction is not the size of the matte it corrects.');
  }
  if (expected.kind === 'brush' && image.pixels.some((value) => !BRUSH_VALUES.has(value))) {
    throw new MatteStoreError('invalid_brush', 'A brush correction may only mark keep, remove or untouched.');
  }
  const sha256 = createHash('sha256').update(png).digest('hex');
  const store = await ensureRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, MATTE_INPUTS_STORE_DIR]);
  const target = path.join(store, `${sha256}.png`);
  try {
    await writeFile(target, png, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Same digest, same bytes: saving an identical correction twice is a no-op.
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return { sha256, bytes: png.byteLength };
}

/** Read a stored input back, proving its bytes still match its name. */
export async function readMatteInput(projectDir: string, sha256: string): Promise<{ readonly bytes: Buffer; readonly image: GrayPng }> {
  if (!isMatteCacheKey(sha256)) throw new MatteStoreError('input_missing', 'Correction reference is malformed.');
  let bytes: Buffer;
  try {
    const store = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, MATTE_INPUTS_STORE_DIR]);
    if (store === undefined) throw new Error('no inputs store');
    const file = path.join(store, `${sha256}.png`);
    const stat = await lstat(file);
    if (!stat.isFile()) throw new Error('not a file');
    bytes = await readFile(file);
  } catch {
    throw new MatteStoreError('input_missing', 'A saved correction is missing from the project.');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new MatteStoreError('input_corrupt', 'A saved correction was changed outside FramePilot.');
  }
  return { bytes, image: decodeInput(bytes) };
}

export function matteRecordPath(projectDir: string, key: string): string {
  return path.join(path.resolve(projectDir), ...MATTES_RELATIVE_DIR, MATTE_RESULTS_DIR, `${key}.json`);
}

/** Write the record atomically (temp file + rename). */
export async function writeMatteRecord(projectDir: string, record: MatteArtifactRecord): Promise<void> {
  const parsed = MatteArtifactRecordSchema.parse(record);
  const directory = await ensureRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, MATTE_RESULTS_DIR]);
  const target = path.join(directory, `${parsed.key}.json`);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The record for `key`, or `undefined` when absent or invalid (an invalid record is a miss). */
export async function readMatteRecord(projectDir: string, key: string): Promise<MatteArtifactRecord | undefined> {
  if (!isMatteCacheKey(key)) return undefined;
  try {
    const results = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, MATTE_RESULTS_DIR]);
    if (results === undefined) return undefined;
    const file = path.join(results, `${key}.json`);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return undefined;
    const parsed = MatteArtifactRecordSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success && parsed.data.key === key ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The source's content fingerprint: size, sha256 of the first and last 8 MiB, and the decoded
 * timestamps. Hashing whole camera files per request would cost minutes; this detects a
 * replaced or re-encoded file, and the decoded-frame samples (BR4.10) catch the rest.
 */
export async function sourceContentFingerprint(file: string, timing: MatteVideoTiming): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const edge = Math.min(FINGERPRINT_EDGE_BYTES, size);
    const head = Buffer.alloc(edge);
    const tail = Buffer.alloc(edge);
    await handle.read(head, 0, edge, 0);
    await handle.read(tail, 0, edge, size - edge);
    const ptsHash = createHash('sha256').update(timing.pts.join(',')).digest('hex');
    return createHash('sha256')
      .update(
        [
          `size:${size}`,
          `head:${createHash('sha256').update(head).digest('hex')}`,
          `tail:${createHash('sha256').update(tail).digest('hex')}`,
          `timebase:${timing.timeBase[0]}/${timing.timeBase[1]}`,
          `pts:${ptsHash}`,
        ].join('|'),
      )
      .digest('hex');
  } finally {
    await handle.close();
  }
}

function decodeInput(bytes: Uint8Array): GrayPng {
  try {
    return decodeGrayPng(bytes);
  } catch (error) {
    if (error instanceof MattePngError) throw new MatteStoreError('invalid_png', error.message);
    throw error;
  }
}
