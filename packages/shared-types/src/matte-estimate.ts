/**
 * What one background-removal job costs, before anyone starts it (BR6.4, plan 05 "READY").
 *
 * Shared by the Inspector's estimate line and the desktop agent executor, which must agree:
 * the editor confirms a long job in the Inspector, and the agent may only start a job the
 * Inspector would have started without asking (`needsConfirmation === false`). Two copies of
 * these numbers would let the agent quietly start an hours-long job the UI asks about.
 *
 * Every number comes from the BR0 spike's measured throughput and storage tables
 * (`plan/background-removal-ai/BR0-FINDINGS.md`), on the CPU execution provider. A CoreML or
 * DirectML machine may well be faster; an estimate that is too long and finishes early is a
 * kept promise, a hopeful one is not.
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
