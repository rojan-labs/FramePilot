/**
 * The one look an AI mask gets, where the numbers cannot decide (AM3.2; plan 11 "Verification
 * after apply").
 *
 * Deterministic facts come first and are always reported: the pack's flagged ranges, the track's
 * residual, the validator. They cannot say whether the mask is on the RIGHT THING. For that there
 * is exactly one bounded question — "is the masked region the {label}?" — put to the existing
 * vision-review route at no more than four frames, with three answers:
 *
 * - **yes** — nothing changes; the result says a spot check agreed. It is still not "verified".
 * - **no** — the mask is NOT applied. The call fails with the remedy: resolve the target again
 *   more specifically, or ask the editor. A mask on the wrong person never reaches the timeline.
 * - **unsure** — the mask is applied, and the frames looked at go on the review list, so the
 *   editor sees exactly the moments nobody could vouch for.
 *
 * A host with no reviewer, a cloud reviewer without media-egress consent, or a cancelled run
 * yields `not_run`: a fact about the check, never an opinion about the mask.
 */
import type { Project } from '@framepilot/timeline-schema';
import {
  MAX_VISION_FRAMES,
  VISION_REVIEW_VERSION,
  reviewVisionObjectives,
  type VisionFrameAcquirer,
  type VisionJudge,
  type VisionMediaEgressConsent,
  type VisionReviewRequest,
  type VisionReviewerIdentity,
} from '../vision-review.js';

export type MaskSpotCheckVerdict = 'yes' | 'no' | 'unsure' | 'not_run';

export interface MaskSpotCheckResult {
  readonly verdict: MaskSpotCheckVerdict;
  /** What the reviewer saw, or why no look happened. Shown to the editor. */
  readonly reason: string;
  /** Timeline frames that were looked at. */
  readonly frames: readonly number[];
}

/** What the orchestrator's run hands in: the same live objects picture verification uses. */
export interface MaskSpotCheckControls {
  readonly acquire: (
    project: Project,
    request: VisionReviewRequest,
    signal?: AbortSignal,
  ) => ReturnType<VisionFrameAcquirer>;
  readonly judge: VisionJudge;
  readonly reviewer: VisionReviewerIdentity;
  readonly mediaEgressConsent?: VisionMediaEgressConsent;
}

export interface MaskSpotCheckInput {
  /** The project WITH the mask applied — the reviewer looks at the result, not the intent. */
  readonly project: Project;
  readonly clipId: string;
  readonly maskId: string;
  /** What the mask is supposed to be on, in the editor's or the detector's words. */
  readonly label: string;
  /** What the mask does, so the reviewer knows what "the masked region" looks like. */
  readonly purpose: 'cutout' | 'hide' | 'effect';
  /** Source-second ranges the pack or the tracker flagged; looked at first. */
  readonly flagged: readonly { readonly start: number; readonly end: number }[];
  readonly controls?: MaskSpotCheckControls;
  readonly signal?: AbortSignal;
}

/** A candidate this confident, with nothing flagged, is one the numbers already decided. */
export const SPOT_CHECK_CONFIDENT_SCORE = 0.8;

/**
 * Whether the numbers leave the question open. An editor-picked or editor-typed target is
 * never second-guessed: they said which thing, and a model disagreeing is not evidence.
 */
export function spotCheckIsWarranted(facts: {
  readonly flaggedCount: number;
  readonly candidateScore?: number;
  readonly editorChose: boolean;
}): boolean {
  if (facts.editorChose) return false;
  if (facts.flaggedCount > 0) return true;
  return facts.candidateScore === undefined || facts.candidateScore < SPOT_CHECK_CONFIDENT_SCORE;
}

const REVEALED: Readonly<Record<MaskSpotCheckInput['purpose'], string>> = {
  cutout: 'the part of the picture that is kept (everything else is cut away)',
  hide: 'the part of the picture that is removed',
  effect: 'the part of the picture that looks graded differently from the rest',
};

/** The single structured question. One sentence a person could answer by looking. */
export function spotCheckQuestion(label: string, purpose: MaskSpotCheckInput['purpose']): string {
  return (
    `A mask was applied to this clip. The masked region is ${REVEALED[purpose]}. ` +
    `Is the masked region the ${label}? Answer pass for yes, fail for no, and cannot_tell if you are unsure.`
  );
}

/** Up to four timeline frames: the middle of each flagged range first, then an even spread. */
export function spotCheckFrames(
  input: Pick<MaskSpotCheckInput, 'project' | 'clipId' | 'flagged'>,
): number[] {
  const clip = input.project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((item) => item.id === input.clipId);
  if (clip === undefined) return [];
  const fps = input.project.fps;
  const first = Math.round(clip.start * fps);
  const last = Math.max(first, Math.ceil(clip.end * fps) - 1);
  const rate = clip.speed !== undefined && clip.speed > 0 ? clip.speed : 1;
  const toTimelineFrame = (sourceSeconds: number): number =>
    Math.min(
      last,
      Math.max(first, Math.round((clip.start + (sourceSeconds - clip.sourceStart) / rate) * fps)),
    );
  const flagged = input.flagged.map((range) => toTimelineFrame((range.start + range.end) / 2));
  const spread = [0.5, 0.15, 0.85, 0.33].map((share) => Math.round(first + (last - first) * share));
  return [...new Set([...flagged, ...spread])].slice(0, MAX_VISION_FRAMES);
}

/** Timeline frames back to the source-second ranges a review list stores. */
export function framesToSourceRanges(
  project: Project,
  clipId: string,
  frames: readonly number[],
): { start: number; end: number }[] {
  const clip = project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((item) => item.id === clipId);
  if (clip === undefined) return [];
  const rate = clip.speed !== undefined && clip.speed > 0 ? clip.speed : 1;
  const frameSeconds = 1 / project.fps;
  return [...frames]
    .sort((a, b) => a - b)
    .map((frame) => {
      const source = clip.sourceStart + (frame / project.fps - clip.start) * rate;
      return { start: Math.max(0, source), end: Math.max(0, source) + frameSeconds * rate };
    });
}

const notRun = (reason: string, frames: readonly number[] = []): MaskSpotCheckResult => ({
  verdict: 'not_run',
  reason,
  frames,
});

/**
 * Ask the one question. Never throws: a look that could not happen is `not_run`, and the
 * caller's deterministic report stands on its own.
 */
export async function spotCheckMask(input: MaskSpotCheckInput): Promise<MaskSpotCheckResult> {
  const { controls } = input;
  if (controls === undefined)
    return notRun('This host has no vision reviewer, so no spot check was made.');
  // Rendered frames leave the machine for a cloud reviewer only with the editor's consent.
  if (controls.reviewer.transport === 'cloud' && controls.mediaEgressConsent === undefined) {
    return notRun(
      'A cloud reviewer needs the editor’s consent to see frames, so no spot check was made.',
    );
  }
  const frames = spotCheckFrames(input);
  if (frames.length === 0) return notRun('There was no frame of this clip to look at.');
  const revision = input.project.timeline.revision ?? 0;
  try {
    const report = await reviewVisionObjectives({
      requests: [
        {
          schemaVersion: VISION_REVIEW_VERSION,
          requestId: `mask-spot-check:${input.clipId}:${input.maskId}`,
          projectRevision: revision,
          objective: spotCheckQuestion(input.label, input.purpose),
          frames,
        },
      ],
      projectRevision: revision,
      acquire: (request) => controls.acquire(input.project, request, input.signal),
      judge: controls.judge,
      reviewer: controls.reviewer,
      ...(controls.mediaEgressConsent === undefined
        ? {}
        : { mediaEgressConsent: controls.mediaEgressConsent }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (input.signal?.aborted === true)
      return notRun('The run was cancelled before the spot check finished.', frames);
    const [check] = report.checks;
    if (check === undefined) return notRun('The reviewer returned nothing.', frames);
    const verdict: MaskSpotCheckVerdict =
      check.status === 'pass' ? 'yes' : check.status === 'fail' ? 'no' : 'unsure';
    return { verdict, reason: check.reason, frames };
  } catch (cause) {
    return notRun(
      `The spot check could not run: ${cause instanceof Error ? cause.message : String(cause)}`,
      frames,
    );
  }
}
