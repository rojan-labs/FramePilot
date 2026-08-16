/**
 * Caption generation and transcript helpers for the editor UI.
 *
 * The *segmentation* — deciding where cues begin and end, and what each says —
 * lives in `@framepilot/editor-core` (`captions/segment.ts`), shared with the AI
 * `add_captions` recipe so the two paths cannot disagree (ADR 0071). This module
 * is the thin layer that turns those cues into a reversible patch, plus the small
 * transcript utilities the panels need (active word, keyword highlighting, clock
 * formatting).
 *
 * Caption LOOKS live in the shared template catalog
 * (`@framepilot/timeline-schema/caption-templates`) and persist as
 * `captionStyle.templateId` on the *track* (the set-wide default) with per-cue
 * overrides on the clip — resolution is clip → track → template.
 *
 * Caption TEXT persists on the clip as `captionCue` (schema v11), so it is
 * editable and independent of later transcript changes. Read it back with
 * `resolveCaptionCue` from editor-core — never re-derive it here.
 */
import type { Patch } from '@framepilot/editor-core';
import {
  buildTimelineMap,
  captionSegmentConfig,
  deriveCaptionCues,
  presetForWordsPerLine,
  type CaptionSegmentConfig,
  type CaptionSegmentPresetName,
} from '@framepilot/editor-core';
import type { CaptionStyle, Timeline, TranscriptWord } from '@framepilot/timeline-schema';
import {
  DEFAULT_CAPTION_TEMPLATE_ID,
  getCaptionTemplate,
} from '@framepilot/timeline-schema/caption-templates';

/**
 * Index of the transcript word spoken at time `t` (start ≤ t < end), or `-1`
 * when none is active (e.g. a silent gap or past the end).
 */
export function activeWordIndex(words: readonly TranscriptWord[], t: number): number {
  // Binary search over the time-ordered transcript (H8): this runs on every
  // playback clock tick, so O(log n) matters on an hour-long transcript.
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((words[mid] as TranscriptWord).start <= t) lo = mid + 1;
    else hi = mid;
  }
  const candidate = lo - 1;
  if (candidate < 0) return -1;
  const word = words[candidate] as TranscriptWord;
  return t >= word.start && t < word.end ? candidate : -1;
}

/** Parse a free-form keyword string into a normalized, de-duplicated list. */
export function parseKeywords(input: string): readonly string[] {
  const seen = new Set<string>();
  for (const token of input.split(/[\s,]+/)) {
    const normalized = token.trim().toLowerCase();
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/** A run of caption text, flagged for keyword highlighting. */
export interface HighlightSegment {
  readonly text: string;
  readonly highlight: boolean;
}

/**
 * Fold a token down to its bare letters/digits, lowercased — the shared
 * normalization for anything that compares transcript words as *words* rather
 * than exact strings (keyword highlighting here, whole-word transcript search
 * in `transcriptSearch.ts`), so "Cat," and "cat" match but "cat" never matches
 * inside "category".
 */
export const stripPunctuation = (token: string): string =>
  token.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/** Compact `m:ss` clock, floored to whole seconds (matches the ruler style). */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Split `text` into whitespace-delimited segments, flagging each token that
 * matches one of `keywords` (case-insensitive, punctuation-insensitive).
 */
export function highlightKeywords(
  text: string,
  keywords: readonly string[],
): readonly HighlightSegment[] {
  if (keywords.length === 0) {
    return text ? [{ text, highlight: false }] : [];
  }
  const set = new Set(keywords);
  return text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => ({ text: token, highlight: set.has(stripPunctuation(token)) }));
}

/**
 * Group transcript words into fixed-size runs, for *reading* the transcript in
 * the Transcription panel.
 *
 * NOT for captions. Caption cues come from `segmentCaptions` (editor-core),
 * which breaks on sentences, clauses, pauses, and reading speed. This is the
 * plain "give me N words a line so a wall of text is scannable" chunker, which
 * is all a transcript reader needs — and keeping it here, clearly labelled,
 * prevents it from drifting back into the caption path.
 */
export function groupTranscriptIntoReadableLines(
  words: readonly TranscriptWord[],
  wordsPerLine: number,
): readonly {
  readonly text: string;
  readonly start: number;
  readonly words: readonly TranscriptWord[];
}[] {
  const size = Math.max(1, Math.floor(wordsPerLine));
  const lines: { text: string; start: number; words: readonly TranscriptWord[] }[] = [];
  for (let i = 0; i < words.length; i += size) {
    const group = words.slice(i, i + size);
    // group is non-empty: i < words.length and size ≥ 1.
    lines.push({
      text: group.map((w) => w.word).join(' '),
      start: (group[0] as TranscriptWord).start,
      words: group,
    });
  }
  return lines;
}

/** PatchId is a branded string; cast at the construction boundary. */
const patchId = (raw: string): Patch['patchId'] => raw as Patch['patchId'];

/** How caption generation should be configured for a given template + tuning. */
export interface CaptionGenerationOptions {
  /** Caption template catalog id — the look the whole track adopts. */
  readonly templateId?: string;
  /** Segmentation preset; defaults to whatever the template's grouping implies. */
  readonly preset?: CaptionSegmentPresetName;
  /** Per-field segmentation overrides (from the panel's advanced controls). */
  readonly overrides?: Partial<CaptionSegmentConfig>;
  /** Words emphasised via `accent.mode: 'keywords'`, persisted on the track style. */
  readonly keywords?: readonly string[];
}

/**
 * Build a keyword accent that is visibly distinct in both renderers.
 *
 * Caption style nesting is intentionally field-level: an explicit `accent`
 * replaces the template accent instead of deep-merging it. Persisting only
 * `{ mode, keywords }` therefore selected the right words but gave them no
 * different pixels. Carry the template's accent treatment when it has one,
 * otherwise use the shared caption highlight color and a restrained scale.
 */
export function keywordAccentStyle(
  templateId: string,
  keywords: readonly string[],
): NonNullable<CaptionStyle['accent']> | undefined {
  if (keywords.length === 0) return undefined;
  const template = getCaptionTemplate(templateId);
  const templateAccent = template?.style.accent;
  const { mode: _mode, keywords: _keywords, ...appearance } = templateAccent ?? {
    mode: 'none' as const,
  };
  return {
    ...appearance,
    mode: 'keywords',
    keywords: [...keywords],
    color: appearance.color ?? '#ffd60a',
    fontScale: appearance.fontScale ?? 1.18,
  };
}

/**
 * The segmentation config generation will use — exported so the panel can show a
 * live preview of the cues it is about to produce with the exact same settings.
 */
export function resolveGenerationConfig(
  options: CaptionGenerationOptions = {},
): CaptionSegmentConfig {
  const template = getCaptionTemplate(options.templateId ?? DEFAULT_CAPTION_TEMPLATE_ID);
  const preset = options.preset ?? presetForWordsPerLine(template?.suggestedWordsPerLine ?? 4);
  return captionSegmentConfig(preset, {
    ...options.overrides,
    emphasisWords: options.keywords ?? options.overrides?.emphasisWords ?? [],
  });
}

/**
 * Build one reversible patch that replaces the caption track's contents with
 * cues derived from `transcript` **against the edited timeline**.
 *
 * The v12 change is which timebase the cues land in. This function used to hand
 * the raw transcript to the segmenter and write the resulting times straight
 * onto the track — correct only for a single untrimmed clip at t=0, and wrong
 * from the first cut onward for every real edit. `timeline` was passed in but
 * read only to find the clips to clear. Now it drives the mapping: words in
 * deleted footage are dropped, survivors are moved to where their footage
 * actually plays, and no cue may span a cut (ADR 0076).
 *
 * Three further things differ from the pre-v11 generator, all of them things an
 * editor hits immediately:
 *
 * 1. **It replaces rather than appends.** The old generator used clip ids derived
 *    from an index (`caption_<track>_<n>`), so pressing Generate twice collided
 *    on every id. Existing caption clips are deleted in the same patch, making
 *    "Generate" idempotent and re-runnable after a transcript change.
 * 2. **Style is set once on the track**, not stamped per cue — so a 400-cue
 *    project is one style operation, and changing the look later stays one
 *    operation (schema v11).
 * 3. **Each cue carries its own text** (`set_caption_cue`), so the caption is
 *    editable and survives later transcript edits.
 *
 * Clip ids embed the cue's start time in milliseconds, so they are stable across
 * regenerations of the same transcript and never collide within one.
 *
 * @returns A single patch (one undo removes everything), or `null` when there is
 *   nothing to caption and nothing to clear.
 */
export function generateCaptionsPatch(
  timeline: Timeline,
  transcript: readonly TranscriptWord[],
  captionTrackId: string,
  options: CaptionGenerationOptions = {},
): Patch | null {
  const templateId = options.templateId ?? DEFAULT_CAPTION_TEMPLATE_ID;
  const config = resolveGenerationConfig(options);
  const map = buildTimelineMap(timeline);
  const cues = deriveCaptionCues(map, transcript, config);

  const track = timeline.tracks.find((candidate) => candidate.id === captionTrackId);
  const existing = track?.clips ?? [];
  if (cues.length === 0 && existing.length === 0) return null;

  // Clear first, in the same patch, so one undo restores the previous captions.
  // Deleted back-to-front so each delete_range refers to a range that is still
  // present in the working timeline the validator replays against.
  const clears = [...existing]
    .sort((a, b) => b.start - a.start)
    .map((clip) => ({
      type: 'delete_range' as const,
      trackId: captionTrackId,
      start: clip.start,
      end: clip.end,
    }));

  const keywords = options.keywords ?? [];
  const accent = keywordAccentStyle(templateId, keywords);
  const trackStyle = {
    templateId,
    // Persist the keyword list so `accent.mode: 'keywords'` actually renders —
    // in v10 the editor's chips were preview-only and never reached an export.
    ...(accent ? { accent } : {}),
  };

  return {
    patchId: patchId(`captions_${captionTrackId}_${cues.length}`),
    createdBy: 'user',
    reason:
      cues.length === 0
        ? `Clear captions on ${captionTrackId}`
        : `Generate ${cues.length} caption${cues.length === 1 ? '' : 's'} on ${captionTrackId}`,
    operations: [
      ...clears,
      { type: 'set_track_caption_style', trackId: captionTrackId, captionStyle: trackStyle },
      ...cues.flatMap((cue) => {
        const clipId = `caption_${captionTrackId}_${Math.round(cue.start * 1000)}`;
        return [
          {
            type: 'add_caption_layer' as const,
            trackId: captionTrackId,
            start: cue.start,
            end: cue.end,
            clipId,
          },
          {
            type: 'set_caption_cue' as const,
            clipId,
            captionCue: {
              text: cue.text,
              words: [...cue.words],
              // Provenance: which timing this cue was computed against, and
              // which footage it captions. Without it a later edit can only be
              // *assumed* not to have invalidated the cue (ADR 0076).
              derivedFromRevision: cue.revision,
              source: {
                assetId: cue.assetId,
                clipId: cue.clipId,
                start: cue.sourceStart,
                end: cue.sourceEnd,
              },
            },
          },
        ];
      }),
    ],
  };
}
