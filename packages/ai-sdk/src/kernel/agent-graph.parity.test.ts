/**
 * M6.2/M6.3 — the §4.1 graph's stream is deterministic and node-addressable.
 *
 * Shadow mode's question is exactly one thing: **given the same command and the same
 * handler results, does the graph produce the byte-identical event stream the kernel
 * produces?** Anything less than byte-identical breaks the §7.4 contract that the
 * sidebar, the durable WAL and the replay harness all depend on — and it breaks it
 * silently, because a plausible-looking stream with different ids still renders.
 *
 * So both paths run over the SAME scripted handlers, and the results go through the M0.2
 * comparator, which reports a divergence list rather than a boolean. A failure here names
 * the diverging event and field.
 */
import { describe, expect, it } from 'vitest';
import type { ContextInput } from '../context-builder.js';
import type { AiEvent } from '../events.js';
import { makeProject } from '../__fixtures__/project.js';
import type { Command } from './commands.js';
import type { AgentTurnResult, ConductorState, VerifyResult } from './conductor.js';
import { GRAPH_NODES, runAgentGraph, type ConductorHandlers } from './agent-graph.js';
import {
  compareSessions,
  formatComparison,
  toGoldenSession,
  type RunOutcome,
} from './replay/golden-session.js';
import type { AnyOperation } from '@framepilot/editor-core';

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the intro' };
const stream = { conversationId: 'conv_shadow', turnId: 'turn_shadow', now: () => 1000 };
const command: Command = { kind: 'submit_turn', mode: 'agent', input, stream };

function marker(text: string): AiEvent {
  return {
    id: `shadow:${text}`,
    conversationId: stream.conversationId,
    turnId: stream.turnId,
    ts: 1000,
    type: 'notification',
    text,
  };
}

function turn(state: ConductorState, over: Partial<AgentTurnResult> = {}): AgentTurnResult {
  return {
    kind: 'agent_turn',
    stepIndex: 1,
    aborted: false,
    done: true,
    anyToolCancelled: false,
    anyToolFailed: false,
    turnOpCount: 0,
    rejectedOpCount: 0,
    rejectionNotes: [],
    applied: false,
    appliedOps: [],
    describedActions: [],
    signature: 'shadow',
    callFacts: [],
    note: 'complete',
    planSteps: [{ id: 'step-1', label: 'tighten intro', status: 'running' }],
    planStepIndex: 0,
    intent: 'tighten intro',
    log: [],
    endSeq: state.seq,
    ...over,
  };
}

const verified = (state: ConductorState): VerifyResult => ({
  kind: 'verify',
  ok: true,
  summary: 'verified',
  failedChecks: [],
  warnedChecks: [],
  repairOps: [],
  endSeq: state.seq,
});

/**
 * Handlers are rebuilt per run so the two paths get identical, independent scripts —
 * sharing one instance would let the first run's state leak into the second and make a
 * real divergence look like a scripting artefact.
 */
function handlers(over: Partial<ConductorHandlers> = {}): ConductorHandlers {
  return {
    async *draftPlan(_effect, state) {
      yield marker('draft');
      return { kind: 'draft_plan', labels: ['tighten intro'], endSeq: state.seq + 1 };
    },
    async *resume(_effect, state) {
      yield* [];
      return { kind: 'resume', ok: false, ops: [], log: [], stepsCompleted: 0, endSeq: state.seq };
    },
    async *awaitApproval(_effect, state) {
      yield marker('approval');
      return { kind: 'approval', decision: 'approved', endSeq: state.seq };
    },
    async *runTurn(_effect, state) {
      yield marker('turn');
      // `endSeq` ADVANCES, as a real handler's does after streaming. Returning
      // `state.seq` unchanged hid a genuine divergence: the graph seeded the reducer's
      // emitter at `state.seq` instead of `result.endSeq`, restarting the sequence
      // underneath the handler's own events. The corpus caught it; this now would too.
      return turn(state, { endSeq: state.seq + 3 });
    },
    async *runVerify(_effect, state) {
      yield marker('verify');
      return { ...verified(state), endSeq: state.seq + 2 };
    },
    async *finalize() {
      yield marker('finalize');
    },
    ...over,
  };
}

async function collect(source: AsyncIterable<AiEvent>): Promise<RunOutcome> {
  const events: AiEvent[] = [];
  for await (const event of source) events.push(event);
  const diffs = events.filter(
    (event): event is Extract<AiEvent, { type: 'diff' }> => event.type === 'diff',
  );
  const combined = diffs.filter((diff) => diff.scope !== 'turn');
  const source_ = combined.length > 0 ? combined : diffs;
  return {
    events,
    operations: source_.flatMap((diff) => diff.edit.patch.operations as AnyOperation[]),
  };
}

/**
 * Run one scenario twice through the graph and compare with the M0.2 comparator.
 *
 * Until M12 this compared the graph against `runConductor`. The kernel driver is now
 * deleted, so there is no second implementation to shadow — and that is the point of
 * deleting it. What this still proves is **determinism**: the same command and the same
 * handler results must produce the same stream, ids included, every time. The standing
 * cross-implementation oracle is `replay/golden-corpus.test.ts`, which compares against
 * behaviour RECORDED before the cutover rather than against a live twin.
 */
async function shadow(
  scenario: { name: string; command?: Command; over?: Partial<ConductorHandlers> },
  signals?: { kernel?: AbortSignal; graph?: AbortSignal },
) {
  const cmd = scenario.command ?? command;
  const first = await collect(runAgentGraph(cmd, handlers(scenario.over), signals?.kernel));
  const second = await collect(runAgentGraph(cmd, handlers(scenario.over), signals?.graph));
  return compareSessions(toGoldenSession(scenario.name, 'x'.repeat(50), 'p', first), second);
}

describe('M6.2 — the graph reproduces the kernel byte for byte', () => {
  const scenarios: { name: string; over?: Partial<ConductorHandlers>; command?: Command }[] = [
    { name: 'single-turn' },
    {
      name: 'multi-turn',
      over: {
        async *runTurn(_effect, state) {
          yield marker('turn');
          return turn(state, { done: state.stepIndex >= 1, endSeq: state.seq + 3 });
        },
      },
    },
    {
      name: 'plan-first',
      command: { ...command, kind: 'submit_turn', mode: 'agent' } as Command,
    },
    {
      name: 'aborted-turn',
      over: {
        async *runTurn(_effect, state) {
          yield marker('turn');
          return turn(state, { aborted: true, endSeq: state.seq + 3 });
        },
      },
    },
    {
      name: 'tool-cancelled-mid-turn',
      over: {
        async *runTurn(_effect, state) {
          yield marker('turn');
          return turn(state, { anyToolCancelled: true, endSeq: state.seq + 3 });
        },
      },
    },
    {
      name: 'verification-failed',
      over: {
        async *runVerify(_effect, state) {
          yield marker('verify');
          return {
            ...verified(state),
            ok: false,
            summary: 'drifted',
            failedChecks: ['captions'],
            endSeq: state.seq + 2,
          };
        },
      },
    },
    { name: 'chat-mode', command: { ...command, mode: 'chat' } as Command },
    {
      // Reaches the `draft_plan` node and, above the threshold, `await_approval` —
      // the two nodes M9 attaches interrupts to.
      name: 'plan-approval-gate',
      command: {
        ...command,
        agentOptions: {
          planFirst: true,
          requirePlanApproval: true,
        },
      } as Command,
      over: {
        async *draftPlan(_effect, state) {
          yield marker('draft');
          return {
            kind: 'draft_plan',
            // PLAN_APPROVAL_STEP_THRESHOLD is 10 and the check is strictly greater,
            // so eleven steps is what actually engages the gate.
            labels: Array.from({ length: 11 }, (_v, i) => `step ${String(i + 1)}`),
            endSeq: state.seq + 1,
          };
        },
      },
    },
    {
      // Reaches the `resume` node: an interrupted run continuing from its checkpoint.
      name: 'resume-checkpoint',
      command: {
        ...command,
        // `resuming` requires ops.length > 0: an empty checkpoint is not a resume, it is
        // a fresh run, so an empty `ops` array would quietly take the normal path.
        agentOptions: {
          resume: {
            ops: [
              { type: 'trim_clip', clipId: 'clip_a', start: 1, end: 5 },
            ] as unknown as AgentTurnResult['appliedOps'],
            log: ['trimmed the intro'],
            stepsCompleted: 1,
          },
        },
      } as Command,
      over: {
        async *resume(_effect, state) {
          yield marker('resume');
          return {
            kind: 'resume',
            ok: true,
            ops: [],
            log: ['trimmed the intro'],
            stepsCompleted: 1,
            endSeq: state.seq + 1,
          };
        },
      },
    },
  ];

  it.each(scenarios.map((s) => [s.name, s] as const))('%s diverges nowhere', async (_n, s) => {
    const comparison = await shadow(s);
    expect(comparison.identical, formatComparison(comparison)).toBe(true);
  });

  it.each([
    ['plan-approval-gate', 'approval'],
    ['resume-checkpoint', 'resume'],
  ])('%s actually reaches its node, so the parity above is not vacuous', async (name, mark) => {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    const outcome = await collect(
      runAgentGraph(scenario?.command ?? command, handlers(scenario?.over)),
    );
    expect(outcome.events.some((event) => event.id === `shadow:${mark}`)).toBe(true);
  });

  it('produces identical event IDS, which is the §7.4 contract itself', async () => {
    const kernel = await collect(runAgentGraph(command, handlers()));
    const graph = await collect(runAgentGraph(command, handlers()));
    // Compared explicitly as well as through the comparator: id equality is the single
    // property the sidebar, the WAL and the replay harness all depend on, and a
    // comparator change must never be able to stop checking it by accident.
    expect(graph.events.map((event) => event.id)).toEqual(kernel.events.map((event) => event.id));
  });
});

describe('M6 — the graph is a drop-in for the kernel driver', () => {
  it('rethrows a handler’s thrown value unchanged, as the driver does', async () => {
    const thrower = handlers({
      async *runTurn() {
        yield* [];
        throw 'not-an-error-object';
      },
    });
    await expect(collect(runAgentGraph(command, thrower))).rejects.toBe('not-an-error-object');
  });

  it('delivers events emitted before a throw', async () => {
    const thrower = handlers({
      async *runTurn() {
        yield marker('before-throw');
        throw new Error('boom');
      },
    });
    const events: AiEvent[] = [];
    await expect(
      (async () => {
        for await (const event of runAgentGraph(command, thrower)) events.push(event);
      })(),
    ).rejects.toThrow('boom');
    expect(events.some((event) => event.id === 'shadow:before-throw')).toBe(true);
  });

  it('lets the handlers own cancellation, so the run settles rather than being torn down', async () => {
    const controller = new AbortController();
    const cancelling = handlers({
      async *runTurn(_effect, state, signal) {
        yield marker('turn-started');
        controller.abort();
        expect(signal?.aborted).toBe(true);
        yield marker('settled-as-cancelled');
        return turn(state, { aborted: true, endSeq: state.seq + 3 });
      },
    });
    const outcome = await collect(runAgentGraph(command, cancelling, controller.signal));
    const markers = outcome.events
      .filter((event) => event.id.startsWith('shadow:'))
      .map((event) => (event.type === 'notification' ? event.text : event.type));
    expect(markers).toEqual(['turn-started', 'settled-as-cancelled', 'finalize']);
  });

  // The two runtime-selection tests that lived here — that a mistyped
  // `FRAMEPILOT_AI_ORCHESTRATOR` fell back to the kernel, and that reading it did not
  // throw where there is no `process` — went with the flag itself in M12 (ADR 0103).
  // The renderer-safety guard was not dropped; it moved to `useLangChainProvider`, the
  // one env read still on the agent path, in `langchain-providers.test.ts`.

  it('names a node per effect kind, which is what M9 attaches interrupts to', () => {
    expect(Object.values(GRAPH_NODES)).toEqual([
      'dispatch',
      'select_effect',
      'draft_plan',
      'resume',
      'await_approval',
      'run_turn',
      'verify',
      'finalize',
    ]);
  });
});
