/**
 * Durable orchestration protocol v1.
 *
 * These schemas are the trust boundary shared by the desktop gateway, browser
 * adapter, MCP adapter, run store, and workspace projector. Every accepted
 * command, persisted event, and restored snapshot is parsed here before use.
 */
import { z } from 'zod/v4';
import type { DurableRunStartRequest } from '@framepilot/shared-types';
import { KEY_DIGEST_CHARS, MAX_IDENTITY_KEY_CHARS, boundedKeySegment } from './stable-key.js';

export const RUN_PROTOCOL_SCHEMA_VERSION = 1 as const;

const idSchema = z.string().trim().min(1).max(256);

/**
 * An identity key that is only ever compared for equality, bounded on the way in
 * rather than rejected.
 *
 * `idempotencyKey` used to be a plain `idSchema`, so a key longer than 256
 * characters failed the whole snapshot parse. Producers are bounded now
 * (`idempotencyKeyFor`), but runs persisted before that are still on disk, and a
 * snapshot that cannot parse cannot be *closed* either: startup reconciliation
 * caught the error, skipped the run, and left it non-terminal — so it failed
 * again on every subsequent launch, forever. One over-long string permanently
 * stranded a run the user could no longer see or clear.
 *
 * Bounding here is identity-preserving. `boundedKeySegment` is deterministic and
 * keeps a digest of the full input, so a legacy long key and a freshly computed
 * one for the same call reduce to the same string, and two keys that differed
 * anywhere still differ. Equality is all this field is for.
 *
 * The `<= MAX` guard is what makes the transform idempotent, and it is load-bearing
 * rather than an optimization: a snapshot is parsed, re-persisted and parsed again
 * many times over a run's life, and bounding unconditionally would re-truncate an
 * already-bounded key on every pass — a key that changes identity each time it is
 * read is worse than one that is too long.
 */
const identityKeySchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) =>
    value.length <= MAX_IDENTITY_KEY_CHARS
      ? value
      : boundedKeySegment(value, MAX_IDENTITY_KEY_CHARS - KEY_DIGEST_CHARS),
  );
const timestampSchema = z.number().int().nonnegative().finite();
const sequenceSchema = z.number().int().nonnegative().finite();

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** Monotonic revision of the canonical project document. */
export const ProjectRevisionSchema = z.number().int().nonnegative().finite();
export type ProjectRevision = z.infer<typeof ProjectRevisionSchema>;

/**
 * Durable lifecycle status. Existing presentation statuses remain valid during
 * migration; foundation statuses add explicit recovery/review phases.
 */
export const RunStatusSchema = z.enum([
  'idle',
  'accepted',
  'thinking',
  'searching',
  'reading',
  'planning',
  'awaiting_approval',
  'awaiting_answer',
  'awaiting_input',
  'editing',
  'executing',
  'generating',
  'running_tool',
  'rendering',
  'reconciling',
  'verifying',
  'awaiting_review',
  'suspended',
  'completed',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunOutcomeKindSchema = z.enum([
  'completed_with_changes',
  'completed_no_changes',
  'completed_with_warnings',
  'rejected',
  'cancelled',
  'interrupted',
  'timed_out',
  'failed',
]);
export type RunOutcomeKind = z.infer<typeof RunOutcomeKindSchema>;

export const RunTerminationSourceSchema = z.enum([
  'run_completed',
  'user_stop',
  'question_dismissed',
  'plan_rejected',
  'provider',
  'timeout',
  'application_shutdown',
  'process_restart',
  'internal_error',
]);
export type RunTerminationSource = z.infer<typeof RunTerminationSourceSchema>;

export const RunOutcomeSchema = z
  .object({
    kind: RunOutcomeKindSchema,
    reason: z.string().trim().min(1).optional(),
    source: RunTerminationSourceSchema.optional(),
    changed: z.boolean(),
    warnings: z.array(z.string()).default([]),
  })
  .strict();
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const PatchDecisionStateSchema = z.enum([
  'pending',
  'accepted',
  'rejected',
  'stale',
  'committed',
]);
export type PatchDecisionState = z.infer<typeof PatchDecisionStateSchema>;

export const PatchDecisionSchema = z
  .object({
    patchId: idSchema,
    state: PatchDecisionStateSchema,
    decidedAt: timestampSchema.optional(),
    decidedByCommandId: idSchema.optional(),
    reason: z.string().trim().min(1).optional(),
    projectRevision: ProjectRevisionSchema.optional(),
  })
  .strict();
export type PatchDecision = z.infer<typeof PatchDecisionSchema>;

const commandBase = {
  schemaVersion: z.literal(RUN_PROTOCOL_SCHEMA_VERSION),
  commandId: idSchema,
  runId: idSchema,
  projectId: idSchema,
  expectedProjectRevision: ProjectRevisionSchema.optional(),
  issuedAt: timestampSchema,
} as const;

/** The run modes a host may start today. `planned-edit` is deliberately absent. */
export const DURABLE_RUN_MODES = [
  'auto',
  'chat',
  'plan',
  'edit',
  'agent',
  'review',
] as const;
export type DurableRunMode = (typeof DURABLE_RUN_MODES)[number];

/**
 * The retired `planned_edit` route's durable mode string (ADR 0126).
 *
 * It cannot simply be dropped from the enum. Persisted `start` commands are re-parsed from
 * the durable event log during recovery (`run-coordinator-base.ts#commandFromEvent`), so a
 * run that was in flight when the user upgraded would fail to replay and their work would be
 * unrecoverable. Instead the value is still ACCEPTED on read and normalized to the runtime
 * that absorbed it, which is exactly where such a run would continue anyway: the planner
 * path already fell back to the agent whenever its own gate declined a plan.
 *
 * Fresh starts are rejected at the IPC boundary (`run-ipc.ts`), so this is a read-side
 * migration only — nothing new is ever written with it.
 */
const RETIRED_PLANNED_EDIT_MODE = 'planned-edit';

/**
 * Compile-time lockstep with `DurableRunStartRequest['mode']` in `@framepilot/shared-types`.
 * That package cannot import this one (the dependency runs the other way), so the check lives
 * here: adding or removing a run mode on either side fails typecheck instead of silently
 * letting the renderer-facing contract and the durable schema drift apart.
 */
type MutuallyAssignable<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
/** Fails to compile unless the two unions are exactly equal. */
type AssertTrue<T extends true> = T;
export type DurableRunModeLockstep = AssertTrue<
  MutuallyAssignable<DurableRunMode, DurableRunStartRequest['mode']>
>;

const DurableRunModeSchema = z
  .enum([...DURABLE_RUN_MODES, RETIRED_PLANNED_EDIT_MODE])
  .transform((mode): DurableRunMode => (mode === RETIRED_PLANNED_EDIT_MODE ? 'agent' : mode));

const StartCommandSchema = z
  .object({
    ...commandBase,
    kind: z.literal('start'),
    payload: z
      .object({
        userPrompt: z.string().trim().min(1),
        mode: DurableRunModeSchema,
        selection: JsonValueSchema.optional(),
        agentOptions: JsonValueSchema.optional(),
        contextHandles: z.array(idSchema).default([]),
        patchPolicy: z.enum(['review', 'auto_commit']).default('review'),
        /**
         * The run's durable task memory (ADR 0075) — what it learned, decided and did,
         * as opposed to `tasks`/`effects`, which describe how the machinery executed.
         *
         * Held as opaque JSON on purpose. This module is the trust boundary and is authored
         * against `zod/v4`, while the working-state schema lives in `kernel/working-state.ts`
         * against `zod` v3; composing the two silently misbehaves. Readers call
         * `parseWorkingState`, which validates the shape and drops what it cannot understand,
         * so a snapshot written by a newer build can never crash an older one.
         */
        workingState: JsonValueSchema.optional(),
      })
      .strict(),
  })
  .strict();

const PlanDecisionPayloadSchema = z
  .object({
    planId: idSchema,
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

const AnswerPayloadSchema = z
  .object({
    toolCallId: idSchema,
    answer: z.string().trim().min(1),
  })
  .strict();

const SteeringPayloadSchema = z
  .object({
    message: z.string().trim().min(1),
  })
  .strict();

const StopPayloadSchema = z
  .object({
    source: z.enum(['user_stop', 'question_dismissed']),
    reason: z.string().trim().min(1),
  })
  .strict();

const ResumePayloadSchema = z
  .object({
    fromSequence: sequenceSchema.optional(),
  })
  .strict();

const PatchDecisionPayloadSchema = z
  .object({
    patchId: idSchema,
    reason: z.string().trim().min(1).optional(),
    projectRevision: ProjectRevisionSchema.optional(),
  })
  .strict();

const commandSchema = <Kind extends string, Payload extends z.ZodType>(
  kind: Kind,
  payload: Payload,
) =>
  z
    .object({
      ...commandBase,
      kind: z.literal(kind),
      payload,
    })
    .strict();

/** Every durable input accepted by a run coordinator. */
export const RunCommandEnvelopeSchema = z.discriminatedUnion('kind', [
  StartCommandSchema,
  commandSchema('approve_plan', PlanDecisionPayloadSchema),
  commandSchema('reject_plan', PlanDecisionPayloadSchema),
  commandSchema('answer', AnswerPayloadSchema),
  commandSchema('steer', SteeringPayloadSchema),
  commandSchema('cancel', StopPayloadSchema),
  commandSchema('resume', ResumePayloadSchema),
  commandSchema('accept_patch', PatchDecisionPayloadSchema),
  commandSchema('reject_patch', PatchDecisionPayloadSchema),
]);
export type RunCommandEnvelope = z.infer<typeof RunCommandEnvelopeSchema>;
export type RunCommandKind = RunCommandEnvelope['kind'];

/**
 * Append-only domain event. `sequence` is monotonic within one run; causation
 * fields connect the event to the durable input/effect that produced it.
 */
export const RunEventEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(RUN_PROTOCOL_SCHEMA_VERSION),
    eventId: idSchema,
    runId: idSchema,
    projectId: idSchema,
    sequence: sequenceSchema,
    causedByCommandId: idSchema.optional(),
    causedByEffectId: idSchema.optional(),
    projectRevision: ProjectRevisionSchema.optional(),
    occurredAt: timestampSchema,
    kind: idSchema,
    payload: JsonValueSchema,
  })
  .strict();
export type RunEventEnvelope = z.infer<typeof RunEventEnvelopeSchema>;

export const TaskRunStateSchema = z.enum([
  'pending',
  'ready',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);
export type TaskRunState = z.infer<typeof TaskRunStateSchema>;

export const EffectRunStateSchema = z.enum([
  'pending',
  'running',
  'settled',
  'failed',
  'cancelled',
]);
export type EffectRunState = z.infer<typeof EffectRunStateSchema>;

const TaskSnapshotSchema = z
  .object({
    taskId: idSchema,
    parentTaskId: idSchema.optional(),
    state: TaskRunStateSchema,
    dependsOn: z.array(idSchema).default([]),
    attempt: z.number().int().nonnegative(),
    summary: z.string().optional(),
  })
  .strict();

export const EffectSnapshotSchema = z
  .object({
    effectId: idSchema,
    taskId: idSchema,
    kind: idSchema,
    state: EffectRunStateSchema,
    attempt: z.number().int().nonnegative(),
    idempotencyKey: identityKeySchema,
    outcome: JsonValueSchema.optional(),
  })
  .strict();

const PendingGateSchema = z
  .object({
    gateId: idSchema,
    kind: z.enum(['plan_approval', 'question', 'patch_review']),
    requestedAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    payload: JsonValueSchema,
  })
  .strict();

const BudgetSnapshotSchema = z
  .object({
    limit: z.number().nonnegative().finite(),
    consumed: z.number().nonnegative().finite(),
    unit: z.string().trim().min(1),
  })
  .strict()
  .refine((budget) => budget.consumed <= budget.limit, {
    message: 'Budget consumption cannot exceed its limit.',
  });

/** Durable checkpoint from which a run and workspace projection can resume. */
export const RunSnapshotSchema = z
  .object({
    schemaVersion: z.literal(RUN_PROTOCOL_SCHEMA_VERSION),
    runId: idSchema,
    projectId: idSchema,
    status: RunStatusSchema,
    outcome: RunOutcomeSchema.optional(),
    baseProjectRevision: ProjectRevisionSchema,
    currentProjectRevision: ProjectRevisionSchema,
    lastSequence: sequenceSchema,
    graphVersion: z.number().int().positive(),
    tasks: z.array(TaskSnapshotSchema),
    effects: z.array(EffectSnapshotSchema),
    patchDecisions: z.array(PatchDecisionSchema),
    /** Canonical causal ledger projected from machine-authored `run_state` events. */
    workingState: JsonValueSchema.optional(),
    pendingGate: PendingGateSchema.optional(),
    budgets: z.record(idSchema, BudgetSnapshotSchema).default({}),
    contextHandles: z.array(idSchema).default([]),
    patchPolicy: z.enum(['review', 'auto_commit']).default('review'),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.currentProjectRevision < snapshot.baseProjectRevision) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentProjectRevision'],
        message: 'Current project revision cannot precede the base revision.',
      });
    }
    const terminal = new Set<RunStatus>(['completed', 'failed', 'cancelled']);
    if (terminal.has(snapshot.status) !== (snapshot.outcome !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'Terminal snapshots require an outcome; non-terminal snapshots must omit it.',
      });
    }
  });
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export function parseRunCommand(value: unknown): RunCommandEnvelope {
  return RunCommandEnvelopeSchema.parse(value);
}

export function parseRunEvent(value: unknown): RunEventEnvelope {
  return RunEventEnvelopeSchema.parse(value);
}

export function parseRunSnapshot(value: unknown): RunSnapshot {
  return RunSnapshotSchema.parse(value);
}
