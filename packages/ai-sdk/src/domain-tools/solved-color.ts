/**
 * Colour tools whose numbers come from measurements (VU3.2).
 *
 * ## The gap these close
 *
 * `apply_color_grade` takes seven signed offsets and has no idea what the shot looks like.
 * Across ten recorded golden runs every grade the agent applied carried numbers the model
 * invented — guess rate 1.00 (ADR 0175) — because there was no other way to call it.
 * `solveColorMatch` / `solveExposureNormalize` / `solveLook` in
 * `@framepilot/editor-core` are the arithmetic that turns two measurements into a grade;
 * this module is their caller.
 *
 * The division of labour is the rule the whole phase rests on: **the model states the
 * intent, the solver produces every number.** `match_color` takes clip ids and nothing
 * else. `apply_look` takes an intent word and a strength word. Neither accepts a parameter
 * value, so neither can be handed a guess. `apply_color_grade` still takes raw numbers,
 * for the UI and for an editor who asks for exactly +0.2 exposure.
 *
 * ## Honest partials
 *
 * Every grade here can be partial, in three separate ways, and each one is said in words:
 *
 * - a parameter hit its contract bound, so the match got as close as the renderer's range
 *   allows and no closer (`ColorSolution.clamped`);
 * - the white-balance move was scaled back to hold skin where it is (`skinCapped`);
 * - the measurement came from the ledger's tier-0 pass, which reads the **ungraded
 *   source** — so a clip that already carries a grade measures as if it did not.
 *
 * A tool that reported "matched" for any of those would be lying in the one direction that
 * costs the editor a re-do. See {@link colorSolveNote}, which is what the model reads.
 */
import { z } from 'zod/v4';
import type { Effect, Track } from '@framepilot/timeline-schema';
import {
  type ColorMeasurement as SolverMeasurement,
  type ColorSolution,
  type ExposureAnchor,
  LOOK_AMOUNTS,
  LOOK_INTENTS,
  type LookAmount,
  type LookIntent,
  type ProfessionalColorAdjustments,
  professionalColorEffectId,
  solveColorMatch,
  solveExposureNormalize,
  solveLook,
} from '@framepilot/editor-core';
import type { Operation } from '@framepilot/editor-core';
import type { ToolContext } from '../tool-context.js';
import type { ToolSpec } from '../tool-registry.js';
import { ToolRefusalError } from '../tool-refusal.js';
import { mutateTool } from './tool-factories.js';
import {
  type MeasurementProvenance,
  type ResolvedMeasurement,
  measurementFor,
  pictureOf,
  skinFor,
} from './picture-facts.js';

// ---------------------------------------------------------------------------
// The plan a solved colour call produces
// ---------------------------------------------------------------------------

/** One clip that will be graded, and everything that qualifies the grade. */
interface SolvedGrade {
  readonly clipId: string;
  readonly params: ProfessionalColorAdjustments;
  readonly clampedParameters: readonly string[];
  readonly skinCapped: boolean;
  readonly provenance: MeasurementProvenance;
  /** Signed gap this grade is closing, in stops of exposure. Absent where meaningless. */
  readonly gapStops?: number;
  /** Signed gap in measured warmth, −1..1. */
  readonly gapWarmth?: number;
}

/** One clip that will NOT be graded, and the sentence that says why. */
interface SkippedClip {
  readonly clipId: string;
  readonly why: string;
}

/** What a solved colour call decided, before any operation exists. */
interface ColorPlan {
  readonly grades: readonly SolvedGrade[];
  readonly skipped: readonly SkippedClip[];
  /** Free-standing qualifications — the reference's own provenance, an anchor choice. */
  readonly notes: readonly string[];
}

const EMPTY_PLAN: ColorPlan = { grades: [], skipped: [], notes: [] };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Round a reported figure to two decimals — a report, not a parameter. */
function reported(value: number): number {
  return Math.round(value * 100) / 100;
}

const MEASUREMENT_EPSILON = 1e-6;

/** Δ exposure between two measurements, in stops. `undefined` when either reads black. */
function stopsBetween(from: SolverMeasurement, to: SolverMeasurement): number | undefined {
  const a = from.luma.mean;
  const b = to.luma.mean;
  if (!(a > MEASUREMENT_EPSILON) || !(b > MEASUREMENT_EPSILON)) return undefined;
  return Math.log2(b / a);
}

/** Every picture clip on a track, in timeline order. Refuses an unknown or empty track. */
function pictureClipsOfTrack(ctx: ToolContext, trackId: string, tool: string): Track['clips'] {
  const track = ctx.project.timeline.tracks.find((candidate) => candidate.id === trackId);
  if (!track) {
    const ids = ctx.project.timeline.tracks.map((candidate) => candidate.id).join(', ');
    throw new ToolRefusalError(
      `${tool}: no track "${trackId}" in this project. The tracks are: ${ids}.`,
    );
  }
  if (track.type === 'audio' || track.type === 'caption') {
    throw new ToolRefusalError(
      `${tool}: track "${trackId}" is a ${track.type} track — there is no picture on it to grade.`,
    );
  }
  return [...track.clips].sort((a, b) => a.start - b.start);
}

/** The `apply_color_grade` operation for one solved grade. */
function gradeOperation(clipId: string, params: ProfessionalColorAdjustments): Operation {
  // The canonical technical-correction node (`professionalColorEffectId`), NOT a fresh id
  // per call. Two consequences that both matter: a second solve on the same clip REPLACES
  // the first rather than stacking two grades whose combined effect neither tool measured,
  // and a solved grade lands on the same layer `professional_color` writes, so the creative
  // LUT/look layers above it are left alone.
  const effect: Effect = {
    id: professionalColorEffectId(clipId),
    type: 'color_grade',
    params: { ...params },
    keyframes: [],
  };
  return { type: 'apply_color_grade', clipId, effect };
}

/** Turn a plan into operations. A clip whose solve moved nothing is not graded. */
function operationsOf(plan: ColorPlan): Operation[] {
  return plan.grades
    .filter((grade) => Object.keys(grade.params).length > 0)
    .map((grade) => gradeOperation(grade.clipId, grade.params));
}

function solvedGrade(
  clipId: string,
  solution: ColorSolution,
  provenance: MeasurementProvenance,
  gaps: { readonly stops?: number; readonly warmth?: number } = {},
): SolvedGrade {
  return {
    clipId,
    params: solution.params,
    clampedParameters: solution.clampedParameters,
    skinCapped: solution.skinCapped,
    provenance,
    ...(gaps.stops === undefined ? {} : { gapStops: reported(gaps.stops) }),
    ...(gaps.warmth === undefined ? {} : { gapWarmth: reported(gaps.warmth) }),
  };
}

/**
 * The one sentence that has to be right: what this grade did NOT do.
 *
 * Assembled from the plan rather than from the operations, because everything that makes a
 * match partial — a clamp, a skin cap, a measurement of the ungraded source — is invisible
 * in the operations it produced. The model reads this note as the tool's result, so a
 * silence here reads as "matched exactly" and sends the run on to the next shot.
 */
export function colorSolveNote(toolName: string, ctx: ToolContext, rawArgs: unknown): string {
  const plan = planFor(toolName, ctx, rawArgs);
  if (plan === undefined) return '';
  const parts: string[] = [...plan.notes];

  const clamped = plan.grades.filter((grade) => grade.clampedParameters.length > 0);
  if (clamped.length > 0) {
    const named = clamped
      .map((grade) => `${grade.clipId} (${grade.clampedParameters.join(', ')})`)
      .join('; ');
    parts.push(
      `the match is partial because the renderer's parameter range ran out on ${named} — ` +
        'those axes went as far as they can and no further',
    );
  }

  const capped = plan.grades.filter((grade) => grade.skinCapped);
  if (capped.length > 0) {
    parts.push(
      `white balance was held back on ${capped.map((grade) => grade.clipId).join(', ')} to ` +
        'keep skin where it is, so the colour cast is only partly matched',
    );
  }

  const fromLedger = plan.grades.filter((grade) => grade.provenance === 'ledger');
  if (fromLedger.length > 0) {
    parts.push(
      `${fromLedger.map((grade) => grade.clipId).join(', ')} was solved against the imported ` +
        "footage's own measurements, which do not include any grade already on the clip — " +
        'measure_color first if this shot was graded before',
    );
  }

  for (const skip of plan.skipped) parts.push(`${skip.clipId}: ${skip.why}`);

  if (plan.grades.length > 0) {
    parts.push(
      'nothing here is verified until it is re-measured: measure_color on the graded clip ' +
        'reads back what the render actually produced',
    );
  }

  if (parts.length === 0) return '';
  return ` — ${parts.join('. ')}.`;
}

// ---------------------------------------------------------------------------
// match_color
// ---------------------------------------------------------------------------

const MAX_MATCH_TARGETS = 40;

const matchColorSchema = z
  .object({
    targetClipIds: z.array(z.string().trim().min(1)).min(1).max(MAX_MATCH_TARGETS),
    referenceClipId: z.string().trim().min(1),
  })
  .strict();

function planMatchColor(args: z.infer<typeof matchColorSchema>, ctx: ToolContext): ColorPlan {
  const slice = pictureOf(ctx);
  const reference = measurementFor(ctx, slice, args.referenceClipId);
  if (reference === undefined) {
    throw new ToolRefusalError(
      `match_color: nothing has measured "${args.referenceClipId}", so there is no look to ` +
        'match to. Call measure_color on it (and on each target) first, or wait for the ' +
        'footage to finish indexing.',
    );
  }

  const notes: string[] = [];
  if (reference.provenance === 'ledger') {
    notes.push(
      `the reference "${args.referenceClipId}" was read from the imported footage rather ` +
        'than from a render of the timeline',
    );
  } else if (!reference.occlusionFree) {
    notes.push(
      `the reference "${args.referenceClipId}" was measured with another layer over it, so ` +
        'its reading includes whatever is composited on top',
    );
  }

  const grades: SolvedGrade[] = [];
  const skipped: SkippedClip[] = [];
  for (const clipId of args.targetClipIds) {
    if (clipId === args.referenceClipId) {
      skipped.push({ clipId, why: 'it is the reference — a shot cannot be matched to itself' });
      continue;
    }
    const target: ResolvedMeasurement | undefined = measurementFor(ctx, slice, clipId);
    if (target === undefined) {
      skipped.push({
        clipId,
        why: 'nothing has measured it, so it was left alone — measure_color reads it',
      });
      continue;
    }
    const skin = skinFor(ctx, clipId);
    const solution = solveColorMatch(target.measurement, reference.measurement, {
      ...(skin === undefined ? {} : { skin }),
    });
    if (Object.keys(solution.params).length === 0) {
      skipped.push({ clipId, why: 'it already measures the same as the reference' });
      continue;
    }
    const stops = stopsBetween(target.measurement, reference.measurement);
    grades.push(
      solvedGrade(clipId, solution, target.provenance, {
        ...(stops === undefined ? {} : { stops }),
        warmth: reference.measurement.warmth - target.measurement.warmth,
      }),
    );
  }
  return { grades, skipped, notes };
}

// ---------------------------------------------------------------------------
// normalize_exposure
// ---------------------------------------------------------------------------

const normalizeExposureSchema = z
  .object({
    trackId: z.string().trim().min(1),
    /** `median` (the default) or the id of the clip whose brightness everything follows. */
    anchor: z.string().trim().min(1).optional(),
  })
  .strict();

/** Clips named outright in a "nothing is measured" refusal before it summarises the rest. */
const MAX_NAMED_CLIPS = 4;

function planNormalizeExposure(
  args: z.infer<typeof normalizeExposureSchema>,
  ctx: ToolContext,
): ColorPlan {
  const slice = pictureOf(ctx);
  const clips = pictureClipsOfTrack(ctx, args.trackId, 'normalize_exposure');
  const measured: { clipId: string; resolved: ResolvedMeasurement }[] = [];
  const skipped: SkippedClip[] = [];
  for (const clip of clips) {
    const resolved = measurementFor(ctx, slice, clip.id);
    if (resolved === undefined) {
      skipped.push({ clipId: clip.id, why: 'not measured yet, so it was left alone' });
      continue;
    }
    measured.push({ clipId: clip.id, resolved });
  }
  if (measured.length === 0) {
    // Name the CLIPS, not just the tool. The old sentence said "measure_color reads one
    // clip; indexing measures them all" — true, and the model still did not call it. In
    // run `3ed87ff0` it asked twice, was told twice, measured nothing, and fell back to
    // 36 hand-picked `apply_color_grade` calls carrying identical numbers on every shot —
    // guessed grades standing in for solved ones. In `3b340e68` it simply stopped.
    //
    // A remedy naming the tool leaves the caller to work out the arguments; one naming
    // the arguments is a call it can make. Same reason `trim_clip` names both time
    // domains and `split_clip` names the range that would work.
    const names = clips.slice(0, MAX_NAMED_CLIPS).map((clip) => clip.id);
    const rest = clips.length - names.length;
    throw new ToolRefusalError(
      `normalize_exposure: nothing on track "${args.trackId}" has been measured, so there is ` +
        'no brightness to normalise toward. ' +
        (names.length === 0
          ? `Track "${args.trackId}" has no picture clips to measure.`
          : `Call measure_color on ${names.map((id) => `"${id}"`).join(', ')}` +
            `${rest > 0 ? ` and the other ${String(rest)} clip${rest === 1 ? '' : 's'} on the track` : ''}` +
            ', then call normalize_exposure again. Indexing the footage measures them all at once.'),
    );
  }

  const notes: string[] = [];
  const anchorArg = args.anchor;
  const anchor: ExposureAnchor =
    anchorArg === undefined || anchorArg === 'median' ? 'median' : { clipId: anchorArg };
  if (anchor !== 'median' && !measured.some((entry) => entry.clipId === anchor.clipId)) {
    notes.push(
      `"${anchor.clipId}" is not a measured clip on this track, so the track's own median ` +
        'brightness was used as the anchor instead',
    );
  }

  const result = solveExposureNormalize(
    measured.map((entry) => ({ id: entry.clipId, measurement: entry.resolved.measurement })),
    anchor,
  );
  notes.push(
    result.anchorId === undefined
      ? `anchored on the track's median brightness (${reported(result.anchorLumaMean)} of full scale)`
      : `anchored on ${result.anchorId}`,
  );

  const provenanceOf = (clipId: string): MeasurementProvenance =>
    measured.find((entry) => entry.clipId === clipId)?.resolved.provenance ?? 'ledger';

  const grades = result.corrections.map((correction) =>
    solvedGrade(
      correction.id,
      {
        params: correction.params,
        clamped: correction.clamped,
        clampedParameters: correction.clampedParameters,
        skinCapped: false,
      },
      provenanceOf(correction.id),
      { stops: -correction.deviationStops },
    ),
  );

  const untouched = result.untouchedIds.filter(
    (id) => !skipped.some((entry) => entry.clipId === id),
  );
  if (untouched.length > 0) {
    notes.push(
      `${String(untouched.length)} clip(s) already sat within a third of a stop of the anchor ` +
        `and were left alone: ${untouched.join(', ')}`,
    );
  }
  return { grades, skipped, notes };
}

// ---------------------------------------------------------------------------
// apply_look
// ---------------------------------------------------------------------------

const applyLookSchema = z
  .object({
    clipIds: z.array(z.string().trim().min(1)).min(1).max(MAX_MATCH_TARGETS).optional(),
    trackId: z.string().trim().min(1).optional(),
    look: z.enum(LOOK_INTENTS),
    amount: z.enum(LOOK_AMOUNTS).optional(),
  })
  .strict();

function planApplyLook(args: z.infer<typeof applyLookSchema>, ctx: ToolContext): ColorPlan {
  if (args.clipIds === undefined && args.trackId === undefined) {
    throw new ToolRefusalError(
      'apply_look: name the shots to change — clipIds for specific clips, or trackId for a ' +
        'whole layer.',
    );
  }
  const slice = pictureOf(ctx);
  const clipIds =
    args.clipIds ??
    pictureClipsOfTrack(ctx, args.trackId as string, 'apply_look').map((clip) => clip.id);
  const look: LookIntent = args.look;
  const amount: LookAmount = args.amount ?? 'medium';

  const grades: SolvedGrade[] = [];
  const skipped: SkippedClip[] = [];
  for (const clipId of clipIds) {
    const resolved = measurementFor(ctx, slice, clipId);
    if (resolved === undefined) {
      skipped.push({
        clipId,
        why:
          'not measured yet, so the look has no baseline to move from — measure_color reads ' +
          'it, or wait for indexing',
      });
      continue;
    }
    const skin = skinFor(ctx, clipId);
    const solution = solveLook(look, amount, resolved.measurement, {
      ...(skin === undefined ? {} : { skin }),
    });
    if (Object.keys(solution.params).length === 0) {
      skipped.push({ clipId, why: `it is already as ${look} as this amount asks for` });
      continue;
    }
    grades.push(solvedGrade(clipId, solution, resolved.provenance));
  }
  return {
    grades,
    skipped,
    notes: [
      `"${look}" at ${amount} strength is a fixed step in MEASURED units, so it costs a ` +
        'different parameter value on each shot and lands them all in the same place',
    ],
  };
}

// ---------------------------------------------------------------------------
// One planner, two callers
// ---------------------------------------------------------------------------

/**
 * Re-derive a call's plan for {@link colorSolveNote}.
 *
 * Pure and cheap — the picture slice and the project index are both memoized, and the
 * solve is arithmetic on a handful of numbers — so recomputing it beats threading a
 * mutable plan out of `buildOps`, which would give the orchestrator a second place where a
 * tool's decisions live. Returns `undefined` for any other tool, and for arguments that no
 * longer parse (the note is decoration; a refusal has already been reported).
 */
function planFor(toolName: string, ctx: ToolContext, rawArgs: unknown): ColorPlan | undefined {
  try {
    switch (toolName) {
      case 'match_color':
        return planMatchColor(matchColorSchema.parse(rawArgs), ctx);
      case 'normalize_exposure':
        return planNormalizeExposure(normalizeExposureSchema.parse(rawArgs), ctx);
      case 'apply_look':
        return planApplyLook(applyLookSchema.parse(rawArgs), ctx);
      default:
        return undefined;
    }
  } catch {
    return EMPTY_PLAN;
  }
}

/** Every tool name whose result carries a {@link colorSolveNote}. */
export const SOLVED_COLOR_TOOL_NAMES: ReadonlySet<string> = new Set([
  'match_color',
  'normalize_exposure',
  'apply_look',
]);

export const SOLVED_COLOR_TOOLS: readonly ToolSpec[] = [
  mutateTool(
    {
      name: 'match_color',
      description:
        'Make one or more shots look like another one. Takes clip ids only — the grade is ' +
        'solved from what the shots measure, so you never supply a number. Every target ' +
        'gets its own correction on the same canonical grade layer. A target nothing has ' +
        'measured is left alone and named; a match the parameter ranges cannot reach is ' +
        'reported as partial rather than as done. Prefer this over apply_color_grade for ' +
        'any "make these match" request.',
      capabilities: ['color'],
    },
    matchColorSchema,
    (a, ctx) => operationsOf(planMatchColor(a, ctx)),
  ),
  mutateTool(
    {
      name: 'normalize_exposure',
      description:
        'Even out brightness across one track. Grades ONLY the shots that sit more than a ' +
        'third of a stop from the anchor and leaves the rest untouched, so a track where ' +
        'three clips are dark gets three corrections, not one per clip. anchor is `median` ' +
        "(the default — the track's own middle) or a clip id to follow.",
      capabilities: ['color'],
    },
    normalizeExposureSchema,
    (a, ctx) => operationsOf(planNormalizeExposure(a, ctx)),
  ),
  mutateTool(
    {
      name: 'apply_look',
      description:
        'Push shots toward a look: warmer, cooler, punchier, flatter, brighter, darker, ' +
        'cinematic or clean, at subtle / medium / strong. Name the shots with clipIds or a ' +
        'whole layer with trackId. The step is fixed in MEASURED units, not in parameters, ' +
        'so the same request lands dark footage and bright footage in the same place. Use ' +
        'this for "make it warmer"; use apply_color_grade only when the editor names a ' +
        'number.',
      capabilities: ['color'],
    },
    applyLookSchema,
    (a, ctx) => operationsOf(planApplyLook(a, ctx)),
  ),
];
