/**
 * Jobs panel (plan/background-removal-ai/05 "Jobs panel", BR4.9).
 *
 * Every running, queued, paused and recently finished pack job: name, clip, phase, progress,
 * ETA, and Pause / Resume / Cancel / Show clip. Scheduling lives in the desktop host; this is a
 * view over `capabilityPackJobs` plus three actions, so the panel can never disagree with what
 * actually runs. A job resumed after a restart says so, and an export pause is named.
 *
 * The host's `completed`/`total` count ONE step (and restart with every step and every part of a
 * long clip). Drawing them as the job's made a "Loading models 1/1" read as a finished job that
 * then ran for hours. So: when the pack reports whole-job frames (plan 13) the bar and the time
 * left are the JOB's, with the step named beside them; from an older pack they are the current
 * step's and say so, and the only whole-job fact shown is how long it has been running.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@framepilot/ui';
import type { CapabilityPackJobWire, FramePilotBridge } from '@framepilot/shared-types';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import { getBridge } from '../editor/bridge.js';

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
  prepare: 'Loading models',
  initialize: 'Getting ready',
  track: 'Following the subject',
  detect: 'Looking for subjects',
  embed: 'Reading the picture',
  describe: 'Describing the picture',
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

/** The elapsed-time label only needs minute precision. */
const ELAPSED_TICK_MS = 30_000;

const LIVE: ReadonlySet<CapabilityPackJobWire['state']> = new Set(['queued', 'running', 'preempted', 'paused', 'paused_export']);

export type JobActionName = 'pause' | 'resume' | 'cancel';

export interface JobsPanelProps {
  readonly jobs: readonly CapabilityPackJobWire[];
  readonly onAction: (jobId: string, action: JobActionName) => void;
  /** Select the job's clip on the timeline; the button is hidden without it. */
  readonly onShowClip?: (clipId: string) => void;
  /** A readable name for a clip (its media file); the raw id is shown without it. */
  readonly clipLabel?: (clipId: string) => string | undefined;
}

export function JobsPanel({ jobs, onAction, onShowClip, clipLabel }: JobsPanelProps): JSX.Element {
  const live = jobs.filter((job) => LIVE.has(job.state)).length;
  const now = useNow(jobs.some((job) => job.state === 'running' && job.startedAt !== undefined));
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
            <JobRow
              key={job.id}
              job={job}
              now={now}
              onAction={onAction}
              {...(onShowClip === undefined ? {} : { onShowClip })}
              {...(clipLabel === undefined ? {} : { clipLabel })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function JobRow({
  job,
  now,
  onAction,
  onShowClip,
  clipLabel,
}: { readonly job: CapabilityPackJobWire; readonly now: number } & Omit<JobsPanelProps, 'jobs'>): JSX.Element {
  const isLive = LIVE.has(job.state);
  const running = job.state === 'running';
  const pausing = running && job.pausePending === true;
  const elapsed = running && job.startedAt !== undefined ? formatElapsed((now - job.startedAt) / 1_000) : undefined;
  return (
    <li className="jobs-row" data-state={job.state} aria-label={`${job.label}: ${STATE_LABEL[job.state]}`}>
      <div className="jobs-row-head">
        <span className="jobs-row-name">{job.label}</span>
        {job.clipId !== undefined && (
          <span className="jobs-row-clip">{clipLabel?.(job.clipId) ?? `Clip ${job.clipId}`}</span>
        )}
      </div>
      <div className="jobs-row-status">
        <span>{pausing ? 'Pausing after this step' : STATE_LABEL[job.state]}</span>
        {elapsed !== undefined && <span> · {elapsed}</span>}
        {job.resumed && <span className="jobs-row-resumed"> · Resumed after restart</span>}
      </div>
      {isLive && job.progress !== undefined && <JobStep label={job.label} progress={job.progress} running={running} />}
      {job.state === 'failed' && job.error !== undefined && <p className="panel-hint">{job.error}</p>}
      <div className="jobs-row-actions">
        {(running || job.state === 'queued' || job.state === 'preempted') && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pausing}
            onClick={() => onAction(job.id, 'pause')}
            aria-label={`Pause ${job.label}`}
          >
            {pausing ? 'Pausing…' : 'Pause'}
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

/** How far the job is: the whole job when the pack says, otherwise the step it is on. */
function JobStep({
  label,
  progress,
  running,
}: {
  readonly label: string;
  readonly progress: NonNullable<CapabilityPackJobWire['progress']>;
  /** A paused or waiting job keeps the step it stopped on, without a sweep or a time left. */
  readonly running: boolean;
}): JSX.Element {
  const phase = PHASE_LABEL[progress.phase] ?? progress.phase;
  const round = progress.round === undefined ? '' : ` (round ${progress.round})`;
  const whole = progress.overallTotal !== undefined && progress.overallCompleted !== undefined && progress.overallTotal > 0;
  const done = whole ? progress.overallCompleted! : progress.completed;
  const total = whole ? progress.overallTotal! : progress.total;
  // A step of one unit (loading a model) has nothing to count: 0% or 100% would both mislead.
  const counted = whole || progress.total > 1;
  const percent = counted ? Math.round((done / total) * 100) : undefined;
  const eta = whole ? progress.jobEtaSeconds : progress.etaSeconds;
  const bar: ReactNode =
    percent === undefined ? (
      <div className="jobs-progress" data-indeterminate={running ? 'true' : 'idle'} role="progressbar" aria-label={`${label} progress`}>
        <span className="jobs-progress-fill" />
      </div>
    ) : (
      <div
        className="jobs-progress"
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={whole ? `${percent}% of the clip, ${phase}` : `${phase}: ${done} of ${total}`}
      >
        <span className="jobs-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    );
  return (
    <div className="jobs-step">
      <div className="jobs-step-head">
        <span className="jobs-step-name">
          {phase}
          {round}
        </span>
        {counted && <span className="jobs-step-count">{whole ? `${percent}%` : `${done} of ${total}`}</span>}
      </div>
      {bar}
      {running && eta !== undefined && (
        <span className="jobs-step-eta">
          {formatEta(eta)}
          {whole ? '' : ' in this step'}
        </span>
      )}
    </div>
  );
}

/** A clock for the elapsed label, ticking only while something is running. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return 'Just started';
  if (minutes < 60) return `${minutes} min so far`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h so far` : `${Math.floor(minutes / 60)} h ${rest} min so far`;
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

/** The media file a clip plays, by name, for the jobs list ("interview.mov"). */
export function jobClipLabel(timeline: Timeline, assets: readonly Asset[], clipId: string): string | undefined {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip === undefined) continue;
    const asset = assets.find((candidate) => candidate.id === clip.assetId);
    const name = asset?.path.split(/[\\/]/u).pop();
    return name === undefined || name === '' ? undefined : name;
  }
  return undefined;
}

export interface JobsRailProps {
  readonly timeline: Timeline;
  readonly assets: readonly Asset[];
  /** Select the clip, move the playhead to it and show it in the Inspector. */
  readonly onShowClip: (clipId: string) => void;
  /** Injected in tests; the desktop bridge otherwise. */
  readonly bridge?: Parameters<typeof useCapabilityPackJobs>[0];
}

/**
 * The Jobs panel as the right rail mounts it (BR6.12): the host's live job list, clip names from
 * the open timeline, and "Show clip" that lands on the clip. A job whose clip was deleted keeps
 * its row (it may still be running); Show clip then leaves the selection alone.
 */
export function JobsRail({ timeline, assets, onShowClip, bridge }: JobsRailProps): JSX.Element {
  const [source] = useState(() => (bridge === undefined ? getBridge() : bridge));
  const { jobs, act } = useCapabilityPackJobs(source);
  const clipLabel = useCallback(
    (clipId: string) => jobClipLabel(timeline, assets, clipId),
    [timeline, assets],
  );
  const showClip = useCallback(
    (clipId: string) => {
      if (timeline.tracks.some((track) => track.clips.some((clip) => clip.id === clipId))) onShowClip(clipId);
    },
    [timeline, onShowClip],
  );
  return <JobsPanel jobs={jobs} onAction={act} onShowClip={showClip} clipLabel={clipLabel} />;
}
