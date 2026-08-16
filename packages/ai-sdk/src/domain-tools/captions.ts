/**
 * Caption tools — the family that most clearly is not a kind.
 *
 * Captions span read and mutate: you read the style catalog, you read back
 * whether the caption track still matches the edit, and you mutate cues and
 * styling. Grouped by kind, those six tools sat in two arrays hundreds of lines
 * apart, which is exactly the drift this split exists to stop — a caption rule
 * changed in one place and missed in the other reads to a user as a bug in
 * captions, not as a bug in "the mutate array".
 *
 * The cue-length ceilings, the style assertion, and the keyword grounding move
 * with the tools, because each has exactly one caller family and a shared-looking
 * constant with one caller is how the next person learns the wrong thing.
 */
import { z } from 'zod/v4';
import { CaptionStyleSchema, type Project, type Track } from '@framepilot/timeline-schema';
import { CAPTION_FONT_CATALOG, getCaptionFont } from '@framepilot/timeline-schema/caption-fonts';
import {
  CAPTION_TEMPLATE_CATALOG,
  getCaptionTemplate,
} from '@framepilot/timeline-schema/caption-templates';
import { buildTimelineMap, mapTranscript } from '@framepilot/editor-core';
import type { ToolSpec } from '../tool-registry.js';
import { DEFAULT_CAPTION_TOLERANCE_SECONDS, verifyCaptions } from '../verify.js';
import { mutateTool, readTool } from './tool-factories.js';
import { filterString, id, numeric, seconds } from './tool-args.js';

/** Compare caption words the way a reader would: case- and punctuation-insensitive. */
const normalizeCaptionWord = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

const MAX_CAPTION_CUE_SECONDS = 10;
const MAX_CAPTION_CUE_WORDS = 12;

function assertKnownCaptionStyle(style: z.infer<typeof CaptionStyleSchema> | null): void {
  if (style === null) return;
  if (style.templateId !== undefined && getCaptionTemplate(style.templateId) === undefined) {
    throw new Error(
      `Unknown caption template "${style.templateId}". Call discover_caption_styles first.`,
    );
  }
  for (const family of [style.fontFamily, style.accent?.fontFamily]) {
    if (family !== undefined && getCaptionFont(family) === undefined) {
      throw new Error(
        `Caption font "${family}" is not bundled. Call discover_caption_styles for fonts that render identically in preview and export.`,
      );
    }
  }
}

function groundedCaptionKeywords(
  track: Track,
  project: Project,
  requested: readonly string[],
): string[] {
  const vocabulary = new Map<string, string>();
  for (const clip of track.clips) {
    for (const word of clip.captionCue?.words ?? []) {
      const key = normalizeCaptionWord(word.word);
      if (key !== '' && !vocabulary.has(key)) vocabulary.set(key, word.word);
    }
    for (const word of clip.captionCue?.text.split(/\s+/) ?? []) {
      const key = normalizeCaptionWord(word);
      if (key !== '' && !vocabulary.has(key)) vocabulary.set(key, word);
    }
  }
  for (const word of project.transcript) {
    const key = normalizeCaptionWord(word.word);
    if (key !== '' && !vocabulary.has(key)) vocabulary.set(key, word.word);
  }
  const grounded = requested.map((word) => {
    const exact = vocabulary.get(normalizeCaptionWord(word));
    if (exact === undefined) {
      throw new Error(
        `Emphasis keyword "${word}" is not present in the caption text or transcript. Read get_mapped_transcript and choose exact spoken words.`,
      );
    }
    return exact.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  });
  return grounded;
}

/**
 * The exact-span delete op for one clip. Clips on a track can never overlap, so a
 * range covering exactly [clip.start, clip.end) removes that clip and nothing
 * else — the id-addressed delete the model cannot fat-finger with hand-computed
 * times. Throws (model-facing message) when the id is unknown: there is no range
 * to build, and the error steers the model to a listing read.
 */
const discoverCaptionStylesSchema = z
  .object({
    // Blank means "no search", not a rejected call: a model that fills the optional
    // field with "" was asking to browse the whole catalog (see `blankToUndefined`).
    query: filterString(),
    category: z
      .enum([
        'one-word',
        'phrase',
        'karaoke',
        'build',
        'boxed',
        'editorial',
        'aesthetic',
        'cinematic',
      ])
      .optional(),
    limit: numeric(z.number().int().positive().max(45)).optional(),
  })
  .strict();

const captionKeywordsSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(12)
  .superRefine((keywords, issue) => {
    const normalized = keywords.map(normalizeCaptionWord);
    if (normalized.some((keyword) => keyword === '')) {
      issue.addIssue({ code: 'custom', message: 'Keywords must contain a letter or number.' });
    }
    if (new Set(normalized).size !== normalized.length) {
      issue.addIssue({ code: 'custom', message: 'Keywords must be unique.' });
    }
  });

const autoEmphasizeCaptionsSchema = z
  .object({
    trackId: z.string(),
    keywords: captionKeywordsSchema,
    style: CaptionStyleSchema.nullable().optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/)
      .optional(),
    fontScale: numeric(z.number().min(1).max(3)).optional(),
  })
  .strict();

/**
 * `recall_evidence` arguments. `evidenceId` is the handle the action log shows next to a
 * read ("[ev_3]"); `query` narrows a large payload to the lines that mention it, so a
 * long transcript can be re-opened around a phrase instead of wholesale.
 */

export const CAPTION_TOOLS: readonly ToolSpec[] = [
  readTool(
    {
      name: 'verify_captions',
      description:
        'Check the caption track against the edited timeline and report what is ' +
        'actually wrong: cues outside the sequence, cues spanning a cut, cues over ' +
        'deleted speech, cues out of sync with the mapped word timings, stale cues from ' +
        'an older timeline revision, and retained speech with no caption. Returns ' +
        '{ ok, cueCount, issues[] }. Run this before saying captions are done — an ' +
        'operation returning "applied" is not evidence that anything is synchronized.',
      capabilities: ['captions'],
    },
    z.object({ toleranceSeconds: seconds.optional() }).strict(),
    (a, ctx) =>
      verifyCaptions(ctx.project, a.toleranceSeconds ?? DEFAULT_CAPTION_TOLERANCE_SECONDS),
  ),
  readTool(
    {
      name: 'discover_caption_styles',
      description:
        'Browse the production caption design system before styling captions. Returns ' +
        'the bundled fonts (with weight ranges) and matching caption templates. Filter ' +
        'templates by category or search label/category/font. Use only returned font ' +
        'families and template ids so preview and export remain identical.',
      capabilities: ['inspect', 'captions'],
    },
    discoverCaptionStylesSchema,
    (a) => {
      const query = a.query?.toLocaleLowerCase();
      let templates = CAPTION_TEMPLATE_CATALOG.filter(
        (template) => a.category === undefined || template.category === a.category,
      );
      if (query !== undefined) {
        templates = templates.filter((template) =>
          [
            template.id,
            template.label,
            template.category,
            /* v8 ignore next 2 -- every catalog template sets both fields; `?? ''` only satisfies the schema's optional typing */
            template.style.fontFamily ?? '',
            template.style.display ?? '',
          ].some((value) => value.toLocaleLowerCase().includes(query)),
        );
      }
      const limited = templates.slice(0, a.limit ?? 20);
      return {
        matched: templates.length,
        returned: limited.length,
        fonts: CAPTION_FONT_CATALOG.map(({ family, category, minWeight, maxWeight }) => ({
          family,
          category,
          minWeight,
          maxWeight,
        })),
        templates: limited.map((template) => ({
          templateId: template.id,
          label: template.label,
          category: template.category,
          suggestedWordsPerLine: template.suggestedWordsPerLine,
          fontFamily: template.style.fontFamily,
          display: template.style.display,
        })),
        compositionFields: [
          'fontFamily',
          'fontWeight',
          'fontStyle',
          'fontScale',
          'textColor',
          'outlineColor',
          'outlineWidth',
          'xPercent',
          'yPercent',
          'rotation',
          'maxWidthPercent',
          'textAlign',
          'lineHeight',
          'safeArea',
          'letterSpacing',
          'background',
          'shadow',
          'animation',
          'accent',
        ],
      };
    },
  ),
  mutateTool(
    {
      name: 'add_caption_layer',
      description:
        'Add ONE short transcript-driven caption cue on a track over a timeline range ' +
        '(start/end seconds). Never use one call for a whole recording or song: first ' +
        'read get_mapped_transcript, then add separate readable phrase cues (normally ' +
        '3–7 words, never more than 12). Style the completed set track-wide.',
    },
    z.object({ trackId: z.string(), start: seconds, end: seconds }).strict(),
    (a, ctx) => {
      const duration = a.end - a.start;
      const mapped = mapTranscript(buildTimelineMap(ctx.project.timeline), ctx.project.transcript);
      const mappedWords = mapped.words.filter((word) => word.start < a.end && word.end > a.start);
      if (duration > MAX_CAPTION_CUE_SECONDS || mappedWords.length > MAX_CAPTION_CUE_WORDS) {
        throw new Error(
          `add_caption_layer creates one readable cue, but ${a.start}s–${a.end}s spans ${+duration.toFixed(3)}s and ${mappedWords.length} mapped words. Split it into separate 3–7 word phrase cues; never use one layer for a whole recording or song.`,
        );
      }
      const clipIds = new Set(mappedWords.map((word) => word.clipId));
      if (clipIds.size > 1) {
        throw new Error(
          `add_caption_layer cannot cross an edit boundary (${a.start}s–${a.end}s contains words from ${clipIds.size} clips). Split the cue at the cut.`,
        );
      }

      const clipId = id('caption', a.trackId, a.start);
      const first = mappedWords[0];
      const last = mappedWords[mappedWords.length - 1];
      return [
        {
          type: 'add_caption_layer' as const,
          trackId: a.trackId,
          start: a.start,
          end: a.end,
          clipId,
        },
        {
          type: 'set_caption_cue' as const,
          clipId,
          captionCue: {
            text: mappedWords.map((word) => word.word).join(' '),
            words: mappedWords.map(({ word, start, end }) => ({ word, start, end })),
            derivedFromRevision: mapped.revision,
            ...(first !== undefined && last !== undefined
              ? {
                  source: {
                    assetId: first.assetId,
                    clipId: first.clipId,
                    start: first.sourceStart,
                    end: last.sourceEnd,
                  },
                }
              : {}),
          },
        },
      ];
    },
  ),
  mutateTool(
    {
      name: 'set_track_caption_style',
      description:
        'Set the complete shared caption composition for one caption track. This is the ' +
        'AI equivalent of the Captions panel controls: choose a discovered template/font; ' +
        'set font weight/style/scale, colors, outline, xPercent/yPercent placement, rotation, ' +
        'maximum width, alignment, line height, safe area, spacing, padding/background, ' +
        'shadow, animation, and accent behavior. Per-cue set_caption_style overrides still ' +
        'win. Pass captionStyle: null to clear the track default. Call discover_caption_styles ' +
        'first; unbundled fonts and unknown templates are rejected.',
      capabilities: ['edit', 'captions'],
    },
    z.object({ trackId: z.string(), captionStyle: CaptionStyleSchema.nullable() }).strict(),
    (a) => {
      assertKnownCaptionStyle(a.captionStyle);
      return [
        { type: 'set_track_caption_style', trackId: a.trackId, captionStyle: a.captionStyle },
      ];
    },
  ),
  mutateTool(
    {
      name: 'auto_emphasize_captions',
      description:
        'Apply AI-selected semantic emphasis to a caption track as one reversible operation. ' +
        'First read get_mapped_transcript, reason about meaning, emotion, contrast, numbers, ' +
        'delivery and payoff, then submit 1-12 sparse exact spoken keywords. The tool grounds ' +
        'every keyword against the captions/transcript and rejects invented text. Optional ' +
        'style can simultaneously choose a discovered font/template and all composition ' +
        'properties including xPercent/yPercent, size, rotation, width, alignment, spacing, ' +
        'background and animation. Existing track styling is preserved for omitted fields.',
      capabilities: ['edit', 'captions', 'ai'],
    },
    autoEmphasizeCaptionsSchema,
    (a, ctx) => {
      const track = ctx.project.timeline.tracks.find((candidate) => candidate.id === a.trackId);
      if (track === undefined) {
        throw new Error(`Unknown track "${a.trackId}". Use get_timeline to list real ids.`);
      }
      if (track.type !== 'caption') {
        throw new Error(`Track "${a.trackId}" is not a caption track.`);
      }
      assertKnownCaptionStyle(a.style ?? null);
      const keywords = groundedCaptionKeywords(track, ctx.project, a.keywords);
      const captionStyle = {
        ...(track.captionStyle ?? {}),
        ...(a.style ?? {}),
        accent: {
          ...(track.captionStyle?.accent ?? {}),
          ...(a.style?.accent ?? {}),
          mode: 'keywords' as const,
          keywords,
          color:
            a.color ?? a.style?.accent?.color ?? track.captionStyle?.accent?.color ?? '#ffd60a',
          fontScale:
            a.fontScale ??
            a.style?.accent?.fontScale ??
            track.captionStyle?.accent?.fontScale ??
            1.18,
        },
      };
      return [{ type: 'set_track_caption_style', trackId: a.trackId, captionStyle }];
    },
  ),
  mutateTool(
    {
      name: 'set_caption_style',
      description:
        'Override one caption cue after applying the track-wide design. Supports the full ' +
        'composition surface: font/template, weight/style/scale, colors/outline, xPercent/' +
        'yPercent placement, rotation, maximum width, alignment, line height, safe area, ' +
        'letter spacing, background/padding, shadow, highlight, animation and accent. Prefer ' +
        'captionStyle: ' +
        '{ templateId } naming one of the ~45 caption templates — categories: one-word ' +
        '(punchline, beast, impact, stamp), phrase (trio, duo, phrase-pop, duo-gold, ' +
        'phrase-box, phrase-marker), karaoke (karaoke, broadcast, outline, glow, ' +
        'minimal), build (hormozi, slide, bounce, typewriter, ticker), boxed (boxed, ' +
        'tag), editorial (spotlight, headline, whisper), aesthetic (highlighter, pill, ' +
        'ember, retro, caption-bar, pulse, negative, knockout, kinetic, cascade, ' +
        'stacked), cinematic (soft-focus, soft-2, soft-3, soft-4, motion, ' +
        'cinematic-cut, cinetop, real-estate, subtitle-pop). Any explicit field ' +
        '(fontFamily/fontScale/colors/position/display/highlight/animation/accent) ' +
        'overrides the template; call discover_caption_styles and load the caption-design ' +
        'skill for selection guidance. Unbundled fonts and unknown templates are rejected. ' +
        'Pass captionStyle: null to clear styling back to unstyled. Meaningful on ' +
        'caption clips created by add_caption_layer.',
      capabilities: ['edit', 'captions'],
    },
    z.object({ clipId: z.string(), captionStyle: CaptionStyleSchema.nullable() }).strict(),
    (a) => {
      assertKnownCaptionStyle(a.captionStyle);
      return [{ type: 'set_caption_style', clipId: a.clipId, captionStyle: a.captionStyle }];
    },
  ),
];
