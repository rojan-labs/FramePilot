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
 * a divergence.
 *
 * ## What ADR 0170 changed
 *
 * "Covers the frame" turned out to be the wrong question, because the renderer FITS: a
 * source whose aspect does not match the frame is letterboxed and its bars are transparent
 * at export. Whether that matters depends on what is UNDERNEATH. {@link coverageVerdict}
 * is therefore a relation between the front clip, everything it covers and the frame, and
 * it is what the guard, the canvas preview and the eval rubric all ask.
 * {@link isFullFrameOpaque} survives as its opacity half.
 */
import type { Asset, Clip, CropRect, Timeline } from '@framepilot/timeline-schema';
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
 * - `blendMode` — anything but `normal` is by definition a function of the
 *   layer beneath (`render/compiler.py#_blend_layer_over`).
 * - `effects` — see {@link COVERAGE_BREAKING_EFFECTS}.
 *
 * `crop` is deliberately ABSENT from that list, and used not to be. A crop is geometry: it
 * changes which part of the source is used and therefore how much of the frame the layer
 * ends up painting, but it never makes the paint translucent. Asking it here refused the
 * one placement the relation exists to allow — the *cover* crop `add_clip`'s auto-reframe
 * writes, which makes a letterboxed source fill the frame. {@link coverageVerdict} folds
 * the crop into the fitted rect, where it belongs.
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
  readonly clip: FullFrameOpaqueFields & {
    readonly assetId?: string;
    /** The clip's own id, so a refusal can name what leaks. A whole {@link Clip} satisfies it. */
    readonly id?: string;
  };
  readonly source: SourceShape | undefined;
}

/**
 * One output pixel of slack on every containment comparison.
 *
 * This is not a tolerance picked for comfort, it is the export's own arithmetic. A cover
 * crop is a rounded fraction (`coverCropFor` keeps six places), so the rect it cuts is a
 * hair off the exact target aspect and the fit that follows leaves a sub-pixel sliver. The
 * renderer quantises to whole pixels, so a sliver under one pixel is a bar that does not
 * exist in the file. Requiring exact equality would refuse the very crop written to make a
 * clip cover.
 */
const PIXEL_SLACK = 1;

/** Fractional places kept on a derived crop rect — see `ai-sdk/domain-tools/timeline.ts`,
    whose `coverCropForFrame` delegates here and whose tests pin these digits. */
const CROP_PRECISION = 1e6;

const roundCrop = (value: number): number => Math.round(value * CROP_PRECISION) / CROP_PRECISION;

/** The visible source rect in SOURCE pixels — the crop is a fraction OF THE SOURCE, so the
    visible shape is the source scaled by it. `undefined` when unmeasured or degenerate. */
function visibleRect(entry: ShapedClip): SourceShape | undefined {
  const { source, clip } = entry;
  if (!source || source.width <= 0 || source.height <= 0) return undefined;
  const width = source.width * (clip.crop?.width ?? 1);
  const height = source.height * (clip.crop?.height ?? 1);
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

/**
 * The size, in OUTPUT pixels, that the renderer actually paints for this clip.
 *
 * `render/compiler.py#_place_video_clip` cuts the crop out of the source first and then
 * scales what is left by `min(target_w / w, target_h / h)` — *contain*, not cover — and
 * centres it. So this is the export's own formula, restated once.
 */
function fittedSize(
  entry: ShapedClip,
  frame: { readonly width: number; readonly height: number },
): SourceShape | undefined {
  const rect = visibleRect(entry);
  if (!rect) return undefined;
  const scale = Math.min(frame.width / rect.width, frame.height / rect.height);
  return { width: rect.width * scale, height: rect.height * scale };
}

/**
 * The centred crop that makes a source FILL a frame of a different aspect, in EITHER
 * direction, or `undefined` when it already fills it (within {@link PIXEL_SLACK}) or a
 * size is degenerate.
 *
 * Dictated by the renderer, which fits rather than covers: cut the source down to exactly
 * the target aspect and *contain* becomes *cover*. A source wider than the frame is cut
 * horizontally at full height; a taller one is cut vertically at full width. Keeping the
 * whole other extent throws away the least picture, and the middle is the only defensible
 * guess without subject evidence.
 *
 * It lives here rather than in the agent's tool layer because the refusal that SUGGESTS a
 * crop and the placement that WRITES one have to name the same rect; two copies would
 * drift, and the way they would drift is that the suggestion stops covering.
 *
 * @param source - Measured source pixel dimensions. Never guessed by the caller.
 * @param frame - The project's output pixel dimensions.
 */
export function coverCropFor(
  source: { readonly width: number; readonly height: number },
  frame: { readonly width: number; readonly height: number },
): CropRect | undefined {
  if (source.width <= 0 || source.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return undefined;
  }
  const fitted = fittedSize({ clip: {}, source }, frame);
  /* v8 ignore next -- `fittedSize` is total for the sizes just validated above */
  if (!fitted) return undefined;
  // Already covers: there is no bar to cut away, so there is no crop to suggest.
  if (
    fitted.width >= frame.width - PIXEL_SLACK &&
    fitted.height >= frame.height - PIXEL_SLACK
  ) {
    return undefined;
  }
  const sourceAspect = source.width / source.height;
  const frameAspect = frame.width / frame.height;
  if (sourceAspect > frameAspect) {
    const width = roundCrop(frameAspect / sourceAspect);
    return { x: roundCrop((1 - width) / 2), y: 0, width, height: 1 };
  }
  const height = roundCrop(sourceAspect / frameAspect);
  return { x: 0, y: roundCrop((1 - height) / 2), width: 1, height };
}

/** Why the monitor and the export would disagree about a stack, in terms a refusal can use
    without re-deriving the order the tests run in. */
export type CoverageVerdict =
  | { readonly hides: true }
  | {
      readonly hides: false;
      readonly reason: 'blend' | 'keyframes' | 'effect' | 'unmeasured' | 'leaks';
      /**
       * For `blend` the mode, for `effect` the effect type, for `unmeasured` the covered
       * clip whose shape is unknown, and for `leaks` the clause naming the covered clip
       * that shows through and the bar size in output pixels.
       */
      readonly detail?: string;
      /** For `leaks` with a measured front: the centred crop that would make it fill the frame. */
      readonly coverCrop?: CropRect;
    };

/** Two clips of the SAME asset with the same crop are identical by construction, so they fit
    identically whether or not anyone measured the asset. */
function identicalByConstruction(front: ShapedClip, covered: ShapedClip): boolean {
  return (
    front.clip.assetId !== undefined &&
    front.clip.assetId === covered.clip.assetId &&
    front.clip.crop?.width === covered.clip.crop?.width &&
    front.clip.crop?.height === covered.clip.crop?.height
  );
}

/** How the frame letterboxes a fitted rect, as the middle of the refusal sentence. */
function barsClause(
  fitted: SourceShape,
  frame: { readonly width: number; readonly height: number },
  coveredId: string,
): string {
  const horizontal = frame.width - fitted.width >= frame.height - fitted.height;
  const bar = Math.round((horizontal ? frame.width - fitted.width : frame.height - fitted.height) / 2);
  const axis = horizontal ? 'left and right' : 'top and bottom';
  return (
    `the ${String(frame.width)}x${String(frame.height)} frame fits it with ${String(bar)}px ` +
    `bars ${axis}, and ${coveredId} shows through them at export`
  );
}

/** The label a refusal uses for a clip that has no id of its own. */
const coveredLabel = (covered: ShapedClip): string =>
  covered.clip.id ?? covered.clip.assetId ?? 'the clip beneath';

/**
 * Does the clip in front hide everything behind it, so the monitor and the export agree —
 * and when it does not, why?
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
 * a 1:1 overlay over a 16:9 base in a 16:9 frame leaks the base's left and right edges into
 * the export while the monitor shows only the overlay.
 *
 * ## Why containment, and not "same aspect"
 *
 * "Fills the frame, or shares an aspect with everything it covers" was the first reduction,
 * and it is stricter than the geometry. In a 16:9 frame a 4:3 front over a 1:1 base is
 * fitted WIDER and exactly as tall, so it hides the base completely — and the aspect test
 * refused it. Both fits are centred, so containment is just the two fitted sizes compared,
 * with {@link PIXEL_SLACK} of give.
 *
 * ## The unmeasured policy
 *
 * Nothing can be said about the fit of a source nobody probed, so a mixed-shape stack of
 * DIFFERENT unmeasured assets is refused. Two clips of the same asset are identical by
 * construction and qualify unmeasured — which is what keeps a montage cut from one source
 * legal on a project nobody has probed. A measured clip stacked with an unmeasured one is
 * refused for the same reason as two unmeasured ones: half a comparison is not one.
 *
 * @param front - The clip nearest the viewer, and its source shape.
 * @param behind - Everything it covers, front-to-back.
 * @param frame - The project's own resolution.
 * @returns `{ hides: true }` when the export can produce nothing the monitor does not
 *   already show, otherwise the reason it can.
 */
export function coverageVerdict(
  front: ShapedClip,
  behind: readonly ShapedClip[],
  frame: { readonly width: number; readonly height: number },
): CoverageVerdict {
  // The clip's own compositing has to be opaque before its geometry matters at all: a mask
  // or a dissolve lets the frame beneath through whatever shape either of them is. Tested
  // in this order so the reason a caller reports is the most specific one available.
  const { blendMode, keyframes, effects } = front.clip;
  if (blendMode !== undefined && blendMode !== 'normal') {
    return { hides: false, reason: 'blend', detail: blendMode };
  }
  if ((keyframes ?? []).length > 0) return { hides: false, reason: 'keyframes' };
  const breaking = (effects ?? []).find((effect) => COVERAGE_BREAKING_EFFECTS.has(effect.type));
  if (breaking) return { hides: false, reason: 'effect', detail: breaking.type };

  if (behind.length === 0) return { hides: true };
  if (frame.width <= 0 || frame.height <= 0) {
    return { hides: false, reason: 'unmeasured', detail: coveredLabel(behind[0] as ShapedClip) };
  }

  const frontFit = fittedSize(front, frame);
  for (const covered of behind) {
    if (identicalByConstruction(front, covered)) continue;
    const coveredFit = fittedSize(covered, frame);
    if (!frontFit || !coveredFit) {
      return { hides: false, reason: 'unmeasured', detail: coveredLabel(covered) };
    }
    if (
      frontFit.width >= coveredFit.width - PIXEL_SLACK &&
      frontFit.height >= coveredFit.height - PIXEL_SLACK
    ) {
      continue;
    }
    // Suggested from the SOURCE, not the visible rect: `set_clip_crop` REPLACES the crop,
    // so a rect derived from an already-cropped region would compose two crops.
    const suggested = front.source ? coverCropFor(front.source, frame) : undefined;
    return {
      hides: false,
      reason: 'leaks',
      detail: barsClause(frontFit, frame, coveredLabel(covered)),
      ...(suggested ? { coverCrop: suggested } : {}),
    };
  }
  return { hides: true };
}

/**
 * {@link coverageVerdict} as a yes/no, for callers that only gate on it.
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
  return coverageVerdict(front, behind, frame).hides;
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
