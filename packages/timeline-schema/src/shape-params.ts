/**
 * @framepilot/timeline-schema/shape-params — the parameters of a shape clip (schema v25,
 * plan/elements EL4a, ADR 0190).
 *
 * A shape is a synthetic clip (editor-core's `SHAPE_ASSET_ID`) carrying exactly one effect of
 * type {@link SHAPE_EFFECT_TYPE} whose `params` are a {@link ShapeParams}. The params are FLAT on
 * purpose: `set_effect_params` shallow-merges, the Inspector edits one key at a time, and a flat
 * number can later be animated by effect keyframes with no new machinery.
 *
 * Units (one sizing unit for every graphic, so a shape and a title scale together when the
 * project's orientation changes, and a circle stays a circle):
 *
 * - box position `x`, `y`: the centre, percent of each frame axis (the title convention);
 * - box size `width`, `height`: percent of the frame HEIGHT;
 * - segment endpoints `x1, y1, x2, y2`: percent of each axis, allowed off-frame;
 * - `strokeWidth`: percent of the frame height.
 *
 * `null` and an absent key mean the same thing for every key (no fill, no stroke, no cap). Knobs
 * (`cornerRadius`, `headSize`, …) are catalogue-declared numbers; the catalogue bounds them,
 * so the schema only says "a knob is a finite number" and {@link shapeParamsProblem} checks the
 * name and range against the shape's own descriptor. The engine (`render/shape_geometry.py`) is
 * the only rasteriser; the Python twin of this module is `render/shape_catalog.py`.
 */
import { z } from 'zod/v4';
import { catalogShape, shapePreset, type ShapeDescriptor } from './shape-catalog.js';

/** The `Effect.type` a shape's params are stored under. */
export const SHAPE_EFFECT_TYPE = 'shape';

/** How a shape is placed: a centred box, or two endpoints. */
export const SHAPE_FRAMES = ['box', 'segment'] as const;
export type ShapeFrame = (typeof SHAPE_FRAMES)[number];

export const SHAPE_STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export type ShapeStrokeStyle = (typeof SHAPE_STROKE_STYLES)[number];

/** What an end of a segment shape draws. */
export const SHAPE_CAPS = ['none', 'arrow', 'dot', 'bar'] as const;
export type ShapeCap = (typeof SHAPE_CAPS)[number];

/** Inclusive bounds of the standard keys (see the module doc for units). */
export const SHAPE_LIMITS = {
  position: { min: 0, max: 100 },
  size: { min: 0.1, max: 400 },
  endpoint: { min: -50, max: 150 },
  strokeWidth: { min: 0.05, max: 10 },
} as const;

/** `#rrggbb` or `#rrggbbaa`: what the engine's Pillow rasteriser parses. */
export const SHAPE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** The longest badge label, in characters (code points, as the engine counts them). */
export const SHAPE_LABEL_MAX = 8;

/**
 * Whether `value` can be a badge label: 1–{@link SHAPE_LABEL_MAX} characters on one line, not
 * all spaces. Counted in code points so an emoji is one character in both runtimes.
 */
export function isShapeLabel(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  return length >= 1 && length <= SHAPE_LABEL_MAX && value.trim() !== '' && !/[\n\r]/.test(value);
}

const colour = z.string().regex(SHAPE_COLOR_PATTERN);
const within = (bounds: { readonly min: number; readonly max: number }) =>
  z.number().min(bounds.min).max(bounds.max);

/** The keys every shape understands; anything else is a catalogue knob. */
export const SHAPE_STANDARD_KEYS = [
  'shape',
  'x',
  'y',
  'width',
  'height',
  'x1',
  'y1',
  'x2',
  'y2',
  'fill',
  'stroke',
  'strokeWidth',
  'strokeStyle',
  'startCap',
  'endCap',
  'label',
  'labelColor',
] as const;

const BOX_KEYS = ['x', 'y', 'width', 'height'] as const;
const SEGMENT_KEYS = ['x1', 'y1', 'x2', 'y2'] as const;

const ShapeStandardParamsSchema = z.object({
  shape: z.string().min(1),
  x: within(SHAPE_LIMITS.position).nullish(),
  y: within(SHAPE_LIMITS.position).nullish(),
  width: within(SHAPE_LIMITS.size).nullish(),
  height: within(SHAPE_LIMITS.size).nullish(),
  x1: within(SHAPE_LIMITS.endpoint).nullish(),
  y1: within(SHAPE_LIMITS.endpoint).nullish(),
  x2: within(SHAPE_LIMITS.endpoint).nullish(),
  y2: within(SHAPE_LIMITS.endpoint).nullish(),
  fill: colour.nullish(),
  stroke: colour.nullish(),
  strokeWidth: within(SHAPE_LIMITS.strokeWidth),
  strokeStyle: z.enum(SHAPE_STROKE_STYLES),
  startCap: z.enum(SHAPE_CAPS).nullish(),
  endCap: z.enum(SHAPE_CAPS).nullish(),
  /** A badge's text, drawn inside the shape (numbered badges, burst labels; plan/elements EL5.4). */
  label: z.string().refine(isShapeLabel).nullish(),
  labelColor: colour.nullish(),
});

/** The standard keys, plus knobs: catalogue-declared numbers (`shapeParamsProblem` checks them). */
export const ShapeParamsSchema = ShapeStandardParamsSchema.catchall(
  z.number().refine(Number.isFinite),
);

/** A shape clip's params: the standard keys plus the shape's own numeric knobs. */
export type ShapeParams = z.infer<typeof ShapeStandardParamsSchema> & {
  readonly [knob: string]: unknown;
};

/**
 * Whether `key` carries a value. `null` reads as absent everywhere: `set_effect_params` clears a
 * key with JSON `null` in the engine and keeps a `null` in TypeScript, so the two runtimes only
 * agree on a shape if neither tells `null` and "absent" apart.
 */
function present(params: Readonly<Record<string, unknown>>, key: string): boolean {
  return params[key] !== undefined && params[key] !== null;
}

/** The catalogue entry (or `icon/<name>` icon) for `shapeId`, or `undefined`. */
export function shapeDescriptor(shapeId: string): ShapeDescriptor | undefined {
  return catalogShape(shapeId);
}

/**
 * Why `params` cannot be a shape, as one sentence with its remedy, or `null` when it can.
 *
 * The messages name the fix and never the offending magnitude: the agent's repeated-failure
 * guard keys on the text, so a message that varied with the input would read as progress.
 * The engine's `shape_catalog.shape_params_problem` returns the same sentences.
 */
export function shapeParamsProblem(params: Readonly<Record<string, unknown>>): string | null {
  const shapeId = params.shape;
  if (typeof shapeId !== 'string' || shapeId === '') {
    return 'A shape needs a shape id. Pick one with search_elements (kind: shape) or from the Shapes tab.';
  }
  const descriptor = shapeDescriptor(shapeId);
  if (descriptor === undefined) {
    return `There is no shape called '${shapeId}'. Pick one with search_elements (kind: shape) or from the Shapes tab.`;
  }
  const knobNames = new Set(descriptor.knobs.map((knob) => knob.name));
  const standard = new Set<string>(SHAPE_STANDARD_KEYS);
  for (const key of Object.keys(params)) {
    if (!present(params, key) || standard.has(key) || knobNames.has(key)) continue;
    const allowed = [...shapeKeysFor(descriptor)].join(', ');
    return `Shape parameter '${key}' is not one this shape has. Its parameters are: ${allowed}.`;
  }
  const wrongFrame = descriptor.frame === 'box' ? SEGMENT_KEYS : BOX_KEYS;
  if (wrongFrame.some((key) => present(params, key))) {
    return descriptor.frame === 'box'
      ? `'${shapeId}' is placed by a box (x, y, width, height), not by two ends.`
      : `'${shapeId}' is placed by its two ends (x1, y1, x2, y2), not a box.`;
  }
  const frameKeys = descriptor.frame === 'box' ? BOX_KEYS : SEGMENT_KEYS;
  const missing = frameKeys.filter((key) => !present(params, key));
  if (missing.length > 0) {
    return descriptor.frame === 'box'
      ? `'${shapeId}' needs its box: x, y, width and height.`
      : `'${shapeId}' needs both ends: x1, y1, x2 and y2.`;
  }
  if (descriptor.frame === 'box' && (present(params, 'startCap') || present(params, 'endCap'))) {
    return `'${shapeId}' has no ends to cap; startCap and endCap are for lines and arrows.`;
  }
  if (descriptor.labelled !== true && (present(params, 'label') || present(params, 'labelColor'))) {
    return `'${shapeId}' has no label; label and labelColor are for numbered badges and burst labels.`;
  }
  for (const knob of descriptor.knobs) {
    const value = params[knob.name];
    if (value === undefined || value === null) continue;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < knob.min ||
      value > knob.max
    ) {
      return `${knob.name} must be between ${String(knob.min)} and ${String(knob.max)}.`;
    }
  }
  const parsed = ShapeParamsSchema.safeParse(
    Object.fromEntries(Object.entries(params).filter(([key]) => present(params, key))),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path[0];
    return typeof key === 'string'
      ? `Shape parameter '${key}' is out of range or the wrong type. ${standardKeyHint(key)}`
      : 'The shape parameters are not valid. Start from a preset in the Shapes tab.';
  }
  const { fill, stroke } = parsed.data;
  if (descriptor.frame === 'segment' && stroke == null) {
    return `'${shapeId}' is drawn by its stroke — with the stroke off it draws nothing. Set a stroke colour.`;
  }
  if (fill == null && stroke == null) {
    return 'A shape needs a fill or a stroke — with both off it draws nothing.';
  }
  return null;
}

/** Every key a shape of this descriptor accepts, standard frame keys first. */
export function shapeKeysFor(descriptor: ShapeDescriptor): readonly string[] {
  const frame = descriptor.frame === 'box' ? BOX_KEYS : SEGMENT_KEYS;
  const caps = descriptor.frame === 'segment' ? (['startCap', 'endCap'] as const) : [];
  const label = descriptor.labelled === true ? (['label', 'labelColor'] as const) : [];
  return [
    'shape',
    ...frame,
    'fill',
    'stroke',
    'strokeWidth',
    'strokeStyle',
    ...caps,
    ...label,
    ...descriptor.knobs.map((knob) => knob.name),
  ];
}

function standardKeyHint(key: string): string {
  switch (key) {
    case 'x':
    case 'y':
      return 'A box centre is a percent of the frame, 0 to 100.';
    case 'width':
    case 'height':
      return 'A box size is a percent of the frame height, 0.1 to 400.';
    case 'x1':
    case 'y1':
    case 'x2':
    case 'y2':
      return 'An end is a percent of the frame, -50 to 150.';
    case 'fill':
    case 'stroke':
    case 'labelColor':
      return 'A colour is #rrggbb or #rrggbbaa, or null for none.';
    case 'label':
      return 'A label is 1 to 8 characters on one line.';
    case 'strokeWidth':
      return 'A stroke width is a percent of the frame height, 0.05 to 10.';
    case 'strokeStyle':
      return 'It is solid, dashed or dotted.';
    case 'startCap':
    case 'endCap':
      return 'A cap is none, arrow, dot or bar.';
    default:
      return 'Knobs are numbers.';
  }
}

/**
 * The complete params a preset is inserted with, centred on `at` (percent of each axis; the
 * frame centre by default). Knobs take the preset's value, else the descriptor's default, so a
 * fresh shape states every number the engine will draw it with.
 *
 * @param presetId - A preset id from the catalogue (`rounded-rect/highlight`).
 * @param at - Where the box centre (or the segment's reference point) lands.
 * @returns The params, or `undefined` for an unknown preset.
 */
export function presetShapeParams(
  presetId: string,
  at: { readonly x: number; readonly y: number } = { x: 50, y: 50 },
): ShapeParams | undefined {
  const found = shapePreset(presetId);
  if (found === undefined) return undefined;
  const { shape, preset } = found;
  const knobs = Object.fromEntries(
    shape.knobs.map((knob) => [knob.name, preset.knobs?.[knob.name] ?? knob.default]),
  );
  const style = {
    fill: preset.fill,
    stroke: preset.stroke,
    strokeWidth: preset.strokeWidth,
    strokeStyle: preset.strokeStyle,
  };
  if (shape.frame === 'box') {
    return {
      shape: shape.id,
      x: at.x,
      y: at.y,
      width: shape.defaults.width,
      height: shape.defaults.height,
      ...style,
      ...(preset.label !== undefined ? { label: preset.label } : {}),
      ...(preset.labelColor !== undefined ? { labelColor: preset.labelColor } : {}),
      ...knobs,
    };
  }
  const { x1, y1, x2, y2 } = shape.defaults;
  return {
    shape: shape.id,
    x1: at.x + x1,
    y1: at.y + y1,
    x2: at.x + x2,
    y2: at.y + y2,
    ...style,
    startCap: preset.startCap ?? 'none',
    endCap: preset.endCap ?? 'none',
    ...knobs,
  };
}
