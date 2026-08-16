/** Deterministic professional motion commands compiled into reversible keyframe patches. */
import type { PatchId } from '@framepilot/shared-types';
import type { Asset, Keyframe, Timeline } from '@framepilot/timeline-schema';
import { clipKeyframeContractIssue, type ClipKeyframeProperty } from './edit-value-contracts.js';
import type { Easing } from './keyframes.js';
import { applyPatch, invertPatch, type Patch } from './patch.js';
import { validatePatch } from './validator.js';

const TIME_EPSILON = 1e-6;

export interface MotionFrameRate {
  readonly numerator: number;
  readonly denominator: number;
}

export interface MotionFramePoint {
  /** Clip presentation frames, relative to the clip's sequence start. */
  readonly domain: 'clip';
  readonly frame: number;
  readonly value: number;
  /** Curve from this point into the next point. */
  readonly easing: Easing;
}

export interface AnimateClipPropertyCommand {
  readonly type: 'animate_clip_property';
  readonly timelineRevision: number;
  readonly clipId: string;
  readonly property: ClipKeyframeProperty;
  readonly rate: MotionFrameRate;
  readonly points: readonly MotionFramePoint[];
}

export type MotionCommand = AnimateClipPropertyCommand;

export type MotionCommandRejectionCode =
  | 'stale_timeline'
  | 'invalid_frame_rate'
  | 'insufficient_points'
  | 'duplicate_frame'
  | 'missing_clip'
  | 'locked_track'
  | 'wrong_track_kind'
  | 'point_outside_clip'
  | 'invalid_keyframe'
  | 'invalid_patch';

export interface MotionCommandFact {
  readonly name: string;
  readonly value: string | number | boolean;
}

export type MotionCommandCompileResult =
  | {
      readonly status: 'compiled';
      readonly command: MotionCommand;
      readonly patch: Patch;
      readonly inversePatch: Patch;
      readonly facts: readonly MotionCommandFact[];
    }
  | {
      readonly status: 'rejected';
      readonly command: MotionCommand;
      readonly code: MotionCommandRejectionCode;
      readonly detail: string;
      readonly facts: readonly MotionCommandFact[];
    };

export interface CompileMotionCommandInput {
  readonly timeline: Timeline;
  readonly assets: readonly Asset[];
  readonly command: MotionCommand;
}

function rejected(
  command: MotionCommand,
  code: MotionCommandRejectionCode,
  detail: string,
  facts: readonly MotionCommandFact[] = [],
): MotionCommandCompileResult {
  return { status: 'rejected', command, code, detail, facts };
}

function validRate(rate: MotionFrameRate): boolean {
  return (
    Number.isSafeInteger(rate.numerator) &&
    rate.numerator > 0 &&
    Number.isSafeInteger(rate.denominator) &&
    rate.denominator > 0
  );
}

function pointSeconds(point: MotionFramePoint, rate: MotionFrameRate): number {
  return (point.frame * rate.denominator) / rate.numerator;
}

function compileAnimateClipProperty(
  input: CompileMotionCommandInput,
  command: AnimateClipPropertyCommand,
): MotionCommandCompileResult {
  const currentRevision = input.timeline.revision ?? 0;
  if (command.timelineRevision !== currentRevision) {
    return rejected(
      command,
      'stale_timeline',
      `Command targets timeline revision ${command.timelineRevision}, but current revision is ${currentRevision}.`,
    );
  }
  if (!validRate(command.rate)) {
    return rejected(command, 'invalid_frame_rate', 'Motion rate must be a positive rational rate.');
  }
  if (command.points.length < 2) {
    return rejected(
      command,
      'insufficient_points',
      'Professional motion requires at least two keyframes.',
    );
  }
  const frames = new Set<number>();
  for (const point of command.points) {
    if (!Number.isSafeInteger(point.frame) || point.frame < 0) {
      return rejected(
        command,
        'point_outside_clip',
        'Motion keyframe positions must be non-negative integer clip frames.',
      );
    }
    if (frames.has(point.frame)) {
      return rejected(
        command,
        'duplicate_frame',
        `Motion command contains more than one point at clip frame ${point.frame}.`,
      );
    }
    frames.add(point.frame);
  }

  let found:
    | {
        readonly clip: Timeline['tracks'][number]['clips'][number];
        readonly track: Timeline['tracks'][number];
      }
    | undefined;
  for (const track of input.timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === command.clipId);
    if (clip) {
      found = { clip, track };
      break;
    }
  }
  if (!found) return rejected(command, 'missing_clip', `Clip "${command.clipId}" does not exist.`);
  if (found.track.locked === true) {
    return rejected(command, 'locked_track', `Track "${found.track.id}" is locked.`);
  }
  if (found.track.type === 'audio' || found.track.type === 'caption') {
    return rejected(
      command,
      'wrong_track_kind',
      `Clip "${command.clipId}" is not on a visual track.`,
    );
  }

  const duration = found.clip.end - found.clip.start;
  const sorted = [...command.points].sort((left, right) => left.frame - right.frame);
  const keyframes: Keyframe[] = [];
  for (const point of sorted) {
    const time = pointSeconds(point, command.rate);
    if (time > duration + TIME_EPSILON) {
      return rejected(
        command,
        'point_outside_clip',
        `Clip frame ${point.frame} lands at ${time}s, outside the ${duration}s clip.`,
        [{ name: 'clipDurationSeconds', value: duration }],
      );
    }
    const keyframe: Keyframe = {
      id: `motion__${command.clipId}__${command.property}__${point.frame}`,
      time,
      property: command.property,
      value: point.value,
      easing: point.easing,
    };
    const issue = clipKeyframeContractIssue(keyframe);
    if (issue) {
      return rejected(command, 'invalid_keyframe', issue.message, [
        { name: 'invalidFrame', value: point.frame },
      ]);
    }
    keyframes.push(keyframe);
  }

  const patch: Patch = {
    patchId:
      `motion__${command.clipId}__${command.property}__${sorted[0]!.frame}__${sorted.at(-1)!.frame}` as PatchId,
    createdBy: 'agent',
    reason: `Animate ${command.property} on "${command.clipId}"`,
    operations: [{ type: 'add_keyframes', clipId: command.clipId, keyframes, replace: true }],
  };
  const facts: readonly MotionCommandFact[] = [
    { name: 'property', value: command.property },
    { name: 'pointCount', value: keyframes.length },
    { name: 'startClipFrame', value: sorted[0]!.frame },
    { name: 'endClipFrame', value: sorted.at(-1)!.frame },
  ];
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

/** Compile a revision-bound motion command into one validated reversible keyframe patch. */
export function compileMotionCommand(input: CompileMotionCommandInput): MotionCommandCompileResult {
  switch (input.command.type) {
    case 'animate_clip_property':
      return compileAnimateClipProperty(input, input.command);
  }
}
