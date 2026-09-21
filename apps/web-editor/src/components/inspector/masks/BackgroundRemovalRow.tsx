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
import { useEffect, useState } from 'react';
import { assetDisplaySize } from '@framepilot/editor-core';
import { masksOf, type Clip } from '@framepilot/timeline-schema';
import type { MatteValidationIssueWire } from '@framepilot/shared-types';
import type { MattePromptRefWire } from '@framepilot/shared-types';
import { Button } from '@framepilot/ui';
import type { UseEditor } from '../../../editor/useEditor.js';
import { runMaskCommand } from '../../../editor/mask-editing.js';
import { currentMatteIssues, hasPictureBehind } from '../../../editor/matteReview.js';
import { useOpenedMatteIssues } from '../../../editor/openedMattes.js';
import { useRelinkedMatteIssues } from '../../../editor/relinkAsset.js';
import {
  MATTE_HANDLE_SECONDS,
  estimateMatteJob,
  formatBytes,
  formatClock,
  formatDuration,
} from './matteEstimate.js';
import { PackToolWarning } from './PackToolWarning.js';
import { hardwareNotice, packToolCopy, SMART_MASK_PACK } from './packToolCopy.js';
import {
  matteJobStore,
  mattePhaseLabel,
  type MatteJobState,
  type MatteJobStore,
} from './matteJobStore.js';
import { useClipMatteJob, useMatteJobs } from './useMatteJob.js';
import {
  maskToolStore,
  useMaskTools,
  type MaskToolStore,
  type SubjectBox,
  type SubjectPoint,
} from './useMaskTools.js';
import { LabeledSelect } from '../LabeledSelect.js';
import { useMatteIssues } from './useMatteIssues.js';
import { SUBJECT_MATTE_CAPABILITY, usePackStatus } from './usePackStatus.js';

/** How the editor tells the pack which subject to keep. */
export type SubjectMode = 'auto' | 'pick';

type Quality = 'fast' | 'best';
const QUALITIES: readonly Quality[] = ['fast', 'best'];
const QUALITY_LABELS = ['Fast (minutes)', 'Best quality (can take hours)'] as const;
const SUBJECT_MODES: readonly SubjectMode[] = ['auto', 'pick'];
const SUBJECT_LABELS = ['Auto (main subject)', 'Click to pick'] as const;

/** RD0 parity control (Premiere Object Mask). The delivered matte is precise either way. */
const EDGE_MODES: readonly ('smooth' | 'sharp')[] = ['smooth', 'sharp'];
const EDGE_LABELS = ['Smooth (hair and soft edges)', 'Sharp (hard edges)'] as const;

const TOOL_NAME = 'Background removal';
const WARNING_ID = 'background-removal-pack-note';

/**
 * The editor's clicks (and box, BR7.5) as the wire's prompts: one `points` prompt per source
 * instant, because the pack is prompted at a frame and two clicks on the same frame are one
 * prompt, not two. A box is its own prompt; on the same frame as clicks the pack merges them.
 */
export function subjectPrompts(
  points: readonly SubjectPoint[],
  box: SubjectBox | null = null,
): MattePromptRefWire[] {
  const byInstant = new Map<number, { x: number; y: number; label: 'include' | 'exclude' }[]>();
  for (const point of points) {
    const list = byInstant.get(point.sourceTime) ?? [];
    list.push({ x: point.x, y: point.y, label: point.label });
    byInstant.set(point.sourceTime, list);
  }
  const clicks: MattePromptRefWire[] = [...byInstant.entries()]
    .sort(([a], [b]) => a - b)
    .map(([sourceTime, list]) => ({ kind: 'points', sourceTime, points: list }));
  if (box === null) return clicks;
  const { sourceTime, ...rect } = box;
  return [{ kind: 'box', sourceTime, box: rect }, ...clicks];
}

export interface BackgroundRemovalRowProps {
  readonly editor: UseEditor;
  readonly clip: Clip;
  /** Injectable for tests. */
  readonly store?: MaskToolStore;
  readonly jobs?: MatteJobStore;
  /** Development builds can register a pack from disk; releases cannot. */
  readonly developmentBuild?: boolean;
  /** STALE/BROKEN mattes main reported, with the engine's own remedy sentences. */
  readonly issues?: readonly MatteValidationIssueWire[];
}

export function BackgroundRemovalRow({
  editor,
  clip,
  store = maskToolStore,
  jobs = matteJobStore,
  developmentBuild = import.meta.env.DEV,
  issues = [],
}: BackgroundRemovalRowProps): JSX.Element {
  const { status, refresh } = usePackStatus(SUBJECT_MATTE_CAPABILITY);
  const tools = useMaskTools(store);
  const { job, start, cancel } = useClipMatteJob(clip.id, jobs);
  const notice = useMatteJobs(jobs).notices[clip.id];
  const [subject, setSubject] = useState<SubjectMode>('auto');
  // RD0 parity control (Premiere Object Mask): the delivered matte is the precise one either way;
  // this is which edge treatment the mask carries.
  const [edgeMode, setEdgeMode] = useState<'sharp' | 'smooth'>('smooth');
  // Plan 13: the Fast engine exists only where the host says so (macOS, a pack that knows it).
  // Elsewhere every job is a Best job, and offering a choice that does nothing would be a lie.
  const fastAvailable = status.kind === 'ready' && status.fastMatte;
  const [chosenQuality, setChosenQuality] = useState<Quality>('fast');
  const quality: Quality = fastAvailable ? chosenQuality : 'best';
  const [message, setMessage] = useState<string | null>(null);
  const [behindText, setBehindText] = useState('');

  const copy = packToolCopy(status, {
    pack: SMART_MASK_PACK,
    tool: TOOL_NAME,
    developmentBuild,
  });
  const hardware = 'hardware' in status ? status.hardware : null;
  const hardwareLine = hardwareNotice(hardware ?? null);
  const clipAsset = editor.state.assets.find((asset) => asset.id === clip.assetId);
  const media = clipAsset?.media;
  const size = assetDisplaySize(media);
  const coverage = {
    sourceStart: Math.max(0, clip.sourceStart - MATTE_HANDLE_SECONDS),
    sourceEnd: clip.sourceEnd + MATTE_HANDLE_SECONDS,
  };
  const estimate = estimateMatteJob(coverage.sourceEnd - coverage.sourceStart, size, quality);
  const running = job !== null;
  const matte = masksOf(clip).find((mask) => mask.kind === 'matte') ?? null;
  const applied = matte !== null;
  const checked = useMatteIssues(
    applied ? clip.assetId : null,
    matte?.kind === 'matte' ? matte.artifact.key : undefined,
  );
  // Until main's re-check answers, what it found when the project opened (BR4.15): a deleted
  // matte is BROKEN from the first paint, not only once the re-check comes back.
  const opened = useOpenedMatteIssues();
  // Main's answer describes the SAVED project, which can lag the one on screen by an autosave:
  // a finding about an artifact this clip no longer carries (a re-run replaced it) is dropped.
  const detected = currentMatteIssues(editor.state.timeline, checked ?? opened);
  // What the relink found, while the clip still plays the file it was checked for and still
  // carries the matte it was checked against (a re-run replaces the key and clears it).
  const relinkedIssues = currentMatteIssues(
    editor.state.timeline,
    useRelinkedMatteIssues(applied ? clip.assetId : null, clipAsset?.path),
  );
  const issue =
    [...issues, ...detected, ...relinkedIssues].find((candidate) => candidate.clipId === clip.id) ??
    null;

  const run = (): void => {
    setMessage(null);
    if (subject === 'pick' && tools.subjectPoints.length === 0 && tools.subjectBox === null) {
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
      // Running it again REPLACES this clip's background removal: a stale or broken one's remedy
      // is "run Remove background again", and a second matte stacked on the old one would leave
      // the old one refusing the export (found in E2E.6).
      ...(matte !== null ? { maskId: matte.id } : {}),
      sourceStart: coverage.sourceStart,
      sourceEnd: coverage.sourceEnd,
      prompts: subject === 'auto' ? [] : subjectPrompts(tools.subjectPoints, tools.subjectBox),
      edgeMode,
      ...(fastAvailable ? { quality } : {}),
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
      {running && job !== null && <MatteProgress job={job} onCancel={cancel} />}
      {!copy.blocked && !running && (
        <>
          <LabeledSelect
            caption="Subject"
            label="background removal subject"
            value={subject}
            options={SUBJECT_MODES}
            labels={SUBJECT_LABELS}
            onChange={(value) => setSubject(value)}
          />
          {subject === 'pick' && (
            <p className="inspector-empty">
              {tools.subjectPoints.length === 0 && tools.subjectBox === null
                ? 'Pick AI Object on the monitor, then click the subject or drag a box around it.'
                : `${String(tools.subjectPoints.length)} point(s) picked${tools.subjectBox === null ? '' : ' and a box drawn'}.`}
            </p>
          )}
          {fastAvailable && (
            <LabeledSelect
              caption="Speed"
              label="background removal speed"
              value={chosenQuality}
              options={QUALITIES}
              labels={QUALITY_LABELS}
              onChange={(value) => setChosenQuality(value)}
            />
          )}
          <LabeledSelect
            caption="Edges"
            label="background removal edges"
            value={edgeMode}
            options={EDGE_MODES}
            labels={EDGE_LABELS}
            onChange={(value) => setEdgeMode(value)}
          />
          {notice?.disk === undefined ? (
            <p className="inspector-empty">
              About {formatDuration(estimate.computeSeconds)} on this computer ·{' '}
              {formatBytes(estimate.bytes)} on disk.
            </p>
          ) : (
            // BR6.8: with too little room the estimate stops being advice and becomes the
            // blocker, with the two numbers that matter.
            <p className="inspector-empty" role="alert">
              Not enough disk space: this needs about {formatBytes(notice.disk.requiredBytes)} and{' '}
              {formatBytes(notice.disk.freeBytes)} is free. Free some space, then{' '}
              <button
                type="button"
                className="inspector-text-button"
                onClick={() => jobs.setNotice(clip.id, null)}
              >
                check again
              </button>
              .
            </p>
          )}
          <p className="inspector-empty">
            Covers this clip plus {String(MATTE_HANDLE_SECONDS)} s of handles. The first run on this
            computer also prepares the models, so it takes longer than later ones.
          </p>
        </>
      )}
      <Button
        variant="primary"
        type="button"
        disabled={copy.blocked || running || notice?.disk !== undefined}
        aria-disabled={copy.blocked || running || notice?.disk !== undefined}
        {...(copy.blocked ? { 'aria-describedby': WARNING_ID, title: copy.tooltip } : {})}
        onClick={run}
      >
        Remove background
      </Button>
      {applied && !running && (
        <>
          {issue !== null && (
            <p className="inspector-empty" role="alert">
              {/* The engine's own sentence, carried over the wire, so the Inspector, the export
                  dialog and the render refusal never paraphrase each other. */}
              {issue.remedy}
            </p>
          )}
          {!hasPictureBehind(editor.state.timeline, clip.id) && (
            <p className="inspector-empty" role="status">
              Nothing below this clip, so the removed area exports as black. Put a clip, image or
              colour on the track below.
            </p>
          )}
          <label className="background-removal-text">
            Text behind the subject
            <input
              type="text"
              value={behindText}
              placeholder="Type the text"
              onChange={(event) => setBehindText(event.target.value)}
            />
          </label>
          <Button
            variant="secondary"
            type="button"
            disabled={behindText.trim() === ''}
            onClick={() => {
              const refusal = runMaskCommand(editor, {
                type: 'text_behind_subject',
                clipId: clip.id,
                text: behindText,
                maskId: matte.id,
              });
              setMessage(refusal ?? 'Text added behind the subject.');
              if (refusal === null) setBehindText('');
            }}
          >
            Put text behind subject
          </Button>
        </>
      )}
      {message !== null && (
        <p className="inspector-empty" role="status">
          {message}
        </p>
      )}
      {notice !== undefined && (
        <p className="inspector-empty" role={notice.tone === 'alert' ? 'alert' : 'status'}>
          {notice.message}
        </p>
      )}
    </div>
  );
}

/**
 * The running job (BR6.4): which phase it is in, how far through, how long it has taken and how
 * long is left, and one way to stop it.
 *
 * The bar is a real `progressbar` with the counts on it, and the ETA is the HOST's number — when
 * the host has not produced one yet the line says nothing rather than extrapolating from two
 * frames, because an ETA that swings is worse than no ETA.
 */
export function MatteProgress({
  job,
  onCancel,
}: {
  readonly job: MatteJobState;
  readonly onCancel: () => void;
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, (now - job.startedAt) / 1000);
  const label = mattePhaseLabel(job.phase, job.round);
  // Whole-job frames when the pack reports them. `completed`/`total` count ONE phase of one part
  // of the clip: drawn as the job's bar they showed "done" at the first loaded model (plan 13).
  const whole = job.overallTotal !== null && job.overallCompleted !== null && job.overallTotal > 0;
  const done = whole ? job.overallCompleted! : job.completed;
  const total = whole ? job.overallTotal! : job.total;
  const counted = whole || job.total > 1;
  const percent = counted && total > 0 ? Math.round((done / total) * 100) : null;
  const left = whole ? job.jobEtaSeconds : job.etaSeconds;

  return (
    <div className="background-removal-progress">
      <p className="inspector-empty" role="status" aria-live="polite">
        {label}
        {whole && percent !== null ? ` · ${String(percent)}% of the clip` : ''}
      </p>
      <div
        role="progressbar"
        className="background-removal-bar"
        data-indeterminate={percent === null ? 'true' : undefined}
        aria-label="Background removal progress"
        aria-valuemin={0}
        aria-valuemax={percent === null ? 100 : total}
        {...(percent === null ? {} : { 'aria-valuenow': done })}
        aria-valuetext={
          percent === null
            ? label
            : whole
              ? `${String(done)} of ${String(total)} frames`
              : `${label}: ${String(done)} of ${String(total)}`
        }
      >
        <span
          className="background-removal-bar-fill"
          style={percent === null ? undefined : { width: `${String((done / total) * 100)}%` }}
        />
      </div>
      <p className="inspector-empty">
        {formatClock(elapsed)} elapsed
        {left === null
          ? ''
          : ` · about ${formatDuration(left)} left${whole ? '' : ' in this step'}`}
      </p>
      <Button variant="secondary" type="button" disabled={job.cancelling} onClick={onCancel}>
        {job.cancelling ? 'Stopping…' : 'Cancel'}
      </Button>
    </div>
  );
}
