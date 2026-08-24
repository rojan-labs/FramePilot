/**
 * @framepilot/ai-sdk/kernel/effects — effects as DATA
 * (plan/AI-ORCHESTRATION-REDESIGN.md §7 tenet 5, Phase K0.1).
 *
 * The control plane never performs I/O directly; it emits {@link EffectDescription}s
 * — inert descriptions of work — which an effect runtime later interprets. Deciding
 * an effect and running it are different layers (Elm/Effect-TS discipline). This is
 * what makes the kernel a pure function of its inputs and makes runs replayable.
 *
 * K0.1 introduces the effect boundary with a SINGLE, deliberately coarse effect:
 * {@link AgentEffect} wraps *today's* whole streaming orchestration run (any mode)
 * as one opaque unit of work — the honest strangler-fig starting point. It changes
 * no behavior: the effect runs the existing `Orchestrator.stream*` methods and
 * yields the existing {@link AiEvent}s. Later phases (K0.3, K1, K3) split this coarse
 * effect into fine-grained `ModelEffect` / `HostToolEffect` / `AnalysisEffect` /
 * `PatchEffect` handled by a real scheduler — but the boundary TYPE lands now.
 */
import type { Project } from '@framepilot/timeline-schema';
import type { AiMode, StreamOptions } from '../orchestrator.js';
import type { ContextInput } from '../context-builder.js';
import type { AgentOptions } from '../agent.js';
import type { AiCompletionRequest, ToolCall } from '../providers/types.js';
import type { Command } from './commands.js';
import type { ModelTier } from './proposers/types.js';
import type { JsonValue, ProjectRevision } from '../run-contracts.js';
import type { AnalysisBudget } from './cost/analysis-caps.js';
import type { EditorInteractionContext } from '../editor-context/interaction-context.js';

export type EffectResourceClass =
  | 'model'
  | 'cpu'
  | 'gpu'
  | 'ffmpeg'
  | 'sidecar'
  | 'project_commit'
  | 'persistence'
  | 'user';

export type EffectRetryClass =
  | 'never'
  | 'transient'
  | 'rate_limited'
  | 'repair_once'
  | 'revision_conflict';

export type EffectSideEffectClass = 'pure' | 'idempotent' | 'commit';

/** Scheduling, recovery, and audit controls shared by production effects. */
export interface EffectControl {
  readonly effectId: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly resourceClass: EffectResourceClass;
  readonly timeoutMs: number;
  readonly retryClass: EffectRetryClass;
  readonly cancellationParentId?: string;
  readonly sideEffectClass: EffectSideEffectClass;
  readonly expectedProjectRevision?: ProjectRevision;
}

/**
 * Run the existing streaming orchestration loop for one turn as one opaque effect.
 *
 * Named `agent` after the plan's K0.1 milestone ("wrap today's streamAgent as a
 * single AgentEffect"), but it faithfully wraps *every* streaming mode — chat, plan,
 * edit, and agent — because in K0 they share one execution path (the orchestrator).
 * The runtime dispatches it by calling the matching `Orchestrator.stream*` method.
 */
export interface AgentEffect {
  readonly kind: 'agent';
  readonly mode: AiMode;
  readonly input: ContextInput;
  readonly stream: StreamOptions;
  readonly agentOptions?: AgentOptions;
}

/**
 * Run one analysis/action tool call on the host (engine sidecar) — the
 * fine-grained effect the {@link EffectRuntime} interprets (Phase K0.3). The
 * proposer only *proposes* the {@link ToolCall}; the kernel schedules it as this
 * effect and the runtime executes/dedups/retries it (§10: "the model proposes,
 * the runtime disposes"). Idempotent by construction — a deterministic analysis
 * re-requested with the same args is served from the runtime's memo.
 */
export interface HostToolEffect {
  readonly kind: 'host_tool';
  readonly call: ToolCall;
  /** The working project the analysis must reflect (the run's in-flight edits). */
  readonly project: Project;
  /**
   * The editor's live selection snapshot, when the driving surface has one.
   * Host tools that resolve "the selected clip" need this for the same reason
   * mutate tools do — the model must not infer what the user pointed at.
   */
  readonly interaction?: EditorInteractionContext;
  /** The run-scoped compute ceiling enforced by the host executor. */
  readonly analysisBudget?: AnalysisBudget;
  /**
   * Optional explicit idempotency key; when omitted the runtime derives one from
   * the call name + arguments (generalizing today's per-run `hostCache` key).
   */
  readonly idempotencyKey?: string;
}

/**
 * Perform one model completion (Phase K0.3). Wraps a provider call as data so the
 * runtime — not the control plane — owns the network I/O, retry, and (when a key is
 * supplied) dedup. Model calls are non-deterministic, so they are deduped only when
 * the effect declares an explicit {@link ModelEffect.idempotencyKey}.
 */
export interface ModelEffect {
  readonly kind: 'model';
  readonly request: AiCompletionRequest;
  readonly idempotencyKey?: string;
  /**
   * The model-tier this call routes to (§6 roster; `proposers/types.ts`). Stamped by
   * whichever proposer built the request (its own declared {@link ModelProposer.tier})
   * so the {@link EffectRuntime} — not the control plane — resolves it to a concrete
   * provider (Phase P3.4 "Model-tier routing, live"). Omitted for the coarse `AgentEffect`
   * wrapper's turns (chat/edit/agent), which are not yet tier-routed; the runtime treats
   * an absent tier as `mid`.
   */
  readonly tier?: ModelTier;
}

/** One incrementally delivered model request owned by the Effect Runtime. */
export interface ModelStreamEffect {
  readonly kind: 'model_stream';
  readonly request: AiCompletionRequest;
  readonly tier?: ModelTier;
}

export interface HostAnalysisEffect {
  readonly kind: 'host_analysis';
  readonly control: EffectControl;
  readonly analysis: string;
  readonly input: JsonValue;
  readonly projectId: string;
}

export interface DeterministicTransformEffect {
  readonly kind: 'deterministic_transform';
  readonly control: EffectControl;
  readonly transform: string;
  readonly input: JsonValue;
}

export interface PatchValidateEffect {
  readonly kind: 'patch_validate';
  readonly control: EffectControl;
  readonly projectId: string;
  readonly patch: JsonValue;
}

export interface PatchProposeEffect {
  readonly kind: 'patch_propose';
  readonly control: EffectControl;
  readonly projectId: string;
  readonly patch: JsonValue;
  readonly rationale?: string;
}

export interface PatchCommitEffect {
  readonly kind: 'patch_commit';
  readonly control: EffectControl;
  readonly projectId: string;
  readonly patchId: string;
}

export interface RenderEffect {
  readonly kind: 'render';
  readonly control: EffectControl;
  readonly projectId: string;
  readonly preset?: string;
  readonly preview: boolean;
}

export interface VerificationEffect {
  readonly kind: 'verification';
  readonly control: EffectControl;
  readonly verification: string;
  readonly input: JsonValue;
}

export interface UserWaitEffect {
  readonly kind: 'user_wait';
  readonly control: EffectControl;
  readonly gateKind: 'plan_approval' | 'question' | 'patch_review';
  readonly gateId: string;
  readonly payload: JsonValue;
  readonly expiresAt?: number;
}

export interface PersistenceEffect {
  readonly kind: 'persistence';
  readonly control: EffectControl;
  readonly operation: 'append_event' | 'save_snapshot' | 'save_artifact' | 'archive_run';
  readonly payload: JsonValue;
}

/**
 * The kernel's effect union. `AgentEffect` is the coarse K0 wrapper of the whole
 * streaming loop; `HostToolEffect`/`ModelEffect` are the fine-grained effects the
 * {@link EffectRuntime} interprets. Future phases add `AnalysisEffect`/`PatchEffect`.
 */
export type EffectDescription =
  | AgentEffect
  | HostToolEffect
  | ModelEffect
  | HostAnalysisEffect
  | DeterministicTransformEffect
  | PatchValidateEffect
  | PatchProposeEffect
  | PatchCommitEffect
  | RenderEffect
  | VerificationEffect
  | UserWaitEffect
  | PersistenceEffect;

/** The fine-grained effects the {@link EffectRuntime} executes (excludes the coarse wrapper). */
export type StructuredRuntimeEffect = Exclude<
  EffectDescription,
  AgentEffect | HostToolEffect | ModelEffect
>;

export type RuntimeEffect =
  | HostToolEffect
  | ModelEffect
  | ModelStreamEffect
  | StructuredRuntimeEffect;

/** Effects whose result is delivered as one promise rather than a chunk stream. */
export type NonStreamingRuntimeEffect = Exclude<RuntimeEffect, ModelStreamEffect>;

/**
 * Compile a {@link Command} into the effect(s) that satisfy it. Pure: no I/O, no
 * clock, no randomness — the same command always compiles to the same effect
 * description, which is what makes the control plane table-testable and runs
 * replayable (design tenet 6).
 *
 * In K0 the mapping is 1:1 — a `submit_turn` becomes one {@link AgentEffect} — but
 * expressing it as `compile()` (rather than inlining the dispatch) is the point:
 * it establishes the Command → EffectDescription boundary the Conductor will own.
 */
export function compileCommand(command: Command): readonly EffectDescription[] {
  switch (command.kind) {
    case 'submit_turn':
      return [
        {
          kind: 'agent',
          mode: command.mode,
          input: command.input,
          stream: command.stream,
          ...(command.agentOptions !== undefined ? { agentOptions: command.agentOptions } : {}),
        },
      ];
  }
}
