/**
 * @framepilot/ai-sdk/specialists — one typed contract for every bounded specialist
 * (plan/system-mission/05-WORKERS-AND-LIFECYCLE.md P5.1).
 *
 * A **specialist** here is what Phase 5's decision rule means by "worker": a step with its
 * own bounded context and a typed contract, not necessarily its own process. The domain
 * controllers (`src/controllers/*`) and the Critic proposer (`kernel/proposers/critic.ts`)
 * are already exactly that in behaviour — pure functions from a slice of host state to a
 * set of editor commands or findings — but each one declared its own ad-hoc input and
 * result shape, and each call site hand-assembled the slice. Two things went unenforced:
 *
 *  1. **What a specialist may read.** A controller's input was built by hand from the
 *     whole {@link ToolContext}, so nothing but review stopped a new field being threaded
 *     in "just for this one case". The slice is now *declared* and the envelope is
 *     `.strict()`, so an undeclared field is a validation error, not a habit.
 *  2. **What a specialist returns.** Six result unions said the same four things —
 *     commands, evidence, facts, a rejection code — in six shapes.
 *
 * So: `SpecialistInput { task, context, constraints, inputs }` →
 * `SpecialistOutput { outputs, artifacts, confidence, errors }`, zod-validated on the way
 * in and on the way out.
 *
 * ## What is deliberately NOT re-validated
 *
 * `context.project` is a `Project` the host already parsed through
 * `@framepilot/timeline-schema`, and `context.interaction` was built by
 * `captureEditorInteractionContext`, which validates its own clocks and marks. Re-running
 * a deep schema parse on a minutes-long timeline at every tool call would cost real time
 * to re-derive a guarantee the boundary above already gives. The envelope checks
 * *identity and shape* — which keys are present, that each is the right kind of thing —
 * and leaves the deep contracts to the schemas that own them.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import type { ColorEvidenceReader } from '../color-evidence.js';
import type { EditorInteractionContext } from '../editor-context/interaction-context.js';
import type { ToolContext } from '../tool-context.js';

const log = createLogger('ai-sdk:specialists');

/**
 * Every field of host state a specialist is allowed to name in its slice.
 *
 * This is the whole vocabulary: a specialist that needs something not on this list is
 * asking for a capability the sandbox does not grant it (`tool-context.ts`), and the fix
 * is a decision about the sandbox, not a new field quietly threaded through a controller.
 */
export const SPECIALIST_CONTEXT_KEYS = [
  'project',
  'projectRevision',
  'interaction',
  'evidence',
] as const;

export type SpecialistContextKey = (typeof SPECIALIST_CONTEXT_KEYS)[number];

/** The host state a specialist may be handed, before its slice narrows it. */
export interface SpecialistContext {
  readonly project: Project;
  readonly projectRevision?: number;
  readonly interaction?: EditorInteractionContext;
  readonly evidence?: ColorEvidenceReader;
}

const isObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The full context envelope. `.strict()` is the point of the whole file: a key nobody
 * declared is rejected rather than silently carried.
 */
const SpecialistContextSchema = z
  .object({
    project: z.custom<Project>(isObject, { message: 'project must be a Project object' }),
    projectRevision: z.number().int().nonnegative().optional(),
    interaction: z
      .custom<EditorInteractionContext>(isObject, {
        message: 'interaction must be an EditorInteractionContext',
      })
      .optional(),
    evidence: z
      .custom<ColorEvidenceReader>(isObject, { message: 'evidence must be a reader object' })
      .optional(),
  })
  .strict();

/**
 * Bounds the caller imposes on the step, kept separate from `inputs` because they come
 * from a different authority: `inputs` is what the model asked for, `constraints` is what
 * the host will allow. Open by design — a specialist reads the keys it knows.
 */
export const SpecialistConstraintsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export type SpecialistConstraints = z.infer<typeof SpecialistConstraintsSchema>;

/** One thing a specialist produced besides its primary output: evidence, or a fact. */
export interface SpecialistArtifact {
  readonly kind: 'evidence' | 'fact';
  readonly name: string;
  readonly value: string | number | boolean;
}

const SpecialistArtifactSchema = z
  .object({
    kind: z.enum(['evidence', 'fact']),
    name: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict();

/** Why a specialist could not do what it was asked. `code` is the controller's own code. */
export interface SpecialistError {
  readonly code: string;
  readonly detail: string;
}

const SpecialistErrorSchema = z.object({ code: z.string().min(1), detail: z.string() }).strict();

/** The one input shape (P5.1). */
export interface SpecialistInput<Inputs> {
  /** What this specialist is being asked to do — the tool or objective name. */
  readonly task: string;
  /** The declared slice of host state, and nothing else. */
  readonly context: SpecialistContext;
  /** Host-imposed bounds, distinct from the model-supplied `inputs`. */
  readonly constraints: SpecialistConstraints;
  /** The model-supplied, already-parsed objective. */
  readonly inputs: Inputs;
}

/** The one output shape (P5.1). */
export interface SpecialistOutput<Outputs> {
  readonly outputs: Outputs;
  readonly artifacts: readonly SpecialistArtifact[];
  /**
   * How much the specialist stands behind `outputs`, 0–1.
   *
   * The domain controllers are deterministic — they resolve a target from authoritative
   * editor state or they refuse — so in practice this is 1 (resolved) or 0 (rejected),
   * and it says so honestly rather than manufacturing a spread. It is a number and not a
   * boolean because the Critic's verdict genuinely is graded (share of checks that held),
   * and one shape that cannot express that would just push the Critic back out of it.
   */
  readonly confidence: number;
  readonly errors: readonly SpecialistError[];
}

const SpecialistOutputSchema = z
  .object({
    outputs: z.unknown(),
    artifacts: z.array(SpecialistArtifactSchema),
    confidence: z.number().min(0).max(1),
    errors: z.array(SpecialistErrorSchema),
  })
  .strict();

/** A specialist: a name, the host state it declares it reads, and a pure function. */
export interface Specialist<Inputs, Outputs> {
  readonly name: string;
  /** The ONLY host-state keys this specialist's input may carry. */
  readonly slice: readonly SpecialistContextKey[];
  readonly run: (input: SpecialistInput<Inputs>) => SpecialistOutput<Outputs>;
  /** The per-specialist strict input schema, exposed for tests and for `runSpecialist`. */
  readonly inputSchema: z.ZodType;
}

/** Build the strict envelope schema for one specialist's declared slice. */
function inputSchemaFor(slice: readonly SpecialistContextKey[]): z.ZodType {
  const mask = Object.fromEntries(slice.map((key) => [key, true as const]));
  return z
    .object({
      task: z.string().min(1),
      // `.pick` keeps the parent's `.strict()`, so a key outside the slice fails here.
      context: SpecialistContextSchema.pick(mask as never),
      constraints: SpecialistConstraintsSchema,
      inputs: z.unknown(),
    })
    .strict();
}

/** Declare a specialist and its slice. Pure; performs no work until {@link runSpecialist}. */
export function defineSpecialist<Inputs, Outputs>(definition: {
  readonly name: string;
  readonly slice: readonly SpecialistContextKey[];
  readonly run: (input: SpecialistInput<Inputs>) => SpecialistOutput<Outputs>;
}): Specialist<Inputs, Outputs> {
  return { ...definition, inputSchema: inputSchemaFor(definition.slice) };
}

/**
 * Project a {@link ToolContext} down to one specialist's declared slice.
 *
 * This is the half of P5.1 that changes behaviour rather than types: a call site can no
 * longer hand a controller "the context", because it never sees the context — it names a
 * specialist and gets exactly what that specialist declared. An optional key the host did
 * not supply is omitted rather than set to `undefined`, so the envelope's `.strict()`
 * check and `exactOptionalPropertyTypes` agree.
 */
export function sliceOf(
  specialist: { readonly slice: readonly SpecialistContextKey[] },
  ctx: Pick<ToolContext, SpecialistContextKey>,
): SpecialistContext {
  const picked: Record<string, unknown> = {};
  for (const key of specialist.slice) {
    const value = ctx[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked as unknown as SpecialistContext;
}

/** Thrown when a specialist is called with an input its contract refuses. */
export class SpecialistContractError extends Error {
  public constructor(specialist: string, phase: 'input' | 'output', detail: string) {
    super(`${specialist} specialist ${phase} violated its contract: ${detail}`);
    this.name = 'SpecialistContractError';
  }
}

function describe(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'unknown validation failure';
  const where = first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
  return `${first.message}${where}`;
}

/**
 * Call a specialist through its contract: validate the input envelope, run, validate the
 * output envelope. Both directions, because a contract enforced in one direction only is
 * a type annotation.
 */
export function runSpecialist<Inputs, Outputs>(
  specialist: Specialist<Inputs, Outputs>,
  input: SpecialistInput<Inputs>,
): SpecialistOutput<Outputs> {
  const parsedInput = specialist.inputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new SpecialistContractError(specialist.name, 'input', describe(parsedInput.error));
  }
  const output = specialist.run(input);
  const parsedOutput = SpecialistOutputSchema.safeParse(output);
  if (!parsedOutput.success) {
    throw new SpecialistContractError(specialist.name, 'output', describe(parsedOutput.error));
  }
  log.debug('specialist settled', {
    specialist: specialist.name,
    task: input.task,
    confidence: output.confidence,
    errors: output.errors.length,
  });
  return output;
}
