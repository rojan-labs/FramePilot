/**
 * The striped band over the part of a clip whose background removal has not been processed yet
 * (BR6.8, plan 05 "Progressive results").
 *
 * It covers the range the job has not reached, and disappears when the job ends, whatever the
 * outcome. NOTE: the monitor does not show a running job's finished parts (this comment used to
 * say it did). The matte appears when the job commits; the band is the only in-flight feedback
 * on the clip. Showing parts early needs the media protocol to read a job's staging folder,
 * which is a sandbox change for the maintainer to decide (plan 13, SP2 "deferred").
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
  // Whole-clip frames when the pack reports them (ADR 0182). `completed`/`total` count ONE phase
  // of one part of the clip and restart constantly: the band drawn from them swept back and
  // forth across the clip with every step. Without whole-clip numbers the honest band is the
  // whole clip, not a guess.
  const whole = job.overallTotal !== null && job.overallCompleted !== null && job.overallTotal > 0;
  const done = whole ? Math.min(1, Math.max(0, job.overallCompleted! / job.overallTotal!)) : 0;
  return (
    <span
      className="clip-processing-band"
      aria-hidden="true"
      title="Removing the background"
      style={{ left: `${String(done * 100)}%`, width: `${String((1 - done) * 100)}%` }}
    />
  );
}
