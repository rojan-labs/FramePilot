/**
 * Conformance harness for FramePilot's **single mutating AI runtime**
 * (`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §6, Phase 1).
 *
 * ## History
 *
 * This started life as a two-route *parity* harness: it ran the same user goal through both
 * `planned_edit` and the primary agent runtime and compared them on the §6.3 retirement
 * dimensions. That comparison discharged the gate — the evidence is recorded in
 * `docs/architecture/FRAMEPILOT-95-ROUTE-PARITY-EVIDENCE.md` and the comparative harness is
 * reproducible at the commit that added it — and `planned_edit` was retired (ADR 0126).
 *
 * Keeping a comparator for a route that no longer exists would be exactly the dead
 * scaffolding this program is supposed to delete. What survives is the half that still has a
 * subject: the same scenarios, the same deterministic scripted provider and host executor,
 * and the same observations — now asserted as **invariants of the one runtime** rather than
 * as a comparison against a second one.
 *
 * ## What it observes
 *
 * Per-run measurements project through the Phase-0 telemetry contract
 * ({@link captureAgentRunQuality}), so conformance numbers and Foundation numbers stay the
 * same numbers. The harness is not a writer: it drains an orchestrator stream and never
 * commits, persists, or applies anything to a real project.
 *
 * ## What it cannot observe
 *
 * A scripted provider proves *mechanics* — capability coverage, cancellation, undo,
 * review read-only-ness, failure honesty, bounded model calls. It cannot prove *editorial
 * quality* or wall-clock latency, because both are properties of a real model on real media.
 * Those belong to the Foundation real-provider capture and are deliberately absent here
 * rather than approximated.
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

/** The observable behavior of one run of the mutating runtime. */
export interface RuntimeObservation {
  readonly metrics: AgentRunQualityMetrics;
  readonly terminalStatus: RunStatus | undefined;
  /** Operation `type` values in emitted order — the capability fingerprint. */
  readonly operationKinds: readonly string[];
  /** Whether every emitted diff carried a passing deterministic validation. */
  readonly validated: boolean;
  /**
   * Whether applying each emitted patch and then its inverse restores the project exactly.
   * `undefined` when the run emitted no patch (nothing to reverse) — deliberately distinct
   * from `false` ("it emitted work that could not be reversed"), which is a hard defect.
   */
  readonly reversible: boolean | undefined;
  /** Distinct `AiEvent.type` values, so activity legibility is assertable. */
  readonly eventKinds: readonly string[];
  /**
   * False only when the run settled `failed` with no machine-readable diagnostic. Both an
   * `error` card and a `warning` satisfy it: the invariant is that a failed run must SAY
   * why, not that it must say why through one particular event kind.
   */
  readonly reportedItsFailure: boolean;
  /** Review is a reader — no `review_finding` may carry an edit. Asserted, not assumed. */
  readonly reviewWroteNothing: boolean;
}

/** A scripted turn: assistant text plus optional tool calls. */
export type AgentScriptTurn = AiResponse;

/** What the runtime must do for this scenario. Every field is a hard assertion. */
export interface ScenarioExpectation {
  readonly terminalStatus: RunStatus;
  /** Sorted operation kinds the run must land. An empty array means "must mutate nothing". */
  readonly operationKinds: readonly string[];
  /** Upper bound on model calls, so a runtime regression into a spin loop is caught. */
  readonly maxModelCalls: number;
}

export interface RuntimeConformanceScenario {
  readonly id: string;
  readonly tier: AgentOutcomeEvalTier;
  /** The user-facing goal, verbatim. */
  readonly goal: string;
  readonly project: () => Project;
  readonly agentScript: readonly AgentScriptTurn[];
  /**
   * Host executor factory. The per-run {@link AbortController} is handed in so a scenario
   * can model a user pressing Stop *from inside* a tool call — the only faithful way to
   * reproduce a mid-analysis cancel without an arbitrary sleep.
   */
  readonly executor: (controller: AbortController) => HostToolExecutor;
  /** When true, the run is given the scenario's abort signal. */
  readonly cancels?: boolean;
  readonly expect: ScenarioExpectation;
  /** Why this row exists — surfaced in failure output so a break is self-explaining. */
  readonly rationale: string;
}

/**
 * Records one {@link CapturedTurn} per completion, so the model-call count is an OBSERVED
 * number rather than a default. Without this the bound would compare against zero and pass
 * vacuously — the "unavailable metric read as passing" the Foundation exit record forbids.
 *
 * Timings are zero because a synchronous mock has none. That is honest and harmless:
 * latency is explicitly not a claim this harness makes.
 */
class ScriptedAgentProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public calls = 0;
  public readonly turns: CapturedTurn[] = [];

  public constructor(private readonly scriptedTurns: readonly AgentScriptTurn[]) {}

  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    // The last turn repeats so a loop that runs longer than the script still terminates
    // instead of throwing a harness error over a runtime behavior change.
    const turn = this.scriptedTurns[Math.min(this.calls, this.scriptedTurns.length - 1)];
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
    return turn ?? { text: '' };
  }
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
  /* v8 ignore next -- unreachable in practice: every orchestrator route settles on a
     terminal status event, so a stream with no status at all cannot be produced by a
     scenario. Kept as a total function rather than a non-null assertion. */
  return undefined;
}

/** Apply then invert every emitted patch against a pristine project. */
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

/** Run one scenario through the mutating runtime and observe it. */
export async function observeRuntimeScenario(
  scenario: RuntimeConformanceScenario,
): Promise<RuntimeObservation> {
  const controller = new AbortController();
  const project = scenario.project();
  const provider = new ScriptedAgentProvider(scenario.agentScript);
  const options: StreamOptions = {
    conversationId: `conformance_${scenario.id}`,
    turnId: scenario.id,
    // A fixed clock keeps observations byte-stable, so a break is a real behavior change
    // rather than clock noise.
    now: () => 1_000,
    ...(scenario.cancels ? { signal: controller.signal } : {}),
  };
  const events = await drain(
    new Orchestrator(provider, { executor: scenario.executor(controller) }).streamEditorRun(
      { project, userPrompt: scenario.goal } satisfies ContextInput,
      options,
      { route: 'agent', agentOptions: {} },
    ),
  );

  const diffs = diffEvents(events);
  const terminal = terminalStatusOf(events);
  return {
    metrics: captureAgentRunQuality({
      routeMode: 'agent',
      events,
      capturedTurns: provider.turns,
      operations: {
        attempted: diffs.reduce((total, diff) => total + diff.patch.operations.length, 0),
        // An emitted diff is PROPOSED work. Only a host commit makes it applied, and this
        // harness deliberately has no host — so `applied` stays 0 rather than inflating.
        applied: 0,
        rejected: 0,
      },
      /* v8 ignore next 6 -- the 'failed' arm needs an emitted diff whose validation did
         NOT pass. Editor-core rejects an invalid patch before a diff is emitted, so no
         scenario can currently reach it; it exists so a future regression that DOES emit
         one is reported as a validation failure instead of silently as 'passed'. */
      deterministicValidation:
        diffs.length === 0
          ? 'not_run'
          : diffs.every((diff) => diff.validation.valid)
            ? 'passed'
            : 'failed',
    }),
    terminalStatus: terminal,
    operationKinds: diffs.flatMap((diff) => diff.patch.operations.map((op) => op.type)),
    validated: diffs.length > 0 && diffs.every((diff) => diff.validation.valid),
    reversible: patchesAreReversible(project, diffs),
    eventKinds: [...new Set(events.map((event) => event.type))].sort(),
    reportedItsFailure:
      terminal !== 'failed' ||
      events.some((event) => event.type === 'error' || event.type === 'warning'),
    reviewWroteNothing: !events.some(
      (event) => event.type === 'review_finding' && 'edit' in event,
    ),
  };
}

export interface ConformanceViolation {
  readonly scenarioId: string;
  readonly detail: string;
}

/**
 * Check one observation against its scenario's expectation plus the runtime-wide invariants
 * that hold for EVERY scenario: review never writes, a failed run always says why, and no
 * emitted patch is irreversible.
 */
export function conformanceViolations(
  scenario: RuntimeConformanceScenario,
  observed: RuntimeObservation,
): readonly ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];
  const fail = (detail: string): void => {
    violations.push({ scenarioId: scenario.id, detail: `${detail} (${scenario.rationale})` });
  };

  if (observed.terminalStatus !== scenario.expect.terminalStatus) {
    fail(
      `terminal status was "${String(observed.terminalStatus)}", expected "${scenario.expect.terminalStatus}"`,
    );
  }
  const landed = [...observed.operationKinds].sort().join(',');
  const wanted = [...scenario.expect.operationKinds].sort().join(',');
  if (landed !== wanted) {
    fail(`landed operations [${landed}], expected [${wanted}]`);
  }
  if (observed.metrics.modelCallCount === 0) {
    fail('no model call was observed, so the run was not actually measured');
  }
  if (observed.metrics.modelCallCount > scenario.expect.maxModelCalls) {
    fail(
      `used ${String(observed.metrics.modelCallCount)} model calls, over the bound of ${String(scenario.expect.maxModelCalls)}`,
    );
  }
  if (observed.operationKinds.length > 0 && !observed.validated) {
    fail('landed operations without a passing deterministic validation');
  }
  if (observed.reversible === false) {
    fail('emitted a patch that does not invert back to the original project');
  }
  if (!observed.reportedItsFailure) {
    fail('settled failed with no error or warning explaining why');
  }
  if (!observed.reviewWroteNothing) {
    fail('a review finding carried an edit — review must stay read-only');
  }
  return violations;
}

/** Stable JSON for persisting a conformance run beside the Foundation records. */
export function serializeRuntimeObservations(
  entries: readonly (readonly [string, RuntimeObservation])[],
): string {
  return JSON.stringify(Object.fromEntries(entries), null, 2);
}
