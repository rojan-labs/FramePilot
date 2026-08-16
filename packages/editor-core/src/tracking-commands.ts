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

function compileApplyTrackedMask(
  input: CompileTrackingCommandInput,
  command: ApplyTrackedMaskCommand,
): TrackingCommandCompileResult {
  const resolved = resolveTrackableMask(input, command);
  if ('rejection' in resolved) return resolved.rejection;
  const { clip, region, revision } = resolved;
  const conversion = convertTrackSamples({
    samples: command.samples,
    fps: command.fps,
    startSeconds: command.startSeconds,
    durationSeconds: clip.end - clip.start,
    keyframePrefix: `tracking__${command.clipId}`,
    ...(command.policy === undefined ? {} : { policy: command.policy }),
  });
  if (conversion.status === 'rejected') {
    // A track the policy refuses is reported as refused. It is never downgraded
    // into a partial or smoothed-over edit.
    return rejected(command, 'unusable_track', conversion.detail, conversion.facts);
  }
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
    ],
  };
  const facts: readonly TrackingCommandFact[] = [
    { name: 'clipId', value: command.clipId },
    { name: 'maskEffectId', value: command.maskEffectId },
    { name: 'trackingEffectId', value: professionalTrackingEffectId(command.clipId) },
    { name: 'engine', value: command.engine },
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
