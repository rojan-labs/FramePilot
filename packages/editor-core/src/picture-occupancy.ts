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

/**
 * TRUE when any picture clip overlaps `[start, end)`.
 *
 * Touching edges do not count: butting a cutaway against the clip before it is
 * exactly what an editor does, and treating that as a conflict would make the
 * feature unusable.
 *
 * Clips whose asset is unknown are treated as **picture**. The failure modes are
 * not symmetric — wrongly refusing a placement costs one repositioning, wrongly
 * allowing one ships an export that does not match the preview.
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
  const kindById = new Map(assets.map((asset) => [asset.id, asset.kind]));

  for (const track of timeline.tracks) {
    // Only `video` layers carry the picture chain. `overlay`, `effect`, `audio`
    // and `caption` layers composite separately, so a title sitting above a
    // cutaway is not a conflict.
    if (track.type !== undefined && track.type !== 'video') continue;
    for (const clip of track.clips) {
      const kind = kindById.get(clip.assetId);
      if (kind !== undefined && !PICTURE_ASSET_KINDS.has(kind)) continue;
      if (clip.start < end && start < clip.end) return true;
    }
  }
  return false;
}
