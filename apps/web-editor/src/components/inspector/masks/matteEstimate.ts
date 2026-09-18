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

export {
  COMPUTE_SECONDS_PER_FOOTAGE_SECOND_1080P,
  COMPUTE_SECONDS_PER_FOOTAGE_SECOND_4K,
  LONG_JOB_CONFIRM_SECONDS,
  MATTE_HANDLE_SECONDS,
  STORAGE_MIB_PER_MINUTE_1080P,
  STORAGE_MIB_PER_MINUTE_4K,
  estimateMatteJob,
  type MatteEstimate,
} from '@framepilot/shared-types';

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
