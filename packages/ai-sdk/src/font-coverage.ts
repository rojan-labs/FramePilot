/**
 * @framepilot/ai-sdk/font-coverage — warn when a caption or title font cannot draw its words.
 *
 * ## Why
 *
 * Neither renderer substitutes another face glyph by glyph in the export: a letter the font
 * lacks is drawn as a missing-glyph box (Pillow draws the font's `.notdef`), whatever the
 * browser preview shows by falling back. Desktop run `001be135` captioned a Hindi narration in
 * Poppins (which has Devanagari) with "Bebas Neue" as the accent font (which does not), so every
 * accented word was a row of boxes in the export — and the run spent five restyles trying to
 * make a second font show, with nothing telling it why.
 *
 * The catalog now records which scripts each bundled family covers (measured from the files;
 * `timeline-schema/caption-fonts.ts`). This module compares that with the scripts of the text
 * each font will actually draw and says what is missing, naming every bundled family that has
 * the script. It warns; it never refuses and never picks a font — that stays the model's call.
 */
import type { CaptionStyle, Clip, Project, Track } from '@framepilot/timeline-schema';
import {
  captionFontsWithScript,
  captionScriptsIn,
  getCaptionFont,
  type CaptionFontScript,
} from '@framepilot/timeline-schema/caption-fonts';
import { parseTextOverlayTypography } from '@framepilot/timeline-schema/text-overlay-styles';
import { resolveCaptionStyle } from './caption-style-resolve.js';

/** What a script is called in a sentence the model reads. */
const SCRIPT_LABELS: Readonly<Record<CaptionFontScript, string>> = {
  latin: 'Latin',
  'latin-ext': 'extended Latin (Central European/Turkish)',
  cyrillic: 'Cyrillic',
  greek: 'Greek',
  devanagari: 'Devanagari',
  bengali: 'Bengali',
  arabic: 'Arabic',
  hebrew: 'Hebrew',
  thai: 'Thai',
  cjk: 'Chinese/Japanese',
};

/** Bundled families named per missing script before the rest are counted. */
const MAX_ALTERNATIVES_NAMED = 8;

/** Sample words quoted per gap. */
const MAX_SAMPLE_WORDS = 3;

/** One font and the words it will draw, with the role it plays ("accent font", "font"). */
export interface FontDrawing {
  readonly family: string;
  readonly role: string;
  readonly words: readonly string[];
}

/**
 * Fold a token the way both caption renderers do before matching an accent keyword
 * (`captionPreview.ts#bareToken`, `captions.py#_bare_token`).
 */
const bareToken = (token: string): string =>
  token
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, '');

/**
 * The tokens of a cue its accent draws — the renderers' `accentWordIndices` / `_accent_indices`
 * selection: every run of tokens that speaks a keyword phrase, or the one last/longest token.
 */
function accentedIndices(tokens: readonly string[], accent: CaptionStyle['accent']): Set<number> {
  const picked = new Set<number>();
  if (accent === undefined || tokens.length === 0) return picked;
  if (accent.mode === 'last-word') picked.add(tokens.length - 1);
  if (accent.mode === 'longest-word') {
    let best = 0;
    tokens.forEach((token, index) => {
      if (token.length > tokens[best]!.length) best = index;
    });
    picked.add(best);
  }
  if (accent.mode === 'keywords') {
    const bare = tokens.map(bareToken);
    for (const keyword of accent.keywords ?? []) {
      const phrase = keyword.split(/\s+/).map(bareToken).filter(Boolean);
      if (phrase.length === 0) continue;
      for (let start = 0; start + phrase.length <= bare.length; start += 1) {
        if (!phrase.every((part, offset) => bare[start + offset] === part)) continue;
        for (let offset = 0; offset < phrase.length; offset += 1) picked.add(start + offset);
      }
    }
  }
  return picked;
}

/** What each font of one caption cue draws: its accent font the accented words, its font the rest. */
function cueDrawings(clip: Clip, track: Track | undefined): FontDrawing[] {
  const text = clip.captionCue?.text;
  if (text === undefined) return [];
  const style = resolveCaptionStyle(clip, track);
  const tokens = text.split(/\s+/).filter(Boolean);
  const base = style?.fontFamily;
  const accentFamily = style?.accent?.fontFamily;
  const accented =
    accentFamily === undefined ? new Set<number>() : accentedIndices(tokens, style?.accent);
  const drawings: FontDrawing[] = [];
  if (base !== undefined) {
    drawings.push({ family: base, role: 'font', words: tokens.filter((_, i) => !accented.has(i)) });
  }
  if (accentFamily !== undefined && accented.size > 0) {
    drawings.push({
      family: accentFamily,
      role: 'accent font',
      words: tokens.filter((_, i) => accented.has(i)),
    });
  }
  return drawings;
}

/** Drawings with the same family and role folded together. */
function merged(drawings: readonly FontDrawing[]): FontDrawing[] {
  const byKey = new Map<string, { family: string; role: string; words: string[] }>();
  for (const drawing of drawings) {
    const key = `${drawing.role}\u0000${drawing.family}`;
    const entry = byKey.get(key);
    if (entry === undefined) byKey.set(key, { ...drawing, words: [...drawing.words] });
    else entry.words.push(...drawing.words);
  }
  return [...byKey.values()];
}

/** The bundled families that can draw `script`, as a clause. */
function alternatives(script: CaptionFontScript): string {
  const families = captionFontsWithScript(script);
  const label = SCRIPT_LABELS[script];
  if (families.length === 0) {
    return `No bundled font has ${label}, so these words cannot be drawn in the export in any caption font.`;
  }
  const named = families.slice(0, MAX_ALTERNATIVES_NAMED).join(', ');
  const rest = families.length - MAX_ALTERNATIVES_NAMED;
  return (
    `Bundled fonts with ${label}: ${named}` +
    (rest > 0
      ? `, and ${String(rest)} more (discover_caption_styles lists each font's scripts).`
      : '.')
  );
}

/**
 * The warning for every font in `drawings` that lacks a script its words are written in, or
 * `''` when every font can draw what it is given. A family not in the bundled catalog is not
 * judged here (the style tools refuse one).
 *
 * @param drawings - Each font and the words it draws.
 * @param where - What the words are, for the sentence ("on this track", "in this title").
 */
export function scriptCoverageWarning(drawings: readonly FontDrawing[], where: string): string {
  const sentences: string[] = [];
  for (const drawing of merged(drawings)) {
    const font = getCaptionFont(drawing.family);
    if (font === undefined) continue;
    for (const script of captionScriptsIn(drawing.words.join(' '))) {
      if (font.scripts.includes(script)) continue;
      const inScript = drawing.words.filter((word) => captionScriptsIn(word).includes(script));
      const samples = [...new Set(inScript)].slice(0, MAX_SAMPLE_WORDS).map((w) => `"${w}"`);
      const label = SCRIPT_LABELS[script];
      sentences.push(
        `WARNING: the ${drawing.role} "${drawing.family}" has no ${label} glyphs, and ` +
          `${String(inScript.length)} word${inScript.length === 1 ? '' : 's'} it draws ${where} ` +
          `${inScript.length === 1 ? 'is' : 'are'} ${label} (${samples.join(', ')}): the export ` +
          'cannot draw them in that font and shows missing-glyph boxes, whatever the preview ' +
          `shows. ${alternatives(script)}`,
      );
    }
  }
  return sentences.length === 0 ? '' : ` — ${sentences.join(' ')}`;
}

/**
 * The script warning for a whole caption track, read from the applied project: every cue's
 * text against the font and accent font it resolves to (its own style over the track's over
 * the template's). `''` for an unknown track or when every font can draw its words.
 */
export function captionTrackFontNote(project: Project, trackId: unknown): string {
  if (typeof trackId !== 'string') return '';
  const track = project.timeline.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) return '';
  return scriptCoverageWarning(
    track.clips.flatMap((clip) => cueDrawings(clip, track)),
    'on this track',
  );
}

/** The script warning for one caption cue (its own override included). */
function captionCueFontNote(project: Project, clipId: unknown): string {
  if (typeof clipId !== 'string') return '';
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip !== undefined) return scriptCoverageWarning(cueDrawings(clip, track), 'in this cue');
  }
  return '';
}

/**
 * What each font of a text overlay draws: a lockup's lines in their own faces (paragraph `i`
 * in `typography.lines[i]`'s family, else the overlay's), otherwise the whole text in the
 * overlay's family. An overlay with no family named is drawn in the renderers' default face,
 * which this does not judge.
 */
function overlayDrawings(clip: Clip): FontDrawing[] {
  const params = clip.effects.find((effect) => effect.type === 'text')?.params as
    Record<string, unknown> | undefined;
  if (params === undefined || typeof params.text !== 'string') return [];
  const base = typeof params.fontFamily === 'string' ? params.fontFamily : undefined;
  const lines = parseTextOverlayTypography(params.typography)?.lines ?? [];
  const paragraphs = lines.length > 0 ? params.text.split('\n') : [params.text];
  return paragraphs.flatMap((paragraph, index) => {
    const family = lines[index]?.fontFamily ?? base;
    if (family === undefined) return [];
    return [{ family, role: 'font', words: paragraph.split(/\s+/).filter(Boolean) }];
  });
}

function textOverlayFontNote(clips: readonly Clip[]): string {
  return scriptCoverageWarning(clips.flatMap(overlayDrawings), 'in this title');
}

/** The text overlays `add_text_layer` just placed: its words, at its start (on whichever lane). */
function placedOverlays(project: Project, args: Record<string, unknown>): Clip[] {
  if (typeof args.text !== 'string' || typeof args.start !== 'number') return [];
  const frame = project.fps > 0 ? 1 / project.fps : 1 / 30;
  const start = args.start;
  return project.timeline.tracks.flatMap((track) =>
    track.clips.filter(
      (clip) =>
        Math.abs(clip.start - start) <= frame + 1e-6 &&
        clip.effects.some((effect) => effect.type === 'text' && effect.params.text === args.text),
    ),
  );
}

/**
 * The script warning for a styling call that `trackStyleNote`/`emphasisCoverageNote` do not
 * already carry — a caption cue override, a re-caption under the track's existing look, a new
 * or restyled title — read from the APPLIED project. `''` for any other tool.
 *
 * `set_track_caption_style` and `auto_emphasize_captions` are answered inside those two notes
 * (`caption-style-facts.ts`), so they are not handled here and cannot be warned about twice.
 *
 * @param toolName - The call that produced the operations.
 * @param applied - The project after its patch.
 * @param rawArgs - The call's arguments as the model sent them.
 */
export function fontCoverageNote(toolName: string, applied: Project, rawArgs: unknown): string {
  const args =
    typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
  switch (toolName) {
    case 'caption_the_edit':
      return captionTrackFontNote(applied, args.trackId);
    case 'set_caption_style':
      return captionCueFontNote(applied, args.clipId);
    case 'add_text_layer':
      return textOverlayFontNote(placedOverlays(applied, args));
    case 'set_text_style': {
      const clip = applied.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === args.clipId);
      return clip === undefined ? '' : textOverlayFontNote([clip]);
    }
    default:
      return '';
  }
}
