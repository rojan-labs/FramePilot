/**
 * The compact mask fact a clip row carries (AM4.1; plan 11 "Model surfaces and tokens").
 *
 * A model planning from `id[start–end]` rows could not tell a clip had a cut-out, a hidden face
 * or a grade limited to the sky, so it would re-mask a masked clip or grade over a masked grade.
 * The fact is cheap and belongs where the clip is named: `masks: matte-cutout (3 flagged),
 * ellipse-hide tracked`. Ids are left to `get_masks`, which the refine and delete tools need
 * anyway; the row only has to say that there is something to ask about.
 *
 * ZERO delta without masks: {@link withMaskFacts} returns its input unchanged — the same object
 * — when no clip has one, so a project without masks renders byte-for-byte as it did and its
 * cached prompt prefix does not move. The token goldens pin that.
 *
 * Never "verified" and never a checkmark: a mask with nothing flagged says nothing about review,
 * because only the editor's review earns that word (plan 11 rule 3).
 */
import { masksOf, type Clip, type MaskLayer, type Project } from '@framepilot/timeline-schema';

/** What a mask does to its clip, in `create_mask`'s own purpose words. */
function purposeOf(mask: MaskLayer): 'cutout' | 'hide' | 'effect' {
  if (mask.target.kind === 'effect') return 'effect';
  return mask.invert ? 'hide' : 'cutout';
}

function flaggedCount(mask: MaskLayer): number {
  const review = mask.kind === 'matte' ? mask.review : mask.tracking?.review;
  return review?.flagged.length ?? 0;
}

/** One mask, e.g. `ellipse-hide tracked (2 flagged)`. */
function maskWords(mask: MaskLayer): string {
  const flagged = flaggedCount(mask);
  return [
    `${mask.kind}-${purposeOf(mask)}`,
    ...(mask.tracking === undefined ? [] : ['tracked']),
    ...(mask.enabled ? [] : ['off']),
    ...(flagged === 0 ? [] : [`(${String(flagged)} flagged)`]),
  ].join(' ');
}

/**
 * A clip's masks, top first, e.g. `matte-cutout (3 flagged), ellipse-hide tracked`; `undefined`
 * when it has none. `get_timeline` carries this as a row field.
 */
export function maskSummaryFor(clip: Pick<Clip, 'masks'>): string | undefined {
  const masks = masksOf(clip);
  if (masks.length === 0) return undefined;
  return masks.map(maskWords).join(', ');
}

/** The same summary as a row suffix, `masks: …`, for the prompt's timeline summary. */
export function maskFactFor(clip: Pick<Clip, 'masks'>): string | undefined {
  const summary = maskSummaryFor(clip);
  return summary === undefined ? undefined : `masks: ${summary}`;
}

/**
 * Merge every masked clip's fact into the row facts the timeline summary renders.
 *
 * @param project - The project whose clips to read.
 * @param facts - The row facts so far (picture words, repeat markers), if any.
 * @returns `facts` itself when no clip has a mask; otherwise a new map with the facts appended.
 */
export function withMaskFacts(
  project: Project,
  facts: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> | undefined {
  let merged: Map<string, string> | undefined;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      const fact = maskFactFor(clip);
      if (fact === undefined) continue;
      merged ??= new Map(facts ?? []);
      const words = merged.get(clip.id);
      merged.set(clip.id, words === undefined || words === '' ? fact : `${words} · ${fact}`);
    }
  }
  return merged ?? facts;
}
