/**
 * What background removal will cost this editor, before they start it (BR6.4, plan 05 "READY").
 *
 * Every number here comes from the BR0 spike's measured throughput and storage tables
 * (`BR0-FINDINGS.md`), not from a guess, and the two facts that make it honest are:
 *
 * - **It is the CPU execution provider.** Per-EP throughput is still open (BR0.7), so a CoreML or
 *   DirectML machine may well be faster. An estimate that is too long and then finishes early is
 *   a kept promise; a hopeful one is not.
 * - **It stays an estimate.** The UI says "about", and the running job replaces it with the host's
 *   own ETA (`MatteProgressWire.etaSeconds`) as soon as there is one.
 */

/** Seconds of compute per second of 1080p30 footage, CPU EP, M1 Pro (BR0-FINDINGS §Throughput). */
export const COMPUTE_SECONDS_PER_FOOTAGE_SECOND_1080P = 520;
/** The same figure at 4K30, where the subject crop needs 2×2 matting tiles. */
export const COMPUTE_SECONDS_PER_FOOTAGE_SECOND_4K = 1230;
/** Matte + foreground on disk, MiB per minute of 1080p30 (FFV1 level 3, measured). */
export const STORAGE_MIB_PER_MINUTE_1080P = 105;
/** The same at 4K30. */
export const STORAGE_MIB_PER_MINUTE_4K = 280;

/** Handles kept either side of the clip, so a later trim does not fall outside the coverage. */
export const MATTE_HANDLE_SECONDS = 2;

/** A job estimated above this asks the editor to confirm before it starts (plan 05). */
export const LONG_JOB_CONFIRM_SECONDS = 10 * 60;

const PIXELS_1080P = 1920 * 1080;
const PIXELS_4K = 3840 * 2160;

/** Linear interpolation between the two measured resolutions, clamped outside them. */
function betweenMeasured(pixels: number, at1080p: number, at4k: number): number {
  if (!Number.isFinite(pixels) || pixels <= 0) return at1080p;
  if (pixels <= PIXELS_1080P) return at1080p * (pixels / PIXELS_1080P);
  if (pixels >= PIXELS_4K) return at4k * (pixels / PIXELS_4K);
  const t = (pixels - PIXELS_1080P) / (PIXELS_4K - PIXELS_1080P);
  return at1080p + (at4k - at1080p) * t;
}

export interface MatteEstimate {
  /** Footage seconds the job covers, handles included. */
  readonly coverageSeconds: number;
  /** Compute seconds, CPU EP. */
  readonly computeSeconds: number;
  readonly bytes: number;
  /** Whether the job is long enough to need confirming first. */
  readonly needsConfirmation: boolean;
}

/**
 * Estimate one background-removal job.
 *
 * @param coverageSeconds - Footage seconds to process, handles included.
 * @param size - The media's picture size, or `null` when it has not been measured.
 * @returns The estimate, using the 1080p row when the size is unknown.
 */
export function estimateMatteJob(
  coverageSeconds: number,
  size: { readonly width: number; readonly height: number } | null,
): MatteEstimate {
  const seconds = Math.max(0, coverageSeconds);
  const pixels = size === null ? PIXELS_1080P : size.width * size.height;
  const computeSeconds =
    seconds *
    betweenMeasured(
      pixels,
      COMPUTE_SECONDS_PER_FOOTAGE_SECOND_1080P,
      COMPUTE_SECONDS_PER_FOOTAGE_SECOND_4K,
    );
  const mib =
    (seconds / 60) *
    betweenMeasured(pixels, STORAGE_MIB_PER_MINUTE_1080P, STORAGE_MIB_PER_MINUTE_4K);
  return {
    coverageSeconds: seconds,
    computeSeconds,
    bytes: mib * 1024 * 1024,
    needsConfirmation: computeSeconds > LONG_JOB_CONFIRM_SECONDS,
  };
}

/** A duration in the words an editor uses: "about 2 minutes", "about 3 hours". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  if (seconds < 90) return `${String(Math.max(1, Math.round(seconds)))} seconds`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${String(Math.round(minutes))} minutes`;
  const hours = minutes / 60;
  return hours < 10 ? `${hours.toFixed(1)} hours` : `${String(Math.round(hours))} hours`;
}

/** Bytes as an editor reads them on a disk-space line. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const mb = bytes / 1_000_000;
  if (mb < 1000) return `${String(Math.max(1, Math.round(mb)))} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

/** Elapsed seconds as a running clock ("1:07", "12:04"). */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${String(minutes)}:${String(total % 60).padStart(2, '0')}`;
}
