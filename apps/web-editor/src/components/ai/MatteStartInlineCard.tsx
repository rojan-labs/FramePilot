/**
 * One-click start for a background removal the agent prepared but may not start itself.
 *
 * A cut-out is measured in hundreds of compute-seconds per second of footage, and the Inspector
 * asks before starting a job over ten minutes. The agent gets no way round that question: its
 * executor returns `needs_editor_start` with the exact intent, and this card is the editor's
 * answer. Starting it runs the SAME job the Inspector's "Remove background" row runs — the same
 * store, the same jobs panel, the same reversible `add_matte_mask` commit and the same review
 * list when it finishes — so there is no second path for a matte into the project.
 */
import { useState } from 'react';
import type { MatteRunIntentWire } from '@framepilot/shared-types';
import { Button } from '@framepilot/ui';
import { formatDuration } from '../inspector/masks/matteEstimate.js';
import { matteJobStore, type MatteJobStore } from '../inspector/masks/matteJobStore.js';

/** What the agent prepared: the job, and how long the Inspector's estimate says it takes. */
export interface MatteStartProposal {
  readonly job: Omit<MatteRunIntentWire, 'requestId' | 'timelineRevision'>;
  readonly estimateSeconds: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Read a `needs_editor_start` tool result. Anything malformed yields `null` and no card: main
 * re-validates the intent when the job starts, so this only decides whether to OFFER it.
 */
export function matteStartProposal(result: unknown): MatteStartProposal | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  if (record.code !== 'needs_editor_start') return null;
  const job = record.job as Record<string, unknown> | undefined;
  if (typeof job !== 'object' || job === null) return null;
  if (typeof job.assetId !== 'string' || typeof job.clipId !== 'string') return null;
  if (
    !isFiniteNumber(job.sourceStart) ||
    !isFiniteNumber(job.sourceEnd) ||
    job.sourceEnd <= job.sourceStart
  )
    return null;
  if (!Array.isArray(job.prompts) || !isFiniteNumber(record.estimateSeconds)) return null;
  const { timelineRevision: _stale, requestId: _unused, ...rest } = job;
  return { job: rest as MatteStartProposal['job'], estimateSeconds: record.estimateSeconds };
}

export function MatteStartInlineCard({
  proposal,
  timelineRevision,
  store = matteJobStore,
}: {
  proposal: MatteStartProposal;
  /** The editor's CURRENT revision: the agent's is stale by the time anyone clicks. */
  timelineRevision: number;
  store?: MatteJobStore;
}): JSX.Element {
  const [phase, setPhase] = useState<'offer' | 'starting' | 'started' | 'dismissed'>('offer');
  const [error, setError] = useState<string | null>(null);

  if (phase === 'dismissed') return <></>;
  if (phase === 'started') {
    return (
      <div className="ai-pack-install" role="status">
        Background removal is running. It is added to the clip when it finishes, and anything it is
        unsure about goes to the Inspector’s review list.
      </div>
    );
  }
  return (
    <div className="ai-pack-install" role="dialog" aria-label="start background removal">
      <p>
        <strong>Remove the background</strong> on this clip — about{' '}
        {formatDuration(proposal.estimateSeconds)}. It runs in the background while you keep
        editing.
      </p>
      <span className="ai-pack-install__actions">
        <Button
          variant="secondary"
          type="button"
          disabled={phase === 'starting'}
          onClick={() => {
            setPhase('starting');
            setError(null);
            // Not awaited to completion: `start` resolves when the job ENDS. The store reports
            // a refusal to start (already running, no desktop host) straight away.
            let settled = false;
            void store.start({ ...proposal.job, timelineRevision }).then((refusal) => {
              settled = true;
              if (refusal === null) return;
              setError(refusal);
              setPhase('offer');
            });
            queueMicrotask(() => {
              if (!settled) setPhase('started');
            });
          }}
        >
          {phase === 'starting' ? 'Starting…' : 'Start'}
        </Button>
        <Button variant="ghost" type="button" onClick={() => setPhase('dismissed')}>
          Not now
        </Button>
      </span>
      {error !== null && (
        <p role="alert" className="ai-pack-install__error">
          {error}
        </p>
      )}
    </div>
  );
}
