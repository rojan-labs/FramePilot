/**
 * Pack-driven mask actions in the Inspector's Mask tab.
 *
 * The user drew the mask; these buttons MEASURE its subject through an
 * installed Capability Pack worker and animate that same mask from the
 * measurements — the identical reversible `track_object` patch the agent path
 * produces, applied through the editor's checked pipeline so validation,
 * history, and desktop persistence behave like any other manual edit.
 */
import { useMemo, useState } from 'react';
import { compileTrackingCommand, type ApplyTrackedMaskCommand } from '@framepilot/editor-core';
import type { Clip, Effect } from '@framepilot/timeline-schema';
import type { UseEditor } from '../../editor/useEditor.js';
import { Button } from '@framepilot/ui';
import { professionalMaskEffectId } from '@framepilot/editor-core';
import type { TrackingSampleWire } from '@framepilot/shared-types';
import { LabeledSelect } from './LabeledSelect.js';
import { usePackJob } from './usePackJob.js';

type FollowMode = 'box' | 'center' | 'silhouette';

const FOLLOW_OPTIONS = ['box', 'center', 'silhouette'] as const;
const FOLLOW_LABELS = ['Follow box', 'Follow centre', 'Follow silhouette'] as const;

function professionalMask(clip: Clip): Effect | undefined {
  const id = professionalMaskEffectId(clip.id);
  return clip.effects.find((effect) => effect.id === id && effect.type === 'mask');
}

function maskBounds(effect: Effect): { x: number; y: number; width: number; height: number } | undefined {
  const raw = (effect.params as Record<string, unknown>).bounds;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, number>;
  const values = [record.x, record.y, record.width, record.height];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
  return { x: record.x!, y: record.y!, width: record.width!, height: record.height! };
}

export function MaskPackActions({
  editor,
  clip,
  fps,
}: {
  editor: UseEditor;
  clip: Clip;
  fps: number;
}): JSX.Element | null {
  const mask = useMemo(() => professionalMask(clip), [clip]);
  const bounds = mask === undefined ? undefined : maskBounds(mask);
  const shapeOk =
    mask !== undefined &&
    ((mask.params as Record<string, unknown>).shape === 'rectangle' ||
      (mask.params as Record<string, unknown>).shape === 'ellipse');
  const [mode, setMode] = useState<FollowMode>('box');
  const [localError, setLocalError] = useState<string | null>(null);

  const job = usePackJob({
    onComplete: (result) => {
      if (result.kind !== 'tracking') {
        setLocalError('This job did not return a track.');
        return;
      }
      // Identical conversion to the agent path: measured samples become a
      // validated, exactly invertible tracked-mask patch.
      const command: ApplyTrackedMaskCommand = {
        type: 'apply_tracked_mask',
        timelineRevision: editor.state.timeline.revision ?? 0,
        clipId: clip.id,
        maskEffectId: professionalMaskEffectId(clip.id),
        target: mode === 'center' ? ('object' as const) : ('bounding_box' as const),
        engine: result.engine,
        fps,
        startSeconds: 0,
        samples: result.samples.map(
          (sample: TrackingSampleWire) => sample,
        ),
      };
      const compiled = compileTrackingCommand({
        timeline: editor.state.timeline,
        assets: editor.state.assets,
        command,
      });
      if (compiled.status === 'rejected') {
        setLocalError(`${compiled.code}: ${compiled.detail}`);
        return;
      }
      const issues = editor.applyPatchChecked(compiled.patch);
      if (issues.length > 0) setLocalError(issues.map((issue) => issue.message).join('; '));
    },
  });

  if (mask === undefined || !shapeOk || bounds === undefined) {
    return (
      <p className="inspector-empty inspector-empty-inline">
        Add a rectangle or ellipse mask first — pack tracking measures the subject inside it.
      </p>
    );
  }

  const capability =
    mode === 'center' ? 'tracking.point' : mode === 'silhouette' ? 'subject.segment' : 'tracking.region';
  const parameters =
    mode === 'center'
      ? { point: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } }
      : { region: { ...bounds } };
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const firstFrame = Math.max(0, Math.round(clip.sourceStart * safeFps));
  const lastFrameExclusive = Math.max(firstFrame + 1, Math.round(clip.sourceEnd * safeFps));

  const run = (): void => {
    setLocalError(null);
    void job.run({ assetId: clip.assetId, capability, firstFrame, lastFrameExclusive, fps: safeFps, parameters });
  };

  const running = job.phase !== 'idle';

  return (
    <div className="inspector-subpanel" aria-label="pack-tracking">
      <LabeledSelect
        caption="Measure"
        label="pack follow mode"
        value={mode}
        options={FOLLOW_OPTIONS}
        labels={FOLLOW_LABELS}
        onChange={(value) => setMode(value as FollowMode)}
      />
      {running ? (
        <>
          <p className="inspector-empty inspector-empty-inline" role="status">
            Measuring… {job.progress ? `${job.progress.phase} ${job.progress.completed}/${job.progress.total}` : ''}
          </p>
          <Button variant="secondary" type="button" onClick={job.cancel} disabled={job.phase === 'cancelling'}>
            {job.phase === 'cancelling' ? 'Cancelling…' : 'Cancel'}
          </Button>
        </>
      ) : (
        <Button variant="secondary" type="button" onClick={run}>
          Measure and follow
        </Button>
      )}
      {(job.error !== null || localError !== null) && (
        <p role="alert" className="inspector-empty inspector-empty-inline">
          {localError ?? job.error}
        </p>
      )}
      {job.proposal !== null && (
        <div role="dialog" aria-label="capability pack install">
          <p>
            <strong>{job.proposal.displayName}</strong> — {(job.proposal.downloadBytes / 1_000_000).toFixed(1)} MB.
            Licenses: {job.proposal.licenses.map((license) => license.spdx).join(', ')}. Media never leaves this
            machine.
          </p>
          <Button variant="primary" type="button" onClick={() => void job.approveInstall()} disabled={job.installing}>
            {job.installing ? 'Installing…' : 'Review and install'}
          </Button>{' '}
          <Button variant="ghost" type="button" onClick={job.dismissProposal}>
            Not now
          </Button>
        </div>
      )}
    </div>
  );
}
