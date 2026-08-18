/**
 * FramePilot 9.5 Phase-1 mutating-route parity harness
 * (`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §6.1 and §6.3).
 *
 * ## Why this module exists
 *
 * Phase 1 asks one question: *may the `planned_edit` execution universe be retired?* The
 * roadmap's answer is deliberately evidence-gated — §6.3 lists eight conditions that must
 * hold before the route is removed. This harness produces that evidence by running the SAME
 * user goal through BOTH mutating routes against the SAME project with the SAME deterministic
 * scripted provider and host executor, then comparing the observable result on each §6.3
 * dimension.
 *
 * ## What it is not
 *
 * It is **not** a second eval framework. Every per-run measurement is projected through the
 * Phase-0 telemetry contract ({@link captureAgentRunQuality}) so parity numbers and Foundation
 * numbers are the same numbers, and the scenario tiers reuse the Foundation manifest's tiers
 * ({@link AgentOutcomeEvalTier}). It is also not a writer: it observes an orchestrator stream
 * and never commits, persists, or applies anything to a real project.
 *
 * ## Deterministic vs. real-provider evidence
 *
 * A scripted provider can prove *mechanics* — capability coverage, cancellation, undo,
 * review read-only-ness, failure honesty, structured activity, bounded model calls. It
 * cannot prove *editorial quality* or wall-clock latency, because both are properties of a
 * real model on real media. Those two dimensions are therefore reported as
 * {@link RouteParityDisposition} `'not_evaluated'` with an explicit reason rather than being
 * silently scored as passes — the Foundation exit record forbids converting an unavailable
 * metric into a passing one.
 */
import {
  applyProjectPatch,
  diffProject,
  invertProjectPatch,
  type AnyOperation,
  type Patch,
} from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { captureAgentRunQuality, type AgentRunQualityMetrics } from './agent-run-quality.js';
import type { CapturedTurn } from './kernel/cost/baseline-capture.js';
import type { AgentOutcomeEvalTier } from './professional-agent-evals.js';
import type { ContextInput } from './context-builder.js';
import type { AiEvent, RunStatus } from './events.js';
import { Orchestrator, type StreamOptions } from './orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import type { HostToolExecutor } from './tool-executor.js';

/**
 * The §6.3 retirement gate, one dimension per bullet, plus `capability` for the
 * "no planned-edit-only capability remains" clause.
 */
export const ROUTE_PARITY_DIMENSIONS = [
  'capability',
  'outcome',
  'cost',
  'latency',
  'cancellation',
  'durability',
  'activity_ux',
  'review',
  'undo',
  'failure_honesty',
] as const;
export type RouteParityDimension = (typeof ROUTE_PARITY_DIMENSIONS)[number];

/**
 * How the primary agent runtime compares to `planned_edit` on one dimension.
 * `not_evaluated` is a first-class outcome: it keeps an unmeasured dimension visibly
 * unmeasured instead of letting an absent signal read as a pass.
 */
export type RouteParityDisposition =
  | 'agent_better'
  | 'equivalent'
  | 'agent_worse'
  | 'not_evaluated';

export interface RouteParityDimensionResult {
  readonly dimension: RouteParityDimension;
  readonly disposition: RouteParityDisposition;
  /** Human-readable justification. Required, so no verdict is unattributable. */
  readonly reason: string;
}

/** One route's observable behavior for a scenario. */
export interface RouteObservation {
  readonly route: 'planned_edit' | 'agent';
  readonly metrics: AgentRunQualityMetrics;
  readonly terminalStatus: RunStatus | undefined;
  /** Operation `type` values in emitted order — the capability fingerprint. */
  readonly operationKinds: readonly string[];
  /** Whether every emitted diff carried a passing deterministic validation. */
  readonly validated: boolean;
  /**
   * Whether applying each emitted patch and then its inverse restores the project exactly.
   * `undefined` when the route emitted no patch (nothing to reverse).
   */
  readonly reversible: boolean | undefined;
  /** Distinct `AiEvent.type` values, so activity legibility is comparable structurally. */
  readonly eventKinds: readonly string[];
  /**
   * True unless the run settled `failed` with no machine-readable diagnostic. Both an
   * `error` card and a `warning` satisfy this: the invariant is that a failed run must SAY
   * why, not that it must say why through one particular event kind. The multi-turn agent
   * deliberately reports a recoverable tool failure as a warning plus an honest prose
   * report, which is more specific than a bare retryable error card, not less.
   */
  readonly failureWasTyped: boolean;
  /** Review findings never accompany a patch authored by review — asserted, not assumed. */
  readonly reviewWroteNothing: boolean;
}

export interface RouteParityRecord {
  readonly scenarioId: string;
  readonly tier: AgentOutcomeEvalTier;
  readonly goal: string;
  readonly plannedEdit: RouteObservation;
  readonly agent: RouteObservation;
  readonly dimensions: readonly RouteParityDimensionResult[];
  /**
   * `agent_ready` — no dimension regressed. `agent_regresses` — at least one did.
   * The verdict deliberately ignores `not_evaluated`; the gate summary reports those
   * separately as waivers so they cannot be mistaken for evidence.
   */
  readonly verdict: 'agent_ready' | 'agent_regresses';
}

/** A scripted turn for the agent route: assistant text plus optional tool calls. */
export type AgentScriptTurn = AiResponse;

export interface RouteParityScenario {
  readonly id: string;
  readonly tier: AgentOutcomeEvalTier;
  /** The user-facing goal both routes are given, verbatim. */
  readonly goal: string;
  /** Fresh project per route, so neither run can observe the other's state. */
  readonly project: () => Project;
  /**
   * Ordered raw model replies for the planned-edit route: intent JSON, plan JSON, then one
   * reply per `propose_edit` step. Exhausting the script is itself an observation (the route
   * made more calls than the scenario budgeted), not a crash.
   */
  readonly plannedEditScript: readonly string[];
  /** Ordered scripted turns for the agent route. */
  readonly agentScript: readonly AgentScriptTurn[];
  /**
   * Shared host executor factory, so analysis evidence is identical on both sides. The
   * per-route {@link AbortController} is handed in so a scenario can model a user pressing
   * Stop *from inside* a tool call — the only faithful way to reproduce a mid-analysis or
   * mid-mutation cancel without an arbitrary sleep.
   */
  readonly executor: (controller: AbortController) => HostToolExecutor;
  /** When true, both runs are given the scenario's abort signal. */
  readonly cancels?: boolean;
  /** Dimensions this row is designed to be evidence for. */
  readonly proves: readonly RouteParityDimension[];
}

const NOT_EVALUATED_REASONS: Partial<Record<RouteParityDimension, string>> = {
  outcome:
    'Editorial success is a property of a real model on real media; a scripted provider ' +
    'cannot produce it. Requires the Foundation real-provider capture.',
  latency:
    'Wall-clock latency under a synchronous scripted provider measures the test harness, ' +
    'not the runtime. Requires the Foundation real-provider capture.',
};

/**
 * Every scripted provider records one {@link CapturedTurn} per completion, so the parity
 * record's model-call count is an OBSERVED number rather than a default. Without this the
 * `cost` dimension would compare zero against zero and report a vacuous "equivalent" — the
 * exact "unavailable metric read as passing" the Foundation exit record forbids.
 *
 * Timings are recorded as zero because a synchronous mock has none. That is honest and
 * harmless: `latency` is a waived dimension precisely because of it.
 */
abstract class RecordingProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public calls = 0;
  public readonly turns: CapturedTurn[] = [];

  protected record(): void {
    this.calls += 1;
    this.turns.push({
      provider: 'mock',
      modelId: 'scripted',
      streamed: false,
      ttftMs: 0,
      wallMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  public abstract complete(request: AiCompletionRequest): Promise<AiResponse>;
}

/** Replays canned raw text replies in call order; running out is reported, never thrown away. */
class ScriptedTextProvider extends RecordingProvider {
  public overruns = 0;
  public readonly requests: AiCompletionRequest[] = [];
  public constructor(private readonly responses: readonly string[]) {
    super();
  }
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const text = this.responses[this.calls];
    this.record();
    if (text === undefined) {
      this.overruns += 1;
      // An empty reply is unparseable, which every proposer already handles as an honest
      // decline. Throwing here would report a harness bug as a runtime failure.
      return { text: '' };
    }
    return { text };
  }
}

/** Replays canned tool-calling turns; the last turn repeats so a loop terminates. */
class ScriptedAgentProvider extends RecordingProvider {
  public constructor(private readonly scriptedTurns: readonly AgentScriptTurn[]) {
    super();
  }
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    const turn = this.scriptedTurns[Math.min(this.calls, this.scriptedTurns.length - 1)];
    this.record();
    return turn ?? { text: '' };
  }
}

function streamOptions(scenarioId: string, route: string, signal?: AbortSignal): StreamOptions {
  return {
    conversationId: `parity_${scenarioId}`,
    turnId: `${scenarioId}_${route}`,
    // A fixed clock keeps records byte-stable so a parity regression is a real behavior
    // change rather than clock noise.
    now: () => 1_000,
    ...(signal ? { signal } : {}),
  };
}

async function drain(stream: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

interface DiffLike {
  readonly patch: Patch & { readonly operations: readonly AnyOperation[] };
  readonly validation: { readonly valid: boolean };
}

function diffEvents(events: readonly AiEvent[]): readonly DiffLike[] {
  return events
    .filter((event): event is Extract<AiEvent, { type: 'diff' }> => event.type === 'diff')
    .map((event) => event.edit as unknown as DiffLike);
}

function terminalStatusOf(events: readonly AiEvent[]): RunStatus | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'status') return event.status;
  }
  return undefined;
}

/**
 * Apply then invert every emitted patch against a pristine project. `undefined` when the
 * route emitted nothing to reverse — deliberately distinct from `false` ("it emitted work
 * that could not be reversed"), which is a hard regression.
 */
function patchesAreReversible(project: Project, diffs: readonly DiffLike[]): boolean | undefined {
  if (diffs.length === 0) return undefined;
  let working = project;
  for (const diff of diffs) {
    const patch = diff.patch;
    const after = applyProjectPatch(working, patch);
    const inverse = invertProjectPatch(working, patch);
    const restored = applyProjectPatch(after, inverse);
    if (diffProject(working, restored).summary.join('|') !== 'no changes') return false;
    working = after;
  }
  return true;
}

function observe(
  route: 'planned_edit' | 'agent',
  project: Project,
  events: readonly AiEvent[],
  capturedTurns: readonly CapturedTurn[],
): RouteObservation {
  const diffs = diffEvents(events);
  const terminal = terminalStatusOf(events);
  const failed = terminal === 'failed';
  return {
    route,
    metrics: captureAgentRunQuality({
      routeMode: route === 'planned_edit' ? 'planned-edit' : 'agent',
      events,
      capturedTurns,
      operations: {
        attempted: diffs.reduce((total, diff) => total + diff.patch.operations.length, 0),
        // An emitted diff is PROPOSED work. Only a host commit makes it applied, and this
        // harness deliberately has no host — so `applied` stays 0 rather than inflating.
        applied: 0,
        rejected: 0,
      },
      deterministicValidation:
        diffs.length === 0 ? 'not_run' : diffs.every((d) => d.validation.valid) ? 'passed' : 'failed',
    }),
    terminalStatus: terminal,
    operationKinds: diffs.flatMap((diff) => diff.patch.operations.map((op) => op.type)),
    validated: diffs.length > 0 && diffs.every((diff) => diff.validation.valid),
    reversible: patchesAreReversible(project, diffs),
    eventKinds: [...new Set(events.map((event) => event.type))].sort(),
    failureWasTyped:
      !failed || events.some((event) => event.type === 'error' || event.type === 'warning'),
    // Review is a reader by construction: a `review_finding` carries findings, never a
    // patch. This asserts the property from the observed stream rather than trusting it.
    reviewWroteNothing: !events.some(
      (event) => event.type === 'review_finding' && 'edit' in event,
    ),
  };
}

function dimension(
  dim: RouteParityDimension,
  disposition: RouteParityDisposition,
  reason: string,
): RouteParityDimensionResult {
  return { dimension: dim, disposition, reason };
}

/** Compare two observations on every §6.3 dimension the scenario claims to prove. */
function compare(
  scenario: RouteParityScenario,
  planned: RouteObservation,
  agent: RouteObservation,
): readonly RouteParityDimensionResult[] {
  const results: RouteParityDimensionResult[] = [];
  for (const dim of ROUTE_PARITY_DIMENSIONS) {
    if (!scenario.proves.includes(dim)) {
      results.push(
        dimension(dim, 'not_evaluated', `Scenario "${scenario.id}" is not evidence for ${dim}.`),
      );
      continue;
    }
    const waived = NOT_EVALUATED_REASONS[dim];
    if (waived) {
      results.push(dimension(dim, 'not_evaluated', waived));
      continue;
    }
    results.push(compareDimension(dim, planned, agent));
  }
  return results;
}

function compareDimension(
  dim: RouteParityDimension,
  planned: RouteObservation,
  agent: RouteObservation,
): RouteParityDimensionResult {
  switch (dim) {
    case 'capability': {
      const plannedKinds = [...planned.operationKinds].sort().join(',');
      const agentKinds = [...agent.operationKinds].sort().join(',');
      if (plannedKinds === agentKinds) {
        return dimension(
          dim,
          'equivalent',
          `Both routes produced the same operation kinds: [${agentKinds || 'none'}].`,
        );
      }
      // A superset is not a regression: the agent covering everything planned_edit covers
      // is exactly the retirement condition, even when it also does more.
      const coversAll = planned.operationKinds.every((kind) => agent.operationKinds.includes(kind));
      return coversAll
        ? dimension(
            dim,
            'agent_better',
            `Agent covered every planned-edit operation kind and added [${agent.operationKinds
              .filter((kind) => !planned.operationKinds.includes(kind))
              .join(',')}].`,
          )
        : dimension(
            dim,
            'agent_worse',
            `Agent is missing planned-edit operation kinds: [${planned.operationKinds
              .filter((kind) => !agent.operationKinds.includes(kind))
              .join(',')}].`,
          );
    }
    case 'cost': {
      const plannedCalls = planned.metrics.modelCallCount;
      const agentCalls = agent.metrics.modelCallCount;
      if (agentCalls < plannedCalls) {
        return dimension(dim, 'agent_better', `Agent used ${agentCalls} model calls vs ${plannedCalls}.`);
      }
      if (agentCalls === plannedCalls) {
        return dimension(dim, 'equivalent', `Both routes used ${agentCalls} model calls.`);
      }
      return dimension(
        dim,
        'agent_worse',
        `Agent used ${agentCalls} model calls vs planned-edit's ${plannedCalls}.`,
      );
    }
    case 'cancellation': {
      if (planned.terminalStatus !== 'cancelled') {
        return dimension(
          dim,
          'not_evaluated',
          `Planned-edit did not cancel (terminal "${String(planned.terminalStatus)}"), so there is nothing to match.`,
        );
      }
      if (agent.terminalStatus !== 'cancelled') {
        return dimension(
          dim,
          'agent_worse',
          `Planned-edit settled cancelled but the agent settled "${String(agent.terminalStatus)}".`,
        );
      }
      // Cancelling must not fabricate committed-looking work on either side.
      const plannedWork = planned.operationKinds.length;
      const agentWork = agent.operationKinds.length;
      return agentWork <= plannedWork
        ? dimension(
            dim,
            'equivalent',
            `Both routes settled cancelled; agent proposed ${agentWork} operations vs ${plannedWork}.`,
          )
        : dimension(
            dim,
            'agent_worse',
            `Agent proposed ${agentWork} operations after cancellation vs planned-edit's ${plannedWork}.`,
          );
    }
    case 'durability':
      return planned.terminalStatus === agent.terminalStatus
        ? dimension(
            dim,
            'equivalent',
            `Both routes reached the same terminal outcome "${String(agent.terminalStatus)}", so the durable run records the same result.`,
          )
        : dimension(
            dim,
            'agent_worse',
            `Terminal outcomes diverge: planned-edit "${String(planned.terminalStatus)}" vs agent "${String(agent.terminalStatus)}".`,
          );
    case 'activity_ux': {
      // "Understandable" here is structural: the agent must not go dark where the planner
      // narrated. Two kinds are deliberately not required. `task_started`/`task_finished`
      // are the planner's own step-card vocabulary — the agent narrates the same work as
      // live `tool_call`/`tool_result` cards, which is the shipping agent-mode UX. And
      // `error`/`warning` are interchangeable diagnostics: what matters is that a problem is
      // reported, not which card carries it.
      const DIAGNOSTIC = new Set(['error', 'warning']);
      const PLANNER_ONLY = new Set(['task_started', 'task_finished']);
      const agentReportsDiagnostic = agent.eventKinds.some((kind) => DIAGNOSTIC.has(kind));
      const missing = planned.eventKinds.filter((kind) => {
        if (agent.eventKinds.includes(kind) || PLANNER_ONLY.has(kind)) return false;
        return !(DIAGNOSTIC.has(kind) && agentReportsDiagnostic);
      });
      return missing.length === 0
        ? dimension(
            dim,
            agent.eventKinds.length > planned.eventKinds.length ? 'agent_better' : 'equivalent',
            `Agent emits [${agent.eventKinds.join(',')}] against planned-edit's [${planned.eventKinds.join(',')}].`,
          )
        : dimension(
            dim,
            'agent_worse',
            `Agent stream is missing planned-edit event kinds [${missing.join(',')}].`,
          );
    }
    case 'review':
      return planned.reviewWroteNothing && agent.reviewWroteNothing
        ? dimension(dim, 'equivalent', 'Neither route let review author a patch.')
        : dimension(dim, 'agent_worse', 'A route emitted a review finding carrying an edit.');
    case 'undo': {
      if (agent.reversible === false) {
        return dimension(dim, 'agent_worse', 'An agent patch did not invert back to the original project.');
      }
      if (agent.reversible === undefined) {
        return planned.reversible === undefined
          ? dimension(dim, 'equivalent', 'Neither route emitted a patch, so there is nothing to reverse.')
          : dimension(dim, 'agent_worse', 'Planned-edit produced a reversible patch and the agent produced none.');
      }
      return dimension(dim, 'equivalent', 'Every agent patch inverts back to the original project exactly.');
    }
    case 'failure_honesty':
      return planned.failureWasTyped && agent.failureWasTyped
        ? dimension(
            dim,
            'equivalent',
            planned.terminalStatus === 'failed' || agent.terminalStatus === 'failed'
              ? 'Every failed run carried a machine-readable diagnostic event.'
              : 'Neither route failed, and neither settled without a diagnostic.',
          )
        : dimension(
            dim,
            agent.failureWasTyped ? 'agent_better' : 'agent_worse',
            `Typed-failure reporting: planned-edit ${String(planned.failureWasTyped)}, agent ${String(agent.failureWasTyped)}.`,
          );
    /* v8 ignore next 4 -- `outcome` and `latency` are intercepted by NOT_EVALUATED_REASONS
       before reaching this switch; the arm exists so the union stays exhaustive if a future
       dimension is added without a waiver. */
    default:
      return dimension(dim, 'not_evaluated', `No deterministic comparison is defined for ${dim}.`);
  }
}

/**
 * Run one scenario through both mutating routes and produce its parity record.
 *
 * Both routes get a pristine copy of the scenario project and the same host executor, so
 * any difference in the record is a difference in the runtime, not in the fixture.
 */
export async function runRouteParityScenario(
  scenario: RouteParityScenario,
): Promise<RouteParityRecord> {
  const plannedController = new AbortController();
  const plannedProject = scenario.project();
  const plannedProvider = new ScriptedTextProvider(scenario.plannedEditScript);
  const plannedEvents = await drain(
    new Orchestrator(plannedProvider, {
      executor: scenario.executor(plannedController),
    }).streamEditorRun(
      { project: plannedProject, userPrompt: scenario.goal } satisfies ContextInput,
      streamOptions(scenario.id, 'planned', scenario.cancels ? plannedController.signal : undefined),
      { route: 'planned_edit' },
    ),
  );

  const agentController = new AbortController();
  const agentProject = scenario.project();
  const agentProvider = new ScriptedAgentProvider(scenario.agentScript);
  const agentEvents = await drain(
    new Orchestrator(agentProvider, {
      executor: scenario.executor(agentController),
    }).streamEditorRun(
      { project: agentProject, userPrompt: scenario.goal } satisfies ContextInput,
      streamOptions(scenario.id, 'agent', scenario.cancels ? agentController.signal : undefined),
      { route: 'agent', agentOptions: {} },
    ),
  );

  const planned = observe('planned_edit', plannedProject, plannedEvents, plannedProvider.turns);
  const agent = observe('agent', agentProject, agentEvents, agentProvider.turns);
  const dimensions = compare(scenario, planned, agent);
  return {
    scenarioId: scenario.id,
    tier: scenario.tier,
    goal: scenario.goal,
    plannedEdit: planned,
    agent,
    dimensions,
    verdict: dimensions.some((result) => result.disposition === 'agent_worse')
      ? 'agent_regresses'
      : 'agent_ready',
  };
}

export interface RouteParityWaiver {
  readonly dimension: RouteParityDimension;
  readonly reason: string;
}

export interface RouteParityGateResult {
  readonly recordCount: number;
  /** Dimensions with at least one `equivalent`/`agent_better` result and no regression. */
  readonly satisfied: readonly RouteParityDimension[];
  /** Dimensions where at least one scenario regressed. Any entry blocks retirement. */
  readonly blockers: readonly RouteParityDimension[];
  /**
   * Dimensions no deterministic scenario could evaluate, each with the reason. These are
   * NOT passes — retiring the route while a waiver stands is an explicit owner decision.
   */
  readonly waived: readonly RouteParityWaiver[];
  readonly verdict: 'retirement_unblocked' | 'retirement_blocked';
}

/**
 * Fold parity records into the §6.3 gate. `retirement_unblocked` means no measured
 * dimension regressed — it deliberately does not mean every dimension was measured, which
 * is why {@link RouteParityGateResult.waived} is reported alongside the verdict.
 */
export function summarizeRouteParityGate(
  records: readonly RouteParityRecord[],
): RouteParityGateResult {
  const satisfied = new Set<RouteParityDimension>();
  const blockers = new Set<RouteParityDimension>();
  const waivers = new Map<RouteParityDimension, string>();
  for (const record of records) {
    for (const result of record.dimensions) {
      if (result.disposition === 'agent_worse') blockers.add(result.dimension);
      else if (result.disposition !== 'not_evaluated') satisfied.add(result.dimension);
    }
  }
  for (const dim of ROUTE_PARITY_DIMENSIONS) {
    if (satisfied.has(dim) || blockers.has(dim)) continue;
    waivers.set(
      dim,
      NOT_EVALUATED_REASONS[dim] ??
        `No parity scenario produced a deterministic comparison for ${dim}.`,
    );
  }
  const order = (dim: RouteParityDimension): number => ROUTE_PARITY_DIMENSIONS.indexOf(dim);
  return {
    recordCount: records.length,
    satisfied: [...satisfied].sort((a, b) => order(a) - order(b)),
    blockers: [...blockers].sort((a, b) => order(a) - order(b)),
    waived: [...waivers.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([dimensionName, reason]) => ({ dimension: dimensionName, reason })),
    verdict: blockers.size === 0 ? 'retirement_unblocked' : 'retirement_blocked',
  };
}

/** Stable JSON for persisting a parity run beside the Foundation records. */
export function serializeRouteParityRecords(records: readonly RouteParityRecord[]): string {
  return JSON.stringify(records, null, 2);
}
