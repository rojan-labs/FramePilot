/**
 * Patches for shapes (plan/elements EL4a): add one from a preset, restyle or move one. Each is a
 * single validated, reversible patch, so one click or one drag is one undo step and History
 * names what it did ("Add shape “Highlight box”").
 */
import {
  buildAddShapeOps,
  setShapeParamsOp,
  shapeClipParams,
  type Patch,
} from '@framepilot/editor-core';
import {
  presetShapeParams,
  shapeDescriptor,
  shapePreset,
  shapeParamsProblem,
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

/**
 * Add the shape preset `presetId` at `start` for `durationSeconds`, centred on `at` (percent of
 * each axis; the frame centre by default).
 *
 * @returns `null` for an unknown preset or a span too short to hold.
 */
export function addShapePatch(
  timeline: Timeline,
  presetId: string,
  start: number,
  durationSeconds: number,
  at?: { readonly x: number; readonly y: number },
): AddedShape | null {
  const found = shapePreset(presetId);
  const params = presetShapeParams(presetId, at);
  if (found === undefined || params === undefined || !(durationSeconds > 0)) return null;
  const end = start + durationSeconds;
  const placed = buildAddShapeOps(timeline, params, start, end);
  return {
    clipId: placed.clipId,
    patch: {
      patchId: patchId(`shape_${presetId.replace('/', '_')}_${placed.trackId}_${ms(start)}`),
      createdBy: 'user',
      reason: `Add shape “${found.preset.name}”`,
      operations: [...placed.operations],
    },
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
