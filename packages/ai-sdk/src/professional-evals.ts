/** Capability-derived professional operation evaluation manifest and contract checks. */
import { z } from 'zod/v4';
import { EDITOR_CAPABILITIES, type EditorCapability } from './editor-capabilities.js';
import { PROFESSIONAL_EVAL_CASES } from './professional-eval-cases.js';
import { PROFESSIONAL_EVAL_STAGES, type ProfessionalEvalCase } from './professional-eval-runner.js';

export {
  PROFESSIONAL_EVAL_STAGES,
  POST_COMPILE_EVAL_STAGES,
  evaluateCompiledProfessionalOperation,
  runProfessionalEvalCase,
  runProfessionalEvalCases,
  summarizeProfessionalEvalResults,
  outcomeIssues,
  type ProfessionalEvalReview,
  type ProfessionalEvalScorecard,
  type ProfessionalEvalScorecardRow,
  type RunProfessionalEvalCaseOptions,
  type ProfessionalEvalStage,
  type ProfessionalEvalCase,
  type ProfessionalEvalCaseResult,
  type ProfessionalEvalCompilation,
  type ProfessionalEvalFixture,
  type OutcomeCheck,
  type EvaluateCompiledProfessionalOperationInput,
  type CompiledProfessionalOperationEvidence,
} from './professional-eval-runner.js';

const COVERED_FIXTURES = {
  'timeline.roll': 'timeline.roll.outcome',
  'timeline.slip': 'timeline.slip.outcome',
  'timeline.slide': 'timeline.slide.outcome',
  'timeline.ripple_trim': 'timeline.ripple-trim.outcome',
  'timeline.lift': 'timeline.lift.outcome',
  'timeline.extract': 'timeline.extract.outcome',
  'timeline.insert': 'timeline.insert.outcome',
  'timeline.overwrite': 'timeline.overwrite.outcome',
  'timeline.replace': 'timeline.replace.outcome',
  'timeline.j_cut': 'timeline.j-cut.outcome',
  'timeline.l_cut': 'timeline.l-cut.outcome',
  'timeline.switch_angle': 'timeline.switch-angle.outcome',
  'motion.clip.scale': 'motion.scale.outcome',
  'motion.clip.x': 'motion.x.outcome',
  'motion.clip.y': 'motion.y.outcome',
  'motion.clip.rotation': 'motion.rotation.outcome',
  'motion.clip.opacity': 'motion.opacity.outcome',
  'color.clip.exposure': 'color.exposure.outcome',
  'color.clip.contrast': 'color.contrast.outcome',
  'color.clip.saturation': 'color.saturation.outcome',
  'color.clip.temperature': 'color.temperature.outcome',
  'color.clip.tint': 'color.tint.outcome',
  'color.clip.shadows': 'color.shadows.outcome',
  'color.clip.highlights': 'color.highlights.outcome',
  'tracking_mask.manual_mask_track': 'tracking-mask.manual.outcome',
  'tracking_mask.automatic_subject_track': 'tracking-mask.automatic.outcome',
  'audio.clip.gain': 'audio.gain.outcome',
  'audio.clip.fade_in': 'audio.fade-in.outcome',
  'audio.clip.fade_out': 'audio.fade-out.outcome',
  'audio.clip.normalize_peak': 'audio.normalize.outcome',
  'audio.clip.sidechain_duck': 'audio.sidechain-duck.outcome',
  'audio.clip.eq': 'audio.eq.outcome',
  'audio.clip.compression': 'audio.compression.outcome',
  'audio.clip.gain_automation': 'audio.gain-automation.outcome',
} as const satisfies Readonly<Record<string, string>>;

export const ProfessionalEvalRowSchema = z
  .object({
    capabilityId: z.string().min(1),
    domain: z.string().min(1),
    availability: z.enum(['registered', 'unsupported']),
    fixtureId: z.string().min(1).optional(),
    unsupportedReason: z.string().min(1).optional(),
    stages: z.array(z.enum(PROFESSIONAL_EVAL_STAGES)),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.availability === 'registered' && row.fixtureId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['fixtureId'],
        message: 'Covered row needs fixture.',
      });
    }
    if (row.availability === 'unsupported' && row.unsupportedReason === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['unsupportedReason'],
        message: 'Unsupported row needs an honest reason.',
      });
    }
  });

export type ProfessionalEvalRow = z.infer<typeof ProfessionalEvalRowSchema>;

/** Build the public scorecard without turning a newly added capability green automatically. */
export function buildProfessionalEvalManifest(
  capabilities: readonly EditorCapability[] = EDITOR_CAPABILITIES,
): readonly ProfessionalEvalRow[] {
  return capabilities.map((capability) => {
    const fixtureId = COVERED_FIXTURES[capability.id as keyof typeof COVERED_FIXTURES];
    if (capability.availability.state === 'available' && capability.editable && fixtureId) {
      return ProfessionalEvalRowSchema.parse({
        capabilityId: capability.id,
        domain: capability.domain,
        availability: 'registered',
        fixtureId,
        stages: [...PROFESSIONAL_EVAL_STAGES],
      });
    }
    return ProfessionalEvalRowSchema.parse({
      capabilityId: capability.id,
      domain: capability.domain,
      availability: 'unsupported',
      unsupportedReason:
        capability.availability.state === 'available' && capability.editable
          ? 'No executable professional outcome fixture is registered.'
          : capability.availability.reason,
      stages: [],
    });
  });
}

export interface ProfessionalEvalDriftIssue {
  readonly capabilityId: string;
  readonly message: string;
}

/** Release-gate drift: every advertised editable capability needs one executable row. */
export function professionalEvalDriftIssues(
  rows: readonly ProfessionalEvalRow[],
  capabilities: readonly EditorCapability[] = EDITOR_CAPABILITIES,
  cases: readonly ProfessionalEvalCase[] = PROFESSIONAL_EVAL_CASES,
): readonly ProfessionalEvalDriftIssue[] {
  const issues: ProfessionalEvalDriftIssue[] = [];
  const rowsByCapability = new Map<string, ProfessionalEvalRow[]>();
  for (const row of rows) {
    const current = rowsByCapability.get(row.capabilityId) ?? [];
    current.push(row);
    rowsByCapability.set(row.capabilityId, current);
  }
  for (const capability of capabilities) {
    const matching = rowsByCapability.get(capability.id) ?? [];
    if (matching.length !== 1) {
      issues.push({
        capabilityId: capability.id,
        message: `Expected exactly one eval row; found ${matching.length}.`,
      });
      continue;
    }
    const row = matching[0]!;
    if (
      capability.availability.state === 'available' &&
      capability.editable &&
      (row.availability !== 'registered' || row.stages.length !== PROFESSIONAL_EVAL_STAGES.length)
    ) {
      issues.push({
        capabilityId: capability.id,
        message: 'Advertised editable capability lacks full-stage outcome coverage.',
      });
    }
  }
  for (const capabilityId of rowsByCapability.keys()) {
    if (!capabilities.some((capability) => capability.id === capabilityId)) {
      issues.push({ capabilityId, message: 'Eval row references an unknown capability.' });
    }
  }
  issues.push(...runnableCaseDriftIssues(rows, cases));
  return issues;
}

/**
 * A registered fixture id is a promise that something actually runs. Reconcile the manifest against
 * the executable case registry in both directions so neither side can drift silently.
 */
function runnableCaseDriftIssues(
  rows: readonly ProfessionalEvalRow[],
  cases: readonly ProfessionalEvalCase[],
): readonly ProfessionalEvalDriftIssue[] {
  const issues: ProfessionalEvalDriftIssue[] = [];
  const casesByFixture = new Map<string, ProfessionalEvalCase[]>();
  for (const evalCase of cases) {
    const current = casesByFixture.get(evalCase.fixtureId) ?? [];
    current.push(evalCase);
    casesByFixture.set(evalCase.fixtureId, current);
  }
  const registeredFixtures = new Set<string>();
  for (const row of rows) {
    if (row.availability !== 'registered' || row.fixtureId === undefined) continue;
    registeredFixtures.add(row.fixtureId);
    const matching = casesByFixture.get(row.fixtureId) ?? [];
    if (matching.length !== 1) {
      issues.push({
        capabilityId: row.capabilityId,
        message: `Registered fixture "${row.fixtureId}" has ${matching.length} executable cases; expected exactly one.`,
      });
      continue;
    }
    if (matching[0]!.capabilityId !== row.capabilityId) {
      issues.push({
        capabilityId: row.capabilityId,
        message: `Fixture "${row.fixtureId}" runs capability "${matching[0]!.capabilityId}".`,
      });
    }
  }
  for (const evalCase of cases) {
    if (!registeredFixtures.has(evalCase.fixtureId)) {
      issues.push({
        capabilityId: evalCase.capabilityId,
        message: `Executable case "${evalCase.fixtureId}" has no registered scorecard row.`,
      });
    }
  }
  return issues;
}

export const PROFESSIONAL_EVAL_MANIFEST = buildProfessionalEvalManifest();
