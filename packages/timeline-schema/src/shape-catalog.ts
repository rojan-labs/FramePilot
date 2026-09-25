/**
 * @framepilot/timeline-schema/shape-catalog — the shapes Elements offers (plan/elements 03 §1).
 *
 * PURE DATA. A descriptor says how a shape is placed (`frame`), which generator the engine draws
 * it with, which numeric knobs it takes and their bounds, its size when first placed, and its
 * named styles (presets). Renderers dispatch on `generator`, never on a shape id, so adding
 * a shape is a change to this list (plus a generator when it needs a new one).
 *
 * `scripts/generate-json-schema.mjs` writes this catalogue to `schema/shape-catalog.json` and the
 * engine's copy (`framepilot_engine/render/shape_catalog.json`); both sides guard drift.
 *
 * Ids are persisted in `ShapeParams.shape` (and preset ids in the Shapes tab's recents): never
 * rename one.
 */

import { SHAPE_ICON_NAMES } from './shape-icon-names.js';

export { SHAPE_ICON_NAMES };

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
  'numbers',
] as const;
export type ShapeCategory = (typeof SHAPE_CATEGORIES)[number];

/**
 * How the engine turns the params into outlines (`render/shape_geometry.py`):
 * `rect` a box with rounded corners (`cornerRadius`), `ellipse` the box's inscribed ellipse,
 * `segment` a line between two ends with caps (curved with a `curvature` knob), `polygon` a
 * regular polygon (`geometry.sides`), `star` (`points`, `innerRadius`), `ring` a box or ellipse
 * with a hole (`thickness`), `bubble` a rounded box with a tail (`tailX`, `tailSize`), `corners`
 * four corner marks (`length`), `path` an outline drawn on a 0–100 box (`geometry.path`, or
 * `geometry.icon`, a Lucide icon from the icon catalogue).
 */
export const SHAPE_GENERATORS = [
  'rect',
  'ellipse',
  'segment',
  'polygon',
  'star',
  'ring',
  'bubble',
  'corners',
  'path',
] as const;
export type ShapeGenerator = (typeof SHAPE_GENERATORS)[number];

export interface ShapeKnob {
  readonly name: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  /** How the knob reads in the Inspector. */
  readonly unit: '%' | '×' | '';
  readonly hint: string;
}

/**
 * Fixed settings of a shape's generator. `fillRule: 'evenodd'` makes overlapping closed pieces
 * holes (a ring, a frame); `roundCaps` rounds the open ends of a stroked path (icons).
 */
export interface ShapeGeometry {
  readonly sides?: number;
  readonly rotation?: number;
  readonly inner?: 'rect' | 'ellipse';
  readonly path?: string;
  readonly icon?: string;
  readonly fillRule?: 'nonzero' | 'evenodd';
  readonly roundCaps?: boolean;
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
  /** Numbered badges: the text drawn inside the shape (≤ 8 characters). */
  readonly label?: string;
  readonly labelColor?: string;
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
  readonly geometry?: ShapeGeometry;
  readonly knobs: readonly ShapeKnob[];
  /** Badges draw a `label` inside the shape (plan/elements EL5.4). */
  readonly labelled?: boolean;
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

// --- knobs ------------------------------------------------------------------------------------

const knob = (
  name: string,
  label: string,
  min: number,
  max: number,
  def: number,
  unit: ShapeKnob['unit'],
  hint: string,
): ShapeKnob => ({ name, label, min, max, default: def, unit, hint });

const CORNER_RADIUS = (def: number): ShapeKnob =>
  knob(
    'cornerRadius',
    'Corners',
    0,
    50,
    def,
    '%',
    'Corner radius, as a percent of the shorter side. 50 makes the ends fully round.',
  );
const HEAD_SIZE = knob(
  'headSize',
  'Head size',
  2,
  8,
  4,
  '×',
  'How long an arrow head is, as a multiple of the stroke width.',
);
const CURVATURE = (def: number): ShapeKnob =>
  knob(
    'curvature',
    'Curve',
    -100,
    100,
    def,
    '%',
    'How far the line bows out, as a percent of half its length; negative bows the other way.',
  );
const POINTS = (def: number): ShapeKnob =>
  knob('points', 'Points', 3, 24, def, '', 'How many points the star has.');
const INNER_RADIUS = (def: number): ShapeKnob =>
  knob(
    'innerRadius',
    'Inner radius',
    10,
    95,
    def,
    '%',
    'How deep the points are cut: the inner corners as a percent of the outer radius.',
  );
const THICKNESS = (def: number): ShapeKnob =>
  knob('thickness', 'Thickness', 2, 45, def, '%', 'The border, as a percent of the shorter side.');
const TAIL_X = knob(
  'tailX',
  'Tail position',
  5,
  95,
  30,
  '%',
  'Where the tail points, across the bottom edge.',
);
const TAIL_SIZE = knob(
  'tailSize',
  'Tail length',
  5,
  45,
  22,
  '%',
  'How long the tail is, as a percent of the height.',
);
const CORNER_LENGTH = knob(
  'length',
  'Corner length',
  5,
  50,
  22,
  '%',
  'How long each corner mark is, as a percent of the shorter side.',
);

// --- paths on a 0–100 box -------------------------------------------------------------------

const num = (value: number): string => String(Math.round(value * 100) / 100);
const move = (x: number, y: number): string => `M ${num(x)} ${num(y)}`;
const line = (x: number, y: number): string => `L ${num(x)} ${num(y)}`;
const curve = (a: number, b: number, c: number, d: number, e: number, f: number): string =>
  `C ${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(e)} ${num(f)}`;
const KAPPA = 0.5522847498;

/** A closed polygon through the points. */
function polygonPath(points: readonly (readonly [number, number])[]): string {
  return [...points.map(([x, y], i) => (i === 0 ? move(x, y) : line(x, y))), 'Z'].join(' ');
}

/** An open polyline through the points. */
function polylinePath(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y], i) => (i === 0 ? move(x, y) : line(x, y))).join(' ');
}

/** An ellipse as four cubic quarter arcs. */
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  const k = KAPPA;
  return [
    move(cx + rx, cy),
    curve(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry),
    curve(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy),
    curve(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry),
    curve(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy),
    'Z',
  ].join(' ');
}

/** A sine wave across the box, `waves` periods of `amplitude` about the middle. */
function wavePath(waves: number, amplitude: number): string {
  const points: [number, number][] = [];
  for (let i = 0; i <= 64; i += 1) {
    const x = (i / 64) * 100;
    points.push([x, 50 - amplitude * Math.sin((x / 100) * waves * 2 * Math.PI)]);
  }
  return polylinePath(points);
}

/** A zigzag across the box. */
function zigzagPath(teeth: number, amplitude: number): string {
  const points: [number, number][] = [];
  for (let i = 0; i <= teeth * 2; i += 1) {
    points.push([(i / (teeth * 2)) * 100, i % 2 === 0 ? 50 + amplitude : 50 - amplitude]);
  }
  return polylinePath(points);
}

/**
 * A loop that looks drawn by hand: an ellipse whose radius wobbles, going round a little more
 * than once. Deterministic (the wobble is a fixed sum of sines, not random).
 */
function handDrawnLoop(): string {
  const points: [number, number][] = [];
  const turns = 1.12;
  for (let i = 0; i <= 96; i += 1) {
    const t = (i / 96) * turns * 2 * Math.PI - Math.PI * 0.6;
    const wobble = 1 + 0.04 * Math.sin(3 * t) + 0.025 * Math.sin(5 * t + 1);
    const shrink = 1 - 0.05 * (i / 96);
    points.push([50 + 47 * wobble * shrink * Math.cos(t), 50 + 45 * wobble * shrink * Math.sin(t)]);
  }
  return polylinePath(points);
}

/** A box that looks drawn by hand: four slightly bowed strokes that overshoot at the corners. */
function handDrawnBox(): string {
  return [
    move(6, 8),
    curve(35, 5, 70, 7, 96, 5),
    move(94, 3),
    curve(96, 35, 95, 70, 97, 96),
    move(99, 94),
    curve(65, 96, 30, 95, 4, 97),
    move(6, 99),
    curve(4, 65, 5, 30, 3, 4),
  ].join(' ');
}

/** Concentric circles (a click ripple). */
function ripplePath(): string {
  return [
    ellipsePath(50, 50, 48, 48),
    ellipsePath(50, 50, 32, 32),
    ellipsePath(50, 50, 14, 14),
  ].join(' ');
}

/** A thought bubble: a cloud-ish ellipse and two trailing circles. */
function thoughtBubblePath(): string {
  return [ellipsePath(55, 38, 44, 36), ellipsePath(22, 82, 9, 8), ellipsePath(9, 95, 5, 4.5)].join(
    ' ',
  );
}

/** A rectangle outline inset by `inset` (for double frames). */
function rectPath(inset: number): string {
  return polygonPath([
    [inset, inset],
    [100 - inset, inset],
    [100 - inset, 100 - inset],
    [inset, 100 - inset],
  ]);
}

// --- presets ----------------------------------------------------------------------------------

const WHITE = '#FFFFFF';
const BLACK = '#111111';
const YELLOW = '#FFD400';
const RED = '#FF3B30';
const BLUE = '#0A84FF';
const GREEN = '#34C759';

type PresetStyle = Omit<ShapePreset, 'id' | 'name'>;

const solid = (fill: string): PresetStyle => ({
  fill,
  stroke: null,
  strokeWidth: 0.8,
  strokeStyle: 'solid',
});
const outline = (stroke: string, strokeWidth = 0.8): PresetStyle => ({
  fill: null,
  stroke,
  strokeWidth,
  strokeStyle: 'solid',
});
const outlined = (fill: string, stroke: string): PresetStyle => ({
  fill,
  stroke,
  strokeWidth: 0.4,
  strokeStyle: 'solid',
});

/**
 * The three styles every basic shape offers (03 §1.2): solid, outline, translucent. Colours are
 * the Shapes tab's colour row, not more presets.
 */
function basicPresets(id: string, name: string): ShapePreset[] {
  const lower = name.toLowerCase();
  return [
    { id: `${id}/white`, name, ...solid(WHITE) },
    { id: `${id}/outline`, name: `${name} outline`, ...outline(WHITE) },
    { id: `${id}/translucent`, name: `Translucent ${lower}`, ...solid('#FFFFFF66') },
  ];
}

/** Line and arrow styles that read on any footage: white, and attention red. */
function linePresets(
  id: string,
  name: string,
  caps: Pick<ShapePreset, 'startCap' | 'endCap'>,
  width = 0.8,
  style: ShapePreset['strokeStyle'] = 'solid',
): ShapePreset[] {
  return [
    { id: `${id}/white`, name, ...outline(WHITE, width), strokeStyle: style, ...caps },
    {
      id: `${id}/red`,
      name: `Red ${name.toLowerCase()}`,
      ...outline(RED, width),
      strokeStyle: style,
      ...caps,
    },
  ];
}

/** Highlight and focus styles: highlighter yellow and attention red. */
function highlightPresets(id: string, name: string, width = 0.8): ShapePreset[] {
  return [
    { id: `${id}/yellow`, name, ...outline(YELLOW, width) },
    { id: `${id}/red`, name: `Red ${name.toLowerCase()}`, ...outline(RED, width) },
  ];
}

/** Icon-like styles for symbols: white and yellow outlines. */
function symbolPresets(id: string, name: string): ShapePreset[] {
  return [
    { id: `${id}/white`, name, ...outline(WHITE, 1) },
    { id: `${id}/yellow`, name: `Yellow ${name.toLowerCase()}`, ...outline(YELLOW, 1) },
  ];
}

/**
 * Numbered badges: red and white, numbered up to `count`. The number is the `label` param, so any
 * badge takes any number in the Inspector; the tiles are the common first steps.
 */
function badgePresets(id: string, name: string, count: number): ShapePreset[] {
  const colours: readonly (readonly [string, string, string, string])[] = [
    ['red', 'Red', RED, WHITE],
    ['white', 'White', WHITE, BLACK],
  ];
  return colours.flatMap(([key, label, fill, labelColor]) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${id}/${key}-${String(index + 1)}`,
      name: `${label} ${name.toLowerCase()} ${String(index + 1)}`,
      ...solid(fill),
      label: String(index + 1),
      labelColor,
    })),
  );
}

// --- descriptors ------------------------------------------------------------------------------

type BoxInput = Omit<BoxShapeDescriptor, 'frame' | 'knobs' | 'presets'> & {
  readonly knobs?: readonly ShapeKnob[];
  readonly presets?: readonly ShapePreset[];
};
type SegmentInput = Omit<SegmentShapeDescriptor, 'frame' | 'knobs' | 'presets'> & {
  readonly knobs?: readonly ShapeKnob[];
  readonly presets?: readonly ShapePreset[];
};

function box(input: BoxInput): BoxShapeDescriptor {
  return {
    ...input,
    frame: 'box',
    knobs: input.knobs ?? [],
    presets: input.presets ?? basicPresets(input.id, input.name),
  };
}

function segment(input: SegmentInput): SegmentShapeDescriptor {
  return { ...input, frame: 'segment', knobs: input.knobs ?? [], presets: input.presets ?? [] };
}

const WIDE = { width: 36, height: 24 } as const;
const SQUARE = { width: 24, height: 24 } as const;
const ARROW_ENDS = { x1: -12, y1: -12, x2: 0, y2: 0 } as const;
const LINE_ENDS = { x1: -15, y1: 0, x2: 15, y2: 0 } as const;

/** A box shape drawn from a Lucide icon's outline (`geometry.icon`). */
function iconShape(
  id: string,
  name: string,
  category: ShapeCategory,
  tags: readonly string[],
  icon: string,
  presets: readonly ShapePreset[],
  defaults: ShapeBoxDefaults = SQUARE,
): BoxShapeDescriptor {
  return box({
    id,
    name,
    category,
    tags,
    generator: 'path',
    geometry: { icon, roundCaps: true },
    defaults,
    presets,
  });
}

/**
 * The catalogue. The first five shapes and their six presets are the screen-recording staples
 * EL4a shipped; their ids are persisted and never change. Highlighter yellow `#FFD400`,
 * attention red `#FF3B30` and white read on light and dark interfaces alike.
 */
export const SHAPE_CATALOG: readonly ShapeDescriptor[] = [
  // --- the EL4a staples (ids persisted) ----------------------------------------------------
  box({
    id: 'rounded-rect',
    name: 'Rounded rectangle',
    category: 'highlights',
    tags: ['box', 'rectangle', 'highlight', 'button', 'card', 'frame'],
    generator: 'rect',
    knobs: [CORNER_RADIUS(12)],
    defaults: { width: 48, height: 27 },
    presets: [
      { id: 'rounded-rect/highlight', name: 'Highlight box', ...outline(YELLOW) },
      { id: 'rounded-rect/filled', name: 'Filled box', ...solid(WHITE) },
      { id: 'rounded-rect/red', name: 'Red highlight box', ...outline(RED) },
      { id: 'rounded-rect/translucent', name: 'Translucent box', ...solid('#FFFFFF66') },
    ],
  }),
  box({
    id: 'ellipse',
    name: 'Ellipse',
    category: 'basic',
    tags: ['circle', 'oval', 'ring', 'highlight'],
    generator: 'ellipse',
    defaults: { width: 40, height: 28 },
    presets: [
      { id: 'ellipse/outline', name: 'Ellipse', ...outline(RED) },
      { id: 'ellipse/white', name: 'White ellipse', ...solid(WHITE) },
    ],
  }),
  box({
    id: 'marker-highlight',
    name: 'Marker highlight',
    category: 'highlights',
    tags: ['marker', 'highlighter', 'highlight', 'emphasis', 'text'],
    generator: 'rect',
    knobs: [CORNER_RADIUS(8)],
    defaults: { width: 60, height: 10 },
    presets: [
      { id: 'marker-highlight/yellow', name: 'Marker', ...solid('#FFD40066') },
      { id: 'marker-highlight/green', name: 'Green marker', ...solid(`${GREEN}66`) },
      { id: 'marker-highlight/pink', name: 'Pink marker', ...solid('#FF2D5566') },
    ],
  }),
  segment({
    id: 'line-arrow',
    name: 'Arrow',
    category: 'arrows',
    tags: ['arrow', 'pointer', 'point', 'direction'],
    generator: 'segment',
    knobs: [HEAD_SIZE],
    defaults: ARROW_ENDS,
    presets: [
      { id: 'line-arrow/red', name: 'Arrow', ...outline(RED), startCap: 'none', endCap: 'arrow' },
      {
        id: 'line-arrow/white',
        name: 'White arrow',
        ...outline(WHITE),
        startCap: 'none',
        endCap: 'arrow',
      },
    ],
  }),
  segment({
    id: 'underline-marker',
    name: 'Underline',
    category: 'highlights',
    tags: ['underline', 'line', 'marker', 'emphasis'],
    generator: 'segment',
    defaults: LINE_ENDS,
    presets: [
      {
        id: 'underline-marker/yellow',
        name: 'Underline',
        ...outline('#FFD400CC', 1.2),
        startCap: 'none',
        endCap: 'none',
      },
      {
        id: 'underline-marker/red',
        name: 'Red underline',
        ...outline('#FF3B30CC', 1.2),
        startCap: 'none',
        endCap: 'none',
      },
    ],
  }),

  // --- basic --------------------------------------------------------------------------------
  box({
    id: 'rectangle',
    name: 'Rectangle',
    category: 'basic',
    tags: ['box', 'square'],
    generator: 'rect',
    knobs: [CORNER_RADIUS(0)],
    defaults: WIDE,
  }),
  box({
    id: 'square',
    name: 'Square',
    category: 'basic',
    tags: ['box'],
    generator: 'rect',
    knobs: [CORNER_RADIUS(0)],
    defaults: SQUARE,
  }),
  box({
    id: 'rounded-square',
    name: 'Rounded square',
    category: 'basic',
    tags: ['box', 'tile'],
    generator: 'rect',
    knobs: [CORNER_RADIUS(20)],
    defaults: SQUARE,
  }),
  box({
    id: 'pill',
    name: 'Pill',
    category: 'basic',
    tags: ['capsule', 'button', 'label'],
    generator: 'rect',
    knobs: [CORNER_RADIUS(50)],
    defaults: { width: 40, height: 14 },
  }),
  box({
    id: 'circle',
    name: 'Circle',
    category: 'basic',
    tags: ['round', 'dot', 'ring'],
    generator: 'ellipse',
    defaults: SQUARE,
  }),
  box({
    id: 'semicircle',
    name: 'Semicircle',
    category: 'basic',
    tags: ['half circle', 'dome'],
    generator: 'path',
    geometry: {
      path: [
        move(0, 100),
        curve(0, 44.77, 22.39, 0, 50, 0),
        curve(77.61, 0, 100, 44.77, 100, 100),
        'Z',
      ].join(' '),
    },
    defaults: { width: 30, height: 15 },
  }),
  box({
    id: 'quarter-circle',
    name: 'Quarter circle',
    category: 'basic',
    tags: ['quadrant', 'pie'],
    generator: 'path',
    geometry: {
      path: [move(0, 100), line(0, 0), curve(55.23, 0, 100, 44.77, 100, 100), 'Z'].join(' '),
    },
    defaults: SQUARE,
  }),
  box({
    id: 'triangle',
    name: 'Triangle',
    category: 'basic',
    tags: ['arrow', 'play'],
    generator: 'polygon',
    geometry: { sides: 3 },
    defaults: SQUARE,
  }),
  box({
    id: 'right-triangle',
    name: 'Right triangle',
    category: 'basic',
    tags: ['corner'],
    generator: 'path',
    geometry: {
      path: polygonPath([
        [0, 100],
        [0, 0],
        [100, 100],
      ]),
    },
    defaults: SQUARE,
  }),
  box({
    id: 'diamond',
    name: 'Diamond',
    category: 'basic',
    tags: ['rhombus', 'gem'],
    generator: 'polygon',
    geometry: { sides: 4 },
    defaults: SQUARE,
  }),
  box({
    id: 'pentagon',
    name: 'Pentagon',
    category: 'basic',
    tags: ['polygon'],
    generator: 'polygon',
    geometry: { sides: 5 },
    defaults: SQUARE,
  }),
  box({
    id: 'hexagon',
    name: 'Hexagon',
    category: 'basic',
    tags: ['polygon', 'honeycomb'],
    generator: 'polygon',
    geometry: { sides: 6, rotation: 30 },
    defaults: SQUARE,
  }),
  box({
    id: 'octagon',
    name: 'Octagon',
    category: 'basic',
    tags: ['polygon', 'stop'],
    generator: 'polygon',
    geometry: { sides: 8, rotation: 22.5 },
    defaults: SQUARE,
  }),
  box({
    id: 'parallelogram',
    name: 'Parallelogram',
    category: 'basic',
    tags: ['slanted', 'skew'],
    generator: 'path',
    geometry: {
      path: polygonPath([
        [25, 0],
        [100, 0],
        [75, 100],
        [0, 100],
      ]),
    },
    defaults: WIDE,
  }),
  box({
    id: 'trapezoid',
    name: 'Trapezoid',
    category: 'basic',
    tags: ['trapezium'],
    generator: 'path',
    geometry: {
      path: polygonPath([
        [20, 0],
        [80, 0],
        [100, 100],
        [0, 100],
      ]),
    },
    defaults: WIDE,
  }),

  // --- arrows -------------------------------------------------------------------------------
  box({
    id: 'block-arrow',
    name: 'Block arrow',
    category: 'arrows',
    tags: ['arrow', 'direction', 'next'],
    generator: 'path',
    geometry: {
      path: polygonPath([
        [0, 30],
        [60, 30],
        [60, 5],
        [100, 50],
        [60, 95],
        [60, 70],
        [0, 70],
      ]),
    },
    defaults: { width: 36, height: 20 },
  }),
  segment({
    id: 'double-arrow',
    name: 'Double arrow',
    category: 'arrows',
    tags: ['arrow', 'both ways', 'between'],
    generator: 'segment',
    knobs: [HEAD_SIZE],
    defaults: LINE_ENDS,
    presets: linePresets('double-arrow', 'Double arrow', { startCap: 'arrow', endCap: 'arrow' }),
  }),
  segment({
    id: 'curved-arrow',
    name: 'Curved arrow',
    category: 'arrows',
    tags: ['arrow', 'curve', 'bend', 'swoop'],
    generator: 'segment',
    knobs: [HEAD_SIZE, CURVATURE(45)],
    defaults: ARROW_ENDS,
    presets: linePresets('curved-arrow', 'Curved arrow', { startCap: 'none', endCap: 'arrow' }),
  }),
  iconShape(
    'u-turn-arrow',
    'U-turn arrow',
    'arrows',
    ['arrow', 'back', 'return'],
    'undo-2',
    linePresets('u-turn-arrow', 'U-turn arrow', {}, 1),
  ),
  iconShape(
    'circular-arrow',
    'Circular arrow',
    'arrows',
    ['arrow', 'loop', 'rotate', 'refresh'],
    'rotate-cw',
    linePresets('circular-arrow', 'Circular arrow', {}, 1),
  ),
  iconShape(
    'chevron',
    'Chevron',
    'arrows',
    ['arrow', 'next', 'caret'],
    'chevron-right',
    linePresets('chevron', 'Chevron', {}, 1.4),
  ),
  iconShape(
    'double-chevron',
    'Double chevron',
    'arrows',
    ['arrow', 'fast forward'],
    'chevrons-right',
    linePresets('double-chevron', 'Double chevron', {}, 1.4),
  ),
  box({
    id: 'caret-pointer',
    name: 'Caret pointer',
    category: 'arrows',
    tags: ['arrow', 'triangle', 'pointer'],
    generator: 'path',
    geometry: {
      path: polygonPath([
        [0, 0],
        [100, 50],
        [0, 100],
        [25, 50],
      ]),
    },
    defaults: { width: 16, height: 16 },
  }),
  segment({
    id: 'dotted-arrow',
    name: 'Dotted-tail arrow',
    category: 'arrows',
    tags: ['arrow', 'dotted', 'path'],
    generator: 'segment',
    knobs: [HEAD_SIZE],
    defaults: ARROW_ENDS,
    presets: linePresets(
      'dotted-arrow',
      'Dotted arrow',
      { startCap: 'none', endCap: 'arrow' },
      0.8,
      'dotted',
    ),
  }),
  box({
    id: 'hand-drawn-arrow',
    name: 'Hand-drawn arrow',
    category: 'arrows',
    tags: ['arrow', 'sketch', 'doodle'],
    generator: 'path',
    geometry: {
      path: [
        move(4, 80),
        curve(25, 60, 45, 70, 62, 42),
        curve(70, 30, 78, 22, 92, 12),
        move(72, 10),
        line(93, 11),
        line(88, 32),
      ].join(' '),
      roundCaps: true,
    },
    defaults: SQUARE,
    presets: linePresets('hand-drawn-arrow', 'Hand-drawn arrow', {}, 1),
  }),
  iconShape(
    'elbow-arrow',
    'Elbow arrow',
    'arrows',
    ['arrow', 'corner', 'turn'],
    'corner-down-right',
    linePresets('elbow-arrow', 'Elbow arrow', {}, 1),
  ),
  box({
    id: 'zigzag-arrow',
    name: 'Zigzag arrow',
    category: 'arrows',
    tags: ['arrow', 'lightning', 'bounce'],
    generator: 'path',
    geometry: {
      path: [
        polylinePath([
          [4, 70],
          [30, 40],
          [50, 62],
          [90, 22],
        ]),
        move(70, 20),
        line(91, 21),
        line(90, 42),
      ].join(' '),
      roundCaps: true,
    },
    defaults: SQUARE,
    presets: linePresets('zigzag-arrow', 'Zigzag arrow', {}, 1),
  }),
  iconShape(
    'cursor-pointer',
    'Cursor',
    'arrows',
    ['mouse', 'pointer', 'click', 'cursor'],
    'mouse-pointer-2',
    [
      { id: 'cursor-pointer/white', name: 'Cursor', ...outlined(WHITE, BLACK) },
      { id: 'cursor-pointer/black', name: 'Black cursor', ...outlined(BLACK, WHITE) },
      { id: 'cursor-pointer/red', name: 'Red cursor', ...outlined(RED, WHITE) },
    ],
    { width: 10, height: 10 },
  ),
  box({
    id: 'arrow-head',
    name: 'Arrow head',
    category: 'arrows',
    tags: ['arrow', 'triangle', 'tip'],
    generator: 'polygon',
    geometry: { sides: 3, rotation: 90 },
    defaults: { width: 12, height: 12 },
  }),

  // --- lines and dividers ---------------------------------------------------------------------
  segment({
    id: 'line',
    name: 'Line',
    category: 'lines',
    tags: ['line', 'rule', 'divider'],
    generator: 'segment',
    defaults: LINE_ENDS,
    presets: linePresets('line', 'Line', { startCap: 'none', endCap: 'none' }),
  }),
  segment({
    id: 'dashed-line',
    name: 'Dashed line',
    category: 'lines',
    tags: ['line', 'dashes'],
    generator: 'segment',
    defaults: LINE_ENDS,
    presets: linePresets(
      'dashed-line',
      'Dashed line',
      { startCap: 'none', endCap: 'none' },
      0.8,
      'dashed',
    ),
  }),
  segment({
    id: 'dotted-line',
    name: 'Dotted line',
    category: 'lines',
    tags: ['line', 'dots'],
    generator: 'segment',
    defaults: LINE_ENDS,
    presets: linePresets(
      'dotted-line',
      'Dotted line',
      { startCap: 'none', endCap: 'none' },
      1,
      'dotted',
    ),
  }),
  box({
    id: 'double-line',
    name: 'Double line',
    category: 'lines',
    tags: ['line', 'rule', 'equals'],
    generator: 'path',
    geometry: {
      path: [
        polylinePath([
          [0, 30],
          [100, 30],
        ]),
        polylinePath([
          [0, 70],
          [100, 70],
        ]),
      ].join(' '),
    },
    defaults: { width: 40, height: 4 },
    presets: linePresets('double-line', 'Double line', {}, 0.5),
  }),
  segment({
    id: 'thick-line',
    name: 'Thick line',
    category: 'lines',
    tags: ['line', 'bar', 'rule'],
    generator: 'segment',
    defaults: LINE_ENDS,
    presets: linePresets('thick-line', 'Thick line', { startCap: 'none', endCap: 'none' }, 2.4),
  }),
  box({
    id: 'wavy-line',
    name: 'Wavy line',
    category: 'lines',
    tags: ['wave', 'squiggle', 'underline'],
    generator: 'path',
    geometry: { path: wavePath(3, 40), roundCaps: true },
    defaults: { width: 40, height: 6 },
    presets: linePresets('wavy-line', 'Wavy line', {}, 0.8),
  }),
  box({
    id: 'zigzag-line',
    name: 'Zigzag line',
    category: 'lines',
    tags: ['zigzag', 'saw'],
    generator: 'path',
    geometry: { path: zigzagPath(6, 40), roundCaps: true },
    defaults: { width: 40, height: 6 },
    presets: linePresets('zigzag-line', 'Zigzag line', {}, 0.8),
  }),
  box({
    id: 'underline-swoosh',
    name: 'Underline swoosh',
    category: 'lines',
    tags: ['underline', 'swoosh', 'brush'],
    generator: 'path',
    geometry: { path: [move(2, 70), curve(30, 40, 70, 30, 98, 45)].join(' '), roundCaps: true },
    defaults: { width: 40, height: 8 },
    presets: linePresets('underline-swoosh', 'Swoosh', {}, 1.2),
  }),
  box({
    id: 'divider-dot',
    name: 'Divider with dot',
    category: 'lines',
    tags: ['divider', 'separator'],
    generator: 'path',
    geometry: {
      path: [
        polylinePath([
          [0, 50],
          [42, 50],
        ]),
        polylinePath([
          [58, 50],
          [100, 50],
        ]),
        ellipsePath(50, 50, 3, 30),
      ].join(' '),
    },
    defaults: { width: 40, height: 4 },
    presets: linePresets('divider-dot', 'Divider', {}, 0.5),
  }),
  iconShape(
    'curly-brace',
    'Curly brace',
    'lines',
    ['brace', 'bracket', 'group'],
    'braces',
    linePresets('curly-brace', 'Curly brace', {}, 1),
  ),

  // --- callouts and bubbles ----------------------------------------------------------------------
  box({
    id: 'speech-bubble',
    name: 'Speech bubble',
    category: 'callouts',
    tags: ['speech', 'bubble', 'talk', 'quote'],
    generator: 'bubble',
    knobs: [CORNER_RADIUS(25), TAIL_X, TAIL_SIZE],
    defaults: { width: 40, height: 30 },
  }),
  box({
    id: 'speech-bubble-square',
    name: 'Square speech bubble',
    category: 'callouts',
    tags: ['speech', 'bubble', 'comic'],
    generator: 'bubble',
    knobs: [CORNER_RADIUS(0), TAIL_X, TAIL_SIZE],
    defaults: { width: 40, height: 30 },
  }),
  box({
    id: 'chat-bubble',
    name: 'Chat bubble',
    category: 'callouts',
    tags: ['chat', 'message', 'bubble'],
    generator: 'bubble',
    knobs: [CORNER_RADIUS(45), TAIL_X, TAIL_SIZE],
    defaults: { width: 40, height: 26 },
  }),
  box({
    id: 'tooltip',
    name: 'Tooltip',
    category: 'callouts',
    tags: ['tooltip', 'hint', 'label'],
    generator: 'bubble',
    knobs: [CORNER_RADIUS(15), { ...TAIL_X, default: 50 }, { ...TAIL_SIZE, default: 18 }],
    defaults: { width: 30, height: 16 },
  }),
  box({
    id: 'thought-bubble',
    name: 'Thought bubble',
    category: 'callouts',
    tags: ['thought', 'think', 'dream'],
    generator: 'path',
    geometry: { path: thoughtBubblePath() },
    defaults: { width: 40, height: 32 },
  }),
  box({
    id: 'shout-bubble',
    name: 'Shout bubble',
    category: 'callouts',
    tags: ['shout', 'burst', 'boom', 'comic'],
    generator: 'star',
    knobs: [POINTS(14), INNER_RADIUS(72)],
    defaults: { width: 40, height: 30 },
  }),
  iconShape(
    'callout-leader',
    'Callout with leader line',
    'callouts',
    ['callout', 'label', 'annotation'],
    'message-square-text',
    symbolPresets('callout-leader', 'Callout'),
    SQUARE,
  ),
  box({
    id: 'pill-label',
    name: 'Pill label',
    category: 'callouts',
    tags: ['label', 'tag', 'chip'],
    generator: 'rect',
    knobs: [CORNER_RADIUS(50)],
    defaults: { width: 30, height: 10 },
  }),
  iconShape(
    'banner-ribbon',
    'Banner ribbon',
    'callouts',
    ['banner', 'ribbon', 'award'],
    'ribbon',
    symbolPresets('banner-ribbon', 'Ribbon'),
  ),
  iconShape('tag', 'Tag', 'callouts', ['tag', 'price', 'label'], 'tag', [
    { id: 'tag/white', name: 'Tag', ...outlined(WHITE, BLACK) },
    { id: 'tag/red', name: 'Red tag', ...outlined(RED, WHITE) },
    { id: 'tag/yellow', name: 'Yellow tag', ...outlined(YELLOW, BLACK) },
  ]),
  iconShape('sticky-note', 'Sticky note', 'callouts', ['note', 'post-it', 'memo'], 'sticky-note', [
    { id: 'sticky-note/yellow', name: 'Sticky note', ...outlined('#FFE066', '#6B5A00') },
    { id: 'sticky-note/white', name: 'White sticky note', ...outlined(WHITE, BLACK) },
  ]),

  // --- highlights and focus ----------------------------------------------------------------------
  box({
    id: 'highlight-circle',
    name: 'Highlight circle',
    category: 'highlights',
    tags: ['circle', 'ring', 'highlight'],
    generator: 'ellipse',
    defaults: SQUARE,
    presets: highlightPresets('highlight-circle', 'Highlight circle'),
  }),
  box({
    id: 'hand-drawn-circle',
    name: 'Hand-drawn circle',
    category: 'highlights',
    tags: ['circle', 'sketch', 'loop', 'doodle'],
    generator: 'path',
    geometry: { path: handDrawnLoop(), roundCaps: true },
    defaults: WIDE,
    presets: highlightPresets('hand-drawn-circle', 'Hand-drawn circle', 1),
  }),
  box({
    id: 'hand-drawn-box',
    name: 'Hand-drawn box',
    category: 'highlights',
    tags: ['box', 'sketch', 'doodle'],
    generator: 'path',
    geometry: { path: handDrawnBox(), roundCaps: true },
    defaults: WIDE,
    presets: highlightPresets('hand-drawn-box', 'Hand-drawn box', 1),
  }),
  box({
    id: 'viewfinder-corners',
    name: 'Viewfinder corners',
    category: 'highlights',
    tags: ['corners', 'focus', 'frame', 'camera'],
    generator: 'corners',
    knobs: [CORNER_LENGTH],
    defaults: WIDE,
    presets: highlightPresets('viewfinder-corners', 'Viewfinder corners', 0.8),
  }),
  iconShape(
    'crosshair',
    'Crosshair',
    'highlights',
    ['target', 'aim', 'focus'],
    'crosshair',
    highlightPresets('crosshair', 'Crosshair', 1),
  ),
  box({
    id: 'spotlight-ring',
    name: 'Spotlight ring',
    category: 'highlights',
    tags: ['ring', 'spotlight', 'focus'],
    generator: 'ring',
    geometry: { inner: 'ellipse', fillRule: 'evenodd' },
    knobs: [THICKNESS(10)],
    defaults: SQUARE,
    presets: [
      { id: 'spotlight-ring/yellow', name: 'Spotlight ring', ...solid('#FFD400CC') },
      { id: 'spotlight-ring/white', name: 'White spotlight ring', ...solid('#FFFFFFCC') },
    ],
  }),
  box({
    id: 'click-ripple',
    name: 'Click ripple',
    category: 'highlights',
    tags: ['click', 'tap', 'ripple', 'touch'],
    generator: 'path',
    geometry: { path: ripplePath() },
    defaults: { width: 12, height: 12 },
    presets: highlightPresets('click-ripple', 'Click ripple', 0.5),
  }),
  box({
    id: 'cursor-halo',
    name: 'Cursor halo',
    category: 'highlights',
    tags: ['cursor', 'halo', 'glow', 'mouse'],
    generator: 'ellipse',
    defaults: { width: 8, height: 8 },
    presets: [
      { id: 'cursor-halo/yellow', name: 'Cursor halo', ...solid('#FFD40080') },
      { id: 'cursor-halo/red', name: 'Red cursor halo', ...solid('#FF3B3080') },
    ],
  }),
  iconShape(
    'square-brackets',
    'Square brackets',
    'highlights',
    ['brackets', 'focus', 'select'],
    'brackets',
    highlightPresets('square-brackets', 'Square brackets', 1),
  ),

  // --- stars and badges -----------------------------------------------------------------------------
  box({
    id: 'star-5',
    name: 'Star',
    category: 'stars',
    tags: ['star', 'favourite', 'rating'],
    generator: 'star',
    knobs: [POINTS(5), INNER_RADIUS(45)],
    defaults: SQUARE,
  }),
  box({
    id: 'star-4',
    name: 'Four-point star',
    category: 'stars',
    tags: ['star', 'twinkle'],
    generator: 'star',
    knobs: [POINTS(4), INNER_RADIUS(35)],
    defaults: SQUARE,
  }),
  box({
    id: 'star-6',
    name: 'Six-point star',
    category: 'stars',
    tags: ['star', 'hexagram'],
    generator: 'star',
    knobs: [POINTS(6), INNER_RADIUS(55)],
    defaults: SQUARE,
  }),
  box({
    id: 'star-8',
    name: 'Eight-point star',
    category: 'stars',
    tags: ['star', 'compass'],
    generator: 'star',
    knobs: [POINTS(8), INNER_RADIUS(50)],
    defaults: SQUARE,
  }),
  iconShape('sparkle', 'Sparkle', 'stars', ['sparkle', 'shine', 'magic', 'new'], 'sparkle', [
    { id: 'sparkle/yellow', name: 'Sparkle', ...outlined(YELLOW, YELLOW) },
    { id: 'sparkle/white', name: 'White sparkle', ...outlined(WHITE, WHITE) },
  ]),
  box({
    id: 'starburst-16',
    name: 'Starburst',
    category: 'stars',
    tags: ['burst', 'sale', 'badge'],
    generator: 'star',
    knobs: [POINTS(16), INNER_RADIUS(80)],
    defaults: SQUARE,
  }),
  box({
    id: 'starburst-24',
    name: 'Dense starburst',
    category: 'stars',
    tags: ['burst', 'seal', 'badge'],
    generator: 'star',
    knobs: [POINTS(24), INNER_RADIUS(86)],
    defaults: SQUARE,
  }),
  box({
    id: 'seal',
    name: 'Seal',
    category: 'stars',
    tags: ['seal', 'badge', 'stamp'],
    generator: 'star',
    knobs: [POINTS(20), INNER_RADIUS(90)],
    defaults: SQUARE,
  }),
  iconShape('shield', 'Shield', 'stars', ['shield', 'security', 'badge'], 'shield', [
    { id: 'shield/blue', name: 'Shield', ...outlined(BLUE, WHITE) },
    { id: 'shield/white', name: 'White shield', ...outlined(WHITE, BLACK) },
  ]),
  iconShape(
    'rosette',
    'Rosette',
    'stars',
    ['award', 'prize', 'rosette', 'medal'],
    'award',
    symbolPresets('rosette', 'Rosette'),
  ),
  iconShape(
    'banner',
    'Banner',
    'stars',
    ['flag', 'banner'],
    'flag',
    symbolPresets('banner', 'Banner'),
  ),
  iconShape(
    'ribbon-corner',
    'Badge',
    'stars',
    ['badge', 'verified'],
    'badge',
    symbolPresets('ribbon-corner', 'Badge'),
  ),
  box({
    id: 'burst-label',
    name: 'Burst label',
    category: 'stars',
    tags: ['new', 'sale', 'burst', 'label', 'badge'],
    generator: 'star',
    knobs: [POINTS(12), INNER_RADIUS(78)],
    labelled: true,
    defaults: { width: 18, height: 18 },
    presets: [
      { id: 'burst-label/new', name: 'New burst', ...solid(RED), label: 'NEW', labelColor: WHITE },
      {
        id: 'burst-label/sale',
        name: 'Sale burst',
        ...solid(YELLOW),
        label: 'SALE',
        labelColor: BLACK,
      },
    ],
  }),

  // --- frames and borders ------------------------------------------------------------------------------
  box({
    id: 'frame',
    name: 'Frame',
    category: 'frames',
    tags: ['frame', 'border'],
    generator: 'ring',
    geometry: { inner: 'rect', fillRule: 'evenodd' },
    knobs: [THICKNESS(6), CORNER_RADIUS(0)],
    defaults: WIDE,
  }),
  box({
    id: 'rounded-frame',
    name: 'Rounded frame',
    category: 'frames',
    tags: ['frame', 'border'],
    generator: 'ring',
    geometry: { inner: 'rect', fillRule: 'evenodd' },
    knobs: [THICKNESS(6), CORNER_RADIUS(14)],
    defaults: WIDE,
  }),
  box({
    id: 'circle-frame',
    name: 'Circle frame',
    category: 'frames',
    tags: ['frame', 'ring', 'circle'],
    generator: 'ring',
    geometry: { inner: 'ellipse', fillRule: 'evenodd' },
    knobs: [THICKNESS(8)],
    defaults: SQUARE,
  }),
  box({
    id: 'double-frame',
    name: 'Double frame',
    category: 'frames',
    tags: ['frame', 'border', 'double'],
    generator: 'path',
    geometry: { path: [rectPath(1), rectPath(8)].join(' ') },
    defaults: WIDE,
    presets: highlightPresets('double-frame', 'Double frame', 0.5),
  }),
  box({
    id: 'corner-frame',
    name: 'Corner frame',
    category: 'frames',
    tags: ['corners', 'frame'],
    generator: 'corners',
    knobs: [{ ...CORNER_LENGTH, default: 14 }],
    defaults: WIDE,
    presets: highlightPresets('corner-frame', 'Corner frame', 0.6),
  }),
  box({
    id: 'polaroid-frame',
    name: 'Photo frame',
    category: 'frames',
    tags: ['polaroid', 'photo', 'frame'],
    generator: 'path',
    geometry: {
      path: [
        rectPath(0),
        polygonPath([
          [6, 6],
          [94, 6],
          [94, 76],
          [6, 76],
        ]),
      ].join(' '),
      fillRule: 'evenodd',
    },
    defaults: { width: 28, height: 32 },
    presets: [
      { id: 'polaroid-frame/white', name: 'Photo frame', ...solid(WHITE) },
      { id: 'polaroid-frame/cream', name: 'Cream photo frame', ...solid('#F4EFE6') },
    ],
  }),
  box({
    id: 'phone-frame',
    name: 'Phone frame',
    category: 'frames',
    tags: ['phone', 'device', 'mockup'],
    generator: 'ring',
    geometry: { inner: 'rect', fillRule: 'evenodd' },
    knobs: [THICKNESS(6), CORNER_RADIUS(18)],
    defaults: { width: 24, height: 48 },
    presets: [
      { id: 'phone-frame/black', name: 'Phone frame', ...solid(BLACK) },
      { id: 'phone-frame/white', name: 'White phone frame', ...solid(WHITE) },
    ],
  }),
  iconShape(
    'browser-frame',
    'Browser frame',
    'frames',
    ['browser', 'window', 'mockup', 'screen'],
    'app-window',
    highlightPresets('browser-frame', 'Browser frame', 0.6),
    WIDE,
  ),

  // --- symbols (Lucide outlines) ---------------------------------------------------------------------------
  iconShape(
    'check',
    'Check',
    'symbols',
    ['tick', 'done', 'yes', 'correct'],
    'check',
    symbolPresets('check', 'Check'),
  ),
  iconShape(
    'check-circle',
    'Check in circle',
    'symbols',
    ['tick', 'done', 'success'],
    'circle-check',
    symbolPresets('check-circle', 'Check in circle'),
  ),
  iconShape(
    'cross',
    'Cross',
    'symbols',
    ['x', 'no', 'wrong', 'close'],
    'x',
    symbolPresets('cross', 'Cross'),
  ),
  iconShape(
    'cross-circle',
    'Cross in circle',
    'symbols',
    ['x', 'error', 'wrong'],
    'circle-x',
    symbolPresets('cross-circle', 'Cross in circle'),
  ),
  iconShape('plus', 'Plus', 'symbols', ['add', 'new'], 'plus', symbolPresets('plus', 'Plus')),
  iconShape(
    'minus',
    'Minus',
    'symbols',
    ['remove', 'less'],
    'minus',
    symbolPresets('minus', 'Minus'),
  ),
  iconShape('heart', 'Heart', 'symbols', ['love', 'like', 'favourite'], 'heart', [
    { id: 'heart/red', name: 'Heart', ...outlined(RED, RED) },
    { id: 'heart/white', name: 'Heart outline', ...outline(WHITE, 1) },
  ]),
  iconShape(
    'lightning',
    'Lightning',
    'symbols',
    ['zap', 'bolt', 'fast', 'energy'],
    'zap',
    symbolPresets('lightning', 'Lightning'),
  ),
  iconShape('moon', 'Moon', 'symbols', ['night', 'dark'], 'moon', symbolPresets('moon', 'Moon')),
  iconShape(
    'sun',
    'Sun',
    'symbols',
    ['day', 'light', 'bright'],
    'sun',
    symbolPresets('sun', 'Sun'),
  ),
  iconShape(
    'cloud',
    'Cloud',
    'symbols',
    ['weather', 'sky'],
    'cloud',
    symbolPresets('cloud', 'Cloud'),
  ),
  iconShape(
    'drop',
    'Drop',
    'symbols',
    ['water', 'droplet', 'liquid'],
    'droplet',
    symbolPresets('drop', 'Drop'),
  ),
  iconShape(
    'location-pin',
    'Location pin',
    'symbols',
    ['pin', 'map', 'place', 'marker'],
    'map-pin',
    symbolPresets('location-pin', 'Location pin'),
  ),
  iconShape(
    'play-button',
    'Play button',
    'symbols',
    ['play', 'video', 'start'],
    'circle-play',
    symbolPresets('play-button', 'Play button'),
  ),
  iconShape(
    'warning',
    'Warning',
    'symbols',
    ['alert', 'caution', 'danger'],
    'triangle-alert',
    symbolPresets('warning', 'Warning'),
  ),
  iconShape(
    'info',
    'Info',
    'symbols',
    ['information', 'about', 'help'],
    'info',
    symbolPresets('info', 'Info'),
  ),
  iconShape(
    'question',
    'Question',
    'symbols',
    ['help', 'ask', 'faq'],
    'circle-question-mark',
    symbolPresets('question', 'Question'),
  ),
  iconShape(
    'star-outline',
    'Star icon',
    'symbols',
    ['star', 'rating', 'favourite'],
    'star',
    symbolPresets('star-outline', 'Star icon'),
  ),

  // --- numbered badges (plan/elements EL5.4) --------------------------------------------------------------
  box({
    id: 'numbered-circle',
    name: 'Numbered circle',
    category: 'numbers',
    tags: ['number', 'step', 'badge', 'count'],
    generator: 'ellipse',
    labelled: true,
    defaults: { width: 9, height: 9 },
    presets: badgePresets('numbered-circle', 'Step', 5),
  }),
  box({
    id: 'numbered-square',
    name: 'Numbered square',
    category: 'numbers',
    tags: ['number', 'step', 'badge'],
    generator: 'rect',
    knobs: [CORNER_RADIUS(20)],
    labelled: true,
    defaults: { width: 9, height: 9 },
    presets: badgePresets('numbered-square', 'Square step', 1),
  }),
  box({
    id: 'numbered-pill',
    name: 'Numbered pill',
    category: 'numbers',
    tags: ['number', 'step', 'badge', 'label'],
    generator: 'rect',
    knobs: [CORNER_RADIUS(50)],
    labelled: true,
    defaults: { width: 14, height: 8 },
    presets: badgePresets('numbered-pill', 'Pill step', 1),
  }),
];

/**
 * Icons are shapes too: `icon/<name>` draws that Lucide icon's outline on a box (plan/elements
 * EL5.5). The outlines live in `schema/shape-icons.json` (loaded only where a tile or the engine
 * draws one); the names alone decide which ids exist.
 */
export const SHAPE_ICON_PREFIX = 'icon/';

const ICON_NAMES: ReadonlySet<string> = new Set(SHAPE_ICON_NAMES);

/** The style an icon is inserted with: its outline in white, as Lucide draws it. */
export const ICON_PRESET_STYLE: PresetStyle = outline(WHITE, 1);

/** The descriptor of `icon/<name>`, or `undefined` when there is no such icon. */
export function iconShapeDescriptor(shapeId: string): BoxShapeDescriptor | undefined {
  if (!shapeId.startsWith(SHAPE_ICON_PREFIX)) return undefined;
  const icon = shapeId.slice(SHAPE_ICON_PREFIX.length);
  if (!ICON_NAMES.has(icon)) return undefined;
  const name = icon.replace(/-/g, ' ');
  return box({
    id: shapeId,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    category: 'symbols',
    tags: ['icon'],
    generator: 'path',
    geometry: { icon, roundCaps: true },
    defaults: SQUARE,
    presets: [
      { id: shapeId, name: name.charAt(0).toUpperCase() + name.slice(1), ...ICON_PRESET_STYLE },
    ],
  });
}

const BY_ID: ReadonlyMap<string, ShapeDescriptor> = new Map(
  SHAPE_CATALOG.map((shape) => [shape.id, shape]),
);

/** The catalogue entry (or icon) `shapeId` names, or `undefined`. */
export function catalogShape(shapeId: string): ShapeDescriptor | undefined {
  return BY_ID.get(shapeId) ?? iconShapeDescriptor(shapeId);
}

/**
 * The preset `presetId` names, with its shape, or `undefined`. An icon's id is its own preset:
 * `icon/<name>` inserts the outline in white.
 */
export function shapePreset(
  presetId: string,
): { readonly shape: ShapeDescriptor; readonly preset: ShapePreset } | undefined {
  for (const shape of SHAPE_CATALOG) {
    const preset = shape.presets.find((candidate) => candidate.id === presetId);
    if (preset !== undefined) return { shape, preset };
  }
  const icon = iconShapeDescriptor(presetId);
  return icon === undefined ? undefined : { shape: icon, preset: icon.presets[0]! };
}

/**
 * The preset `id` names: the preset itself, an icon (its id is its own preset), or a shape's
 * first style — a model that names the shape (`star-5`) rather than a style gets its default.
 */
export function resolveShapePresetId(id: string): string | undefined {
  if (shapePreset(id) !== undefined) return id;
  return catalogShape(id)?.presets[0]?.id;
}

/**
 * The presets the Shapes tab opens on, in order: the screen-recording staples. Everything else
 * follows in catalogue order.
 */
export const FEATURED_SHAPE_PRESET_IDS: readonly string[] = [
  'rounded-rect/highlight',
  'rounded-rect/filled',
  'ellipse/outline',
  'marker-highlight/yellow',
  'line-arrow/red',
  'underline-marker/yellow',
];

/** Every catalogue preset, the featured ones first: what the Shapes tab shows. */
export const SHAPE_PRESETS: readonly {
  readonly shape: ShapeDescriptor;
  readonly preset: ShapePreset;
}[] = (() => {
  const all = SHAPE_CATALOG.flatMap((shape) => shape.presets.map((preset) => ({ shape, preset })));
  const featured = FEATURED_SHAPE_PRESET_IDS.map((id) =>
    all.find(({ preset }) => preset.id === id)!,
  );
  return [
    ...featured,
    ...all.filter(({ preset }) => !FEATURED_SHAPE_PRESET_IDS.includes(preset.id)),
  ];
})();
