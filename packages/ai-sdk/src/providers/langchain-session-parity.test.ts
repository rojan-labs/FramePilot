/**
 * Whole-run behaviour through the Anthropic adapter, frozen as golden sessions.
 *
 * This began as M1.4 — golden-session parity for the LangChain provider (plan/LANGCHAIN-MIGRATION.md).
 *
 * M1.2 proved the two adapters put the **same bytes on the wire**. That is necessary and
 * not sufficient: a provider also has to produce the same *run*. Response parsing, tool-call
 * extraction and usage reporting all sit between the wire and the orchestrator, and a
 * difference in any of them changes the event stream the sidebar renders and the patch the
 * user gets — while the request bodies stay byte-identical.
 *
 * So this drives whole agent runs through **both** adapters against one scripted Anthropic
 * wire, and compares the results with the M0.2 comparator: event stream including ids,
 * operations, terminal status.
 *
 * Kept separate from `langchain-parity.test.ts` deliberately. That file compares one request;
 * this one compares an entire run, and when it fails the useful output is a divergence list,
 * not a body diff.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, type StreamOptions } from '../orchestrator.js';
import type { AgentOptions } from '../agent.js';
import type { AiEvent } from '../events.js';
import type { ContextInput } from '../context-builder.js';
import type { AnyOperation } from '@framepilot/editor-core';
import { makeProject } from '../__fixtures__/project.js';
import { LangChainAnthropicProvider } from './langchain.js';
import type { AiProvider, FetchLike, ProviderConfig } from './types.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareSessions,
  formatComparison,
  parseSession,
  serializeSession,
  toGoldenSession,
  type RunOutcome,
} from '../kernel/replay/golden-session.js';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/langchain-anthropic-sessions',
);

/** Set to rewrite the fixtures. A regenerated fixture is a behaviour change. */
const UPDATE = process.env['FRAMEPILOT_GOLDEN_UPDATE'] === '1';

const CONFIG: ProviderConfig = { name: 'anthropic', apiKey: 'test-key', model: 'claude-opus-4-8' };

const project = makeProject();

const options = (): StreamOptions => ({
  conversationId: 'conv_parity',
  turnId: 'turn_parity',
  now: () => 1000,
});

/** One scripted assistant turn, as Anthropic's Messages API would return it. */
interface WireTurn {
  readonly text?: string;
  readonly toolCalls?: readonly { id: string; name: string; input: Record<string, unknown> }[];
}

/**
 * Fixed usage for every turn, so cost events are comparable across the adapters.
 *
 * The cache counts are present deliberately: M1's token-accounting fix (LangChain
 * reports input_tokens as a TOTAL including the cache components, Anthropic reports
 * only the non-cached portion) is exactly what would make the two paths disagree here,
 * and a zero would hide it.
 */
const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 40,
  cache_creation_input_tokens: 10,
};

/** Render a scripted turn as a real Anthropic SSE stream. */
function wireStream(turn: WireTurn): string {
  const frames: string[] = [];
  const push = (type: string, payload: Record<string, unknown>): void => {
    frames.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  push('message_start', {
    message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: USAGE },
  });

  let index = 0;
  if (turn.text !== undefined) {
    push('content_block_start', { index, content_block: { type: 'text', text: '' } });
    push('content_block_delta', {
      index,
      delta: { type: 'text_delta', text: turn.text },
    });
    push('content_block_stop', { index });
    index += 1;
  }
  for (const call of turn.toolCalls ?? []) {
    push('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
    });
    // Tool input arrives as `input_json_delta` fragments that only parse once joined —
    // sending it in two pieces keeps that reassembly under test on both adapters.
    const json = JSON.stringify(call.input);
    const split = Math.floor(json.length / 2);
    push('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: json.slice(0, split) },
    });
    push('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: json.slice(split) },
    });
    push('content_block_stop', { index });
    index += 1;
  }

  push('message_delta', {
    delta: { stop_reason: (turn.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn' },
    usage: { output_tokens: USAGE.output_tokens },
  });
  push('message_stop', {});
  return frames.join('');
}

/**
 * A `fetch` replaying scripted turns in order, then repeating the last.
 *
 * Returns a real SSE `body` because `streamAgent` takes the streaming path — the
 * non-streaming shape made both adapters fail identically-in-spirit but with different
 * wording, which is a divergence about the harness rather than the adapters.
 */
function scriptedFetch(script: readonly WireTurn[]): FetchLike {
  let index = 0;
  return (async () => {
    const turn = script[Math.min(index, script.length - 1)] as WireTurn;
    index += 1;
    const sse = wireStream(turn);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }),
      json: async () => ({}) as unknown,
      text: async () => sse,
    };
  }) as unknown as FetchLike;
}

const del = (id: string, start: number, end: number) => ({
  id,
  name: 'delete_range',
  input: { trackId: 'video_1', start, end },
});

interface ParityScenario {
  readonly name: string;
  readonly covers: string;
  readonly prompt: string;
  readonly script: readonly WireTurn[];
  /** Operations the run must produce — pins that the scenario really exercised its path. */
  readonly expectedOperations: number;
  readonly agentOptions?: AgentOptions;
}

const SCENARIOS: readonly ParityScenario[] = [
  {
    name: 'single-edit',
    expectedOperations: 1,
    covers: 'One tool call applied — the ordinary path, and the one every run passes through.',
    prompt: 'tighten the intro',
    script: [{ toolCalls: [del('c1', 0, 3)] }, { text: 'done' }],
  },
  {
    name: 'multi-turn-edit',
    expectedOperations: 2,
    covers:
      'Two edit turns then a settle — exercises tool-call extraction repeatedly and the ' +
      'usage folding M1 had to fix (streamed usage arrives in two parts).',
    prompt: 'tighten the intro and the outro',
    script: [{ toolCalls: [del('c1', 0, 2)] }, { toolCalls: [del('c2', 8, 9)] }, { text: 'done' }],
  },
  {
    name: 'text-then-edit',
    expectedOperations: 1,
    covers:
      'An assistant turn carrying BOTH text and a tool call. Content flattening differs ' +
      'most between the adapters here, and text that leaks into the wrong channel is visible ' +
      'to the user.',
    prompt: 'trim the dead air',
    script: [
      { text: 'Trimming the dead air now.', toolCalls: [del('c1', 0, 3)] },
      { text: 'done' },
    ],
  },
  {
    name: 'no-op-run',
    expectedOperations: 0,
    covers:
      'The model declining to edit. Must settle identically rather than differ on an empty run.',
    prompt: 'is there anything to tighten?',
    script: [{ text: 'The intro is already tight.' }],
  },
  {
    name: 'wipe-guard-refusal',
    expectedOperations: 0,
    covers:
      'The wipe-guard refusal through a real provider adapter. §5.3 puts the invariant inside ' +
      'the tool path so it holds regardless of what produced the call — including which ' +
      'adapter parsed it.',
    prompt: 'make the opening punchier',
    script: [{ toolCalls: [del('w', 0, 10)] }, { text: 'done' }],
  },
];

async function runWith(provider: AiProvider, scenario: ParityScenario): Promise<RunOutcome> {
  const events: AiEvent[] = [];
  const input: ContextInput = { project, userPrompt: scenario.prompt };
  for await (const event of new Orchestrator(provider).streamAgent(
    input,
    options(),
    scenario.agentOptions ?? {},
  )) {
    events.push(event);
  }
  const diffs = events.filter(
    (event): event is Extract<AiEvent, { type: 'diff' }> => event.type === 'diff',
  );
  const combined = diffs.filter((diff) => diff.scope !== 'turn');
  const source = combined.length > 0 ? combined : diffs;
  const operations: AnyOperation[] = source.flatMap(
    (diff) => diff.edit.patch.operations as AnyOperation[],
  );
  return { events, operations };
}

describe('whole-run behaviour through the Anthropic adapter, frozen', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    '%s reproduces its recorded run exactly',
    async (_name, scenario) => {
      const outcome = await runWith(
        new LangChainAnthropicProvider(CONFIG, scriptedFetch(scenario.script)),
        scenario,
      );

      // Guard against a vacuous pass: a run that produced nothing would match an empty
      // recording and prove nothing.
      expect(outcome.events.length).toBeGreaterThan(4);
      expect(outcome.operations.length).toBe(scenario.expectedOperations);

      const file = join(FIXTURE_DIR, `${scenario.name}.json`);
      if (UPDATE) {
        mkdirSync(FIXTURE_DIR, { recursive: true });
        writeFileSync(
          file,
          serializeSession(
            toGoldenSession(scenario.name, scenario.covers, scenario.prompt, outcome),
          ),
        );
        return;
      }
      const comparison = compareSessions(parseSession(readFileSync(file, 'utf8')), outcome);
      expect(comparison.identical, formatComparison(comparison)).toBe(true);
    },
  );

  it('reports token accounting end to end, with the cache counts handled once', async () => {
    // The M1 defect this pins: LangChain reports `input_tokens` as a TOTAL that already
    // contains the cache components, while Anthropic's own count is the non-cached portion.
    // `usageFromMetadata` subtracts them back out; double-counting or failing to subtract
    // both show up here as a different `tokens` figure.
    //
    // Asserted on the aggregate the run actually emits, rather than against a second
    // adapter that no longer exists (ADR 0105). The raw per-response fields are pinned
    // directly in `langchain-parity.test.ts`; this is the same accounting seen from the
    // far end of the orchestrator, which is where a regression would reach the user's
    // cost display.
    const scenario = SCENARIOS[0] as ParityScenario;
    const outcome = await runWith(
      new LangChainAnthropicProvider(CONFIG, scriptedFetch(scenario.script)),
      scenario,
    );
    const usage = outcome.events.filter((event) => event.type === 'usage');
    expect(usage).toEqual([
      expect.objectContaining({ type: 'usage', tokens: 240, usd: 0.0012, modelCalls: 2 }),
    ]);
  });
});
