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
  SHAPE_CAPS,
  SHAPE_PRESETS,
  SHAPE_STROKE_STYLES,
  presetShapeParams,
  shapeParamsProblem,
} from '@framepilot/timeline-schema';
import type { ToolSpec } from '../tool-registry.js';
import { ToolRefusalError } from '../tool-refusal.js';
import type { ToolContext } from '../tool-context.js';
import { mutateTool } from './tool-factories.js';
import { numeric, seconds } from './tool-args.js';

/** The shapes the agent may place: every preset of the catalogue, by id. */
const SHAPE_IDS = SHAPE_PRESETS.map(({ preset }) => preset.id) as [string, ...string[]];

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
};

/** The param changes a tool call's style, box and ends ask for; refuses a colour it cannot read. */
function styleChanges(args: { readonly [key: string]: unknown }): Record<string, unknown> {
  const box = args.box as Record<string, number> | undefined;
  const ends = args.ends as Record<string, number> | undefined;
  const changes: Record<string, unknown> = { ...box, ...ends };
  for (const key of ['fill', 'stroke'] as const) {
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
  ] as const) {
    if (args[key] !== undefined) changes[key] = args[key];
  }
  return changes;
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

const PRESET_LIST = SHAPE_PRESETS.map(({ preset }) => `${preset.id} (${preset.name})`).join(', ');

export const ELEMENT_TOOLS: readonly ToolSpec[] = [
  mutateTool(
    {
      name: 'add_shape',
      description:
        'Add a shape over the picture for a timeline range: a highlight box around a button, an ' +
        'arrow pointing at something, an ellipse, a translucent marker over a line of text, an ' +
        `underline. shape is one of: ${PRESET_LIST}. Boxes take box {x, y, width, height}: the ` +
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
        shape: z.enum(SHAPE_IDS),
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
      const params = { ...presetShapeParams(a.shape)!, ...styleChanges(a) };
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
        'stroke width and style, caps on a line or arrow, corner radius, arrow head size, and ' +
        'its box or ends (same units as add_shape). Only what you pass changes. A change that ' +
        'would leave the shape drawing nothing is refused.',
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
        throw new ToolRefusalError('Nothing to change. Pass a colour, a stroke, a box or ends.');
      }
      const params = shapeClipParams(clip)!;
      const problem = shapeParamsProblem({ ...params, ...changes });
      if (problem !== null) throw new ToolRefusalError(problem);
      return [setShapeParamsOp(a.clipId, changes)];
    },
  ),
];
