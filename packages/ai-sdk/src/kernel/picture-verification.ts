/**
 * @framepilot/ai-sdk/kernel/picture-verification — pixels VERIFY an apply; they never plan it
 * (ADR 0175 §4, `plan/visual-understanding/06-VERIFICATION-AND-EVAL.md` §VU7).
 *
 * After an apply that touched picture clips, this asks the two questions the run is actually
 * judged on: did this edit introduce a defect on screen, and if the numbers cannot say, did
 * anyone look? Nothing here decides *what to edit* — every frame it spends is spent after the
 * operations already exist, on a cut this apply is responsible for.
 *
 * ## The four rules, in the order they bind
 *
 * 1. **Deterministic first, vision only where numbers cannot decide.** A residual, a black
 *    ratio and a Hamming distance are free of opinion and cost no model tokens. The vision
 *    reviewer is reached only for a pair the deterministic pass returned as *undecided*, and
 *    `vision-review.ts`' own six rules then apply unchanged — in particular `cannot_tell` is
 *    not a pass.
 * 2. **An inherited defect is an ADVISORY, never a shortfall.** {@link diffPicture} already
 *    draws that line, and this module does not re-decide it: only `added` and `worsened`
 *    changes become candidates. A cut that was over-exposed before the run started never
 *    costs a frame here.
 * 3. **Honest degradation.** No sidecar, no vision-capable provider, no budget headroom, a
 *    cancelled run, a missing result — every one of them settles as `unverified`. There is no
 *    path from "could not check" to "checked and fine".
 * 4. **It adds facts and nothing else.** No return value of this module can turn a valid
 *    apply into a failed one, and none of it is a repair trigger. The caller records the
 *    facts; the model reads them next turn and decides for itself.
 *
 * ## Why the bounds are the numbers they are
 *
 * `framesSeenPerEdit` has a measured floor of **0.00** (`reports/golden/BASELINE.md`) and the
 * golden gate treats it as a *ceiling*: a change that raises it has not worked. So every
 * bound below is chosen to keep the ceiling reachable, not to maximise coverage.
 *
 * - {@link MAX_VERIFIED_CUTS_PER_APPLY} = **4**. A deterministic comparison decodes two
 *   composited frames; four pairs is eight frames, ~38 ms each at `REVIEW_MAX_DIMENSION`
 *   (measured, `temporal-evidence-client.ts`), so ~0.3 s of decode on top of the compile the
 *   turn's temporal review already pays. These frames are **never shown to a model**, so they
 *   do not count against `framesSeenPerEdit` at all — they are bounded for wall-clock, not
 *   for tokens. Beyond four, a single apply's verification starts to cost more than the apply.
 * - {@link MAX_VISION_PAIRS_PER_APPLY} = **2** and {@link VISION_FRAMES_PER_PAIR} = **2**.
 *   These four frames DO reach a model, at roughly a thousand image tokens each, so a worst
 *   case apply contributes 4 to `framesSeen`. In practice it contributes 0: escalation
 *   requires two disagreeing tier-2 descriptions, and tier 2 does not run on a default
 *   install. That asymmetry is deliberate — the expensive path is the one that has to earn
 *   its way in.
 * - One batch, one review, no retry loop. Repair is the agent's next turn, not more looking.
 */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { BLACK_FRAME } from '../perceptual-thresholds.js';
import type { ProviderName } from '../providers/types.js';
import { supportsVision } from '../providers/model-capabilities.js';
import type { TemporalEvidenceAcquirer } from '../temporal-evidence-client.js';
import type { TemporalEvidenceRequest, TemporalEvidenceResult } from '../temporal-review.js';
import {
  reviewVisionObjectives,
  type VisionJudge,
  type VisionMediaEgressConsent,
  type VisionReviewRequest,
  type VisionReviewerIdentity,
  VISION_REVIEW_VERSION,
} from '../vision-review.js';
import type { ProjectVisionFrameAcquirer } from '../vision-evidence-client.js';
import { TEMPORAL_EVIDENCE_VERSION } from '../temporal-review.js';
import { diffPicture, MAX_PICTURE_LINES, type PictureChange } from './briefing-picture.js';
import type { PictureCut, PictureCutFlag, PictureSlice } from './semantic-index/picture.js';
import { recordEvidence, recordFact, type RunWorkingState } from './working-state.js';

const log = createLogger('ai-sdk:picture-verification');

// ---------------------------------------------------------------------------
// Bounds and tolerances
// ---------------------------------------------------------------------------

/** Cut pairs one apply may verify deterministically. See the module header for why 4. */
export const MAX_VERIFIED_CUTS_PER_APPLY = 4;

/** Cut pairs one apply may escalate to a vision reviewer. See the header for why 2. */
export const MAX_VISION_PAIRS_PER_APPLY = 2;

/**
 * Frames shown to the vision reviewer per escalated pair: the outgoing frame and the
 * incoming one. A cut has exactly two sides, and a third frame would only show more of a
 * shot the question is not about.
 */
export const VISION_FRAMES_PER_PAIR = 2;

/**
 * Mean |ΔRGB| across a cut, above which the two sides are treated as genuinely different
 * pictures.
 *
 * **This number is not measured, and the design is built so that it cannot fabricate a
 * verdict.** The engine's comparison metric is the mean absolute RGB difference of two
 * composited frames (`temporal_evidence.py`), and across a *cut* that quantity moves with
 * framing and content, not only with exposure — two shots of one room can differ more than
 * one shot graded a stop apart. So a residual is read in one direction only:
 *
 * - **above** the tolerance the two sides really are far apart, which is what the flag said,
 *   and the flag is CONFIRMED;
 * - **at or below** it, the residual has not proved anything about exposure. It refutes the
 *   flag only when nothing else disagrees; the moment two tier-2 descriptions disagree it
 *   becomes `undecided` and the question goes to someone who can look.
 *
 * 0.25 is a quarter of full scale — deliberately generous, because a tighter number would
 * turn ordinary coverage into a stream of confirmed "jumps". When VU0.2's labelled cuts
 * exist, this is the first constant to fit against them.
 */
export const SHOT_MATCH_MAX_DIFFERENCE = 0.25;

/**
 * Mean |ΔRGB| across a cut that carries a transition, above which the join reads as a
 * discontinuity the transition failed to carry.
 *
 * Lower than {@link SHOT_MATCH_MAX_DIFFERENCE} on purpose: a transition exists precisely to
 * make the two sides resemble each other for a moment, so the frames either side of one
 * should be *closer* than the frames either side of a hard cut. Same unmeasured caveat, same
 * one-directional reading.
 */
export const TRANSITION_CONTINUITY_MAX_DIFFERENCE = 0.18;

/** Flags this module can check, in the order it would rather spend a pair on them. */
const CHECKABLE_FLAGS: readonly PictureCutFlag[] = ['black_in', 'exposure_jump', 'wb_jump'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a cut pair was interrogated. */
export type PictureVerificationMethod =
  'black_ratio' | 'shot_match' | 'transition_continuity' | 'vision';

/**
 * What the check concluded about the flag this apply raised.
 *
 * - `confirmed` — the defect is really on screen.
 * - `refuted` — the numbers say it is not; the flag was a threshold artefact.
 * - `undecided` — the numbers cannot settle it (and no one looked, or looking was not
 *   available). Never a pass.
 * - `unverified` — nothing was checked: no sidecar, no result, a cancelled run, or a
 *   reviewer that answered `cannot_tell`.
 */
export type PictureVerificationStatus = 'confirmed' | 'refuted' | 'undecided' | 'unverified';

export interface PictureVerificationCheck {
  readonly requestId: string;
  readonly fromClipId: string;
  readonly toClipId: string;
  /** TIMELINE seconds. */
  readonly at: number;
  /** The flag being checked, or `null` for a continuity check on a newly made cut. */
  readonly flag: PictureCutFlag | null;
  readonly method: PictureVerificationMethod;
  readonly status: PictureVerificationStatus;
  /** One model-facing sentence. Words, never grade values. */
  readonly detail: string;
}

/** A fact ready for {@link recordPictureVerification}; the caller owns the working state. */
export interface PictureVerificationFact {
  readonly statement: string;
  readonly evidenceIds: readonly string[];
}

export interface PictureVerificationEvidence {
  readonly id: string;
  readonly source: string;
  readonly descriptor: string;
}

export interface PictureVerificationReport {
  readonly checks: readonly PictureVerificationCheck[];
  readonly facts: readonly PictureVerificationFact[];
  readonly evidence: readonly PictureVerificationEvidence[];
  /**
   * Frames put in front of a MODEL — the quantity `framesSeenPerEdit` counts. Deterministic
   * decodes are not in it; they never reach a model.
   */
  readonly framesShownToModel: number;
  /** Composited frames the sidecar decoded for the deterministic pass. Wall clock, not tokens. */
  readonly framesDecoded: number;
  /** The PICTURE verification lines, or `''` when there is nothing to say. */
  readonly briefingLine: string;
}

/** Everything the vision escalation needs, and the three conditions that gate it. */
export interface PictureVisionControls {
  readonly acquire: ProjectVisionFrameAcquirer;
  readonly judge: VisionJudge;
  readonly reviewer: VisionReviewerIdentity;
  readonly mediaEgressConsent?: VisionMediaEgressConsent;
  /** The run's configured provider/model — vision capability is read from these. */
  readonly provider?: ProviderName;
  readonly model?: string;
  /**
   * Whether the run can afford to look. **Defaults to refusing**: a caller that has not
   * decided must not be charged for four image payloads by omission.
   */
  readonly hasBudgetHeadroom: boolean;
}

export interface PictureVerificationInput {
  /** The project AFTER the apply — the frames are of this arrangement. */
  readonly project: Project;
  /** The picture slice as it was when the turn started; `null` on the first apply. */
  readonly before: PictureSlice | null | undefined;
  readonly after: PictureSlice;
  /** Namespaces the request ids so two applies in one run never collide. */
  readonly patchId: string;
  /** Absent means this host has no deterministic evidence route: everything is unverified. */
  readonly acquireTemporal?: TemporalEvidenceAcquirer;
  readonly vision?: PictureVisionControls;
  readonly signal?: AbortSignal;
}

const EMPTY_REPORT: PictureVerificationReport = {
  checks: [],
  facts: [],
  evidence: [],
  framesShownToModel: 0,
  framesDecoded: 0,
  briefingLine: '',
};

// ---------------------------------------------------------------------------
// Candidate selection — strictly this apply's delta
// ---------------------------------------------------------------------------

/** One cut pair worth a frame, and the reason it is worth one. */
interface Candidate {
  readonly change: PictureChange;
  readonly cut: PictureCut;
  readonly flag: PictureCutFlag | null;
  readonly method: Exclude<PictureVerificationMethod, 'vision'>;
  readonly severity: number;
}

function cutKey(fromClipId: string, toClipId: string): string {
  return `${fromClipId}→${toClipId}`;
}

function clock(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${String(minutes)}:${rest.toFixed(1).padStart(4, '0')}`;
}

/**
 * Which cut pairs this apply is answerable for.
 *
 * Reads {@link diffPicture} and nothing else, so the inherited/new line is drawn in exactly
 * one place in the codebase. `unchanged` changes carry only inherited flags and are dropped
 * here — that is rule 2, and it is why a run that opens on defective footage spends no frames.
 */
export function verificationCandidates(
  before: PictureSlice | null | undefined,
  after: PictureSlice,
  limit: number = MAX_VERIFIED_CUTS_PER_APPLY,
): readonly PictureChange[] {
  return selectCandidates(before, after, limit).map((candidate) => candidate.change);
}

function selectCandidates(
  before: PictureSlice | null | undefined,
  after: PictureSlice,
  limit: number,
): readonly Candidate[] {
  const cutsNow = new Map<string, PictureCut>();
  for (const cut of after.cuts) cutsNow.set(cutKey(cut.fromClipId, cut.toClipId), cut);

  const candidates: Candidate[] = [];
  for (const change of diffPicture(before, after)) {
    // `unchanged` is inherited-only and `removed` has no cut left to look at.
    if (change.kind !== 'added' && change.kind !== 'worsened') continue;
    const cut = cutsNow.get(cutKey(change.fromClipId, change.toClipId));
    if (!cut) continue;
    const flag = CHECKABLE_FLAGS.find((candidate) => change.newFlags.includes(candidate));
    if (flag === 'black_in') {
      candidates.push({ change, cut, flag, method: 'black_ratio', severity: 0 });
      continue;
    }
    // A transition takes precedence over a bare exposure/colour comparison: the question a
    // transition raises is whether it CARRIES the join, which is a different measurement.
    if (cut.delta.transition !== null) {
      candidates.push({
        change,
        cut,
        flag: flag ?? null,
        method: 'transition_continuity',
        severity: flag ? 1 : 3,
      });
      continue;
    }
    if (flag) {
      candidates.push({
        change,
        cut,
        flag,
        method: 'shot_match',
        severity: flag === 'exposure_jump' ? 1 : 2,
      });
    }
  }
  candidates.sort((a, b) => a.severity - b.severity || a.change.at - b.change.at);
  return candidates.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Request planning
// ---------------------------------------------------------------------------

/** The composited frames either side of a cut, clamped to the programme. */
function framesAcross(at: number, fps: number): { readonly left: number; readonly right: number } {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const incoming = Math.max(1, Math.round(at * rate));
  return { left: incoming - 1, right: incoming };
}

function requestIdFor(patchId: string, index: number): string {
  return `picture:${patchId.slice(0, 200)}:${String(index)}`;
}

/**
 * Turn the selected pairs into ONE deterministic batch.
 *
 * Exported so a caller (and a test) can see exactly what a verification would cost before
 * anything is decoded.
 */
export function planPictureEvidence(
  candidates: readonly Candidate[],
  projectRevision: number,
  fps: number,
  patchId: string,
): readonly TemporalEvidenceRequest[] {
  return candidates.map((candidate, index) => {
    const requestId = requestIdFor(patchId, index);
    const { left, right } = framesAcross(candidate.change.at, fps);
    const where = clock(candidate.change.at);
    const base = {
      schemaVersion: TEMPORAL_EVIDENCE_VERSION,
      requestId,
      projectRevision,
    } as const;
    if (candidate.method === 'black_ratio') {
      return {
        ...base,
        kind: 'frame',
        atFrame: right,
        metrics: ['black_ratio'],
        reason: `The cut at ${where} was flagged as cutting to black by this edit`,
      } satisfies TemporalEvidenceRequest;
    }
    return {
      ...base,
      kind: 'comparison',
      leftFrame: left,
      rightFrame: right,
      check: candidate.method === 'transition_continuity' ? 'transition_continuity' : 'shot_match',
      maxDifference:
        candidate.method === 'transition_continuity'
          ? TRANSITION_CONTINUITY_MAX_DIFFERENCE
          : SHOT_MATCH_MAX_DIFFERENCE,
      reason: `The cut at ${where} changed in this edit`,
    } satisfies TemporalEvidenceRequest;
  });
}

// ---------------------------------------------------------------------------
// Deciding a pair
// ---------------------------------------------------------------------------

/** The tier-2 description of the dominant shot on one side of a cut, lower-cased. */
function describedSubject(slice: PictureSlice, clipId: string): string {
  const described = slice.clips.find((clip) => clip.clipId === clipId)?.dominant?.described;
  if (!described) return '';
  return `${described.subject} ${described.setting}`.trim().toLowerCase();
}

/**
 * Do the two sides carry tier-2 descriptions that disagree?
 *
 * Both sides must actually be described: an absent description is not a disagreement, which
 * is why a tier-0-only install never escalates to vision and `framesSeenPerEdit` stays at its
 * measured floor.
 */
function descriptionsDisagree(slice: PictureSlice, cut: PictureCut): boolean {
  const from = describedSubject(slice, cut.fromClipId);
  const to = describedSubject(slice, cut.toClipId);
  return from !== '' && to !== '' && from !== to;
}

const FLAG_WORDS: Readonly<Record<PictureCutFlag, string>> = {
  black_in: 'cut to black',
  jump_cut: 'jump cut',
  exposure_jump: 'exposure jump',
  wb_jump: 'colour jump',
  size_jump: 'framing jump',
  soft_in: 'soft incoming shot',
};

function flagWords(flag: PictureCutFlag | null): string {
  return flag ? FLAG_WORDS[flag] : 'join';
}

interface Decision {
  readonly status: PictureVerificationStatus;
  readonly detail: string;
}

function decide(
  candidate: Candidate,
  result: TemporalEvidenceResult | undefined,
  after: PictureSlice,
): Decision {
  const where = clock(candidate.change.at);
  const what = flagWords(candidate.flag);
  if (!result) {
    return {
      status: 'unverified',
      detail: `the ${what} at ${where} could not be checked — the render evidence never came back`,
    };
  }
  if (result.kind === 'frame') {
    const black = result.sample.blackRatio >= BLACK_FRAME.reviewFrameRatio.value;
    return black
      ? { status: 'confirmed', detail: `the cut at ${where} really does land on a black frame` }
      : { status: 'refuted', detail: `the cut at ${where} does not land on black after all` };
  }
  if (result.kind !== 'comparison') {
    return {
      status: 'unverified',
      detail: `the ${what} at ${where} came back as the wrong kind of evidence`,
    };
  }
  const tolerance =
    candidate.method === 'transition_continuity'
      ? TRANSITION_CONTINUITY_MAX_DIFFERENCE
      : SHOT_MATCH_MAX_DIFFERENCE;
  if (result.difference > tolerance) {
    return candidate.method === 'transition_continuity'
      ? {
          status: 'confirmed',
          detail: `the transition at ${where} does not carry the join — the two sides still read as separate pictures`,
        }
      : { status: 'confirmed', detail: `the ${what} at ${where} is really there on screen` };
  }
  // Inside tolerance the residual has NOT proved anything about exposure or colour on its
  // own (see SHOT_MATCH_MAX_DIFFERENCE). It refutes the flag only when nothing disagrees.
  if (descriptionsDisagree(after, candidate.cut)) {
    return {
      status: 'undecided',
      detail: `the ${what} at ${where} measures small, but the two shots are described as different scenes`,
    };
  }
  if (candidate.method === 'transition_continuity' && candidate.cut.delta.sameSetting === null) {
    return {
      status: 'refuted',
      detail: `the transition at ${where} carries the join`,
    };
  }
  return { status: 'refuted', detail: `the ${what} at ${where} is not visible in the render` };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

const CANCELLED_DETAIL = 'the run was cancelled, so nothing on screen was confirmed';

function statusWord(status: PictureVerificationStatus): string {
  switch (status) {
    case 'confirmed':
      return 'Verified';
    case 'refuted':
      return 'Verified';
    case 'undecided':
      return 'Not settled';
    case 'unverified':
      return 'Unverified';
  }
}

function factStatement(check: PictureVerificationCheck): string {
  return `${statusWord(check.status)} — ${check.detail}.`;
}

function renderBriefing(checks: readonly PictureVerificationCheck[]): string {
  if (checks.length === 0) return '';
  const lines = checks
    .slice(0, MAX_PICTURE_LINES)
    .map((check) => `- ${statusWord(check.status)}: ${check.detail}`);
  if (checks.length > MAX_PICTURE_LINES) {
    lines.push(`- …and ${String(checks.length - MAX_PICTURE_LINES)} more check(s)`);
  }
  return `PICTURE — what was checked after this edit\n${lines.join('\n')}`;
}

function assemble(
  checks: readonly PictureVerificationCheck[],
  framesShown: number,
  framesDecoded: number,
): PictureVerificationReport {
  return {
    checks,
    facts: checks.map((check) => ({
      statement: factStatement(check),
      evidenceIds: [check.requestId],
    })),
    evidence: checks.map((check) => ({
      id: check.requestId,
      source: check.method === 'vision' ? 'vision-review' : 'review/temporal-evidence',
      descriptor: `${check.method} across ${check.fromClipId}→${check.toClipId} at ${clock(check.at)}`,
    })),
    framesShownToModel: framesShown,
    framesDecoded,
    briefingLine: renderBriefing(checks),
  };
}

/**
 * Verify what this apply did to the screen, deterministically first and with a model's eyes
 * only where the numbers could not decide.
 *
 * Never throws for a verification reason: an unreachable sidecar, a malformed batch or a
 * cancelled run all resolve to `unverified` checks. A caller MUST NOT let any part of this
 * report change whether the apply succeeded — that is the whole contract (rule 4).
 *
 * @param input - The apply's before/after picture slices, the project they describe, and the
 *   bounded IO this host is willing to do.
 * @returns Facts, evidence handles and one briefing block. Empty when this apply touched no
 *   cut it is answerable for.
 */
export async function verifyPictureAfterApply(
  input: PictureVerificationInput,
): Promise<PictureVerificationReport> {
  const candidates = selectCandidates(input.before, input.after, MAX_VERIFIED_CUTS_PER_APPLY);
  if (candidates.length === 0) return EMPTY_REPORT;

  const revision = input.project.timeline.revision ?? 0;
  const requests = planPictureEvidence(candidates, revision, input.project.fps, input.patchId);

  const cancelledCheck = (candidate: Candidate, index: number): PictureVerificationCheck => ({
    requestId: requestIdFor(input.patchId, index),
    fromClipId: candidate.change.fromClipId,
    toClipId: candidate.change.toClipId,
    at: candidate.change.at,
    flag: candidate.flag,
    method: candidate.method,
    status: 'unverified',
    detail: CANCELLED_DETAIL,
  });

  // Read through a call, not a property: TypeScript would narrow a property check and hide
  // exactly the case that matters — a signal that fires while the batch is in flight.
  const cancelled = (): boolean => input.signal?.aborted === true;
  if (cancelled()) {
    return assemble(candidates.map(cancelledCheck), 0, 0);
  }
  if (!input.acquireTemporal) {
    return assemble(
      candidates.map((candidate, index) => ({
        ...cancelledCheck(candidate, index),
        detail: `the ${flagWords(candidate.flag)} at ${clock(candidate.change.at)} could not be checked — this host has no render evidence route`,
      })),
      0,
      0,
    );
  }

  let byRequestId = new Map<string, TemporalEvidenceResult>();
  let framesDecoded = 0;
  try {
    const batch = await input.acquireTemporal(input.project, requests, input.signal);
    byRequestId = new Map(batch.results.map((result) => [result.requestId, result]));
    framesDecoded = requests.reduce(
      (total, request) => total + (request.kind === 'comparison' ? 2 : 1),
      0,
    );
  } catch (error) {
    log.warn('deterministic picture verification failed', {
      requests: requests.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // A signal that fired while the batch was in flight invalidates the whole pass: an answer
  // that arrives after the user stopped the run is not consent to use it.
  if (cancelled()) {
    return assemble(candidates.map(cancelledCheck), 0, framesDecoded);
  }

  const checks: PictureVerificationCheck[] = candidates.map((candidate, index) => {
    const requestId = requestIdFor(input.patchId, index);
    const decision = decide(candidate, byRequestId.get(requestId), input.after);
    return {
      requestId,
      fromClipId: candidate.change.fromClipId,
      toClipId: candidate.change.toClipId,
      at: candidate.change.at,
      flag: candidate.flag,
      method: candidate.method,
      status: decision.status,
      detail: decision.detail,
    };
  });

  const escalated = await escalateToVision(input, candidates, checks, revision);
  return assemble(escalated.checks, escalated.framesShownToModel, framesDecoded);
}

// ---------------------------------------------------------------------------
// VU7.2 — vision, only where numbers could not decide
// ---------------------------------------------------------------------------

/** All three gates, read as one predicate so a caller can test the decision directly. */
export function visionEscalationAllowed(vision: PictureVisionControls | undefined): boolean {
  if (!vision) return false;
  if (!vision.hasBudgetHeadroom) return false;
  return supportsVision(vision.provider, vision.model);
}

async function escalateToVision(
  input: PictureVerificationInput,
  candidates: readonly Candidate[],
  checks: readonly PictureVerificationCheck[],
  revision: number,
): Promise<{
  readonly checks: readonly PictureVerificationCheck[];
  readonly framesShownToModel: number;
}> {
  const undecided = checks
    .map((check, index) => ({ check, candidate: candidates[index] as Candidate, index }))
    .filter((entry) => entry.check.status === 'undecided')
    .slice(0, MAX_VISION_PAIRS_PER_APPLY);
  const vision = input.vision;
  if (undecided.length === 0 || !vision || !visionEscalationAllowed(vision)) {
    return { checks, framesShownToModel: 0 };
  }

  const requests: VisionReviewRequest[] = undecided.map((entry) => {
    const { left, right } = framesAcross(entry.check.at, input.project.fps);
    return {
      schemaVersion: VISION_REVIEW_VERSION,
      requestId: entry.check.requestId,
      projectRevision: revision,
      objective:
        `At ${clock(entry.check.at)} the picture cuts from ${entry.check.fromClipId} to ` +
        `${entry.check.toClipId}. Do these two frames read as the same scene under the same ` +
        `light, or is there a visible ${flagWords(entry.candidate.flag)}?`,
      frames: [left, right].slice(0, VISION_FRAMES_PER_PAIR),
    };
  });

  const report = await reviewVisionObjectives({
    requests,
    projectRevision: revision,
    acquire: (request) => vision.acquire(input.project, request, input.signal),
    judge: vision.judge,
    reviewer: vision.reviewer,
    ...(vision.mediaEgressConsent === undefined
      ? {}
      : { mediaEgressConsent: vision.mediaEgressConsent }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const byRequestId = new Map(report.checks.map((check) => [check.requestId, check]));
  const merged = checks.map((check) => {
    const verdict = byRequestId.get(check.requestId);
    if (!verdict || check.status !== 'undecided') return check;
    // `pass` means the reviewer saw no defect; `fail` means it saw one. `unverified` — which
    // is where `cannot_tell`, a cancelled run and a missing frame all land — stays honest.
    const status: PictureVerificationStatus =
      verdict.status === 'pass'
        ? 'refuted'
        : verdict.status === 'fail'
          ? 'confirmed'
          : 'unverified';
    return {
      ...check,
      method: 'vision' as const,
      status,
      detail: `${verdict.reason.replace(/\.$/, '')} (looked at the cut at ${clock(check.at)})`,
    };
  });
  const framesShownToModel = requests.reduce((total, request) => total + request.frames.length, 0);
  return { checks: merged, framesShownToModel };
}

// ---------------------------------------------------------------------------
// Into the working state
// ---------------------------------------------------------------------------

/**
 * Fold a report into the run's working state: one evidence handle per check, then the fact
 * that cites it.
 *
 * The handle is indexed BEFORE the fact, for the same reason `conductor.ts` does it that way
 * — a fact citing a handle the state does not contain is a dangling reference in the
 * briefing.
 */
export function recordPictureVerification(
  state: RunWorkingState,
  report: PictureVerificationReport,
): RunWorkingState {
  let next = state;
  for (const handle of report.evidence) {
    next = recordEvidence(next, { ...handle, scope: 'timeline_dependent' });
  }
  for (const fact of report.facts) {
    next = recordFact(next, {
      kind: 'verification',
      statement: fact.statement,
      scope: 'timeline_dependent',
      evidenceIds: fact.evidenceIds,
    });
  }
  return next;
}
