/**
 * @framepilot/ai-sdk/kernel/agent-graph — the §4.1 orchestration graph
 * (plan/LANGCHAIN-MIGRATION.md M6).
 *
 * ## What this is
 *
 * **This is the only agent runtime.** M12 deleted `kernel/driver.ts` (ADR 0102/0103); if
 * you are reading a comment elsewhere that contrasts "the graph path" with "the kernel
 * path", it is describing history.
 *
 * Its predecessor was a generic effect pump — four nodes (dispatch, take_effect,
 * execute_effect, finalize) routing any `ConductorEffect` to its handler. A loop written
 * in graph notation, and the right first step.
 *
 * This module is the graph §4.1 actually specifies: **one named node per effect kind**,
 * each a thin shell that does its I/O and then calls the corresponding **pure decision**
 * exported by `conductor.ts`. That is §5.2 — "nodes are shells; decisions stay pure" —
 * realised rather than described.
 *
 * The difference is not cosmetic. Named nodes are what an interrupt could attach to (you
 * cannot interrupt "execute_effect"; you interrupt `await_approval`), what a divergence
 * report can name, and what makes the graph readable as the run's actual shape.
 *
 * ## The decisions are not reimplemented here
 *
 * Every node calls `onDraftPlanResult` / `onApprovalResult` / `onResumeResult` /
 * `onTurnResult` / `onVerifyResult` — the same functions `onEffectResult` dispatches to.
 * There is exactly one implementation of the run's policy. A "graph-flavoured" copy would
 * be two, and they would drift the first time either was touched. This is also why
 * `conductor.ts` survived M12 while the driver did not: it holds the decisions, not the
 * plumbing.
 *
 * ## Events, cancellation and throws — three contracts that must not be relaxed
 *
 * Each was established by an empirically observed LangGraph behaviour, so the reasons
 * are recorded here rather than in the deleted file that first found them:
 *
 * 1. **Events go through `GraphEventQueue`, never LangGraph's custom stream writer.**
 *    LangGraph discards a whole superstep's custom-stream writes when that superstep
 *    aborts or throws. Cancel a run mid-turn and every buffered event vanishes — probed
 *    directly, the observed output was an empty array.
 * 2. **The `AbortSignal` is never handed to LangGraph.** Handlers own cancellation, so a
 *    cancelled run settles through the normal path and its events survive (1).
 * 3. **Node throws are wrapped in `GraphNodeThrow`.** LangGraph annotates thrown values
 *    with a `pregelTaskId`, which destroys any non-`Error` throw
 *    (`TypeError: Cannot create property 'pregelTaskId' on string`). Wrapping preserves
 *    the original value for the caller.
 * 4. **`GraphEventQueue` order is the run's ORDER OF INTENT, not its order of completion.**
 *    A turn's concurrency-safe tool calls run against a bounded pool (E1 batching,
 *    `concurrency.ts`), and ADR 0150 additionally warms a turn's acquisitions ahead of the
 *    serial pass. None of that is allowed to show: `mapBounded` returns results in input
 *    order and `executeToolCalls` folds a batch in original call order, so the event
 *    sequence a host observes is byte-identical to serial execution (golden-tested) and
 *    concurrency changes wall-clock only. Anything that emits from inside a concurrent
 *    call — rather than deferring to the fold — breaks this, and with it every golden.
 *
 *    The ordering RULE that bounds the batching is the mirror of the same contract: a
 *    mutating call ends a batch, because the turn's speculative working copy is threaded
 *    call-to-call. An analysis hoisted across a mutation would answer about a timeline
 *    that no longer exists (`analysis-parallel.test.ts` pins both halves).
 */
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { createLogger, getLogLevel, type LogLevel } from '@framepilot/shared-types';
import { type AiEvent, createTurnEmitter } from '../events.js';
import type { Command } from './commands.js';
import {
  type AwaitApprovalEffect,
  type DraftPlanEffect,
  type FinalizeEffect,
  type ResumeEffect,
  type RunTurnEffect,
  type RunVerifyEffect,
  type ConductorResult,
  type ConductorState,
  type ConductorStep,
  type Emitter,
  initialConductorState,
  onApprovalResult,
  onCommand,
  onDraftPlanResult,
  onResumeResult,
  onTurnResult,
  onVerifyResult,
} from './conductor.js';

const log = createLogger('ai-sdk:kernel:agent-graph');

/**
 * How much of one notice survives into the decision line. Long enough that the guard,
 * budget and verify sentences stay recognisable (and greppable) at the front, short
 * enough that a run's log stays a trace rather than a transcript.
 */
const SAID_MAX_CHARS = 160;

/**
 * `Logger.action` emits at `info`, so these three levels drop it. The decision line is
 * built behind this check rather than handed to a logger that will discard it: the
 * `said` array walks every event a step produced, and a run that is deliberately quiet
 * should not pay for prose nobody reads.
 */
const LEVELS_THAT_DROP_ACTIONS: ReadonlySet<LogLevel> = new Set(['warn', 'error', 'silent']);

function decisionLineIsVisible(): boolean {
  return !LEVELS_THAT_DROP_ACTIONS.has(getLogLevel());
}

function truncateSaid(text: string): string {
  return text.length > SAID_MAX_CHARS ? `${text.slice(0, SAID_MAX_CHARS)}…` : text;
}

/**
 * What the step SAID: the notices, warnings and failures it emitted. A guard firing, a
 * budget stop, an inherited-finding advisory and the verify verdict are all prose events
 * and nothing else — collecting their texts here is what makes them greppable in a log of
 * a run nobody watched, without logging the deltas that make up the bulk of the stream.
 */
function saidTexts(events: readonly AiEvent[]): readonly string[] {
  const said: string[] = [];
  for (const event of events) {
    if (event.type === 'notification' || event.type === 'warning')
      said.push(truncateSaid(event.text));
    else if (event.type === 'error') said.push(truncateSaid(event.message));
  }
  return said;
}

/** `completed` / `failed` / `cancelled` — present only on the step that ends the run. */
function finalizeOutcome(
  effects: readonly Effect[],
): 'completed' | 'failed' | 'cancelled' | undefined {
  const final = effects.find((effect): effect is FinalizeEffect => effect.kind === 'finalize');
  if (final === undefined) return undefined;
  if (final.cancelled) return 'cancelled';
  return final.failed ? 'failed' : 'completed';
}

/**
 * ONE line per reducer step — the decision trace (Workstream F).
 *
 * The effect runtime already logs what the run *did* (`runModel → request`,
 * `runHostTool ← settled`). Nothing logged what it *decided*: which route was taken, a
 * guard firing, a stage advance, the verify verdict, the terminal outcome. Those live in
 * `conductor.ts`, which is a pure reducer and must stay one — so the line is emitted here,
 * at the only place a step's result is in hand, and it is the whole decision rather than a
 * per-event dribble.
 */
function logDecision(step: Step): void {
  if (!decisionLineIsVisible()) return;
  const { state } = step;
  const outcome = finalizeOutcome(step.effects);
  log.action('conductor decided', {
    runId: state.working.runId,
    stepIndex: state.stepIndex,
    phase: state.phase,
    stage: state.working.stage,
    effects: step.effects.map((effect) => effect.kind),
    applied: state.cumulativeOps.length,
    rejected: state.rejectedOpCount,
    stallStreak: state.stallStreak,
    runUsd: state.runUsd,
    runElapsedMs: state.runElapsedMs,
    said: saidTexts(step.events),
    ...(outcome === undefined ? {} : { outcome }),
  });
}

/** Draft the up-front plan: streams any events, returns the parsed plan labels. */
export type DraftPlanHandler = (
  effect: DraftPlanEffect,
  state: ConductorState,
  signal?: AbortSignal,
) => AsyncGenerator<AiEvent, ConductorResult>;

/** Replay a resume checkpoint: streams the reasoning/warning, returns the replay outcome. */
export type ResumeHandler = (
  effect: ResumeEffect,
  state: ConductorState,
  signal?: AbortSignal,
) => AsyncGenerator<AiEvent, ConductorResult>;

/** Await the creator's approve/cancel decision on a gated plan. */
export type AwaitApprovalHandler = (
  effect: AwaitApprovalEffect,
  state: ConductorState,
  signal?: AbortSignal,
) => AsyncGenerator<AiEvent, ConductorResult>;

/** Executes one agent turn: streams its events, returns the distilled turn outcome. */
export type TurnHandler = (
  effect: RunTurnEffect,
  state: ConductorState,
  signal?: AbortSignal,
) => AsyncGenerator<AiEvent, ConductorResult>;

/** Runs the Critic self-check and repair pass. */
export type VerifyHandler = (
  effect: RunVerifyEffect,
  state: ConductorState,
  signal?: AbortSignal,
) => AsyncGenerator<AiEvent, ConductorResult>;

/** Assembles and emits terminal artifacts, diff, report, and status. */
export type FinalizeHandler = (
  effect: FinalizeEffect,
  state: ConductorState,
  signal?: AbortSignal,
) => AsyncGenerator<AiEvent, void>;

export interface ConductorHandlers {
  readonly draftPlan: DraftPlanHandler;
  readonly resume: ResumeHandler;
  readonly awaitApproval: AwaitApprovalHandler;
  readonly runTurn: TurnHandler;
  readonly runVerify: VerifyHandler;
  readonly finalize: FinalizeHandler;
}

/**
 * A drafted plan may widen a deliberately tiny requested step cap to fit its plan +
 * headroom. Thirty-two is safely above that plan-derived floor, while normal runs use
 * the conductor's actual configured maxSteps. Each effect costs at most select + execute;
 * the fixed overhead covers dispatch, plan/resume/approval, verify, finalize, and END.
 * The graph is therefore a runaway backstop that always sits outside conductor policy.
 */
const MIN_GRAPH_STEP_BUDGET = 32;
const GRAPH_NODE_OVERHEAD = 16;

export function graphRecursionLimit(command: Command): number {
  const initial = onCommand(initialConductorState(command.stream), command);
  const stepBudget = Math.max(initial.state.config.maxSteps, MIN_GRAPH_STEP_BUDGET);
  return stepBudget * 2 + GRAPH_NODE_OVERHEAD;
}

export const GRAPH_NODES = {
  dispatch: 'dispatch',
  select: 'select_effect',
  draftPlan: 'draft_plan',
  resume: 'resume',
  awaitApproval: 'await_approval',
  runTurn: 'run_turn',
  runVerify: 'verify',
  finalize: 'finalize',
} as const;

export type GraphNodeName = (typeof GRAPH_NODES)[keyof typeof GRAPH_NODES];

type Step = ConductorStep;
type Effect = Step['effects'][number];

interface GraphSnapshot {
  readonly step: Step;
  readonly pending: readonly Effect[];
  readonly active: Effect | null;
}

class GraphEventQueue {
  private readonly buffer: AiEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  public push(event: AiEvent): void {
    this.buffer.push(event);
    this.signal();
  }

  public pushAll(events: readonly AiEvent[]): void {
    for (const event of events) this.push(event);
  }

  public close(): void {
    this.closed = true;
    this.signal();
  }

  public async *drain(): AsyncGenerator<AiEvent> {
    while (true) {
      while (this.buffer.length > 0) yield this.buffer.shift() as AiEvent;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

class GraphNodeThrow extends Error {
  public constructor(public readonly thrown: unknown) {
    super('FramePilot agent-graph node threw');
    this.name = 'GraphNodeThrow';
  }
}

function unwrapNodeThrow(error: unknown): unknown {
  /* v8 ignore next */
  if (!(error instanceof GraphNodeThrow)) return error;
  return error.thrown;
}

const GraphState = Annotation.Root({
  snapshot: Annotation<GraphSnapshot | null>({
    reducer: (_current, next) => next,
    default: () => null,
  }),
});

type StateValue = typeof GraphState.State;
type StateUpdate = typeof GraphState.Update;

function requireSnapshot(state: StateValue): GraphSnapshot {
  /* v8 ignore start */
  if (state.snapshot === null) {
    throw new Error('agent-graph state was read before command dispatch.');
  }
  /* v8 ignore stop */
  return state.snapshot;
}

const emitterFor = (state: ConductorState, result: ConductorResult): Emitter =>
  createTurnEmitter(state.turnRef, result.endSeq);

async function streamHandler<T>(
  generator: AsyncGenerator<AiEvent, T>,
  events: GraphEventQueue,
): Promise<T> {
  while (true) {
    const next = await generator.next();
    if (next.done) return next.value;
    events.push(next.value);
  }
}

function decide(state: ConductorState, result: ConductorResult, emitter: Emitter): Step {
  switch (result.kind) {
    case 'draft_plan':
      return onDraftPlanResult(state, result, emitter);
    case 'approval':
      return onApprovalResult(state, result, emitter);
    case 'resume':
      return onResumeResult(state, result, emitter);
    case 'agent_turn':
      return onTurnResult(state, result, emitter);
    case 'verify':
      return onVerifyResult(state, result, emitter);
  }
}

function createAgentGraph(
  command: Command,
  handlers: ConductorHandlers,
  events: GraphEventQueue,
  signal?: AbortSignal,
) {
  const fold = (snapshot: GraphSnapshot, result: ConductorResult): StateUpdate => {
    const next = decide(snapshot.step.state, result, emitterFor(snapshot.step.state, result));
    logDecision(next);
    events.pushAll(next.events);
    events.push(createTurnEmitter(next.state.turnRef, next.state.seq).runState(next.state.working));
    return {
      snapshot: {
        step: next,
        pending: [...snapshot.pending, ...next.effects],
        active: null,
      },
    };
  };

  const executionNode =
    (
      name: GraphNodeName,
      run: (snapshot: GraphSnapshot) => AsyncGenerator<AiEvent, ConductorResult>,
    ) =>
    async (state: StateValue): Promise<StateUpdate> => {
      const snapshot = requireSnapshot(state);
      log.action('agent-graph → node', { node: name });
      return fold(snapshot, await streamHandler(run(snapshot), events));
    };

  const dispatch = (_state: StateValue): StateUpdate => {
    const step = onCommand(initialConductorState(command.stream), command);
    log.action('agent-graph → command dispatched', {
      mode: command.mode,
      effects: step.effects.map((effect) => effect.kind),
    });
    logDecision(step);
    events.pushAll(step.events);
    if (command.mode === 'agent') {
      events.push(
        createTurnEmitter(step.state.turnRef, step.state.seq).runState(step.state.working),
      );
    }
    return { snapshot: { step, pending: [...step.effects], active: null } };
  };

  const select = (state: StateValue): StateUpdate => {
    const snapshot = requireSnapshot(state);
    const [active, ...pending] = snapshot.pending;
    /* v8 ignore next */
    return { snapshot: { ...snapshot, pending, active: active ?? null } };
  };

  const finalize = async (state: StateValue): Promise<StateUpdate> => {
    const snapshot = requireSnapshot(state);
    const effect = snapshot.active;
    /* v8 ignore next 3 */
    if (effect === null || effect.kind !== 'finalize') {
      throw new Error('agent-graph finalize node received a non-final effect.');
    }
    log.action('agent-graph → node', { node: GRAPH_NODES.finalize });
    await streamHandler(handlers.finalize(effect, snapshot.step.state, signal), events);
    return { snapshot: { ...snapshot, pending: [], active: null } };
  };

  const routePending = (state: StateValue): typeof GRAPH_NODES.select | typeof END =>
    requireSnapshot(state).pending.length > 0 ? GRAPH_NODES.select : END;

  const routeEffect = (state: StateValue): GraphNodeName | typeof END => {
    const effect = requireSnapshot(state).active;
    /* v8 ignore next */
    if (effect === null) return END;
    switch (effect.kind) {
      case 'draft_plan':
        return GRAPH_NODES.draftPlan;
      case 'resume':
        return GRAPH_NODES.resume;
      case 'await_approval':
        return GRAPH_NODES.awaitApproval;
      case 'run_turn':
        return GRAPH_NODES.runTurn;
      case 'run_verify':
        return GRAPH_NODES.runVerify;
      case 'finalize':
        return GRAPH_NODES.finalize;
    }
  };

  const guarded =
    <T>(node: (state: StateValue) => Promise<T>) =>
    async (state: StateValue): Promise<T> => {
      try {
        return await node(state);
      } catch (error) {
        throw new GraphNodeThrow(error);
      }
    };

  const node = (
    name: GraphNodeName,
    pick: (handlers: ConductorHandlers) => ConductorHandlers[keyof ConductorHandlers],
  ) =>
    guarded(
      executionNode(name, (snapshot) =>
        (pick(handlers) as (...args: never[]) => AsyncGenerator<AiEvent, ConductorResult>)(
          snapshot.active as never,
          snapshot.step.state as never,
          signal as never,
        ),
      ),
    );

  const pending = { [GRAPH_NODES.select]: GRAPH_NODES.select, [END]: END } as const;

  return new StateGraph(GraphState)
    .addNode(GRAPH_NODES.dispatch, dispatch)
    .addNode(GRAPH_NODES.select, select)
    .addNode(
      GRAPH_NODES.draftPlan,
      node(GRAPH_NODES.draftPlan, (h) => h.draftPlan),
    )
    .addNode(
      GRAPH_NODES.resume,
      node(GRAPH_NODES.resume, (h) => h.resume),
    )
    .addNode(
      GRAPH_NODES.awaitApproval,
      node(GRAPH_NODES.awaitApproval, (h) => h.awaitApproval),
    )
    .addNode(
      GRAPH_NODES.runTurn,
      node(GRAPH_NODES.runTurn, (h) => h.runTurn),
    )
    .addNode(
      GRAPH_NODES.runVerify,
      node(GRAPH_NODES.runVerify, (h) => h.runVerify),
    )
    .addNode(GRAPH_NODES.finalize, guarded(finalize))
    .addEdge(START, GRAPH_NODES.dispatch)
    .addConditionalEdges(GRAPH_NODES.dispatch, routePending, pending)
    .addConditionalEdges(GRAPH_NODES.select, routeEffect, {
      [GRAPH_NODES.draftPlan]: GRAPH_NODES.draftPlan,
      [GRAPH_NODES.resume]: GRAPH_NODES.resume,
      [GRAPH_NODES.awaitApproval]: GRAPH_NODES.awaitApproval,
      [GRAPH_NODES.runTurn]: GRAPH_NODES.runTurn,
      [GRAPH_NODES.runVerify]: GRAPH_NODES.runVerify,
      [GRAPH_NODES.finalize]: GRAPH_NODES.finalize,
      [END]: END,
    } as const)
    .addConditionalEdges(GRAPH_NODES.draftPlan, routePending, pending)
    .addConditionalEdges(GRAPH_NODES.resume, routePending, pending)
    .addConditionalEdges(GRAPH_NODES.awaitApproval, routePending, pending)
    .addConditionalEdges(GRAPH_NODES.runTurn, routePending, pending)
    .addConditionalEdges(GRAPH_NODES.runVerify, routePending, pending)
    .addEdge(GRAPH_NODES.finalize, END)
    .compile();
}

export async function* runAgentGraph(
  command: Command,
  handlers: ConductorHandlers,
  signal?: AbortSignal,
): AsyncGenerator<AiEvent> {
  const events = new GraphEventQueue();
  const graph = createAgentGraph(command, handlers, events, signal);

  let failure: { readonly thrown: unknown } | null = null;
  const completed = graph
    .invoke({ snapshot: null }, { recursionLimit: graphRecursionLimit(command) })
    .then(
      () => undefined,
      (error: unknown) => {
        failure = { thrown: unwrapNodeThrow(error) };
      },
    )
    .finally(() => {
      events.close();
    });

  for await (const event of events.drain()) yield event;
  await completed;
  if (failure !== null) throw (failure as { readonly thrown: unknown }).thrown;
}
