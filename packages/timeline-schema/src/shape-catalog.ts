/**
 * @framepilot/timeline-schema/shape-catalog — the shapes Elements offers (plan/elements 03 §1).
 *
 * PURE DATA. A descriptor says how a shape is placed (`frame`), which generator the engine draws
 * it with, which numeric knobs it takes and their bounds, its size when first placed, and its
 * named styles (presets). Renderers dispatch on `generator.kind`, never on a shape id, so adding
 * a shape is a change to this list (plus a generator when it needs a new one).
 *
 * `scripts/generate-json-schema.mjs` writes this catalogue to `schema/shape-catalog.json` and the
 * engine's copy (`framepilot_engine/render/shape_catalog.json`); both sides guard drift.
 *
 * Ids are persisted in `ShapeParams.shape` (and preset ids in the Shapes tab's recents): never
 * rename one.
 */

/** Where a shape sits in the Shapes tab. */
export const SHAPE_CATEGORIES = [
  'basic',
  'arrows',
  'lines',
  'callouts',
  'highlights',
  'stars',
  'frames',
  'symbols',
] as const;
export type ShapeCategory = (typeof SHAPE_CATEGORIES)[number];

/**
 * How the engine turns the params into outlines (`render/shape_geometry.py`):
 * `rect` a box with rounded corners (`cornerRadius`), `ellipse` the box's inscribed ellipse,
 * `segment` a straight line between the two ends with its caps.
 */
export const SHAPE_GENERATORS = ['rect', 'ellipse', 'segment'] as const;
export type ShapeGenerator = (typeof SHAPE_GENERATORS)[number];

export interface ShapeKnob {
  readonly name: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  /** How the knob reads in the Inspector. */
  readonly unit: '%' | '×';
  readonly hint: string;
}

/** A named style: the colours, stroke and caps a shape is inserted with. */
export interface ShapePreset {
  /** `<shapeId>/<style>`. Stable; never rename. */
  readonly id: string;
  /** The name the Shapes tab and History show ("Highlight box"). */
  readonly name: string;
  readonly fill: string | null;
  readonly stroke: string | null;
  readonly strokeWidth: number;
  readonly strokeStyle: 'solid' | 'dashed' | 'dotted';
  readonly startCap?: 'none' | 'arrow' | 'dot' | 'bar';
  readonly endCap?: 'none' | 'arrow' | 'dot' | 'bar';
  /** Knob values this style sets; absent knobs take the descriptor's default. */
  readonly knobs?: Readonly<Record<string, number>>;
}

/** Where a box shape lands: its size, percent of the frame height, centred on the target. */
export interface ShapeBoxDefaults {
  readonly width: number;
  readonly height: number;
}

/** Where a segment shape lands: its ends, percent of each axis, relative to the target point. */
export interface ShapeSegmentDefaults {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

interface ShapeDescriptorBase {
  readonly id: string;
  readonly name: string;
  readonly category: ShapeCategory;
  /** Words a search matches, beyond the name. */
  readonly tags: readonly string[];
  readonly generator: ShapeGenerator;
  readonly knobs: readonly ShapeKnob[];
  readonly presets: readonly ShapePreset[];
}

export interface BoxShapeDescriptor extends ShapeDescriptorBase {
  readonly frame: 'box';
  readonly defaults: ShapeBoxDefaults;
}

export interface SegmentShapeDescriptor extends ShapeDescriptorBase {
  readonly frame: 'segment';
  readonly defaults: ShapeSegmentDefaults;
}

export type ShapeDescriptor = BoxShapeDescriptor | SegmentShapeDescriptor;

const CORNER_RADIUS = (def: number): ShapeKnob => ({
  name: 'cornerRadius',
  label: 'Corners',
  min: 0,
  max: 50,
  default: def,
  unit: '%',
  hint: 'Corner radius, as a percent of the shorter side. 50 makes the ends fully round.',
});

const HEAD_SIZE: ShapeKnob = {
  name: 'headSize',
  label: 'Head size',
  min: 2,
  max: 8,
  default: 4,
  unit: '×',
  hint: 'How long an arrow head is, as a multiple of the stroke width.',
};

/**
 * The catalogue. Highlighter yellow `#FFD400`, attention red `#FF3B30` and white are the
 * screen-recording staples: they read on light and dark interfaces alike.
 */
export const SHAPE_CATALOG: readonly ShapeDescriptor[] = [
  {
    id: 'rounded-rect',
    name: 'Rounded rectangle',
    category: 'highlights',
    tags: ['box', 'rectangle', 'highlight', 'button', 'card', 'frame'],
    frame: 'box',
    generator: 'rect',
    knobs: [CORNER_RADIUS(12)],
    defaults: { width: 48, height: 27 },
    presets: [
      {
        id: 'rounded-rect/highlight',
        name: 'Highlight box',
        fill: null,
        stroke: '#FFD400',
        strokeWidth: 0.8,
        strokeStyle: 'solid',
      },
      {
        id: 'rounded-rect/filled',
        name: 'Filled box',
        fill: '#FFFFFF',
        stroke: null,
        strokeWidth: 0.8,
        strokeStyle: 'solid',
      },
    ],
  },
  {
    id: 'ellipse',
    name: 'Ellipse',
    category: 'basic',
    tags: ['circle', 'oval', 'ring', 'highlight'],
    frame: 'box',
    generator: 'ellipse',
    knobs: [],
    defaults: { width: 40, height: 28 },
    presets: [
      {
        id: 'ellipse/outline',
        name: 'Ellipse',
        fill: null,
        stroke: '#FF3B30',
        strokeWidth: 0.8,
        strokeStyle: 'solid',
      },
    ],
  },
  {
    id: 'marker-highlight',
    name: 'Marker highlight',
    category: 'highlights',
    tags: ['marker', 'highlighter', 'highlight', 'emphasis', 'text'],
    frame: 'box',
    generator: 'rect',
    knobs: [CORNER_RADIUS(8)],
    defaults: { width: 60, height: 10 },
    presets: [
      {
        id: 'marker-highlight/yellow',
        name: 'Marker',
        fill: '#FFD40066',
        stroke: null,
        strokeWidth: 0.8,
        strokeStyle: 'solid',
      },
    ],
  },
  {
    id: 'line-arrow',
    name: 'Arrow',
    category: 'arrows',
    tags: ['arrow', 'pointer', 'point', 'direction'],
    frame: 'segment',
    generator: 'segment',
    knobs: [HEAD_SIZE],
    defaults: { x1: -12, y1: -12, x2: 0, y2: 0 },
    presets: [
      {
        id: 'line-arrow/red',
        name: 'Arrow',
        fill: null,
        stroke: '#FF3B30',
        strokeWidth: 0.8,
        strokeStyle: 'solid',
        startCap: 'none',
        endCap: 'arrow',
      },
    ],
  },
  {
    id: 'underline-marker',
    name: 'Underline',
    category: 'highlights',
    tags: ['underline', 'line', 'marker', 'emphasis'],
    frame: 'segment',
    generator: 'segment',
    knobs: [],
    defaults: { x1: -15, y1: 0, x2: 15, y2: 0 },
    presets: [
      {
        id: 'underline-marker/yellow',
        name: 'Underline',
        fill: null,
        stroke: '#FFD400CC',
        strokeWidth: 1.2,
        strokeStyle: 'solid',
        startCap: 'none',
        endCap: 'none',
      },
    ],
  },
];

/** The preset `presetId` names, with its shape, or `undefined`. */
export function shapePreset(
  presetId: string,
): { readonly shape: ShapeDescriptor; readonly preset: ShapePreset } | undefined {
  for (const shape of SHAPE_CATALOG) {
    const preset = shape.presets.find((candidate) => candidate.id === presetId);
    if (preset !== undefined) return { shape, preset };
  }
  return undefined;
}

/** Every preset, in catalogue order: what the Shapes tab shows. */
export const SHAPE_PRESETS: readonly {
  readonly shape: ShapeDescriptor;
  readonly preset: ShapePreset;
}[] = SHAPE_CATALOG.flatMap((shape) => shape.presets.map((preset) => ({ shape, preset })));
