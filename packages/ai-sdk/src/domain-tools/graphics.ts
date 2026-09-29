/**
 * Graphics tools — effect layers, transitions, and text.
 *
 * One family because they are one question: what goes *on top of*, or *between*,
 * the pictures already on the timeline. Discovery belongs with application —
 * `discover_effects` exists so the model picks a real catalog entry instead of
 * inventing a plausible name, and that guarantee is only as good as its agreement
 * with `apply_effect` sitting beside it.
 */
import { z } from 'zod/v4';
import type { EffectLayer, Project } from '@framepilot/timeline-schema';
import {
  EFFECT_CATALOG,
  EFFECT_CATEGORIES,
  findEffect,
  resolveParams,
  searchEffects,
} from '@framepilot/timeline-schema/effect-catalog';
import { clampParamsForKind, paramsForKind } from '@framepilot/timeline-schema/effect-params';
import {
  TRANSITION_CATALOG,
  TRANSITION_CATEGORIES,
  directionsForTransition as transitionDirectionsFor,
  getTransition,
  resolveTransitionParams,
  searchTransitions,
} from '@framepilot/timeline-schema/transition-catalog';
import { transitionParamsForKind } from '@framepilot/timeline-schema/transition-params';
import { getCaptionFont } from '@framepilot/timeline-schema/caption-fonts';
import {
  TEXT_OVERLAY_STYLE_CATALOG,
  TEXT_OVERLAY_STYLE_CATEGORIES,
  getTextOverlayStyle,
  textOverlayLookParams,
  type TextOverlayStyle,
  type TextOverlayTypography,
} from '@framepilot/timeline-schema/text-overlay-styles';
import {
  createLaneAllocator,
  type Operation,
  syntheticClipKind,
  textEffectId,
  textOverlayClipId,
} from '@framepilot/editor-core';
import { verifyTransitions } from '../verify.js';
import type { ToolSpec } from '../tool-registry.js';
import { mutateTool, noArgs, readTool } from './tool-factories.js';
import { ToolRefusalError } from '../tool-refusal.js';
import type { ToolContext } from '../tool-context.js';
import {
  largestFittingSizePercent,
  overflowingWords,
  typedTitleOf,
  type TitleFont,
} from '../overlay-fit.js';
import { describeTextOverlayLook } from '../text-overlay-style-facts.js';
import {
  TRANSITION_REASONS,
  type CutawayTransitionDecision,
  type TransitionDecision,
  type TransitionReason,
  planCutawayTransitions,
  planTransitions,
} from './transition-planning.js';
import {
  boolean,
  bundledFontFamily,
  cssFontWeight,
  filterString,
  filterStringList,
  id,
  numeric,
  seconds,
} from './tool-args.js';

/**
 * The widest a text box may be widened to in order to keep the size the editor asked for.
 *
 * 100 is the whole frame edge to edge, which leaves a title touching both sides — legible,
 * but it reads as a mistake and any safe-area check will flag it. Stopping short keeps a
 * visible margin, and text that still does not fit comes down in size instead.
 */
const MAX_BOX_WIDTH_PERCENT = 92;

/**
 * Every text overlay style id, as `add_text_layer`'s `style` enum: a style the catalog does not
 * hold is refused by the schema, before any op is built, instead of landing as an overlay whose
 * look nobody chose.
 */
const TEXT_OVERLAY_STYLE_IDS = TEXT_OVERLAY_STYLE_CATALOG.map((style) => style.id) as [
  string,
  ...string[],
];

const TEXT_OVERLAY_STYLE_CATEGORY_IDS = TEXT_OVERLAY_STYLE_CATEGORIES.map(
  (category) => category.id,
) as [string, ...string[]];

/**
 * The text as the renderer sets it. A style that capitalises draws capitals, which are far
 * wider than the lower case the model wrote, so the fit has to measure what is drawn.
 */
function textAsDrawn(text: string, typography: TextOverlayTypography | undefined): string {
  if (typography?.textTransform === 'uppercase') return text.toUpperCase();
  if (typography?.textTransform === 'lowercase') return text.toLowerCase();
  return text;
}

/**
 * The weight a bundled family can actually draw. A family named over a style carries the
 * style's weight with it (a heavy 800 heading, re-set in a single-weight script face), and
 * neither renderer synthesises a weight the file lacks — so the param says what is drawn.
 */
function weightTheFamilyHas(family: unknown, weight: unknown): number | undefined {
  if (typeof weight !== 'number') return undefined;
  const font = typeof family === 'string' ? getCaptionFont(family) : undefined;
  if (font === undefined) return weight;
  return Math.min(font.maxWeight, Math.max(font.minWeight, weight));
}

/**
 * Keep a box that the fit widened inside the frame: a box of width `w` centred at `x` spans
 * `x ± w/2`, and a lower third placed near the left edge would otherwise start off-frame.
 */
function centreKeepingBoxInFrame(xPercent: number, boxWidthPercent: number): number {
  const half = boxWidthPercent / 2;
  return Math.min(100 - half, Math.max(half, xPercent));
}

/** `params` with its `xPercent` moved just enough that a `boxWidthPercent` box stays in frame. */
function withBoxInFrame(
  params: Record<string, unknown>,
  boxWidthPercent: number,
): Record<string, unknown> {
  if (typeof params.xPercent !== 'number') return params;
  return { ...params, xPercent: centreKeepingBoxInFrame(params.xPercent, boxWidthPercent) };
}

/**
 * The params of a new text overlay with its words fitted to the frame (see the handler for
 * why it fits rather than refuses). Returns `params` with `fontSizePercent`,
 * `boxWidthPercent` and `xPercent` adjusted where the words would not fit; unchanged when the
 * size or the box is unknown, since a renderer default is not a value anyone chose.
 *
 * The words are measured as the renderer draws them: a `params.typography` that validates
 * sends the title through the caption rasterizer, which tracks (`letterSpacing`), draws the
 * italic file and wraps inside the chip padding — so the fit reads all of that (#135).
 */
function fitTextOverlayParams(
  text: string,
  params: Readonly<Record<string, unknown>>,
  resolution: { readonly width: number; readonly height: number },
): Record<string, unknown> {
  const askedSize = params.fontSizePercent;
  const askedBox = params.boxWidthPercent;
  if (typeof askedSize !== 'number' || typeof askedBox !== 'number') return { ...params };
  let sizePercent = askedSize;
  let boxWidthPercent = askedBox;
  const typed = typedTitleOf(params.typography, params.background);
  const drawn = textAsDrawn(
    text,
    typed === undefined ? undefined : typographyOf(params.typography),
  );
  const font: TitleFont | undefined =
    typeof params.fontFamily === 'string'
      ? {
          fontFamily: params.fontFamily,
          ...(typeof params.fontWeight === 'number' ? { fontWeight: params.fontWeight } : {}),
        }
      : undefined;
  const fitInput = {
    text: drawn,
    fontFamily: font?.fontFamily,
    fontWeight: font?.fontWeight,
    typography: params.typography,
    background: params.background,
  };
  const over = overflowingWords(
    { ...fitInput, fontSizePercent: sizePercent, boxWidthPercent },
    resolution,
  )[0];
  // Every word fits: nothing to resize — but the box must still sit inside the frame. A
  // style's box is wide (a 76% lower third), `xPercent` is its CENTRE, and harness run 6
  // put three such boxes at x 30–35: each spanned about -3%…73%, so its left-aligned words
  // began off the frame and the safe-area check could only say so afterwards.
  if (over === undefined) return withBoxInFrame({ ...params }, askedBox);
  if (over.requiredBoxWidthPercent <= MAX_BOX_WIDTH_PERCENT) {
    boxWidthPercent = over.requiredBoxWidthPercent;
  }
  // Re-measure rather than trust the widen: `requiredBoxWidthPercent` answers for the widest
  // word, and the box may also have been left where it was. Whatever still overflows comes
  // down in size, against the box as it now stands.
  if (
    overflowingWords({ ...fitInput, fontSizePercent: sizePercent, boxWidthPercent }, resolution)
      .length > 0
  ) {
    const fits = largestFittingSizePercent(drawn, boxWidthPercent, resolution, font, typed);
    if (fits === undefined || fits <= 0) {
      // Not arithmetic this can solve — the text has no measurable width, or the frame has
      // none. That is still worth saying out loud.
      throw new ToolRefusalError(
        `"${over.word}" cannot be fitted in this frame at any size. Shorten the ` +
          'text, or split it across two overlays.',
        { refusalCause: 'text_does_not_fit' },
      );
    }
    sizePercent = fits;
  }
  return {
    ...params,
    fontSizePercent: sizePercent,
    boxWidthPercent,
    ...(typeof params.xPercent === 'number'
      ? { xPercent: centreKeepingBoxInFrame(params.xPercent, boxWidthPercent) }
      : {}),
  };
}

/**
 * The styling args `add_text_layer` takes besides `style`, in the `text` effect's own param
 * names. Each overrides the one field of a style it names.
 */
function authoredTextParams(a: {
  readonly sizePercent?: number | undefined;
  readonly color?: string | undefined;
  readonly background?: string | undefined;
  readonly align?: 'left' | 'center' | 'right' | undefined;
  readonly boxWidthPercent?: number | undefined;
  readonly xPercent?: number | undefined;
  readonly yPercent?: number | undefined;
  readonly fontFamily?: string | undefined;
  readonly fontWeight?: number | undefined;
}): Record<string, unknown> {
  const named: Record<string, unknown> = {
    fontFamily: a.fontFamily,
    fontWeight: a.fontWeight,
    color: a.color,
    fontSizePercent: a.sizePercent,
    align: a.align,
    boxWidthPercent: a.boxWidthPercent,
    xPercent: a.xPercent,
    yPercent: a.yPercent,
    background: a.background,
  };
  return Object.fromEntries(Object.entries(named).filter(([, value]) => value !== undefined));
}

/**
 * A style's look as a restyle applies it: everything but where the overlay sits and how wide
 * it wraps. `applyTextOverlayStylePatch` (the Text panel) keeps those too — restyling should not
 * move an overlay the author placed — so one style id is one look whichever host applied it.
 */
function restyleLookOf(style: TextOverlayStyle): Record<string, unknown> {
  const {
    xPercent: _x,
    yPercent: _y,
    boxWidthPercent: _box,
    ...look
  } = textOverlayLookParams(style.look, style.id);
  return Object.fromEntries(Object.entries(look).filter(([, value]) => value !== undefined));
}

/** A stored `typography` param as the fit reads it; anything else is no typography. */
function typographyOf(value: unknown): TextOverlayTypography | undefined {
  return typeof value === 'object' && value !== null ? (value as TextOverlayTypography) : undefined;
}

/** A style's catalog entry as the model reads it: id, name, group, and what it looks like. */
function styleListing(style: TextOverlayStyle): Record<string, unknown> {
  return {
    styleId: style.id,
    label: style.label,
    category: style.category,
    look: describeTextOverlayLook(style.look),
  };
}

/** The styles a query and an optional category select, matched on every field shown. */
function matchTextOverlayStyles(
  query: string | undefined,
  category: string | undefined,
): TextOverlayStyle[] {
  return TEXT_OVERLAY_STYLE_CATALOG.filter(
    (style) =>
      (category === undefined || style.category === category) &&
      (query === undefined ||
        [style.id, style.label, style.category, describeTextOverlayLook(style.look)].some((value) =>
          value.toLocaleLowerCase().includes(query),
        )),
  );
}

/**
 * The effect lane to apply to: the named one, else the first that exists.
 *
 * Returns `undefined` when there is none, which is the caller's signal to create
 * one. Reusing the first existing lane rather than always creating is what stops
 * a five-effect request from producing five nearly-empty tracks.
 */
const effectTrackOf = (project: Project, preferred?: string): string | undefined => {
  if (preferred !== undefined) {
    const named = project.timeline.tracks.find((t) => t.id === preferred);
    // A named non-effect track is a caller error, surfaced by the validator's
    // `invalid_track` check rather than silently redirected somewhere else.
    if (named !== undefined) return named.id;
  }
  return project.timeline.tracks.find((t) => t.type === 'effect')?.id;
};

/** Overlay text long enough to bury a refusal is trimmed for the sentence, not for the check. */
const clampTitle = (text: string): string =>
  text.length <= 48 ? text : `${text.slice(0, 47).trimEnd()}…`;

const round2 = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * A text overlay already carrying this exact text over a range that overlaps `[start,end)`.
 *
 * Compared on the trimmed, case-folded text and on time overlap rather than on an exact
 * range match: "the same title again, a frame later" is the same mistake as "the same
 * title again", and a viewer cannot tell them apart either. Whitespace differences are not
 * a different title.
 */
function findOverlayWithSameText(
  project: Project,
  text: string,
  start: number,
  end: number,
): { readonly trackId: string; readonly clipId: string } | undefined {
  const wanted = text.trim().replace(/\s+/g, ' ').toLowerCase();
  if (wanted === '') return undefined;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      if (syntheticClipKind(clip.assetId) !== 'text') continue;
      if (!(clip.start < end && clip.end > start)) continue;
      const existing = clip.effects.find((effect) => effect.type === 'text');
      const value = existing?.params['text'];
      if (typeof value !== 'string') continue;
      if (value.trim().replace(/\s+/g, ' ').toLowerCase() === wanted) {
        return { trackId: track.id, clipId: clip.id };
      }
    }
  }
  return undefined;
}

/**
 * The cuts whose transition the editor named, as `add_transition` operations — the catalog
 * entry at its own default length unless a length was named too. An id the catalog does not
 * hold is refused with the way to find a real one, rather than planted and rendered as
 * nothing.
 */
function namedTransitions(
  ctx: ToolContext,
  cuts: readonly {
    readonly fromClipId: string;
    readonly toClipId: string;
    readonly kind?: string | undefined;
    readonly durationSeconds?: number | undefined;
  }[],
): Operation[] {
  return cuts.flatMap((cut) => {
    if (cut.kind === undefined) return [];
    const entry = getTransition(cut.kind);
    if (entry === undefined) {
      throw new ToolRefusalError(
        `add_transitions: "${cut.kind}" is not a transition in the catalog. Call ` +
          'discover_transitions for real ids.',
      );
    }
    const track = ctx.project.timeline.tracks.find((candidate) =>
      candidate.clips.some((clip) => clip.id === cut.fromClipId),
    );
    if (track === undefined) {
      throw new Error(`Clip not found: ${cut.fromClipId}. list_edit_boundaries names every cut.`);
    }
    return [
      {
        type: 'add_transition' as const,
        trackId: track.id,
        fromClipId: cut.fromClipId,
        toClipId: cut.toClipId,
        kind: entry.id,
        durationSeconds: cut.durationSeconds ?? entry.defaultDuration,
      },
    ];
  });
}

/** Arguments `add_transition` resolves a kind and a length from. */
interface SingleTransitionArgs {
  readonly trackId: string;
  readonly fromClipId: string;
  readonly toClipId: string;
  readonly kind?: string | undefined;
  readonly durationSeconds?: number | undefined;
  readonly reason?: TransitionReason | undefined;
}

/**
 * The kind and duration for one cut: whatever the editor named, and the policy for the rest.
 *
 * Four cases, and the refusals are the interesting ones. Nothing at all is a refusal
 * because a transition with neither a kind nor a reason is exactly the guess this tool
 * stopped taking. And a `reason` the policy answers with a hard cut is a refusal too —
 * quietly substituting a dissolve there would make "continuity" mean "cross-dissolve",
 * which is the amateur tell the policy exists to prevent.
 */
function resolveSingleTransition(
  args: SingleTransitionArgs,
  ctx: ToolContext,
): { kind: string; durationSeconds: number } {
  const catalogDefault = args.kind === undefined ? undefined : getTransition(args.kind);
  if (args.reason === undefined) {
    if (args.kind === undefined) {
      throw new ToolRefusalError(
        'add_transition: say why a transition belongs at this cut with `reason` ' +
          `(${TRANSITION_REASONS.join(', ')}) and the kind and length are worked out from ` +
          'the two shots — or name a `kind` yourself if the editor asked for a specific one.',
      );
    }
    return {
      kind: args.kind,
      // The catalog's own default length for that entry, not a number of ours: the entry
      // knows how long it needs to read as itself.
      durationSeconds: args.durationSeconds ?? catalogDefault?.defaultDuration ?? 0.5,
    };
  }

  const [decision] = planTransitions(ctx, {
    trackId: args.trackId,
    reason: args.reason,
    cuts: [{ fromClipId: args.fromClipId, toClipId: args.toClipId, reason: args.reason }],
  });
  if (decision === undefined) {
    throw new ToolRefusalError(
      `add_transition: "${args.fromClipId}" and "${args.toClipId}" are not a cut on track ` +
        `"${args.trackId}" — list_edit_boundaries names every cut the sequence has.`,
    );
  }
  if (decision.choice === null && args.kind === undefined) {
    throw new ToolRefusalError(
      `add_transition: "${args.reason}" at ${String(Math.round(decision.at * 10) / 10)}s is a ` +
        `hard cut — ${decision.why}. Leave it as it is, or name a kind explicitly if the ` +
        'editor asked for one anyway.',
    );
  }
  return {
    kind: args.kind ?? (decision.choice?.kind as string),
    durationSeconds:
      args.durationSeconds ??
      decision.choice?.durationSeconds ??
      catalogDefault?.defaultDuration ??
      0.5,
  };
}

/**
 * Most looks one discover call answers. Run `55bf6774` ("add effects and transitions")
 * spent 5 of 12 model calls — ≈95 s of 212 s — asking the catalogs one or two queries
 * at a time, because each call took exactly one `query` and one `category`. Eight
 * covers every look a single editorial decision weighs without inviting a catalog dump.
 */
const MAX_CATALOG_LOOKS = 8;
/** Entries returned per look when the caller names no `limit`. */
const CATALOG_PAGE_PER_LOOK = 20;
/** The schema's own `limit` ceiling; a default never exceeds what a caller may ask for. */
const CATALOG_PAGE_CEILING = 80;

const catalogBrowseArgs = z
  .object({
    query: filterString(),
    queries: filterStringList(MAX_CATALOG_LOOKS),
    category: filterString(),
    categories: filterStringList(MAX_CATALOG_LOOKS),
    /** Only the shelves a person would see first. */
    shelf: z.enum(['popular', 'recommended']).optional(),
    limit: numeric(z.number().int().positive().max(CATALOG_PAGE_CEILING)).optional(),
  })
  .strict();

type CatalogBrowseArgs = z.infer<typeof catalogBrowseArgs>;

interface BrowsableEntry {
  readonly id: string;
  readonly category: string;
  readonly popular?: boolean;
  readonly recommended?: boolean;
}

/** `single` then `many`, trimmed blanks already gone, exact duplicates dropped in order. */
function looksOf(single: string | undefined, many: readonly string[] | undefined): string[] {
  return [...new Set([...(single === undefined ? [] : [single]), ...(many ?? [])])];
}

/**
 * One browse over a catalog: the union of every query's matches (deduped by id, first
 * seen wins, so a single query reads exactly as it always did), then the union of the
 * categories, then the shelf, then the page.
 */
function browseCatalog<T extends BrowsableEntry>(
  catalog: readonly T[],
  search: (query: string) => readonly T[],
  args: CatalogBrowseArgs,
): {
  readonly results: readonly T[];
  readonly limited: readonly T[];
  readonly asked: { query?: string; queries?: { query: string; matched: number }[] };
} {
  const queries = looksOf(args.query, args.queries);
  const categories = looksOf(args.category, args.categories);
  const perQuery = queries.map((query) => ({ query, matches: search(query) }));

  let results: readonly T[] = catalog;
  if (perQuery.length > 0) {
    const seen = new Set<string>();
    results = perQuery
      .flatMap(({ matches }) => matches)
      .filter((entry) => !seen.has(entry.id) && seen.add(entry.id) !== undefined);
  }
  if (categories.length > 0) results = results.filter((e) => categories.includes(e.category));
  if (args.shelf === 'popular') results = results.filter((e) => e.popular === true);
  if (args.shelf === 'recommended') results = results.filter((e) => e.recommended === true);

  // The default page scales with the number of looks asked for: a batch of four queries
  // capped at the single-look 20 would silently truncate the later looks, and the model
  // would re-ask for them one call at a time — the round trips batching exists to remove.
  // Still capped at the schema ceiling so a batch never dumps the whole catalog.
  const looks = Math.max(1, queries.length, categories.length);
  const limit = args.limit ?? Math.min(CATALOG_PAGE_PER_LOOK * looks, CATALOG_PAGE_CEILING);

  // Echoed so an empty result can say what was asked and how big the catalogue is:
  // run `cc907070` searched "sharpness", "unsharp mask", "sharpen clarity unsharp",
  // "sharpen focus clarity", "clarity", "sharpen" — seven ways of asking for an
  // effect this build does not have — and each answer read "no effects match
  // (0 in catalog)", which says neither. A batch reports each query's own count, so a
  // look the catalog does not have stays visible inside a union that matched plenty.
  const asked =
    perQuery.length === 1
      ? { query: perQuery[0]!.query }
      : perQuery.length > 1
        ? { queries: perQuery.map(({ query, matches }) => ({ query, matched: matches.length })) }
        : {};
  return { results, limited: results.slice(0, limit), asked };
}

export const GRAPHICS_TOOLS: readonly ToolSpec[] = [
  readTool(
    {
      name: 'discover_effects',
      description:
        'Browse the effect catalog. Search by name, tag or use case ("vhs", ' +
        '"teal orange", "censor"), or filter by category. Returns each effect’s ' +
        'id, what it looks like, and its tunable parameters WITH their real ' +
        'ranges and defaults. Call this before apply_effect or adjust_effect — ' +
        'the ids and parameter names are not guessable, and out-of-range values ' +
        'are rejected by the patch validator. Weighing several looks? Pass them ' +
        'all as queries in one call.',
      capabilities: ['inspect', 'effects'],
    },
    catalogBrowseArgs,
    (a) => {
      // Capped by default: the full catalog is 72 entries and dumping every
      // parameter of all of them would spend a large slice of the context window
      // on effects the model is not going to use.
      const { results, limited, asked } = browseCatalog(EFFECT_CATALOG, searchEffects, a);
      return {
        matched: results.length,
        returned: limited.length,
        ...asked,
        total: EFFECT_CATALOG.length,
        categories: EFFECT_CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
        effects: limited.map((effect) => ({
          effectId: effect.id,
          label: effect.label,
          category: effect.category,
          description: effect.description,
          defaultDuration: effect.defaultDuration,
          popular: effect.popular === true,
          recommended: effect.recommended === true,
          // Ranges, not just names: the model needs them to pick a legal value
          // instead of guessing and getting the patch rejected.
          params: paramsForKind(effect.kind).map((p) => ({
            name: p.name,
            label: p.label,
            min: p.min,
            max: p.max,
            // `p` is one of THIS effect's own kind's descriptors, and
            // `resolveParams` starts from that same kind's defaults before
            // applying overrides — `p.name` is therefore always present.
            default: resolveParams(effect)[p.name]!,
            ...(p.choices !== undefined ? { choices: p.choices } : {}),
            ...(p.hint !== undefined ? { hint: p.hint } : {}),
          })),
        })),
      };
    },
  ),
  readTool(
    {
      name: 'discover_transitions',
      description:
        'Browse the transition catalog. Search by name, direction, feel or use ' +
        'case ("left", "fast", "cinematic", "social media"), or filter by ' +
        'category. Returns each transition’s id, what it does, its default ' +
        'length, and the parameters it actually reads. Call this before ' +
        'add_transition — the ids are not guessable, and a kind this build does ' +
        'not know is refused outright rather than rendering as nothing. Weighing ' +
        'several looks? Pass them all as queries in one call.',
      capabilities: ['inspect'],
    },
    catalogBrowseArgs,
    (a) => {
      // Capped by default, for the same reason discover_effects is: 78 entries
      // with every parameter would spend a large slice of the context window on
      // transitions the model is not going to use.
      const { results, limited, asked } = browseCatalog(TRANSITION_CATALOG, searchTransitions, a);
      return {
        matched: results.length,
        returned: limited.length,
        ...asked,
        total: TRANSITION_CATALOG.length,
        categories: TRANSITION_CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
        transitions: limited.map((transition) => ({
          kind: transition.id,
          label: transition.label,
          category: transition.category,
          description: transition.description,
          defaultDuration: transition.defaultDuration,
          ...(transition.direction !== undefined ? { direction: transition.direction } : {}),
          directions: transitionDirectionsFor(transition),
          popular: transition.popular === true,
          recommended: transition.recommended === true,
          // Ranges, not just names: the model needs them to pick a legal value
          // instead of guessing and having the patch rejected.
          params: transitionParamsForKind(transition.renderKind).map((p) => ({
            name: p.name,
            label: p.label,
            min: p.min,
            max: p.max,
            // `p` is one of THIS transition's own render kind's descriptors, and
            // `resolveTransitionParams` starts from that same kind's defaults
            // before applying overrides — `p.name` is therefore always present.
            default: resolveTransitionParams(transition)[p.name]!,
            ...(p.choices !== undefined ? { choices: p.choices } : {}),
            ...(p.hint !== undefined ? { hint: p.hint } : {}),
          })),
        })),
      };
    },
  ),
  readTool(
    {
      name: 'verify_transitions',
      description:
        'Read back every transition actually present in timeline state and check each ' +
        'sits at a real cut, references the correct adjacent clips, and has a duration ' +
        'the boundary can carry. Also reports boundaries you may have intended to treat ' +
        'but did not. Returns { ok, transitionCount, issues[] }. Every add_transition ' +
        'result already carries this check as "verified: …", so call this only to ' +
        're-check after other edits have moved the cuts.',
    },
    noArgs,
    (_args, ctx) => verifyTransitions(ctx.project),
  ),
  readTool(
    {
      name: 'discover_text_overlay_styles',
      description:
        'Browse the designed text overlay styles add_text_layer can apply by `style` — ' +
        'headings, lower thirds, callouts, social, quotes, script and retro looks. Each ' +
        'comes with one line saying what it puts on screen (typeface, colour, size, where ' +
        'it sits, how it stands off the picture). Filter by category or search by name, ' +
        'font or colour.',
      capabilities: ['inspect'],
    },
    z
      .object({
        query: filterString(),
        category: z.enum(TEXT_OVERLAY_STYLE_CATEGORY_IDS).optional(),
      })
      .strict(),
    (a) => {
      const query = a.query?.toLocaleLowerCase();
      const strict = matchTextOverlayStyles(query, a.category);
      // A name searched in the wrong category is still the style that was meant: drop the
      // category rather than answer "none" (the caption catalog learned this the hard way).
      const nearMisses =
        strict.length === 0 && query !== undefined && a.category !== undefined
          ? matchTextOverlayStyles(query, undefined)
          : [];
      const styles = strict.length > 0 ? strict : nearMisses;
      return {
        matched: strict.length,
        total: TEXT_OVERLAY_STYLE_CATALOG.length,
        ...(nearMisses.length > 0
          ? {
              note:
                `No style matches "${a.query ?? ''}" in "${a.category ?? ''}"; the ` +
                `${String(nearMisses.length)} below match it in their own category.`,
            }
          : {}),
        ...(a.query === undefined ? {} : { query: a.query }),
        categories: TEXT_OVERLAY_STYLE_CATEGORY_IDS,
        styles: styles.map(styleListing),
      };
    },
  ),
  mutateTool(
    {
      name: 'add_text_layer',
      description:
        'Add a text overlay clip on a track over a timeline range (start/end seconds). ' +
        'Simultaneous text elements are fine: clips on one track cannot overlap, so if ' +
        'the track you name is already busy over that range the overlay is placed on ' +
        'another free overlay track, or a new one, and the result reports where it ' +
        'landed. Style it here. `style` applies a designed text overlay style whole — ' +
        'typeface, size, colour, outline/shadow/chip and placement (ids and what each ' +
        'looks like: discover_text_overlay_styles); any other styling arg you also pass ' +
        'overrides just that field of the style. sizePercent is the glyph ' +
        'height as a percentage of the frame (8 is a caption, 18+ is a headline that ' +
        'dominates the frame), xPercent/yPercent place the box centre (50/50 is the ' +
        'middle, y 15 is near the top), fontFamily (a bundled family) and fontWeight set ' +
        'the typeface, and color/background/align/' +
        'boxWidthPercent do what they say. Everything renders exactly as the preview ' +
        'shows it. To restyle it later, set_text_style. For motion, follow this with ' +
        'punch_in on the clip it creates.',
    },
    z
      .object({
        trackId: z.string(),
        text: z.string(),
        start: seconds,
        end: seconds,
        /** Percentage of FRAME HEIGHT, matching what the editor's Inspector writes. */
        sizePercent: numeric(z.number().positive().max(100)).optional(),
        color: z.string().optional(),
        background: z.string().optional(),
        align: z.enum(['left', 'center', 'right']).optional(),
        boxWidthPercent: numeric(z.number().positive().max(100)).optional(),
        xPercent: numeric(z.number().min(0).max(100)).optional(),
        yPercent: numeric(z.number().min(0).max(100)).optional(),
        /** A text overlay style id; the other styling args override its fields one by one. */
        style: z.enum(TEXT_OVERLAY_STYLE_IDS).optional(),
        fontFamily: bundledFontFamily.optional(),
        fontWeight: cssFontWeight.optional(),
      })
      .strict(),
    (a, ctx) => {
      // Resolve the lane instead of trusting the one the model named.
      //
      // A track cannot hold overlapping clips, and the description below has always
      // said so — but a description is a request, not a constraint, and the model
      // routinely put two simultaneous text elements on one track anyway. The whole
      // patch was then refused by the validator with
      //
      //     Clips 'text__t_motion_gfx_18000' and 'text__t_motion_gfx_22800'
      //     overlap on track 't_motion_gfx'.
      //
      // which cost a turn, taught the run nothing it could act on, and left the
      // editor looking at an error for a request that was perfectly sensible. The
      // named lane still wins whenever it has room; when it does not, the overlay
      // goes on another free overlay lane, or onto a new one — which is exactly
      // what the description was asking the model to do by hand.
      //
      // Shared with `add_clip` and `add_caption_layer`: one rule for every kind of
      // clip, so a placement never depends on which tool happened to make it. The
      // allocator keeps the fallback inside the role that was named — lanes are
      // type-agnostic, so an unconstrained search happily put a title on the audio
      // bed just because it was free.
      // THE SAME TITLE, TWICE, IS NOT TWO TITLES.
      //
      // The lane fallback above exists for two DIFFERENT simultaneous elements. It cannot
      // tell them from the same element sent twice, and the difference is what the viewer
      // sees: run `137d8fd0` called this with `text: "Breck, opening weekend",
      // trackId: "v_titles", start: 0, end: 5` and then called it again with exactly those
      // arguments. The lane was busy — with the first one — so the second went onto a new
      // overlay layer, and the export composited the headline on top of itself. In the
      // preview it reads as illegible: two copies of the same words at the same size,
      // offset by nothing.
      //
      // Not caught anywhere else. A second placement really does change the project (a new
      // lane, a new clip), so the run's no-change guard cannot see it, and the two clips do
      // not overlap on any one track so the validator cannot either.
      const duplicate = findOverlayWithSameText(ctx.project, a.text, a.start, a.end);
      if (duplicate) {
        throw new ToolRefusalError(
          `"${clampTitle(a.text)}" is already on screen from ${round2(a.start)}s to ` +
            `${round2(a.end)}s, on ${duplicate.trackId}. Adding it again would composite ` +
            'the same words on top of themselves. Restyle that overlay with ' +
            'set_text_style, move it with move_clip, or write different text.',
        );
      }
      // A word that cannot fit its box runs out the sides of the frame in the preview and
      // the export alike, and the safe-area check can only say so afterwards. The fit is
      // arithmetic on the text and the box, so it is decided here: run `4a8e` set "Breck,
      // opening weekend" at a size where "weekend" needed 119% of the frame in an 80% box.
      //
      // FIT IT, don't refuse it. This used to throw, naming the largest size that would
      // fit — and the model did not use it. Run `160b7557` asked for five titles
      // ("MASTERING", "PRINCIPLES", "SUBSCRIBERS", "557,000", "SCHOOL"), was refused once
      // each, retried none of them, and the export shipped with NO titles at all. Across
      // the three runs that hit this, 64 `add_text_layer` calls produced 11 overlays.
      //
      // Refusing spends a whole model call to be told a number this function has already
      // computed. A title one size smaller is an ordinary typographic compromise; a
      // missing title is a hole in the edit. So the fit is applied here, the same way the
      // speed-ramp tool fits its slot by default rather than refusing a ramp that would
      // overrun it.
      //
      // Widening the box is preferred where it is enough, because that KEEPS the size the
      // editor asked for; shrinking is the fallback for text no box can hold. The chosen
      // values ride the ops, so the applied patch states the size that was really used.
      //
      // A style's own size and box are fitted the same way: a style is a starting look, not a
      // promise that any text fits its box, and "SUBSCRIBERS" set in a 12%-high retro face is
      // the same overflow whoever picked the size. The fit measures the face and the case the
      // overlay is drawn in.
      const style = a.style === undefined ? undefined : getTextOverlayStyle(a.style);
      const requested: Record<string, unknown> = {
        ...(style === undefined ? {} : textOverlayLookParams(style.look, style.id)),
        ...authoredTextParams(a),
      };
      const weight = weightTheFamilyHas(requested.fontFamily, requested.fontWeight);
      if (weight !== undefined) requested.fontWeight = weight;
      const params = fitTextOverlayParams(a.text, requested, ctx.project.resolution);
      const placed = createLaneAllocator(ctx.project.timeline).allocate(a.trackId, a.start, a.end);
      const trackId = placed.trackId;
      const clipId = textOverlayClipId(trackId, a.start);
      const ops: Operation[] = [
        ...placed.setupOps,
        {
          type: 'add_text_overlay',
          trackId,
          text: a.text,
          start: a.start,
          end: a.end,
          clipId,
        },
      ];
      // The style rides a second op on the same patch rather than widening the
      // `add_text_overlay` operation: the params bag is where every other consumer of a
      // text overlay already reads its styling from (the Inspector writes it, the preview
      // reads it, and the renderer resolves it), and one shared vocabulary is worth more
      // than a shorter call. Undo still removes both in one step — they are one patch.
      if (Object.keys(params).length > 0) {
        ops.push({
          type: 'set_effect_params',
          clipId,
          effectId: textEffectId(clipId),
          params,
        });
      }
      return ops;
    },
  ),
  mutateTool(
    {
      // The restyle half of `add_text_layer`. Without it the only way to change a title the
      // run had placed was to delete it and add it again: run `6cb12e30` tried
      // `adjust_effect` on a title's own effect id, was refused "Effect layer not found",
      // and told the editor it could not enlarge its titles.
      name: 'set_text_style',
      description:
        'Restyle a text overlay already on the timeline — its words, a designed `style` ' +
        '(ids and looks: discover_text_overlay_styles; applied the way the Text panel ' +
        'applies it, keeping the overlay where it sits), size, font, weight, colour, ' +
        'background, alignment, box width or position. Pass the clipId add_text_layer ' +
        "created and only what changes, in add_text_layer's units; a styling arg overrides " +
        'that field of the style, and the words are re-fitted to the box the same way. ' +
        'Timing and track stay as they are (move_clip / trim_clip change those).',
    },
    z
      .object({
        clipId: z.string().min(1),
        text: z.string().min(1).optional(),
        style: z.enum(TEXT_OVERLAY_STYLE_IDS).optional(),
        sizePercent: numeric(z.number().positive().max(100)).optional(),
        color: z.string().optional(),
        background: z.string().optional(),
        align: z.enum(['left', 'center', 'right']).optional(),
        boxWidthPercent: numeric(z.number().positive().max(100)).optional(),
        xPercent: numeric(z.number().min(0).max(100)).optional(),
        yPercent: numeric(z.number().min(0).max(100)).optional(),
        fontFamily: bundledFontFamily.optional(),
        fontWeight: cssFontWeight.optional(),
      })
      .strict(),
    (a, ctx) => {
      const clip = ctx.project.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === a.clipId);
      if (clip === undefined) {
        throw new Error(
          `Clip not found: ${a.clipId}. Use the clipId add_text_layer returned, or get_clips ` +
            'on the overlay track to read it.',
        );
      }
      const effect = clip.effects.find((candidate) => candidate.type === 'text');
      if (syntheticClipKind(clip.assetId) !== 'text' || effect === undefined) {
        throw new ToolRefusalError(
          `${a.clipId} is not a text overlay — set_text_style restyles overlays made with ` +
            'add_text_layer. A shape is set_shape_style; captions are set_caption_style.',
        );
      }
      // Fit the overlay as it WILL be — new words in the old box, a heavier face at the old
      // size — not as it is, so a restyle cannot push a word out of the frame.
      const style = a.style === undefined ? undefined : getTextOverlayStyle(a.style);
      const merged: Record<string, unknown> = {
        ...effect.params,
        ...(style === undefined ? {} : restyleLookOf(style)),
        ...authoredTextParams(a),
        ...(a.text === undefined ? {} : { text: a.text }),
      };
      const weight = weightTheFamilyHas(merged.fontFamily, merged.fontWeight);
      if (weight !== undefined) merged.fontWeight = weight;
      const fitted = fitTextOverlayParams(
        typeof merged.text === 'string' ? merged.text : '',
        merged,
        ctx.project.resolution,
      );
      const params = Object.fromEntries(
        Object.entries(fitted).filter(
          ([key, value]) =>
            value !== undefined && JSON.stringify(value) !== JSON.stringify(effect.params[key]),
        ),
      );
      if (Object.keys(params).length === 0) {
        throw new ToolRefusalError(
          `Nothing to change on ${a.clipId}: name at least one of text, style, sizePercent, ` +
            'color, background, align, boxWidthPercent, xPercent, yPercent, fontFamily or ' +
            'fontWeight with a value different from what it already has.',
        );
      }
      return [{ type: 'set_effect_params', clipId: clip.id, effectId: effect.id, params }];
    },
  ),
  mutateTool(
    {
      name: 'add_transition',
      description:
        'Add a transition at the cut between two adjacent clips on the same track ' +
        '(trackId plus fromClipId and toClipId, which must be neighbours). Say WHY with ' +
        '`reason` — continuity, time_jump, location_change, energy, montage, soften, ' +
        'reveal — and the kind and the length are chosen from what the two shots measure ' +
        'and how fast the sequence is cutting. `continuity` is answered with a hard cut ' +
        'and no transition, which is the right answer at most cuts. Give `kind` (a ' +
        'catalog id from discover_transitions) and/or `durationSeconds` only when the ' +
        'editor named one. A cut can carry at most half of its shorter clip; ask for ' +
        'longer and it is shortened to fit rather than refused.',
    },
    z
      .object({
        trackId: z.string(),
        fromClipId: z.string(),
        toClipId: z.string(),
        // A catalog id, validated against the catalog rather than pinned to an
        // enum here: the catalog is data, and restating 78 ids in the tool
        // schema would make every added transition a change in four packages.
        // An unknown id is refused by the op with a readable sentence, which is
        // exactly what a model needs to correct itself.
        //
        // OPTIONAL since VU4.2: the id is what an editor names, and the model naming one
        // is the guess the policy replaces. Absent, `reason` chooses it.
        kind: z
          .string()
          .refine((value) => getTransition(value) !== undefined, {
            message: 'Unknown transition kind. Call discover_transitions to see what exists.',
          })
          .optional(),
        durationSeconds: numeric(z.number().positive()).optional(),
        reason: z.enum(TRANSITION_REASONS).optional(),
      })
      .strict(),
    (a, ctx) => {
      const resolved = resolveSingleTransition(a, ctx);
      return [
        {
          type: 'add_transition',
          trackId: a.trackId,
          fromClipId: a.fromClipId,
          toClipId: a.toClipId,
          kind: resolved.kind,
          durationSeconds: resolved.durationSeconds,
        },
      ];
    },
  ),
  mutateTool(
    {
      name: 'add_transitions',
      description:
        'Decide what belongs at EVERY cut in one pass, instead of one call per cut. ' +
        '`reason: "auto"` (the default) reads each cut: a jump cut is softened, a change ' +
        'of setting gets a location transition, and every other cut is deliberately left ' +
        'as a hard cut. Name one reason instead to apply it to every cut in scope, or ' +
        'list `cuts` with a reason each — or with `kind` (a catalog id from ' +
        'discover_transitions, e.g. whip-pan-left, light-leak) where the editor named the ' +
        'transition for that cut. Optionally limit to one trackId. includeCutaways ' +
        'also treats where b-roll laid over the A-roll enters and leaves (auto keeps those ' +
        'hard; soften gives quick dissolves, energy punchier entrances). The result names ' +
        'every cut it left hard and why — those are decisions, not omissions, so do not go ' +
        'back and fill them in.',
    },
    z
      .object({
        trackId: z.string().trim().min(1).optional(),
        reason: z.union([z.literal('auto'), z.enum(TRANSITION_REASONS)]).optional(),
        cuts: z
          .array(
            z
              .object({
                fromClipId: z.string().trim().min(1),
                toClipId: z.string().trim().min(1),
                reason: z.enum(TRANSITION_REASONS).optional(),
                // What the editor NAMED for this cut. Without it the batch could only pass
                // reasons, so run `6cb12e30`'s "whip-pan into departure" and "light-leak
                // dissolve into camp" became a policy zoom and a plain cross-dissolve.
                kind: z.string().trim().min(1).optional(),
                durationSeconds: numeric(z.number().positive()).optional(),
              })
              .strict(),
          )
          .min(1)
          .optional(),
        includeCutaways: boolean().optional(),
      })
      .strict(),
    (a, ctx) => [
      ...namedTransitions(ctx, a.cuts ?? []),
      ...planTransitions(ctx, {
        ...(a.trackId === undefined ? {} : { trackId: a.trackId }),
        reason: a.reason ?? 'auto',
        ...(a.cuts === undefined ? {} : { cuts: a.cuts.filter((cut) => cut.kind === undefined) }),
      })
        .filter(
          (
            decision,
          ): decision is TransitionDecision & {
            choice: { kind: string; durationSeconds: number };
          } => decision.choice !== null,
        )
        .map((decision) => ({
          type: 'add_transition' as const,
          trackId: decision.trackId,
          fromClipId: decision.fromClipId,
          toClipId: decision.toClipId,
          kind: decision.choice.kind,
          durationSeconds: decision.choice.durationSeconds,
        })),
      ...(a.includeCutaways === true
        ? planCutawayTransitions(ctx, { trackId: a.trackId, reason: a.reason ?? 'auto' })
            .filter(
              (
                decision,
              ): decision is CutawayTransitionDecision & {
                choice: { kind: string; durationSeconds: number };
              } => decision.choice !== null,
            )
            .map((decision) => ({
              type: 'add_layer_transition' as const,
              clipId: decision.clipId,
              edge: decision.edge,
              kind: decision.choice.kind,
              durationSeconds: decision.choice.durationSeconds,
            }))
        : []),
    ],
  ),
  mutateTool(
    {
      name: 'apply_effect',
      description:
        'Apply a catalog effect as its own timeline LAYER over a time range. The ' +
        'effect affects every visible clip beneath it for that range — it is not ' +
        'attached to one clip. Use discover_effects first to get a real effectId ' +
        'and its parameter ranges. Creates an effect track if the project has ' +
        'none. Omit endTime to use the effect’s own default duration. ' +
        'Finishing and texture layers (grain, print emulation, vignette) may run the ' +
        'whole programme; light, glow, leak and flash accents belong on a moment, ' +
        'around their defaultDuration.',
      capabilities: ['edit', 'effects'],
    },
    z
      .object({
        effectId: z.string(),
        startTime: numeric(z.number().nonnegative()),
        endTime: numeric(z.number().positive()).optional(),
        /** Overrides for the catalog defaults; clamped, unknown names rejected. */
        params: z.record(z.string(), numeric(z.number())).optional(),
        intensity: numeric(z.number().min(0).max(1)).optional(),
        /** Target an existing effect lane; omit to reuse the first / create one. */
        trackId: filterString(),
      })
      .strict(),
    (a, ctx) => {
      const entry = findEffect(a.effectId);
      if (entry === undefined) {
        // Thrown, not silently ignored: a hallucinated effect id must come back
        // to the model as an error it can correct, not as a no-op patch that
        // looks like success.
        throw new Error(
          `Unknown effectId "${a.effectId}". Call discover_effects to list valid ids.`,
        );
      }
      const end = a.endTime ?? a.startTime + entry.defaultDuration;
      if (end <= a.startTime) {
        throw new Error(
          `apply_effect endTime (${end}) must be greater than startTime (${a.startTime}).`,
        );
      }

      const layer: EffectLayer = {
        id: id('fx', entry.id, a.startTime),
        effectId: entry.id,
        kind: entry.kind,
        start: a.startTime,
        end,
        // Resolve the FULL bag, not just the overrides: a layer carrying only
        // overrides would change appearance if a kind's defaults were ever
        // retuned, silently altering already-saved projects.
        params: clampParamsForKind(entry.kind, { ...resolveParams(entry), ...(a.params ?? {}) }),
        keyframes: [],
        ...(a.intensity !== undefined ? { intensity: a.intensity } : {}),
      };

      const existing = effectTrackOf(ctx.project, a.trackId);
      if (existing !== undefined) {
        return [{ type: 'add_effect_layer', trackId: existing, layer }];
      }
      // No effect lane yet: create one at the FRONT (index 0) so it sits above
      // the picture, then add the layer to it. Two ops, one patch, one undo.
      const trackId = id('fx_track', ctx.project.timeline.tracks.length);
      return [
        { type: 'add_layer', layerId: trackId, layerType: 'effect', atIndex: 0 },
        { type: 'add_effect_layer', trackId, layer },
      ];
    },
  ),
  mutateTool(
    {
      name: 'move_effect',
      description:
        'Move an effect layer to a new start time, keeping its duration. Pass ' +
        'toTrackId to move it onto a different effect lane (which changes the ' +
        'order it combines in — lower lanes apply first).',
      capabilities: ['edit', 'effects'],
    },
    z
      .object({
        layerId: z.string(),
        toStart: numeric(z.number().nonnegative()),
        toTrackId: filterString(),
      })
      .strict(),
    (a) => [
      {
        type: 'move_effect_layer',
        layerId: a.layerId,
        toStart: a.toStart,
        ...(a.toTrackId !== undefined ? { toTrackId: a.toTrackId } : {}),
      },
    ],
  ),
  mutateTool(
    {
      name: 'resize_effect',
      description:
        'Change an effect layer’s in/out points — trim, extend or shorten it. ' +
        'Both times are absolute timeline seconds.',
      capabilities: ['edit', 'effects'],
    },
    z
      .object({
        layerId: z.string(),
        start: numeric(z.number().nonnegative()),
        end: numeric(z.number().positive()),
      })
      .strict(),
    (a) => [{ type: 'trim_effect_layer', layerId: a.layerId, start: a.start, end: a.end }],
  ),
  mutateTool(
    {
      name: 'adjust_effect',
      description:
        'Retune an effect layer placed with apply_effect (its layerId). `params` is a ' +
        'PARTIAL patch — send only the values to change. `intensity` (0–1) is the master strength every effect ' +
        'honours; pass null to reset it to full. Call discover_effects for the ' +
        'valid parameter names and ranges of the effect’s kind.',
      capabilities: ['edit', 'effects'],
    },
    z
      .object({
        layerId: z.string(),
        params: z.record(z.string(), numeric(z.number())).optional(),
        intensity: numeric(z.number().min(0).max(1)).nullable().optional(),
      })
      .strict(),
    (a, ctx) => {
      const isLayer = ctx.project.timeline.tracks.some((track) =>
        (track.effectLayers ?? []).some((layer) => layer.id === a.layerId),
      );
      if (!isLayer) {
        // Resolve the id before emitting an op for it. This always emitted the effect-LAYER op,
        // so a clip's own effect id — the `<clipId>__text` a title's patch carries — was
        // refused as "Effect layer not found" with no way forward, and run `6cb12e30` told
        // the editor its titles could not be enlarged.
        const owner = ctx.project.timeline.tracks
          .flatMap((track) => track.clips)
          .find((clip) => clip.effects.some((effect) => effect.id === a.layerId));
        if (owner !== undefined) {
          const kind = owner.effects.find((effect) => effect.id === a.layerId)?.type;
          throw new ToolRefusalError(
            `${a.layerId} is ${kind === 'text' ? 'the text of' : `a ${String(kind)} effect on`} ` +
              `clip ${owner.id}, not an effect layer — adjust_effect retunes layers placed ` +
              'with apply_effect. ' +
              (kind === 'text'
                ? `Restyle the text overlay with set_text_style (clipId "${owner.id}").`
                : 'Change it with the tool that made it, or read it with get_clip.'),
          );
        }
      }
      return [
        {
          type: 'set_effect_layer_params',
          layerId: a.layerId,
          ...(a.params !== undefined ? { params: a.params } : {}),
          ...(a.intensity !== undefined ? { intensity: a.intensity } : {}),
        },
      ];
    },
  ),
  mutateTool(
    {
      name: 'set_effect_enabled',
      description:
        'Temporarily bypass an effect layer, or re-enable it. The layer stays on ' +
        'the timeline either way — use remove_effect to delete it.',
      capabilities: ['edit', 'effects'],
    },
    z.object({ layerId: z.string(), enabled: z.boolean() }).strict(),
    (a) => [{ type: 'set_effect_layer_enabled', layerId: a.layerId, disabled: !a.enabled }],
  ),
  mutateTool(
    {
      name: 'remove_effect',
      description: 'Delete an effect layer from the timeline. Reversible.',
      capabilities: ['edit', 'effects'],
    },
    z.object({ layerId: z.string() }).strict(),
    (a) => [{ type: 'remove_effect_layer', layerId: a.layerId }],
  ),
];
