/**
 * Disk-space preflight for a matte job (plan 03 "Disk space", audit P12, BR4.10).
 *
 * The estimate comes from measured output, not a guess: BR0-FINDINGS "Storage per minute
 * (FFV1 level 3, 30 fps)" on the walk_pan pilot. Bytes per frame are interpolated by pixel
 * count between the 1080p and 4K rows (and extrapolated beyond them), times the job's frame
 * count, times 1.2 headroom. The pilot's subject covered ~5% of the frame, so a close-up with
 * hair can be several times larger; the headroom is for that, and a mid-job shortfall still
 * fails cleanly as `output_unwritable`.
 */
import { statfs } from 'node:fs/promises';

const MIB = 1024 * 1024;
const FRAMES_PER_MINUTE_MEASURED = 30 * 60;
/** BR0-FINDINGS: 1080p30 matte 23.2 MiB/min, foreground 81.4 MiB/min. */
const HD = { pixels: 1920 * 1080, matte: 23.2 * MIB, foreground: 81.4 * MIB } as const;
/** BR0-FINDINGS: 4K30 matte 61.2 MiB/min, foreground 218.6 MiB/min (a lower bound). */
const UHD = { pixels: 3840 * 2160, matte: 61.2 * MIB, foreground: 218.6 * MIB } as const;
/** Proxy previews (WebM) were not measured in BR0; budget them at a tenth of the masters. */
const PREVIEW_SHARE = 0.1;
/** Plan 03: 20% headroom over the estimate. */
export const MATTE_DISK_HEADROOM = 1.2;

export interface MatteDiskEstimate {
  /** Expected artifact bytes, before headroom. */
  readonly estimatedBytes: number;
  /** What must be free to start: the estimate with headroom. */
  readonly requiredBytes: number;
}

export function estimateMatteBytes(width: number, height: number, frameCount: number, foreground: boolean): MatteDiskEstimate {
  const pixels = Math.max(1, width * height);
  const perMinute = (row: 'matte' | 'foreground'): number => {
    const slope = (UHD[row] - HD[row]) / (UHD.pixels - HD.pixels);
    // Linear in pixel count through the two measured points, never below a pixel-scaled floor.
    return Math.max(HD[row] * (pixels / HD.pixels) * 0.5, HD[row] + slope * (pixels - HD.pixels));
  };
  const perFrame = (perMinute('matte') + (foreground ? perMinute('foreground') : 0)) / FRAMES_PER_MINUTE_MEASURED;
  const estimatedBytes = Math.ceil(perFrame * frameCount * (1 + PREVIEW_SHARE));
  return { estimatedBytes, requiredBytes: Math.ceil(estimatedBytes * MATTE_DISK_HEADROOM) };
}

/** Free bytes on the volume holding `directory` (available to this user). */
export async function freeDiskBytes(directory: string): Promise<number> {
  const info = await statfs(directory);
  return Number(info.bavail) * Number(info.bsize);
}

const GIB = 1024 * MIB;
/**
 * Frames one Smart Mask window holds (`segment.py` WINDOW_FRAMES 300 + WINDOW_OVERLAP 60).
 * A job shorter than this holds only its own frames.
 */
const WORKER_WINDOW_FRAMES = 360;
/**
 * Scratch bytes per pixel of one window frame (`pipeline.py`): RGB frames (3) and a reuse copy
 * (3), plus the u8/bool planes (BiRefNet, alpha, band, estimate, silhouette: 5). Rounded up to 16
 * so a pipeline change that adds a plane does not kill healthy jobs.
 */
const SCRATCH_BYTES_PER_WINDOW_PIXEL = 16;
/** `PipelineConfig.embedding_spill_bytes`: SAM embeddings spilled to scratch. */
const EMBEDDING_SPILL_BYTES = 8 * GIB;
/** Temp files (TMPDIR points into scratch, F3), ffmpeg concat lists, checkpoint JSON. */
const SCRATCH_SLACK_BYTES = GIB;

/**
 * The most a matte job's whole staging folder may hold (BR4.12 follow-up F1): three times the
 * artifact's byte ceiling (the declared outputs, each finished window's segments in `windows/`
 * until the join, and a re-run's cloned previous matte in `inputs/`) plus one window's scratch.
 *
 * A bound, not an estimate: it is what keeps the folder finite when the volume cannot report
 * free space, and it is generous so a healthy job never meets it.
 */
export function matteStagingBudgetBytes(width: number, height: number, frameCount: number, byteCeiling: number): number {
  const windowFrames = Math.min(Math.max(frameCount, 1), WORKER_WINDOW_FRAMES);
  const scratch = windowFrames * Math.max(1, width * height) * SCRATCH_BYTES_PER_WINDOW_PIXEL;
  return 3 * Math.max(0, byteCeiling) + scratch + EMBEDDING_SPILL_BYTES + SCRATCH_SLACK_BYTES;
}
