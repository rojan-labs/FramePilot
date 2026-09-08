/**
 * The numbers behind a caption's LOOK, stated once so every surface agrees on them.
 *
 * Three surfaces judge a caption style — the tools that accept one, `verify_captions`,
 * and the note the orchestrator writes after an emphasis pass — and until this module
 * none of them knew the scale of a chip. `background.paddingX` is a fraction of the font
 * size (`timeline-schema/src/index.ts` `CaptionBackgroundSchema`; the catalog uses
 * 0.25–0.6) and the renderer multiplies it (`engine/python/framepilot_engine/render/
 * captions.py` `pad_x = int(font_size * box_pad_x)`). Run `df81d58e` (2026-09-08) sent
 * `paddingX: 18, paddingY: 10, radius: 18` — pixel-shaped numbers — and at the 94 px font
 * a 1080 × 1920 frame gives that is a chip ~1,700 px wider than the frame on each side:
 * every caption rendered as a full-frame white rectangle, `verify_captions` said
 * `ok: true` three times, and `discover_caption_styles` had shown no number the model
 * could have matched. The run before it (`6fc886ef`, a different model) sent 18/10/14.
 *
 * The font-height fraction mirrors the engine (`_FONT_HEIGHT_FRACTION = 1 / 22`) and the
 * preview (`apps/web-editor/src/editor/captionPreview.ts` `CAPTION_FONT_CQH = 100 / 22`);
 * the parity contract is `captionStyle.ts ↔ captions.py`, and a change to one is a change
 * to all three.
 */
import type { CaptionStyle, Clip, Project, Track } from '@framepilot/timeline-schema';
import { getCaptionTemplate } from '@framepilot/timeline-schema/caption-templates';

/** The engine's caption font height as a fraction of the frame height (`captions.py`). */
export const CAPTION_FONT_HEIGHT_FRACTION = 1 / 22;

/**
 * The largest font-relative value a caption style may carry. The catalog tops out at 0.6;
 * 3 leaves generous room for a deliberately loose chip and still refuses every value a
 * caller who thought in pixels could have meant.
 */
export const MAX_CAPTION_EM_VALUE = 3;

/**
 * The shortest cue a viewer can read. The `one-word` segmenter preset floors at 0.25 s
 * (`editor-core/src/captions/segment.ts`); nothing shorter is a caption, it is a flicker.
 * Run `df81d58e` hand-placed a 0.10 s cue ("And you"), deleted it, and placed it again.
 */
export const MIN_CAPTION_CUE_SECONDS = 0.25;

/** The sentence every caption-style surface hands the model about units. */
export const CAPTION_STYLE_UNITS =
  'background.radius, background.paddingX, background.paddingY and shadow.blur are ' +
  'FRACTIONS of the font size — the catalog uses 0.25–0.6, and a chip that hugs the ' +
  'text is paddingX 0.4–0.5, paddingY 0.25–0.35, radius 0.2–0.4. fontScale multiplies ' +
  'the base size (1/22 of the frame height). xPercent, yPercent and maxWidthPercent are ' +
  `percent of the frame. Font-relative values above ${String(MAX_CAPTION_EM_VALUE)} are refused.`;

/** One font-relative field of a style, with where it lives. */
interface EmField {
  readonly path: string;
  readonly value: number;
}

function emFields(style: CaptionStyle | null | undefined): EmField[] {
  if (!style) return [];
  const out: EmField[] = [];
  const { background, shadow } = style;
  if (background) {
    for (const key of ['radius', 'paddingX', 'paddingY'] as const) {
      const value = background[key];
      if (typeof value === 'number') out.push({ path: `background.${key}`, value });
    }
  }
  if (shadow && typeof shadow.blur === 'number') out.push({ path: 'shadow.blur', value: shadow.blur });
  return out;
}

/** The caption font size in pixels for a style on a frame, as the renderer computes it. */
export function captionFontPx(
  style: CaptionStyle | null | undefined,
  resolution: { readonly width: number; readonly height: number },
): number {
  return Math.max(14, Math.floor(resolution.height * CAPTION_FONT_HEIGHT_FRACTION * (style?.fontScale ?? 1)));
}

/** A font-relative value past the ceiling, with what it would render as. */
export interface CaptionEmViolation extends EmField {
  /** The pixels the renderer would draw for it on this frame. */
  readonly px: number;
}

/**
 * Every font-relative field of `style` above {@link MAX_CAPTION_EM_VALUE}.
 *
 * Only the fields the style itself sets are judged: a template's own values are always in
 * range, and a caller who sent none of these has nothing to be wrong about.
 */
export function captionEmViolations(
  style: CaptionStyle | null | undefined,
  resolution: { readonly width: number; readonly height: number },
): CaptionEmViolation[] {
  const fontPx = captionFontPx(style, resolution);
  return emFields(style)
    .filter((field) => field.value > MAX_CAPTION_EM_VALUE)
    .map((field) => ({ ...field, px: Math.round(field.value * fontPx) }));
}

/**
 * The refusal for a style whose numbers are in the wrong unit — what was sent, what it
 * would draw, and the range that was meant. One sentence per offending field.
 */
export function captionUnitsRefusal(
  violations: readonly CaptionEmViolation[],
  resolution: { readonly width: number; readonly height: number },
): string {
  const worst = violations.reduce((a, b) => (b.value > a.value ? b : a));
  const listed = violations
    .map((v) => `${v.path} ${String(v.value)} (≈${String(v.px)} px)`)
    .join(', ');
  return (
    `${listed}: these are fractions of the font size, not pixels — ${String(worst.value)} means ` +
    `${String(worst.value)} font-heights, about ${String(worst.px)} px on this ${String(resolution.width)}×` +
    `${String(resolution.height)} frame, which is wider than the frame itself. ${CAPTION_STYLE_UNITS}`
  );
}

/**
 * The style a cue renders with: its own override over the track default over the
 * template, with `background`/`shadow` taken whole from the first layer that sets them —
 * the same precedence the renderers use.
 */
export function resolveCaptionStyle(clip: Clip, track: Track | undefined): CaptionStyle | undefined {
  const authored: CaptionStyle | undefined =
    clip.captionStyle !== undefined
      ? { ...(track?.captionStyle ?? {}), ...clip.captionStyle }
      : track?.captionStyle;
  if (authored === undefined) return undefined;
  const template =
    authored.templateId !== undefined ? getCaptionTemplate(authored.templateId)?.style : undefined;
  if (template === undefined) return authored;
  return {
    ...template,
    ...authored,
    ...(authored.background === undefined && template.background !== undefined
      ? { background: template.background }
      : {}),
    ...(authored.shadow === undefined && template.shadow !== undefined
      ? { shadow: template.shadow }
      : {}),
  };
}

/** Compare caption words the way a reader would: case- and punctuation-insensitive. */
export const normalizeCaptionWord = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Does `tokens` contain `phrase` as a consecutive run? */
export function containsRun(tokens: readonly string[], phrase: readonly string[]): boolean {
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    if (phrase.every((part, offset) => tokens[i + offset] === part)) return true;
  }
  return false;
}

/**
 * What an emphasis pass actually reached, cue by cue.
 *
 * `auto_emphasize_captions` grounds every keyword and then reports a constant sentence
 * ("Set track caption style"), so run `19e20922` called it thirteen times — same
 * keywords, a different accent hex each time — and never learned that the 2nd–13th changed
 * nothing. The number of cues each keyword lands on is what makes a repeat visibly
 * redundant, and it is read from the applied project, so it cannot disagree with what the
 * renderer will accent.
 *
 * @returns The note, or `''` when the track carries no keyword accent.
 */
export function emphasisCoverageNote(project: Project, trackId: unknown): string {
  if (typeof trackId !== 'string') return '';
  const track = project.timeline.tracks.find((candidate) => candidate.id === trackId);
  const keywords = track?.captionStyle?.accent?.keywords ?? [];
  if (track === undefined || keywords.length === 0) return '';
  const cueTokens = track.clips
    .map((clip) => clip.captionCue?.words.map((word) => normalizeCaptionWord(word.word)) ?? [])
    .filter((tokens) => tokens.length > 0);
  if (cueTokens.length === 0) {
    return ' — the track has no cues yet, so the accent reaches nothing; caption_the_edit writes them.';
  }
  const counts = keywords.map((keyword) => {
    const phrase = keyword.split(/\s+/).map(normalizeCaptionWord).filter(Boolean);
    const hits = cueTokens.filter((tokens) => containsRun(tokens, phrase)).length;
    return { keyword, hits };
  });
  const reached = new Set<number>();
  cueTokens.forEach((tokens, index) => {
    if (counts.some(({ keyword }) => containsRun(tokens, keyword.split(/\s+/).map(normalizeCaptionWord).filter(Boolean)))) {
      reached.add(index);
    }
  });
  const missing = counts.filter((c) => c.hits === 0).map((c) => `"${c.keyword}"`);
  return (
    ` — emphasis lands on ${String(reached.size)} of ${String(cueTokens.length)} cues: ` +
    counts.map((c) => `"${c.keyword}" ×${String(c.hits)}`).join(', ') +
    (missing.length > 0
      ? `. ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} in the transcript but on no cue — spoken in a stretch that was cut, or split across two cues; nothing on screen will accent ${missing.length === 1 ? 'it' : 'them'}.`
      : '.')
  );
}
