/** Deterministic professional audio commands compiled into reversible timeline patches. */
import type { PatchId } from '@framepilot/shared-types';
import type { Asset, Timeline } from '@framepilot/timeline-schema';
import {
  AUDIO_FADE_CURVES,
  audioAutomationContractIssue,
  audioDynamicsContractIssue,
  audioEqContractIssue,
  audioFadeCurveSupported,
  audioGainContractIssue,
  duckAmountContractIssue,
  type AudioAutomationPoint,
  type AudioAutomationProperty,
  type AudioDynamicsSettings,
  type AudioEqBand,
} from './edit-value-contracts.js';
import { applyPatch, invertPatch, type Patch } from './patch.js';
import { validatePatch } from './validator.js';

export interface AudioFrameRate {
  readonly numerator: number;
  readonly denominator: number;
}

export interface MixClipAudioSettings {
  readonly gainDb?: number;
  readonly fadeInFrames?: number;
  readonly fadeOutFrames?: number;
  readonly fadeCurve?: (typeof AUDIO_FADE_CURVES)[number];
  readonly muted?: boolean;
  readonly normalize?: boolean;
  readonly duckUnderTrackId?: string;
  readonly duckAmountDb?: number;
  /** Replaces the clip's EQ curve outright. See `AdjustAudioOp.eq`. */
  readonly eq?: { readonly bands: readonly AudioEqBand[] };
  /** Replaces the clip's compressor settings outright. */
  readonly dynamics?: AudioDynamicsSettings;
  /** Authors (or, with an empty `points` array, clears) a gain automation lane. */
  readonly automation?: {
    readonly property: AudioAutomationProperty;
    readonly points: readonly AudioAutomationPoint[];
  };
}

export interface MixClipAudioCommand {
  readonly type: 'mix_clip_audio';
  readonly timelineRevision: number;
  readonly clipId: string;
  readonly rate: AudioFrameRate;
  /** Absolute overrides. Omitted settings retain the clip's current audio mix. */
  readonly settings: MixClipAudioSettings;
}

export type AudioCommand = MixClipAudioCommand;

export type AudioCommandRejectionCode =
  | 'stale_timeline'
  | 'invalid_frame_rate'
  | 'missing_clip'
  | 'missing_asset'
  | 'no_audio'
  | 'locked_track'
  | 'empty_settings'
  | 'invalid_gain'
  | 'invalid_fade'
  | 'invalid_duck'
  | 'invalid_eq'
  | 'invalid_dynamics'
  | 'invalid_automation'
  | 'conflicting_gain'
  | 'invalid_patch';

export interface AudioCommandFact {
  readonly name: string;
  readonly value: string | number | boolean;
}

export type AudioCommandCompileResult =
  | {
      readonly status: 'compiled';
      readonly command: AudioCommand;
      readonly patch: Patch;
      readonly inversePatch: Patch;
      readonly facts: readonly AudioCommandFact[];
    }
  | {
      readonly status: 'rejected';
      readonly command: AudioCommand;
      readonly code: AudioCommandRejectionCode;
      readonly detail: string;
      readonly facts: readonly AudioCommandFact[];
    };

export interface CompileAudioCommandInput {
  readonly timeline: Timeline;
  readonly assets: readonly Asset[];
  readonly command: AudioCommand;
}

function rejected(
  command: AudioCommand,
  code: AudioCommandRejectionCode,
  detail: string,
  facts: readonly AudioCommandFact[] = [],
): AudioCommandCompileResult {
  return { status: 'rejected', command, code, detail, facts };
}

function validRate(rate: AudioFrameRate): boolean {
  return (
    Number.isSafeInteger(rate.numerator) &&
    rate.numerator > 0 &&
    Number.isSafeInteger(rate.denominator) &&
    rate.denominator > 0
  );
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function optionalNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Read a persisted EQ curve back out of the canonical effect's open params bag.
 *
 * Anything that is not the shape this compiler writes is treated as absent
 * rather than repaired: a half-understood curve carried forward would be an EQ
 * the editor never authored, and the next command would persist it as if it had.
 */
function priorEq(value: unknown): { readonly bands: readonly AudioEqBand[] } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const bands = (value as { bands?: unknown }).bands;
  if (!Array.isArray(bands) || bands.length === 0) return undefined;
  return { bands: bands as readonly AudioEqBand[] };
}

function priorDynamics(value: unknown): AudioDynamicsSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<AudioDynamicsSettings>;
  return typeof candidate.thresholdDb === 'number' &&
    typeof candidate.ratio === 'number' &&
    typeof candidate.attackMs === 'number' &&
    typeof candidate.releaseMs === 'number'
    ? (candidate as AudioDynamicsSettings)
    : undefined;
}

/** Recover the automation lane already on the clip so an unrelated mix edit cannot erase it. */
function priorAutomation(
  effect:
    | {
        readonly keyframes: readonly {
          property: string;
          time: number;
          value: number;
          easing?: string;
        }[];
      }
    | undefined,
  property: AudioAutomationProperty,
): readonly AudioAutomationPoint[] {
  if (!effect) return [];
  return effect.keyframes
    .filter((keyframe) => keyframe.property === property)
    .map((keyframe) => ({
      timeSeconds: keyframe.time,
      value: keyframe.value,
      ...(keyframe.easing === undefined ? {} : { easing: keyframe.easing }),
    }))
    .sort((left, right) => left.timeSeconds - right.timeSeconds);
}

function compileMixClipAudio(
  input: CompileAudioCommandInput,
  command: MixClipAudioCommand,
): AudioCommandCompileResult {
  const currentRevision = input.timeline.revision ?? 0;
  if (command.timelineRevision !== currentRevision) {
    return rejected(
      command,
      'stale_timeline',
      `Command targets timeline revision ${command.timelineRevision}, but current revision is ${currentRevision}.`,
    );
  }
  if (!validRate(command.rate)) {
    return rejected(command, 'invalid_frame_rate', 'Audio rate must be a positive rational rate.');
  }
  if (Object.keys(command.settings).length === 0) {
    return rejected(
      command,
      'empty_settings',
      'An audio mix command requires at least one setting.',
    );
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
  const asset = input.assets.find((candidate) => candidate.id === found.clip.assetId);
  if (!asset)
    return rejected(command, 'missing_asset', `Asset "${found.clip.assetId}" is missing.`);
  if (asset.kind === 'image' || found.track.type === 'caption' || found.track.type === 'effect') {
    return rejected(command, 'no_audio', `Clip "${command.clipId}" has no audio stream.`);
  }

  // `adjust_audio` canonicalizes every legacy gain layer to `<clipId>__gain`; read the
  // effective layer by type first so that canonicalization does not silently discard its mix.
  const existing = found.clip.effects.find((effect) => effect.type === 'audio_gain');
  const prior = existing?.params ?? {};
  const frameSeconds = command.rate.denominator / command.rate.numerator;
  const fadeInSeconds =
    command.settings.fadeInFrames === undefined
      ? optionalNumber(prior.fadeInSeconds, 0)
      : command.settings.fadeInFrames * frameSeconds;
  const fadeOutSeconds =
    command.settings.fadeOutFrames === undefined
      ? optionalNumber(prior.fadeOutSeconds, 0)
      : command.settings.fadeOutFrames * frameSeconds;
  const gainDb = command.settings.gainDb ?? optionalNumber(prior.gainDb, 0);
  const fadeCurve =
    command.settings.fadeCurve ??
    (typeof prior.fadeCurve === 'string' && audioFadeCurveSupported(prior.fadeCurve)
      ? prior.fadeCurve
      : 'linear');
  const duckUnderTrackId =
    command.settings.duckUnderTrackId ??
    (typeof prior.duckUnderTrackId === 'string' ? prior.duckUnderTrackId : undefined);
  const duckAmountDb =
    command.settings.duckAmountDb ??
    (duckUnderTrackId ? optionalNumber(prior.duckAmountDb, -12) : undefined);

  const gainIssue = audioGainContractIssue(gainDb);
  if (gainIssue) return rejected(command, 'invalid_gain', gainIssue.message);
  for (const [name, frames, seconds] of [
    ['fadeInFrames', command.settings.fadeInFrames, fadeInSeconds],
    ['fadeOutFrames', command.settings.fadeOutFrames, fadeOutSeconds],
  ] as const) {
    if (frames !== undefined && (!Number.isSafeInteger(frames) || frames < 0)) {
      return rejected(command, 'invalid_fade', `${name} must be a non-negative integer.`);
    }
    if (seconds > found.clip.end - found.clip.start) {
      return rejected(command, 'invalid_fade', `${name} cannot exceed the clip duration.`);
    }
  }
  if (!audioFadeCurveSupported(fadeCurve)) {
    return rejected(
      command,
      'invalid_fade',
      `fadeCurve must be one of ${AUDIO_FADE_CURVES.join(', ')}.`,
    );
  }
  if (duckUnderTrackId !== undefined) {
    const sidechain = input.timeline.tracks.find((track) => track.id === duckUnderTrackId);
    if (
      !sidechain ||
      sidechain.id === found.track.id ||
      sidechain.type === 'caption' ||
      sidechain.type === 'effect'
    ) {
      return rejected(
        command,
        'invalid_duck',
        'Ducking requires a different existing audio-capable sidechain track.',
      );
    }
    const duckIssue = duckAmountContractIssue(duckAmountDb ?? -12);
    if (duckIssue) return rejected(command, 'invalid_duck', duckIssue.message);
  } else if (duckAmountDb !== undefined) {
    return rejected(command, 'invalid_duck', 'duckAmountDb requires duckUnderTrackId.');
  }

  // A command that authored an empty curve is clearing the EQ; anything else
  // inherits whatever the clip already carries.
  const clearingEq = command.settings.eq !== undefined && command.settings.eq.bands.length === 0;
  const eq = clearingEq ? undefined : (command.settings.eq ?? priorEq(prior.eq));
  if (eq) {
    const eqIssue = audioEqContractIssue(eq.bands);
    if (eqIssue) return rejected(command, 'invalid_eq', eqIssue.message);
  }
  const dynamics = command.settings.dynamics ?? priorDynamics(prior.dynamics);
  if (dynamics) {
    const dynamicsIssue = audioDynamicsContractIssue(dynamics);
    if (dynamicsIssue) return rejected(command, 'invalid_dynamics', dynamicsIssue.message);
  }

  const automationProperty = command.settings.automation?.property ?? 'gainDb';
  const carriedLane = priorAutomation(existing, automationProperty);
  const automationPoints = command.settings.automation?.points ?? carriedLane;
  const clipDuration = found.clip.end - found.clip.start;
  if (automationPoints.length > 0) {
    const automationIssue = audioAutomationContractIssue(
      automationProperty,
      automationPoints,
      clipDuration,
    );
    if (automationIssue) return rejected(command, 'invalid_automation', automationIssue.message);
    // A lane and a static level are two authored answers for one parameter at one
    // instant. Rather than pick silently — and have a level change do nothing
    // audible because the lane outranks it — say which one has to go.
    if (command.settings.gainDb !== undefined) {
      return rejected(
        command,
        'conflicting_gain',
        command.settings.automation === undefined
          ? `Clip "${command.clipId}" already has a ${automationProperty} automation lane, which ` +
              'supersedes a static level. Clear the lane, or re-author it, instead of setting gainDb.'
          : 'A command may author a gain automation lane or a static gainDb, not both.',
      );
    }
  }

  const operation = {
    type: 'adjust_audio' as const,
    clipId: command.clipId,
    gainDb,
    fadeInSeconds,
    fadeOutSeconds,
    fadeCurve,
    muted: command.settings.muted ?? optionalBoolean(prior.muted, false),
    normalize: command.settings.normalize ?? optionalBoolean(prior.normalize, false),
    ...(duckUnderTrackId !== undefined
      ? { duckUnderTrackId, duckAmountDb: duckAmountDb ?? -12 }
      : {}),
    ...(eq ? { eq } : clearingEq ? { eq: { bands: [] } } : {}),
    ...(dynamics ? { dynamics } : {}),
    // An explicit empty lane must reach the operation: absent now means "leave the
    // clip's lane alone", so omitting it here would make clearing impossible.
    ...(automationPoints.length > 0
      ? { automation: { property: automationProperty, points: automationPoints } }
      : command.settings.automation !== undefined
        ? { automation: { property: automationProperty, points: [] } }
        : {}),
  };
  const patch: Patch = {
    patchId: `audio__${command.clipId}__${currentRevision}` as PatchId,
    createdBy: 'agent',
    reason: `Mix audio on "${command.clipId}"`,
    operations: [operation],
  };
  const facts: readonly AudioCommandFact[] = [
    { name: 'clipId', value: command.clipId },
    { name: 'gainDb', value: gainDb },
    { name: 'fadeInFrames', value: Math.round(fadeInSeconds / frameSeconds) },
    { name: 'fadeOutFrames', value: Math.round(fadeOutSeconds / frameSeconds) },
    { name: 'mergedExistingMix', value: existing !== undefined },
    ...(duckUnderTrackId ? [{ name: 'sidechainTrackId', value: duckUnderTrackId }] : []),
    ...(eq ? [{ name: 'eqBands', value: eq.bands.length }] : []),
    ...(dynamics
      ? [
          { name: 'compressorThresholdDb', value: dynamics.thresholdDb },
          { name: 'compressorRatio', value: dynamics.ratio },
        ]
      : []),
    ...(automationPoints.length > 0
      ? [
          { name: 'automationProperty', value: automationProperty },
          { name: 'automationPoints', value: automationPoints.length },
          // The reviewer needs the span to know which windows to measure: a lane
          // that only moves in the last second is not evidenced by a mid-clip sample.
          { name: 'automationStartSeconds', value: automationPoints[0]?.timeSeconds ?? 0 },
          {
            name: 'automationEndSeconds',
            value: automationPoints[automationPoints.length - 1]?.timeSeconds ?? 0,
          },
        ]
      : []),
  ];
  const validation = validatePatch(input.timeline, patch, {
    assetIds: input.assets.map((candidate) => candidate.id),
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

/** Compile one revision-bound audio command into a validated reversible patch. */
export function compileAudioCommand(input: CompileAudioCommandInput): AudioCommandCompileResult {
  switch (input.command.type) {
    case 'mix_clip_audio':
      return compileMixClipAudio(input, input.command);
  }
}
