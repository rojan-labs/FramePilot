/**
 * Is a span of the timeline already occupied by picture media?
 *
 * ## Why this exists at all
 *
 * The preview flattens picture clips from **every** track into one time-ordered
 * sequence, while the export composites stacked picture layers properly. Two
 * picture clips overlapping in time therefore render one way and preview
 * another — the divergence documented as blocker #1 in
 * `plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` §0.2, which `SUC-P1` exists to
 * close.
 *
 * Until it does, anything that places picture media *for* the user rather than
 * *by* the user — the Stock panel's one-click Add, the agent's `add_stock` —
 * must refuse to create that overlap instead of quietly producing an edit that
 * looks wrong on export.
 *
 * ## Why it lives in editor-core
 *
 * Two callers need the identical answer in different processes: the renderer
 * (to disable a button with a reason) and the Electron main process (to refuse
 * an agent's placement before spending a download). Two copies would eventually
 * disagree, and the way they would disagree is that one of them starts allowing
 * the overlap.
 *
 * Overlap is measured in **time**, not by layer: which track the clips sit on
 * does not affect whether the preview can show both.
 */
import type { Asset, Timeline } from '@framepilot/timeline-schema';

/** Asset kinds that flow through the preview's single picture chain. */
const PICTURE_ASSET_KINDS: ReadonlySet<string> = new Set(['video', 'image']);

/** One picture clip's span, as the preview's single chain sees it. */
interface PictureSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Every picture span on the timeline, merged and in time order.
 *
 * Shared by the predicate below and by {@link firstFreePictureStart} so "is this
 * span occupied?" and "where is the next free one?" can never answer from
 * different pictures of the timeline — the way those two would drift is that the
 * suggestion starts naming a moment the predicate then refuses.
 */
function mergedPictureSpans(timeline: Timeline, assets: readonly Asset[]): readonly PictureSpan[] {
  const kindById = new Map(assets.map((asset) => [asset.id, asset.kind]));
  const spans: PictureSpan[] = [];

  for (const track of timeline.tracks) {
    // Only `video` layers carry the picture chain. `overlay`, `effect`, `audio`
    // and `caption` layers composite separately, so a title sitting above a
    // cutaway is not a conflict.
    if (track.type !== undefined && track.type !== 'video') continue;
    for (const clip of track.clips) {
      const kind = kindById.get(clip.assetId);
      // Clips whose asset is unknown are treated as PICTURE. The failure modes
      // are not symmetric — wrongly refusing a placement costs one
      // repositioning, wrongly allowing one ships an export that does not match
      // the preview.
      if (kind !== undefined && !PICTURE_ASSET_KINDS.has(kind)) continue;
      if (clip.end > clip.start) spans.push({ start: clip.start, end: clip.end });
    }
  }

  spans.sort((a, b) => a.start - b.start);
  const merged: PictureSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    // Touching spans merge: there is no usable gap of zero length, and treating
    // one as usable would suggest a start the predicate immediately refuses.
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) merged[merged.length - 1] = { start: last.start, end: span.end };
      continue;
    }
    merged.push(span);
  }
  return merged;
}

/**
 * TRUE when any picture clip overlaps `[start, end)`.
 *
 * Touching edges do not count: butting a cutaway against the clip before it is
 * exactly what an editor does, and treating that as a conflict would make the
 * feature unusable.
 *
 * @param timeline - The timeline to inspect.
 * @param assets - The project's asset bin, used to derive each clip's kind.
 * @param start - Span start in timeline seconds.
 * @param end - Span end in timeline seconds (exclusive).
 */
export function picturePlacementConflict(
  timeline: Timeline,
  assets: readonly Asset[],
  start: number,
  end: number,
): boolean {
  if (!(end > start)) return false;
  return mergedPictureSpans(timeline, assets).some((span) => span.start < end && start < span.end);
}

/**
 * The earliest moment at or after `fromSeconds` where a picture clip of
 * `durationSeconds` fits without overlapping existing picture media.
 *
 * ## Why a refusal has to carry this
 *
 * "Pick an empty stretch" is only actionable if you know where one is. A person
 * can see the timeline and scrub to a gap; the agent cannot, and a captured run
 * showed it re-proposing the same occupied moment because the rejection told it
 * what was wrong and never what to do instead. This turns the refusal into a
 * next step for both callers, from the same spans the refusal itself was
 * computed over.
 *
 * The timeline has no end, so there is always an answer: after the last picture
 * clip is always free. A clip of zero or negative length conflicts with nothing
 * and gets `fromSeconds` back unchanged.
 *
 * @param timeline - The timeline to inspect.
 * @param assets - The project's asset bin, used to derive each clip's kind.
 * @param durationSeconds - How much room the clip needs.
 * @param fromSeconds - Earliest acceptable start; clamped to >= 0. Defaults to 0.
 * @returns A start in timeline seconds for which
 *   {@link picturePlacementConflict} is FALSE over `[start, start + durationSeconds)`.
 */
export function firstFreePictureStart(
  timeline: Timeline,
  assets: readonly Asset[],
  durationSeconds: number,
  fromSeconds = 0,
): number {
  const from = fromSeconds > 0 ? fromSeconds : 0;
  if (!(durationSeconds > 0)) return from;

  let cursor = from;
  for (const span of mergedPictureSpans(timeline, assets)) {
    if (span.end <= cursor) continue;
    // The gap between the cursor and this span is usable only if the whole clip
    // fits in it. Touching edges are allowed, so an exact fit counts.
    if (span.start - cursor >= durationSeconds) return cursor;
    cursor = span.end;
  }
  return cursor;
}
