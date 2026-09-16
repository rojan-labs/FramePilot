/**
 * Deterministic tracking commands: manual mask motion, and measured pack tracks.
 *
 * Schema v22 (ADR 0178): the mask is a `Clip.masks` layer in source pixels with SOURCE-time
 * keyframes. The `object_track` effect (`track_object`) keeps its v21 vocabulary — clip
 * timeline seconds and frame fractions — because it is provenance for the tracker, and the
 * conversions between the two live here and in `mask-builders.ts`, nowhere else.
 */
import type { PatchId } from '@framepilot/shared-types';
import {
  masksOf,
  type Asset,
  type Keyframe,
  type MaskKeyframe,
  type MaskLayer,
  type MaskScalarProperty,
  type Timeline,
} from '@framepilot/timeline-schema';
import { assetDisplaySize, type DisplaySize } from './mask-geometry.js';
import { MEASURE_MEDIA_FIRST, maskFrameBox } from './mask-builders.js';
import type { MaskBounds, Operation, TrackTarget } from './operations.js';
import { applyPatch, invertPatch, type Patch } from './patch.js';
import {
  convertTrackSamples,
  type TrackConversionPolicy,
  type TrackSample,
} from './track-samples.js';
import { validatePatch } from './validator.js';

const BOX_PROPERTIES = ['x', 'y', 'width', 'height'] as const;
const EPSILON = 1e-6;

export const professionalTrackingEffectId = (clipId: string): string => `${clipId}__track`;
export const professionalMaskEffectId = (clipId: string): string => `${clipId}__mask`;

export interface TrackExistingMaskCommand {
  readonly type: 'track_existing_mask';
  readonly timelineRevision: number;
  readonly clipId: string;
  readonly maskEffectId: string;
  readonly target: Extract<TrackTarget, 'object' | 'bounding_box'>;
  readonly engine: 'manual';
}

/**
 * Apply a track measured by a Capability Pack worker to an existing mask.
 *
 * The samples are measurements, not an edit. This command is where they become
 * one: they pass through the host's deterministic conversion policy and then a
 * validated, exactly invertible patch. The worker never touches the project.
 */
export interface ApplyTrackedMaskCommand {
  readonly type: 'apply_tracked_mask';
  readonly timelineRevision: number;
  readonly clipId: string;
  readonly maskEffectId: string;
  readonly target: Extract<TrackTarget, 'object' | 'bounding_box'>;
  /** Exact pack identity that measured this track, recorded as provenance. */
  readonly engine: string;
  readonly fps: number;
  /** Clip-relative time, in seconds, of the first tracked frame. */
  readonly startSeconds: number;
  /**
   * The frame index `startSeconds` corresponds to — the first frame REQUESTED.
   * Without it the first usable sample is assumed to sit at `startSeconds`,
   * which shifts the whole track early when the opening frames were occluded.
   */
  readonly firstFrame?: number;
  /**
   * Measured samples. `target: 'object'` means point follow: only the centre of
   * each box steers the mask, keeping the drawn size.
   */
  readonly samples: readonly TrackSample[];
  readonly policy?: Partial<TrackConversionPolicy>;
}

export type TrackingCommand = TrackExistingMaskCommand | ApplyTrackedMaskCommand;

export type TrackingCommandRejectionCode =
  | 'stale_timeline'
  | 'missing_clip'
  | 'locked_track'
  | 'wrong_track_kind'
  | 'missing_mask'
  | 'ambiguous_mask'
  | 'unsupported_mask_shape'
  | 'missing_region'
  | 'invalid_mask_motion'
  | 'unusable_track'
  | 'invalid_patch';

export interface TrackingCommandFact {
  readonly name: string;
  readonly value: string | number | boolean;
}

export type TrackingCommandCompileResult =
  | {
      readonly status: 'compiled';
      readonly command: TrackingCommand;
      readonly patch: Patch;
      readonly inversePatch: Patch;
      readonly facts: readonly TrackingCommandFact[];
    }
  | {
      readonly status: 'rejected';
      readonly command: TrackingCommand;
      readonly code: TrackingCommandRejectionCode;
      readonly detail: string;
      readonly facts: readonly TrackingCommandFact[];
    };

export interface CompileTrackingCommandInput {
  readonly timeline: Timeline;
  readonly assets: readonly Asset[];
  readonly command: TrackingCommand;
}

function rejected(
  command: TrackingCommand,
  code: TrackingCommandRejectionCode,
  detail: string,
  facts: readonly TrackingCommandFact[] = [],
): TrackingCommandCompileResult {
  return { status: 'rejected', command, code, detail, facts };
}

function boundsInsideFrame(bounds: MaskBounds): boolean {
  return (
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x + bounds.width <= 1 + EPSILON &&
    bounds.y + bounds.height <= 1 + EPSILON
  );
}

type BoxMask = Extract<MaskLayer, { kind: 'rectangle' | 'ellipse' }>;

/** The source-time properties that describe a box mask's geometry. */
const geometryProperties = (mask: BoxMask): readonly MaskScalarProperty[] =>
  mask.kind === 'ellipse' ? ['cx', 'cy', 'rx', 'ry'] : ['cx', 'cy', 'width', 'height'];

/**
 * The mask's box motion restated as `object_track` keyframes (clip timeline seconds, frame
 * fractions), sampled at every instant any geometry property is keyed.
 *
 * Refused for a clip whose source is not consumed forwards at a constant rate: there is no
 * single timeline instant for a source keyframe under a ramp, freeze or reverse, and a
 * guessed one would place the tracker on the wrong frame.
 */
function trackingKeyframes(
  clip: ResolvedTrackableMask['clip'],
  mask: BoxMask,
  size: DisplaySize | null,
): readonly Keyframe[] | string {
  const clipId = clip.id;
  const duration = clip.end - clip.start;
  const relevant = mask.keyframes.filter((keyframe) =>
    geometryProperties(mask).includes(keyframe.property),
  );
  if (
    relevant.some(
      (keyframe) => !Number.isFinite(keyframe.sourceTime) || !Number.isFinite(keyframe.value),
    )
  ) {
    return 'Mask tracking keyframes must be finite.';
  }
  const rate = forwardRate(clip);
  if (relevant.length > 0 && typeof rate === 'string') return rate;
  const speed = typeof rate === 'number' ? rate : 1;
  const toClipTime = (sourceTime: number): number => (sourceTime - clip.sourceStart) / speed;
  const toSourceTime = (time: number): number => clip.sourceStart + time * speed;
  if (
    relevant.some(
      (keyframe) =>
        toClipTime(keyframe.sourceTime) < -EPSILON ||
        toClipTime(keyframe.sourceTime) > duration + EPSILON,
    )
  ) {
    return 'Mask tracking keyframes must stay inside the clip.';
  }
  const times = [
    ...new Set([0, duration, ...relevant.map((keyframe) => toClipTime(keyframe.sourceTime))]),
  ].sort((left, right) => left - right);
  const boxes: { readonly time: number; readonly box: MaskBounds }[] = [];
  for (const time of times) {
    const box = maskFrameBox(mask, size, toSourceTime(time));
    if (box === null) return MEASURE_MEDIA_FIRST;
    if (!boundsInsideFrame(box))
      return 'Mask bounds leave the frame during the clip. Keep the mask inside the picture.';
    boxes.push({ time, box });
  }
  const animated = relevant.length > 0 ? boxes : boxes.slice(0, 1);
  return BOX_PROPERTIES.flatMap((property) =>
    animated.map(({ time, box }) => ({
      id: `tracking__${clipId}__${property}__${Math.round(time * 1000)}`,
      time,
      property,
      value: box[property],
      easing: 'linear' as const,
    })),
  );
}

interface ResolvedTrackableMask {
  readonly clip: Timeline['tracks'][number]['clips'][number];
  readonly mask: BoxMask;
  /** The mask's box at the clip's in-point, frame fractions. */
  readonly region: MaskBounds;
  /** The clip media's display-corrected size (`null` only for a normalised legacy mask). */
  readonly size: DisplaySize | null;
  readonly revision: number;
}

/**
 * Shared preconditions for every tracking command: a current revision, an
 * existing unlocked visual clip, and exactly one box-shaped mask with valid
 * in-frame bounds. Both compilers use this so a new command cannot skip a check.
 */
function resolveTrackableMask(
  input: CompileTrackingCommandInput,
  command: TrackingCommand,
): ResolvedTrackableMask | { readonly rejection: TrackingCommandCompileResult } {
  const revision = input.timeline.revision ?? 0;
  if (command.timelineRevision !== revision) {
    return {
      rejection: rejected(
        command,
        'stale_timeline',
        `Command targets timeline revision ${command.timelineRevision}, but current revision is ${revision}.`,
      ),
    };
  }
  const found = input.timeline.tracks
    .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
    .find(({ clip }) => clip.id === command.clipId);
  if (!found) {
    return {
      rejection: rejected(command, 'missing_clip', `Clip "${command.clipId}" does not exist.`),
    };
  }
  if (found.track.locked === true) {
    return {
      rejection: rejected(command, 'locked_track', `Track "${found.track.id}" is locked.`),
    };
  }
  if (found.track.type === 'audio' || found.track.type === 'caption') {
    return {
      rejection: rejected(command, 'wrong_track_kind', `Clip "${command.clipId}" is not visual.`),
    };
  }
  const masks = masksOf(found.clip).filter((mask) => mask.id === command.maskEffectId);
  if (masks.length === 0) {
    return {
      rejection: rejected(
        command,
        'missing_mask',
        `Mask "${command.maskEffectId}" does not exist.`,
      ),
    };
  }
  if (masks.length > 1) {
    return {
      rejection: rejected(
        command,
        'ambiguous_mask',
        `Mask "${command.maskEffectId}" is duplicated.`,
      ),
    };
  }
  const mask = masks[0]!;
  if (mask.kind !== 'rectangle' && mask.kind !== 'ellipse') {
    return {
      rejection: rejected(
        command,
        'unsupported_mask_shape',
        'Box tracking currently requires a rectangle or ellipse mask.',
      ),
    };
  }
  const asset = input.assets.find((candidate) => candidate.id === found.clip.assetId);
  const size = assetDisplaySize(asset?.media);
  const region = maskFrameBox(mask, size, found.clip.sourceStart);
  if (region === null) {
    return { rejection: rejected(command, 'missing_region', MEASURE_MEDIA_FIRST) };
  }
  if (!boundsInsideFrame(region)) {
    return {
      rejection: rejected(
        command,
        'missing_region',
        'The mask needs a box inside the picture to track.',
      ),
    };
  }
  return { clip: found.clip, mask, region, size, revision };
}

/** Validate, invert, and prove the round trip before a patch is ever offered. */
function finalizePatch(
  input: CompileTrackingCommandInput,
  command: TrackingCommand,
  patch: Patch,
  facts: readonly TrackingCommandFact[],
): TrackingCommandCompileResult {
  const validation = validatePatch(input.timeline, patch, {
    assetIds: input.assets.map((asset) => asset.id),
  });
  if (!validation.valid) {
    return rejected(
      command,
      'invalid_patch',
      validation.issues.map((issue) => issue.message).join('; '),
      facts,
    );
  }
  try {
    const inversePatch = invertPatch(input.timeline, patch);
    applyPatch(applyPatch(input.timeline, patch), inversePatch);
    return { status: 'compiled', command, patch, inversePatch, facts };
  } catch (error) {
    return rejected(
      command,
      'invalid_patch',
      error instanceof Error ? error.message : String(error),
      facts,
    );
  }
}

function compileTrackExistingMask(
  input: CompileTrackingCommandInput,
  command: TrackExistingMaskCommand,
): TrackingCommandCompileResult {
  const resolved = resolveTrackableMask(input, command);
  if ('rejection' in resolved) return resolved.rejection;
  const { clip, mask, region, size, revision } = resolved;
  const keyframes = trackingKeyframes(clip, mask, size);
  if (typeof keyframes === 'string') {
    return rejected(command, 'invalid_mask_motion', keyframes);
  }
  const patch: Patch = {
    patchId: `tracking__${command.clipId}__${revision}` as PatchId,
    createdBy: 'agent',
    reason: `Track existing mask on "${command.clipId}"`,
    operations: [
      {
        type: 'track_object',
        clipId: command.clipId,
        target: command.target,
        region,
        engine: command.engine,
        keyframes,
      },
    ],
  };
  const facts: readonly TrackingCommandFact[] = [
    { name: 'clipId', value: command.clipId },
    { name: 'maskEffectId', value: command.maskEffectId },
    { name: 'trackingEffectId', value: professionalTrackingEffectId(command.clipId) },
    { name: 'trackingKeyframeCount', value: keyframes.length },
  ];
  return finalizePatch(input, command, patch, facts);
}

/**
 * Clip-seconds per measured source frame, or a refusal when the clip's time map
 * is not a constant forward rate.
 *
 * Workers sample the clip's SOURCE range, so frame `n` sits `n / fps` source
 * seconds in — but mask keyframes live in clip (timeline) seconds. A clip at
 * speed 2 shows those frames in half the time; ignoring that put every keyframe
 * past the clip's end. A freeze, a reverse or a speed curve has no single linear
 * mapping, and guessing one would steer the mask onto the wrong frames.
 */
function forwardRate(clip: ResolvedTrackableMask['clip']): number | string {
  if (clip.speedRamp !== undefined && clip.speedRamp.length > 0) {
    return 'Measured tracks cannot yet be applied to a clip with a speed curve. Remove the ramp, track, then re-apply it.';
  }
  const speed = clip.speed ?? 1;
  if (!(speed > 0)) {
    return 'Measured tracks can only be applied to a clip playing forward (not frozen or reversed).';
  }
  return speed;
}

/**
 * The mask after a measured track is applied: its box geometry keyframed on the SOURCE
 * clock, in source pixels.
 *
 * The export compiler and every mask reader animate the MASK's keyframes; the
 * `object_track` effect is provenance only. So the measured motion must land on the mask,
 * or nothing on screen moves.
 *
 * `target: 'object'` is the point-follow path (`tracking.point`): the worker's box is only
 * the tracked feature's patch, a few pixels wide, so steering the mask's size from it
 * collapses the user's drawn mask. There only the centre moves, and the drawn size is kept.
 */
function trackedMask(
  clip: ResolvedTrackableMask['clip'],
  mask: BoxMask,
  region: MaskBounds,
  size: DisplaySize | null,
  target: ApplyTrackedMaskCommand['target'],
  measured: readonly Keyframe[],
  speed: number,
): BoxMask {
  const scale = mask.units === 'normalized' ? { width: 1, height: 1 } : size!;
  const properties = geometryProperties(mask);
  const steeredProperties = target === 'object' ? properties.slice(0, 2) : properties;
  const kept = mask.keyframes.filter((keyframe) => !steeredProperties.includes(keyframe.property));
  const byTime = new Map<number, Record<string, number>>();
  for (const keyframe of measured) {
    const slot = byTime.get(keyframe.time) ?? {};
    slot[keyframe.property] = keyframe.value;
    byTime.set(keyframe.time, slot);
  }
  const steered: MaskKeyframe[] = [];
  for (const [time, slot] of [...byTime].sort(([left], [right]) => left - right)) {
    const { x, y, width, height } = slot;
    if (x === undefined || y === undefined || width === undefined || height === undefined) continue;
    const box: MaskBounds =
      target === 'object'
        ? {
            x: Math.min(Math.max(x + width / 2 - region.width / 2, 0), 1 - region.width),
            y: Math.min(Math.max(y + height / 2 - region.height / 2, 0), 1 - region.height),
            width: region.width,
            height: region.height,
          }
        : { x, y, width, height };
    const sourceTime = clip.sourceStart + time * speed;
    const values: Record<MaskScalarProperty, number> = {
      cx: (box.x + box.width / 2) * scale.width,
      cy: (box.y + box.height / 2) * scale.height,
      width: box.width * scale.width,
      height: box.height * scale.height,
      rx: (box.width * scale.width) / 2,
      ry: (box.height * scale.height) / 2,
    } as Record<MaskScalarProperty, number>;
    const suffix = Math.round(time * 1_000_000);
    for (const property of steeredProperties) {
      steered.push({
        id: `tracking__${clip.id}__mask__${property}__${suffix}`,
        sourceTime,
        property,
        value: values[property],
        easing: 'linear',
      });
    }
  }
  return {
    ...mask,
    keyframes: [...kept, ...steered].sort((left, right) => left.sourceTime - right.sourceTime),
  };
}

function compileApplyTrackedMask(
  input: CompileTrackingCommandInput,
  command: ApplyTrackedMaskCommand,
): TrackingCommandCompileResult {
  const resolved = resolveTrackableMask(input, command);
  if ('rejection' in resolved) return resolved.rejection;
  const { clip, mask, region, size, revision } = resolved;
  // Tracking tools steer the clip's primary mask `<clip>__mask`; steering any other id would
  // silently animate a different mask than the one the caller named.
  if (command.maskEffectId !== professionalMaskEffectId(command.clipId)) {
    return rejected(
      command,
      'missing_mask',
      `Measured tracks steer the clip's mask "${professionalMaskEffectId(command.clipId)}", not "${command.maskEffectId}".`,
    );
  }
  const rate = forwardRate(clip);
  if (typeof rate === 'string') return rejected(command, 'unusable_track', rate);
  const conversion = convertTrackSamples({
    samples: command.samples,
    fps: command.fps * rate,
    startSeconds: command.startSeconds,
    ...(command.firstFrame === undefined ? {} : { firstFrame: command.firstFrame }),
    durationSeconds: clip.end - clip.start,
    keyframePrefix: `tracking__${command.clipId}`,
    ...(command.policy === undefined ? {} : { policy: command.policy }),
  });
  if (conversion.status === 'rejected') {
    // A track the policy refuses is reported as refused. It is never downgraded
    // into a partial or smoothed-over edit.
    return rejected(command, 'unusable_track', conversion.detail, conversion.facts);
  }
  const steered = trackedMask(clip, mask, region, size, command.target, conversion.keyframes, rate);
  const index = masksOf(clip).findIndex((candidate) => candidate.id === mask.id);
  const operations: Operation[] = [
    {
      type: 'track_object',
      clipId: command.clipId,
      target: command.target,
      region,
      engine: command.engine,
      keyframes: conversion.keyframes,
    },
    // Restate the mask with its steered keyframes at the same stack position: the remove and
    // the add are one validated, exactly invertible pair.
    { type: 'remove_mask', clipId: command.clipId, maskId: mask.id },
    { type: 'add_mask', clipId: command.clipId, mask: steered, index },
  ];
  const patch: Patch = {
    patchId: `tracking__${command.clipId}__${revision}` as PatchId,
    createdBy: 'agent',
    reason: `Apply measured track to "${command.clipId}"`,
    operations,
  };
  const facts: readonly TrackingCommandFact[] = [
    { name: 'clipId', value: command.clipId },
    { name: 'maskEffectId', value: command.maskEffectId },
    { name: 'trackingEffectId', value: professionalTrackingEffectId(command.clipId) },
    { name: 'engine', value: command.engine },
    { name: 'follow', value: command.target === 'object' ? 'centre' : 'box' },
    ...conversion.facts,
  ];
  return finalizePatch(input, command, patch, facts);
}

/** Compile a tracking command into a validated reversible tracking effect. */
export function compileTrackingCommand(
  input: CompileTrackingCommandInput,
): TrackingCommandCompileResult {
  switch (input.command.type) {
    case 'track_existing_mask':
      return compileTrackExistingMask(input, input.command);
    case 'apply_tracked_mask':
      return compileApplyTrackedMask(input, input.command);
  }
}
