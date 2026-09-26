/**
 * The `elements` domain's tools (plan/elements EL4a): shapes the agent places and restyles.
 *
 * Both are ordinary mutate tools over the shared editor-core builders, so a shape the agent adds
 * lands exactly where the Shapes tab would put the same shape. The engine draws every shape (ADR
 * 0190); these tools only state params, and refuse, with the validator's own sentence, a shape
 * that would draw nothing.
 *
 * Argument conventions match `add_text_layer`: positions in percent of each frame axis, sizes in
 * percent of the frame height. Colours accept `#rgb`, `#rrggbb[aa]`, the palette's names, or
 * `none`, because those are the words models reach for.
 */
import { z } from 'zod/v4';
import {
  buildAddShapeOps,
  setShapeParamsOp,
  shapeClipParams,
  type Operation,
} from '@framepilot/editor-core';
import {
  FEATURED_SHAPE_PRESET_IDS,
  SHAPE_CAPS,
  SHAPE_CATEGORIES,
  SHAPE_ICON_PREFIX,
  SHAPE_PRESETS,
  SHAPE_STROKE_STYLES,
  presetShapeParams,
  resolveShapePresetId,
  searchShapes,
  shapeParamsProblem,
  type ShapeDescriptor,
} from '@framepilot/timeline-schema';
import type { ToolSpec } from '../tool-registry.js';
import { ToolRefusalError } from '../tool-refusal.js';
import type { ToolContext } from '../tool-context.js';
import { analysisTool, mutateTool, readTool } from './tool-factories.js';
import {
  STICKER_ID_PATTERN,
  loadStickerCatalog,
  searchStickers,
  type StickerItem,
} from '../providers/elements/sticker-catalog.js';
import { numeric, seconds } from './tool-args.js';

/** The staples the add_shape description names; search_elements finds everything else. */
const FEATURED = SHAPE_PRESETS.filter(({ preset }) =>
  FEATURED_SHAPE_PRESET_IDS.includes(preset.id),
);

/** Colour names models use, mapped to the catalogue palette (plan/elements 03 §1.3). */
const NAMED_COLOURS: Readonly<Record<string, string>> = {
  white: '#FFFFFF',
  black: '#111111',
  yellow: '#FFD400',
  red: '#FF3B30',
  blue: '#0A84FF',
  green: '#34C759',
  orange: '#FF9500',
  purple: '#AF52DE',
  pink: '#FF2D55',
};

/**
 * A colour argument as `ShapeParams` stores it: `#rrggbb[aa]`, or `null` for none.
 *
 * @returns `undefined` when the value is not a colour this accepts (the caller refuses).
 */
export function shapeColour(value: string): string | null | undefined {
  const text = value.trim().toLowerCase();
  if (text === 'none' || text === 'transparent') return null;
  const named = NAMED_COLOURS[text];
  if (named !== undefined) return named;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(text) ? text : undefined;
}

const colourArg = z.string().describe('#rrggbb, #rrggbbaa, a colour name, or none');
const percent = (min: number, max: number) => numeric(z.number().min(min).max(max));

const boxArg = z
  .object({
    x: percent(0, 100),
    y: percent(0, 100),
    width: percent(0.1, 400),
    height: percent(0.1, 400),
  })
  .strict();
const endsArg = z
  .object({
    x1: percent(-50, 150),
    y1: percent(-50, 150),
    x2: percent(-50, 150),
    y2: percent(-50, 150),
  })
  .strict();

const styleArgs = {
  fill: colourArg.optional(),
  stroke: colourArg.optional(),
  strokeWidth: percent(0.05, 10).optional(),
  strokeStyle: z.enum(SHAPE_STROKE_STYLES).optional(),
  startCap: z.enum(SHAPE_CAPS).optional(),
  endCap: z.enum(SHAPE_CAPS).optional(),
  cornerRadius: percent(0, 50).optional(),
  headSize: percent(2, 8).optional(),
  label: z.string().optional().describe('a badge’s text, up to 8 characters'),
  labelColor: colourArg.optional(),
  knobs: z
    .record(z.string(), numeric(z.number()))
    .optional()
    .describe('the shape’s own knobs by name, as search_elements lists them'),
};

/** The param changes a tool call's style, box and ends ask for; refuses a colour it cannot read. */
function styleChanges(args: { readonly [key: string]: unknown }): Record<string, unknown> {
  const box = args.box as Record<string, number> | undefined;
  const ends = args.ends as Record<string, number> | undefined;
  const changes: Record<string, unknown> = { ...box, ...ends };
  for (const key of ['fill', 'stroke', 'labelColor'] as const) {
    const raw = args[key];
    if (typeof raw !== 'string') continue;
    const colour = shapeColour(raw);
    if (colour === undefined) {
      throw new ToolRefusalError(
        `${key} must be a colour: #rrggbb, #rrggbbaa, a name like yellow or red, or none.`,
      );
    }
    changes[key] = colour;
  }
  for (const key of [
    'strokeWidth',
    'strokeStyle',
    'startCap',
    'endCap',
    'cornerRadius',
    'headSize',
    'label',
  ] as const) {
    if (args[key] !== undefined) changes[key] = args[key];
  }
  const knobs = args.knobs as Readonly<Record<string, number>> | undefined;
  return { ...changes, ...knobs };
}

function shapeClip(ctx: ToolContext, clipId: string) {
  const clip = ctx.project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((c) => c.id === clipId);
  if (clip === undefined || shapeClipParams(clip) === null) {
    throw new ToolRefusalError(
      `"${clipId}" is not a shape. Read the timeline with get_timeline for shape clip ids, or add one with add_shape.`,
    );
  }
  return clip;
}

const PRESET_LIST = FEATURED.map(({ preset }) => `${preset.id} (${preset.name})`).join(', ');
const FEATURED_IDS = FEATURED_SHAPE_PRESET_IDS.join(', ');

/** The most rows search_elements returns, and how many when the model does not say. */
const SEARCH_LIMIT_MAX = 30;
const SEARCH_LIMIT_DEFAULT = 12;

/** Every shape `query` finds, one row per shape with the styles it comes in. */
function shapeRows(
  query: string,
  category: (typeof SHAPE_CATEGORIES)[number] | 'icons' | undefined,
): { readonly rows: ReturnType<typeof elementRow>[]; readonly total: number } {
  const { hits } = searchShapes(query, category);
  const shapes = new Map<
    string,
    { shape: ShapeDescriptor; styles: { id: string; name: string }[] }
  >();
  for (const { shape, preset } of hits) {
    const row = shapes.get(shape.id) ?? { shape, styles: [] };
    row.styles.push({ id: preset.id, name: preset.name });
    shapes.set(shape.id, row);
  }
  return {
    rows: [...shapes.values()].map(({ shape, styles }) => elementRow(shape, styles)),
    total: shapes.size,
  };
}

/** One search_elements row for a sticker: the elementId add_sticker takes, and what it is. */
function stickerRow(item: StickerItem) {
  return {
    elementId: item.id,
    kind: 'sticker' as const,
    name: item.name,
    glyph: item.glyph,
    category: item.collections[0] ?? item.group,
    tags: item.keywords.slice(0, 6),
    frame: 'box' as const,
    aspect: 1,
    knobs: [],
    labelled: false,
    styles: [],
    animated: false,
    license: 'MIT (Fluent Emoji by Microsoft)',
    attributionRequired: false,
  };
}

/** One search_elements row: a shape, the styles it comes in, and what add_shape can set on it. */
function elementRow(shape: ShapeDescriptor, styles: readonly { id: string; name: string }[]) {
  const icon = shape.id.startsWith(SHAPE_ICON_PREFIX);
  return {
    elementId: shape.id,
    kind: 'shape' as const,
    name: shape.name,
    category: icon ? 'icons' : shape.category,
    tags: shape.tags,
    frame: shape.frame,
    aspect:
      shape.frame === 'box'
        ? Math.round((shape.defaults.width / shape.defaults.height) * 100) / 100
        : null,
    knobs: shape.knobs.map(({ name, min, max, default: value }) => ({
      name,
      min,
      max,
      default: value,
    })),
    labelled: shape.labelled === true,
    styles,
    animated: false,
    license: icon ? 'ISC (Lucide)' : 'first-party',
    attributionRequired: false,
  };
}

export const ELEMENT_TOOLS: readonly ToolSpec[] = [
  readTool(
    {
      name: 'search_elements',
      description:
        'Find stickers for add_sticker and shapes for add_shape by what they are or are for. ' +
        'Stickers are emoji-style images — 🔥, 👍, 🎉, "party", "money", "thumbs up"; shapes are ' +
        'callouts — "box", "curved arrow", "speech bubble", "numbered badge", "check", and every ' +
        'Lucide icon (icon/<name>). kind narrows it to sticker or shape; without it you get the ' +
        'best of both. Each row has the elementId to pass on, and for a shape its styles (preset ' +
        'ids, also valid as shape), whether it is placed by a box or two ends, its knobs with ' +
        'their ranges, and whether it takes a label. category narrows shapes: ' +
        `${SHAPE_CATEGORIES.join(', ')}, or icons; collection narrows stickers: reactions, ` +
        'celebrate, hands, hearts, tech, arrows, symbols, money, food, nature, animals, travel, ' +
        'objects.',
    },
    z
      .object({
        query: z.string().describe('words to find (a sticker also by its emoji); empty lists'),
        kind: z.enum(['shape', 'sticker']).optional(),
        category: z.enum([...SHAPE_CATEGORIES, 'icons']).optional(),
        collection: z.string().min(1).optional(),
        limit: numeric(z.number().int().min(1).max(SEARCH_LIMIT_MAX)).optional(),
      })
      .strict(),
    (a) => {
      const limit = a.limit ?? SEARCH_LIMIT_DEFAULT;
      const shapes = shapeRows(a.query, a.category);
      const head = {
        query: a.query,
        ...(a.kind !== undefined ? { kind: a.kind } : {}),
        ...(a.category !== undefined ? { category: a.category } : {}),
        ...(a.collection !== undefined ? { collection: a.collection } : {}),
      };
      if (a.kind === 'shape') {
        const results = shapes.rows.slice(0, limit);
        return { ...head, results, returned: results.length, total: shapes.total };
      }
      // The sticker catalogue is loaded on first use; a shape-only search never pays for it.
      return loadStickerCatalog().then((catalog) => {
        const found = searchStickers(
          catalog,
          a.query,
          a.collection !== undefined ? { collection: a.collection } : {},
        );
        const stickers = found.items.map(stickerRow);
        if (a.kind === 'sticker') {
          const results = stickers.slice(0, limit);
          return { ...head, results, returned: results.length, total: found.total };
        }
        // Both kinds: stickers lead (a word like "fire" means the emoji), and whichever kind
        // has fewer matches leaves its room to the other.
        const shapeShare = Math.min(shapes.total, Math.floor(limit / 2));
        const stickerShare = Math.min(stickers.length, limit - shapeShare);
        const results = [
          ...stickers.slice(0, stickerShare),
          ...shapes.rows.slice(0, limit - stickerShare),
        ];
        return { ...head, results, returned: results.length, total: found.total + shapes.total };
      });
    },
  ),
  analysisTool(
    {
      name: 'add_sticker',
      description:
        'Put a sticker — an emoji-style image such as 🔥, 👍 or 🎉 — over the picture for a ' +
        'timeline range. elementId comes from search_elements (kind: sticker). start and end ' +
        'are timeline seconds (end defaults to 3 s after start). xPercent/yPercent place its ' +
        'centre in percent of the frame (50/50 is the middle); sizePercent is its height in ' +
        'percent of the frame height (30 by default; 15–40 reads well). The app copies the ' +
        'sticker into the project and it lands on a graphics layer with room, never as footage. ' +
        'Keep it off faces and the caption band — look with get_frame.',
      // The file is copied by the desktop app's main process; the standalone MCP server has no
      // materialiser (plan/elements 06 §5), so it neither advertises nor accepts this.
      hostUiOnly: true,
    },
    z
      .object({
        elementId: z.string().regex(STICKER_ID_PATTERN),
        start: seconds,
        end: seconds.optional(),
        xPercent: percent(0, 100).optional(),
        yPercent: percent(0, 100).optional(),
        sizePercent: percent(2, 100).optional(),
        rotation: numeric(z.number().min(-360).max(360)).optional(),
        trackId: z.string().min(1).optional(),
      })
      .strict(),
  ),
  mutateTool(
    {
      name: 'add_shape',
      description:
        'Add a shape over the picture for a timeline range: a highlight box around a button, an ' +
        'arrow pointing at something, an ellipse, a translucent marker over a line of text, an ' +
        `underline, a numbered badge, a star, an icon. shape is a staple — ${PRESET_LIST} — or ` +
        'an elementId or style from search_elements (stars, bubbles, frames, badges, icons). ' +
        'label is a badge’s text (up to 8 characters); knobs sets the shape’s own knobs by name. ' +
        'Boxes take box {x, y, width, height}: the ' +
        'centre in percent of the frame (50/50 is the middle) and the size in percent of the ' +
        'frame height, like add_text_layer. Lines and arrows take ends {x1, y1, x2, y2} in ' +
        'percent of the frame; the arrow head is at x2/y2, so point it AT the target from empty ' +
        'space. Without a box or ends the preset lands centred. fill/stroke take a colour or ' +
        'none; strokeWidth is a percent of the frame height. It goes on an overlay lane with room ' +
        '(a new one if needed) and renders exactly as the preview shows it. Look with get_frame ' +
        'to place it on what is on screen.',
    },
    z
      .object({
        shape: z.string().min(1),
        start: seconds,
        end: seconds,
        box: boxArg.optional(),
        ends: endsArg.optional(),
        ...styleArgs,
        rotation: numeric(z.number().min(-360).max(360)).optional(),
        trackId: z.string().min(1).optional(),
      })
      .strict(),
    (a, ctx) => {
      if (!(a.end > a.start)) {
        throw new ToolRefusalError('end must be after start. Give the shape a time range.');
      }
      const presetId = resolveShapePresetId(a.shape);
      if (presetId === undefined) {
        // No echo of the id: the repeated-failure guard keys on this text, and a new wrong id
        // each attempt must not read as progress.
        throw new ToolRefusalError(
          `That shape is not in the catalogue. Find one with search_elements, or use a staple: ${FEATURED_IDS}.`,
        );
      }
      const params = { ...presetShapeParams(presetId)!, ...styleChanges(a) };
      const problem = shapeParamsProblem(params);
      if (problem !== null) throw new ToolRefusalError(problem);
      const placed = buildAddShapeOps(ctx.project.timeline, params, a.start, a.end, a.trackId);
      const ops: Operation[] = [...placed.operations];
      if (a.rotation !== undefined && a.rotation !== 0) {
        ops.push({
          type: 'add_keyframes',
          clipId: placed.clipId,
          keyframes: [
            {
              id: `${placed.clipId}__rotation`,
              time: 0,
              property: 'rotation',
              value: a.rotation,
              easing: 'linear',
            },
          ],
        });
      }
      return ops;
    },
  ),
  mutateTool(
    {
      name: 'set_shape_style',
      description:
        'Restyle or move one shape added with add_shape: fill and stroke colours (or none), ' +
        'stroke width and style, caps on a line or arrow, corner radius, arrow head size, a ' +
        'badge’s label and its colour, the shape’s other knobs, and its box or ends (same units ' +
        'as add_shape). Only what you pass changes. A change that would leave the shape drawing ' +
        'nothing is refused.',
    },
    z
      .object({
        clipId: z.string().min(1),
        box: boxArg.optional(),
        ends: endsArg.optional(),
        ...styleArgs,
      })
      .strict(),
    (a, ctx) => {
      const clip = shapeClip(ctx, a.clipId);
      const changes = styleChanges(a);
      if (Object.keys(changes).length === 0) {
        throw new ToolRefusalError(
          'Nothing to change. Pass a colour, a stroke, a label, a knob, a box or ends.',
        );
      }
      const params = shapeClipParams(clip)!;
      const problem = shapeParamsProblem({ ...params, ...changes });
      if (problem !== null) throw new ToolRefusalError(problem);
      return [setShapeParamsOp(a.clipId, changes)];
    },
  ),
];
