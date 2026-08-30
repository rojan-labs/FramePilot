import type { Clip, EffectLayer, Timeline, Track } from '@framepilot/timeline-schema';
import { effectLayersOf } from '@framepilot/timeline-schema';
import { paramsForKind } from '@framepilot/timeline-schema/effect-params';
import {
  AUDIO_FADE_CURVES,
  CLIP_KEYFRAME_PROPERTIES,
  audioAutomationContractIssue,
  audioDynamicsContractIssue,
  audioEqContractIssue,
  audioFadeCurveSupported,
  audioGainContractIssue,
  clipKeyframeContractIssue,
  colorGradeContractIssues,
  duckAmountContractIssue,
} from './edit-value-contracts.js';
import type { Operation } from './operations.js';

export class OperationContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OperationContractError';
  }
}

function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OperationContractError(`${label} must be finite.`);
  }
}

const positiveRange = (start: number, end: number, label: string): void => {
  finite(start, `${label}.start`);
  finite(end, `${label}.end`);
  if (start < 0) {
    throw new OperationContractError(`${label}.start must be non-negative, got ${start}s.`);
  }
  if (end <= start) {
    // Name the times. A bare "end must be greater than start" tells the author
    // — often a model with no other view of the rejected patch — nothing about
    // WHICH moment is wrong, so the only available next move is to reissue the
    // same call and hope. That is exactly what happened in run 7d159862: four
    // identical rejections, ~10 model calls, no way to tell a zero-length range
    // from an inverted one.
    const detail =
      end === start
        ? `both are ${start}s, so it would occupy no time`
        : `${start}s → ${end}s runs backwards`;
    throw new OperationContractError(`${label}.end must be greater than start: ${detail}.`);
  }
};

const findTrack = (timeline: Timeline, trackId: string): Track | undefined =>
  timeline.tracks.find((track) => track.id === trackId);

const findClip = (timeline: Timeline, clipId: string): { track: Track; clip: Clip } | undefined => {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
};

const findEffectLayer = (
  timeline: Timeline,
  layerId: string,
): { track: Track; layer: EffectLayer } | undefined => {
  for (const track of timeline.tracks) {
    const layer = effectLayersOf(track).find((candidate) => candidate.id === layerId);
    if (layer) return { track, layer };
  }
  return undefined;
};

const effectTrack = (timeline: Timeline, layerId: string): Track | undefined =>
  findEffectLayer(timeline, layerId)?.track;

const assertUnlocked = (track: Track | undefined, operation: string): void => {
  if (track?.locked === true) {
    throw new OperationContractError(
      `${operation} cannot modify locked track "${track.id}". Unlock it first.`,
    );
  }
};

const assertClipUnlocked = (timeline: Timeline, clipId: string, operation: string): void => {
  assertUnlocked(findClip(timeline, clipId)?.track, operation);
};

function assertTrackerRegion(region: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): void {
  for (const [name, value] of Object.entries(region)) {
    finite(value, `track_object.region.${name}`);
    if (value < 0 || value > 1) {
      throw new OperationContractError(`track_object.region.${name} must be within 0..1.`);
    }
  }
  if (region.width <= 0 || region.height <= 0) {
    throw new OperationContractError('track_object region width and height must be positive.');
  }
  if (region.x + region.width > 1 || region.y + region.height > 1) {
    throw new OperationContractError('track_object region must stay inside the normalized frame.');
  }
}

function assertKeyframes(op: Extract<Operation, { type: 'add_keyframes' }>): void {
  for (const keyframe of op.keyframes) {
    const issue = clipKeyframeContractIssue(keyframe);
    if (issue) {
      throw new OperationContractError(`add_keyframes.${keyframe.property}.${issue.message}`);
    }
  }
}

function assertKeyframeTargets(op: Extract<Operation, { type: 'remove_keyframes' }>): void {
  const supported = new Set<string>(CLIP_KEYFRAME_PROPERTIES);
  for (const target of op.targets) {
    if (!supported.has(target.property)) {
      throw new OperationContractError(
        `remove_keyframes property "${target.property}" is unsupported. ` +
          `Supported properties: ${CLIP_KEYFRAME_PROPERTIES.join(', ')}.`,
      );
    }
    if (target.time !== undefined) {
      finite(target.time, `remove_keyframes.${target.property}.time`);
      if (target.time < 0) {
        throw new OperationContractError('remove_keyframes times must be non-negative.');
      }
    }
  }
}

function assertEffectParams(layer: EffectLayer, params: Readonly<Record<string, number>>): void {
  const descriptors = new Map(
    paramsForKind(layer.kind).map((descriptor) => [descriptor.name, descriptor]),
  );
  for (const [name, value] of Object.entries(params)) {
    finite(value, `effect.${name}`);
    const descriptor = descriptors.get(name);
    if (!descriptor) {
      throw new OperationContractError(
        `Effect kind "${layer.kind}" does not support parameter "${name}".`,
      );
    }
    if (value < descriptor.min || value > descriptor.max) {
      throw new OperationContractError(
        `Effect parameter "${name}" must be within ${String(descriptor.min)}..${String(descriptor.max)}.`,
      );
    }
  }
}

/**
 * Last-resort semantic gate shared by every patch application surface.
 *
 * Tool schemas remain the first boundary and the patch validator remains the rich
 * diagnostic pass. This guard protects canonical persisted state when another surface
 * constructs an operation directly or when a cross-language schema drifts.
 */
export function assertOperationContract(timeline: Timeline, op: Operation): void {
  switch (op.type) {
    case 'trim_clip':
      assertClipUnlocked(timeline, op.clipId, op.type);
      positiveRange(op.start, op.end, op.type);
      return;
    case 'set_clip_source_range':
      assertClipUnlocked(timeline, op.clipId, op.type);
      positiveRange(op.sourceStart, op.sourceEnd, op.type);
      return;
    case 'set_clip_media':
      assertClipUnlocked(timeline, op.clipId, op.type);
      if (op.assetId.length === 0) {
        throw new OperationContractError('set_clip_media.assetId must not be empty.');
      }
      positiveRange(op.sourceStart, op.sourceEnd, op.type);
      return;
    case 'split_clip': {
      assertClipUnlocked(timeline, op.clipId, op.type);
      // The contract runs on RAW intent, before frame normalization — which is also
      // where the legacy `time` spelling is migrated to the canonical `at`. Reading
      // both here keeps a stored recipe that predates the rename valid, without
      // letting a missing or non-finite split point through: accepting a documented
      // older spelling is not the same as repairing an invalid value.
      const legacy = op as typeof op & { readonly time?: unknown };
      const at = Number.isFinite(op.at) ? op.at : legacy.time;
      finite(at, 'split_clip.at');
      if (at < 0) throw new OperationContractError('split_clip.at must be non-negative.');
      return;
    }
    case 'delete_range':
    case 'ripple_delete':
      assertUnlocked(findTrack(timeline, op.trackId), op.type);
      positiveRange(op.start, op.end, op.type);
      return;
    case 'move_clip':
      assertClipUnlocked(timeline, op.clipId, op.type);
      assertUnlocked(findTrack(timeline, op.toTrackId), op.type);
      finite(op.toStart, 'move_clip.toStart');
      if (op.toStart < 0)
        throw new OperationContractError('move_clip.toStart must be non-negative.');
      return;
    case 'add_clip':
      assertUnlocked(findTrack(timeline, op.trackId), op.type);
      positiveRange(op.start, op.end, op.type);
      finite(op.sourceStart, 'add_clip.sourceStart');
      finite(op.sourceEnd, 'add_clip.sourceEnd');
      if (op.sourceStart < 0 || op.sourceEnd <= op.sourceStart) {
        throw new OperationContractError('add_clip source range must be positive and ordered.');
      }
      return;
    case 'add_text_overlay':
    case 'add_caption_layer':
      assertUnlocked(findTrack(timeline, op.trackId), op.type);
      positiveRange(op.start, op.end, op.type);
      return;
    case 'add_keyframes':
      assertClipUnlocked(timeline, op.clipId, op.type);
      assertKeyframes(op);
      return;
    case 'remove_keyframes':
      assertClipUnlocked(timeline, op.clipId, op.type);
      assertKeyframeTargets(op);
      return;
    case 'apply_color_grade': {
      assertClipUnlocked(timeline, op.clipId, op.type);
      const issues = colorGradeContractIssues(op.effect);
      if (issues.length > 0)
        throw new OperationContractError(issues.map((issue) => issue.message).join('; '));
      return;
    }
    case 'set_effect_params':
    case 'add_mask':
    case 'set_caption_style':
    case 'set_caption_cue':
    case 'set_clip_speed':
    case 'set_clip_speed_ramp':
    case 'set_clip_crop':
    case 'set_clip_blend_mode':
      assertClipUnlocked(timeline, op.clipId, op.type);
      return;
    case 'adjust_audio': {
      const found = findClip(timeline, op.clipId);
      assertUnlocked(found?.track, op.type);
      const gainIssue = audioGainContractIssue(op.gainDb);
      if (gainIssue) throw new OperationContractError(gainIssue.message);
      const clipDuration = found ? found.clip.end - found.clip.start : undefined;
      for (const [name, value] of [
        ['fadeInSeconds', op.fadeInSeconds],
        ['fadeOutSeconds', op.fadeOutSeconds],
      ] as const) {
        if (value === undefined) continue;
        finite(value, `adjust_audio.${name}`);
        if (value < 0) throw new OperationContractError(`${name} must be non-negative.`);
        if (clipDuration !== undefined && value > clipDuration) {
          throw new OperationContractError(`${name} cannot exceed the clip duration.`);
        }
      }
      if (op.fadeCurve !== undefined && !audioFadeCurveSupported(op.fadeCurve)) {
        throw new OperationContractError(
          `fadeCurve must be one of ${AUDIO_FADE_CURVES.join(', ')}.`,
        );
      }
      if (op.duckAmountDb !== undefined) {
        const duckIssue = duckAmountContractIssue(op.duckAmountDb);
        if (duckIssue) throw new OperationContractError(duckIssue.message);
        if (op.duckUnderTrackId === undefined) {
          throw new OperationContractError('duckAmountDb requires duckUnderTrackId.');
        }
      }
      if (op.duckUnderTrackId !== undefined) {
        const sidechain = findTrack(timeline, op.duckUnderTrackId);
        if (sidechain === undefined) {
          throw new OperationContractError(
            `duckUnderTrackId references missing track "${op.duckUnderTrackId}".`,
          );
        }
        if (found?.track.id === sidechain.id) {
          throw new OperationContractError('Audio cannot duck under its own track.');
        }
        if (sidechain.type === 'caption' || sidechain.type === 'effect') {
          throw new OperationContractError(
            'duckUnderTrackId must reference an audio-capable track.',
          );
        }
      }
      // An empty band list is the documented "clear the EQ" instruction, so it
      // skips the curve contract (which requires a band) rather than failing it —
      // the same shape as an empty automation lane below.
      if (op.eq !== undefined && op.eq.bands.length > 0) {
        const eqIssue = audioEqContractIssue(op.eq.bands);
        if (eqIssue) throw new OperationContractError(eqIssue.message);
      }
      if (op.dynamics !== undefined) {
        const dynamicsIssue = audioDynamicsContractIssue(op.dynamics);
        if (dynamicsIssue) throw new OperationContractError(dynamicsIssue.message);
      }
      // An empty lane is the documented "clear the automation" instruction, so it
      // skips the lane contract (which requires two points) rather than failing it.
      if (op.automation !== undefined && op.automation.points.length > 0) {
        const automationIssue = audioAutomationContractIssue(
          op.automation.property,
          op.automation.points,
          clipDuration ?? Number.POSITIVE_INFINITY,
        );
        if (automationIssue) throw new OperationContractError(automationIssue.message);
      }
      return;
    }
    case 'add_transition':
      assertUnlocked(findTrack(timeline, op.trackId), op.type);
      finite(op.durationSeconds, 'add_transition.durationSeconds');
      if (op.durationSeconds <= 0) {
        throw new OperationContractError('add_transition.durationSeconds must be positive.');
      }
      return;
    case 'track_object':
      assertClipUnlocked(timeline, op.clipId, op.type);
      if (op.region) assertTrackerRegion(op.region);
      return;
    case 'set_track_flags':
      return; // must remain able to unlock a locked track
    case 'set_track_caption_style':
      assertUnlocked(findTrack(timeline, op.trackId), op.type);
      return;
    case 'add_layer':
      if (!Number.isInteger(op.atIndex) || op.atIndex < 0) {
        throw new OperationContractError('add_layer.atIndex must be a non-negative integer.');
      }
      return;
    case 'remove_layer':
      assertUnlocked(findTrack(timeline, op.layerId), op.type);
      return;
    case 'move_layer':
      assertUnlocked(findTrack(timeline, op.layerId), op.type);
      if (!Number.isInteger(op.toIndex) || op.toIndex < 0) {
        throw new OperationContractError('move_layer.toIndex must be a non-negative integer.');
      }
      return;
    case 'add_effect_layer':
      assertUnlocked(findTrack(timeline, op.trackId), op.type);
      positiveRange(op.layer.start, op.layer.end, op.type);
      assertEffectParams(op.layer, op.layer.params);
      if (op.layer.intensity !== undefined) {
        finite(op.layer.intensity, 'add_effect_layer.intensity');
        if (op.layer.intensity < 0 || op.layer.intensity > 1) {
          throw new OperationContractError('add_effect_layer.intensity must be within 0..1.');
        }
      }
      return;
    case 'remove_effect_layer':
    case 'set_effect_layer_enabled':
      assertUnlocked(effectTrack(timeline, op.layerId), op.type);
      return;
    case 'move_effect_layer':
      assertUnlocked(effectTrack(timeline, op.layerId), op.type);
      if (op.toTrackId !== undefined) assertUnlocked(findTrack(timeline, op.toTrackId), op.type);
      finite(op.toStart, 'move_effect_layer.toStart');
      if (op.toStart < 0)
        throw new OperationContractError('move_effect_layer.toStart must be non-negative.');
      return;
    case 'trim_effect_layer':
      assertUnlocked(effectTrack(timeline, op.layerId), op.type);
      positiveRange(op.start, op.end, op.type);
      return;
    case 'set_effect_layer_params': {
      const found = findEffectLayer(timeline, op.layerId);
      assertUnlocked(found?.track, op.type);
      if (op.intensity !== undefined && op.intensity !== null) {
        finite(op.intensity, 'set_effect_layer_params.intensity');
        if (op.intensity < 0 || op.intensity > 1) {
          throw new OperationContractError(
            'set_effect_layer_params.intensity must be within 0..1.',
          );
        }
      }
      if (op.params !== undefined && found) assertEffectParams(found.layer, op.params);
      return;
    }
    case 'restore_effect_layer':
    case 'restore_clips':
      return; // internal lossless inverse primitives must always be able to restore state
  }
}
