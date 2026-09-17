/**
 * The agent's mask builders on the v22 mask stack (ADR 0178).
 *
 * The tools keep the vocabulary a model reasons in — a shape, a box in frame fractions, a
 * feather fraction — and every conversion to the stored form (source pixels, source-time
 * keyframes) goes through the editor-core / timeline-schema converters the UI and the
 * v21 → v22 migration use, so the agent cannot place a mask somewhere the editor would not.
 */
import {
  assetDisplaySize,
  compileMaskCommand,
  MEASURE_MEDIA_FIRST,
  nextMaskId,
  type MaskShape,
  type Operation,
} from '@framepilot/editor-core';
import {
  MaskLayerSchema,
  maskLayerFromLegacyMaskEffect,
  type Clip,
  type Keyframe,
  type Project,
} from '@framepilot/timeline-schema';

function clipAndSize(
  project: Project,
  clipId: string,
): { clip: Clip; width: number; height: number } {
  const clip = project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);
  if (!clip) throw new Error(`Unknown clip "${clipId}". Use get_clips to list real clip ids.`);
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  const size = assetDisplaySize(asset?.media);
  if (size === null) throw new Error(MEASURE_MEDIA_FIRST);
  return { clip, ...size };
}

/**
 * `add_mask`: a whole-frame rectangle or ellipse on the clip, in source pixels.
 *
 * Compiled through the same `draw_mask` command the monitor's Rectangle and Ellipse tools use
 * (MK4.4), so an agent-drawn mask and a hand-drawn one get the same id, name, colour and
 * validation.
 */
export function addShapeMaskOps(
  project: Project,
  args: { readonly clipId: string; readonly shape: MaskShape },
): Operation[] {
  const { clip, width, height } = clipAndSize(project, args.clipId);
  if (args.shape === 'polygon') {
    throw new Error(
      'add_mask draws a rectangle or an ellipse. Use add_mask_advanced for a polygon.',
    );
  }
  const compiled = compileMaskCommand({
    timeline: project.timeline,
    assets: project.assets,
    command: {
      type: 'draw_mask',
      timelineRevision: project.timeline.revision ?? 0,
      clipId: clip.id,
      createdBy: 'agent',
      sourceTime: clip.sourceStart,
      atTop: false,
      geometry:
        args.shape === 'ellipse'
          ? {
              kind: 'ellipse',
              cx: width / 2,
              cy: height / 2,
              rx: width / 2,
              ry: height / 2,
              rotation: 0,
            }
          : {
              kind: 'rectangle',
              cx: width / 2,
              cy: height / 2,
              width,
              height,
              rotation: 0,
              roundness: 0,
            },
    },
  });
  if (compiled.status === 'rejected') throw new Error(compiled.detail);
  return [...compiled.patch.operations] as Operation[];
}

/** The v21-vocabulary mask `add_mask_advanced` accepts. */
export interface LegacyMaskRequest {
  readonly clipId: string;
  readonly shape: MaskShape;
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly points?: readonly (readonly [number, number])[];
  readonly feather?: number;
  readonly opacity?: number;
  readonly invert?: boolean;
  /** Box/feather/opacity keyframes in CLIP timeline seconds, as v21 masks were keyed. */
  readonly keyframes?: readonly Keyframe[];
}

/**
 * `add_mask_advanced`: bounds, polygon, feather and clip-time keyframes, converted exactly as
 * the v21 → v22 migration converts a stored mask effect (feather stays the Gaussian blur the
 * request describes: `featherModel: 'gaussian-legacy'`).
 */
export function addLegacyMaskOps(project: Project, request: LegacyMaskRequest): Operation[] {
  const { clip, width, height } = clipAndSize(project, request.clipId);
  const params: Record<string, unknown> = { shape: request.shape };
  if (request.bounds !== undefined) params.bounds = request.bounds;
  if (request.points !== undefined) params.points = request.points;
  if (request.feather !== undefined) params.feather = request.feather;
  if (request.opacity !== undefined) params.opacity = request.opacity;
  if (request.invert !== undefined) params.invert = request.invert;
  const raw = maskLayerFromLegacyMaskEffect(
    { id: nextMaskId(clip), params, keyframes: request.keyframes ?? [] },
    clip as unknown as Record<string, unknown>,
    { width, height },
  );
  const parsed = MaskLayerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'The mask is outside the allowed values. Keep fractions within 0..1 and sizes positive.',
    );
  }
  return [{ type: 'add_mask', clipId: clip.id, mask: parsed.data }];
}
