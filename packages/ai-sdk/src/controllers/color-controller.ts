/** Professional color objectives resolved against authoritative editor selection state. */
import { z } from 'zod/v4';
import {
  COLOR_GRADE_PARAMETER_CONTRACTS,
  professionalColorEffectId,
  type ColorCommand,
  type ProfessionalColorAdjustments,
} from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { EditorInteractionContext } from '../editor-context/interaction-context.js';
import { resolveEditorTarget, type TargetEvidence } from '../editor-context/target-resolver.js';
import {
  ColorMeasurementSchema,
  type ColorEvidenceReader,
  type ColorMeasurement,
} from '../color-evidence.js';

const log = createLogger('ai-sdk:controllers:color');

const adjustmentFields = Object.fromEntries(
  Object.entries(COLOR_GRADE_PARAMETER_CONTRACTS).map(([name, bounds]) => [
    name,
    z.number().finite().min(bounds.min).max(bounds.max).optional(),
  ]),
) as Record<keyof ProfessionalColorAdjustments, z.ZodOptional<z.ZodNumber>>;

const ColorAdjustmentsSchema = z
  .object(adjustmentFields)
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one color adjustment is required.',
  });

export const ColorObjectiveSchema = z
  .object({
    intent: z.enum(['correct', 'match_reference']),
    target: z.enum(['this', 'these', 'playhead']).default('this'),
    adjustments: ColorAdjustmentsSchema.optional(),
    targetEvidenceId: z.string().trim().min(1).optional(),
    referenceEvidenceId: z.string().trim().min(1).optional(),
    /**
     * Apply the same grade to every shot from the same setup, not just the one
     * in hand. The group is derived from the footage — see `shotGroupFor`.
     */
    groupShots: z.boolean().optional(),
    /** Hold skin tones where they are while the rest of the frame moves. */
    preserveSkin: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.intent === 'correct') {
      if (!value.adjustments) {
        context.addIssue({
          code: 'custom',
          path: ['adjustments'],
          message: 'Explicit correction requires at least one bounded adjustment.',
        });
      }
      if (value.targetEvidenceId || value.referenceEvidenceId) {
        context.addIssue({
          code: 'custom',
          message: 'Explicit correction does not accept measurement evidence.',
        });
      }
      if (value.preserveSkin !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['preserveSkin'],
          // Nothing to hold skin against: an explicit correction is the number the
          // editor asked for, and quietly scaling it back would be a lie about what ran.
          message: 'Skin preservation applies to a measured match, not to an explicit correction.',
        });
      }
      if (value.groupShots === true && value.target === 'these') {
        context.addIssue({
          code: 'custom',
          path: ['groupShots'],
          message: 'Grouping expands from one shot; use target "this" or "playhead".',
        });
      }
      return;
    }
    if (value.target === 'these') {
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'Reference matching accepts exactly one target shot.',
      });
    }
    if (!value.targetEvidenceId) {
      context.addIssue({
        code: 'custom',
        path: ['targetEvidenceId'],
        message: 'Reference matching requires target measurement evidence.',
      });
    }
    if (!value.referenceEvidenceId) {
      context.addIssue({
        code: 'custom',
        path: ['referenceEvidenceId'],
        message: 'Reference matching requires reference measurement evidence.',
      });
    }
    if (value.adjustments) {
      context.addIssue({
        code: 'custom',
        path: ['adjustments'],
        message: 'Reference matching derives adjustments from evidence.',
      });
    }
  });

export type ColorObjective =
  | {
      readonly intent: 'correct';
      readonly target: 'this' | 'these' | 'playhead';
      readonly adjustments: ProfessionalColorAdjustments;
      readonly groupShots?: boolean;
    }
  | {
      readonly intent: 'match_reference';
      readonly target: 'this' | 'playhead';
      readonly targetEvidenceId: string;
      readonly referenceEvidenceId: string;
      readonly groupShots?: boolean;
      readonly preserveSkin?: boolean;
    };

/** Parse the provider-compatible flat schema into a discriminated controller objective. */
export function parseColorObjective(raw: unknown): ColorObjective {
  const value = ColorObjectiveSchema.parse(raw);
  if (value.intent === 'correct') {
    const adjustments = Object.fromEntries(
      Object.entries(value.adjustments!).filter((entry): entry is [string, number] =>
        Number.isFinite(entry[1]),
      ),
    ) as ProfessionalColorAdjustments;
    return {
      intent: value.intent,
      target: value.target,
      adjustments,
      ...(value.groupShots === undefined ? {} : { groupShots: value.groupShots }),
    };
  }
  return {
    intent: value.intent,
    target: value.target as 'this' | 'playhead',
    targetEvidenceId: value.targetEvidenceId!,
    referenceEvidenceId: value.referenceEvidenceId!,
    ...(value.groupShots === undefined ? {} : { groupShots: value.groupShots }),
    ...(value.preserveSkin === undefined ? {} : { preserveSkin: value.preserveSkin }),
  };
}

/**
 * Every shot that came from the same setup as `clipId`.
 *
 * "The same setup" means **the same source recording**, which is a fact about
 * where the pixels came from rather than a judgement about how they look. So a
 * group is reproducible and explainable — "these nine clips are all camera B" —
 * where a similarity threshold would silently regroup the moment a grade lands.
 *
 * That also covers multicam: an angle (schema v18) *is* one recording, so "every
 * shot from camera B" and "every clip of B's asset" are the same set. No angle
 * lookup is needed, and an ungrouped project groups just as well as a grouped one.
 *
 * Returns the clip alone when nothing else shares its origin — the honest answer
 * for a one-off shot, not a reason to refuse.
 */
export function shotGroupFor(project: Project, clipId: string): readonly string[] {
  const visualClips = project.timeline.tracks
    .filter((track) => track.type !== 'audio' && track.type !== 'caption')
    .flatMap((track) => track.clips);
  const subject = visualClips.find((clip) => clip.id === clipId);
  if (!subject) return [clipId];
  return visualClips.filter((clip) => clip.assetId === subject.assetId).map((clip) => clip.id);
}

export type ColorControllerRejectionCode =
  | 'target_unresolved'
  | 'target_ambiguous'
  | 'wrong_track_kind'
  | 'evidence_missing'
  | 'evidence_invalid'
  | 'evidence_stale'
  | 'evidence_target_mismatch'
  | 'measurement_occluded'
  /** The measurement predates the skin channels, so there is nothing to hold. */
  | 'skin_unmeasured'
  /** The qualifier found too little skin for a reading — not the same as no drift. */
  | 'skin_absent';

export interface ColorControllerFact {
  readonly name: string;
  readonly value: string | number | boolean;
}

export type ColorControllerResult =
  | {
      readonly status: 'resolved';
      readonly objective: ColorObjective;
      readonly commands: readonly ColorCommand[];
      readonly evidence: readonly TargetEvidence[];
      readonly facts: readonly ColorControllerFact[];
    }
  | {
      readonly status: 'rejected';
      readonly objective: ColorObjective;
      readonly code: ColorControllerRejectionCode;
      readonly detail: string;
      readonly facts: readonly ColorControllerFact[];
    };

export interface ResolveColorObjectiveInput {
  readonly project: Project;
  readonly projectRevision?: number;
  readonly interaction: EditorInteractionContext;
  readonly objective: ColorObjective;
  readonly evidence?: ColorEvidenceReader;
}

type Rejection = Extract<ColorControllerResult, { status: 'rejected' }>;

function rejected(
  objective: ColorObjective,
  code: ColorControllerRejectionCode,
  detail: string,
): Rejection {
  log.warn('Color objective rejected', { intent: objective.intent, code });
  return { status: 'rejected', objective, code, detail, facts: [] };
}

function stable(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function channelMedian(
  measurement: ColorMeasurement,
  channel: ColorMeasurement['samples'][number]['channel'],
): number {
  const values = measurement.samples
    .filter((sample) => sample.channel === channel)
    .map((sample) => sample.p50)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  if (values.length === 0) return 0;
  return values[Math.floor(values.length / 2)]!;
}

function tonalSpread(measurement: ColorMeasurement): number {
  const luma = measurement.samples.filter(
    (sample) => sample.channel === 'luma' && sample.p90 !== undefined && sample.p10 !== undefined,
  );
  if (luma.length === 0) return 0;
  return luma.reduce((sum, sample) => sum + (sample.p90 ?? 0) - (sample.p10 ?? 0), 0) / luma.length;
}

/** Conservative first-order match derived from the renderer's documented color math. */
export function matchColorMeasurements(
  target: ColorMeasurement,
  reference: ColorMeasurement,
): ProfessionalColorAdjustments {
  const epsilon = 1 / 255;
  const targetLuma = Math.max(epsilon, channelMedian(target, 'luma'));
  const referenceLuma = Math.max(epsilon, channelMedian(reference, 'luma'));
  const targetRed = Math.max(epsilon, channelMedian(target, 'red'));
  const targetGreen = Math.max(epsilon, channelMedian(target, 'green'));
  const targetBlue = Math.max(epsilon, channelMedian(target, 'blue'));
  const referenceRed = Math.max(epsilon, channelMedian(reference, 'red'));
  const referenceGreen = Math.max(epsilon, channelMedian(reference, 'green'));
  const referenceBlue = Math.max(epsilon, channelMedian(reference, 'blue'));
  const temperatureRatio = referenceRed / referenceBlue / (targetRed / targetBlue);
  const temperature = (temperatureRatio - 1) / (0.3 * (temperatureRatio + 1));
  const targetGreenRatio = targetGreen / ((targetRed + targetBlue) / 2);
  const referenceGreenRatio = referenceGreen / ((referenceRed + referenceBlue) / 2);
  const saturationTarget = Math.max(epsilon, channelMedian(target, 'saturation'));
  const saturationReference = channelMedian(reference, 'saturation');
  const spreadTarget = Math.max(epsilon, tonalSpread(target));
  const spreadReference = tonalSpread(reference);
  return {
    exposure: stable(clamp(Math.log2(referenceLuma / targetLuma), -1, 1)),
    contrast: stable(clamp(spreadReference / spreadTarget - 1, -0.3, 0.3)),
    saturation: stable(clamp(saturationReference / saturationTarget - 1, -0.5, 0.5)),
    temperature: stable(clamp(temperature, -0.5, 0.5)),
    tint: stable(clamp((referenceGreenRatio / targetGreenRatio - 1) / 0.3, -0.5, 0.5)),
  };
}

/**
 * The share of a frame the skin qualifier must select before its reading counts.
 *
 * Below this, the "skin" is a few stray pixels of a wooden table, and a hue
 * constraint derived from them would clamp a correct grade for no reason. Low
 * coverage means *no reading*, not "no drift".
 */
export const SKIN_COVERAGE_FLOOR = 0.02;

/**
 * How far a protected skin tone may change in **warmth** — its red-to-blue ratio —
 * as a fraction of where it started.
 *
 * Warmth, not hue: the render-backed fixture in
 * `test_professional_objective_fixtures.py` measures a large temperature push
 * rotating this renderer's skin hue by barely a degree while its red:blue ratio
 * moves by more than half. That is what a multiplicative white balance does to a
 * red-dominant tone, so a hue tolerance would have been a guard against nothing.
 *
 * Faces are the one thing an audience judges absolutely rather than relatively: a
 * whole frame can go warm and read as evening light, while the same push on a
 * face reads as sunburn. 8% is about where that becomes visible side by side.
 */
export const SKIN_WARMTH_TOLERANCE = 0.08;

/** White-balance push per unit, mirroring `render/color.py`'s `_TEMP_GAIN`/`_TINT_GAIN`. */
const WHITE_BALANCE_GAIN = 0.3;

interface SkinReading {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly coverage: number;
}

/** Read the qualified skin statistics out of a measurement, if it carries a usable one. */
export function skinReading(measurement: ColorMeasurement): SkinReading | undefined {
  const coverages = measurement.samples
    .filter((sample) => sample.channel === 'skin_red')
    .map((sample) => sample.coverageRatio)
    .filter((value): value is number => value !== undefined);
  if (coverages.length === 0) return undefined;
  const coverage = coverages.reduce((sum, value) => sum + value, 0) / coverages.length;
  const red = channelMedian(measurement, 'skin_red');
  const green = channelMedian(measurement, 'skin_green');
  const blue = channelMedian(measurement, 'skin_blue');
  if (red <= 0 && green <= 0 && blue <= 0) return undefined;
  return { red, green, blue, coverage };
}

/**
 * Relative drift a white-balance move puts on skin, at `scale` of its full push.
 *
 * Two readings, because white balance can push a face two ways: `warmth` is the
 * red:blue ratio (temperature), `greenness` is green against the red/blue average
 * (tint). Both are ratios of the *same* tone before and after, so the measured
 * medians cancel out — which is a property of a multiplicative white balance, and
 * the reason the measurement's job here is to establish that skin is *present*
 * and how much of the frame it occupies, not to scale the arithmetic. Stating that
 * plainly is better than passing medians through a formula that ignores them.
 */
function whiteBalanceSkinDrift(delta: ProfessionalColorAdjustments, scale: number): number {
  const temperature = (delta.temperature ?? 0) * scale;
  const tint = (delta.tint ?? 0) * scale;
  const warmth =
    (1 + WHITE_BALANCE_GAIN * temperature) / (1 - WHITE_BALANCE_GAIN * temperature) - 1;
  const greenness = WHITE_BALANCE_GAIN * tint;
  return Math.max(Math.abs(warmth), Math.abs(greenness));
}

/**
 * Scale a white-balance move back until it stops taking skin out of tolerance.
 *
 * Only temperature and tint are touched. Exposure and contrast move a face along
 * the same axis as everything else in the frame, which is what matching a shot
 * means; restraining those would not protect skin, it would just fail the match.
 */
export function clampWhiteBalanceForSkin(
  delta: ProfessionalColorAdjustments,
  tolerance = SKIN_WARMTH_TOLERANCE,
): { readonly adjustments: ProfessionalColorAdjustments; readonly scale: number } {
  if (whiteBalanceSkinDrift(delta, 1) <= tolerance) return { adjustments: delta, scale: 1 };
  // Drift is monotonic in the scale, so a fixed bisection finds the largest
  // admissible push without an iteration count that depends on rounding.
  let low = 0;
  let high = 1;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    if (whiteBalanceSkinDrift(delta, middle) <= tolerance) low = middle;
    else high = middle;
  }
  return {
    adjustments: {
      ...delta,
      ...(delta.temperature === undefined ? {} : { temperature: stable(delta.temperature * low) }),
      ...(delta.tint === undefined ? {} : { tint: stable(delta.tint * low) }),
    },
    scale: stable(low),
  };
}

function addMatchDeltaToPrimaryGrade(
  project: Project,
  clipId: string,
  delta: ProfessionalColorAdjustments,
): ProfessionalColorAdjustments {
  const clip = project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);
  const primary = clip?.effects.find(
    (effect) => effect.id === professionalColorEffectId(clipId) && effect.type === 'color_grade',
  );
  return Object.fromEntries(
    Object.entries(delta).map(([name, value]) => {
      const parameter = name as keyof ProfessionalColorAdjustments;
      const previous = primary?.params[name];
      const current = typeof previous === 'number' && Number.isFinite(previous) ? previous : 0;
      const bounds = COLOR_GRADE_PARAMETER_CONTRACTS[parameter]!;
      return [name, stable(clamp(current + value, bounds.min, bounds.max))];
    }),
  ) as ProfessionalColorAdjustments;
}

function readMeasurement(
  input: ResolveColorObjectiveInput,
  evidenceId: string,
  expectedClipId: string | undefined,
): ColorMeasurement | Rejection {
  const entry = input.evidence?.byHandle(evidenceId);
  if (!entry)
    return rejected(
      input.objective,
      'evidence_missing',
      `No color evidence exists for handle "${evidenceId}".`,
    );
  if (entry.source !== 'measure_color') {
    return rejected(
      input.objective,
      'evidence_invalid',
      `Evidence "${evidenceId}" came from ${entry.source}, not measure_color.`,
    );
  }
  const parsed = ColorMeasurementSchema.safeParse(entry.data);
  if (!parsed.success)
    return rejected(
      input.objective,
      'evidence_invalid',
      `Evidence "${evidenceId}" lacks complete color statistics.`,
    );
  if (parsed.data.projectRevision !== (input.project.timeline.revision ?? 0)) {
    return rejected(
      input.objective,
      'evidence_stale',
      `Evidence "${evidenceId}" targets timeline revision ${parsed.data.projectRevision}.`,
    );
  }
  if (expectedClipId !== undefined && parsed.data.clipId !== expectedClipId) {
    return rejected(
      input.objective,
      'evidence_target_mismatch',
      `Evidence "${evidenceId}" measures clip "${parsed.data.clipId}", not "${expectedClipId}".`,
    );
  }
  if (!parsed.data.occlusionFree) {
    return rejected(
      input.objective,
      'measurement_occluded',
      `Evidence "${evidenceId}" includes another visible layer or caption.`,
    );
  }
  return parsed.data;
}

/** Resolve a single- or multi-shot correction without guessing clip referents. */
export function resolveColorObjective(input: ResolveColorObjectiveInput): ColorControllerResult {
  const resolution = resolveEditorTarget(
    input.project,
    input.interaction,
    { kind: 'clips', referent: input.objective.target },
    { projectRevision: input.projectRevision ?? input.interaction.projectRevision },
  );
  if (resolution.status !== 'resolved') {
    const detail =
      resolution.status === 'ambiguous'
        ? `${resolution.reason}: ${resolution.candidateIds.join(', ')}`
        : `${resolution.reason}: ${resolution.detail}`;
    return rejected(
      input.objective,
      resolution.status === 'ambiguous' ? 'target_ambiguous' : 'target_unresolved',
      detail,
    );
  }
  if (resolution.target.kind !== 'clips') {
    return rejected(
      input.objective,
      'target_unresolved',
      'Color correction requires clip targets.',
    );
  }
  const trackById = new Map(
    input.project.timeline.tracks.map((track) => [track.id, track] as const),
  );
  const nonVisualTrack = resolution.target.trackIds.find((trackId) => {
    const kind = trackById.get(trackId)?.type;
    return kind === 'audio' || kind === 'caption';
  });
  if (nonVisualTrack) {
    return rejected(
      input.objective,
      'wrong_track_kind',
      `Track "${nonVisualTrack}" is not a visual track.`,
    );
  }

  // Zod's optional object keys may be present with `undefined`; the command contract uses
  // exact optional properties, so normalize to only the axes the editor actually requested.
  let adjustments: ProfessionalColorAdjustments;
  let skinClampScale: number | undefined;
  if (input.objective.intent === 'match_reference') {
    if (resolution.target.clipIds.length !== 1) {
      return rejected(
        input.objective,
        'target_ambiguous',
        'Reference matching requires exactly one target shot.',
      );
    }
    const target = readMeasurement(
      input,
      input.objective.targetEvidenceId,
      resolution.target.clipIds[0],
    );
    if ('status' in target) return target;
    const reference = readMeasurement(input, input.objective.referenceEvidenceId, undefined);
    if ('status' in reference) return reference;
    if (reference.clipId === target.clipId) {
      return rejected(
        input.objective,
        'evidence_target_mismatch',
        'Reference and target evidence measure the same clip.',
      );
    }
    let delta = matchColorMeasurements(target, reference);
    if (input.objective.preserveSkin === true) {
      const skin = skinReading(target);
      if (!skin) {
        return rejected(
          input.objective,
          'skin_unmeasured',
          `Evidence "${input.objective.targetEvidenceId}" carries no skin-tone statistics. ` +
            'Re-measure the shot with the skin channels before asking to protect skin.',
        );
      }
      if (skin.coverage < SKIN_COVERAGE_FLOOR) {
        return rejected(
          input.objective,
          'skin_absent',
          `Skin-coloured pixels cover ${(skin.coverage * 100).toFixed(1)}% of this shot, below the ` +
            `${(SKIN_COVERAGE_FLOOR * 100).toFixed(0)}% needed for a reading. There is no skin here to protect.`,
        );
      }
      const clamped = clampWhiteBalanceForSkin(delta);
      delta = clamped.adjustments;
      skinClampScale = clamped.scale;
    }
    adjustments = addMatchDeltaToPrimaryGrade(input.project, resolution.target.clipIds[0]!, delta);
  } else {
    adjustments = Object.fromEntries(
      Object.entries(input.objective.adjustments).filter((entry): entry is [string, number] =>
        Number.isFinite(entry[1]),
      ),
    ) as ProfessionalColorAdjustments;
  }
  // Grouping expands the resolved shot into every shot from the same recording, so
  // "match camera B to this" is one instruction rather than forty selections. The
  // grade is identical across the group by construction: they are the same setup.
  const targetClipIds =
    input.objective.groupShots === true && resolution.target.clipIds.length === 1
      ? shotGroupFor(input.project, resolution.target.clipIds[0]!)
      : resolution.target.clipIds;
  const commands: ColorCommand[] = targetClipIds.map((clipId) => ({
    type: 'correct_shot',
    timelineRevision: input.project.timeline.revision ?? 0,
    clipId,
    adjustments,
  }));
  log.action('Color objective resolved', {
    intent: input.objective.intent,
    clipCount: commands.length,
    evidence: resolution.evidence,
  });
  return {
    status: 'resolved',
    objective: input.objective,
    commands,
    evidence: [resolution.evidence],
    facts: [
      { name: 'clipCount', value: commands.length },
      { name: 'adjustmentCount', value: Object.keys(adjustments).length },
      ...(targetClipIds.length !== resolution.target.clipIds.length
        ? [{ name: 'shotGroupExpandedTo', value: targetClipIds.length }]
        : []),
      // Reported even at 1: "the match was not held back" is as much a fact about
      // what ran as "it was scaled to 40%", and the reviewer states both.
      ...(skinClampScale === undefined
        ? []
        : [{ name: 'skinWhiteBalanceScale', value: skinClampScale }]),
    ],
  };
}
