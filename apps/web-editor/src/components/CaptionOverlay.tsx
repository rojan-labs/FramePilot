/**
 * CaptionOverlay — draws a caption clip in the preview (and, at tile scale,
 * the template gallery) using the template-based caption system.
 *
 * A pure function of (style, lines, time): the cue's timed display tokens are
 * laid out as spans, the resolved template's display mode selects which are
 * visible, and the emphasis/entrance/loop vocabulary maps to CSS — all via the
 * unit-tested math in `../editor/captionPreview.ts`. The authoritative pixels
 * are the engine's (render-vs-preview rule); this is the live approximation with
 * the same design.
 *
 * Takes `lines` rather than a flat word list (schema v11, ADR 0071) so an
 * author's explicit `\n` renders where they put it. Through v10 wrapping was
 * whatever each renderer's greedy fill produced at that frame size, so the same
 * cue broke differently in the preview and the export. Index math (visibility,
 * accent, per-word entrance stagger) still runs over the flattened list, so a
 * line break costs nothing and never shifts a word's timing.
 */
import type { CaptionStyle, TranscriptWord } from '@framepilot/timeline-schema';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import {
  accentWordIndices,
  captionBoxCss,
  captionLineCss,
  captionLineScale,
  captionWordCss,
  captionWordMotion,
  visibleWordIndices,
  resolveCaptionStyle,
  isSeeThroughCaption,
  wordState,
  CAPTION_FONT_CQH,
  OUTLINE_WIDTH_UNITS_PER_EM,
  type CaptionPaintLayer,
} from '../editor/captionPreview.js';

export interface CaptionOverlayProps {
  /** The caption clip's persisted style (template + overrides), if any. */
  readonly style: CaptionStyle | undefined;
  /**
   * The caption track's style default, layered under `style` (schema v11).
   * Resolution is clip override → track default → template catalog.
   */
  readonly trackStyle?: CaptionStyle | undefined;
  /**
   * The cue's timed display tokens, grouped into display lines — as produced by
   * `resolveCaptionCue` in editor-core. One line is the common case.
   */
  readonly lines: readonly (readonly TranscriptWord[])[];
  /** Current absolute timeline time in seconds. */
  readonly time: number;
  /**
   * Base font size override. Defaults to the engine's frame-relative size
   * (1/22 of the container height via `cqh`); gallery tiles pass px values.
   */
  readonly fontSize?: string;
}

/** Takes its space in the line without being seen (or read by assistive tech). */
const HIDDEN_WORD: CSSProperties = { visibility: 'hidden' };

/** Vertical anchor → flex placement, mirroring the compiler's safe areas. */
const POSITION_CSS: Record<string, CSSProperties> = {
  top: { alignItems: 'flex-start', paddingTop: '8%' },
  middle: { alignItems: 'center' },
  bottom: { alignItems: 'flex-end', paddingBottom: '8%' },
};

export function CaptionOverlay({
  style,
  trackStyle,
  lines,
  time,
  fontSize,
}: CaptionOverlayProps): JSX.Element | null {
  const flat = lines.flat();
  if (flat.length === 0) return null;
  const resolved = resolveCaptionStyle(style, trackStyle);
  const display = resolved.display ?? 'phrase';
  const visible = visibleWordIndices(flat, display, time);
  const accented = accentWordIndices(flat, resolved.accent?.mode, resolved.accent?.keywords ?? []);
  const blockStart = flat[0]!.start;
  const lineScale = captionLineScale(resolved, time);
  const hasFreePosition = resolved.xPercent !== undefined || resolved.yPercent !== undefined;
  const clampPosition = (value: number): number =>
    resolved.safeArea === false ? value : Math.min(90, Math.max(10, value));

  const container: CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
    fontSize: fontSize ?? `${(CAPTION_FONT_CQH * (resolved.fontScale ?? 1)).toFixed(2)}cqh`,
    ...(hasFreePosition ? {} : POSITION_CSS[resolved.position ?? 'bottom']),
  };

  const transforms = [
    hasFreePosition ? 'translate(-50%, -50%)' : '',
    resolved.rotation ? `rotate(${resolved.rotation}deg)` : '',
    lineScale !== 1 ? `scale(${lineScale.toFixed(3)})` : '',
  ].filter(Boolean);

  const block: CSSProperties = {
    ...captionLineCss(resolved),
    ...captionBoxCss(resolved),
    maxWidth: `${resolved.maxWidthPercent ?? 90}%`,
    textAlign: resolved.textAlign ?? 'center',
    lineHeight: resolved.lineHeight ?? 1.25,
    ...(hasFreePosition
      ? {
          position: 'absolute',
          left: `${clampPosition(resolved.xPercent ?? 50)}%`,
          top: `${clampPosition(resolved.yPercent ?? 50)}%`,
        }
      : {}),
    ...(transforms.length > 0 ? { transform: transforms.join(' ') } : {}),
  };

  const oneWord = (resolved.display ?? 'phrase') === 'active-word';

  /**
   * The caption's lines for one paint layer (see `CaptionPaintLayer`). Every copy
   * of a see-through caption is built by this same walk, so they lay out
   * identically; only the `fill` copy (or the single solid copy) is the one
   * assistive tech and tests read, so only it carries the word states.
   */
  const renderLines = (layer?: CaptionPaintLayer): JSX.Element[] => {
    const readable = layer === undefined || layer === 'fill';
    // Walk the flat index alongside the line grouping so visibility/accent/motion
    // stay keyed to the cue's word order, not to a position within its line.
    let flatIndex = 0;
    const rendered: JSX.Element[] = [];
    lines.forEach((line, lineNumber) => {
      const spans: JSX.Element[] = [];
      line.forEach((word) => {
        const index = flatIndex;
        flatIndex += 1;
        const motion = captionWordMotion(resolved, word, index, time, blockStart);
        const shown = visible.has(index) && motion.opacity > 0 && motion.reveal > 0;
        if (!shown) {
          // One word at a time is a single centred word: nothing else takes space.
          if (oneWord) return;
          // Every other mode keeps a word's place before it appears, as the
          // export lays out the full phrase once: a build or cascade line must
          // not re-centre and jump sideways each time a word arrives.
          if (spans.length > 0) spans.push(<span key={`gap-${index}`}> </span>);
          spans.push(
            <span
              key={index}
              data-word-state={readable ? 'hidden' : undefined}
              // The word's own typography (an accent word is larger) so the
              // reserved space is the space it will take.
              style={{
                ...captionWordCss(
                  resolved,
                  'upcoming',
                  motion,
                  accented.has(index),
                  time,
                  word,
                  layer,
                ),
                ...HIDDEN_WORD,
              }}
            >
              {word.word}
            </span>,
          );
          return;
        }
        const state = wordState(word, time);
        const revealed =
          motion.reveal < 1 ? Math.ceil(word.word.length * motion.reveal) : word.word.length;
        if (spans.length > 0) spans.push(<span key={`gap-${index}`}> </span>);
        spans.push(
          <span
            key={index}
            data-word-state={readable ? state : undefined}
            style={captionWordCss(resolved, state, motion, accented.has(index), time, word, layer)}
          >
            {word.word.slice(0, revealed)}
            {revealed < word.word.length && (
              // The untyped rest of a typewriter word still holds its width.
              <span style={HIDDEN_WORD}>{word.word.slice(revealed)}</span>
            )}
          </span>,
        );
      });
      if (spans.length === 0) return;
      rendered.push(
        // A block per line: the author's break is a real layout break, not a
        // wrap that changes with the frame size.
        <span
          key={`line-${lineNumber}`}
          className="caption-overlay-line"
          style={{ display: 'block' }}
        >
          {spans}
        </span>,
      );
    });
    return rendered;
  };

  const solid = isSeeThroughCaption(resolved) ? null : renderLines();
  if (solid !== null && solid.length === 0) return null;

  return (
    <div className="caption-overlay" aria-label="captions" style={container}>
      <span className="caption-overlay-block" style={block}>
        {solid ?? <SeeThroughCopies resolved={resolved} renderLines={renderLines} />}
      </span>
    </div>
  );
}

/** A colour for an SVG `flood-color`, with any `#rrggbbaa` alpha split out. */
function floodPaint(color: string): { floodColor: string; floodOpacity: number } {
  const hex8 = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(color);
  if (hex8 === null) return { floodColor: color, floodOpacity: 1 };
  return { floodColor: `#${hex8[1]}`, floodOpacity: parseInt(hex8[2]!, 16) / 255 };
}

/**
 * A see-through caption (schema v24): three stacked copies of one layout — the
 * active-word chips, the outline ring and shadow knocked out wherever a letter
 * is, and the translucent letters with their glow. The export's paint order
 * (`render/captions.py#_render_styled_caption`): chips, shadow, ring, glow,
 * letters.
 *
 * The ring and shadow come from an SVG filter over the `glyphs` copy (opaque
 * letters): dilate the letters by the outline width, blur and offset that
 * silhouette for the shadow, merge, and cut out the letters themselves. The
 * filter works in pixels, so the caption's font size is measured; until the
 * first measurement lands the letters draw without ring or shadow.
 */
function SeeThroughCopies({
  resolved,
  renderLines,
}: {
  readonly resolved: ReturnType<typeof resolveCaptionStyle>;
  readonly renderLines: (layer: CaptionPaintLayer) => JSX.Element[];
}): JSX.Element | null {
  const filterId = `caption-see-through-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const ref = useRef<HTMLSpanElement>(null);
  const [fontPx, setFontPx] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const measure = (): void => {
      const px = Number.parseFloat(getComputedStyle(element).fontSize);
      if (Number.isFinite(px))
        setFontPx((current) => (Math.abs(current - px) < 0.01 ? current : px));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fill = renderLines('fill');
  if (fill.length === 0) return null;
  const ringPx =
    resolved.outlineColor !== undefined && (resolved.outlineWidth ?? 0) > 0
      ? ((resolved.outlineWidth ?? 0) / OUTLINE_WIDTH_UNITS_PER_EM) * fontPx
      : 0;
  const shadow = resolved.shadow;
  const separated = fontPx > 0 && (ringPx > 0 || shadow !== undefined);
  const chips =
    resolved.highlight?.enabled === true && resolved.highlight.animation === 'background';
  const copy: CSSProperties = { gridArea: '1 / 1' };

  return (
    <span ref={ref} className="caption-see-through" style={{ display: 'grid' }}>
      {separated && (
        <svg
          aria-hidden="true"
          focusable="false"
          width="0"
          height="0"
          style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
        >
          <filter
            id={filterId}
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
            colorInterpolationFilters="sRGB"
          >
            {ringPx > 0 ? (
              <feMorphology
                in="SourceAlpha"
                operator="dilate"
                radius={ringPx}
                result="silhouette"
              />
            ) : (
              <feOffset in="SourceAlpha" dx={0} dy={0} result="silhouette" />
            )}
            {shadow !== undefined && (
              <>
                <feGaussianBlur
                  in="silhouette"
                  // A CSS blur radius is two standard deviations (`captionLineCss`).
                  stdDeviation={(shadow.blur * fontPx) / 2}
                  result="blurred"
                />
                <feOffset
                  in="blurred"
                  dx={shadow.offsetX * fontPx}
                  dy={shadow.offsetY * fontPx}
                  result="cast"
                />
                <feFlood {...floodPaint(shadow.color)} result="shadowInk" />
                <feComposite in="shadowInk" in2="cast" operator="in" result="shadow" />
              </>
            )}
            {ringPx > 0 && resolved.outlineColor !== undefined && (
              <>
                <feFlood {...floodPaint(resolved.outlineColor)} result="ringInk" />
                <feComposite in="ringInk" in2="silhouette" operator="in" result="ring" />
              </>
            )}
            <feMerge result="separation">
              {shadow !== undefined && <feMergeNode in="shadow" />}
              {ringPx > 0 && <feMergeNode in="ring" />}
            </feMerge>
            <feComposite in="separation" in2="SourceAlpha" operator="out" />
          </filter>
        </svg>
      )}
      {chips && (
        <span aria-hidden="true" style={{ ...copy, color: 'transparent' }}>
          {renderLines('chips')}
        </span>
      )}
      {separated && (
        <span
          aria-hidden="true"
          data-caption-layer="separation"
          style={{ ...copy, color: '#000000', filter: `url(#${filterId})` }}
        >
          {renderLines('glyphs')}
        </span>
      )}
      <span style={copy}>{fill}</span>
    </span>
  );
}
