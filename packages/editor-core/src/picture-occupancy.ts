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
 *
 * ## What ADR 0169 changed
 *
 * The blanket answer above is still what `add_stock` and the Stock panel use:
 * they pick the track themselves, so "is this moment occupied?" is the whole
 * question for them. It is no longer the whole question for the AGENT, which
 * names its own track and can be given a new one. A layer that covers the frame
 * opaquely previews exactly as it exports — the preview shows the front-most
 * clip and so does the composite — so that case is a legal placement rather than
 * a divergence. {@link isFullFrameOpaque} is the predicate that separates the
 * two, and it lives here so the guard and the preview cannot drift apart.
 */
import type { Asset, Clip, Timeline } from '@framepilot/timeline-schema';
import { TRANSITION_OUT_EFFECT_TYPE } from './transitions.js';

// ---------------------------------------------------------------------------
// Full-frame opacity — the predicate that decides whether a stacked picture
// layer previews the way it exports (ADR 0169)
// ---------------------------------------------------------------------------

/**
 * Clip effects that stop a picture layer covering the frame opaquely.
 *
 * - `mask` cuts a shape out of the layer, so the layer beneath shows through
 *   the hole. The preview can only show one of the two.
 * - `transition` / `transition_out` ramp the layer's own alpha (a dissolve), its
 *   geometry (a push) or a wipe edge across the frame. For part of the clip the
 *   layer is not covering, and the export blends whatever is under it.
 *
 * A colour grade, an audio adjustment or a text effect are deliberately absent:
 * they change what the layer LOOKS like, never how much of the frame it covers
 * or what shows through it.
 */
const COVERAGE_BREAKING_EFFECTS: ReadonlySet<string> = new Set([
  'mask',
  'transition',
  TRANSITION_OUT_EFFECT_TYPE,
]);

/** The compositing fields {@link isFullFrameOpaque} reads. A whole {@link Clip} satisfies it. */
export type FullFrameOpaqueFields = Pick<Clip, 'crop' | 'blendMode'> &
  Partial<Pick<Clip, 'keyframes' | 'effects'>>;

/**
 * Does this clip paint the WHOLE output frame, with nothing showing through it?
 *
 * ## Why one predicate decides this for two processes
 *
 * A picture layer stacked over another previews correctly and exports
 * identically **only** when the layer in front covers the frame opaquely: then
 * the preview's "show the front-most clip" and the export's "composite the
 * layers" produce the same pixels, and there is no divergence to guard against.
 * The moment the front layer is scaled, positioned, cropped, masked, faded or
 * blended, the export folds in what is underneath and the preview — which paints
 * exactly one picture layer — cannot.
 *
 * So this one answer decides two things that must never disagree:
 *
 * - the agent's placement guard (`ai-sdk/domain-tools/picture-layers.ts`), which
 *   allows a full-frame opaque overlay and refuses everything else;
 * - the canvas preview's eligibility test
 *   (`web-editor/editor/selectors-base.ts#canvasPreviewEligible`), which admits
 *   overlapping picture only when every clip in the overlap satisfies this.
 *
 * Two copies of the rule would drift, and the way they would drift is that the
 * guard starts allowing an overlay the preview cannot show.
 *
 * ## What it reads, and why each field is disqualifying
 *
 * - `keyframes` — transform animation. `scale` below 1, any `x`/`y`, a
 *   `rotation`, or an `opacity` below 1 all uncover part of the frame. The
 *   presence of ANY keyframe disqualifies rather than the evaluated value:
 *   coverage would then be a function of time, and a clip that covers for two
 *   seconds and uncovers for one is not a full-frame layer.
 * - `crop` — a crop rect changes which part of the SOURCE is used. A cover crop
 *   fills the frame and a narrower one letterboxes, and the two are not
 *   distinguishable without the source's measured pixel dimensions, which this
 *   is not given. Callers that generate a cover crop themselves (`add_clip`'s
 *   auto-reframe) test the placement BEFORE that crop, because a cover crop can
 *   only increase coverage.
 * - `blendMode` — anything but `normal` is by definition a function of the
 *   layer beneath (`render/compiler.py#_blend_layer_over`).
 * - `effects` — see {@link COVERAGE_BREAKING_EFFECTS}.
 *
 * NECESSARY, NOT SUFFICIENT. This answers only "is the layer itself opaque everywhere it
 * paints?" — whether it paints over the whole frame is geometry, and geometry is a relation
 * between this clip, the ones it covers and the frame. See {@link hidesWhatIsBehind}, which
 * is what a caller deciding a placement should ask.
 *
 * @param clip - The clip, or the compositing fields a placement would write.
 * @returns TRUE when nothing in the layer's own compositing lets the frame beneath through.
 */
export function isFullFrameOpaque(clip: FullFrameOpaqueFields): boolean {
  if (clip.crop !== undefined) return false;
  if (clip.blendMode !== undefined && clip.blendMode !== 'normal') return false;
  if ((clip.keyframes ?? []).length > 0) return false;
  return !(clip.effects ?? []).some((effect) => COVERAGE_BREAKING_EFFECTS.has(effect.type));
}

/**
 * The measured pixel shape of a clip's source, or `undefined` when nothing probed it
 * (`Asset.media.width`/`height` are optional since schema v21 and are "honestly absent
 * rather than guessed at").
 */
export interface SourceShape {
  readonly width: number;
  readonly height: number;
}

/** A clip together with the shape of the media under it. */
export interface ShapedClip {
  readonly clip: FullFrameOpaqueFields & { readonly assetId?: string };
  readonly source: SourceShape | undefined;
}

/** Relative aspect tolerance. `coverCropForFrame` rounds its rect to four places, so an
    exact test would reject the very crop written to make a clip cover. A per-mille
    difference is far under one pixel row at any resolution this product renders. */
const ASPECT_TOLERANCE = 0.001;

const sameAspect = (a: number, b: number): boolean => Math.abs(a - b) <= b * ASPECT_TOLERANCE;

/** The aspect of the source rect this clip actually shows — the crop is a fraction OF THE
    SOURCE, so the visible shape is the source scaled by it. `undefined` when unmeasured. */
function visibleAspect(entry: ShapedClip): number | undefined {
  const { source, clip } = entry;
  if (!source || source.width <= 0 || source.height <= 0) return undefined;
  const width = source.width * (clip.crop?.width ?? 1);
  const height = source.height * (clip.crop?.height ?? 1);
  if (width <= 0 || height <= 0) return undefined;
  return width / height;
}

/**
 * Does the clip in front hide everything behind it, so the monitor and the export agree?
 *
 * ## Why this is a RELATION and not a property of the front clip
 *
 * The first version of this asked "does the front clip fill the frame?", and that is the
 * wrong question. The renderer FITS rather than covers (schema v21's note on
 * `media.width`), so a source whose aspect does not match the frame is letterboxed and its
 * bars are TRANSPARENT at export. But the clip BEHIND is fitted by the same renderer. When
 * the two share an aspect — the same camera, which is the ordinary case — their bars
 * coincide exactly: the export blends transparent over transparent and paints black, and
 * so does the monitor. **They agree, and refusing that placement buys nothing.**
 *
 * They disagree only when the front clip's fitted rect fails to CONTAIN the one behind it —
 * a 1:1 overlay over a 16:9 base leaks the base's left and right edges into the export
 * while the monitor shows only the overlay. For centred fits that reduces to: the front
 * clip fills the frame, or it shares an aspect with everything it covers.
 *
 * Two clips of the SAME asset with the same crop are identical by construction, so they
 * qualify without either being measured — which is what keeps a montage of one source
 * legal on a project nobody has probed.
 *
 * @param front - The clip nearest the viewer, and its source shape.
 * @param behind - Everything it covers, front-to-back.
 * @param frame - The project's own resolution.
 * @returns TRUE when the export can produce nothing the monitor does not already show.
 */
export function hidesWhatIsBehind(
  front: ShapedClip,
  behind: readonly ShapedClip[],
  frame: { readonly width: number; readonly height: number },
): boolean {
  // The clip's own compositing has to be opaque before its geometry matters at all: a mask
  // or a dissolve lets the frame beneath through whatever shape either of them is.
  if (!isFullFrameOpaque(front.clip)) return false;
  if (behind.length === 0) return true;
  if (frame.width <= 0 || frame.height <= 0) return false;

  const frontAspect = visibleAspect(front);
  // Fills the frame ⇒ there is no bar for anything to show through.
  if (frontAspect !== undefined && sameAspect(frontAspect, frame.width / frame.height)) {
    return true;
  }
  return behind.every((covered) => {
    if (
      front.clip.assetId !== undefined &&
      front.clip.assetId === covered.clip.assetId &&
      front.clip.crop?.width === covered.clip.crop?.width &&
      front.clip.crop?.height === covered.clip.crop?.height
    ) {
      return true;
    }
    const coveredAspect = visibleAspect(covered);
    if (frontAspect === undefined || coveredAspect === undefined) return false;
    return sameAspect(frontAspect, coveredAspect);
  });
}

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
