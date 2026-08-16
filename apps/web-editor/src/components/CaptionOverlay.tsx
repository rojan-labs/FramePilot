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
import type { CSSProperties, JSX } from 'react';
import {
  accentWordIndices,
  captionLineCss,
  captionLineScale,
  captionWordCss,
  captionWordMotion,
  visibleWordIndices,
  resolveCaptionStyle,
  wordState,
  CAPTION_FONT_CQH,
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

  // Walk the flat index alongside the line grouping so visibility/accent/motion
  // stay keyed to the cue's word order, not to a position within its line.
  let flatIndex = 0;
  const rendered: JSX.Element[] = [];
  lines.forEach((line, lineNumber) => {
    const spans: JSX.Element[] = [];
    line.forEach((word) => {
      const index = flatIndex;
      flatIndex += 1;
      if (!visible.has(index)) return;
      const motion = captionWordMotion(resolved, word, index, time, blockStart);
      if (motion.opacity <= 0 || motion.reveal <= 0) return;
      const state = wordState(word, time);
      const text =
        motion.reveal < 1
          ? word.word.slice(0, Math.ceil(word.word.length * motion.reveal))
          : word.word;
      if (text.length === 0) return;
      if (spans.length > 0) spans.push(<span key={`gap-${index}`}> </span>);
      spans.push(
        <span
          key={index}
          data-word-state={state}
          style={captionWordCss(resolved, state, motion, accented.has(index), time, word)}
        >
          {text}
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
  if (rendered.length === 0) return null;

  return (
    <div className="caption-overlay" aria-label="captions" style={container}>
      <span className="caption-overlay-block" style={block}>
        {rendered}
      </span>
    </div>
  );
}
