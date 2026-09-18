/**
 * Main-process authority for `subject.segment_frame` (hover highlight and click preview, BR6.11).
 *
 * The renderer states WHAT (asset, source instant, a hover point or clicks). Main resolves the
 * rest exactly as a matte job does — the asset from the project on disk, its decoded timing, the
 * frame's pts, the installed pack — and asks the pack's warm worker. The answer never touches the
 * project or the disk: it is verified and handed back as pixels.
 *
 * Verification of the worker's output (the same rules as any pack output, BR4.12):
 * - the result must name the requested pts and the preview size the host computed itself from the
 *   probed display size (the worker's own rounding, mirrored), checked at IHDR before inflating;
 * - the PNG is decoded by the strict reader (every CRC, no ancillary chunks, nothing after IEND,
 *   8-bit gray only); what the renderer receives is the decoded pixels, never the worker's bytes;
 * - errors carry codes and fixed sentences, never a path or the worker's text.
 *
 * Latest wins: a new request aborts the one still in flight (a pointer that moved on no longer
 * cares), and nothing runs while a background job or an export holds the model slot (`busy`), so
 * the warm model is never resident beside a matte job on a 16 GB machine.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  MatteSegmentFrameIntentSchema,
  type CapabilityPackWorkerRequest,
} from '@framepilot/capability-packs';
import {
  CapabilityPackWarmWorker,
  CapabilityPackWorkerRuntimeError,
  type CapabilityPackWarmWorkerOptions,
  type SegmentFrameWorkerResult,
} from '@framepilot/capability-packs/node';
import { createLogger, maskingEventPayload, type MatteSegmentFrameResultWire } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { displaySizeOf, frameAt, type CapabilityPackMatteService } from './matte.js';
import type { MatteMediaInspector, MatteVideoTiming } from './matte-media-inspector.js';
import { decodeGrayPng, MattePngError } from './matte-png.js';

const log = createLogger('desktop:capability-packs:segment-frame');
/** Matches the worker's `MAX_PREVIEW_HEIGHT`. */
const MAX_PREVIEW_HEIGHT = 1080;
/** Decoded timings kept for hover (each is one ffprobe of the whole file). */
const TIMING_CACHE_ENTRIES = 8;
/** The rate a single-frame source (a still image) is described at in the media handle. */
const STILL_FRAME_RATE = 30;
/** Largest base64 the host decodes (mirrors CAPABILITY_PACK_SEGMENT_FRAME_MAX_PNG_CHARS). */
const MAX_PNG_BASE64_CHARS = 900_000;

type Failure = Extract<MatteSegmentFrameResultWire, { ok: false }>;

export interface SegmentFrameContext {
  readonly project: Project;
  readonly projectRevision: number;
}

export interface CapabilityPackSegmentFrameServiceOptions {
  readonly matte: () => Promise<Pick<CapabilityPackMatteService, 'resolveWorker'>>;
  readonly inspector: Pick<MatteMediaInspector, 'videoTiming'>;
  /** False while a background job runs or an export holds the model slot. */
  readonly slotFree: () => boolean;
  /** Tests inject a session factory; production spawns the signed entrypoint warm. */
  readonly openWorker?: (
    options: CapabilityPackWarmWorkerOptions,
  ) => Pick<CapabilityPackWarmWorker, 'segmentFrame' | 'close'>;
  readonly idleMs?: number;
}

/** Python's `round` (half to even), so the host computes the worker's preview size exactly. */
export function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference > 0.5) return floor + 1;
  if (difference < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `interactive.preview_dimensions` in the worker. */
export function previewDimensions(
  width: number,
  height: number,
  previewHeight: number,
): { width: number; height: number } {
  const targetHeight = Math.max(1, Math.min(previewHeight, height, MAX_PREVIEW_HEIGHT));
  return { width: Math.max(1, pythonRound((width * targetHeight) / height)), height: targetHeight };
}

export class CapabilityPackSegmentFrameService {
  private worker:
    | {
        readonly key: string;
        readonly session: Pick<CapabilityPackWarmWorker, 'segmentFrame' | 'close'>;
      }
    | undefined;
  private inFlight: AbortController | undefined;
  private sequence = 0;
  private readonly timings = new Map<
    string,
    { readonly stamp: string; readonly timing: MatteVideoTiming }
  >();

  public constructor(private readonly options: CapabilityPackSegmentFrameServiceOptions) {}

  public async segment(
    input: unknown,
    context: SegmentFrameContext,
  ): Promise<MatteSegmentFrameResultWire> {
    const parsed = MatteSegmentFrameIntentSchema.safeParse(input);
    if (!parsed.success) return failure('invalid_request', 'Hover request is malformed.');
    const intent = parsed.data;
    // Latest wins: whatever was in flight is for a pointer position nobody is looking at now.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      return await this.run(intent, context, controller.signal);
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }

  /** End the warm process (app quit, project closed, pack removed). */
  public close(): void {
    this.inFlight?.abort();
    this.worker?.session.close();
    this.worker = undefined;
  }

  private async run(
    intent: ReturnType<typeof MatteSegmentFrameIntentSchema.parse>,
    context: SegmentFrameContext,
    signal: AbortSignal,
  ): Promise<MatteSegmentFrameResultWire> {
    if (!this.options.slotFree()) {
      return failure('busy', 'Hover highlight pauses while background removal or an export runs.');
    }
    const asset = context.project.assets.find((candidate) => candidate.id === intent.assetId);
    if (asset === undefined)
      return failure('missing_asset', 'That media is no longer in this project.');
    if (asset.kind !== 'video' && asset.kind !== 'image') {
      return failure('unsupported_asset', 'Hover highlight works on video and image clips.');
    }
    const size = displaySizeOf(asset);
    if (!path.isAbsolute(asset.path) || size === undefined) {
      return failure('media_unreadable', 'This media has not been measured yet.');
    }
    const worker = await (await this.options.matte()).resolveWorker();
    if (worker.status !== 'ready') {
      return failure(
        worker.outcome.status === 'pack_missing' ? 'pack_missing' : 'pack_unhealthy',
        'The Smart Mask pack is not ready.',
      );
    }
    let timing: MatteVideoTiming;
    try {
      timing = await this.timing(asset.path, signal);
    } catch {
      if (signal.aborted) return failure('superseded', 'A newer hover replaced this one.');
      return failure('media_unreadable', 'The media file could not be read.');
    }
    const index = frameAt(timing, intent.sourceTime);
    if (index === undefined)
      return failure('invalid_request', 'That instant is before the media starts.');
    const pts = timing.pts[index]!;
    const expected = previewDimensions(size.width, size.height, intent.previewHeight);
    const frameSeconds = relative(timing, index);
    const request: CapabilityPackWorkerRequest = {
      type: 'request',
      protocolVersion: 1,
      // A fresh worker-side id per call: the renderer's id is not trusted to be unique, and a
      // late `cancelled` answer must never be matched to a newer request.
      requestId: `hover-${String((this.sequence += 1))}`,
      projectRevision: context.projectRevision,
      capability: 'subject.segment_frame',
      media: {
        handleId: `media-hover-${String(this.sequence)}`,
        assetId: asset.id,
        absolutePath: asset.path,
        sourceStartSeconds: frameSeconds,
        sourceEndSeconds: frameSeconds + 1 / frameRate(timing),
        fps: frameRate(timing),
        firstFrame: index,
        lastFrameExclusive: index + 1,
      },
      parameters: {
        pts,
        ...(intent.hoverPoint === undefined ? {} : { hoverPoint: intent.hoverPoint }),
        ...(intent.points === undefined ? {} : { points: intent.points }),
        previewHeight: intent.previewHeight,
      },
    };
    let result: SegmentFrameWorkerResult;
    const started = Date.now();
    try {
      result = await this.session(worker.entrypoint, worker.installRoot).segmentFrame({
        request,
        mediaRoot: path.dirname(asset.path),
        signal,
      });
    } catch (error) {
      if (signal.aborted) return failure('superseded', 'A newer hover replaced this one.');
      const code = error instanceof CapabilityPackWorkerRuntimeError ? error.code : 'worker_failed';
      log.warn('segmentFrameFailed', maskingEventPayload('segmentFrameFailed', { code }));
      return failure(
        code === 'media_escape' ? 'media_rejected' : 'worker_failed',
        'The Smart Mask pack could not read that frame.',
      );
    }
    const verified = verifySegmentFrame(result, pts, expected);
    log.debug('segmentFrame', maskingEventPayload('segmentFrame', { ok: verified.ok, elapsedMs: Date.now() - started }));
    return verified;
  }

  private session(
    entrypoint: string,
    installRoot: string,
  ): Pick<CapabilityPackWarmWorker, 'segmentFrame' | 'close'> {
    const key = `${entrypoint}\n${installRoot}`;
    if (this.worker?.key === key) return this.worker.session;
    // A different install (an update landed): end the old process before starting the new one.
    this.worker?.session.close();
    const open = this.options.openWorker ?? ((options) => new CapabilityPackWarmWorker(options));
    const session = open({
      entrypoint,
      extraEnvironment: { FRAMEPILOT_CAPABILITY_PACK_ROOT: installRoot },
      ...(this.options.idleMs === undefined ? {} : { idleMs: this.options.idleMs }),
    });
    this.worker = { key, session };
    return session;
  }

  /** Decoded timing per file, re-probed when the file's size or mtime changes. */
  private async timing(file: string, signal: AbortSignal): Promise<MatteVideoTiming> {
    const stat = await lstat(file);
    const stamp = `${String(stat.size)}:${String(stat.mtimeMs)}`;
    const cached = this.timings.get(file);
    if (cached?.stamp === stamp) {
      this.timings.delete(file);
      this.timings.set(file, cached);
      return cached.timing;
    }
    const timing = await this.options.inspector.videoTiming(file, signal);
    this.timings.set(file, { stamp, timing });
    while (this.timings.size > TIMING_CACHE_ENTRIES) {
      const oldest = this.timings.keys().next();
      if (oldest.done === true) break;
      this.timings.delete(oldest.value);
    }
    return timing;
  }
}

/**
 * Check one worker answer against what the host asked for and decode it strictly.
 *
 * @returns The decoded mask, or `invalid_output` with a fixed sentence.
 */
export function verifySegmentFrame(
  result: SegmentFrameWorkerResult,
  pts: number,
  expected: { readonly width: number; readonly height: number },
): MatteSegmentFrameResultWire {
  const invalid = failure(
    'invalid_output',
    'The Smart Mask pack returned a mask the app could not verify.',
  );
  if (result.pts !== pts || result.width !== expected.width || result.height !== expected.height)
    return invalid;
  if (result.maskPng.length > MAX_PNG_BASE64_CHARS) return invalid;
  const bytes = Buffer.from(result.maskPng, 'base64');
  try {
    const image = decodeGrayPng(bytes, {
      expectedWidth: expected.width,
      expectedHeight: expected.height,
    });
    return {
      ok: true,
      pts,
      width: image.width,
      height: image.height,
      mask: new Uint8Array(image.pixels),
      score: result.score,
    };
  } catch (error) {
    if (error instanceof MattePngError) return invalid;
    throw error;
  }
}

/** Average decoded frame rate, clamped to what the media handle accepts (a still reads as 30). */
function frameRate(timing: MatteVideoTiming): number {
  const count = timing.pts.length;
  const span = count > 1 ? relative(timing, count - 1) : 0;
  return span > 0 ? Math.min(240, Math.max(1e-3, (count - 1) / span)) : STILL_FRAME_RATE;
}

function relative(timing: MatteVideoTiming, index: number): number {
  return ((timing.pts[index]! - timing.pts[0]!) * timing.timeBase[0]) / timing.timeBase[1];
}

function failure(code: string, error: string): Failure {
  return { ok: false, code, error };
}
