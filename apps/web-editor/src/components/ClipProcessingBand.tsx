/**
 * The striped band over the part of a clip whose background removal has not been processed yet
 * (BR6.8, plan 05 "Progressive results").
 *
 * Finished windows land in the monitor as they complete, which is the point of progressive
 * results — but it also means a partly processed clip looks exactly like a finished one. The band
 * is what keeps that honest: it covers the range the job has not reached, and disappears when the
 * job ends, whatever the outcome.
 *
 * It reads the job store, not the project: the project has no idea a job is running, and it
 * should not — a band is a view of work in flight, not a fact about the edit.
 */
import { matteJobStore, type MatteJobStore } from './inspector/masks/matteJobStore.js';
import { useMatteJob } from './inspector/masks/useMatteJob.js';

export function ClipProcessingBand({
  clipId,
  jobs = matteJobStore,
}: {
  readonly clipId: string;
  /** Injectable for tests. */
  readonly jobs?: MatteJobStore;
}): JSX.Element | null {
  const job = useMatteJob(clipId, jobs);
  if (job === null) return null;
  // Windows finish in order from the start of the coverage, so what is left is the tail.
  const done = job.total > 0 ? Math.min(1, Math.max(0, job.completed / job.total)) : 0;
  return (
    <span
      className="clip-processing-band"
      aria-hidden="true"
      title="Removing the background"
      style={{ left: `${String(done * 100)}%`, width: `${String((1 - done) * 100)}%` }}
    />
  );
}
