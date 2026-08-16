/**
 * @framepilot/ai-sdk/kernel/plan-compiler — Intent → Task DAG
 * (plan/AI-ORCHESTRATION-REDESIGN.md §8.1, Phase K3.1).
 *
 * Turns a {@link ProposedPlan} from the **Planner** proposer into a validated
 * {@link TaskGraph} via {@link buildTaskGraph}. There is exactly one execution path
 * downstream — scheduler, runtime, verify.
 *
 * This module also used to compile a second input shape: a deterministic **recipe**
 * (`remove_silence`, `add_captions`, …) that synthesized the same plan with zero model
 * calls. That path is gone — the model classifier reads the whole request and the agent
 * loop executes it, so a fixed parameterised template was a second, weaker way to do the
 * same job, and its "no changes, no AI needed" outcome on a request it only partly
 * matched was the most common way a run silently did nothing.
 */
import { createLogger } from '@framepilot/shared-types';
import {
  type ResourceClass,
  type TaskEffectSpec,
  type TaskGraph,
  type TaskId,
  type TaskNode,
  type TaskPriority,
  TaskGraphError,
  buildTaskGraph,
} from './task-graph.js';

const log = createLogger('ai-sdk:kernel:plan-compiler');

/**
 * One step of a {@link ProposedPlan}. Mirrors the Planner's output schema (§6:
 * `{op-kind, target, deps}`) plus the scheduling hints the compiler defaults. `id` is
 * optional — when omitted the compiler assigns `T1`, `T2`, … in order, and `deps`
 * reference those ids (or any explicit `id` a step declares).
 */
export interface PlanStepSpec {
  readonly id?: TaskId;
  readonly label: string;
  readonly effect: TaskEffectSpec;
  /** Resource pool; defaults by effect kind (see {@link DEFAULT_RESOURCE}). */
  readonly resource?: ResourceClass;
  /** Scheduling priority; defaults to `edit` (user-visible work). */
  readonly priority?: TaskPriority;
  /** Ids of upstream steps this one waits on. */
  readonly deps?: readonly TaskId[];
}

/** A plan as proposed (by the Planner) or synthesized (by a recipe) before compilation. */
export interface ProposedPlan {
  readonly steps: readonly PlanStepSpec[];
}

/** Default resource class per effect kind. ffmpeg/network work is declared explicitly
 *  by the step (e.g. an `analyze_silence` host tool sets `resource: 'ffmpeg'`). */
const DEFAULT_RESOURCE: Readonly<Record<TaskEffectSpec['kind'], ResourceClass>> = {
  host_tool: 'host',
  model: 'model',
  analysis: 'pure',
  patch: 'pure',
  verify: 'pure',
};

/**
 * Compile a {@link ProposedPlan} into a validated {@link TaskGraph}. Assigns ids to
 * steps that omit one (`T{n}` in order), fills the resource/priority defaults, and
 * delegates the DAG invariants (unique ids, resolvable deps, acyclic) to
 * {@link buildTaskGraph} — so a malformed plan (a dangling dep, a cycle) is rejected
 * with a specific error instead of deadlocking the scheduler.
 *
 * @throws {import('./task-graph.js').TaskGraphError} on an invalid graph.
 */
export function compilePlan(plan: ProposedPlan): TaskGraph {
  const proposedNodes: TaskNode[] = plan.steps.map((step, i) => {
    const deps = step.deps ?? [];
    return {
      id: step.id ?? `T${i + 1}`,
      label: step.label,
      effect: bindPureLeafUpstream(step.effect, deps, step.id ?? `T${i + 1}`),
      resource: step.resource ?? DEFAULT_RESOURCE[step.effect.kind],
      priority: step.priority ?? 'edit',
      deps,
    };
  });
  const nodes = closeModelMutationLifecycle(proposedNodes);
  const graph = buildTaskGraph(nodes);
  log.action('compilePlan → compiled', { nodes: graph.nodes.length });
  return graph;
}

/** True when `task` transitively waits on `ancestorId`. */
function dependsOn(nodes: readonly TaskNode[], task: TaskNode, ancestorId: TaskId): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pending = [...task.deps];
  const visited = new Set<TaskId>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || visited.has(id)) continue;
    if (id === ancestorId) return true;
    visited.add(id);
    const dependency = byId.get(id);
    if (dependency) pending.push(...dependency.deps);
  }
  return false;
}

/** Allocate a deterministic compiler-owned id without colliding with model-authored ids. */
function generatedTaskId(nodes: readonly TaskNode[], stem: string): TaskId {
  const ids = new Set(nodes.map((node) => node.id));
  let candidate = stem;
  let suffix = 2;
  while (ids.has(candidate)) {
    candidate = `${stem}_${String(suffix)}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * A model-authored plan is not allowed to strand typed operations after its last patch.
 * Normalize that recoverable planner mistake into the one lifecycle the driver can settle:
 * every `propose_edit` feeds a combined `assemble_patch`, and that patch feeds a terminal
 * verify. Existing intermediate assembly/verification steps remain useful checkpoints.
 */
function closeModelMutationLifecycle(nodes: readonly TaskNode[]): TaskNode[] {
  const proposals = nodes.filter(
    (node) => node.effect.kind === 'model' && node.effect.name === 'propose_edit',
  );
  if (proposals.length === 0) return [...nodes];

  const assemblies = nodes.filter(
    (node) => node.effect.kind === 'patch' && node.effect.name === 'assemble_patch',
  );
  const verifications = nodes.filter(
    (node) => node.effect.kind === 'verify' && node.effect.name === 'verify',
  );
  const coveringAssembly = assemblies.find((assembly) =>
    proposals.every(
      (proposal) => proposal.id === assembly.id || dependsOn(nodes, assembly, proposal.id),
    ),
  );
  if (
    coveringAssembly &&
    verifications.some((verification) => dependsOn(nodes, verification, coveringAssembly.id))
  ) {
    return [...nodes];
  }

  const closed = [...nodes];
  let finalAssembly = coveringAssembly;
  if (!finalAssembly) {
    const assemblyFrontier = assemblies.filter(
      (assembly) =>
        !assemblies.some(
          (later) => later.id !== assembly.id && dependsOn(nodes, later, assembly.id),
        ),
    );
    const uncoveredProposals = proposals.filter(
      (proposal) => !assemblies.some((assembly) => dependsOn(nodes, assembly, proposal.id)),
    );
    const sources = [...assemblyFrontier, ...uncoveredProposals];
    const assemblyId = generatedTaskId(closed, '__final_assemble');
    const sourceIds = sources.map((source) => source.id);
    finalAssembly = {
      id: assemblyId,
      label: 'Assemble all proposed changes',
      effect: {
        kind: 'patch',
        name: 'assemble_patch',
        args: { from: sourceIds.length === 1 ? sourceIds[0] : sourceIds },
      },
      resource: 'pure',
      priority: 'edit',
      deps: sourceIds,
    };
    closed.push(finalAssembly);
  }

  const verifyId = generatedTaskId(closed, '__final_verify');
  closed.push({
    id: verifyId,
    label: 'Verify the complete planned edit',
    effect: {
      kind: 'verify',
      name: 'verify',
      args: { goal: 'the complete requested edit is assembled and valid' },
    },
    resource: 'pure',
    priority: 'edit',
    deps: [finalAssembly.id],
  });
  log.warn('compilePlan → repaired incomplete mutation lifecycle', {
    proposals: proposals.length,
    appendedAssembly: !coveringAssembly,
    appendedVerify: true,
  });
  return closed;
}

/**
 * Pure leaves consume completed DAG results. `deps` is the scheduling authority, so it
 * also owns that data binding: requiring a Planner to repeat the same edge in
 * `effect.args.from` created two sources of truth and allowed a graph to compile only to
 * fail at execution. Fill an omitted binding from the validated dependency list and
 * reject an explicit binding that contradicts it before any task can run.
 */
function bindPureLeafUpstream(
  effect: TaskEffectSpec,
  deps: readonly TaskId[],
  taskId: TaskId,
): TaskEffectSpec {
  if (!['analysis', 'patch'].includes(effect.kind) || deps.length === 0) {
    return effect;
  }
  const args = effect.args ?? {};
  const explicit = args.from;
  if (explicit === undefined) {
    return {
      ...effect,
      args: { ...args, from: deps.length === 1 ? deps[0] : [...deps] },
    };
  }
  const references =
    typeof explicit === 'string'
      ? [explicit]
      : Array.isArray(explicit) && explicit.every((value) => typeof value === 'string')
        ? explicit
        : undefined;
  if (!references || references.length === 0) {
    throw new TaskGraphError(`Task "${taskId}" has an invalid upstream "from" binding.`);
  }
  const undeclared = references.filter((reference) => !deps.includes(reference));
  if (undeclared.length > 0) {
    throw new TaskGraphError(
      `Task "${taskId}" reads undeclared upstream task${undeclared.length === 1 ? '' : 's'}: ${undeclared.join(', ')}.`,
    );
  }
  return effect;
}
