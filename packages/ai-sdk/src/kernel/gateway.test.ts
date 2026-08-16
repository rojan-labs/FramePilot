/**
 * Tests for the K0.1 kernel seam (plan/AI-ORCHESTRATION-REDESIGN.md §7).
 *
 * Two contracts:
 *  - `compileCommand` is a pure Command → EffectDescription mapping (table-tested).
 *  - `createInProcessGateway` is behavior-preserving: for every streaming mode the
 *    events it yields are byte-for-byte what the orchestrator yields directly, so
 *    wrapping today's loop as a single AgentEffect changes nothing observable.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, type StreamOptions } from '../orchestrator.js';
import { MockProvider } from '../providers/mock.js';
import type { AiEvent } from '../events.js';
import type { ContextInput } from '../context-builder.js';
import { makeProject } from '../__fixtures__/project.js';
import { compileCommand } from './effects.js';
import { createInProcessGateway } from './gateway.js';
import type { Command } from './commands.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the intro' };
const stream = (): StreamOptions => ({
  conversationId: 'conv_1',
  turnId: 'turn_1',
  now: () => 1000,
});

async function collect(events: AsyncIterable<AiEvent>): Promise<AiEvent[]> {
  const out: AiEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('compileCommand', () => {
  it('maps a submit_turn to exactly one agent effect, preserving fields', () => {
    const agentOptions = { maxSteps: 3 } as const;
    const command: Command = {
      kind: 'submit_turn',
      mode: 'agent',
      input,
      stream: stream(),
      agentOptions,
    };
    const effects = compileCommand(command);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ kind: 'agent', mode: 'agent', input, agentOptions });
  });

  it('omits agentOptions when the command carries none', () => {
    const command: Command = { kind: 'submit_turn', mode: 'chat', input, stream: stream() };
    const [effect] = compileCommand(command);
    expect(effect).not.toHaveProperty('agentOptions');
    expect(effect?.kind).toBe('agent');
    expect(effect && 'mode' in effect ? effect.mode : undefined).toBe('chat');
  });
});

describe('createInProcessGateway', () => {
  const modes = ['chat', 'plan', 'edit', 'agent'] as const;

  it.each(modes)('yields the same events as orchestrator.stream* for %s mode', async (mode) => {
    const direct = new Orchestrator(new MockProvider());
    const expected = await collect(
      mode === 'chat'
        ? direct.streamChat(input, stream())
        : mode === 'plan'
          ? direct.streamPlan(input, stream())
          : mode === 'edit'
            ? direct.streamEdit(input, stream())
            : direct.streamAgent(input, stream(), {}),
    );

    const gateway = createInProcessGateway(new Orchestrator(new MockProvider()));
    const actual = await collect(
      gateway.submit({ kind: 'submit_turn', mode, input, stream: stream() }),
    );

    expect(actual).toEqual(expected);
    expect(actual.length).toBeGreaterThan(0);
  });
});
