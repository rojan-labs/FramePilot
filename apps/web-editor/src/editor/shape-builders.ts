/**
 * Patches for shapes (plan/elements EL4a): add one from a preset, restyle or move one. Each is a
 * single validated, reversible patch, so one click or one drag is one undo step and History
 * names what it did ("Add shape “Highlight box”").
 */
import {
  buildAddShapeOps,
  setShapeParamsOp,
  shapeClipParams,
  swapShapeParams,
  type Patch,
} from '@framepilot/editor-core';
import {
  presetShapeParams,
  shapeDescriptor,
  shapePreset,
  shapeParamsProblem,
  type ShapePreset,
  type Timeline,
} from '@framepilot/timeline-schema';

const patchId = (raw: string): Patch['patchId'] => raw as Patch['patchId'];
const ms = (seconds: number): number => Math.round(seconds * 1000);

/** A short hash of the change, so two different edits of one shape never share a patch id. */
function contentHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

/** What an added shape is, for the caller that selects it afterwards. */
export interface AddedShape {
  readonly patch: Patch;
  readonly clipId: string;
}

/** Dark ink for a label on a light colour, white on a dark one (WCAG relative luminance). */
function readableOn(colour: string): string {
  const channel = (offset: number): number => {
    const value = parseInt(colour.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? '#111111' : '#FFFFFF';
}

/** `colour` (`#rrggbb`) with the alpha `like` carries, so a translucent preset stays translucent. */
function withAlphaOf(colour: string, like: string): string {
  return like.length === 9 ? `${colour.slice(0, 7)}${like.slice(7)}` : colour.slice(0, 7);
}

/**
 * A preset in the Shapes tab's chosen colour (plan/elements 02 §2.3): the colour takes the paint
 * that carries the shape — the stroke of an outline, the fill of a solid, the fill of a filled
 * shape with a contrasting outline (both when they were the same colour) — keeping each paint's
 * alpha, and a badge's number stays readable on it.
 *
 * @param colour - `#rrggbb`, or `null` for the preset's own colours.
 */
export function recolourPreset(preset: ShapePreset, colour: string | null): ShapePreset {
  if (colour === null) return preset;
  const { fill, stroke } = preset;
  const next: { -readonly [K in keyof ShapePreset]: ShapePreset[K] } = { ...preset };
  if (fill !== null) {
    next.fill = withAlphaOf(colour, fill);
    if (stroke !== null && stroke.slice(0, 7) === fill.slice(0, 7)) {
      next.stroke = withAlphaOf(colour, stroke);
    }
  } else if (stroke !== null) {
    next.stroke = withAlphaOf(colour, stroke);
  }
  if (preset.label !== undefined && fill !== null) next.labelColor = readableOn(colour);
  return next;
}

/** Where and how a shape is added: all optional. */
export interface AddShapeOptions {
  /** Box centre (or a segment's reference point), percent of each axis; the frame centre. */
  readonly at?: { readonly x: number; readonly y: number };
  /** The Shapes tab's chosen colour (`#rrggbb`), or `null`/absent for the preset's own. */
  readonly colour?: string | null;
  /** An overlay lane to use when it has room (a drop on a lane names it). */
  readonly trackId?: string;
}

/**
 * Add the shape preset `presetId` at `start` for `durationSeconds`.
 *
 * @returns `null` for an unknown preset or a span too short to hold.
 */
export function addShapePatch(
  timeline: Timeline,
  presetId: string,
  start: number,
  durationSeconds: number,
  options: AddShapeOptions = {},
): AddedShape | null {
  const found = shapePreset(presetId);
  const params = presetShapeParams(presetId, options.at);
  if (found === undefined || params === undefined || !(durationSeconds > 0)) return null;
  const style = recolourPreset(found.preset, options.colour ?? null);
  const coloured = { ...params, fill: style.fill, stroke: style.stroke };
  const end = start + durationSeconds;
  const placed = buildAddShapeOps(timeline, coloured, start, end, options.trackId);
  return {
    clipId: placed.clipId,
    patch: {
      patchId: patchId(
        `shape_${presetId.replace(/\//g, '_')}_${placed.trackId}_${ms(start)}_${contentHash(coloured)}`,
      ),
      createdBy: 'user',
      reason: `Add shape “${found.preset.name}”`,
      operations: [...placed.operations],
    },
  };
}

/**
 * Swap a shape's geometry for `shapeId`'s, keeping its style and placement (the Inspector's shape
 * picker). The old shape's knobs are cleared with `null`, which both runtimes read as absent.
 *
 * @returns `null` when the clip is not a shape, or `shapeId` is unknown or placed differently.
 */
export function swapShapePatch(timeline: Timeline, clipId: string, shapeId: string): Patch | null {
  const clip = timeline.tracks.flatMap((track) => track.clips).find((c) => c.id === clipId);
  const params = clip === undefined ? null : shapeClipParams(clip);
  if (params === null) return null;
  const swapped = swapShapeParams(params, shapeId);
  if (swapped === undefined || shapeParamsProblem(swapped) !== null) return null;
  const changes: Record<string, unknown> = { ...swapped };
  for (const key of Object.keys(params)) if (!(key in swapped)) changes[key] = null;
  const from = typeof params.shape === 'string' ? shapeDescriptor(params.shape)?.name : undefined;
  const to = shapeDescriptor(shapeId)?.name ?? 'shape';
  return {
    patchId: patchId(`shape_${clipId}_swap_${contentHash(changes)}`),
    createdBy: 'user',
    reason: `Change ${(from ?? 'shape').toLowerCase()} to ${to.toLowerCase()}`,
    operations: [setShapeParamsOp(clipId, changes)],
  };
}

/**
 * Change some of a shape's params as one patch. `undefined` removes a key (a colour turned off
 * is `null`, which both runtimes read as "none").
 *
 * @returns `null` when the clip is not a drawable shape or the change would leave it undrawable
 *   (the caller keeps the control where it was rather than applying a refused edit).
 */
export function setShapeParamsPatch(
  timeline: Timeline,
  clipId: string,
  changes: Readonly<Record<string, unknown>>,
  what = 'style',
): Patch | null {
  const clip = timeline.tracks.flatMap((track) => track.clips).find((c) => c.id === clipId);
  const params = clip === undefined ? null : shapeClipParams(clip);
  if (params === null) return null;
  const merged: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  if (shapeParamsProblem(merged) !== null) return null;
  const name =
    typeof params.shape === 'string' ? (shapeDescriptor(params.shape)?.name ?? 'shape') : 'shape';
  return {
    patchId: patchId(`shape_${clipId}_${contentHash(changes)}`),
    createdBy: 'user',
    reason: `Change ${name.toLowerCase()} ${what}`,
    operations: [setShapeParamsOp(clipId, changes)],
  };
}
