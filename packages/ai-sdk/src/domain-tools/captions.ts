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
import {
  buildTimelineMap,
  captionSegmentConfig,
  createLaneAllocator,
  deriveCaptionCues,
  mapTranscript,
  type CaptionSegmentPresetName,
} from '@framepilot/editor-core';
import type { ToolSpec } from '../tool-registry.js';
import { DEFAULT_CAPTION_TOLERANCE_SECONDS, verifyCaptions } from '../verify.js';
import { mutateTool, readTool } from './tool-factories.js';
import { filterString, id, numeric, seconds } from './tool-args.js';

/**
 * The caption tracks this project actually has, appended to a track-not-found message.
 *
 * A wrong track id is almost always a typo on one the model has already read: run
 * `25e06a6f` asked twice for `captains_main` on a project whose only caption track is
 * `captions_main`, was told to "use get_timeline to list real ids", and lost the turn to
 * the round trip. The ids are in hand right here. Naming them is not a guess — no fuzzy
 * matching, just the fact the message was withholding.
 */
function captionTrackIds(project: Project): string {
  const ids = project.timeline.tracks
    .filter((track) => track.type === 'caption')
    .map((track) => track.id);
  if (ids.length === 0) {
    return ' This project has no caption track yet — add_track with type "caption" creates one.';
  }
  return ` The caption track${ids.length === 1 ? '' : 's'} in this project: ${ids.join(', ')}.`;
}

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

/** Split a keyword into the bare tokens it must match consecutively. */
const keywordTokens = (keyword: string): string[] =>
  keyword
    .split(/\s+/)
    .map(normalizeCaptionWord)
    .filter((token) => token !== '');

/**
 * Ground each requested emphasis keyword against what is actually spoken.
 *
 * A keyword may be a PHRASE. The renderers accent the whole run of consecutive
 * words that speaks one (see `accentRunIndices` / `_accent_indices`), so this
 * check has to ground it the same way: as a consecutive token sequence over the
 * spoken word ORDER, not as a lookup in a bag of single words. Grounding against
 * a bag is what rejected "stop scrolling" — a phrase the editor plainly says —
 * and sent the model into a retry loop against a rule it could not satisfy.
 */
function groundedCaptionKeywords(
  track: Track,
  project: Project,
  requested: readonly string[],
): string[] {
  // Every ordered run of spoken words a phrase could match: each caption cue's
  // own words and text, plus the project transcript. Kept as separate sequences
  // so a phrase can never match across the seam between two of them.
  const sequences: string[][] = [];
  for (const clip of track.clips) {
    const cue = clip.captionCue;
    if (cue === undefined) continue;
    sequences.push(cue.words.map((word) => word.word));
    sequences.push(cue.text.split(/\s+/));
  }
  sequences.push(project.transcript.map((word) => word.word));

  const bared = sequences.map((sequence) => sequence.map(normalizeCaptionWord));

  return requested.map((keyword) => {
    const phrase = keywordTokens(keyword);
    const found = phrase.length > 0 && bared.some((tokens) => containsRun(tokens, phrase));
    if (!found) {
      throw new Error(
        `Emphasis keyword "${keyword}" is not present in the caption text or transcript. Read get_mapped_transcript and choose exact spoken words — a multi-word keyword must be spoken as consecutive words.`,
      );
    }
    // Store the bare token sequence: it is exactly what both renderers compare
    // against, so what is persisted cannot drift from what is highlighted.
    return phrase.join(' ');
  });
}

/** Does `tokens` contain `phrase` as a consecutive run? */
function containsRun(tokens: readonly string[], phrase: readonly string[]): boolean {
  for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
    if (phrase.every((part, offset) => tokens[i + offset] === part)) return true;
  }
  return false;
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
    // Capped at the catalog size, not below it. The old ceiling of 45 against a
    // 51-template catalog meant NO call could return the whole thing, and the default of
    // 20 hid the rest — a run that needed the template already applied to the project
    // (`headline`, past the cut) could not name it or pick a deliberate alternative, and
    // `set_track_caption_style` rejects an id that never appeared in a result.
    limit: numeric(z.number().int().positive().max(CAPTION_TEMPLATE_CATALOG.length)).optional(),
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
        'actually wrong: cues outside the sequence, cues over deleted speech or a gap, ' +
        'cues out of sync with the mapped word timings, cues whose words a later edit ' +
        'replaced, cues bridging a break in the SPEECH (two stretches of audio never ' +
        'spoken in one breath), and retained speech with no caption. A cue sitting over ' +
        'several picture cuts is fine and is not reported — only an audio discontinuity ' +
        'is. Returns { ok, cueCount, issues[] }. Run this before saying captions are ' +
        'done: an operation returning "applied" is not evidence that anything is ' +
        'synchronized. Repair whatever it reports by re-running caption_the_edit, which ' +
        're-derives every cue from the current timeline in one call — do not delete and ' +
        're-add cues one at a time. It checks TIMING only — it cannot see whether a cue ' +
        'is legible, clipped by the frame edge, or sitting on a face.',
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
      // Default to the whole matching set: the ids ARE the deliverable, the digest
      // renders them grouped by category (a few compact lines), and the full payload
      // stays retrievable by handle. A partial catalog by default is what made the
      // model reason about templates it had never been shown.
      const limited = templates.slice(0, a.limit ?? CAPTION_TEMPLATE_CATALOG.length);
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
      name: 'caption_the_edit',
      description:
        'Caption the WHOLE edit in one call. Reads the mapped transcript, segments the ' +
        'retained speech into readable phrase cues at linguistic breaks, and writes every ' +
        'cue on the track — replacing whatever cues are already there. This is the tool to ' +
        'use for "add captions"; it is also how you REPAIR captions that verify_captions ' +
        'reports as stale or out of sync after a cut, because re-running it re-derives every ' +
        'cue from the current timeline. That re-run is local and free. Words in deleted footage are dropped and no cue can ' +
        'span a cut, so it cannot produce the errors hand-placed cues do. preset picks the ' +
        'register: short-form (default, punchy 1-2 lines), subtitle (broadcast, longer ' +
        'reading lines), one-word (one word per cue, for the one-word template family). ' +
        'Style the finished track with set_track_caption_style and emphasise with ' +
        'auto_emphasize_captions. Requires a transcript — run transcribe first.',
      capabilities: ['edit', 'captions'],
      // Not mirrored into the Python sidecar registry. Where a caption cue breaks
      // is a linguistic decision and `segmentCaptions` is deliberately its single
      // authority (ADR 0071); a Python re-implementation would disagree with it
      // word by word, which is the drift the caption parity contract exists to
      // prevent. Registering a spec the sidecar dispatcher could never honour is,
      // per that parity test, the inverse of the gap it closes — so the flag that
      // means "resolved outside the sidecar" is the honest one.
      //
      // This tool is NOT UI-dependent, though, so MCP still serves it — see
      // `UI_INDEPENDENT_HOST_TOOLS` in packages/mcp-server.
      hostUiOnly: true,
      // One `delete_range` per existing cue, two operations per new one — and the cue
      // count is a fact about the transcript, not something the model chose. See
      // `ToolSpec.derivedFanOut`.
      derivedFanOut: true,
    },
    z
      .object({
        trackId: z.string(),
        preset: z.enum(['short-form', 'subtitle', 'one-word']).optional(),
        maxWordsPerCue: numeric(z.number().int().min(1).max(MAX_CAPTION_CUE_WORDS)).optional(),
      })
      .strict(),
    (a, ctx) => {
      const track = ctx.project.timeline.tracks.find((candidate) => candidate.id === a.trackId);
      if (track === undefined) {
        throw new Error(`Unknown track "${a.trackId}".${captionTrackIds(ctx.project)}`);
      }
      if (track.type !== 'caption') {
        throw new Error(
          `Track "${a.trackId}" is not a caption track.${captionTrackIds(ctx.project)}`,
        );
      }
      if (ctx.project.transcript.length === 0) {
        throw new Error(
          'This project has no transcript yet, so there is no speech to caption. Run transcribe first.',
        );
      }

      const config = captionSegmentConfig(
        (a.preset ?? 'short-form') as CaptionSegmentPresetName,
        a.maxWordsPerCue === undefined ? {} : { maxWordsPerCue: a.maxWordsPerCue },
      );
      const cues = deriveCaptionCues(
        buildTimelineMap(ctx.project.timeline),
        ctx.project.transcript,
        config,
        ctx.project.fps,
      );
      if (cues.length === 0 && track.clips.length === 0) {
        throw new Error(
          'No speech survives on the timeline to caption. Check the transcript covers the footage that is still in the edit.',
        );
      }

      // Clear first, in the same patch, so one undo restores the previous
      // captions. Back-to-front so each delete_range names a range that is still
      // present in the timeline the validator replays against.
      const clears = [...track.clips]
        .sort((left, right) => right.start - left.start)
        .map((clip) => ({
          type: 'delete_range' as const,
          trackId: a.trackId,
          start: clip.start,
          end: clip.end,
        }));

      return [
        ...clears,
        ...cues.flatMap((cue) => {
          // Ids embed the cue start in ms: stable across re-runs of the same
          // transcript, and unique within one.
          const clipId = `caption_${a.trackId}_${Math.round(cue.start * 1000)}`;
          return [
            {
              type: 'add_caption_layer' as const,
              trackId: a.trackId,
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
      ];
    },
  ),
  mutateTool(
    {
      name: 'add_caption_layer',
      description:
        'Add ONE short transcript-driven caption cue on a track over a timeline range ' +
        '(start/end seconds). To caption a whole recording use caption_the_edit instead — ' +
        'it segments and writes every cue in a single call. Reach for this one only to ' +
        'patch a specific gap by hand: it needs get_mapped_transcript first, and a range ' +
        'longer than one readable phrase (3–7 words, never more than 12) is rejected. ' +
        'If the track you name is already busy over that range the cue is placed on ' +
        'another free caption track, or a new one carrying the same style. ' +
        'Style the completed set track-wide.',
    },
    z.object({ trackId: z.string(), start: seconds, end: seconds }).strict(),
    (a, ctx) => {
      const duration = a.end - a.start;
      const mapped = mapTranscript(buildTimelineMap(ctx.project.timeline), ctx.project.transcript);
      const mappedWords = mapped.words.filter((word) => word.start < a.end && word.end > a.start);
      if (duration > MAX_CAPTION_CUE_SECONDS || mappedWords.length > MAX_CAPTION_CUE_WORDS) {
        throw new Error(
          `add_caption_layer creates one readable cue, but ${a.start}s–${a.end}s spans ${+duration.toFixed(3)}s and ${mappedWords.length} mapped words. To caption a stretch this long call caption_the_edit, which segments the whole edit in one call; to place this cue by hand, split it into separate 3–7 word phrases.`,
        );
      }
      const clipIds = new Set(mappedWords.map((word) => word.clipId));
      if (clipIds.size > 1) {
        throw new Error(
          `add_caption_layer cannot cross an edit boundary (${a.start}s–${a.end}s contains words from ${clipIds.size} clips). Split the cue at the cut, or call caption_the_edit, which never places a cue across one.`,
        );
      }

      // Cues are clips, so they cannot overlap on one lane either. A cue that
      // collides used to take the patch down with the validator's overlap error;
      // it now lands on another caption lane, or a new one, in the same patch.
      //
      // A relocated cue must keep the project's caption LOOK. Style resolves
      // clip override → track default → catalog, so a cue moved to a fresh lane
      // would silently render in the catalog default while every other cue on the
      // original lane kept the project style — one odd-looking caption, and a
      // later `set_track_caption_style` reaching only one of the two lanes. The
      // source lane's default is copied onto any lane this opens.
      const timeline = ctx.project.timeline;
      const sourceTrack = timeline.tracks.find((t) => t.id === a.trackId);
      const placed = createLaneAllocator(timeline).allocate(a.trackId, a.start, a.end);
      // Whenever the cue MOVED, not only when a lane was created. An existing free
      // caption lane can carry a different style (or none), which would render this
      // one cue in a different look — exactly the "one odd-looking caption" this
      // guard exists to prevent, and what the tool description promises against.
      const relocated = placed.trackId !== a.trackId;
      const inheritedStyle =
        relocated && sourceTrack?.captionStyle !== undefined
          ? [
              {
                type: 'set_track_caption_style' as const,
                trackId: placed.trackId,
                captionStyle: sourceTrack.captionStyle,
              },
            ]
          : [];
      const clipId = id('caption', placed.trackId, a.start);
      const first = mappedWords[0];
      const last = mappedWords[mappedWords.length - 1];
      return [
        ...placed.setupOps,
        ...inheritedStyle,
        {
          type: 'add_caption_layer' as const,
          trackId: placed.trackId,
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
        'delivery and payoff, then submit 1-12 sparse exact spoken keywords. A keyword may be ' +
        'a phrase ("stop scrolling"), which emphasises the whole run of words that speaks it. ' +
        'The tool grounds every keyword against the captions/transcript and rejects invented ' +
        'text; a phrase must be spoken as consecutive words. Existing ' +
        'track styling is preserved; change the design itself with set_track_caption_style.',
      capabilities: ['edit', 'captions', 'ai'],
    },
    autoEmphasizeCaptionsSchema,
    (a, ctx) => {
      const track = ctx.project.timeline.tracks.find((candidate) => candidate.id === a.trackId);
      if (track === undefined) {
        throw new Error(`Unknown track "${a.trackId}".${captionTrackIds(ctx.project)}`);
      }
      if (track.type !== 'caption') {
        throw new Error(
          `Track "${a.trackId}" is not a caption track.${captionTrackIds(ctx.project)}`,
        );
      }
      const keywords = groundedCaptionKeywords(track, ctx.project, a.keywords);
      const captionStyle = {
        ...(track.captionStyle ?? {}),
        accent: {
          ...(track.captionStyle?.accent ?? {}),
          mode: 'keywords' as const,
          keywords,
          color: a.color ?? track.captionStyle?.accent?.color ?? '#ffd60a',
          fontScale: a.fontScale ?? track.captionStyle?.accent?.fontScale ?? 1.18,
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
        'captionStyle: { templateId } naming a template from discover_caption_styles (it ' +
        'lists every template with its category); any explicit field overrides the ' +
        'template. Load the caption-design skill for selection guidance. Unbundled fonts ' +
        'and unknown templates are rejected. ' +
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
