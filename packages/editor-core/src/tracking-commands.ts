/** Deterministic tracking commands: manual mask motion, and measured pack tracks. */
import type { PatchId } from '@framepilot/shared-types';
import type { Asset, Effect, Keyframe, Timeline } from '@framepilot/timeline-schema';
import { evaluateKeyframes } from './keyframes.js';
import type { MaskBounds, TrackTarget } from './operations.js';
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

function maskBounds(effect: Effect): MaskBounds | undefined {
  const raw = effect.params.bounds;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const values = [record.x, record.y, record.width, record.height];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
  return {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number,
  };
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

function trackingKeyframes(
  clipId: string,
  mask: Effect,
  initial: MaskBounds,
  duration: number,
): readonly Keyframe[] | string {
  const relevant = mask.keyframes.filter((keyframe) =>
    BOX_PROPERTIES.includes(keyframe.property as (typeof BOX_PROPERTIES)[number]),
  );
  if (
    relevant.some(
      (keyframe) =>
        !Number.isFinite(keyframe.time) ||
        !Number.isFinite(keyframe.value) ||
        keyframe.time < 0 ||
        keyframe.time > duration + EPSILON,
    )
  ) {
    return 'Mask tracking keyframes must be finite and stay inside the clip.';
  }
  const times = [...new Set([0, duration, ...relevant.map((keyframe) => keyframe.time)])].sort(
    (left, right) => left - right,
  );
  const defaults: Record<(typeof BOX_PROPERTIES)[number], number> = initial;
  for (const time of times) {
    const resolved = Object.fromEntries(
      BOX_PROPERTIES.map((property) => [
        property,
        evaluateKeyframes(relevant, property, time) ?? defaults[property],
      ]),
    ) as unknown as MaskBounds;
    if (!boundsInsideFrame(resolved)) {
      return `Mask bounds leave the normalized frame at ${time}s.`;
    }
  }
  return BOX_PROPERTIES.flatMap((property) => {
    const points = relevant.filter((keyframe) => keyframe.property === property);
    const source = points.length > 0 ? points : [{ time: 0, value: defaults[property], easing: 'linear' as const }];
    return source.map((keyframe) => ({
      ...keyframe,
      id: `tracking__${clipId}__${property}__${Math.round(keyframe.time * 1000)}`,
      property,
    }));
  });
}

interface ResolvedTrackableMask {
  readonly clip: Timeline['tracks'][number]['clips'][number];
  readonly mask: Effect;
  readonly region: MaskBounds;
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
  const masks = found.clip.effects.filter(
    (effect) => effect.id === command.maskEffectId && effect.type === 'mask',
  );
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
  if (mask.params.shape !== 'rectangle' && mask.params.shape !== 'ellipse') {
    return {
      rejection: rejected(
        command,
        'unsupported_mask_shape',
        'Box tracking currently requires a rectangle or ellipse mask.',
      ),
    };
  }
  const region = maskBounds(mask);
  if (!region || !boundsInsideFrame(region)) {
    return {
      rejection: rejected(
        command,
        'missing_region',
        'The mask needs valid normalized bounds to track.',
      ),
    };
  }
  return { clip: found.clip, mask, region, revision };
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
  const { clip, mask, region, revision } = resolved;
  const keyframes = trackingKeyframes(
    command.clipId,
    mask,
    region,
    clip.end - clip.start,
  );
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
function framesPerClipSecond(
  clip: ResolvedTrackableMask['clip'],
  fps: number,
): number | string {
  if (clip.speedRamp !== undefined && clip.speedRamp.length > 0) {
    return 'Measured tracks cannot yet be applied to a clip with a speed curve. Remove the ramp, track, then re-apply it.';
  }
  const speed = clip.speed ?? 1;
  if (!(speed > 0)) {
    return 'Measured tracks can only be applied to a clip playing forward (not frozen or reversed).';
  }
  return fps * speed;
}

function numberParam(effect: Effect, name: string): number | undefined {
  const value = effect.params[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The mask's own keyframes after a measured track is applied.
 *
 * The export compiler (`_attach_mask`) and every mask reader animate the MASK
 * effect's keyframes; the `object_track` effect is provenance only. So the
 * measured motion must land on the mask, or nothing on screen moves.
 *
 * `target: 'object'` is the point-follow path (`tracking.point`): the worker's
 * box is only the tracked feature's patch, a few pixels wide, so steering the
 * mask's size from it collapses the user's drawn mask. There only the centre
 * moves, and the drawn width/height are kept.
 */
function trackedMaskKeyframes(
  clipId: string,
  mask: Effect,
  region: MaskBounds,
  target: ApplyTrackedMaskCommand['target'],
  measured: readonly Keyframe[],
): Keyframe[] {
  const kept = mask.keyframes.filter(
    (keyframe) => !BOX_PROPERTIES.includes(keyframe.property as (typeof BOX_PROPERTIES)[number]),
  );
  const byTime = new Map<number, Record<string, Keyframe>>();
  for (const keyframe of measured) {
    const slot = byTime.get(keyframe.time) ?? {};
    slot[keyframe.property] = keyframe;
    byTime.set(keyframe.time, slot);
  }
  const steered: Keyframe[] = [];
  for (const [time, slot] of byTime) {
    const [x, y, width, height] = BOX_PROPERTIES.map((name) => slot[name]?.value);
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
    const suffix = Math.round(time * 1_000_000);
    for (const name of BOX_PROPERTIES) {
      steered.push({
        id: `tracking__${clipId}__mask__${name}__${suffix}`,
        property: name,
        time,
        value: box[name],
        easing: 'linear',
      });
    }
  }
  return [...kept, ...steered];
}

/** Re-state the drawn mask, preserving its geometry params, with the tracked keyframes. */
function steeredMaskOperation(
  clipId: string,
  mask: Effect,
  region: MaskBounds,
  keyframes: readonly Keyframe[],
): Extract<Patch['operations'][number], { type: 'add_mask' }> {
  const feather = numberParam(mask, 'feather');
  const opacity = numberParam(mask, 'opacity');
  const invert = mask.params.invert;
  return {
    type: 'add_mask',
    clipId,
    shape: mask.params.shape as 'rectangle' | 'ellipse',
    bounds: region,
    ...(feather === undefined ? {} : { feather }),
    ...(opacity === undefined ? {} : { opacity }),
    ...(typeof invert === 'boolean' ? { invert } : {}),
    keyframes,
  };
}

function compileApplyTrackedMask(
  input: CompileTrackingCommandInput,
  command: ApplyTrackedMaskCommand,
): TrackingCommandCompileResult {
  const resolved = resolveTrackableMask(input, command);
  if ('rejection' in resolved) return resolved.rejection;
  const { clip, mask, region, revision } = resolved;
  // `add_mask` always writes `<clip>__mask`; steering any other mask id would
  // silently animate a different effect than the one the caller named.
  if (command.maskEffectId !== professionalMaskEffectId(command.clipId)) {
    return rejected(
      command,
      'missing_mask',
      `Measured tracks steer the clip's mask "${professionalMaskEffectId(command.clipId)}", not "${command.maskEffectId}".`,
    );
  }
  const rate = framesPerClipSecond(clip, command.fps);
  if (typeof rate === 'string') return rejected(command, 'unusable_track', rate);
  const conversion = convertTrackSamples({
    samples: command.samples,
    fps: rate,
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
  const maskKeyframes = trackedMaskKeyframes(
    command.clipId,
    mask,
    region,
    command.target,
    conversion.keyframes,
  );
  const patch: Patch = {
    patchId: `tracking__${command.clipId}__${revision}` as PatchId,
    createdBy: 'agent',
    reason: `Apply measured track to "${command.clipId}"`,
    operations: [
      {
        type: 'track_object',
        clipId: command.clipId,
        target: command.target,
        region,
        engine: command.engine,
        keyframes: conversion.keyframes,
      },
      steeredMaskOperation(command.clipId, mask, region, maskKeyframes),
    ],
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
