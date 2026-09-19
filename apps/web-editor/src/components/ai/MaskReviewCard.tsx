/**
 * What an AI mask still needs from the editor, and the way to it (AM3.3).
 *
 * The agent's masks go through the same consensus and verify stages as a hand-started job, and
 * what those stages could not vouch for lands on the Inspector's review list. This card says how
 * many moments that is and opens the list — the same `requestReview` the export dialog's
 * "Review" uses. It never says a mask is verified, whatever the count: an empty list means the
 * automatic checks flagged nothing, and only the editor's own review earns that word
 * (plan/background-removal-ai/11 rule 3; gate "Verification honesty").
 */
import { Button } from '@framepilot/ui';
import { maskToolStore, type MaskToolStore } from '../inspector/masks/useMaskTools.js';

export interface MaskReviewSummary {
  readonly clipId: string;
  readonly maskId: string;
  readonly flaggedCount: number;
  readonly spotCheck?: 'yes' | 'unsure' | 'not_run';
}

const SPOT_CHECKS: ReadonlySet<string> = new Set(['yes', 'unsure', 'not_run']);

/** Read a masking tool's `mask_review` result; anything else yields no card. */
export function maskReviewSummary(result: unknown): MaskReviewSummary | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  if (record.kind !== 'mask_review') return null;
  if (typeof record.clipId !== 'string' || typeof record.maskId !== 'string') return null;
  if (typeof record.flaggedCount !== 'number' || !Number.isInteger(record.flaggedCount))
    return null;
  const verdict = (record.spotCheck as Record<string, unknown> | undefined)?.verdict;
  return {
    clipId: record.clipId,
    maskId: record.maskId,
    flaggedCount: Math.max(0, record.flaggedCount),
    ...(typeof verdict === 'string' && SPOT_CHECKS.has(verdict)
      ? { spotCheck: verdict as NonNullable<MaskReviewSummary['spotCheck']> }
      : {}),
  };
}

/** The card's one sentence. Exported so the honesty rule is tested on the words themselves. */
export function maskReviewLine(summary: MaskReviewSummary): string {
  const looked =
    summary.spotCheck === 'unsure'
      ? ' A quick look at a few frames could not tell whether it is on the right thing.'
      : '';
  if (summary.flaggedCount === 0) {
    return `The automatic checks flagged nothing on this mask.${looked} It is ready for you to look over.`;
  }
  const moments =
    summary.flaggedCount === 1 ? '1 moment needs' : `${String(summary.flaggedCount)} moments need`;
  return `${moments} a look on this mask.${looked}`;
}

export function MaskReviewCard({
  summary,
  store = maskToolStore,
}: {
  summary: MaskReviewSummary;
  store?: Pick<MaskToolStore, 'requestReview'>;
}): JSX.Element {
  return (
    <div className="ai-pack-install" role="group" aria-label="mask review">
      <p>{maskReviewLine(summary)}</p>
      <span className="ai-pack-install__actions">
        <Button
          variant="secondary"
          type="button"
          onClick={() => store.requestReview(summary.clipId)}
        >
          {summary.flaggedCount === 0 ? 'Open in Inspector' : 'Open review list'}
        </Button>
      </span>
    </div>
  );
}
