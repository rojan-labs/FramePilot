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
import { type Operation, textEffectId, textOverlayClipId } from '@framepilot/editor-core';
import { verifyTransitions } from '../verify.js';
import type { ToolSpec } from '../tool-registry.js';
import { mutateTool, noArgs, readTool } from './tool-factories.js';
import { filterString, id, numeric, seconds } from './tool-args.js';

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
        'are rejected by the patch validator.',
      capabilities: ['inspect', 'effects'],
    },
    z
      .object({
        query: filterString(),
        category: filterString(),
        /** Only the shelves a person would see first. */
        shelf: z.enum(['popular', 'recommended']).optional(),
        limit: numeric(z.number().int().positive().max(80)).optional(),
      })
      .strict(),
    (a) => {
      let results = a.query !== undefined ? searchEffects(a.query) : EFFECT_CATALOG;
      if (a.category !== undefined) {
        results = results.filter((e) => e.category === a.category);
      }
      if (a.shelf === 'popular') results = results.filter((e) => e.popular === true);
      if (a.shelf === 'recommended') results = results.filter((e) => e.recommended === true);

      // Capped by default: the full catalog is 72 entries and dumping every
      // parameter of all of them would spend a large slice of the context window
      // on effects the model is not going to use.
      const limited = results.slice(0, a.limit ?? 20);
      return {
        matched: results.length,
        returned: limited.length,
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
        'not know is refused outright rather than rendering as nothing.',
      capabilities: ['inspect'],
    },
    z
      .object({
        query: filterString(),
        category: filterString(),
        shelf: z.enum(['popular', 'recommended']).optional(),
        limit: numeric(z.number().int().positive().max(80)).optional(),
      })
      .strict(),
    (a) => {
      let results = a.query !== undefined ? searchTransitions(a.query) : TRANSITION_CATALOG;
      if (a.category !== undefined) results = results.filter((t) => t.category === a.category);
      if (a.shelf === 'popular') results = results.filter((t) => t.popular === true);
      if (a.shelf === 'recommended') results = results.filter((t) => t.recommended === true);

      // Capped by default, for the same reason discover_effects is: 78 entries
      // with every parameter would spend a large slice of the context window on
      // transitions the model is not going to use.
      const limited = results.slice(0, a.limit ?? 20);
      return {
        matched: results.length,
        returned: limited.length,
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
        'but did not. Returns { ok, transitionCount, issues[] }. Run this before saying ' +
        'a transition was added; a command being accepted is not proof it is visible.',
    },
    noArgs,
    (_args, ctx) => verifyTransitions(ctx.project),
  ),
  mutateTool(
    {
      name: 'add_text_layer',
      description:
        'Add a text overlay clip on a track over a timeline range (start/end seconds). ' +
        'Clips on one track can never overlap — stack simultaneous text elements on ' +
        'separate tracks with a free range. Style it here: sizePercent is the glyph ' +
        'height as a percentage of the frame (8 is a caption, 18+ is a headline that ' +
        'dominates the frame), xPercent/yPercent place the box centre (50/50 is the ' +
        'middle, y 15 is a title card near the top), and color/background/align/' +
        'boxWidthPercent do what they say. Everything renders exactly as the preview ' +
        'shows it. For motion, follow this with punch_in on the clip it creates.',
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
      })
      .strict(),
    (a) => {
      const clipId = textOverlayClipId(a.trackId, a.start);
      const ops: Operation[] = [
        {
          type: 'add_text_overlay',
          trackId: a.trackId,
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
      const params: Record<string, unknown> = {
        ...(a.sizePercent === undefined ? {} : { fontSizePercent: a.sizePercent }),
        ...(a.color === undefined ? {} : { color: a.color }),
        ...(a.background === undefined ? {} : { background: a.background }),
        ...(a.align === undefined ? {} : { align: a.align }),
        ...(a.boxWidthPercent === undefined ? {} : { boxWidthPercent: a.boxWidthPercent }),
        ...(a.xPercent === undefined ? {} : { xPercent: a.xPercent }),
        ...(a.yPercent === undefined ? {} : { yPercent: a.yPercent }),
      };
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
      name: 'add_transition',
      description:
        'Add a transition at the cut between two adjacent clips on the same track. ' +
        'Requires trackId plus fromClipId and toClipId (the outgoing and incoming ' +
        'clip ids, which must be neighbours), a kind, and a positive durationSeconds. ' +
        'Read the timeline first to get the real track and clip ids; a transition needs ' +
        'two clips, so it cannot be added when the track has only one clip. ' +
        'Kinds come from the transition catalog — `cross-dissolve`, `whip-pan-left`, ' +
        '`glitch`, `circular-wipe` and 70-odd more; `discover_transitions` names them all. ' +
        'A cut can carry at most half of its shorter clip; ask for longer and the ' +
        'transition is shortened to fit rather than refused, so short clips take one ' +
        'too. Read the applied duration back before describing it to the editor.',
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
        kind: z.string().refine((value) => getTransition(value) !== undefined, {
          message: 'Unknown transition kind. Call discover_transitions to see what exists.',
        }),
        durationSeconds: numeric(z.number().positive()),
      })
      .strict(),
    (a) => [
      {
        type: 'add_transition',
        trackId: a.trackId,
        fromClipId: a.fromClipId,
        toClipId: a.toClipId,
        kind: a.kind,
        durationSeconds: a.durationSeconds,
      },
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
        'none. Omit endTime to use the effect’s own default duration.',
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
        'Retune an applied effect. `params` is a PARTIAL patch — send only the ' +
        'values to change. `intensity` (0–1) is the master strength every effect ' +
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
    (a) => [
      {
        type: 'set_effect_layer_params',
        layerId: a.layerId,
        ...(a.params !== undefined ? { params: a.params } : {}),
        ...(a.intensity !== undefined ? { intensity: a.intensity } : {}),
      },
    ],
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
