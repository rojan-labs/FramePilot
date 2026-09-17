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
