/**
 * Background removal in the Inspector's Mask tab (BR6.1, plan 05 "Copy and controls per state").
 *
 * This is the first action row of the mask panel and the front door to every pack-backed tool, so
 * it carries the rules the rest of them follow:
 *
 * - **The tool is always visible.** When the Smart Mask pack is missing the button stays on screen,
 *   disabled, with a warning that says what would fix it. Hiding a capability teaches the editor it
 *   does not exist; disabling it with a reason teaches them what to do.
 * - **The warning is `role="status"`, not `role="alert"`.** The Inspector re-renders on every clip
 *   selection, and an alert would re-announce "not installed" each time.
 * - **Installing here updates everywhere.** `usePackStatus` re-checks on `onCapabilityPackInstalled`,
 *   so an install started in Settings or the AI sidebar unblocks this row without a restart, and
 *   vice versa.
 * - **Every project change is a typed mask command.** The row starts a job; the job's result becomes
 *   one reversible `add_matte_mask` through the editor's validated patch path, exactly as the agent's
 *   would.
 */
import { useState } from 'react';
import { assetDisplaySize } from '@framepilot/editor-core';
import type { Clip } from '@framepilot/timeline-schema';
import type { MattePromptRefWire } from '@framepilot/shared-types';
import { Button } from '@framepilot/ui';
import type { UseEditor } from '../../../editor/useEditor.js';
import {
  MATTE_HANDLE_SECONDS,
  estimateMatteJob,
  formatBytes,
  formatDuration,
} from './matteEstimate.js';
import { PackToolWarning } from './PackToolWarning.js';
import { hardwareNotice, packToolCopy, SMART_MASK_PACK } from './packToolCopy.js';
import { matteJobStore, type MatteJobStore } from './matteJobStore.js';
import { useClipMatteJob } from './useMatteJob.js';
import {
  maskToolStore,
  useMaskTools,
  type MaskToolStore,
  type SubjectPoint,
} from './useMaskTools.js';
import { SUBJECT_MATTE_CAPABILITY, usePackStatus } from './usePackStatus.js';

/** How the editor tells the pack which subject to keep. */
export type SubjectMode = 'auto' | 'pick';

const TOOL_NAME = 'Background removal';
const WARNING_ID = 'background-removal-pack-note';

/**
 * The editor's clicks as the wire's prompts: one `points` prompt per source instant, because the
 * pack is prompted at a frame and two clicks on the same frame are one prompt, not two.
 */
export function subjectPrompts(points: readonly SubjectPoint[]): MattePromptRefWire[] {
  const byInstant = new Map<number, { x: number; y: number; label: 'include' | 'exclude' }[]>();
  for (const point of points) {
    const list = byInstant.get(point.sourceTime) ?? [];
    list.push({ x: point.x, y: point.y, label: point.label });
    byInstant.set(point.sourceTime, list);
  }
  return [...byInstant.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sourceTime, list]) => ({ kind: 'points', sourceTime, points: list }));
}

export interface BackgroundRemovalRowProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  /** Injectable for tests. */
  readonly store?: MaskToolStore;
  readonly jobs?: MatteJobStore;
  /** Development builds can register a pack from disk; releases cannot. */
  readonly developmentBuild?: boolean;
}

export function BackgroundRemovalRow({
  editor,
  clip,
  store = maskToolStore,
  jobs = matteJobStore,
  developmentBuild = import.meta.env.DEV,
}: BackgroundRemovalRowProps): JSX.Element {
  const { status, refresh } = usePackStatus(SUBJECT_MATTE_CAPABILITY);
  const tools = useMaskTools(store);
  const { job, start } = useClipMatteJob(clip.id, jobs);
  const [subject, setSubject] = useState<SubjectMode>('auto');
  // RD0 parity control (Premiere Object Mask): the delivered matte is the precise one either way;
  // this is which edge treatment the mask carries.
  const [edgeMode, setEdgeMode] = useState<'sharp' | 'smooth'>('smooth');
  const [message, setMessage] = useState<string | null>(null);

  const copy = packToolCopy(status, {
    pack: SMART_MASK_PACK,
    tool: TOOL_NAME,
    developmentBuild,
  });
  const hardware = 'hardware' in status ? status.hardware : null;
  const hardwareLine = hardwareNotice(hardware ?? null);
  const media = editor.state.assets.find((asset) => asset.id === clip.assetId)?.media;
  const size = assetDisplaySize(media);
  const coverage = {
    sourceStart: Math.max(0, clip.sourceStart - MATTE_HANDLE_SECONDS),
    sourceEnd: clip.sourceEnd + MATTE_HANDLE_SECONDS,
  };
  const estimate = estimateMatteJob(coverage.sourceEnd - coverage.sourceStart, size);
  const running = job !== null;

  const run = (): void => {
    setMessage(null);
    if (subject === 'pick' && tools.subjectPoints.length === 0) {
      setMessage('Click the subject on the monitor first.');
      return;
    }
    if (
      estimate.needsConfirmation &&
      !window.confirm(
        `This will take about ${formatDuration(estimate.computeSeconds)} on this computer. Start it?`,
      )
    ) {
      return;
    }
    void start({
      assetId: clip.assetId,
      clipId: clip.id,
      sourceStart: coverage.sourceStart,
      sourceEnd: coverage.sourceEnd,
      prompts: subject === 'auto' ? [] : subjectPrompts(tools.subjectPoints),
      edgeMode,
      timelineRevision: editor.state.timeline.revision ?? 0,
    }).then((refusal) => setMessage(refusal));
  };

  return (
    <div className="inspector-subpanel background-removal" aria-label="Background removal">
      <PackToolWarning id={WARNING_ID} copy={copy} status={status} onInstalled={refresh} />
      {hardwareLine !== null && !copy.blocked && (
        <p className="inspector-empty" role="status">
          {hardwareLine}
        </p>
      )}
      {!copy.blocked && (
        <>
          <fieldset className="background-removal-subject">
            <legend>Subject</legend>
            <label>
              <input
                type="radio"
                name={`subject-${clip.id}`}
                checked={subject === 'auto'}
                onChange={() => setSubject('auto')}
              />
              Auto (main subject)
            </label>
            <label>
              <input
                type="radio"
                name={`subject-${clip.id}`}
                checked={subject === 'pick'}
                onChange={() => setSubject('pick')}
              />
              Click to pick
            </label>
          </fieldset>
          {subject === 'pick' && (
            <p className="inspector-empty">
              {tools.subjectPoints.length === 0
                ? 'Pick AI Object on the monitor, then click the subject.'
                : `${String(tools.subjectPoints.length)} point(s) picked.`}
            </p>
          )}
          <fieldset className="background-removal-subject">
            <legend>Edges</legend>
            <label>
              <input
                type="radio"
                name={`edges-${clip.id}`}
                checked={edgeMode === 'smooth'}
                onChange={() => setEdgeMode('smooth')}
              />
              Smooth (hair and soft edges)
            </label>
            <label>
              <input
                type="radio"
                name={`edges-${clip.id}`}
                checked={edgeMode === 'sharp'}
                onChange={() => setEdgeMode('sharp')}
              />
              Sharp (hard edges)
            </label>
          </fieldset>
          <p className="inspector-empty">
            Covers this clip plus {String(MATTE_HANDLE_SECONDS)} s of handles.
          </p>
          <p className="inspector-empty">
            About {formatDuration(estimate.computeSeconds)} on this computer ·{' '}
            {formatBytes(estimate.bytes)} on disk.
          </p>
        </>
      )}
      <Button
        variant="primary"
        type="button"
        disabled={copy.blocked || running}
        aria-disabled={copy.blocked || running}
        {...(copy.blocked ? { 'aria-describedby': WARNING_ID, title: copy.tooltip } : {})}
        onClick={run}
      >
        Remove background
      </Button>
      {message !== null && (
        <p className="inspector-empty" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
