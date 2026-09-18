/**
 * Per-mask tracking in the Inspector's Mask tab (MK7.4, plan 10 "Tracking", plan 05 "Review").
 *
 * The editor drew the mask; this panel MEASURES its motion through an installed Capability Pack
 * worker and pins the resulting transform track on the mask. It replaces the old clip-wide
 * "Measure and follow" buttons, which could only steer one hard-coded mask's bounding box.
 *
 * What the panel owns, and why each piece is here rather than in main:
 *
 * - **Method** and **direction**. Both are the editor's judgement about the shot, not something to
 *   infer: a sign on a wall is a perspective track, a face is position+scale+rotation, a hand is a
 *   shape track, and "from here to the end" is a different request from "the whole clip".
 * - **Feature points and exclusion regions.** Extra texture the tracker should follow, and regions
 *   it must ignore (a hand passing in front). They are sent with the request; main bounds and
 *   validates both before anything spawns.
 * - **Progress and cancel**, on the same channels as every other pack job.
 * - **The review list**, shared with mattes: the ranges the measurement itself flagged, with
 *   Lock this frame (a constraint) and Re-track from constraints.
 *
 * Everything that changes the project goes through `runMaskCommand`, so the panel and the agent
 * take the identical reversible path.
 */
import { useMemo, useState } from 'react';
import { masksOf, type Clip, type MaskLayer } from '@framepilot/timeline-schema';
import { Button } from '@framepilot/ui';
import type { MaskTrackIntentWire } from '@framepilot/shared-types';
import type { UseEditor } from '../../../editor/useEditor.js';
import { clipSourceTimeAt, runMaskCommand } from '../../../editor/mask-editing.js';
import { LabeledSelect } from '../LabeledSelect.js';
import { PackToolWarning } from './PackToolWarning.js';
import { packToolCopy, TRACKING_LITE_PACK } from './packToolCopy.js';
import { TRACKING_CAPABILITY, usePackStatus } from './usePackStatus.js';
import { maskToolStore, useMaskTools, type MaskToolStore } from './useMaskTools.js';
import { useMaskTrackJob } from './useMaskTrackJob.js';

type Method = MaskTrackIntentWire['method'];
type Direction = MaskTrackIntentWire['direction'];

const METHODS: readonly Method[] = [
  'position',
  'position-scale-rotation',
  'perspective',
  'point-cloud',
];
const METHOD_LABELS = ['Position', 'Position, scale and rotation', 'Perspective', 'Shape'] as const;

const DIRECTIONS: readonly Direction[] = ['forward', 'backward', 'both', 'one-frame'];
const DIRECTION_LABELS = [
  'Forward to the clip edge',
  'Backward to the clip start',
  'Both ways',
  'One frame',
] as const;

/** Mask kinds a transform track can move (`_TRACKABLE_KINDS` of the engine). */
const TRACKABLE = new Set<MaskLayer['kind']>(['rectangle', 'ellipse', 'path']);

const TRACKING_WARNING_ID = 'mask-tracking-pack-note';

function seconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

export interface MaskTrackingProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  readonly fps: number;
  readonly store?: MaskToolStore;
}

export function MaskTracking({
  editor,
  clip,
  store = maskToolStore,
}: MaskTrackingProps): JSX.Element | null {
  const tools = useMaskTools(store);
  const mask = useMemo(
    () => masksOf(clip).find((candidate) => candidate.id === tools.selectedMaskId),
    [clip, tools.selectedMaskId],
  );
  // Tracking is pack-backed like background removal, and fails the same handful of ways: the
  // pack is missing, unhealthy, unsupported here, or there is no desktop app at all (BR6.2).
  const { status, refresh } = usePackStatus(TRACKING_CAPABILITY);
  const packCopy = packToolCopy(status, { pack: TRACKING_LITE_PACK, tool: 'Mask tracking' });
  const [method, setMethod] = useState<Method>('position');
  const [direction, setDirection] = useState<Direction>('forward');
  const [message, setMessage] = useState<string | null>(null);
  const sourceTime = clipSourceTimeAt(clip, editor.state.playhead);

  const job = useMaskTrackJob({
    onComplete: (result) => {
      const refusal = runMaskCommand(editor, {
        type: 'set_mask_track',
        clipId: clip.id,
        maskId: result.maskId,
        tracking: {
          artifact: result.artifact,
          method: result.method,
          referenceSourceTime: result.referenceSourceTime,
          constraints: [...result.constraints],
          review: { flagged: [...result.flagged], approved: [], locked: [] },
        },
      });
      setMessage(
        refusal ??
          (result.flagged.length === 0
            ? 'Tracked. Nothing needs review.'
            : `Tracked. ${result.flagged.length} range(s) need review.`),
      );
    },
  });

  if (mask === undefined) {
    return <p className="inspector-empty inspector-empty-inline">Select a mask to track it.</p>;
  }
  if (!TRACKABLE.has(mask.kind)) {
    return (
      <p className="inspector-empty inspector-empty-inline">
        Only shape masks can be tracked — a matte or a key follows its own pixels.
      </p>
    );
  }

  const tracking = mask.tracking;
  const flagged = tracking?.review.flagged ?? [];
  const running = job.phase !== 'idle';
  const start = (fromConstraints: boolean): void => {
    setMessage(null);
    void job.run({
      clipId: clip.id,
      maskId: mask.id,
      method: method === 'point-cloud' && mask.kind !== 'path' ? 'position' : method,
      direction,
      referenceSourceTime: sourceTime,
      ...(tools.featurePoints.length > 0 ? { featurePoints: [...tools.featurePoints] } : {}),
      ...(tools.exclusions.length > 0 ? { exclusions: [...tools.exclusions] } : {}),
      ...(fromConstraints ? { fromConstraints: true } : {}),
    });
  };

  return (
    <div className="inspector-subpanel" aria-label="mask tracking">
      <LabeledSelect
        caption="Method"
        label="tracking method"
        value={method}
        options={METHODS}
        labels={METHOD_LABELS}
        onChange={(value) => setMethod(value as Method)}
      />
      <LabeledSelect
        caption="Direction"
        label="tracking direction"
        value={direction}
        options={DIRECTIONS}
        labels={DIRECTION_LABELS}
        onChange={(value) => setDirection(value as Direction)}
      />
      {method === 'point-cloud' && mask.kind !== 'path' && (
        <p className="inspector-empty inspector-empty-inline">
          A shape track follows a path’s vertices. Draw a path mask, or choose another method.
        </p>
      )}
      <p className="inspector-empty inspector-empty-inline">
        {tools.featurePoints.length} feature point(s), {tools.exclusions.length} excluded region(s).
      </p>
      <PackToolWarning
        id={TRACKING_WARNING_ID}
        copy={packCopy}
        status={status}
        onInstalled={refresh}
      />
      {running ? (
        <>
          <p className="inspector-empty inspector-empty-inline" role="status">
            Tracking… {job.progress ? `${job.progress.completed}/${job.progress.total}` : ''}
          </p>
          <Button
            variant="secondary"
            type="button"
            onClick={job.cancel}
            disabled={job.phase === 'cancelling'}
          >
            {job.phase === 'cancelling' ? 'Cancelling…' : 'Cancel'}
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          type="button"
          disabled={packCopy.blocked}
          aria-disabled={packCopy.blocked}
          {...(packCopy.blocked
            ? { 'aria-describedby': TRACKING_WARNING_ID, title: packCopy.tooltip }
            : {})}
          onClick={() => start(false)}
        >
          Track this mask
        </Button>
      )}
      {tracking !== undefined && !running && (
        <div className="inspector-subpanel" aria-label="track review">
          <p className="inspector-empty inspector-empty-inline">
            {flagged.length === 0
              ? 'Verified — every frame of this track cleared its confidence floor.'
              : `${flagged.length} range(s) need review.`}
          </p>
          <ul aria-label="flagged tracking ranges">
            {flagged.map((range) => (
              <li key={`${range.start}-${range.end}`}>
                <button
                  type="button"
                  onClick={() => editor.seek(clip.start + (range.start - clip.sourceStart))}
                >
                  {seconds(range.start)} – {seconds(range.end)}
                </button>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            type="button"
            onClick={() =>
              setMessage(
                runMaskCommand(editor, {
                  type: 'add_track_constraint',
                  clipId: clip.id,
                  maskId: mask.id,
                  sourceTime,
                }) ?? 'This frame is locked. Re-track from constraints to fix the range.',
              )
            }
          >
            Lock this frame
          </Button>{' '}
          <Button
            variant="ghost"
            type="button"
            disabled={(tracking.constraints ?? []).length === 0}
            onClick={() => start(true)}
          >
            Re-track from constraints
          </Button>{' '}
          <Button
            variant="ghost"
            type="button"
            onClick={() =>
              setMessage(
                runMaskCommand(editor, {
                  type: 'clear_mask_track',
                  clipId: clip.id,
                  maskId: mask.id,
                }) ?? 'The track was removed; the mask keeps its own animation.',
              )
            }
          >
            Remove track
          </Button>
        </div>
      )}
      {(job.error !== null || message !== null) && (
        <p
          role={job.error === null ? 'status' : 'alert'}
          className="inspector-empty inspector-empty-inline"
        >
          {job.error ?? message}
        </p>
      )}
      {job.proposal !== null && (
        <div role="dialog" aria-label="capability pack install">
          <p>
            <strong>{job.proposal.displayName}</strong> —{' '}
            {(job.proposal.downloadBytes / 1_000_000).toFixed(1)} MB. Licenses:{' '}
            {job.proposal.licenses.map((license: { spdx: string }) => license.spdx).join(', ')}.
            Media never leaves this machine.
          </p>
          <Button
            variant="primary"
            type="button"
            onClick={() => void job.approveInstall()}
            disabled={job.installing}
          >
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
