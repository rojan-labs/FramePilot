/**
 * Jobs panel (plan/background-removal-ai/05 "Jobs panel", BR4.9).
 *
 * Every running, queued, paused and recently finished pack job: name, clip, phase, progress,
 * ETA, and Pause / Resume / Cancel / Show clip. Scheduling lives in the desktop host; this is a
 * view over `capabilityPackJobs` plus three actions, so the panel can never disagree with what
 * actually runs. A job resumed after a restart says so, and an export pause is named.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@framepilot/ui';
import type { CapabilityPackJobWire, FramePilotBridge } from '@framepilot/shared-types';

const STATE_LABEL: Readonly<Record<CapabilityPackJobWire['state'], string>> = {
  queued: 'Waiting',
  running: 'Running',
  preempted: 'Waiting for a quicker job',
  paused: 'Paused',
  paused_export: 'Paused during export',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Phase names as the editor reads them (05-INSPECTOR-UX "RUNNING"). */
const PHASE_LABEL: Readonly<Record<string, string>> = {
  decode: 'Reading frames',
  segment: 'Finding the subject',
  refine: 'Refining',
  consensus: 'Comparing estimates',
  self_correct: 'Self-correcting',
  matte: 'Matting edges',
  foreground: 'Cleaning edge colour',
  stabilise: 'Stabilising',
  verify: 'Checking every frame',
  encode: 'Saving',
};

const LIVE: ReadonlySet<CapabilityPackJobWire['state']> = new Set(['queued', 'running', 'preempted', 'paused', 'paused_export']);

export type JobActionName = 'pause' | 'resume' | 'cancel';

export interface JobsPanelProps {
  readonly jobs: readonly CapabilityPackJobWire[];
  readonly onAction: (jobId: string, action: JobActionName) => void;
  /** Select the job's clip on the timeline; the button is hidden without it. */
  readonly onShowClip?: (clipId: string) => void;
}

export function JobsPanel({ jobs, onAction, onShowClip }: JobsPanelProps): JSX.Element {
  const live = jobs.filter((job) => LIVE.has(job.state)).length;
  return (
    <section className="jobs-panel" aria-labelledby="jobs-panel-title">
      <div className="panel-head">
        <h2 id="jobs-panel-title">Jobs</h2>
        {live > 0 && <span className="panel-head-count">{live} active</span>}
      </div>
      {jobs.length === 0 ? (
        <p className="panel-empty">No background jobs.</p>
      ) : (
        <ul className="jobs-list">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} onAction={onAction} {...(onShowClip === undefined ? {} : { onShowClip })} />
          ))}
        </ul>
      )}
    </section>
  );
}

function JobRow({ job, onAction, onShowClip }: { readonly job: CapabilityPackJobWire } & Omit<JobsPanelProps, 'jobs'>): JSX.Element {
  const progress = job.progress;
  const percent = progress === undefined || progress.total === 0 ? undefined : Math.round((progress.completed / progress.total) * 100);
  const phase = progress === undefined ? undefined : (PHASE_LABEL[progress.phase] ?? progress.phase);
  const round = progress?.round === undefined ? '' : ` (round ${progress.round})`;
  const isLive = LIVE.has(job.state);
  return (
    <li className="jobs-row" data-state={job.state} aria-label={`${job.label}: ${STATE_LABEL[job.state]}`}>
      <div className="jobs-row-head">
        <span className="jobs-row-name">{job.label}</span>
        {job.clipId !== undefined && <span className="jobs-row-clip">Clip {job.clipId}</span>}
      </div>
      <div className="jobs-row-status">
        <span>{STATE_LABEL[job.state]}</span>
        {job.state === 'running' && phase !== undefined && (
          <span>
            {' · '}
            {phase}
            {round}
          </span>
        )}
        {progress?.etaSeconds !== undefined && job.state === 'running' && <span> · {formatEta(progress.etaSeconds)}</span>}
        {job.resumed && <span className="jobs-row-resumed"> · Resumed after restart</span>}
      </div>
      {isLive && percent !== undefined && (
        <div
          className="jobs-progress"
          role="progressbar"
          aria-label={`${job.label} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span className="jobs-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      {job.state === 'failed' && job.error !== undefined && <p className="panel-hint">{job.error}</p>}
      <div className="jobs-row-actions">
        {(job.state === 'running' || job.state === 'queued' || job.state === 'preempted') && (
          <Button variant="ghost" size="sm" onClick={() => onAction(job.id, 'pause')} aria-label={`Pause ${job.label}`}>
            Pause
          </Button>
        )}
        {job.state === 'paused' && (
          <Button variant="ghost" size="sm" onClick={() => onAction(job.id, 'resume')} aria-label={`Resume ${job.label}`}>
            Resume
          </Button>
        )}
        {isLive && (
          <Button variant="ghost" size="sm" onClick={() => onAction(job.id, 'cancel')} aria-label={`Cancel ${job.label}`}>
            Cancel
          </Button>
        )}
        {job.clipId !== undefined && onShowClip !== undefined && (
          <Button variant="ghost" size="sm" onClick={() => onShowClip(job.clipId!)} aria-label={`Show clip for ${job.label}`}>
            Show clip
          </Button>
        )}
      </div>
    </li>
  );
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return 'Less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `About ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `About ${hours} h left` : `About ${hours} h ${rest} min left`;
}

/** Live job list from the desktop host; empty (and inert) in the browser build. */
export function useCapabilityPackJobs(
  bridge: Pick<FramePilotBridge, 'capabilityPackJobs' | 'onCapabilityPackJobsChanged' | 'capabilityPackJobAction'> | null,
): { readonly jobs: readonly CapabilityPackJobWire[]; readonly act: (jobId: string, action: JobActionName) => void } {
  const [jobs, setJobs] = useState<readonly CapabilityPackJobWire[]>([]);
  useEffect(() => {
    if (bridge === null) return undefined;
    let active = true;
    void bridge.capabilityPackJobs?.().then((initial) => {
      if (active) setJobs(initial);
    });
    const unsubscribe = bridge.onCapabilityPackJobsChanged?.((next) => setJobs(next));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge]);
  const act = useCallback(
    (jobId: string, action: JobActionName) => {
      void bridge?.capabilityPackJobAction?.({ jobId, action });
    },
    [bridge],
  );
  return { jobs, act };
}
