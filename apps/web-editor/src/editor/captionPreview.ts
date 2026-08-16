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
    const wanted = new Set(keywords.map(bareToken));
    const matched = new Set<number>();
    for (let i = 0; i < words.length; i += 1) {
      if (wanted.has(bareToken(words[i]!.word))) matched.add(i);
    }
    return matched;
  }
  return EMPTY_INDICES;
}

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

/** CSS for the caption line container (typography, chip, shadow). */
export function captionLineCss(resolved: ResolvedCaptionStyle): CSSProperties {
  const css: CSSProperties = {
    fontFamily: resolved.fontFamily,
    fontWeight: resolved.fontWeight,
    fontStyle: resolved.fontStyle,
    color: resolved.textColor ?? '#ffffff',
    letterSpacing: resolved.letterSpacing !== undefined ? `${resolved.letterSpacing}em` : undefined,
    textTransform: resolved.textTransform === 'none' ? undefined : resolved.textTransform,
  };
  if (resolved.background !== undefined) {
    css.backgroundColor = resolved.background.color;
    css.borderRadius = `${resolved.background.radius ?? 0.35}em`;
    css.padding = `${resolved.background.paddingY ?? 0.35}em ${resolved.background.paddingX ?? 0.35}em`;
  }
  if (resolved.shadow !== undefined) {
    const s = resolved.shadow;
    css.textShadow = `${s.offsetX}em ${s.offsetY}em ${s.blur}em ${s.color}`;
  }
  if (resolved.outlineColor !== undefined && (resolved.outlineWidth ?? 0) > 0) {
    // CSS's closest analog of a Pillow stroke outline.
    css.WebkitTextStroke = `${(resolved.outlineWidth ?? 0) / 16}em ${resolved.outlineColor}`;
  }
  return css;
}

/**
 * CSS for one word span: state dimming, active-word emphasis, accent styling,
 * and entrance/loop motion. `karaokeFraction` (0..1) is the elapsed portion
 * of the active word's own span, used by the `karaoke-fill` wipe.
 */
export function captionWordCss(
  resolved: ResolvedCaptionStyle,
  state: CaptionWordState,
  motion: CaptionWordMotion,
  isAccent: boolean,
  time: number,
  word: TranscriptWord,
): CSSProperties {
  const css: CSSProperties = {};
  const highlight = resolved.highlight;
  const emphasized = state === 'active' && highlight?.enabled === true;
  const emphasis = emphasized ? (highlight.animation ?? 'none') : 'none';
  const highlightColor = highlight?.color ?? DEFAULT_HIGHLIGHT_COLOR;
  const highlightScale = highlight?.scale ?? DEFAULT_HIGHLIGHT_SCALE;

  if (state === 'upcoming' && (resolved.display ?? 'phrase') === 'phrase') {
    css.opacity = UPCOMING_OPACITY;
  }

  if (isAccent && resolved.accent !== undefined) {
    const accent = resolved.accent;
    if (accent.fontFamily !== undefined) css.fontFamily = accent.fontFamily;
    if (accent.fontScale !== undefined) css.fontSize = `${accent.fontScale}em`;
    if (accent.color !== undefined) css.color = accent.color;
    if (accent.fontStyle !== undefined) css.fontStyle = accent.fontStyle;
  }

  let scale = motion.scale;
  if (emphasis === 'color') {
    css.color = highlightColor;
  } else if (emphasis === 'pop') {
    css.color = highlightColor;
    scale *= highlightScale;
  } else if (emphasis === 'pulse') {
    css.color = highlightColor;
    const phase = (2 * Math.PI * (time - word.start)) / EMPHASIS_PULSE_PERIOD;
    scale *= 1 + ((highlightScale - 1) / 2) * (1 + Math.sin(phase));
  } else if (emphasis === 'karaoke-fill') {
    const span = word.end - word.start;
    const fraction = clamp01(span > 0 ? (time - word.start) / span : 1);
    const base = resolved.textColor ?? '#ffffff';
    const pct = (fraction * 100).toFixed(1);
    css.backgroundImage = `linear-gradient(90deg, ${highlightColor} ${pct}%, ${base} ${pct}%)`;
    css.backgroundClip = 'text';
    css.WebkitBackgroundClip = 'text';
    css.color = 'transparent';
  } else if (emphasis === 'background') {
    css.color = highlightColor;
    css.backgroundColor = highlight?.background ?? DEFAULT_HIGHLIGHT_COLOR;
    css.borderRadius = '0.15em';
    css.padding = '0.05em 0.18em';
  } else if (emphasis === 'glow') {
    css.color = highlightColor;
    css.textShadow = `0 0 0.25em ${highlightColor}, 0 0 0.5em ${highlightColor}`;
  } else if (emphasis === 'underline') {
    css.color = highlightColor;
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
