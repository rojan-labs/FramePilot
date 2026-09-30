/**
 * Preview-time styling for a text overlay (#5).
 *
 * Turns a clip's {@link TextOverlayParams} plus the current time WITHIN the clip
 * into the CSS the preview draws. Positions/sizes are percent-based so they hold
 * across orientation changes; font size is expressed in `cqh` (a fraction of the
 * preview frame's height, which is a size container), so text scales with the
 * frame at any panel size with no measurement.
 *
 * In/out animations are computed from the playhead (not a mount-time CSS
 * animation), so they are scrub-accurate: the overlay eases in over its first
 * `animDurationSeconds` and eases out over its last, and reads correctly at any
 * scrubbed frame. The export draws the same envelope (plan/elements EL2a).
 *
 * Pure + deterministic — unit-tested; the component is a thin consumer.
 */
import type { CSSProperties } from 'react';
import { titleFaceLines } from '@framepilot/ai-sdk';
import { titleEnvelopeFromParams } from '@framepilot/editor-core';
import type { CaptionStyle } from '@framepilot/timeline-schema';
import {
  textOverlayCaptionStyle,
  textOverlayLineLayouts,
} from '@framepilot/timeline-schema/text-overlay-styles';
import {
  OUTLINE_WIDTH_UNITS_PER_EM,
  captionBoxCss,
  captionLineCss,
  captionTextOpacity,
  isSeeThroughCaption,
  resolveCaptionStyle,
} from './captionPreview.js';
import type { TextOverlayParams } from './patch-builders.js';

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The eased-in fraction (0→1) and eased-out fraction (1→0) at `timeInClip`. */
export function animationProgress(
  timeInClip: number,
  durationSeconds: number,
  animDurationSeconds: number,
): { inProgress: number; outProgress: number } {
  const anim = Math.max(0, animDurationSeconds);
  if (anim === 0) return { inProgress: 1, outProgress: 1 };
  const inProgress = clamp01(timeInClip / anim);
  const outProgress = clamp01((durationSeconds - timeInClip) / anim);
  return { inProgress, outProgress };
}

/**
 * The resolved animation state of an overlay at `timeInClip`: opacity, a vertical offset as a
 * fraction of the FRAME height (down +), and a scale about the box centre. It is the export's
 * own title envelope (`titleEnvelopeFromParams`, the frame plan's computation), shared by the
 * DOM `textOverlayStyle` and the WebCodecs canvas overlay painter so all three animate alike.
 */
export interface TextOverlayAnimationState {
  readonly opacity: number;
  readonly dyFrame: number;
  readonly scale: number;
}

/** Resolve an overlay's in/out animation state at `timeInClip` (pure). */
export function textOverlayAnimationState(
  params: TextOverlayParams,
  timeInClip: number,
  durationSeconds: number,
): TextOverlayAnimationState {
  const envelope = titleEnvelopeFromParams(params, timeInClip, durationSeconds);
  return { opacity: envelope.opacity, dyFrame: envelope.dy, scale: envelope.scale };
}

/** The caption renderer's default line height, when a text overlay's typography names none. */
const CAPTION_LINE_HEIGHT = 1.25;
/** The caption renderer's chip padding (em) when the style names none, chip or not. */
const CAPTION_CHIP_PADDING = 0.35;

/**
 * The caption typography CSS of a text overlay that carries `typography` (the caption CSS a caption in
 * the same look gets, `captionPreview.ts`), or `null` for a plain text overlay.
 *
 * One approximation, for see-through letters: the caption preview draws those as three stacked
 * copies so the outline and shadow stop at the letter's edge, as the export does. A text overlay is one
 * editable element, so its outline is a CSS stroke of the export's width, centred on the glyph
 * edge — the same weight of line, half of it inside the letter. The desktop monitor draws the
 * engine's own raster underneath, so this matters only for the selected text overlay and the browser.
 */
export function textOverlayTypographyCss(params: TextOverlayParams): CSSProperties | null {
  const style = textOverlayCaptionStyle(params);
  return style === undefined ? null : captionBlockCss(style);
}

/** The caption CSS of one block of text in `style`: letters, chip and the renderer's padding. */
function captionBlockCss(style: CaptionStyle): CSSProperties {
  const resolved = resolveCaptionStyle(style);
  const chip = resolved.background;
  const css: CSSProperties = {
    ...captionLineCss(resolved),
    ...captionBoxCss(resolved),
    lineHeight: resolved.lineHeight ?? CAPTION_LINE_HEIGHT,
    // The caption renderer keeps its chip padding round the text whether or not a chip is
    // drawn, and wraps inside it (`captions.py`: wrap width = max width - 2 x pad). A padded
    // border-box, with or without a chip, wraps the preview exactly where the export does.
    padding: `${chip?.paddingY ?? CAPTION_CHIP_PADDING}em ${chip?.paddingX ?? CAPTION_CHIP_PADDING}em`,
    boxSizing: 'border-box',
  };
  if (!isSeeThroughCaption(resolved)) return css;
  if (resolved.shadow !== undefined) {
    const s = resolved.shadow;
    css.textShadow = `${s.offsetX}em ${s.offsetY}em ${s.blur}em ${s.color}`;
  }
  const outline = resolved.outlineWidth ?? 0;
  if (resolved.outlineColor !== undefined && outline > 0) {
    css.WebkitTextStroke = `${outline / OUTLINE_WIDTH_UNITS_PER_EM}em ${resolved.outlineColor}`;
  } else if (captionTextOpacity(resolved) === 0) {
    // Hollow letters with no ring would draw nothing at all; keep a hairline so the text overlay can
    // still be found and edited.
    css.WebkitTextStroke = `1px ${resolved.textColor ?? '#ffffff'}`;
  }
  return css;
}

/**
 * Paint a lockup line starts from, so it never inherits the overlay box's: a line whose own
 * style draws no shadow, ring or chip must draw none, as the engine's per-line raster does.
 */
const LINE_PAINT_RESET = {
  textShadow: 'none',
  WebkitTextStroke: '0',
  backgroundColor: 'transparent',
  boxShadow: 'none',
} as const satisfies CSSProperties;

/**
 * The height, in ems, the engine gives one row of `style`: the face's ascent plus descent, and
 * the outline's width above and below (`captions.py#_layout_styled_caption`). A CSS line box of
 * this height puts the row's box, and its baseline, where the export's is, whatever the face:
 * a script's tall ascenders or a condensed face at a tight line height stack alike in both.
 *
 * Rows that wrap inside one line are pitched by this alone, where the engine adds a gap between
 * them (`lineHeight - 1` of the size when above 1, a sixth of it when no line height is set).
 * CSS cannot add space between rows only without also growing the line's chip, so a lockup line
 * that wraps is drawn slightly tighter here than in the export; lockup lines are short.
 */
function engineRowHeightEm(style: CaptionStyle): number {
  const [ascent, descent] = titleFaceLines(
    style.fontFamily ?? DEFAULT_TYPED_FAMILY,
    style.fontStyle === 'italic',
  );
  const strokeEm =
    style.outlineColor !== undefined ? (style.outlineWidth ?? 0) / OUTLINE_WIDTH_UNITS_PER_EM : 0;
  return (ascent + descent) / 1000 + 2 * strokeEm;
}

/** The family a typed overlay with none is drawn in (the engine's `_with_editor_defaults`). */
const DEFAULT_TYPED_FAMILY = 'Inter';

const LINE_ALIGN: Readonly<Record<TextOverlayParams['align'], CSSProperties>> = {
  left: { marginLeft: 0, marginRight: 'auto' },
  center: { marginLeft: 'auto', marginRight: 'auto' },
  right: { marginLeft: 'auto', marginRight: 0 },
};

/** One line of a lockup as the DOM draws it. */
export interface TextOverlayLineBlock {
  /** The paragraph's index in the overlay's text: a stable React key. */
  readonly index: number;
  readonly text: string;
  readonly css: CSSProperties;
}

/**
 * A lockup's lines, each with the CSS it is drawn in, or `null` for a text overlay that is not a
 * lockup (it draws its text as one block). The box they sit in is a column
 * ({@link textOverlayStyle}); each line is its own caption block at its own size (`em` of the
 * overlay's size), `spaceBefore` below the line above — the engine's `_stack_lockup`, in CSS.
 */
export function textOverlayLineBlocks(
  params: TextOverlayParams,
): readonly TextOverlayLineBlock[] | null {
  const layouts = textOverlayLineLayouts(params);
  if (layouts === undefined) return null;
  return layouts.map((line, position) => ({
    index: line.index,
    text: line.text,
    css: {
      ...LINE_PAINT_RESET,
      ...captionBlockCss(line.style),
      lineHeight: engineRowHeightEm(line.style),
      fontSize: `${line.scale}em`,
      // `spaceBefore` is in ems of the OVERLAY's size; this line's em is `scale` of it.
      marginTop: position === 0 ? 0 : `${line.spaceBefore / line.scale}em`,
      // Each line aligns itself (a block as wide as its words), so it stacks the same wherever
      // it is put: straight in the overlay's box, or inside the on-canvas editor's content node.
      display: 'block',
      ...LINE_ALIGN[params.align],
      width: 'max-content',
      maxWidth: '100%',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
    },
  }));
}

/** `params` drawn as one block in the overlay's own look: a lockup without its lines. */
export function withoutLockupLines(params: TextOverlayParams): TextOverlayParams {
  if (params.typography?.lines === undefined) return params;
  const { lines: _lines, ...typography } = params.typography;
  return { ...params, typography };
}

/**
 * A text overlay's clip transform as the DOM draws it: the centre's offset in percent of each
 * frame axis, the horizontal and vertical scale (uniform scale × stretch) and the turn in degrees
 * (anticlockwise-positive, the project's convention). The export places the text overlay's raster
 * with the same transform (`_place_video_clip`).
 */
export interface TextOverlayClipTransform {
  readonly dxPercent: number;
  readonly dyPercent: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number;
}

const IDENTITY_CLIP: TextOverlayClipTransform = {
  dxPercent: 0,
  dyPercent: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
};

/**
 * The full CSS for a text overlay box at `timeInClip` seconds into a clip of
 * `durationSeconds`. Combines the static style (position, size, colour, font,
 * alignment, optional background) with the current in/out animation state.
 */
export function textOverlayStyle(
  params: TextOverlayParams,
  timeInClip: number,
  durationSeconds: number,
  clip: TextOverlayClipTransform = IDENTITY_CLIP,
): CSSProperties {
  const { opacity, dyFrame, scale } = textOverlayAnimationState(
    params,
    timeInClip,
    durationSeconds,
  );

  // The clip's turn (CSS is clockwise-positive) and its per-axis scale, about the box's centre,
  // after the In/Out envelope's slide and pop.
  const turn = clip.rotation === 0 ? '' : ` rotate(${-clip.rotation}deg)`;
  const box: CSSProperties = {
    position: 'absolute',
    left: `${params.xPercent + clip.dxPercent}%`,
    top: `${params.yPercent + clip.dyPercent}%`,
    // `cqh` is a percent of the preview frame's height, the unit the export's slide moves in.
    transform:
      `translate(-50%, -50%) translateY(${dyFrame * 100}cqh)${turn} ` +
      `scale(${scale * clip.scaleX}, ${scale * clip.scaleY})`,
    textAlign: params.align,
    fontSize: `${params.fontSizePercent}cqh`,
    opacity,
    overflowWrap: 'break-word',
    whiteSpace: 'pre-wrap',
    pointerEvents: 'none',
  };
  if (params.typography?.lines !== undefined && textOverlayLineBlocks(params) !== null) {
    // A lockup: the box holds a column of caption blocks that paint themselves
    // (`textOverlayLineBlocks`); it draws no letters or chip of its own.
    return {
      ...box,
      width: 'max-content',
      maxWidth: `${Math.min(100, Math.max(5, params.boxWidthPercent))}%`,
    };
  }
  const typography = textOverlayTypographyCss(params);
  if (typography !== null) {
    // The engine draws a typed text overlay's raster tight around its lines and centres it on
    // x/y, so the box is as wide as its text, up to the wrap width, and the chip hugs it.
    return {
      ...box,
      ...typography,
      width: 'max-content',
      // Clamped as both mappings clamp the wrap width (`textOverlayCaptionStyle`, the engine's).
      maxWidth: `${Math.min(100, Math.max(5, params.boxWidthPercent))}%`,
    };
  }
  return {
    ...box,
    width: `${params.boxWidthPercent}%`,
    color: params.color,
    fontFamily: params.fontFamily,
    fontWeight: params.fontWeight,
    lineHeight: 1.15,
    // `backgroundColor`, never the `background` shorthand: the typed path paints its chip with
    // `backgroundColor` too, and the desktop hit target blanks exactly that key. React writes
    // only the keys that changed, so a shorthand here and a longhand there let a changed chip
    // colour leak onto the invisible hit target over the engine's raster.
    ...(params.background
      ? { backgroundColor: params.background, padding: '0.15em 0.4em', borderRadius: '0.15em' }
      : {}),
  };
}

/**
 * What a text overlay's hit target over the engine's raster of it adds to {@link textOverlayStyle}: it
 * keeps the text overlay's box and wrap so it covers the same letters, and paints nothing (no fill,
 * chip, outline, shadow, rim or frost). Every paint key `textOverlayStyle` can produce is
 * overridden here by the SAME key. React writes only the style keys that changed, so a shorthand
 * on one side and a longhand on the other would let a later change show through.
 */
export const TEXT_HIT_TARGET_STYLE = {
  color: 'transparent',
  backgroundColor: 'transparent',
  backgroundImage: 'none',
  textShadow: 'none',
  WebkitTextStroke: '0',
  boxShadow: 'none',
  backdropFilter: 'none',
  WebkitBackdropFilter: 'none',
} as const satisfies CSSProperties;
