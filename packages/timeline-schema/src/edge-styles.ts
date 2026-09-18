/**
 * @framepilot/timeline-schema/edge-styles — cut-out edge styles in the effect catalog (MK9.2,
 * plan 10 "Edge styles for cut-outs").
 *
 * A subject cut out by a clip's mask stack (a background removal, a drawn shape, a key) gets the
 * CapCut-style outline, outer glow or drop shadow from ONE of three render kinds. They are clip
 * effects (`Clip.effects[]`, `type: 'edge_style'`) that READ the clip's alpha-target mask stack and
 * draw outside it, so no new mask kind and no schema field exists for them: the params ride the
 * effect's open `params` record, validated here.
 *
 * WHY clip effects and not effect-layer kinds: an adjustment lane works on the composited frame,
 * which has no cut-out to trace. The edge belongs to the clip whose stack made it.
 *
 * Like the rest of the catalog this is PURE DATA: renderers dispatch on {@link EdgeStyleKind}
 * only, never on a catalog entry id. `scripts/generate-json-schema.mjs` exports it inside
 * `schema/effect-catalog.json` (the engine's copy is byte-identical), and both sides guard drift.
 *
 * The render rule, identical on both sides (`render/edge_styles.py`, the compositor's edge pass):
 *
 * - the cut-out is the stack alpha at or above one half, per pixel of the clip's raster;
 * - `d` is the exact Euclidean distance, in raster pixels between pixel centres, to the nearest
 *   pixel of it (0 inside), found by a separable search bounded by the style's reach;
 * - stroke alpha `clamp(w + 0.5 − d, 0, 1)`; glow and shadow `(1 − t)²` for `t = d / (r + 1) < 1`,
 *   the shadow measuring `d` from the cut-out moved by its whole-pixel offset;
 * - × the style's opacity × the clip's opacity; styles stack shadow, glow, stroke (bottom to top)
 *   and the picture goes over them.
 *
 * Lengths are display-corrected SOURCE pixels, like a mask's, scaled onto the raster by the
 * mask's own distance scale, so an outline keeps its look at any decode size.
 */
import { z } from 'zod';
import type { EffectParamDescriptor } from './effect-params.js';

/** The `Effect.type` an edge style is stored under on a clip. */
export const EDGE_STYLE_EFFECT_TYPE = 'edge_style';

/** The render kinds, in the order they stack from the bottom up (shadow under glow under stroke). */
export const EDGE_STYLE_KINDS = ['shadow', 'glow', 'stroke'] as const;

export type EdgeStyleKind = (typeof EDGE_STYLE_KINDS)[number];

export const EdgeStyleKindSchema = z.enum(EDGE_STYLE_KINDS);

const colour = (name: 'red' | 'green' | 'blue', def: number): EffectParamDescriptor => ({
  name,
  label: name === 'red' ? 'Red' : name === 'green' ? 'Green' : 'Blue',
  min: 0,
  max: 255,
  step: 1,
  default: def,
});

const length = (
  name: string,
  label: string,
  min: number,
  max: number,
  def: number,
  hint: string,
): EffectParamDescriptor => ({ name, label, min, max, step: 0.5, default: def, unit: 'px', hint });

const opacity = (def: number): EffectParamDescriptor => ({
  name: 'opacity',
  label: 'Opacity',
  min: 0,
  max: 1,
  step: 0.01,
  default: def,
});

/** The largest reach, in source pixels, any style may ask for (bounds the distance search). */
export const EDGE_STYLE_MAX_REACH_PX = 200;

/** Per-kind parameter vocabulary: the validator, the Inspector and the AI layer all read this. */
export const EDGE_STYLE_PARAMS: Readonly<Record<EdgeStyleKind, readonly EffectParamDescriptor[]>> =
  {
    stroke: [
      length('widthPx', 'Width', 0.5, EDGE_STYLE_MAX_REACH_PX, 8, 'Outline thickness.'),
      colour('red', 255),
      colour('green', 255),
      colour('blue', 255),
      opacity(1),
    ],
    glow: [
      length('radiusPx', 'Radius', 1, EDGE_STYLE_MAX_REACH_PX, 24, 'How far the glow reaches.'),
      colour('red', 255),
      colour('green', 255),
      colour('blue', 255),
      opacity(0.8),
    ],
    shadow: [
      length(
        'offsetXPx',
        'Offset X',
        -EDGE_STYLE_MAX_REACH_PX,
        EDGE_STYLE_MAX_REACH_PX,
        12,
        'Right is positive.',
      ),
      length(
        'offsetYPx',
        'Offset Y',
        -EDGE_STYLE_MAX_REACH_PX,
        EDGE_STYLE_MAX_REACH_PX,
        12,
        'Down is positive.',
      ),
      length('softnessPx', 'Softness', 0, EDGE_STYLE_MAX_REACH_PX, 16, 'Blur of the shadow edge.'),
      colour('red', 0),
      colour('green', 0),
      colour('blue', 0),
      opacity(0.6),
    ],
  };

/** One browsable edge style (pure data, like a catalog effect). */
export interface EdgeStyleEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: EdgeStyleKind;
  /** Shallow override of the kind defaults. */
  readonly params?: Readonly<Record<string, number>>;
  readonly description: string;
  readonly tags: readonly string[];
}

export const EDGE_STYLE_CATALOG: readonly EdgeStyleEntry[] = [
  {
    id: 'white-outline',
    label: 'White Outline',
    kind: 'stroke',
    description: 'A clean white line around the cut-out subject.',
    tags: ['outline', 'stroke', 'border', 'cutout', 'white'],
  },
  {
    id: 'sticker-outline',
    label: 'Sticker',
    kind: 'stroke',
    params: { widthPx: 20 },
    description: 'A thick white border that makes the subject read as a sticker.',
    tags: ['sticker', 'thick outline', 'border', 'cutout'],
  },
  {
    id: 'black-outline',
    label: 'Black Outline',
    kind: 'stroke',
    params: { widthPx: 5, red: 0, green: 0, blue: 0 },
    description: 'A thin dark line that separates the subject from a busy background.',
    tags: ['outline', 'stroke', 'black', 'separation'],
  },
  {
    id: 'neon-glow',
    label: 'Neon Glow',
    kind: 'glow',
    params: { radiusPx: 30, red: 0, green: 240, blue: 255, opacity: 0.9 },
    description: 'A saturated glow that spills out from the subject edge.',
    tags: ['glow', 'neon', 'halo', 'cutout'],
  },
  {
    id: 'soft-halo',
    label: 'Soft Halo',
    kind: 'glow',
    params: { radiusPx: 48, opacity: 0.55 },
    description: 'A wide, gentle white halo around the subject.',
    tags: ['halo', 'glow', 'soft', 'dreamy'],
  },
  {
    id: 'drop-shadow',
    label: 'Drop Shadow',
    kind: 'shadow',
    description: 'A soft shadow behind and below the subject.',
    tags: ['shadow', 'drop shadow', 'depth', 'cutout'],
  },
  {
    id: 'hard-shadow',
    label: 'Hard Shadow',
    kind: 'shadow',
    params: { offsetXPx: 10, offsetYPx: 10, softnessPx: 0, opacity: 0.85 },
    description: 'A crisp offset shadow, poster style.',
    tags: ['shadow', 'hard', 'offset', 'poster'],
  },
];

/** The full default param bag of a kind. */
export function defaultEdgeStyleParams(kind: EdgeStyleKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const descriptor of EDGE_STYLE_PARAMS[kind]) out[descriptor.name] = descriptor.default;
  return out;
}

/**
 * Merge `params` over the kind defaults, clamped to the declared ranges, dropping unknown names
 * and non-numbers (`clamp_edge_style_params` in the engine).
 */
export function clampEdgeStyleParams(
  kind: EdgeStyleKind,
  params: Readonly<Record<string, unknown>>,
): Record<string, number> {
  const out = defaultEdgeStyleParams(kind);
  for (const descriptor of EDGE_STYLE_PARAMS[kind]) {
    const raw = params[descriptor.name];
    if (typeof raw !== 'number' || Number.isNaN(raw)) continue;
    out[descriptor.name] = Math.min(descriptor.max, Math.max(descriptor.min, raw));
  }
  return out;
}

/** A catalog entry's complete param bag, as stored when it is applied. */
export function resolveEdgeStyleParams(entry: EdgeStyleEntry): Record<string, number> {
  return { ...defaultEdgeStyleParams(entry.kind), ...(entry.params ?? {}) };
}

export function findEdgeStyle(id: string): EdgeStyleEntry | undefined {
  return EDGE_STYLE_CATALOG.find((entry) => entry.id === id);
}

/** The stored params of an edge style effect: its kind plus the kind's numbers. */
export const EdgeStyleEffectParamsSchema = z
  .object({ kind: EdgeStyleKindSchema })
  .catchall(z.number().finite());

export type EdgeStyleEffectParams = z.infer<typeof EdgeStyleEffectParamsSchema>;

/**
 * Why stored edge style params are invalid (a message with the remedy and no varying number), or
 * `null`. Unknown names and out-of-range values are refused rather than clamped, so a project
 * never renders something other than what it says.
 */
export function edgeStyleParamsIssue(params: unknown): string | null {
  const parsed = EdgeStyleEffectParamsSchema.safeParse(params);
  if (!parsed.success) {
    return 'An edge style needs a kind (stroke, glow or shadow) and numeric settings. Pick the style again.';
  }
  const { kind, ...values } = parsed.data;
  const declared = new Map(
    EDGE_STYLE_PARAMS[kind].map((descriptor) => [descriptor.name, descriptor]),
  );
  for (const [name, value] of Object.entries(values)) {
    const descriptor = declared.get(name);
    if (descriptor === undefined) {
      return `An edge style has a setting "${name}" its kind does not use. Remove it.`;
    }
    if (value < descriptor.min || value > descriptor.max) {
      return `An edge style's ${descriptor.label.toLowerCase()} is outside its range. Set it within the slider's range.`;
    }
  }
  return null;
}
