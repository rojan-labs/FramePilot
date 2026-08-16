/**
 * Executable professional operation evaluation runner.
 *
 * Registrations in the capability scorecard only become meaningful when a fixture actually runs.
 * This module owns the shared post-compile evaluator plus the case contract that every domain
 * suite implements, so `professionalEvalDriftIssues` can reject a registered row that has no
 * runnable case behind it.
 */
import { applyPatch, validatePatch, type Patch } from '@framepilot/editor-core';
import { deserializeProject, serializeProject, type Project } from '@framepilot/timeline-schema';
import { EDITOR_CAPABILITIES } from './editor-capabilities.js';
import type { EditorInteractionContext } from './editor-context/interaction-context.js';
import type { TemporalEvidenceAcquirer } from './temporal-evidence-client.js';
import {
  planTemporalEvidenceForEdit,
  reviewTemporalEvidence,
  type TemporalEvidenceRequest,
  type TemporalReviewReport,
} from './temporal-review.js';

export const PROFESSIONAL_EVAL_STAGES = [
  'resolve',
  'compile',
  'validate',
  'apply',
  'invert',
  'verify',
  'persist_reload',
  'cross_host',
] as const;

export type ProfessionalEvalStage = (typeof PROFESSIONAL_EVAL_STAGES)[number];

/**
 * Stages the shared evaluator proves once a domain case has resolved and compiled.
 *
 * `verify` is deliberately absent: planning evidence requests is not the same as looking at a
 * rendered result. A case only earns `verify` when evidence is actually acquired and reviewed.
 */
export const POST_COMPILE_EVAL_STAGES = [
  'validate',
  'apply',
  'invert',
  'persist_reload',
  'cross_host',
] as const satisfies readonly ProfessionalEvalStage[];

/**
 * Compare edit content, not object key order.
 *
 * Schema round-trips reorder keys to their declared order, so a raw `JSON.stringify` comparison
 * reports identical timelines as changed. Array order stays significant because clip and keyframe
 * ordering is editorial meaning, not formatting.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export interface EvaluateCompiledProfessionalOperationInput {
  readonly capabilityId: string;
  readonly project: Project;
  readonly patch: Patch;
  readonly inversePatch: Patch;
}

export interface CompiledProfessionalOperationEvidence {
  readonly capabilityId: string;
  readonly stages: readonly Exclude<ProfessionalEvalStage, 'resolve' | 'compile'>[];
  readonly requests: readonly TemporalEvidenceRequest[];
  readonly persistedProject: Project;
}

/**
 * Prove the deterministic half of a compiled eval: patch legality, outcome application, exact
 * inverse, save/reload, JSON-safe host transport, and objective-review request planning.
 * Resolver/compiler callers remain domain-specific and must succeed before calling this helper.
 */
export function evaluateCompiledProfessionalOperation(
  input: EvaluateCompiledProfessionalOperationInput,
): CompiledProfessionalOperationEvidence {
  const capability = EDITOR_CAPABILITIES.find((candidate) => candidate.id === input.capabilityId);
  if (!capability || capability.availability.state !== 'available' || !capability.editable) {
    throw new Error(`Capability "${input.capabilityId}" is not advertised as editable.`);
  }
  const validation = validatePatch(input.project.timeline, input.patch, {
    assetIds: input.project.assets.map((asset) => asset.id),
  });
  if (!validation.valid) {
    throw new Error(validation.issues.map((issue) => issue.message).join('; '));
  }
  const editedTimeline = applyPatch(input.project.timeline, input.patch);
  const restoredTimeline = applyPatch(editedTimeline, input.inversePatch);
  if (
    canonicalJson({ ...restoredTimeline, revision: input.project.timeline.revision }) !==
    canonicalJson(input.project.timeline)
  ) {
    throw new Error(`Capability "${input.capabilityId}" failed exact inverse restoration.`);
  }
  const editedProject = { ...input.project, timeline: editedTimeline };
  const persistedProject = deserializeProject(serializeProject(editedProject));
  if (canonicalJson(persistedProject.timeline) !== canonicalJson(editedTimeline)) {
    throw new Error(`Capability "${input.capabilityId}" changed across save/reload.`);
  }
  const transportedPatch = JSON.parse(JSON.stringify(input.patch)) as Patch;
  if (canonicalJson(transportedPatch) !== canonicalJson(input.patch)) {
    throw new Error(`Capability "${input.capabilityId}" is not host-transport stable.`);
  }
  const durationFrames = Math.max(
    1,
    Math.ceil(
      Math.max(
        0,
        ...editedTimeline.tracks.flatMap((track) => track.clips.map((clip) => clip.end)),
      ) * input.project.fps,
    ),
  );
  const requests = planTemporalEvidenceForEdit({
    projectRevision: editedTimeline.revision ?? 0,
    edit: {
      patch: input.patch,
      validation,
      diff: { before: input.project.timeline, after: editedTimeline, summary: ['eval outcome'] },
      text: input.patch.reason,
    },
    sequenceFps: input.project.fps,
    durationFrames,
  });
  if (requests.length === 0) {
    throw new Error(`Capability "${input.capabilityId}" produced no verification requests.`);
  }
  return {
    capabilityId: input.capabilityId,
    stages: [...POST_COMPILE_EVAL_STAGES],
    requests,
    persistedProject,
  };
}

export interface ProfessionalEvalFixture {
  readonly project: Project;
  readonly interaction: EditorInteractionContext;
}

export type ProfessionalEvalCompilation =
  | {
      readonly status: 'compiled';
      readonly patch: Patch;
      readonly inversePatch: Patch;
      /** Facts the resolver/controller proved, recorded as lineage rather than re-asserted. */
      readonly resolution: readonly string[];
    }
  | { readonly status: 'failed'; readonly failures: readonly string[] };

/**
 * One executable professional capability evaluation.
 *
 * Domains differ only in how they resolve a live referent and compile a semantic command, so each
 * case owns those two steps and the editorial outcome; everything after compilation is shared.
 */
export interface ProfessionalEvalCase {
  readonly fixtureId: string;
  readonly capabilityId: string;
  /** Build a fresh project and live interaction snapshot; never shared between runs. */
  readonly setup: () => ProfessionalEvalFixture;
  /** Resolve the referent through the real controller/resolver and compile the command. */
  readonly resolveAndCompile: (fixture: ProfessionalEvalFixture) => ProfessionalEvalCompilation;
  /** Assert the editorial result on the persisted project; returns failures, never throws. */
  readonly expectOutcome: (
    persisted: Project,
    fixture: ProfessionalEvalFixture,
  ) => readonly string[];
}

export type ProfessionalEvalReview =
  | {
      readonly status: 'not_acquired';
      readonly plannedRequests: number;
      readonly reason: string;
    }
  | {
      readonly status: 'reviewed';
      readonly report: TemporalReviewReport;
    }
  | {
      readonly status: 'acquisition_failed';
      readonly plannedRequests: number;
      readonly reason: string;
    };

export interface ProfessionalEvalCaseResult {
  readonly fixtureId: string;
  readonly capabilityId: string;
  readonly status: 'passed' | 'failed';
  readonly stages: readonly ProfessionalEvalStage[];
  readonly failures: readonly string[];
  readonly resolution: readonly string[];
  readonly requests: readonly TemporalEvidenceRequest[];
  readonly review: ProfessionalEvalReview;
}

export interface RunProfessionalEvalCaseOptions {
  /**
   * The production sidecar acquisition callback. Omit to run the deterministic spine only; the
   * result then reports `not_acquired` rather than implying a rendered check happened. There is
   * deliberately no built-in default, so an eval that cannot reach a renderer cannot invent
   * samples.
   */
  readonly acquireEvidence?: TemporalEvidenceAcquirer;
}

/** Execute one case end to end and report machine-readable stage lineage. */
export async function runProfessionalEvalCase(
  evalCase: ProfessionalEvalCase,
  options: RunProfessionalEvalCaseOptions = {},
): Promise<ProfessionalEvalCaseResult> {
  const failed = (
    stages: readonly ProfessionalEvalStage[],
    failures: readonly string[],
    resolution: readonly string[] = [],
  ): ProfessionalEvalCaseResult => ({
    fixtureId: evalCase.fixtureId,
    capabilityId: evalCase.capabilityId,
    status: 'failed',
    stages,
    failures,
    resolution,
    requests: [],
    review: { status: 'not_acquired', plannedRequests: 0, reason: 'Case failed before review.' },
  });

  let fixture: ProfessionalEvalFixture;
  try {
    fixture = evalCase.setup();
  } catch (error) {
    return failed([], [`setup threw: ${describeError(error)}`]);
  }

  const compilation = evalCase.resolveAndCompile(fixture);
  if (compilation.status === 'failed') {
    return failed([], compilation.failures);
  }

  let evidence: CompiledProfessionalOperationEvidence;
  try {
    evidence = evaluateCompiledProfessionalOperation({
      capabilityId: evalCase.capabilityId,
      project: fixture.project,
      patch: compilation.patch,
      inversePatch: compilation.inversePatch,
    });
  } catch (error) {
    return failed(['resolve', 'compile'], [describeError(error)], compilation.resolution);
  }

  const failures = [...evalCase.expectOutcome(evidence.persistedProject, fixture)];
  const review = await reviewCaseEvidence(
    evidence.requests,
    evidence.persistedProject,
    options.acquireEvidence,
  );
  if (review.status === 'acquisition_failed') failures.push(review.reason);
  if (review.status === 'reviewed' && !review.report.ok) {
    failures.push(...review.report.checks.flatMap((check) => check.issues));
  }
  const verified = review.status === 'reviewed' && review.report.ok;
  return {
    fixtureId: evalCase.fixtureId,
    capabilityId: evalCase.capabilityId,
    status: failures.length === 0 ? 'passed' : 'failed',
    stages: verified
      ? ['resolve', 'compile', ...evidence.stages, 'verify']
      : ['resolve', 'compile', ...evidence.stages],
    failures,
    resolution: compilation.resolution,
    requests: evidence.requests,
    review,
  };
}

export interface ProfessionalEvalScorecardRow {
  readonly fixtureId: string;
  readonly capabilityId: string;
  readonly status: 'passed' | 'failed';
  readonly stages: readonly ProfessionalEvalStage[];
  readonly review: ProfessionalEvalReview['status'];
  readonly plannedRequests: number;
  readonly failures: readonly string[];
}

export interface ProfessionalEvalScorecard {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Rows whose rendered objective was actually acquired and reviewed green. */
  readonly verified: number;
  readonly rows: readonly ProfessionalEvalScorecardRow[];
}

export async function runProfessionalEvalCases(
  cases: readonly ProfessionalEvalCase[],
  options: RunProfessionalEvalCaseOptions = {},
): Promise<readonly ProfessionalEvalCaseResult[]> {
  const results: ProfessionalEvalCaseResult[] = [];
  // Sequential: acquisition drives a real renderer, and eval lineage must stay reproducible.
  for (const evalCase of cases) {
    results.push(await runProfessionalEvalCase(evalCase, options));
  }
  return results;
}

/** Reduce run results to a stable, serializable record of what actually executed. */
export function summarizeProfessionalEvalResults(
  results: readonly ProfessionalEvalCaseResult[],
): ProfessionalEvalScorecard {
  const rows = results
    .map((result) => ({
      fixtureId: result.fixtureId,
      capabilityId: result.capabilityId,
      status: result.status,
      stages: result.stages,
      review: result.review.status,
      plannedRequests: result.requests.length,
      failures: result.failures,
    }))
    .sort((left, right) => (left.fixtureId < right.fixtureId ? -1 : 1));
  return {
    total: rows.length,
    passed: rows.filter((row) => row.status === 'passed').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    verified: rows.filter((row) => row.stages.includes('verify')).length,
    rows,
  };
}

/** Acquire and review rendered evidence when a renderer is available; never fabricate samples. */
async function reviewCaseEvidence(
  requests: readonly TemporalEvidenceRequest[],
  editedProject: Project,
  acquire: TemporalEvidenceAcquirer | undefined,
): Promise<ProfessionalEvalReview> {
  if (!acquire) {
    return {
      status: 'not_acquired',
      plannedRequests: requests.length,
      reason: 'No evidence acquirer was supplied; the rendered objective was not verified.',
    };
  }
  try {
    // Evidence must describe the applied edit. Rendering the setup fixture would either fail the
    // revision-bound engine request or, worse, review the before state as though it were the result.
    const batch = await acquire(editedProject, requests);
    return { status: 'reviewed', report: reviewTemporalEvidence(requests, batch.results) };
  } catch (error) {
    return {
      status: 'acquisition_failed',
      plannedRequests: requests.length,
      reason: `Evidence acquisition or review failed: ${describeError(error)}`,
    };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Frame-accurate tolerance; authored timing is rational, so drift beyond this is a real defect. */
const OUTCOME_EPSILON = 1e-9;

export interface OutcomeCheck {
  readonly label: string;
  readonly actual: unknown;
  readonly expected: unknown;
}

/** Compare editorial outcomes without a test framework so cases stay runnable from any host. */
export function outcomeIssues(checks: readonly OutcomeCheck[]): readonly string[] {
  return checks.flatMap((check) => {
    const matches =
      typeof check.actual === 'number' && typeof check.expected === 'number'
        ? Math.abs(check.actual - check.expected) <= OUTCOME_EPSILON
        : JSON.stringify(check.actual) === JSON.stringify(check.expected);
    return matches
      ? []
      : [
          `${check.label}: expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(
            check.actual,
          )}`,
        ];
  });
}
