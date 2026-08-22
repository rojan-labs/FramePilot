/** Canonical professional-editor run lifecycle shared by every execution route. */
import { z } from 'zod/v4';

export const EDITOR_RUN_LIFECYCLE_VERSION = 1 as const;

export const EditorRunRouteSchema = z.enum(['edit', 'agent']);
export type EditorRunRoute = z.infer<typeof EditorRunRouteSchema>;

export const EditorRunStageSchema = z.enum([
  'understand',
  'resolve',
  'inspect',
  'plan',
  'compile',
  'execute',
  'verify',
  'review',
  'repair',
  'finalize',
]);
export type EditorRunStage = z.infer<typeof EditorRunStageSchema>;

export const EDITOR_RUN_STAGES: readonly EditorRunStage[] = EditorRunStageSchema.options;

export const EditorRunStageDispositionSchema = z.enum([
  'required',
  'precompiled',
  'conditional',
]);
export type EditorRunStageDisposition = z.infer<typeof EditorRunStageDispositionSchema>;

export const EditorRunRoutePolicySchema = z.object(
  Object.fromEntries(
    EDITOR_RUN_STAGES.map((stage) => [stage, EditorRunStageDispositionSchema]),
  ) as Record<EditorRunStage, typeof EditorRunStageDispositionSchema>,
);
export type EditorRunRoutePolicy = z.infer<typeof EditorRunRoutePolicySchema>;

/**
 * Route differences are data, not hidden control-flow forks. `precompiled` means the
 * route must still close that stage with evidence supplied by a deterministic artifact.
 */
export const EDITOR_RUN_ROUTE_POLICY: Readonly<Record<EditorRunRoute, EditorRunRoutePolicy>> = {
  edit: {
    understand: 'required',
    resolve: 'required',
    inspect: 'conditional',
    plan: 'conditional',
    compile: 'required',
    execute: 'required',
    verify: 'required',
    review: 'required',
    repair: 'conditional',
    finalize: 'required',
  },
  agent: {
    understand: 'required',
    resolve: 'required',
    inspect: 'required',
    plan: 'conditional',
    compile: 'required',
    execute: 'required',
    verify: 'required',
    review: 'required',
    repair: 'conditional',
    finalize: 'required',
  },
};

export const EditorRunStageEventSchema = z
  .object({
    schemaVersion: z.literal(EDITOR_RUN_LIFECYCLE_VERSION),
    runId: z.string().trim().min(1).max(256),
    route: EditorRunRouteSchema,
    sequence: z.number().int().nonnegative(),
    stage: EditorRunStageSchema,
    state: z.enum(['entered', 'completed', 'failed', 'cancelled']),
    occurredAt: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    evidence: z.array(z.string().trim().min(1).max(512)).default([]),
    reason: z.string().trim().min(1).max(1024).optional(),
  })
  .strict()
  .superRefine((event, refinement) => {
    if ((event.state === 'failed' || event.state === 'cancelled') && event.reason === undefined) {
      refinement.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A failed or cancelled editor-run stage requires a reason.',
      });
    }
  });
export type EditorRunStageEvent = z.infer<typeof EditorRunStageEventSchema>;

export interface EditorRunLifecycleState {
  readonly runId: string;
  readonly route: EditorRunRoute;
  readonly sequence: number;
  readonly activeStage?: EditorRunStage;
  readonly completedStages: readonly EditorRunStage[];
  readonly repairAttempt: number;
  readonly terminal: boolean;
}

export function createEditorRunLifecycle(
  runId: string,
  route: EditorRunRoute,
): EditorRunLifecycleState {
  if (runId.trim().length === 0) throw new Error('EditorRun requires a non-empty run id.');
  return {
    runId,
    route,
    sequence: 0,
    completedStages: [],
    repairAttempt: 0,
    terminal: false,
  };
}

function stageIndex(stage: EditorRunStage): number {
  return EDITOR_RUN_STAGES.indexOf(stage);
}

function assertLegalEntry(state: EditorRunLifecycleState, stage: EditorRunStage): void {
  if (state.terminal) throw new Error('A finalized EditorRun cannot enter another stage.');
  if (state.activeStage !== undefined) {
    throw new Error(`EditorRun stage "${state.activeStage}" must settle before entering "${stage}".`);
  }
  if (state.completedStages.length === 0 && stage !== 'understand') {
    throw new Error('Every EditorRun must begin at understand.');
  }
  const last = state.completedStages.at(-1);
  if (!last) return;
  const forward = stageIndex(stage) > stageIndex(last);
  const repairReentry = last === 'repair' && ['resolve', 'inspect', 'plan', 'compile'].includes(stage);
  if (!forward && !repairReentry) {
    throw new Error(`Illegal EditorRun transition from "${last}" to "${stage}".`);
  }
}

/** Pure reducer: validates ordering and returns the next lifecycle snapshot. */
export function reduceEditorRunStageEvent(
  state: EditorRunLifecycleState,
  value: unknown,
): EditorRunLifecycleState {
  const event = EditorRunStageEventSchema.parse(value);
  if (event.runId !== state.runId || event.route !== state.route) {
    throw new Error('EditorRun stage event does not belong to this run and route.');
  }
  if (event.sequence !== state.sequence + 1) {
    throw new Error(
      `EditorRun stage sequence must be ${state.sequence + 1}, got ${event.sequence}.`,
    );
  }
  const expectedAttempt =
    state.activeStage === 'repair'
      ? state.repairAttempt
      : state.repairAttempt + 1;
  if (event.attempt !== Math.max(1, expectedAttempt)) {
    throw new Error(
      `EditorRun stage attempt must be ${Math.max(1, expectedAttempt)}, got ${event.attempt}.`,
    );
  }
  if (event.state === 'entered') {
    assertLegalEntry(state, event.stage);
    return {
      ...state,
      sequence: event.sequence,
      activeStage: event.stage,
      repairAttempt:
        event.stage === 'repair' ? state.repairAttempt + 1 : state.repairAttempt,
    };
  }
  if (state.activeStage !== event.stage) {
    throw new Error(`EditorRun cannot ${event.state} inactive stage "${event.stage}".`);
  }
  const completedStages =
    event.state === 'completed' ? [...state.completedStages, event.stage] : state.completedStages;
  const { activeStage: _activeStage, ...settledState } = state;
  return {
    ...settledState,
    sequence: event.sequence,
    completedStages,
    terminal:
      event.stage === 'finalize' || event.state === 'failed' || event.state === 'cancelled',
  };
}

export function parseEditorRunStageEvent(value: unknown): EditorRunStageEvent {
  return EditorRunStageEventSchema.parse(value);
}
