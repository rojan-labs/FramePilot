/**
 * Pure caption-preview math for the template-based caption system (schema
 * v10, ADR 0069) — the web-side interpreter of the caption template
 * vocabulary. `CaptionOverlay.tsx` renders from these functions; they have no
 * React/DOM so the enum→CSS mapping is unit-testable.
 *
 * Mirrors the ENGINE interpreter (`engine/python/framepilot_engine/render/
 * captions.py`) at the design level: same display-mode visibility rules, same
 * word states, same emphasis/entrance/loop vocabulary, same deterministic
 * accent-word selection — "same design, not same pixels" (the render-vs-
 * preview contract). It never branches on a template id.
 */
import type { TranscriptWord } from '@framepilot/timeline-schema';
import {
  resolveCaptionStyle,
  type ResolvedCaptionStyle,
} from '@framepilot/timeline-schema/caption-templates';
import type { CSSProperties } from 'react';

export { resolveCaptionStyle };
export type { ResolvedCaptionStyle };

/** Word states, matching the engine's `_word_state`. */
export type CaptionWordState = 'upcoming' | 'active' | 'spoken';

/** Engine parity constants (see `render/captions.py`). */
const UPCOMING_OPACITY = 0.6;
const DEFAULT_HIGHLIGHT_COLOR = '#ffd60a';
const DEFAULT_HIGHLIGHT_SCALE = 1.18;
const PULSE_DEPTH = 0.05;
const WAVE_DEPTH_EM = 0.15;
const WAVE_PHASE_STEP = 0.8;
const SLIDE_FRACTION_EM = 0.6;
const ZOOM_START = 0.5;
const DEFAULT_ENTRANCE_DURATION = 0.15;
const EMPHASIS_PULSE_PERIOD = 0.6;

export function wordState(word: TranscriptWord, time: number): CaptionWordState {
  if (word.start <= time && time < word.end) return 'active';
  if (time >= word.end) return 'spoken';
  return 'upcoming';
}

/**
 * Which words are on screen at `time` for the resolved display mode — the
 * exact rules of the engine's `_visible_indices`: `active-word` shows the
 * spoken word, holding the last spoken through gaps (never blank mid-clip);
 * `cumulative` shows every started word; `phrase` shows all.
 */
export function visibleWordIndices(
  words: readonly TranscriptWord[],
  display: ResolvedCaptionStyle['display'],
  time: number,
): ReadonlySet<number> {
  if (words.length === 0) return new Set();
  if (display === 'active-word') {
    const active = words.findIndex((w) => wordState(w, time) === 'active');
    if (active >= 0) return new Set([active]);
    let lastSpoken = -1;
    for (let i = 0; i < words.length; i += 1) {
      if (wordState(words[i]!, time) === 'spoken') lastSpoken = i;
    }
    return new Set([lastSpoken >= 0 ? lastSpoken : 0]);
  }
  if (display === 'cumulative') {
    const started = new Set<number>();
    for (let i = 0; i < words.length; i += 1) {
      if (words[i]!.start <= time) started.add(i);
    }
    return started;
  }
  return new Set(words.map((_, i) => i));
}

/**
 * Deterministic accent-word indices (matches the engine's `_accent_indices`).
 *
 * `last-word` and `longest-word` pick exactly one word. `keywords` picks every
 * word matching the style's own keyword list (schema v11) — comparison is
 * case- and punctuation-insensitive, so "Viral!" matches "viral". Before v11
 * there was no keyword list in the schema and this mode selected nothing, which
 * is why the editor's keyword chips never reached a render.
 *
 * A keyword may be a PHRASE ("stop scrolling"), which accents the whole run of
 * consecutive words that speaks it. Emphasis is a unit of meaning, not a unit of
 * tokenization: the phrases an editor actually wants to hit are frequently two
 * or three words, and folding one to a single bare token ("stopscrolling") made
 * it match nothing here and be rejected outright by `auto_emphasize_captions`.
 * Longer phrases are matched first so an overlapping single word cannot claim
 * part of a run and leave the emphasis half-applied.
 */
export function accentWordIndices(
  words: readonly TranscriptWord[],
  mode: string | undefined,
  keywords: readonly string[] = [],
): ReadonlySet<number> {
  if (words.length === 0 || mode === undefined || mode === 'none') return EMPTY_INDICES;
  if (mode === 'last-word') return new Set([words.length - 1]);
  if (mode === 'longest-word') {
    let best = 0;
    for (let i = 1; i < words.length; i += 1) {
      if (words[i]!.word.length > words[best]!.word.length) best = i;
    }
    return new Set([best]);
  }
  if (mode === 'keywords') {
    if (keywords.length === 0) return EMPTY_INDICES;
    const tokens = words.map((word) => bareToken(word.word));
    return accentRunIndices(tokens, keywords);
  }
  return EMPTY_INDICES;
}

/**
 * Indices of every token covered by a keyword phrase, over already-bared tokens.
 *
 * Shared by the preview above and mirrored by the engine's `_accent_indices` and
 * `auto_emphasize_captions`' grounding check, so a phrase the tool accepts is a
 * phrase both renderers actually light up.
 */
export function accentRunIndices(
  tokens: readonly string[],
  keywords: readonly string[],
): ReadonlySet<number> {
  const phrases = keywords
    .map((keyword) => keywordTokens(keyword))
    .filter((phrase) => phrase.length > 0)
    // Longest first: "stop scrolling" must win over a bare "stop" that would
    // otherwise consume the first word and leave the second unaccented.
    .sort((a, b) => b.length - a.length);
  const matched = new Set<number>();
  for (const phrase of phrases) {
    for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
      if (phrase.every((part, offset) => tokens[i + offset] === part)) {
        for (let offset = 0; offset < phrase.length; offset += 1) matched.add(i + offset);
      }
    }
  }
  return matched;
}

/** Split a keyword into the bare tokens it must match consecutively. */
export const keywordTokens = (keyword: string): string[] =>
  keyword
    .split(/\s+/)
    .map(bareToken)
    .filter((token) => token !== '');

const EMPTY_INDICES: ReadonlySet<number> = new Set<number>();

/**
 * Fold a token to bare letters/digits, lowercased — the same normalization
 * `captions.ts#stripPunctuation` uses, so a keyword typed in the panel matches
 * the same words the render will accent.
 */
const bareToken = (token: string): string => token.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Ease-out-back (slight overshoot), matching the engine's `_ease_out_back`. */
const easeOutBack = (p: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const q = p - 1;
  return 1 + c3 * q * q * q + c1 * q * q;
};

export interface CaptionWordMotion {
  readonly opacity: number;
  readonly translateYEm: number;
  readonly scale: number;
  /** Fraction of characters shown (typewriter entrance). */
  readonly reveal: number;
}

const ARRIVED: CaptionWordMotion = { opacity: 1, translateYEm: 0, scale: 1, reveal: 1 };

/**
 * Entrance + loop motion for one word at `time` — the engine's `_word_motion`.
 * The entrance anchors on the word's own start when `perWord`, else on
 * `blockStart` (the first word of the clip).
 */
export function captionWordMotion(
  resolved: ResolvedCaptionStyle,
  word: TranscriptWord,
  index: number,
  time: number,
  blockStart: number,
): CaptionWordMotion {
  const animation = resolved.animation;
  const entrance = animation?.in?.type;
  let opacity = 1;
  let translateYEm = 0;
  let scale = 1;
  let reveal = 1;

  if (entrance !== undefined && entrance !== 'none') {
    const duration = animation?.in?.duration ?? DEFAULT_ENTRANCE_DURATION;
    const start = animation?.perWord ? word.start : blockStart;
    const p = duration > 0 ? clamp01((time - start) / duration) : 1;
    if (entrance === 'fade') {
      opacity = p;
    } else if (entrance === 'slide-up') {
      opacity = p;
      translateYEm = (1 - p) * SLIDE_FRACTION_EM;
    } else if (entrance === 'zoom') {
      opacity = p;
      scale = ZOOM_START + (1 - ZOOM_START) * p;
    } else if (entrance === 'bounce') {
      opacity = Math.min(1, p * 2);
      scale = Math.max(0.01, ZOOM_START + (1 - ZOOM_START) * easeOutBack(p));
    } else {
      // typewriter
      reveal = p;
    }
  }

  const loop = animation?.loop;
  if (loop?.type === 'wave') {
    const phase = (2 * Math.PI * time) / (loop.period > 0 ? loop.period : 1);
    translateYEm += WAVE_DEPTH_EM * Math.sin(phase + index * WAVE_PHASE_STEP);
  }

  if (opacity === 1 && translateYEm === 0 && scale === 1 && reveal === 1) return ARRIVED;
  return { opacity, translateYEm, scale, reveal };
}

/** Whole-line loop transform (pulse), matching the engine's post-compose resize. */
export function captionLineScale(resolved: ResolvedCaptionStyle, time: number): number {
  const loop = resolved.animation?.loop;
  if (loop?.type !== 'pulse') return 1;
  const phase = (2 * Math.PI * time) / (loop.period > 0 ? loop.period : 1);
  return 1 + PULSE_DEPTH * Math.sin(phase);
}

/**
 * `outlineWidth` is in sixteenths of the caption's font size — the engine's
 * `_stroke_px` reads the same unit, so the outline keeps its proportion at every
 * output resolution.
 */
export const OUTLINE_WIDTH_UNITS_PER_EM = 16;

/**
 * The letters' fill opacity (schema v24): below 1 the caption is drawn
 * see-through — see {@link CaptionPaintLayer}. Absent means solid letters.
 */
export function captionTextOpacity(resolved: ResolvedCaptionStyle): number {
  const value = resolved.textOpacity;
  return value === undefined ? 1 : Math.min(1, Math.max(0, value));
}

/** Whether the letters are translucent, which needs the layered see-through paint. */
export function isSeeThroughCaption(resolved: ResolvedCaptionStyle): boolean {
  return captionTextOpacity(resolved) < 1;
}

/**
 * `color` with its alpha multiplied by `opacity`, for any CSS colour string.
 *
 * `color-mix` with `transparent` rather than parsing: the schema allows any CSS
 * colour on the web side, and mixing keeps an alpha the colour already has
 * (a `#ffffffcc` at 50% is 40% white — the export's multiplication).
 */
export function seeThroughColor(color: string, opacity: number): string {
  if (opacity >= 1) return color;
  const percent = Math.round(Math.max(0, opacity) * 1000) / 10;
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/**
 * Which copy of a see-through caption a word is being styled for (schema v24).
 *
 * CSS cannot draw an outline or shadow that stops at a translucent letter's
 * edge: `-webkit-text-stroke` is centred on the outline and `text-shadow` is
 * painted under the letter, so both show THROUGH it — and the export
 * (`render/captions.py#_split_letters`) shows only the picture. A see-through
 * caption is therefore three stacked copies of the same layout, bottom to top:
 *
 * - `chips`  — only the active-word chips (text transparent);
 * - `glyphs` — opaque letters that an SVG filter turns into the outline ring and
 *   shadow, knocked out wherever a letter is (the export's paint order: chips,
 *   shadow, ring, glow, letters);
 * - `fill`   — the translucent letters and the word glow.
 *
 * `undefined` is the ordinary single copy every solid caption uses.
 */
export type CaptionPaintLayer = 'chips' | 'glyphs' | 'fill';

/** The opaque ink the `glyphs` copy draws letters in; only its alpha is read. */
const GLYPH_INK = '#000000';

/** CSS for the caption line container (typography, chip, shadow). */
export function captionLineCss(resolved: ResolvedCaptionStyle): CSSProperties {
  const css: CSSProperties = {
    fontFamily: resolved.fontFamily,
    fontWeight: resolved.fontWeight,
    fontStyle: resolved.fontStyle,
    // The export (Pillow) draws only the faces that are bundled. Left to itself
    // the browser fakes a bold or italic the family does not ship — Anton "at
    // 900", Pacifico "in italic" — so the preview promised a look the export
    // never drew.
    fontSynthesis: 'none',
    // Pillow sets only a variable font's weight axis; every other axis stays at
    // its default. Automatic optical sizing would move `opsz` with the preview's
    // on-screen size and draw different letterforms than the export.
    fontOpticalSizing: 'none',
    color: seeThroughColor(resolved.textColor ?? '#ffffff', captionTextOpacity(resolved)),
    letterSpacing: resolved.letterSpacing !== undefined ? `${resolved.letterSpacing}em` : undefined,
    textTransform: resolved.textTransform === 'none' ? undefined : resolved.textTransform,
  };
  if (resolved.background !== undefined) {
    css.backgroundColor = resolved.background.color;
    css.borderRadius = `${resolved.background.radius ?? 0.35}em`;
    css.padding = `${resolved.background.paddingY ?? 0.35}em ${resolved.background.paddingX ?? 0.35}em`;
  }
  // See-through letters draw their outline and shadow in a separate knocked-out
  // copy (CaptionOverlay); on the line itself they would show through the letters.
  if (isSeeThroughCaption(resolved)) return css;
  if (resolved.shadow !== undefined) {
    const s = resolved.shadow;
    css.textShadow = `${s.offsetX}em ${s.offsetY}em ${s.blur}em ${s.color}`;
  }
  if (resolved.outlineColor !== undefined && (resolved.outlineWidth ?? 0) > 0) {
    // Pillow strokes OUTSIDE the glyph, at full width, under the fill. A CSS
    // stroke is centred on the outline, so it is drawn at twice the width and
    // painted beneath the fill: the half that would eat into the letter is
    // covered, the half outside is the export's outline.
    const em = (2 * (resolved.outlineWidth ?? 0)) / OUTLINE_WIDTH_UNITS_PER_EM;
    css.WebkitTextStroke = `${em}em ${resolved.outlineColor}`;
    css.paintOrder = 'stroke fill';
  }
  return css;
}

/**
 * How far the karaoke wipe has crossed an active word, 0–1, or `null` when the
 * word is not being wiped (no karaoke highlight, or not the active word).
 */
export function captionKaraokeFraction(
  resolved: ResolvedCaptionStyle,
  state: CaptionWordState,
  time: number,
  word: TranscriptWord,
): number | null {
  const highlight = resolved.highlight;
  if (state !== 'active' || highlight?.enabled !== true) return null;
  if (highlight.animation !== 'karaoke-fill') return null;
  const span = word.end - word.start;
  return clamp01(span > 0 ? (time - word.start) / span : 1);
}

/**
 * The karaoke wipe: a copy of the active word in the highlight colour, laid
 * exactly over it and clipped to the spoken `fraction` — the export's own
 * construction (`render/captions.py#_draw_karaoke_word` draws the word, then a
 * highlight-coloured copy cropped to the fraction). The copy is the word's
 * `::after` (`.caption-karaoke-word` in `styles.css`, reading `data-wipe`), so
 * it inherits the word's outline and typography and adds no text to the page:
 * the word still reads once. These are the custom properties it reads — the
 * colour, and how much of the word's right side is still unspoken.
 */
export function captionKaraokeWipeVars(
  resolved: ResolvedCaptionStyle,
  fraction: number,
  layer?: CaptionPaintLayer,
): Record<'--caption-wipe-color' | '--caption-wipe-hidden', string> {
  const opacity = layer === 'fill' ? captionTextOpacity(resolved) : 1;
  const color = resolved.highlight?.color ?? DEFAULT_HIGHLIGHT_COLOR;
  return {
    '--caption-wipe-color': seeThroughColor(color, opacity),
    '--caption-wipe-hidden': `${((1 - clamp01(fraction)) * 100).toFixed(1)}%`,
  };
}

/**
 * The frosted-glass and glass-edge CSS of the caption's chip (schema v24), for
 * the on-video overlay only — a list row styled like a caption must not blur
 * the panel behind it.
 *
 * `backdrop-filter: blur()` takes a standard deviation, as `background.blur`
 * is; the border is an INSET ring so it never changes the chip's size, as the
 * export draws it inside the chip.
 */
export function captionBoxCss(resolved: ResolvedCaptionStyle): CSSProperties {
  const background = resolved.background;
  if (background === undefined) return {};
  const css: CSSProperties = {};
  if ((background.blur ?? 0) > 0) {
    css.backdropFilter = `blur(${background.blur}em)`;
    css.WebkitBackdropFilter = `blur(${background.blur}em)`;
  }
  if (background.borderColor !== undefined && (background.borderWidth ?? 0) > 0) {
    const em = (background.borderWidth ?? 0) / OUTLINE_WIDTH_UNITS_PER_EM;
    css.boxShadow = `inset 0 0 0 ${em}em ${background.borderColor}`;
  }
  return css;
}

/**
 * CSS for one word span: state dimming, active-word emphasis, accent styling,
 * and entrance/loop motion. `karaokeFraction` (0..1) is the elapsed portion
 * of the active word's own span, used by the `karaoke-fill` wipe.
 *
 * `layer` selects a see-through caption's copy (see {@link CaptionPaintLayer});
 * every copy keeps the same geometry (padding, size, transform, opacity) so the
 * three stack exactly, and differs only in what it paints.
 */
export function captionWordCss(
  resolved: ResolvedCaptionStyle,
  state: CaptionWordState,
  motion: CaptionWordMotion,
  isAccent: boolean,
  time: number,
  word: TranscriptWord,
  layer?: CaptionPaintLayer,
): CSSProperties {
  const css: CSSProperties = {};
  const highlight = resolved.highlight;
  const opacity = layer === 'fill' ? captionTextOpacity(resolved) : 1;
  // What each copy paints a letter colour as: the translucent fill, the opaque
  // glyph the separation filter reads, or nothing (the chips copy).
  const ink = (color: string): string =>
    layer === 'glyphs'
      ? GLYPH_INK
      : layer === 'chips'
        ? 'transparent'
        : seeThroughColor(color, opacity);
  const emphasized = state === 'active' && highlight?.enabled === true;
  const emphasis = emphasized ? (highlight.animation ?? 'none') : 'none';
  const highlightColor = highlight?.color ?? DEFAULT_HIGHLIGHT_COLOR;
  const highlightScale = highlight?.scale ?? DEFAULT_HIGHLIGHT_SCALE;

  // Dimming the words still to come is part of word highlighting, exactly as in
  // the engine's `_draw_planned_word`: a phrase template with no highlight is a
  // plain line in the export, and previewing it as a karaoke read-along promised
  // a look the export never drew.
  if (
    state === 'upcoming' &&
    highlight?.enabled === true &&
    (resolved.display ?? 'phrase') === 'phrase'
  ) {
    css.opacity = UPCOMING_OPACITY;
  }

  if (isAccent && resolved.accent !== undefined) {
    const accent = resolved.accent;
    if (accent.fontFamily !== undefined) css.fontFamily = accent.fontFamily;
    if (accent.fontScale !== undefined) css.fontSize = `${accent.fontScale}em`;
    if (accent.color !== undefined) css.color = ink(accent.color);
    if (accent.fontStyle !== undefined) css.fontStyle = accent.fontStyle;
  }

  let scale = motion.scale;
  if (emphasis === 'color') {
    css.color = ink(highlightColor);
  } else if (emphasis === 'pop') {
    css.color = ink(highlightColor);
    scale *= highlightScale;
  } else if (emphasis === 'pulse') {
    css.color = ink(highlightColor);
    const phase = (2 * Math.PI * (time - word.start)) / EMPHASIS_PULSE_PERIOD;
    scale *= 1 + ((highlightScale - 1) / 2) * (1 + Math.sin(phase));
  } else if (emphasis === 'karaoke-fill') {
    // The word in its own colour; the wipe is a second copy on top, clipped to
    // the spoken fraction (`captionKaraokeWipeVars`). A gradient clipped to the
    // text sat UNDER the letters' outline, whose inner half then covered it —
    // an outlined karaoke word showed as a solid block of outline colour.
    css.color = ink(resolved.textColor ?? '#ffffff');
    css.position = 'relative';
  } else if (emphasis === 'background') {
    css.color = ink(highlightColor);
    // Only the chips copy paints the chip; every copy keeps its padding and
    // radius so the three copies lay out identically.
    if (layer === undefined || layer === 'chips') {
      css.backgroundColor = highlight?.background ?? DEFAULT_HIGHLIGHT_COLOR;
    }
    css.borderRadius = '0.15em';
    css.padding = '0.05em 0.18em';
  } else if (emphasis === 'glow') {
    css.color = ink(highlightColor);
    if (layer === undefined || layer === 'fill') {
      css.textShadow = `0 0 0.25em ${highlightColor}, 0 0 0.5em ${highlightColor}`;
    }
  } else if (emphasis === 'underline') {
    css.color = ink(highlightColor);
    css.textDecoration = 'underline';
    css.textDecorationThickness = '0.08em';
    css.textUnderlineOffset = '0.15em';
  }

  if (motion.opacity < 1) {
    css.opacity = (typeof css.opacity === 'number' ? css.opacity : 1) * motion.opacity;
  }
  if (motion.translateYEm !== 0 || scale !== 1) {
    css.display = 'inline-block';
    css.transform = `translateY(${motion.translateYEm.toFixed(3)}em) scale(${scale.toFixed(3)})`;
  }
  return css;
}

/** The engine's font-height fraction (1/22 of the frame) expressed in `cqh`. */
export const CAPTION_FONT_CQH = 100 / 22;

/**
 * The canned phrase every template-gallery tile loops (clipvo-style), with
 * synthetic word timings: 0.4s per word from t=0. Tiles render a
 * `CaptionOverlay` with these words on a shared looping clock.
 */
export const GALLERY_WORDS: readonly TranscriptWord[] = [
  'this',
  'is',
  'how',
  'you',
  'go',
  'viral',
].map((word, i) => ({ word, start: i * 0.4, end: (i + 1) * 0.4 }));

/** One gallery loop: the phrase (6 × 0.4s) plus a short hold before repeat. */
export const GALLERY_LOOP_SECONDS = 3.2;
