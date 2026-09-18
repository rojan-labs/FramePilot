/**
 * The sentence a masking result says about its own review state (AM3.1, AM3.3).
 *
 * One function, so every masking tool reports the same way and the rule is enforceable in one
 * place: the agent states how many moments need a look and NEVER says "verified" (plan 11
 * rule 3; gate "Verification honesty: 0 runs claim Verified or omit a flagged count"). An
 * empty list is "nothing was flagged", which is a fact about the pack's checks — not a claim
 * that the editor has reviewed anything.
 */
import { MaskTargetsResultSchema, type MaskReviewReport } from './contracts.js';

/** Where the editor reviews flagged moments. Named in every sentence that reports some. */
export const MASK_REVIEW_LOCATION = 'the Inspector review list';

export function maskReviewSentence(
  report: Pick<MaskReviewReport, 'flaggedCount' | 'maskId'>,
): string {
  if (report.flaggedCount === 0) {
    return (
      `Mask ${report.maskId}: the automatic checks flagged nothing. Tell the editor it is ready ` +
      `for them to look over — do not call it verified; only their review does that.`
    );
  }
  const moments =
    report.flaggedCount === 1 ? '1 moment needs' : `${report.flaggedCount} moments need`;
  return (
    `Mask ${report.maskId}: ${moments} a look in ${MASK_REVIEW_LOCATION}. Report that count to ` +
    `the editor — do not call the mask verified.`
  );
}

/** What each resolver status asks of the model. The editor-facing picker is the host's job. */
const TARGET_STATUS_GUIDANCE: Readonly<Record<string, string>> = {
  resolved: 'Pass the chosen candidateId to create_mask.',
  ambiguous_target:
    'More than one thing could be meant, so FramePilot has asked the editor to pick. Wait for ' +
    'their choice — do not pick for them.',
  needs_click:
    'This target is outside what the detector can name, so FramePilot has asked the editor to ' +
    'click it on the monitor. Wait for their click — do not substitute another candidate.',
  needs_face_selection:
    "Telling people apart needs the editor's consent to face recognition on this project, so " +
    'FramePilot has shown them the faces to choose from. Wait for their choice.',
  no_candidates:
    'Nothing matching was detected on this clip. Tell the editor; do not mask something else.',
};

/**
 * `find_mask_targets` as the model reads it: the status, what to do about it, and one line per
 * candidate carrying the `candidateId` it has to pass on. Boxes are deliberately absent — the
 * model never handles coordinates, so showing them would only invite it to.
 *
 * @returns The digest, or `undefined` when the payload is not a targets result.
 */
export function maskTargetsDigest(value: unknown): string | undefined {
  const parsed = MaskTargetsResultSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { status, candidates, chosenCandidateIds, clipId } = parsed.data;
  const chosen = new Set(chosenCandidateIds);
  const rows = candidates.map(
    (candidate) =>
      `${candidate.candidateId} · ${candidate.label} · score ${candidate.score.toFixed(2)} · on ` +
      `screen ${Math.round(candidate.persistence * 100)}% of the range` +
      `${chosen.has(candidate.candidateId) ? ' · CHOSEN' : ''}`,
  );
  return [`${status} on ${clipId}. ${TARGET_STATUS_GUIDANCE[status] ?? ''}`.trim(), ...rows].join(
    '\n',
  );
}
