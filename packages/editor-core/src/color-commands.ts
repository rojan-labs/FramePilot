/** Deterministic professional color commands compiled into reversible timeline patches. */
import type { PatchId } from '@framepilot/shared-types';
import type { Asset, Effect, Timeline } from '@framepilot/timeline-schema';
import { colorGradeContractIssues } from './edit-value-contracts.js';
import { applyPatch, invertPatch, type Patch } from './patch.js';
import { validatePatch } from './validator.js';

export const PROFESSIONAL_COLOR_PARAMETERS = [
  'exposure',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'shadows',
  'highlights',
] as const;

export type ProfessionalColorParameter = (typeof PROFESSIONAL_COLOR_PARAMETERS)[number];
export type ProfessionalColorAdjustments = Readonly<
  Partial<Record<ProfessionalColorParameter, number>>
>;

export interface CorrectShotCommand {
  readonly type: 'correct_shot';
  readonly timelineRevision: number;
  readonly clipId: string;
  /** Absolute primary-correction values. Omitted axes retain their current values. */
  readonly adjustments: ProfessionalColorAdjustments;
}

export type ColorCommand = CorrectShotCommand;

export type ColorCommandRejectionCode =
  | 'stale_timeline'
  | 'missing_clip'
  | 'locked_track'
  | 'wrong_track_kind'
  | 'empty_adjustments'
  | 'invalid_grade'
  | 'invalid_patch';

export interface ColorCommandFact {
  readonly name: string;
  readonly value: string | number | boolean;
}

export type ColorCommandCompileResult =
  | {
      readonly status: 'compiled';
      readonly command: ColorCommand;
      readonly patch: Patch;
      readonly inversePatch: Patch;
      readonly facts: readonly ColorCommandFact[];
    }
  | {
      readonly status: 'rejected';
      readonly command: ColorCommand;
      readonly code: ColorCommandRejectionCode;
      readonly detail: string;
      readonly facts: readonly ColorCommandFact[];
    };

export interface CompileColorCommandInput {
  readonly timeline: Timeline;
  readonly assets: readonly Asset[];
  readonly command: ColorCommand;
}

/** Stable identity for the single technical primary-correction layer on a shot. */
export const professionalColorEffectId = (clipId: string): string =>
  `color__${clipId}__primary`;

function rejected(
  command: ColorCommand,
  code: ColorCommandRejectionCode,
  detail: string,
  facts: readonly ColorCommandFact[] = [],
): ColorCommandCompileResult {
  return { status: 'rejected', command, code, detail, facts };
}

function compileCorrectShot(
  input: CompileColorCommandInput,
  command: CorrectShotCommand,
): ColorCommandCompileResult {
  const currentRevision = input.timeline.revision ?? 0;
  if (command.timelineRevision !== currentRevision) {
    return rejected(
      command,
      'stale_timeline',
      `Command targets timeline revision ${command.timelineRevision}, but current revision is ${currentRevision}.`,
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
  if (found.track.type === 'audio' || found.track.type === 'caption') {
    return rejected(
      command,
      'wrong_track_kind',
      `Clip "${command.clipId}" is not on a visual track.`,
    );
  }
  if (Object.keys(command.adjustments).length === 0) {
    return rejected(
      command,
      'empty_adjustments',
      'A shot correction requires at least one adjustment.',
    );
  }

  const effectId = professionalColorEffectId(command.clipId);
  const existing = found.clip.effects.find((effect) => effect.id === effectId);
  const params = {
    ...(existing?.type === 'color_grade' ? existing.params : {}),
    ...command.adjustments,
  };
  const effect: Effect = { id: effectId, type: 'color_grade', params, keyframes: [] };
  const gradeIssues = colorGradeContractIssues(effect);
  if (gradeIssues.length > 0) {
    return rejected(command, 'invalid_grade', gradeIssues.map((issue) => issue.message).join('; '));
  }

  const patch: Patch = {
    patchId: `color__${command.clipId}__${currentRevision}` as PatchId,
    createdBy: 'agent',
    reason: `Correct shot "${command.clipId}"`,
    operations: [{ type: 'apply_color_grade', clipId: command.clipId, effect }],
  };
  const facts: readonly ColorCommandFact[] = [
    { name: 'clipId', value: command.clipId },
    { name: 'adjustmentCount', value: Object.keys(command.adjustments).length },
    { name: 'mergedPrimaryCorrection', value: existing?.type === 'color_grade' },
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

/** Compile one revision-bound color command into a validated reversible patch. */
export function compileColorCommand(input: CompileColorCommandInput): ColorCommandCompileResult {
  switch (input.command.type) {
    case 'correct_shot':
      return compileCorrectShot(input, input.command);
  }
}
