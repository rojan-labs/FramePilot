/**
 * Project media validation for matte artifacts (plan 04/05, BR4.7).
 *
 * The export refuses a matte it cannot trust (`engine/.../render/mattes.py`, BR2.3) with a
 * stable code and one remedy sentence. The desktop reports the SAME codes, statuses and
 * sentences when a project opens, so the Inspector and the export dialog say the same thing
 * (05-INSPECTOR-UX: "STALE and BROKEN use the same remedy text"). A parity test reads the
 * engine source so the two cannot drift.
 *
 * Scope split, so nothing is checked twice with different rules: coverage against the clip's
 * source range and artifact size against the asset's display size are structural and live in
 * `editor-core/mask-validation.ts`; this module checks what only the filesystem can answer.
 *
 * - `quick` (project open): folder and pinned files exist as regular files, sizes match the
 *   host record, `frames.json` parses. No hashing, so opening a project with hours of mattes
 *   stays fast.
 * - `full` (before export, or on demand): adds sha256 against the pinned digests (cached by
 *   path, size and mtime) and ffprobe pixel format, frame count and size.
 */
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@framepilot/shared-types';
import { MatteInspectorError, type MatteMediaInspector } from './matte-media-inspector.js';
import { existingRealDirectory, isMatteCacheKey, MATTES_RELATIVE_DIR, MatteStagingError } from './matte-staging.js';
import { readMatteRecord } from './matte-store.js';
import {
  FOREGROUND_PIXEL_FORMATS,
  MATTE_PIXEL_FORMATS,
  framesJsonByteBound,
  MatteVerificationError,
  readMatteFrames,
  sha256File,
} from './matte-verify.js';

const log = createLogger('desktop:capability-packs:matte-validation');

export type MatteStatus = 'broken' | 'stale';

export type MatteRefusalCode =
  | 'matte_missing'
  | 'matte_digest_mismatch'
  | 'matte_unreadable'
  | 'matte_unsupported_pixel_format'
  | 'matte_size_mismatch'
  | 'matte_out_of_coverage'
  | 'matte_frame_misaligned'
  | 'matte_media_changed';

/** Verbatim from `MATTE_REMEDIES` in `render/mattes.py`; `matte-validation.test.ts` pins parity. */
export const MATTE_REMEDIES: Readonly<Record<MatteRefusalCode, { readonly status: MatteStatus; readonly remedy: string }>> = {
  matte_missing: { status: 'broken', remedy: 'Background removal data is missing — run Remove background again.' },
  matte_digest_mismatch: {
    status: 'broken',
    remedy: 'Background removal data was changed outside FramePilot — run Remove background again.',
  },
  matte_unreadable: { status: 'broken', remedy: 'Background removal data is damaged — run Remove background again.' },
  matte_unsupported_pixel_format: {
    status: 'broken',
    remedy: 'Background removal data uses a format this version cannot read — update FramePilot or run Remove background again.',
  },
  matte_size_mismatch: { status: 'stale', remedy: 'Media changed since background removal ran — run Remove background again.' },
  matte_out_of_coverage: {
    status: 'stale',
    remedy: "Background removal does not cover the clip's whole range — update the background removal for the new range.",
  },
  matte_frame_misaligned: {
    status: 'stale',
    remedy: 'Background removal frames do not line up with the media — run Remove background again.',
  },
  // Relinked or replaced media decoding to different frames (BR4.14, matte-media-recheck.ts).
  matte_media_changed: { status: 'stale', remedy: 'Media changed since background removal ran — run Remove background again.' },
};

export interface MatteValidationIssue {
  readonly clipId: string;
  readonly maskId: string;
  readonly artifactKey: string;
  readonly code: MatteRefusalCode;
  readonly status: MatteStatus;
  readonly remedy: string;
}

export interface MatteValidationOptions {
  readonly mode: 'quick' | 'full';
  readonly inspector?: MatteMediaInspector;
  readonly signal?: AbortSignal;
}

interface MatteMaskRef {
  readonly clipId: string;
  readonly maskId: string;
  readonly key: string;
  readonly files: readonly { readonly name: string; readonly sha256: string }[];
  readonly width: number;
  readonly height: number;
  readonly decontaminate: boolean;
}

/** `(path|size|mtimeMs) → sha256`, so re-validating a project does not re-hash its mattes. */
const digestCache = new Map<string, string>();

export async function validateProjectMattes(
  projectDir: string,
  project: unknown,
  options: MatteValidationOptions,
): Promise<MatteValidationIssue[]> {
  const issues: MatteValidationIssue[] = [];
  // One verdict per (artifact, needs-foreground): a matte shared by many clips is checked once.
  const verdicts = new Map<string, MatteRefusalCode | null>();
  for (const mask of matteMasksOf(project)) {
    const cacheKey = `${mask.key}|${mask.decontaminate}`;
    if (!verdicts.has(cacheKey)) verdicts.set(cacheKey, await checkArtifact(projectDir, mask, options));
    const code = verdicts.get(cacheKey);
    if (code === null || code === undefined) continue;
    issues.push({ clipId: mask.clipId, maskId: mask.maskId, artifactKey: mask.key, code, ...MATTE_REMEDIES[code] });
  }
  if (issues.length > 0) log.action('matteValidationIssues', { count: issues.length, mode: options.mode });
  return issues;
}

async function checkArtifact(
  projectDir: string,
  mask: MatteMaskRef,
  options: MatteValidationOptions,
): Promise<MatteRefusalCode | null> {
  // The whole chain must be real directories inside the project (BR4.12 M1); a link is missing data.
  if (!isMatteCacheKey(mask.key)) return 'matte_missing';
  const directory = await existingRealDirectory(projectDir, [...MATTES_RELATIVE_DIR, mask.key]).catch((error: unknown) => {
    if (error instanceof MatteStagingError) return undefined;
    throw error;
  });
  if (directory === undefined) return 'matte_missing';
  const pinned = new Map(mask.files.map((file) => [file.name, file.sha256]));
  const wanted = ['matte.mkv', 'frames.json', ...(mask.decontaminate ? ['foreground.mkv'] : [])];
  for (const name of wanted) {
    if (!pinned.has(name) || !(await isRegularFile(path.join(directory, name)))) return 'matte_missing';
  }
  const record = await readMatteRecord(projectDir, mask.key);
  if (record !== undefined) {
    for (const name of wanted) {
      const recorded = record.files.find((file) => file.name === name);
      const size = (await stat(path.join(directory, name))).size;
      if (recorded !== undefined && (recorded.bytes !== size || recorded.sha256 !== pinned.get(name))) {
        return 'matte_digest_mismatch';
      }
    }
  }
  if (options.mode === 'full') {
    for (const name of wanted) {
      if ((await cachedSha256(path.join(directory, name), options.signal)) !== pinned.get(name)) return 'matte_digest_mismatch';
    }
  }
  // Quick mode trusts a host record whose sizes and digests match the pins: that frames.json was
  // parsed when the artifact was verified, so project open does not parse it again (BR4.12 L4).
  if (options.mode === 'quick' && record !== undefined && recordMatchesPins(record, wanted, pinned)) return null;
  let frameCount: number;
  try {
    frameCount = (await readMatteFrames(directory, framesJsonByteBound(maxFramesFor(record, mask)))).pts.length;
  } catch (error) {
    if (error instanceof MatteVerificationError) return 'matte_unreadable';
    throw error;
  }
  if (options.mode === 'quick' || options.inspector === undefined) return null;
  try {
    const matte = await options.inspector.probeVideo(path.join(directory, 'matte.mkv'), options.signal);
    const foreground = mask.decontaminate
      ? await options.inspector.probeVideo(path.join(directory, 'foreground.mkv'), options.signal)
      : undefined;
    if (!MATTE_PIXEL_FORMATS.has(matte.pixelFormat) || (foreground !== undefined && !FOREGROUND_PIXEL_FORMATS.has(foreground.pixelFormat))) {
      return 'matte_unsupported_pixel_format';
    }
    for (const stream of foreground === undefined ? [matte] : [matte, foreground]) {
      if (stream.frameCount !== frameCount) return 'matte_frame_misaligned';
      if (stream.width !== mask.width || stream.height !== mask.height) return 'matte_size_mismatch';
    }
  } catch (error) {
    if (error instanceof MatteInspectorError && error.code === 'cancelled') throw error;
    return 'matte_unreadable';
  }
  return null;
}

/** Every matte mask on every clip (and effect layer) of the project, as the engine reads them. */
export function matteMasksOf(project: unknown): MatteMaskRef[] {
  const out: MatteMaskRef[] = [];
  const tracks = (project as { timeline?: { tracks?: unknown[] } } | null)?.timeline?.tracks;
  if (!Array.isArray(tracks)) return out;
  for (const track of tracks) {
    const owners = [
      ...arrayOf((track as { clips?: unknown }).clips),
      ...arrayOf((track as { effectLayers?: unknown }).effectLayers),
    ];
    for (const owner of owners) {
      const clipId = String((owner as { id?: unknown }).id ?? '');
      for (const mask of arrayOf((owner as { masks?: unknown }).masks)) {
        const record = mask as Record<string, unknown>;
        if (record.kind !== 'matte' || typeof record.artifact !== 'object' || record.artifact === null) continue;
        const artifact = record.artifact as Record<string, unknown>;
        out.push({
          clipId,
          maskId: String(record.id ?? ''),
          key: String(artifact.key ?? ''),
          files: arrayOf(artifact.files).map((file) => ({
            name: String((file as { name?: unknown }).name ?? ''),
            sha256: String((file as { sha256?: unknown }).sha256 ?? ''),
          })),
          width: Number(artifact.width),
          height: Number(artifact.height),
          decontaminate: record.decontaminate !== false,
        });
      }
    }
  }
  return out;
}

function recordMatchesPins(
  record: { readonly files: readonly { readonly name: string; readonly sha256: string }[] },
  wanted: readonly string[],
  pinned: ReadonlyMap<string, string>,
): boolean {
  return wanted.every((name) => record.files.some((file) => file.name === name && file.sha256 === pinned.get(name)));
}

/** Upper bound on frames: the record's coverage at 240 fps, or the frames.json size bound's cap. */
function maxFramesFor(record: { readonly coverage: { readonly sourceStart: number; readonly sourceEnd: number } } | undefined, _mask: MatteMaskRef): number {
  if (record === undefined) return Number.POSITIVE_INFINITY;
  return Math.ceil((record.coverage.sourceEnd - record.coverage.sourceStart) * 240) + 2;
}

async function cachedSha256(file: string, signal: AbortSignal | undefined): Promise<string> {
  const info = await stat(file);
  const key = `${file}|${info.size}|${info.mtimeMs}`;
  const cached = digestCache.get(key);
  if (cached !== undefined) return cached;
  const digest = await sha256File(file, signal);
  digestCache.set(key, digest);
  return digest;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function isRegularFile(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isFile();
  } catch {
    return false;
  }
}
