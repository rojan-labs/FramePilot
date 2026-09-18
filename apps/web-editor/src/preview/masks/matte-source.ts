/**
 * Matte artifact frames for the preview's mask-stack pass (BR5.1, plan 04 "Preview").
 *
 * The export reads a matte by the SOURCE FRAME its picture decodes (`render/mattes.py`:
 * `frames.json` names the source frame of matte frame 0 and the pts of every matte frame). This
 * module answers the same question for the monitor, with the same rules:
 *
 * - a source frame the artifact does not hold is {@link MatteLookup} `unprocessed` (a job still
 *   running, or a range never processed), never the nearest frame;
 * - a matte frame whose pts does not belong to the picture's timestamp is refused
 *   (`matte_frame_misaligned`), as the export refuses it;
 * - `frames.json` (and `report.json`, for the Flagged view) are checked against the digests the
 *   mask pins before they are parsed.
 *
 * Proxy decision (docs/guides/preview-masks.md, "Mattes"): the monitor decodes the lossless FFV1
 * masters (`matte.mkv`, `foreground.mkv`), not the VP9 `preview.webm` files. A 540p VP9 matte
 * measured 32.44 dB and 98.34 % within 8/255 on a hard-edged composite, below the PX4 gates, and
 * Chromium has no WebM demuxer or FFV1 decoder to fall back on. The masters decode on their own
 * workers (`decode/matte-decode-pool.ts`, PX5.3: never in the picture decoders' worker, and
 * frame-parallel for an intra-only file), and decoded frames live in the engine's byte-bounded
 * picture cache.
 *
 * The large masters' digests are not re-hashed here (a 4K foreground is gigabytes): desktop
 * project-media validation checks them on open and the export checks them before rendering, so
 * a changed file shows its remedy on the clip either way. Structure is still verified: size,
 * pixel format and frame count against `frames.json`.
 */
import { createLogger } from '@framepilot/shared-types';

import {
  MatteDecodeCancelled,
  type MatteDecodePool,
  type MatteDecodeRank,
} from '../decode/matte-decode-pool.js';
import type { MatteMask } from './mask-stack.js';
import type { MatteFrameData } from './matte-edges.js';

const log = createLogger('web-editor:preview:matte-source');

/** Largest `frames.json` / `report.json` read (`FRAMES_MAX_BYTES` of the engine). */
const JSON_MAX_BYTES = 64 * 1024 * 1024;
const FRAMES_VERSION = 1;
/** Values the engine does arithmetic on must stay well inside float64 integers. */
const FRAMES_VALUE_BOUND = 2 ** 52;

/** The engine's refusal codes (`MatteRefusalCode`) the preview can reach. */
export type MatteRefusalCode =
  | 'matte_missing'
  | 'matte_digest_mismatch'
  | 'matte_unreadable'
  | 'matte_unsupported_pixel_format'
  | 'matte_size_mismatch'
  | 'matte_frame_misaligned'
  | 'matte_unavailable';

/** `MATTE_REMEDIES`: the one sentence per code, identical to the export's. */
export const MATTE_REMEDIES: Readonly<Record<MatteRefusalCode, string>> = {
  matte_missing: 'Background removal data is missing — run Remove background again.',
  matte_digest_mismatch:
    'Background removal data was changed outside FramePilot — run Remove background again.',
  matte_unreadable: 'Background removal data is damaged — run Remove background again.',
  matte_unsupported_pixel_format:
    'Background removal data uses a format this version cannot read — update FramePilot or run Remove background again.',
  matte_size_mismatch: 'Media changed since background removal ran — run Remove background again.',
  matte_frame_misaligned:
    'Background removal frames do not line up with the media — run Remove background again.',
  matte_unavailable: 'Background removal previews in the desktop app.',
};

/** What the monitor can draw for one matte layer at one source frame. */
export type MatteLookup =
  | { readonly state: 'ready'; readonly frame: MatteFrameData }
  | { readonly state: 'pending' }
  /** The artifact holds no frame for this source frame yet: the layer is left out. */
  | { readonly state: 'unprocessed' }
  | { readonly state: 'refused'; readonly code: MatteRefusalCode; readonly message: string };

/** Where an artifact's files are served from; `null` when this host cannot reach them. */
export type MatteArtifactLocator = (artifactKey: string, fileName: string) => string | null;

/** The decoded-frame store the engine shares between pictures and mattes. */
export interface MatteFrameCache {
  get(key: string): MatteFrameData | undefined;
  put(key: string, frame: MatteFrameData): void;
}

/** `frames.json`, parsed and validated (`parse_frames`). */
export interface MatteFrames {
  readonly timeBase: readonly [number, number];
  readonly originPts: number;
  readonly firstFrame: number;
  readonly pts: readonly number[];
}

/** A frame or range the pack flagged for review, in matte frame indices (inclusive). */
export interface FlaggedRange {
  readonly first: number;
  readonly last: number;
}

class MatteArtifactError extends Error {
  /**
   * @param code - The export's refusal code.
   * @param origin - BR5.4: the type name of the error this stands in for, for the diagnostic
   *   only. Never a message: a message can carry a path.
   */
  constructor(
    readonly code: MatteRefusalCode,
    readonly origin: string | null = null,
  ) {
    super(MATTE_REMEDIES[code]);
    this.name = 'MatteArtifactError';
  }
}

/**
 * BR5.4: a refusal's cause for the diagnostic — the reader's own words, with anything that
 * could be a URL or a path taken out (the reader never puts one in a message; this keeps that
 * true if one day it does).
 */
function describeCause(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const text = `${error.name}: ${error.message}`;
  return text.replace(/(?:[a-z]+:\/\/|\/)\S+/gi, '<path>').slice(0, 120);
}

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

/**
 * `parse_frames`: a `frames.json` document with version 1, a positive time base, strictly
 * increasing integer pts and values inside the engine's bound.
 *
 * @throws Error naming what is wrong.
 */
export function parseMatteFrames(document: unknown): MatteFrames {
  const doc = document as Record<string, unknown> | null;
  if (doc === null || typeof doc !== 'object' || doc.version !== FRAMES_VERSION) {
    throw new Error('frames.json must be an object with version 1.');
  }
  const timeBase = doc.timeBase;
  if (
    !Array.isArray(timeBase) ||
    timeBase.length !== 2 ||
    !timeBase.every((v) => isInteger(v) && v > 0)
  ) {
    throw new Error('frames.json timeBase must be two positive integers.');
  }
  if (!isInteger(doc.originPts)) throw new Error('frames.json originPts must be an integer.');
  if (!isInteger(doc.firstFrame) || doc.firstFrame < 0) {
    throw new Error('frames.json firstFrame must be a non-negative integer.');
  }
  const pts = doc.pts;
  if (!Array.isArray(pts) || pts.length === 0 || !pts.every(isInteger)) {
    throw new Error('frames.json pts must be a non-empty list of integers.');
  }
  for (let i = 1; i < pts.length; i += 1) {
    if ((pts[i] as number) <= (pts[i - 1] as number)) {
      throw new Error('frames.json pts must be strictly increasing.');
    }
  }
  const bounded = [
    ...(timeBase as number[]),
    doc.originPts,
    doc.firstFrame,
    pts[0] as number,
    pts[pts.length - 1] as number,
  ];
  if (bounded.some((v) => Math.abs(v) > FRAMES_VALUE_BOUND)) {
    throw new Error('frames.json values are out of range.');
  }
  return {
    timeBase: [timeBase[0] as number, timeBase[1] as number],
    originPts: doc.originPts,
    firstFrame: doc.firstFrame,
    pts: pts as number[],
  };
}

/** Seconds of matte frame `index` from the asset's clock zero. */
export function matteFrameSeconds(frames: MatteFrames, index: number): number {
  return ((frames.pts[index]! - frames.originPts) * frames.timeBase[0]) / frames.timeBase[1];
}

/**
 * Whether matte frame `index` is the source picture presented at `pictureSeconds`: its time is
 * nearer that picture than to either neighbouring matte frame (`assert_frames_align` in one
 * frame: a matte from other footage, another rate, or a dropped frame fails it).
 */
export function matteFrameAligned(
  frames: MatteFrames,
  index: number,
  pictureSeconds: number,
): boolean {
  const at = matteFrameSeconds(frames, index);
  let half = Number.POSITIVE_INFINITY;
  if (index > 0) half = Math.min(half, (at - matteFrameSeconds(frames, index - 1)) / 2);
  if (index + 1 < frames.pts.length) {
    half = Math.min(half, (matteFrameSeconds(frames, index + 1) - at) / 2);
  }
  return Math.abs(at - pictureSeconds) < half;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface ArtifactState {
  readonly key: string;
  /** The artifact as the first mask that referenced it pins it. */
  readonly artifact: MatteMask['artifact'];
  /** Resolves when the artifact's index is loaded (or refused). */
  ready: Promise<void>;
  frames: MatteFrames | null;
  refusal: MatteRefusalCode | null;
  /** BR5.4 diagnostic only: which step of {@link MatteSource.loadArtifact} refused, and with what. */
  failure: { readonly stage: string; readonly cause: string } | null;
  foreground: Promise<MatteRefusalCode | null> | null;
  flagged: Promise<readonly FlaggedRange[] | null> | null;
}

const sourceIdOf = (key: string, file: 'matte' | 'foreground'): string => `matte:${key}:${file}`;
export const matteCacheKey = (key: string, index: number): string => `matte:${key}@${index}`;

/** What {@link MatteSource} needs of a decoder: open a file, decode a frame, close it. */
export type MatteDecoder = Pick<MatteDecodePool, 'loadMatte' | 'decodeMatte' | 'unloadSource'>;

/** A foreground that could not be read: the refusal the frame is failed with. */
interface ForegroundRefused {
  readonly refusal: MatteRefusalCode;
}

export class MatteSource {
  private readonly artifacts = new Map<string, ArtifactState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failedFrames = new Map<string, MatteRefusalCode>();
  /**
   * PX5.3: the frames that matter now (`artifactKey@index` → rank, most urgent first), or
   * `null` before anyone said, when every request is wanted in arrival order.
   */
  private wanted: Map<string, number> | null = null;

  /**
   * @param onFrameDecoded - PX5.3 telemetry: milliseconds from asking for a matte frame to its
   *   planes in the cache, queueing included (`matteDecode`).
   */
  constructor(
    private readonly client: MatteDecoder,
    private readonly locate: () => MatteArtifactLocator | null,
    private readonly cache: MatteFrameCache,
    private readonly fetchBytes: (url: string) => Promise<Uint8Array | null> = fetchFileBytes,
    private readonly onFrameDecoded: ((ms: number) => void) | null = null,
  ) {}

  /**
   * The matte frame for `mask` at decode-order source frame `sourceFrame`, as far as it is known
   * now. `pending` starts the work; {@link ensure} awaits it.
   *
   * @param pictureSeconds - The presented picture's timestamp (seconds from the source's first
   *   frame), for the alignment check; `null` skips it.
   */
  lookup(mask: MatteMask, sourceFrame: number, pictureSeconds: number | null): MatteLookup {
    const artifact = this.artifact(mask);
    if (artifact.refusal !== null) return refused(artifact.refusal);
    const frames = artifact.frames;
    if (frames === null) return { state: 'pending' };
    const index = sourceFrame - frames.firstFrame;
    if (index < 0 || index >= frames.pts.length) return { state: 'unprocessed' };
    if (pictureSeconds !== null && !matteFrameAligned(frames, index, pictureSeconds)) {
      return refused('matte_frame_misaligned');
    }
    const failed = this.failedFrames.get(`${mask.artifact.key}@${index}`);
    if (failed !== undefined) return refused(failed);
    const cached = this.cache.get(matteCacheKey(mask.artifact.key, index));
    if (cached !== undefined && (!mask.decontaminate || cached.foreground !== null)) {
      return { state: 'ready', frame: cached };
    }
    this.markWanted(mask.artifact.key, index);
    void this.decode(artifact, index, mask.decontaminate);
    return { state: 'pending' };
  }

  /**
   * BR5.4: what is known about `mask`'s artifact right now — whether its index loaded, the
   * source-frame range it holds and any refusal. Facts for the PX4 oracle's diagnostic; no
   * drawing decision reads it.
   */
  debugState(mask: MatteMask): {
    loaded: boolean;
    refusal: MatteRefusalCode | null;
    firstFrame: number | null;
    frameCount: number | null;
    stage: string | null;
    cause: string | null;
  } {
    const state = this.artifacts.get(mask.artifact.key);
    return {
      loaded: (state?.frames ?? null) !== null,
      refusal: state?.refusal ?? null,
      firstFrame: state?.frames?.firstFrame ?? null,
      frameCount: state?.frames?.pts.length ?? null,
      stage: state?.failure?.stage ?? null,
      cause: state?.failure?.cause ?? null,
    };
  }

  /** The matte frame index of `sourceFrame`, when the artifact is loaded and holds it. */
  frameIndexFor(mask: MatteMask, sourceFrame: number): number | null {
    const frames = this.artifacts.get(mask.artifact.key)?.frames ?? null;
    if (frames === null) return null;
    const index = sourceFrame - frames.firstFrame;
    return index < 0 || index >= frames.pts.length ? null : index;
  }

  /** The shared-cache key of `mask`'s frame at `sourceFrame`, when the artifact holds it. */
  cacheKeyFor(mask: MatteMask, sourceFrame: number): string | null {
    const frames = this.artifacts.get(mask.artifact.key)?.frames ?? null;
    if (frames === null) return null;
    const index = sourceFrame - frames.firstFrame;
    return index < 0 || index >= frames.pts.length ? null : matteCacheKey(mask.artifact.key, index);
  }

  /** Wait until every `lookup` of these requests is no longer `pending`. */
  async ensure(
    requests: readonly { readonly mask: MatteMask; readonly sourceFrame: number }[],
  ): Promise<void> {
    await Promise.all(
      requests.map(async ({ mask, sourceFrame }) => {
        const artifact = this.artifact(mask);
        await artifact.ready;
        const frames = artifact.frames;
        if (artifact.refusal !== null || frames === null) return;
        const index = sourceFrame - frames.firstFrame;
        if (index < 0 || index >= frames.pts.length) return;
        const cached = this.cache.get(matteCacheKey(mask.artifact.key, index));
        if (cached !== undefined && (!mask.decontaminate || cached.foreground !== null)) return;
        this.markWanted(mask.artifact.key, index);
        await this.decode(artifact, index, mask.decontaminate);
      }),
    );
  }

  /**
   * PX5.3: the matte frames that matter now, most urgent first — the decode-ahead window on
   * every playback tick, a seek's own frames on a seek. It REPLACES the last set: a request
   * still waiting for a worker whose frame is in neither this set nor asked for since
   * ({@link lookup}, {@link ensure}) is dropped, never decoded, and not remembered as failed,
   * so asking again later decodes it. Without it a backlog decodes frames already passed.
   */
  want(requests: readonly { readonly mask: MatteMask; readonly sourceFrame: number }[]): void {
    const wanted = new Map<string, number>();
    requests.forEach(({ mask, sourceFrame }, position) => {
      const frames = this.artifacts.get(mask.artifact.key)?.frames ?? null;
      if (frames === null) return;
      const index = sourceFrame - frames.firstFrame;
      if (index < 0 || index >= frames.pts.length) return;
      const key = `${mask.artifact.key}@${index}`;
      if (!wanted.has(key)) wanted.set(key, position);
    });
    this.wanted = wanted;
  }

  /** Asking for a frame wants it until the next {@link want}, after the frames named there. */
  private markWanted(artifactKey: string, index: number): void {
    const key = `${artifactKey}@${index}`;
    if (this.wanted !== null && !this.wanted.has(key)) this.wanted.set(key, this.wanted.size);
  }

  private rankOf(artifactKey: string, index: number): MatteDecodeRank {
    const key = `${artifactKey}@${index}`;
    return () => (this.wanted === null ? 0 : (this.wanted.get(key) ?? null));
  }

  /**
   * The ranges the pack flagged for review (BR5.2): `report.json` frames that are not verified,
   * as matte frame index ranges. `null` when the artifact has no readable, digest-pinned report.
   */
  flaggedRanges(mask: MatteMask): Promise<readonly FlaggedRange[] | null> {
    const artifact = this.artifact(mask);
    artifact.flagged ??= (async () => {
      await artifact.ready;
      if (artifact.frames === null) return null;
      try {
        const report = await this.readPinnedJson(mask.artifact, 'report.json');
        return flaggedFromReport(report, artifact.frames);
      } catch (error) {
        log.warn('matte review report unavailable', {
          artifact: mask.artifact.key.slice(0, 12),
          code: error instanceof MatteArtifactError ? error.code : 'matte_unreadable',
        });
        return null;
      }
    })();
    return artifact.flagged;
  }

  /** Forget artifacts no mask references any more, and unload their worker sources. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of [...this.artifacts.keys()]) {
      if (keys.has(key)) continue;
      this.artifacts.delete(key);
      void this.client.unloadSource(sourceIdOf(key, 'matte')).catch(() => undefined);
      void this.client.unloadSource(sourceIdOf(key, 'foreground')).catch(() => undefined);
    }
  }

  private artifact(mask: MatteMask): ArtifactState {
    const key = mask.artifact.key;
    const existing = this.artifacts.get(key);
    if (existing !== undefined) return existing;
    const state: ArtifactState = {
      key,
      artifact: mask.artifact,
      ready: Promise.resolve(),
      frames: null,
      refusal: null,
      failure: null,
      foreground: null,
      flagged: null,
    };
    state.ready = this.loadArtifact(state, mask);
    this.artifacts.set(key, state);
    return state;
  }

  private async readPinnedJson(
    artifact: MatteMask['artifact'],
    name: 'frames.json' | 'report.json',
  ): Promise<unknown> {
    const pinned = artifact.files.find((file) => file.name === name);
    const locator = this.locate();
    if (locator === null) throw new MatteArtifactError('matte_unavailable');
    const url = locator(artifact.key, name);
    if (pinned === undefined || url === null) throw new MatteArtifactError('matte_missing');
    const bytes = await this.fetchBytes(url);
    if (bytes === null) throw new MatteArtifactError('matte_missing');
    if (bytes.length > JSON_MAX_BYTES) throw new MatteArtifactError('matte_unreadable');
    if ((await sha256Hex(bytes)) !== pinned.sha256) {
      throw new MatteArtifactError('matte_digest_mismatch');
    }
    try {
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('BOM');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new MatteArtifactError('matte_unreadable');
    }
  }

  private async loadArtifact(state: ArtifactState, mask: MatteMask): Promise<void> {
    const artifact = mask.artifact;
    let stage = 'read-frames';
    try {
      const document = await this.readPinnedJson(artifact, 'frames.json');
      let parsed: MatteFrames;
      stage = 'parse-frames';
      try {
        parsed = parseMatteFrames(document);
      } catch (error) {
        if (error instanceof MatteArtifactError) throw error;
        throw new MatteArtifactError('matte_unreadable', describeCause(error));
      }
      stage = 'pin-matte';
      if (!artifact.files.some((file) => file.name === 'matte.mkv')) {
        throw new MatteArtifactError('matte_missing');
      }
      stage = 'open-matte';
      await this.openFile(artifact, 'matte', parsed.pts.length);
      state.frames = parsed;
      log.debug('matte artifact ready', {
        artifact: state.key.slice(0, 12),
        frames: parsed.pts.length,
        firstFrame: parsed.firstFrame,
      });
    } catch (error) {
      state.refusal = error instanceof MatteArtifactError ? error.code : 'matte_unreadable';
      // Type name only: a message can carry a path.
      const cause =
        error instanceof MatteArtifactError ? (error.origin ?? error.name) : describeCause(error);
      state.failure = { stage, cause };
      log.warn('matte artifact refused', {
        artifact: state.key.slice(0, 12),
        code: state.refusal,
        stage,
        cause,
      });
    }
  }

  /** Open one artifact file in the worker and check it against the artifact and `frames.json`. */
  private async openFile(
    artifact: MatteMask['artifact'],
    file: 'matte' | 'foreground',
    frameCount: number,
  ): Promise<void> {
    const locator = this.locate();
    if (locator === null) throw new MatteArtifactError('matte_unavailable');
    const url = locator(artifact.key, `${file}.mkv`);
    if (url === null) throw new MatteArtifactError('matte_missing');
    let info: Awaited<ReturnType<MatteDecoder['loadMatte']>>;
    try {
      info = await this.client.loadMatte(sourceIdOf(artifact.key, file), url, frameCount);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/request failed: 40[34]/i.test(message)) throw new MatteArtifactError('matte_missing');
      if (/not supported|not matte|YUV|float/i.test(message)) {
        throw new MatteArtifactError('matte_unsupported_pixel_format');
      }
      throw new MatteArtifactError('matte_unreadable', describeCause(error));
    }
    const formatOk = file === 'matte' ? info.format !== 'rgb24' : info.format === 'rgb24';
    if (!formatOk) throw new MatteArtifactError('matte_unsupported_pixel_format');
    if (info.frameCount !== frameCount) throw new MatteArtifactError('matte_frame_misaligned');
    if (info.width !== artifact.width || info.height !== artifact.height) {
      throw new MatteArtifactError('matte_size_mismatch');
    }
  }

  private foregroundReady(state: ArtifactState): Promise<MatteRefusalCode | null> {
    const artifact = state.artifact;
    state.foreground ??= (async () => {
      try {
        if (!artifact.files.some((file) => file.name === 'foreground.mkv')) {
          throw new MatteArtifactError('matte_missing');
        }
        await this.openFile(artifact, 'foreground', state.frames!.pts.length);
        return null;
      } catch (error) {
        return error instanceof MatteArtifactError ? error.code : 'matte_unreadable';
      }
    })();
    return state.foreground;
  }

  /**
   * Decode matte frame `index` into the cache. PX5.3: the alpha and the foreground are asked
   * for together, so on the matte pool they decode on two workers at once instead of in turn.
   */
  private decode(state: ArtifactState, index: number, wantForeground: boolean): Promise<void> {
    const flightKey = `${state.key}@${index}@${wantForeground ? 'fg' : 'alpha'}`;
    const pending = this.inFlight.get(flightKey);
    if (pending !== undefined) return pending;
    const run = (async () => {
      const cacheKey = matteCacheKey(state.key, index);
      const started = performance.now();
      try {
        const cached = this.cache.get(cacheKey);
        const known = cached?.foreground ?? null;
        const [alpha, foreground] = await Promise.all([
          cached ?? this.decodeAlpha(state, index),
          wantForeground && known === null ? this.decodeForeground(state, index) : known,
        ]);
        if (foreground !== null && !(foreground instanceof Uint8Array)) {
          this.failedFrames.set(`${state.key}@${index}`, foreground.refusal);
          return;
        }
        this.cache.put(cacheKey, { ...alpha, foreground });
        this.onFrameDecoded?.(performance.now() - started);
      } catch (error) {
        // Nobody wants it any more: not a failure, and the next ask decodes it.
        if (error instanceof MatteDecodeCancelled) return;
        this.failedFrames.set(`${state.key}@${index}`, 'matte_unreadable');
        log.warn('matte frame could not be decoded', {
          artifact: state.key.slice(0, 12),
          index,
          cause: error instanceof Error ? error.name : typeof error,
        });
      } finally {
        this.inFlight.delete(flightKey);
      }
    })();
    this.inFlight.set(flightKey, run);
    return run;
  }

  /** One `matte.mkv` frame as samples, without a foreground. */
  private async decodeAlpha(state: ArtifactState, index: number): Promise<MatteFrameData> {
    const message = await this.client.decodeMatte(
      sourceIdOf(state.key, 'matte'),
      index,
      this.rankOf(state.key, index),
    );
    return {
      id: `${state.key}@${index}`,
      width: message.width,
      height: message.height,
      maximum: message.format === 'gray16' ? 65535 : 255,
      alpha:
        message.format === 'gray16' ? new Uint16Array(message.data) : new Uint8Array(message.data),
      foreground: null,
    };
  }

  /** One `foreground.mkv` frame, or the refusal that opening the file met. */
  private async decodeForeground(
    state: ArtifactState,
    index: number,
  ): Promise<Uint8Array | ForegroundRefused> {
    const refusal = await this.foregroundReady(state);
    if (refusal !== null) return { refusal };
    const message = await this.client.decodeMatte(
      sourceIdOf(state.key, 'foreground'),
      index,
      this.rankOf(state.key, index),
    );
    return new Uint8Array(message.data);
  }
}

function refused(code: MatteRefusalCode): MatteLookup {
  return { state: 'refused', code, message: MATTE_REMEDIES[code] };
}

/** `report.json` (report version 1) frames that are not verified, as index ranges. */
export function flaggedFromReport(report: unknown, frames: MatteFrames): readonly FlaggedRange[] {
  const doc = report as { version?: unknown; frames?: unknown } | null;
  if (doc === null || typeof doc !== 'object' || doc.version !== 1 || !Array.isArray(doc.frames)) {
    throw new MatteArtifactError('matte_unreadable');
  }
  const indexByPts = new Map(frames.pts.map((pts, index) => [pts, index] as const));
  const flagged: number[] = [];
  for (const entry of doc.frames as { pts?: unknown; verified?: unknown; checks?: unknown }[]) {
    if (entry === null || typeof entry !== 'object' || !isInteger(entry.pts)) continue;
    const unverified =
      entry.verified === false || (Array.isArray(entry.checks) && entry.checks.length > 0);
    if (!unverified) continue;
    const index = indexByPts.get(entry.pts);
    if (index !== undefined) flagged.push(index);
  }
  flagged.sort((a, b) => a - b);
  const ranges: FlaggedRange[] = [];
  for (const index of flagged) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && index <= last.last + 1) {
      ranges[ranges.length - 1] = { first: last.first, last: Math.max(last.last, index) };
    } else {
      ranges.push({ first: index, last: index });
    }
  }
  return ranges;
}

/** A file's bytes, or `null` when it does not exist. */
async function fetchFileBytes(url: string): Promise<Uint8Array | null> {
  const response = await fetch(url);
  // The desktop media protocol answers a missing file 403, a static server 404.
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Artifact file request failed: ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}
