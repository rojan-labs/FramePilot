/**
 * @framepilot/ai-sdk/kernel/plan-driver — the live planned-edit run driver
 * (plan/AGENT-NATIVE-COMPLETION-PLAN.md P3.1, the live planner path's first slice).
 *
 * The planned-edit counterpart to `recipe-executor.ts`: it takes a compiled `TaskGraph`
 * (from `compilePlan`, fed by the live `Planner` proposer) and drives it through the
 * shared {@link runGraph} executor — the same scheduler loop the recipe path already
 * proved live, generalized here with its one new leaf kind: a `model` task. Its one
 * recognised `model` step is `propose_edit` (P3.2, the general EditProposer-class step); its
 * `analysis`/`patch`/`verify` leaves default to `recipe-leaves.ts`'s `RECIPE_LEAVES` (every
 * proven, already-tested deterministic recipe primitive), so a Planner proposal can compose
 * any of these into a novel shape. A task graph naming anything else ends honestly as
 * `unsupported` so the caller (`Orchestrator.streamPlannedEdit`) can fall back to the
 * sequential agent loop rather than fabricate a run.
 *
 * Guardrails applied (plan/AGENT-NATIVE-COMPLETION-PLAN.md P3.1 design notes):
 *  - **No mid-graph replanning** — an invalid/rejected model proposal fails its task
 *    honestly; the driver never mutates the compiled `TaskGraph`.
 *  - **Bounded, local retry** — `propose_edit` gets at most two re-asks on schema/trust
 *    rejections, inside this one task; never a graph-level backtrack.
 *  - **Schema at the trust boundary** — a proposed tool call is validated against the exact
 *    scoped tool registry (`editProposer.parseResponse`); a hallucinated tool is rejected,
 *    never trusted.
 *  - **Transactional patch application** — identical to the recipe path: nothing applies
 *    to the project until the whole run settles into one folded `EditResult`.
 */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { applyProjectPatch, type AnyOperation, validatePatch } from '@framepilot/editor-core';
import type { TurnEmitter } from '../events.js';
import type { AiEvent } from '../events.js';
import { assembleEdit, type EditResult } from '../assemble.js';
import type { AiResponse } from '../providers/types.js';
import { type Sleep, realSleep } from '../reliability/retry.js';
import type { ToolContext } from '../tool-context.js';
import { operationsForCall } from '../tool-dispatch.js';
import { type ToolSpec, getTool } from '../tool-registry.js';
import { type BeatAlignmentResult, alignBeatBackedBoundaries } from './beat-grid/beat-alignment.js';
import { estimateUsd } from './cost/cost-meter.js';
import type { EffectRuntime, ModelEffectResult } from './effect-runtime.js';
import type { ModelEffect } from './effects.js';
import { type TaskRunResult, runGraph, runHostToolTask } from './graph-executor.js';
import { editProposer } from './proposers/edit-proposer.js';
import { recoveryFor } from './recovery/recovery.js';
import {
  RECIPE_LEAVES,
  RecipeLeafError,
  type LeafContext,
  type RecipeLeafRegistry,
  type RecipeTaskOutput,
} from './recipe-leaves.js';
import { type ModelTier } from './proposers/types.js';
import type { SchedulerConfig } from './scheduler.js';
import {
  type AnalysisResultsBag,
  type TimeRange,
  semanticIndexFor,
} from './semantic-index/semantic-index.js';
import {
  type SemanticIndexEntryKind,
  type SemanticIndexSliceQuery,
  getSlice,
} from './semantic-index/semantic-index-slice.js';
import type { TaskId, TaskNode } from './task-graph.js';
import type { TaskGraph } from './task-graph.js';

const log = createLogger('ai-sdk:kernel:plan-driver');

/** Two correction turns cover distinct trust-boundary failures while remaining bounded. */
const MODEL_TASK_MAX_ATTEMPTS = 3;
const PROPOSAL_FEEDBACK_RESPONSE_CHARS = 2_000;
const PROPOSAL_VALIDATION_ISSUE_LIMIT = 8;

/** Re-ask one rejected proposal with the model's actual output and the trust-boundary reason. */
function proposalRepairEffect(
  base: ModelEffect,
  responseText: string,
  reason: string,
): ModelEffect {
  return {
    ...base,
    request: {
      ...base.request,
      messages: [
        ...base.request.messages,
        { role: 'assistant', content: responseText.slice(0, PROPOSAL_FEEDBACK_RESPONSE_CHARS) },
        {
          role: 'user',
          content:
            `That proposal was rejected: ${reason}. Return a corrected JSON proposal for ` +
            'this same mutating step. It must contain at least one grounded, schema-valid ' +
            'call using the supplied tools; do not report success with an empty toolCalls ' +
            'list. When the rejection names a replacement value, copy that value exactly ' +
            'rather than recomputing it, and keep every part of the proposal it did not ' +
            'object to.',
        },
      ],
    },
  };
}

/** Render project-semantic validator failures into bounded, operation-addressable feedback. */
function proposalValidationError(
  project: Project,
  operations: readonly AnyOperation[],
): string | undefined {
  const validation = validatePatch(
    project.timeline,
    { operations },
    {
      assetIds: project.assets.map((asset) => asset.id),
      folders: project.folders,
    },
  );
  if (validation.valid) return undefined;
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  const shown = errors.slice(0, PROPOSAL_VALIDATION_ISSUE_LIMIT).map((issue) => {
    // Unreachable today: every `validatePatch` issue is produced inside a per-operation
    // forEach and always carries `operationIndex` (confirmed by reading every
    // `issues.push` site in editor-core/validator.ts). `operationIndex` is typed optional
    // against a future issue kind that is not tied to one operation; kept as a defensive
    // fallback rather than an assertion so that hypothetical case degrades to an honest
    // label instead of `undefined` leaking into the creator-facing message.
    /* v8 ignore next 4 */
    const location =
      issue.operationIndex === undefined
        ? 'proposal'
        : `operation ${String(issue.operationIndex + 1)}`;
    return `${location}: ${issue.message}`;
  });
  const omitted = errors.length - shown.length;
  return `proposal violates the current project: ${shown.join('; ')}${
    omitted > 0 ? `; plus ${String(omitted)} more error(s)` : ''
  }`;
}

/**
 * A {@link import('./effects.js').ModelEffect} with no explicit tier routes to `mid`
 * (mirrors `effect-runtime.ts`'s `DEFAULT_MODEL_TIER` — the general-composition tier for
 * Planner/EditProposer-class calls).
 */
const DEFAULT_MODEL_TIER: ModelTier = 'mid';

/**
 * Price one model attempt's real usage (P7.1) and fold it into a running total — called
 * on EVERY attempt of a bounded retry loop, not just the winning one: a rejected/retried
 * attempt still burned real tokens against the provider, and that must show up in the
 * task's final `cost`. Never fabricates a number: an attempt with no `usage` on its
 * response (a provider that didn't report real counts) contributes `0`.
 */
function accumulateCost(
  total: { tokens: number; usd: number },
  tier: ModelTier | undefined,
  response: AiResponse,
): { tokens: number; usd: number } {
  const input = response.usage?.inputTokens ?? 0;
  const output = response.usage?.outputTokens ?? 0;
  /* v8 ignore next -- both call sites pass the proposer's tier ('mid'), never undefined; the ?? fallback is defensive. */
  const usd = estimateUsd(tier ?? DEFAULT_MODEL_TIER, { input, output });
  return { tokens: total.tokens + input + output, usd: total.usd + usd };
}

/**
 * Run one `model` effect, retrying a THROWN error (a transient transport/model failure —
 * `model_error`, P7.4) per {@link recoveryFor}'s prescription — the saga recovery table is
 * now the source of truth for THIS decision, replacing what was previously no handling at
 * all (a thrown effect used to crash the whole graph run as an unhandled rejection).
 *
 * This is a SEPARATE, inner retry from the caller's own bounded schema-rejection loop
 * (`MODEL_TASK_MAX_ATTEMPTS`, the `malformed_proposal` case): this one only concerns
 * getting *a* response at all. Each thrown attempt consults `recoveryFor({class:
 * 'model_error', attempt, ...})`; while it prescribes `retry`, this waits its advised
 * backoff and tries again. Once the table prescribes anything else — `fallback_tier` or
 * `fallback_recipe` once `MAX_MODEL_RETRIES` is exhausted — this driver does not yet
 * implement either fallback (a real tier/recipe fallback is a larger capability addition
 * than this task's scope; tracked in plan/AGENT-NATIVE-COMPLETION-PLAN.md P7.4's notes),
 * so it surfaces an honest failure instead of fabricating one.
 */
async function runModelEffectWithRecovery(
  runtime: EffectRuntime,
  effect: ModelEffect,
  signal: AbortSignal | undefined,
  sleep: Sleep,
): Promise<ModelEffectResult> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return (await runtime.run(effect, signal)) as ModelEffectResult;
    } catch (error) {
      const recovery = recoveryFor({
        class: 'model_error',
        attempt,
        hasRecipeFallback: false,
        hasAlternative: false,
      });
      if (recovery.action !== 'retry') {
        const message = error instanceof Error ? error.message : String(error);
        log.error('runModelEffectWithRecovery → giving up', {
          attempt,
          reason: recovery.reason,
          message,
        });
        throw new Error(
          `model call failed after ${String(attempt)} attempt(s) — ${recovery.reason}: ${message}`,
        );
      }
      log.warn('runModelEffectWithRecovery → retrying after model_error', {
        attempt,
        backoffMs: recovery.backoffMs,
      });
      await sleep(recovery.backoffMs, signal);
    }
  }
}

/**
 * Route a FAILED `host_tool` task through the saga recovery table's `tool_failed` rule
 * (plan B5.5) — closing the G9 gap that `recoveryFor` was consulted ONLY for a thrown
 * model call (`model_error`), never for a host/effect-runtime failure.
 *
 * `recoveryFor({class:'tool_failed', hasAlternative})` prescribes `route_around` when a
 * still-viable alternative exists or `fail_subgraph` otherwise (it was the only task). On
 * `route_around` the failure is downgraded to a non-fatal skip — status `completed`, so
 * {@link runGraph} does not terminate the whole run — with its summary annotated so the
 * route-around is visible, not silent. On `fail_subgraph` the task stays `failed` (the run
 * stops) and its summary names the reason. A non-`failed` result (completed / a user
 * `cancelled`) is returned unchanged — cancellation is never "routed around".
 *
 * **A dependant does not force `fail_subgraph` for an ANALYSIS tool.** Every `host_tool` a
 * plan may contain is analysis-kind (the Planner's capability list is filtered to it), and
 * analysis is EVIDENCE: {@link collectAnalysisBag} folds only completed results, so a
 * dependant `propose_edit` simply reasons over a Semantic Index without that evidence
 * rather than over a fabricated one. Requiring no dependants meant the opposite of the
 * intent — the analyses a plan actually builds on are precisely the ones something depends
 * on, so one un-analysable asset (silent footage, an un-indexed clip) discarded the grade,
 * the pacing and every other step and reported "the planned edit could not complete". The
 * failure is still reported; it just no longer condemns the rest of the plan. A mutating or
 * unknown host tool keeps the strict rule: a step that depends on a change that did not
 * happen cannot run honestly.
 */
function recoverHostToolFailure(
  graph: TaskGraph,
  result: TaskRunResult<RecipeTaskOutput>,
): TaskRunResult<RecipeTaskOutput> {
  if (result.status !== 'failed') return result;
  const failedNode = graph.nodes.find((n) => n.id === result.taskId);
  /* v8 ignore next -- the result came from a node of THIS graph, so the lookup always hits. */
  const isAnalysis = getTool(failedNode?.effect.name ?? '')?.kind === 'analysis';
  const hasDependents = graph.nodes.some((n) => n.deps.includes(result.taskId));
  const hasAlternative = (isAnalysis || !hasDependents) && graph.nodes.length > 1;
  const recovery = recoveryFor({ class: 'tool_failed', attempt: 1, hasAlternative });
  /* v8 ignore next -- runHostToolTask always sets a summary on a failed result; the fallback is defensive. */
  const priorSummary = result.output.summary ?? 'host tool failed';
  if (recovery.action === 'route_around') {
    log.warn('recoverHostToolFailure → routing around failed task', {
      taskId: result.taskId,
      reason: recovery.reason,
    });
    // `data` is dropped with the failure: a failed analysis carries the engine's error
    // text there, and `collectAnalysisBag` folds any `data` it finds into the Semantic
    // Index by task name. Keeping it would file an error message as if it were the beat
    // grid — the one thing worse than missing evidence.
    const { data: _discarded, ...output } = result.output;
    return {
      ...result,
      status: 'completed',
      output: { ...output, summary: `${priorSummary} — routed around: ${recovery.reason}` },
    };
  }
  log.error('recoverHostToolFailure → failing subgraph', {
    taskId: result.taskId,
    reason: recovery.reason,
  });
  return {
    ...result,
    output: { ...result.output, summary: `${priorSummary} — ${recovery.reason}` },
  };
}

// --- P4.1/P4.2: fold completed analysis into the Semantic Index for the next model step --

/** `host_tool` effect name → the {@link AnalysisResultsBag} field it feeds (P4.1). */
const ANALYSIS_TASK_BAG_KEY: Readonly<Record<string, keyof AnalysisResultsBag>> = {
  detect_scenes: 'shots',
  analyze_silence: 'silences',
  detect_beats: 'beats',
};

/** One `graph` node whose effect is a task tracked in {@link ANALYSIS_TASK_BAG_KEY}. */
interface AnalysisTaskNode {
  readonly node: TaskNode;
  readonly bagKey: keyof AnalysisResultsBag;
}

/**
 * Every `detect_scenes`/`analyze_silence`/`detect_beats` node in `graph` — the single
 * eligibility filter {@link collectAnalysisBag} and {@link collectEvidenceGaps} both
 * classify against, so a future change to what counts as an analysis task (a new bag
 * key, excluding a tool kind) can't update one and silently miss the other.
 */
function analysisTaskNodes(graph: TaskGraph): readonly AnalysisTaskNode[] {
  const nodes: AnalysisTaskNode[] = [];
  for (const node of graph.nodes) {
    if (node.effect.kind !== 'host_tool') continue;
    const bagKey = ANALYSIS_TASK_BAG_KEY[node.effect.name];
    if (bagKey === undefined) continue;
    nodes.push({ node, bagKey });
  }
  return nodes;
}

/**
 * Fold every analysis task in `graph` that has **already completed** into an
 * {@link AnalysisResultsBag} — real results only; a task that hasn't run yet (or isn't
 * in this graph at all) simply contributes nothing, never a fabricated placeholder.
 * This is what closes the P3.1-era gap: a later model step (`propose_edit`) reasons
 * over the Semantic Index enriched with THIS run's own completed analyses, not just
 * the project-derivable slices.
 */
function collectAnalysisBag(
  graph: TaskGraph,
  upstream: (id: TaskId) => RecipeTaskOutput | undefined,
): AnalysisResultsBag {
  const bag: { -readonly [K in keyof AnalysisResultsBag]?: unknown } = {};
  for (const { node, bagKey } of analysisTaskNodes(graph)) {
    const data = upstream(node.id)?.data;
    if (data !== undefined) bag[bagKey] = data;
  }
  return bag;
}

/**
 * The analyses this plan asked for that produced no evidence.
 *
 * Mirrors {@link collectAnalysisBag}: the bag folds what completed, this names what did
 * not, so the proposer is told the hole exists instead of inferring the world from what
 * happens to be present.
 */
function collectEvidenceGaps(
  graph: TaskGraph,
  upstream: (id: TaskId) => RecipeTaskOutput | undefined,
): { readonly tool: string; readonly detail: string }[] {
  const gaps: { tool: string; detail: string }[] = [];
  for (const { node } of analysisTaskNodes(graph)) {
    const output = upstream(node.id);
    // A node that never ran (its own upstream failed) is as absent as one that failed.
    if (output?.data !== undefined) continue;
    gaps.push({
      tool: node.effect.name,
      detail: output?.summary ?? 'the analysis did not run',
    });
  }
  return gaps;
}

/** Collect every transitive dependency of one task. */
function ancestorTaskIds(graph: TaskGraph, task: TaskNode): ReadonlySet<TaskId> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const ancestors = new Set<TaskId>();
  const pending = [...task.deps];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || ancestors.has(id)) continue;
    ancestors.add(id);
    const dependency = byId.get(id);
    if (dependency) pending.push(...dependency.deps);
  }
  return ancestors;
}

/**
 * Fold every validated ancestor assembly into one deterministic edit for this task.
 * Exact duplicate operations are removed because a later aggregate assembly can contain
 * the same operations as an earlier intermediate assembly.
 */
function ancestorEditForTask(
  graph: TaskGraph,
  task: TaskNode,
  upstream: (id: TaskId) => RecipeTaskOutput | undefined,
  baseProject: Project,
  reason: string,
): EditResult | undefined {
  const ancestors = ancestorTaskIds(graph, task);
  const operations: AnyOperation[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (!ancestors.has(node.id)) continue;
    const edit = upstream(node.id)?.edit;
    if (!edit?.validation.valid) continue;
    for (const operation of edit.patch.operations) {
      const key = JSON.stringify(operation);
      if (seen.has(key)) continue;
      seen.add(key);
      operations.push(operation);
    }
  }
  if (operations.length === 0) return undefined;
  const projection = assembleEdit(baseProject, operations, `${reason} (working projection)`);
  if (!projection.validation.valid) {
    const detail = projection.validation.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message)
      .join('; ');
    throw new Error(`validated ancestor edits could not form a working project: ${detail}`);
  }
  return projection;
}

/**
 * Project validated ancestor assemblies into a task-local working project. The durable
 * project remains untouched; this is an immutable in-run view that lets later analysis and
 * proposal steps see clips created earlier in the same DAG.
 */
function projectForTask(
  graph: TaskGraph,
  task: TaskNode,
  upstream: (id: TaskId) => RecipeTaskOutput | undefined,
  baseProject: Project,
  reason: string,
): Project {
  const projection = ancestorEditForTask(graph, task, upstream, baseProject, reason);
  return projection ? applyProjectPatch(baseProject, projection.patch) : baseProject;
}

const SLICE_KINDS: ReadonlySet<string> = new Set([
  'layers',
  'dialogue',
  'captions',
  'transitions',
  'effects',
  'music',
  'shots',
  'silences',
  'beats',
]);

/** Read a `{ start, end }`-shaped value as a {@link TimeRange}, or `undefined`. */
function readTimeRangeArg(value: unknown): TimeRange | undefined {
  const r = value as { start?: unknown; end?: unknown } | undefined;
  if (typeof r?.start === 'number' && typeof r.end === 'number')
    return { start: r.start, end: r.end };
  return undefined;
}

/**
 * Read an optional `{ timeRange, layerId, kinds }` slice query off a plan step's free-form
 * `args` (all optional; an absent/malformed field just widens to "no restriction" rather
 * than rejecting the step) — lets a Planner-authored step scope what an `propose_edit` task
 * reasons over ("dialogue 12–18s") without a schema change to `PlanStepSpec`.
 */
function sliceQueryFromArgs(
  args: Readonly<Record<string, unknown>> | undefined,
): SemanticIndexSliceQuery {
  const timeRange = readTimeRangeArg(args?.timeRange);
  const layerId = typeof args?.layerId === 'string' ? args.layerId : undefined;
  const rawKinds = Array.isArray(args?.kinds) ? args.kinds : undefined;
  const kinds = rawKinds?.filter(
    (k): k is SemanticIndexEntryKind => typeof k === 'string' && SLICE_KINDS.has(k),
  );
  return {
    ...(timeRange ? { timeRange } : {}),
    ...(layerId ? { layerId } : {}),
    ...(kinds && kinds.length > 0 ? { kinds } : {}),
  };
}

/** Whether `task` has a transitive dependency on one named host analysis. */
function dependsOnHostTool(graph: TaskGraph, task: TaskNode, toolName: string): boolean {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const pending = [...task.deps];
  const visited = new Set<TaskId>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    const dependency = nodes.get(id);
    // Unreachable via any graph this driver runs: `buildTaskGraph` rejects a dep that does
    // not resolve to a node in the SAME graph before this ever walks it, so every id in
    // `pending` (sourced from `.deps` of graph members) is guaranteed present in `nodes`.
    /* v8 ignore next */
    if (!dependency) continue;
    if (dependency.effect.kind === 'host_tool' && dependency.effect.name === toolName) return true;
    pending.push(...dependency.deps);
  }
  return false;
}

/**
 * A beat-analysis-backed montage may only put **interior picture** cut boundaries on the
 * exact mapped onsets supplied by `detect_beats`. This is a deterministic disposal rule, not
 * prompt advice: a near-miss is snapped onto the real onset, and a boundary with no onset
 * nearby is rejected into the existing bounded proposer correction path.
 *
 * The rule itself (which boundaries count, which are exempt, and why) lives in
 * {@link alignBeatBackedBoundaries}; this wrapper only decides whether it applies to this
 * task at all — a step that never analyzed beats is not held to a beat grid.
 */
function beatAlignedOperations(
  graph: TaskGraph,
  task: TaskNode,
  project: Project,
  beatTimes: readonly number[] | undefined,
  rawBeats: unknown,
  operations: readonly AnyOperation[],
): BeatAlignmentResult {
  if (!dependsOnHostTool(graph, task, 'detect_beats')) {
    return { ok: true, operations, snapped: 0 };
  }
  return alignBeatBackedBoundaries(project, operations, beatTimes, rawBeats);
}

// --- the planned-edit run driver ---------------------------------------------------------

/** How a planned-edit run settled — same vocabulary as {@link RecipeRunResult}. */
export type PlannedEditRunStatus = 'completed' | 'empty' | 'failed' | 'cancelled';

/** The distilled outcome of a planned-edit run — the caller turns this into diff/status. */
export interface PlannedEditRunResult {
  readonly status: PlannedEditRunStatus;
  readonly edit?: EditResult;
  /** The compiled plan referenced a task shape this driver does not support (P3.2+). */
  readonly unsupported: boolean;
  /**
   * The run's total priced spend (P7.1), threaded through honestly from
   * {@link GraphRunResult.cost} — a planned edit's `propose_edit` model task prices real
   * usage; every other task in this driver (host-tool/pure leaves) contributes nothing.
   */
  readonly cost: { readonly tokens: number; readonly usd: number };
  /**
   * Which step ended the run, and what it said — present only on `failed`.
   *
   * WHY: a failed planned edit reported one fixed sentence ("The planned edit could not
   * complete"), while the reason the driver already had — "propose_edit: <the proposer's
   * rejection>", a tool's engine error — was dropped on the floor. Nobody could tell a
   * missing argument from a rejected proposal from an engine that was not running, and a
   * `model` task emits no `tool_result` of its own to inspect, so the run's own UI had
   * nothing else to show. The caller renders this into the error the editor actually reads.
   */
  readonly failure?: { readonly taskId: TaskId; readonly label: string; readonly reason: string };
}

/** Everything the driver needs to run one planned edit. */
export interface PlanDriverDeps {
  readonly project: Project;
  readonly runtime: EffectRuntime;
  readonly emit: TurnEmitter;
  readonly reason: string;
  readonly now?: () => number;
  readonly config?: SchedulerConfig;
  /**
   * The pure `analysis`/`patch`/`verify` leaves; defaults to {@link RECIPE_LEAVES} — every
   * proven recipe leaf, so a Planner-authored plan may compose any of them.
   */
  readonly leaves?: RecipeLeafRegistry;
  /**
   * Injectable backoff sleep for {@link runModelEffectWithRecovery}'s `model_error` retry
   * (P7.4); defaults to a real timer. Tests inject a fast/no-op one so a simulated
   * transient failure doesn't actually wait out the recovery table's backoff.
   */
  readonly sleep?: Sleep;
}

/**
 * Run one planned edit's {@link TaskGraph} (compiled by `compilePlan` from a live
 * `Planner` proposal) to completion, yielding the run's lifecycle events and returning
 * its distilled {@link PlannedEditRunResult}.
 */
export async function* executePlannedEdit(
  graph: TaskGraph,
  deps: PlanDriverDeps,
  signal?: AbortSignal,
): AsyncGenerator<AiEvent, PlannedEditRunResult> {
  const now = deps.now ?? Date.now;
  const leaves = deps.leaves ?? RECIPE_LEAVES;
  const sleep = deps.sleep ?? realSleep;
  let runEdit: EditResult | undefined;

  const runHostTool = async (
    task: TaskNode,
    upstream: (id: TaskId) => RecipeTaskOutput | undefined,
  ): Promise<TaskRunResult<RecipeTaskOutput>> => {
    let project: Project;
    try {
      project = projectForTask(graph, task, upstream, deps.project, deps.reason);
    } catch (error) {
      return {
        taskId: task.id,
        events: [],
        /* v8 ignore next -- projectForTask only ever throws an Error, so String(error) is unreachable. */
        output: { summary: error instanceof Error ? error.message : String(error) },
        status: 'failed',
        runtimeMs: 0,
      };
    }
    const result = await runHostToolTask(
      task,
      { runtime: deps.runtime, project, emit: deps.emit, now },
      signal,
    );
    return recoverHostToolFailure(graph, result);
  };

  /**
   * `propose_edit`: the general-purpose model task (P3.2) — realizes ONE plan step by
   * proposing tool calls via the real {@link editProposer}, scoped to `args.toolNames`
   * (restricted to known, available, `mutate`-kind tools; a step needing fresh analysis
   * gets its own upstream `host_tool` task instead — this task never does a host round
   * trip itself). A rejected/invalid proposal gets a bounded correction budget; a hallucinated tool
   * or malformed args is rejected at the registry boundary (`editProposer.parseResponse`
   * validates against the exact scoped `tools`).
   *
   * **Slice (P4.1/P4.2):** the proposer's `slice` is the real Semantic Index Slice for this
   * step — built from `deps.project` enriched with every `detect_scenes`/`analyze_silence`/
   * `detect_beats` task this GRAPH has already completed (not just this task's own deps), so
   * `propose_edit` reasons over "dialogue 12–18s"/"the beat grid" instead of bare counts —
   * plus, when `args.sliceFrom` names an upstream task, that task's raw output threaded in
   * unchanged (P3.2's original mechanism, kept for the exact analysis the step itself asked
   * for). Never fabricated: an analysis that hasn't completed contributes nothing.
   */
  const runProposeEdit = async (
    task: TaskNode,
    upstream: (id: TaskId) => RecipeTaskOutput | undefined,
  ): Promise<TaskRunResult<RecipeTaskOutput>> => {
    const started = now();
    let taskProject: Project;
    try {
      taskProject = projectForTask(graph, task, upstream, deps.project, deps.reason);
    } catch (error) {
      return {
        taskId: task.id,
        events: [],
        /* v8 ignore next -- see the matching guard in runHostTool above: projectForTask only ever throws an Error. */
        output: { summary: error instanceof Error ? error.message : String(error) },
        status: 'failed',
        runtimeMs: now() - started,
      };
    }
    const rawNames = task.effect.args?.toolNames;
    const names = Array.isArray(rawNames) ? rawNames.filter((n) => typeof n === 'string') : [];
    if (names.length === 0) {
      return {
        taskId: task.id,
        events: [],
        output: { summary: 'propose_edit requires a non-empty "toolNames" arg' },
        status: 'failed',
        runtimeMs: now() - started,
      };
    }
    const tools: ToolSpec[] = [];
    for (const name of names) {
      const tool = getTool(name);
      if (!tool || !tool.available || tool.kind !== 'mutate') {
        return {
          taskId: task.id,
          events: [],
          output: { summary: `propose_edit: "${name}" is not a known, available, mutating tool` },
          status: 'failed',
          runtimeMs: now() - started,
        };
      }
      tools.push(tool);
    }
    const sliceFrom = task.effect.args?.sliceFrom;
    const upstreamOutput = typeof sliceFrom === 'string' ? upstream(sliceFrom) : undefined;
    const legacySlice = upstreamOutput?.data ?? upstreamOutput?.value;
    // P4.1/P4.2: fold this run's own completed analyses into the Semantic Index and slice
    // it down to what this step asked for (or the whole project-derived context, absent an
    // explicit query) — real content (dialogue/captions/shots/beats/…), never bare counts.
    const analysisBag = collectAnalysisBag(graph, upstream);
    const semanticIndex = semanticIndexFor(taskProject, analysisBag);
    const semanticSlice = getSlice(semanticIndex, sliceQueryFromArgs(task.effect.args));
    const slice =
      legacySlice !== undefined
        ? { upstream: legacySlice, semanticIndex: semanticSlice }
        : semanticSlice;
    const identities = {
      assets: taskProject.assets.map((asset) => ({
        assetId: asset.id,
        kind: asset.kind,
        ...(asset.durationSeconds === undefined ? {} : { durationSeconds: asset.durationSeconds }),
      })),
      tracks: taskProject.timeline.tracks.map((track) => ({
        trackId: track.id,
        type: track.type,
      })),
      clips: taskProject.timeline.tracks.flatMap((track) =>
        track.clips.map((clip) => ({
          clipId: clip.id,
          assetId: clip.assetId,
          trackId: track.id,
          start: clip.start,
          end: clip.end,
        })),
      ),
    };
    const evidenceGaps = collectEvidenceGaps(graph, upstream);
    if (evidenceGaps.length > 0) {
      log.warn('runProposeEdit → proposing with missing evidence', {
        taskId: task.id,
        missing: evidenceGaps.map((gap) => gap.tool),
      });
    }
    const effect = editProposer.buildRequest({
      step: task,
      slice,
      identities,
      tools,
      ...(evidenceGaps.length === 0 ? {} : { evidenceGaps }),
    });
    let attemptEffect = effect;
    log.action('runProposeEdit → task started', {
      taskId: task.id,
      scopedTools: tools.map((t) => t.name),
    });

    let lastError = 'no attempt made';
    let cost = { tokens: 0, usd: 0 };
    for (let attempt = 1; attempt <= MODEL_TASK_MAX_ATTEMPTS; attempt += 1) {
      let response: AiResponse;
      try {
        // A thrown effect (transient transport/model failure) is retried per the saga
        // recovery table (P7.4) — a SEPARATE, inner concern from this loop's own bounded
        // schema-rejection retry below.
        ({ response } = await runModelEffectWithRecovery(
          deps.runtime,
          attemptEffect,
          signal,
          sleep,
        ));
      } catch (error) {
        /* v8 ignore next -- runModelEffectWithRecovery only ever throws an Error (it wraps non-Errors into one), so the String(error) branch is unreachable. */
        lastError = error instanceof Error ? error.message : String(error);
        break;
      }
      // Every attempt burned real tokens (P7.1) — accumulate even a rejected one, not
      // just the winning attempt.
      cost = accumulateCost(cost, effect.tier, response);
      const parsed = editProposer.parseResponse(response.text, tools);
      if (parsed.ok && parsed.value.length === 0) {
        lastError = 'proposal returned no tool calls for this mutating step';
      } else if (parsed.ok) {
        const ctx: ToolContext = { project: taskProject };
        try {
          const operations = parsed.value.flatMap((call) => operationsForCall(call, ctx));
          /* v8 ignore next 3 -- unreachable today: `tools` here is scoped to mutate-kind tools only (checked above), `parsed.value` is non-empty (checked above), and every registered mutate tool's `buildOps` yields at least one operation for schema-valid args — confirmed by reading every tool-registry.ts buildOps body. Kept as an honest failure message rather than an assertion in case a future tool's buildOps legitimately produces zero ops for some valid input. */
          if (operations.length === 0) {
            lastError = 'proposal produced no timeline operations for this mutating step';
          } else {
            // Beat alignment runs BEFORE the project validator because it may snap a
            // near-miss boundary: the validator must see the operations that would actually
            // be applied, not the pre-snap ones.
            const aligned = beatAlignedOperations(
              graph,
              task,
              taskProject,
              semanticSlice.beats?.times,
              analysisBag.beats,
              operations,
            );
            const semanticError = aligned.ok
              ? proposalValidationError(taskProject, aligned.operations)
              : aligned.error;
            if (semanticError) {
              lastError = semanticError;
            } else {
              /* v8 ignore next -- aligned.ok is true on this branch (a rejection became semanticError above); the guard only narrows the union for the compiler. */
              const finalOperations = aligned.ok ? aligned.operations : operations;
              /* v8 ignore next -- same aligned.ok narrowing as above; always true here. */
              const snappedToBeats = aligned.ok ? aligned.snapped : 0;
              log.action('runProposeEdit ← completed', {
                taskId: task.id,
                operations: finalOperations.length,
                attempt,
                snappedToBeats,
              });
              return {
                taskId: task.id,
                events: [],
                output: {
                  operations: finalOperations,
                  // Beat snapping is a CRAFT decision, not a mechanic: the cuts the editor
                  // asked for were moved onto real onsets. It was being logged and thrown
                  // away, so the one person who would care never saw it.
                  summary:
                    snappedToBeats > 0
                      ? `Proposed ${String(finalOperations.length)} operation(s), ${String(snappedToBeats)} cut${snappedToBeats === 1 ? '' : 's'} snapped onto the beat`
                      : `Proposed ${String(finalOperations.length)} operation(s)`,
                },
                status: 'completed',
                runtimeMs: now() - started,
                cost,
              };
            }
          }
          /* v8 ignore start -- defense in depth: `editProposer.parseResponse` already ran
           each call's args through `tool.parse` (the same registry `operationsForCall`
           consumes), so a call that passed validation cannot fail `operationsForCall`'s
           own parse today. Kept as a per-attempt honest failure (eligible for the same
           bounded retry as a rejected proposal) in case a tool's `buildOps` ever grows a
           semantic check `parse` doesn't express. */
          // Any Error reports its own `message`: a raw `String(error)` prefixed the text
          // with "Error: ", which then surfaced verbatim in the editor's failure banner.
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        /* v8 ignore stop */
      } else {
        lastError = parsed.error;
      }
      log.warn('runProposeEdit → attempt rejected', { taskId: task.id, attempt, error: lastError });
      if (attempt < MODEL_TASK_MAX_ATTEMPTS) {
        attemptEffect = proposalRepairEffect(effect, response.text, lastError);
      }
    }
    let priorEdit: EditResult | undefined;
    try {
      /* v8 ignore next 4 -- unreachable: `ancestorEditForTask` is pure over (graph, task, upstream, deps.project, deps.reason) — the exact same arguments `projectForTask` already passed it to compute `taskProject` above. If that combination were unable to combine, THAT call already threw and returned this task as failed before the retry loop ever ran, so this second call (same inputs) cannot throw here without having thrown there first. Kept as a defensive pairing rather than an assertion, in case the two call sites' arguments ever drift apart. */
      priorEdit = ancestorEditForTask(graph, task, upstream, deps.project, deps.reason);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const ancestors = ancestorTaskIds(graph, task);
    const hasVerifiedCheckpoint = graph.nodes.some(
      (node) => ancestors.has(node.id) && upstream(node.id)?.verdict?.ok === true,
    );
    if (priorEdit?.validation.valid && hasVerifiedCheckpoint) {
      const summary =
        `Skipped refinement after ${String(MODEL_TASK_MAX_ATTEMPTS)} rejected proposal attempts: ` +
        `${lastError}. Preserving the validated earlier edit.`;
      log.warn('runProposeEdit ← refinement skipped', { taskId: task.id, error: lastError });
      return {
        taskId: task.id,
        events: [
          deps.emit.notification(summary, {
            reason: 'refinement_skipped',
            detail: `Task: ${task.label}`,
          }),
        ],
        output: { operations: [], summary },
        status: 'warning',
        runtimeMs: now() - started,
        cost,
      };
    }
    log.error('runProposeEdit ← failed', { taskId: task.id, error: lastError });
    return {
      taskId: task.id,
      events: [],
      output: { summary: `propose_edit: ${lastError}` },
      status: 'failed',
      runtimeMs: now() - started,
      cost,
    };
  };

  const runLeaf = (
    task: TaskNode,
    upstream: (id: TaskId) => RecipeTaskOutput | undefined,
  ): TaskRunResult<RecipeTaskOutput> => {
    const started = now();
    const leaf = leaves[task.effect.name];
    if (!leaf) {
      return {
        taskId: task.id,
        events: [],
        output: { unsupported: true },
        status: 'failed',
        runtimeMs: now() - started,
      };
    }
    try {
      const leafProject =
        task.effect.kind === 'analysis'
          ? projectForTask(graph, task, upstream, deps.project, deps.reason)
          : deps.project;
      const ancestorEdit = ancestorEditForTask(graph, task, upstream, deps.project, deps.reason);
      const editToVerify = ancestorEdit ?? runEdit;
      const ctx: LeafContext = {
        project: leafProject,
        args: task.effect.args ?? {},
        reason: deps.reason,
        ...(editToVerify ? { runEdit: editToVerify } : {}),
        upstream,
      };
      const output = leaf(ctx);
      const patchInvalid = output.edit !== undefined && !output.edit.validation.valid;
      const verdictFailed = output.verdict !== undefined && !output.verdict.ok;
      if (output.edit) runEdit = output.edit;
      return {
        taskId: task.id,
        events: [],
        output,
        status: patchInvalid || verdictFailed ? 'failed' : 'completed',
        runtimeMs: now() - started,
      };
    } catch (error) {
      const message = error instanceof RecipeLeafError ? error.message : String(error);
      return {
        taskId: task.id,
        events: [],
        output: { summary: message },
        status: 'failed',
        runtimeMs: now() - started,
      };
    }
  };

  // The step that ends the run, kept for the caller's error text — `runGraph` reports only
  // that the run failed, and a `model` task emits no `tool_result` anyone could read the
  // reason off. Recorded once: the FIRST failure is the cause; later ones are consequences.
  let failure: PlannedEditRunResult['failure'];
  const recordFailure = (task: TaskNode, r: TaskRunResult<RecipeTaskOutput>) => {
    if (r.status !== 'failed' || failure !== undefined) return r;
    failure = {
      taskId: r.taskId,
      label: task.label,
      reason: r.output.summary ?? `${task.effect.kind}/${task.effect.name} failed`,
    };
    return r;
  };

  const runTask = async (
    task: TaskNode,
    upstream: (id: TaskId) => RecipeTaskOutput | undefined,
  ): Promise<TaskRunResult<RecipeTaskOutput>> => {
    if (task.effect.kind === 'host_tool') {
      return recordFailure(task, await runHostTool(task, upstream));
    }
    if (task.effect.kind === 'model' && task.effect.name === 'propose_edit') {
      return recordFailure(task, await runProposeEdit(task, upstream));
    }
    if (task.effect.kind === 'model') {
      // A model step this driver doesn't recognise yet — honest degrade, never a
      // fabricated proposal.
      return recordFailure(task, {
        taskId: task.id,
        events: [],
        output: {
          unsupported: true,
          summary: `this run cannot execute a "${task.effect.name}" model step`,
        },
        status: 'failed',
        runtimeMs: 0,
      });
    }
    return recordFailure(task, runLeaf(task, upstream));
  };

  const result = yield* runGraph(graph, {
    emit: deps.emit,
    ...(deps.config ? { config: deps.config } : {}),
    runTask,
  });

  let unsupported = false;
  for (const output of result.outputs.values()) {
    if (output.edit) runEdit = output.edit;
    if (output.unsupported) unsupported = true;
  }

  if (result.terminal === 'cancelled') {
    return { status: 'cancelled', unsupported, cost: result.cost };
  }
  if (result.terminal === 'failed') {
    /* v8 ignore next -- a `failed` terminal always came from a recorded task failure; the guard keeps the field exact-optional rather than `undefined`. */
    return { status: 'failed', unsupported, cost: result.cost, ...(failure ? { failure } : {}) };
  }
  if (runEdit && runEdit.validation.valid) {
    const summary = runEdit.diff!.summary;
    const changed = !(summary.length === 1 && summary[0] === 'no changes');
    return {
      status: changed ? 'completed' : 'empty',
      edit: runEdit,
      unsupported,
      cost: result.cost,
    };
  }
  return { status: 'completed', unsupported, cost: result.cost };
}
