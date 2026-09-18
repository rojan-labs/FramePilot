/**
 * `create_shape_mask` (AM2.4, MK8): split screen, mirror band, gradients and shape presets, placed
 * from a measured candidate, from the frame itself, or from numbers the editor typed.
 *
 * The model states WHICH preset, WHERE (a candidate, the frame, or the editor's numbers) and a few
 * named intents (which side to keep, horizontal or vertical, how many star points, how soft); this
 * module picks every number deterministically from the placement box — plan 11's "the model states
 * intent; the solver picks numbers". It compiles the SAME editor-core commands the monitor's
 * Split, Mirror, Gradient and Shapes tools compile (`draw_mask` with an analytic geometry,
 * `draw_shape_preset`), so an AI split and a hand-drawn one are the same mask.
 *
 * Every geometry-bearing operation is attested with its source (the candidate, the frame preset,
 * or the editor's numbers), so the dispatch boundary's "no unsourced geometry" rule holds.
 */
import {
  nextMaskId,
  type AnalyticMaskGeometry,
  type DisplaySize,
  type MaskShapePreset,
} from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { ToolRefusalError } from '../tool-refusal.js';
import type { MaskCandidate } from './contracts.js';
import { attestMaskGeometry, type MaskGeometrySource } from './geometry-provenance.js';
import {
  shapeEdgeFor,
  type MaskEdgeIntent,
  type MaskEffectIntent,
  type MaskPurpose,
} from './intent-tables.js';
import {
  MaskCommandChain,
  addLimitedEffect,
  clipWithSize,
  type BuiltMask,
} from './mask-builders.js';
import type { NormalizedBox } from './shape-fit.js';

/** The presets the tool offers, in the model's vocabulary. */
export const AI_SHAPE_PRESETS = [
  'split',
  'mirror',
  'gradient',
  'radial_gradient',
  'heart',
  'star',
  'polygon',
  'speech_bubble',
  'arrow',
  'rounded_frame',
] as const;
export type AiShapePreset = (typeof AI_SHAPE_PRESETS)[number];

/** Which side a split keeps, or where a linear gradient is opaque. */
export const SHAPE_SIDES = ['left', 'right', 'top', 'bottom'] as const;
export type ShapeSide = (typeof SHAPE_SIDES)[number];

/** Which way a mirror band runs. */
export const SHAPE_DIRECTIONS = ['horizontal', 'vertical'] as const;
export type ShapeDirection = (typeof SHAPE_DIRECTIONS)[number];

/** Editor-core's preset for each path preset of the tool. */
const PATH_PRESETS: Readonly<Partial<Record<AiShapePreset, MaskShapePreset>>> = {
  heart: 'heart',
  star: 'star',
  polygon: 'polygon',
  speech_bubble: 'speech-bubble',
  arrow: 'arrow',
  rounded_frame: 'rounded-frame',
};

/** What `create_shape_mask` was asked for, after argument validation. */
export interface CreateShapeMaskIntent {
  readonly clipId: string;
  readonly preset: AiShapePreset;
  readonly candidateId?: string;
  /** Fractions of the picture the editor typed: left, top, width, height. */
  readonly userBox?: NormalizedBox;
  readonly side?: ShapeSide;
  readonly direction?: ShapeDirection;
  /** Star points or polygon sides. */
  readonly points?: number;
  readonly purpose: MaskPurpose;
  readonly effect?: MaskEffectIntent;
  readonly edge: MaskEdgeIntent;
}

/** A placement box in display-corrected source pixels. */
interface PixelBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where a preset goes on the FRAME when the call names no subject and no numbers. */
function frameBox(preset: AiShapePreset, size: DisplaySize): PixelBox {
  const { width, height } = size;
  const centred = (w: number, h: number): PixelBox => ({
    x: (width - w) / 2,
    y: (height - h) / 2,
    width: w,
    height: h,
  });
  switch (preset) {
    case 'heart':
    case 'star':
    case 'polygon': {
      const side = Math.min(width, height) * 0.6;
      return centred(side, side);
    }
    case 'speech_bubble':
      return centred(width * 0.5, height * 0.4);
    case 'arrow':
      return centred(width * 0.5, height * 0.25);
    default:
      // A split, a band, a gradient or a frame spans the picture.
      return { x: 0, y: 0, width, height };
  }
}

function placementOf(
  intent: CreateShapeMaskIntent,
  size: DisplaySize,
  candidate: MaskCandidate | undefined,
): { readonly box: PixelBox; readonly source: MaskGeometrySource; readonly onFrame: boolean } {
  const toPixels = (box: NormalizedBox): PixelBox => ({
    x: box.x * size.width,
    y: box.y * size.height,
    width: box.width * size.width,
    height: box.height * size.height,
  });
  if (intent.candidateId !== undefined) {
    if (candidate === undefined) {
      throw new ToolRefusalError(
        'The measurement has no candidate for this call, so nothing was applied.',
      );
    }
    return {
      box: toPixels(candidate.box),
      source: { kind: 'candidate', candidateId: candidate.candidateId },
      onFrame: false,
    };
  }
  if (intent.userBox !== undefined) {
    return { box: toPixels(intent.userBox), source: { kind: 'user_numbers' }, onFrame: false };
  }
  return {
    box: frameBox(intent.preset, size),
    source: { kind: 'frame', preset: intent.preset },
    onFrame: true,
  };
}

/** A split keeps the LEFT of its line's direction of travel (editor-core's convention). */
const SPLIT_ANGLE: Readonly<Record<ShapeSide, number>> = {
  left: -90,
  right: 90,
  top: 0,
  bottom: 180,
};

/** The geometry of an analytic preset in `box`, or `null` for a path preset. */
function analyticGeometry(
  intent: CreateShapeMaskIntent,
  box: PixelBox,
  onFrame: boolean,
  size: DisplaySize,
): AnalyticMaskGeometry | null {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // Softness spans both sides of a hard line: twice the outer feather a shape would get.
  const softnessPx = shapeEdgeFor(intent.edge, size).featherOuterPx * 2;
  switch (intent.preset) {
    case 'split':
      return {
        kind: 'linear',
        originX: cx,
        originY: cy,
        angle: SPLIT_ANGLE[intent.side ?? 'left'],
        softnessPx,
      };
    case 'mirror': {
      const vertical = intent.direction === 'vertical';
      // On the frame a band is a third of the picture; on a subject it is the subject's extent.
      const across = vertical ? box.width : box.height;
      return {
        kind: 'band',
        originX: cx,
        originY: cy,
        angle: vertical ? 90 : 0,
        widthPx: onFrame ? across / 3 : across,
        softnessPx,
      };
    }
    case 'gradient': {
      const side = intent.side ?? 'top';
      const ends: Readonly<Record<ShapeSide, readonly [number, number, number, number]>> = {
        top: [cx, box.y, cx, box.y + box.height],
        bottom: [cx, box.y + box.height, cx, box.y],
        left: [box.x, cy, box.x + box.width, cy],
        right: [box.x + box.width, cy, box.x, cy],
      };
      const [startX, startY, endX, endY] = ends[side];
      return { kind: 'gradient', shape: 'linear', startX, startY, endX, endY, curve: 'smooth' };
    }
    case 'radial_gradient': {
      const radius = Math.hypot(box.width, box.height) / 2;
      return {
        kind: 'gradient',
        shape: 'radial',
        startX: cx,
        startY: cy,
        endX: cx + radius,
        endY: cy,
        curve: 'smooth',
      };
    }
    default:
      return null;
  }
}

/**
 * The whole `create_shape_mask` patch.
 *
 * @param project - The working project.
 * @param intent - What was asked for (validated).
 * @param candidate - The measured candidate when the call named one.
 * @returns The operations and the (first) new mask's id.
 * @throws ToolRefusalError with the remedy.
 */
export function buildShapePresetMaskOps(
  project: Project,
  intent: CreateShapeMaskIntent,
  candidate: MaskCandidate | undefined,
): BuiltMask {
  const { clip, size } = clipWithSize(project, intent.clipId);
  const { box, source, onFrame } = placementOf(intent, size, candidate);
  if (intent.preset === 'rounded_frame' && intent.purpose === 'hide') {
    throw new ToolRefusalError(
      'A rounded frame already keeps only its border, so "hide" has no meaning for it and ' +
        'nothing was changed. Use purpose "cutout" to keep the border, or a rectangle ' +
        '(create_mask with shape "rectangle") to hide an area.',
    );
  }
  const chain = new MaskCommandChain(project);
  const maskId = nextMaskId(clip);
  const target =
    intent.purpose === 'effect'
      ? ({
          kind: 'effect',
          effectId: addLimitedEffect(chain, clip, intent.effect),
        } as const)
      : undefined;
  const sourceTime = candidate?.sourceTime ?? clip.sourceStart;
  const analytic = analyticGeometry(intent, box, onFrame, size);
  let drawn;
  if (analytic !== null) {
    drawn = chain.run({
      type: 'draw_mask',
      clipId: clip.id,
      sourceTime,
      geometry: analytic,
      ...(target === undefined ? {} : { target }),
    });
  } else {
    drawn = chain.run({
      type: 'draw_shape_preset',
      clipId: clip.id,
      preset: PATH_PRESETS[intent.preset]!,
      box: {
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
        width: box.width,
        height: box.height,
      },
      ...(intent.points === undefined ? {} : { options: { points: intent.points } }),
      sourceTime,
      ...(target === undefined ? {} : { target }),
    });
  }
  attestMaskGeometry(drawn, source);
  const created = chain
    .clip(clip.id)
    ?.masks?.filter((mask) =>
      drawn.some(
        (operation) =>
          operation.type === 'add_mask' && (operation.mask as { id?: string }).id === mask.id,
      ),
    );
  const isPath = analytic === null;
  const feather = shapeEdgeFor(intent.edge, size).featherOuterPx;
  for (const mask of created ?? []) {
    const changes: Record<string, number | boolean> = {};
    if (isPath && feather > 0) changes.featherOuterPx = feather;
    if (intent.purpose === 'hide') changes.invert = true;
    if (Object.keys(changes).length === 0) continue;
    chain.run({
      type: 'set_mask_properties',
      clipId: clip.id,
      maskId: mask.id,
      sourceTime: clip.sourceStart,
      changes,
    });
  }
  return { operations: chain.operations, maskId };
}
