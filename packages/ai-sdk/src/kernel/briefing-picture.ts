/**
 * @framepilot/ai-sdk/kernel/briefing-picture — what changed ON SCREEN between two revisions
 * (ADR 0175, plan/visual-understanding VU2.6).
 *
 * The user's complaint that started this plan was "the AI does not know what it edited".
 * Everything else in the plan gives the model facts about footage it has not touched yet;
 * this module closes the loop on footage it just did: which cuts appeared, which
 * disappeared, which gained a transition, and which now have a problem they did not have
 * before.
 *
 * It once also RENDERED those lines into the briefing. It no longer does. `verifyPictureAfterApply`
 * turns the same diff into working-state facts, which the existing briefing already prints
 * under ESTABLISHED — so a second renderer would have printed every cut twice. The renderer
 * was deleted rather than left beside the channel that won.
 *
 * Two rules, and the second is the one that matters:
 *
 * 1. **Words, not numbers** — the same discipline as the clip rows. "now MS→WS, a stop
 *    brighter" rather than a pair of decimals the model would copy into a grade.
 * 2. **A defect the footage already had is NOT this run's shortfall.** The run is judged on
 *    its delta. A cut that was over-exposed before the run started is an ADVISORY the model
 *    may act on if the editor asked; it is never a failure the run has to fix. This is the
 *    same rule the shortfall guard learned the hard way — a run that inherits a letterboxed
 *    project must not spend its turns cropping clips nobody mentioned.
 */
import type { PictureCut, PictureCutFlag, PictureSlice } from './semantic-index/picture.js';

/** How a cut differs from how it was before the apply. */
export type PictureChangeKind = 'added' | 'removed' | 'worsened' | 'transitioned' | 'unchanged';

export interface PictureChange {
  readonly kind: PictureChangeKind;
  readonly at: number;
  readonly fromClipId: string;
  readonly toClipId: string;
  /** Flags this apply is responsible for — new here, absent before. */
  readonly newFlags: readonly PictureCutFlag[];
  /** Flags the cut already had. Advisory only; never a shortfall. */
  readonly inheritedFlags: readonly PictureCutFlag[];
}

/** At most this many cut lines. Beyond it the model is reading a list, not a summary. */
export const MAX_PICTURE_LINES = 3;

/** A stable identity for a cut across two revisions: the pair of clips it joins. */
function cutKey(cut: PictureCut): string {
  return `${cut.fromClipId}→${cut.toClipId}`;
}

/**
 * Diff two picture slices into what this apply did to the screen.
 *
 * @param before - The slice as it was when the turn started; `null` on the first apply.
 * @param after - The slice now.
 * @returns One entry per cut that appeared, disappeared or got worse. Unchanged cuts are
 *   omitted: a briefing that lists what did not happen is a briefing nobody reads.
 */
export function diffPicture(
  before: PictureSlice | null | undefined,
  after: PictureSlice,
): readonly PictureChange[] {
  const previous = new Map<string, PictureCut>();
  for (const cut of before?.cuts ?? []) previous.set(cutKey(cut), cut);
  const seen = new Set<string>();
  const changes: PictureChange[] = [];

  for (const cut of after.cuts) {
    const key = cutKey(cut);
    seen.add(key);
    const was = previous.get(key);
    if (!was) {
      changes.push({
        kind: 'added',
        at: cut.at,
        fromClipId: cut.fromClipId,
        toClipId: cut.toClipId,
        newFlags: cut.flags,
        inheritedFlags: [],
      });
      continue;
    }
    const had = new Set<PictureCutFlag>(was.flags);
    const newFlags = cut.flags.filter((flag) => !had.has(flag));
    const inherited = cut.flags.filter((flag) => had.has(flag));
    // A transition placed on a cut that already existed changes nothing about the FLAGS,
    // so keying on flags alone dropped it silently: `add_transitions` over an existing
    // sequence produced no picture line and nothing to verify, which is precisely the
    // edit most worth reporting. The transition itself is part of what changed on screen.
    const transitionChanged = was.delta.transition !== cut.delta.transition;
    if (newFlags.length > 0 || transitionChanged) {
      changes.push({
        // A cut that only gained or lost a transition is not "worse" — it is different.
        kind: newFlags.length > 0 ? 'worsened' : 'transitioned',
        at: cut.at,
        fromClipId: cut.fromClipId,
        toClipId: cut.toClipId,
        newFlags,
        inheritedFlags: inherited,
      });
    } else if (inherited.length > 0) {
      changes.push({
        kind: 'unchanged',
        at: cut.at,
        fromClipId: cut.fromClipId,
        toClipId: cut.toClipId,
        newFlags: [],
        inheritedFlags: inherited,
      });
    }
  }

  for (const [key, cut] of previous) {
    if (seen.has(key)) continue;
    changes.push({
      kind: 'removed',
      at: cut.at,
      fromClipId: cut.fromClipId,
      toClipId: cut.toClipId,
      newFlags: [],
      inheritedFlags: [],
    });
  }
  return changes.sort((a, b) => a.at - b.at);
}
