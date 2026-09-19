/**
 * The sidebar's answer to "which one did you mean?" (AM2.2, AM2.3; plan 11 rule 2).
 *
 * `find_mask_targets` never guesses. When it cannot tell which thing the editor meant, its
 * result lists the candidates and this picker shows them. Picking sends an ordinary message
 * naming the candidate id, which is the ONLY thing that makes a pick-required candidate usable
 * (`create_mask` checks the editor's own words) — so the choice is the editor's by construction,
 * and the conversation records it in plain text the next turn can read.
 */
import { useState } from 'react';
import type { Project } from '@framepilot/timeline-schema';
import { Button } from '@framepilot/ui';
import { FaceRecognitionConsent } from './FaceRecognitionConsent.js';
import { useCandidateThumbnail, type CandidateCrop } from './useCandidateThumbnail.js';

export interface PickerCandidate {
  readonly candidateId: string;
  readonly label: string;
  readonly box: CandidateCrop['box'];
  readonly sourceTime: number;
}

export interface MaskTargetChoice {
  readonly status: 'ambiguous_target' | 'needs_face_selection' | 'needs_click';
  readonly clipId: string;
  readonly description: string;
  readonly candidates: readonly PickerCandidate[];
}

const ASKING: ReadonlySet<string> = new Set([
  'ambiguous_target',
  'needs_face_selection',
  'needs_click',
]);

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && value >= 0 && value <= 1;

function pickerCandidate(value: unknown): PickerCandidate | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const box = record.box as Record<string, unknown> | undefined;
  if (typeof record.candidateId !== 'string' || typeof record.label !== 'string') return null;
  if (typeof record.sourceTime !== 'number' || typeof box !== 'object' || box === null) return null;
  if (!isUnit(box.x) || !isUnit(box.y) || !isUnit(box.width) || !isUnit(box.height)) return null;
  return {
    candidateId: record.candidateId,
    label: record.label,
    sourceTime: record.sourceTime,
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
  };
}

/** Read a `find_mask_targets` result that is asking the editor something; else `null`. */
export function maskTargetChoice(result: unknown): MaskTargetChoice | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  if (
    record.kind !== 'mask_targets' ||
    typeof record.status !== 'string' ||
    !ASKING.has(record.status)
  )
    return null;
  if (typeof record.clipId !== 'string' || typeof record.description !== 'string') return null;
  const candidates = (Array.isArray(record.candidates) ? record.candidates : [])
    .map(pickerCandidate)
    .filter((candidate): candidate is PickerCandidate => candidate !== null);
  return {
    status: record.status as MaskTargetChoice['status'],
    clipId: record.clipId,
    description: record.description,
    candidates,
  };
}

/** Where a candidate sits, in the words an editor would use to tell two faces apart. */
export function positionWords(box: CandidateCrop['box']): string {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const horizontal = x < 0.4 ? 'left' : x > 0.6 ? 'right' : 'centre';
  const vertical = y < 0.35 ? 'top ' : y > 0.65 ? 'bottom ' : '';
  return `${vertical}${horizontal}`;
}

/** The message a pick sends. The id is what `create_mask` looks for; the rest is for people. */
export function pickMessage(choice: MaskTargetChoice, picked: readonly PickerCandidate[]): string {
  const ids = picked.map(
    (candidate) =>
      `${candidate.candidateId} (the ${candidate.label} at the ${positionWords(candidate.box)})`,
  );
  return `For "${choice.description}" on clip ${choice.clipId}, use ${ids.join(' and ')}.`;
}

const HEADING: Readonly<Record<MaskTargetChoice['status'], string>> = {
  ambiguous_target: 'Which one did you mean?',
  needs_face_selection: 'Who should this apply to?',
  needs_click: 'This needs a click',
};

function Thumbnail({
  candidate,
  path,
}: {
  candidate: PickerCandidate;
  path: string | undefined;
}): JSX.Element {
  const url = useCandidateThumbnail(
    path === undefined ? null : { path, sourceTime: candidate.sourceTime, box: candidate.box },
  );
  return url === null ? (
    <span className="ai-mask-pick__placeholder" aria-hidden="true" />
  ) : (
    <img className="ai-mask-pick__image" src={url} alt="" />
  );
}

export function MaskTargetPicker({
  choice,
  project,
  onPick,
  disabled,
  onOpenMaskTools,
}: {
  choice: MaskTargetChoice;
  project?: Project | undefined;
  /** Sends the pick as the editor's next message. Absent ⇒ the picker is read-only. */
  onPick?: ((message: string) => void) | undefined;
  /** A run is in flight: the pick waits for it, so the message lands as its own turn. */
  disabled?: boolean | undefined;
  /** Select the clip and open the Mask tab, where the click-to-mask tool lives. */
  onOpenMaskTools?: ((clipId: string) => void) | undefined;
}): JSX.Element {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const clip = project?.timeline.tracks
    .flatMap((track) => track.clips)
    .find((item) => item.id === choice.clipId);
  const path = project?.assets.find((asset) => asset.id === clip?.assetId)?.path;

  if (choice.status === 'needs_click') {
    return (
      <div className="ai-pack-install" role="group" aria-label="click the target">
        <p>
          <strong>{HEADING.needs_click}.</strong> FramePilot cannot find “{choice.description}” by
          name. Click it on the monitor: select the clip, then Inspector → Mask → Remove background
          → choose the subject. The cut-out is just as exact.
        </p>
        {onOpenMaskTools && (
          <span className="ai-pack-install__actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => onOpenMaskTools(choice.clipId)}
            >
              Select the clip
            </Button>
          </span>
        )}
      </div>
    );
  }

  // "Everyone except the host" is a SET of people, so faces are toggled and sent together; an
  // ordinary "which one?" is one click.
  const multiple = choice.status === 'needs_face_selection';
  const locked = disabled === true || onPick === undefined;
  const chosen = choice.candidates.filter((candidate) => selected.includes(candidate.candidateId));
  const toggle = (candidateId: string): void =>
    setSelected((current) =>
      current.includes(candidateId)
        ? current.filter((id) => id !== candidateId)
        : [...current, candidateId],
    );

  return (
    <div className="ai-pack-install" role="group" aria-label="choose the mask target">
      <p>
        <strong>{HEADING[choice.status]}</strong> For “{choice.description}”.
        {multiple ? ' Pick everyone it should apply to.' : ''}
        {disabled === true ? ' You can pick as soon as the assistant finishes.' : ''}
      </p>
      <ul className="ai-mask-pick">
        {choice.candidates.map((candidate) => (
          <li key={candidate.candidateId}>
            <button
              type="button"
              className="ai-mask-pick__option"
              disabled={locked}
              {...(multiple ? { 'aria-pressed': selected.includes(candidate.candidateId) } : {})}
              onClick={() =>
                multiple
                  ? toggle(candidate.candidateId)
                  : onPick?.(pickMessage(choice, [candidate]))
              }
              aria-label={`Pick the ${candidate.label} at the ${positionWords(candidate.box)}`}
            >
              <Thumbnail candidate={candidate} path={path} />
              <span className="ai-mask-pick__caption">
                {candidate.label} · {positionWords(candidate.box)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {multiple && project !== undefined && <FaceRecognitionConsent projectId={project.id} />}
      <span className="ai-pack-install__actions">
        {multiple && (
          <Button
            variant="secondary"
            type="button"
            disabled={locked || chosen.length === 0}
            onClick={() => onPick?.(pickMessage(choice, chosen))}
          >
            Use selected
          </Button>
        )}
        {choice.candidates.length > 1 && (
          <Button
            variant="ghost"
            type="button"
            disabled={locked}
            onClick={() => onPick?.(pickMessage(choice, choice.candidates))}
          >
            All of them
          </Button>
        )}
      </span>
    </div>
  );
}
