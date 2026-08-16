/**
 * Canvas overlay painter for the WebCodecs compositor (plan
 * PREVIEW-WEBCODECS-COMPOSITOR.md, P3b). Draws a text/caption overlay onto the
 * 2D context so it matches the DOM `PreviewPlayer`'s `textOverlayStyle` output:
 * percent-based position/box-width, font size as a fraction of frame HEIGHT,
 * alignment, optional background box, and the shared in/out animation state
 * (`textOverlayAnimationState`, the single source of truth for both paths).
 *
 * This is a preview **approximation** — the deterministic truth is the Python
 * render. Font metrics can differ from the DOM (a webfont vs the canvas
 * fallback), and `break-word` is approximated as whole-word overflow. Never
 * used for export.
 */
import type { TextOverlayParams } from '../../editor/patch-builders.js';
import { textOverlayAnimationState } from '../../editor/textOverlay.js';

/** Matches the DOM overlay's `line-height: 1.15`. */
const LINE_HEIGHT = 1.15;
/** Background box padding — `0.4em` horizontal / `0.15em` vertical, per `textOverlayStyle`. */
const PAD_X_EM = 0.4;
const PAD_Y_EM = 0.15;
/** Background box corner radius — `0.15em`, per `textOverlayStyle`. */
const RADIUS_EM = 0.15;

/**
 * Greedily wrap `text` into lines no wider than `maxWidth`, honoring hard
 * line breaks (`\n`, mirroring CSS `white-space: pre-wrap`). A single word
 * wider than `maxWidth` still occupies its own line (an approximation of
 * `overflow-wrap: break-word`, which would split mid-word). Pure — `measure`
 * is injected so this is testable without a real canvas.
 */
export function wrapLines(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/(\s+)/).filter((w) => w.length > 0);
    let current = '';
    for (const word of words) {
      if (/^\s+$/.test(word)) {
        // Collapse whitespace runs to a single space, but only between words.
        if (current.length > 0) current += ' ';
        continue;
      }
      const candidate =
        current.length > 0 && !current.endsWith(' ') ? `${current} ${word}` : current + word;
      if (current.length === 0 || measure(candidate) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current.trimEnd());
        current = word;
      }
    }
    lines.push(current.trimEnd());
  }
  return lines;
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fill();
}

/**
 * Paint one overlay at `timeInClip` seconds into a clip of `durationSeconds`
 * onto `ctx` (canvas size `cw`×`ch`). No-ops when fully transparent (outside
 * its animated window) or the font size is degenerate.
 */
export function paintTextOverlay(
  ctx: CanvasRenderingContext2D,
  params: TextOverlayParams,
  timeInClip: number,
  durationSeconds: number,
  cw: number,
  ch: number,
): void {
  const anim = textOverlayAnimationState(params, timeInClip, durationSeconds);
  if (anim.opacity <= 0) return;
  const fontPx = (params.fontSizePercent / 100) * ch;
  if (fontPx <= 0) return;
  const boxWidthPx = (params.boxWidthPercent / 100) * cw;

  ctx.save();
  ctx.font = `${params.fontWeight} ${fontPx}px ${params.fontFamily}, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const measure = (s: string): number => ctx.measureText(s).width;
  const lines = wrapLines(measure, params.text, boxWidthPx);
  const lineHeightPx = LINE_HEIGHT * fontPx;
  const blockHeight = lines.length * lineHeightPx;
  const maxLineWidth = lines.reduce((m, l) => Math.max(m, measure(l)), 0);

  // Box centre in canvas px, plus the animation translate (percent of the box's
  // own size, matching CSS `translate(%,%)`).
  const cx = (params.xPercent / 100) * cw + (anim.txPercent / 100) * boxWidthPx;
  const cy = (params.yPercent / 100) * ch + (anim.tyPercent / 100) * blockHeight;

  ctx.globalAlpha = anim.opacity;
  ctx.translate(cx, cy);
  ctx.scale(anim.scale, anim.scale);

  if (params.background) {
    const padX = PAD_X_EM * fontPx;
    const padY = PAD_Y_EM * fontPx;
    const bgW = maxLineWidth + padX * 2;
    const bgH = blockHeight + padY * 2;
    ctx.fillStyle = params.background;
    fillRoundRect(ctx, -bgW / 2, -bgH / 2, bgW, bgH, RADIUS_EM * fontPx);
  }

  ctx.fillStyle = params.color;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineWidth = measure(line);
    // Alignment within the box (centred on cx, width boxWidthPx).
    const x =
      params.align === 'center'
        ? -lineWidth / 2
        : params.align === 'right'
          ? boxWidthPx / 2 - lineWidth
          : -boxWidthPx / 2;
    const y = -blockHeight / 2 + (i + 0.5) * lineHeightPx;
    ctx.fillText(line, x, y);
  }
  ctx.restore();
}
