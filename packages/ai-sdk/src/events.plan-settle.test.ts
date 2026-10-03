/**
 * A plan checklist must not outlive its run.
 *
 * Run f8574746 died on a host error (its durable log overflowed); the run's only closing
 * events were an error and `status: failed`, and the plan dock kept a spinner on its
 * in-progress step indefinitely. The fold settles such a plan by LOG ORDER, so every way a
 * run can end is covered — including a recovered run whose terminal status carries a
 * synthetic turn id that matches no plan.
 */
import { describe, expect, it } from 'vitest';
import {
  type AiEvent,
  type PlanNode,
  type PlanStep,
  createConversationViewBuilder,
  createTurnEmitter,
  reduceEvents,
} from './events.js';

const STEPS: readonly PlanStep[] = [
  { id: 'step-1', label: 'Map the footage', status: 'completed' },
  { id: 'step-2', label: 'Cut the montage', status: 'running', detail: 'Placing shots' },
  { id: 'step-3', label: 'Check the rhythm', status: 'pending' },
];

const emitter = (turnId = 'turn_1') =>
  createTurnEmitter({ conversationId: 'conv_1', turnId, now: () => 1000 });

function planOf(events: readonly AiEvent[], id = 'turn_1:plan'): PlanNode {
  const node = reduceEvents(events).nodes.find((n) => n.kind === 'plan' && n.id === id);
  if (node?.kind !== 'plan') throw new Error(`no plan ${id}`);
  return node;
}

const statuses = (plan: PlanNode): readonly string[] => plan.steps.map((step) => step.status);

describe('reduceEvents — a plan settles when its run ends', () => {
  it('keeps the live step running while the run is still going', () => {
    const e = emitter();
    const plan = planOf([e.userMessage('cut it'), e.plan(STEPS), e.status('executing')]);
    expect(statuses(plan)).toEqual(['completed', 'running', 'pending']);
  });

  it('settles unfinished steps as stopped after a host throw (error + failed)', () => {
    const e = emitter();
    const plan = planOf([
      e.userMessage('cut it'),
      e.plan(STEPS),
      e.error('Run "f8574746" exceeded the durable log limit.'),
      e.status('failed'),
    ]);
    // Stopped, never failed: the step did not go wrong, the run ended under it.
    expect(statuses(plan)).toEqual(['completed', 'stopped', 'stopped']);
  });

  it('settles on a user cancel', () => {
    const e = emitter();
    const plan = planOf([e.plan(STEPS), e.status('cancelled')]);
    expect(statuses(plan)).toEqual(['completed', 'stopped', 'stopped']);
  });

  it('settles on a recovered run whose terminal status carries a synthetic turn id', () => {
    const e = emitter();
    const recoveredTerminal: AiEvent = {
      id: 'durable-terminal:evt_9',
      conversationId: 'conv_1',
      turnId: 'durable-terminal:evt_9',
      ts: 2000,
      type: 'status',
      status: 'failed',
    };
    const plan = planOf([e.plan(STEPS), e.status('executing'), recoveredTerminal]);
    expect(statuses(plan)).toEqual(['completed', 'stopped', 'stopped']);
  });

  it('leaves a normally finalized plan exactly as its producer settled it', () => {
    const e = emitter();
    const finalized = STEPS.map((step) =>
      step.status === 'completed'
        ? step
        : { ...step, status: 'failed' as const, detail: 'The run ended before this step' },
    );
    const events = [e.plan(STEPS), e.plan(finalized), e.status('completed')];
    const plan = planOf(events);
    expect(statuses(plan)).toEqual(['completed', 'failed', 'failed']);
    expect(plan.steps[1]?.detail).toBe('The run ended before this step');
  });

  it('settles a plan from an earlier turn once the editor sends the next message', () => {
    // The earlier run left no terminal status at all (the app was killed mid-run); the
    // next message can only start a new run, so the old checklist is over.
    const first = emitter('turn_1');
    const second = emitter('turn_2');
    const events = [
      first.userMessage('cut it'),
      first.plan(STEPS),
      second.userMessage('now add captions'),
      second.plan([{ id: 'step-1', label: 'Write captions', status: 'running' }]),
      second.status('executing'),
    ];
    expect(statuses(planOf(events, 'turn_1:plan'))).toEqual(['completed', 'stopped', 'stopped']);
    expect(statuses(planOf(events, 'turn_2:plan'))).toEqual(['running']);
  });

  it('makes a plan live again when its producer re-emits it after the boundary', () => {
    const e = emitter();
    const resumed = STEPS.map((step) =>
      step.id === 'step-3' ? { ...step, status: 'running' as const } : step,
    );
    const plan = planOf([e.plan(STEPS), e.status('cancelled'), e.plan(resumed)]);
    expect(statuses(plan)).toEqual(['completed', 'running', 'running']);
  });

  it('does not touch the stored node — a settled plan keeps its identity across views', () => {
    const e = emitter();
    const builder = createConversationViewBuilder();
    builder.push(e.plan(STEPS));
    builder.push(e.status('failed'));
    const first = builder.view().nodes[0];
    builder.push(e.notification('later notice'));
    const second = builder.view().nodes[0];
    expect(second).toBe(first);
    expect(first?.kind === 'plan' && first.steps[1]?.status).toBe('stopped');
  });

  it('settles identically whether folded incrementally or in one shot', () => {
    const e = emitter();
    const events = [e.userMessage('go'), e.plan(STEPS), e.status('failed')];
    const builder = createConversationViewBuilder();
    for (const event of events) builder.push(event);
    expect(builder.view().nodes).toEqual(reduceEvents(events).nodes);
  });
});
