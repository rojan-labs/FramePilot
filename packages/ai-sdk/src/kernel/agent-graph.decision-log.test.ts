/**
 * Workstream F — the reducer's DECISIONS reach the structured log.
 *
 * The effect runtime already logs what a run *did* (`runModel → request`,
 * `runHostTool ← settled`). What it *decided* — the route taken, a guard firing, a budget
 * stop, the verify verdict, the terminal outcome — lived only in the `AiEvent` stream,
 * which nobody has after the fact. `agent-graph.ts` now emits exactly one
 * `conductor decided` line per reducer step; this pins its shape, so a maintainer
 * debugging a run nobody watched can rely on those fields being there.
 *
 * The logger captures the platform sinks at import time (`console.log.bind`), so the
 * stubs are installed BEFORE any module that reaches it is imported — hence the dynamic
 * imports below (same shape as `shared-types/src/logger.test.ts`).
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

const logged: unknown[][] = [];
const realLog = console.log.bind(console);

vi.stubGlobal('console', {
  ...console,
  log: (...args: unknown[]) => {
    logged.push(args);
  },
  warn: realLog,
  error: realLog,
});

const { makeProject } = await import('../__fixtures__/project.js');
const { runAgentGraph } = await import('./agent-graph.js');

afterAll(() => {
  vi.unstubAllGlobals();
});

type AiEvent = import('../events.js').AiEvent;
type ConductorState = import('./conductor.js').ConductorState;
type AgentTurnResult = import('./conductor.js').AgentTurnResult;
type ConductorHandlers = import('./agent-graph.js').ConductorHandlers;
type Command = import('./commands.js').Command;

const stream = { conversationId: 'conv_log', turnId: 'run_log', now: () => 1000 };

/** One `conductor decided` payload, as the sink saw it. */
interface DecisionLine {
  readonly runId: string;
  readonly stepIndex: number;
  readonly phase: string;
  readonly stage: string;
  readonly effects: readonly string[];
  readonly applied: number;
  readonly rejected: number;
  readonly stallStreak: number;
  readonly runUsd: number;
  readonly runElapsedMs: number;
  readonly said: readonly string[];
  readonly outcome?: string;
}

function decisionLines(): readonly DecisionLine[] {
  return logged
    .filter(([line]) => typeof line === 'string' && line.includes('conductor decided'))
    .map(([, payload]) => payload as DecisionLine);
}

function turn(state: ConductorState, over: Partial<AgentTurnResult> = {}): AgentTurnResult {
  return {
    kind: 'agent_turn',
    stepIndex: state.stepIndex,
    aborted: false,
    done: false,
    anyToolCancelled: false,
    anyToolFailed: false,
    turnOpCount: 0,
    rejectedOpCount: 0,
    rejectionNotes: [],
    applied: false,
    appliedOps: [],
    describedActions: [],
    signature: `sig-${String(state.stepIndex)}`,
    callFacts: [],
    note: 'working',
    planSteps: [],
    planStepIndex: 0,
    intent: `step ${String(state.stepIndex)}`,
    log: [],
    endSeq: state.seq,
    ...over,
  } as AgentTurnResult;
}

/**
 * Two model turns, then a budget that is provably spent. The second turn reports a run
 * cost above the run's `$5` ceiling, which is what makes the budget stop's own sentence
 * the thing the third decision line must carry.
 */
function scriptedHandlers(): ConductorHandlers {
  let turns = 0;
  return {
    async *draftPlan(_effect, state) {
      yield* [];
      return { kind: 'draft_plan', labels: [], endSeq: state.seq };
    },
    async *resume(_effect, state) {
      yield* [];
      return { kind: 'resume', ok: false, ops: [], log: [], stepsCompleted: 0, endSeq: state.seq };
    },
    async *awaitApproval(_effect, state) {
      yield* [];
      return { kind: 'approval', decision: 'approved', endSeq: state.seq };
    },
    async *runTurn(_effect, state) {
      yield* [];
      turns += 1;
      return turns === 1 ? turn(state) : turn(state, { runUsd: 99, runElapsedMs: 1_000 });
    },
    async *runVerify(_effect, state) {
      yield* [];
      return {
        kind: 'verify',
        ok: true,
        summary: 'verified',
        failedChecks: [],
        warnedChecks: [],
        repairOps: [],
        endSeq: state.seq,
      };
    },
    async *finalize() {
      yield* [];
    },
  } as ConductorHandlers;
}

async function drive(): Promise<readonly DecisionLine[]> {
  logged.length = 0;
  const command: Command = {
    kind: 'submit_turn',
    mode: 'agent',
    input: { project: makeProject(), userPrompt: 'tighten the intro' },
    stream,
  };
  const events: AiEvent[] = [];
  for await (const event of runAgentGraph(command, scriptedHandlers())) events.push(event);
  expect(events.length).toBeGreaterThan(0);
  return decisionLines();
}

describe('agent-graph decision log', () => {
  it('emits one `conductor decided` line per reducer step, with the full decision shape', async () => {
    const lines = await drive();

    // dispatch + two folded turns + verify + (at least) the finalizing step.
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line.runId).toBe(stream.turnId);
      expect(typeof line.stepIndex).toBe('number');
      expect(typeof line.phase).toBe('string');
      expect(typeof line.stage).toBe('string');
      expect(Array.isArray(line.effects)).toBe(true);
      expect(typeof line.applied).toBe('number');
      expect(typeof line.rejected).toBe('number');
      expect(typeof line.stallStreak).toBe('number');
      expect(typeof line.runUsd).toBe('number');
      expect(typeof line.runElapsedMs).toBe('number');
      expect(Array.isArray(line.said)).toBe(true);
      for (const said of line.said) expect(said.length).toBeLessThanOrEqual(161);
    }

    // The trace reads as the run's actual shape: turns, then verify, then the end.
    const effects = lines.map((line) => line.effects.join(','));
    expect(effects).toContain('run_turn');
    expect(effects).toContain('run_verify');
    expect(effects).toContain('finalize');
  });

  it('shows the budget stop and the terminal outcome in the trace', async () => {
    const lines = await drive();

    const budgetStop = lines.find((line) =>
      line.said.some((text) => text.startsWith("Reached this run's ")),
    );
    expect(budgetStop).toBeDefined();
    expect(budgetStop?.effects).toEqual(['run_verify']);
    expect(budgetStop?.runUsd).toBe(99);

    // `failed`, not `completed`: this scripted run applied nothing, and the terminal
    // outcome is exactly the distinction the log has to carry.
    const terminal = lines.find((line) => line.effects.includes('finalize'));
    expect(terminal?.outcome).toBe('failed');
    expect(terminal?.applied).toBe(0);
  });
});
