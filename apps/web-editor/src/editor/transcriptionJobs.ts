import type { AsrProviderName } from '@framepilot/shared-types';

/** A transcription request that may outlive the panel that displays it. */
export type TranscriptionJob =
  | {
      readonly kind: 'running';
      readonly assetId: string;
      readonly provider: AsrProviderName;
      readonly startedAt: number;
    }
  | {
      readonly kind: 'error';
      readonly assetId: string;
      readonly provider: AsrProviderName;
      readonly startedAt: number;
      readonly message: string;
    };

type Listener = () => void;

const jobs = new Map<string, TranscriptionJob>();
const listeners = new Set<Listener>();
let snapshot: ReadonlyMap<string, TranscriptionJob> = new Map();

function publish(): void {
  snapshot = new Map(jobs);
  for (const listener of listeners) listener();
}

/** Subscribe to project-wide transcription activity, including import-triggered jobs. */
export function subscribeTranscriptionJobs(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for React's `useSyncExternalStore`. */
export function getTranscriptionJobsSnapshot(): ReadonlyMap<string, TranscriptionJob> {
  return snapshot;
}

/** Start or restart a job and return the shared state written for it. */
export function beginTranscriptionJob(
  assetId: string,
  provider: AsrProviderName,
): Extract<TranscriptionJob, { kind: 'running' }> {
  const job = { kind: 'running' as const, assetId, provider, startedAt: performance.now() };
  jobs.set(assetId, job);
  publish();
  return job;
}

/** Remove a completed job. The applied transcript becomes the durable success state. */
export function finishTranscriptionJob(assetId: string): void {
  if (!jobs.delete(assetId)) return;
  publish();
}

/** Keep a recoverable failure visible where the job's progress was shown. */
export function failTranscriptionJob(assetId: string, message: string): void {
  const current = jobs.get(assetId);
  if (!current) return;
  jobs.set(assetId, { ...current, kind: 'error', message });
  publish();
}

/** Test-only reset. Exported to keep singleton state isolated between focused tests. */
export function resetTranscriptionJobs(): void {
  if (jobs.size === 0) return;
  jobs.clear();
  publish();
}
