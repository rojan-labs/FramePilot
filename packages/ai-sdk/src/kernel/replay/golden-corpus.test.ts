/**
 * The M0.2 golden-session corpus (plan/LANGCHAIN-MIGRATION.md M0.2).
 *
 * Records each named session to `src/__fixtures__/golden-sessions/*.json` and asserts
 * the live `streamAgent` still reproduces it — event stream **including ids**, the
 * operations produced, and the terminal status.
 *
 * ## Why this exists as files rather than a vitest snapshot
 *
 * `streamAgent-golden.test.ts` already snapshots event streams and is the K1.3 cutover
 * gate; it is not being replaced. But a snapshot belongs to the test that wrote it,
 * and from M6 onward the corpus has to be *loadable* — shadow mode compares two live
 * paths per run and reports divergences, which needs the recordings as data and a
 * comparator that returns a list rather than a boolean. That is `golden-session.ts`.
 *
 * ## Regenerating
 *
 * `FRAMEPILOT_GOLDEN_UPDATE=1 pnpm --filter @framepilot/ai-sdk test golden-corpus`
 * rewrites the fixtures. A regenerated fixture is a **behavior change** and belongs in
 * its own reviewed commit — the whole point is that it cannot move silently.
 *
 * ## Scenario coverage, against M0.2's list
 *
 * M0.2 names nine scenarios that must appear. Each is below with the reason it is
 * load-bearing; two are covered by a different mechanism and say so rather than being
 * quietly dropped.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator, type StreamOptions } from '../../orchestrator.js';
import type { AgentOptions } from '../../agent.js';
import type { AiEvent } from '../../events.js';
import type { ContextInput } from '../../context-builder.js';
import type { HostToolExecutor } from '../../tool-executor.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from '../../providers/types.js';
import type { AnyOperation } from '@framepilot/editor-core';
import { makeProject } from '../../__fixtures__/project.js';
import {
  compareSessions,
  formatComparison,
  parseSession,
  serializeSession,
  toGoldenSession,
  type RunOutcome,
} from './golden-session.js';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '__fixtures__',
  'golden-sessions',
);

const UPDATE = process.env.FRAMEPILOT_GOLDEN_UPDATE === '1';

const project = makeProject();

const options = (signal?: AbortSignal): StreamOptions => ({
  conversationId: 'conv_golden',
  turnId: 'turn_golden',
  now: () => 1000,
  ...(signal ? { signal } : {}),
});

/** Replays a fixed script of provider responses, then repeats the last one. */
class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  public constructor(private readonly responses: readonly AiResponse[]) {}
  public async complete(): Promise<AiResponse> {
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return response as AiResponse;
  }
}

/** Aborts mid-model-call — the user pressing Stop while the model is answering. */
class AbortingProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public constructor(
    private readonly controller: AbortController,
    private readonly response: AiResponse,
  ) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.controller.abort();
    return this.response;
  }
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args,
});
const turn = (...calls: ReturnType<typeof call>[]): AiResponse => ({ text: '', toolCalls: calls });
const done: AiResponse = { text: 'done', toolCalls: [] };
const del = (id: string, start: number, end: number) =>
  call(id, 'delete_range', { trackId: 'video_1', start, end });

interface Scenario {
  readonly name: string;
  readonly covers: string;
  readonly prompt: string;
  readonly build: () => {
    provider: AiProvider;
    signal?: AbortSignal;
    executor?: HostToolExecutor;
  };
  readonly agentOptions?: AgentOptions;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'wipe-guard-trigger',
    covers:
      'A delete that would clear EVERY clip on a multi-clip track. wipe-guard must refuse ' +
      'the call rather than let the model "start over" on the user\'s timeline (§5.3, risk 8). ' +
      'This is the session M4/M6 must pass on both tool paths. NOTE the prompt: it deliberately ' +
      'contains no reset/removal words, because `wipeGuardFor` DISABLES the guard when the user ' +
      'themselves asked for a wipe — a prompt like "start over" would record the non-trigger ' +
      'path while appearing to test the guard.',
    prompt: 'make the opening punchier',
    // `clip_a` (0-6) and `clip_b` (6-10) are every clip on video_1; 0-10 clears the track.
    build: () => ({ provider: new ScriptedProvider([turn(del('w', 0, 10)), done]) }),
  },
  {
    name: 'load-skill-chain',
    covers:
      'A read tool (`load_skill`) resolved before an edit — the ADR 0057 on-demand skill ' +
      'path. Pins that a read round trip does not disturb the event sequence the edit then ' +
      'continues.',
    prompt: 'tighten the intro using your pacing playbook',
    build: () => ({
      provider: new ScriptedProvider([
        turn(call('s', 'load_skill', { name: 'pacing' })),
        turn(del('c1', 0, 3)),
        done,
      ]),
    }),
  },
  {
    name: 'cancel-mid-model-call',
    covers:
      'Stop pressed while the model is answering. The run must settle honestly as cancelled ' +
      'with the work so far intact — the exact contract the LangGraph driver broke by ' +
      'discarding a whole superstep on abort (risk 2).',
    prompt: 'tighten the intro',
    build: () => {
      const controller = new AbortController();
      return {
        provider: new AbortingProvider(controller, turn(del('c1', 0, 3))),
        signal: controller.signal,
      };
    },
  },
  {
    name: 'plan-approval',
    covers:
      'The plan-first path (ADR 0051): a plan is drafted before any edit. M9 turns this into ' +
      'a LangGraph interrupt and must reproduce this stream.',
    prompt: 'tighten the intro',
    build: () => ({
      provider: new ScriptedProvider([
        { text: '1. Trim the dead air\n2. Tighten the intro', toolCalls: [] },
        turn(del('c1', 0, 3)),
        done,
      ]),
    }),
    agentOptions: { planFirst: true },
  },
  {
    name: 'ask-user-round-trip',
    covers:
      'The `ask` primitive: the model asks a question of its own authorship. Without a host ' +
      'resolver the run must end honestly rather than invent an answer (ADR 0059).',
    prompt: 'make it punchier',
    build: () => ({
      provider: new ScriptedProvider([
        turn(
          call('a', 'ask_user', {
            question: 'Which section should I tighten first?',
            options: ['The intro', 'The demo'],
          }),
        ),
        done,
      ]),
    }),
  },
  {
    name: 'multi-turn-cache-boundary',
    covers:
      'Three model turns in one run — the shape the prompt-cache boundary exists for (§7.3). ' +
      'The stream must stay identical turn over turn so a cache-affecting change to message ' +
      'assembly shows up here.',
    prompt: 'tighten the intro and the outro',
    build: () => ({
      provider: new ScriptedProvider([turn(del('c1', 0, 2)), turn(del('c2', 8, 9)), done]),
    }),
  },
  {
    name: 'loop-detector-stop',
    covers:
      'The model repeating one read with no progress. `loop-detector.ts` must converge and ' +
      'stop the run rather than burn the turn cap — the predicate M3 extracts and a M6 graph ' +
      'edge calls.',
    prompt: 'what is on the timeline?',
    build: () => ({
      provider: new ScriptedProvider([turn(call('r', 'get_timeline', {}))]),
    }),
  },
  {
    name: 'unavailable-tool-refusal',
    covers:
      'A registered-but-unavailable tool (`detect_faces`). PRD §23 requires refusal at ' +
      'invocation, never a fabricated result — the invariant §5.3 puts INSIDE the tool ' +
      'wrapper so it holds whatever calls the tool.',
    prompt: 'who is on screen?',
    build: () => ({
      provider: new ScriptedProvider([turn(call('f', 'detect_faces', {})), done]),
    }),
  },
  {
    name: 'rejected-patch-invalid-op',
    covers:
      'A tool call whose operation cannot validate against the project. The run must reject ' +
      'the operation and settle honestly rather than apply a partial or invented edit ' +
      '(ADR 0083 fails closed).',
    prompt: 'trim the missing clip',
    build: () => ({
      provider: new ScriptedProvider([
        turn(call('t', 'trim_clip', { clipId: 'does_not_exist', start: 0, end: 2 })),
        done,
      ]),
    }),
  },
];

async function runScenario(scenario: Scenario): Promise<RunOutcome> {
  const { provider, signal, executor } = scenario.build();
  const orchestrator = new Orchestrator(provider, executor ? { executor } : {});
  const events: AiEvent[] = [];
  const input: ContextInput = { project, userPrompt: scenario.prompt };
  for await (const event of orchestrator.streamAgent(
    input,
    options(signal),
    scenario.agentOptions ?? {},
  )) {
    events.push(event);
  }
  // The operations a run produced are what the diff events carry — the same place the
  // sidebar reads them, so a divergence here is a divergence the user would see.
  //
  // ADR 0056 emits a diff PER TURN, and a multi-turn run may carry no combined diff at
  // all. Reading only combined diffs recorded zero operations for every session in this
  // corpus, including ones that plainly edited — so prefer a combined diff when the run
  // produced one, and otherwise concatenate the per-turn diffs in order.
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('M0.2 golden-session corpus', () => {
  it('covers every scenario M0.2 requires', () => {
    // Named explicitly so dropping one is a test failure, not an oversight.
    expect(SCENARIOS.map((s) => s.name).sort()).toEqual(
      [
        'ask-user-round-trip',
        'cancel-mid-model-call',
        'load-skill-chain',
        'loop-detector-stop',
        'multi-turn-cache-boundary',
        'plan-approval',
        'rejected-patch-invalid-op',
        'unavailable-tool-refusal',
        'wipe-guard-trigger',
      ].sort(),
    );
  });

  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    '%s reproduces its recorded session exactly',
    async (_name, scenario) => {
      const outcome = await runScenario(scenario);
      const file = join(FIXTURE_DIR, `${scenario.name}.json`);

      if (UPDATE) {
        mkdirSync(FIXTURE_DIR, { recursive: true });
        writeFileSync(
          file,
          serializeSession(
            toGoldenSession(scenario.name, scenario.covers, scenario.prompt, outcome),
          ),
          'utf8',
        );
        return;
      }

      const recorded = parseSession(readFileSync(file, 'utf8'));
      const comparison = compareSessions(recorded, outcome);
      // The formatted report is the assertion message so a failure names the diverging
      // paths directly, rather than dumping two thousand-event arrays.
      expect(comparison.identical, formatComparison(comparison)).toBe(true);
    },
  );

  it('keeps the recorded prompt and rationale with each session', () => {
    for (const scenario of SCENARIOS) {
      const recorded = parseSession(
        readFileSync(join(FIXTURE_DIR, `${scenario.name}.json`), 'utf8'),
      );
      expect(recorded.prompt).toBe(scenario.prompt);
      // `covers` is what a later phase reads when deciding whether a divergence is
      // acceptable; a fixture without it is a fixture nobody can judge.
      expect(recorded.covers.length).toBeGreaterThan(40);
    }
  });
});

/**
 * M7.2 — the corpus is the migration's acceptance test, and after M12 it is unconditional.
 *
 * These fixtures were recorded on the kernel path, before `kernel/driver.ts` was deleted
 * (ADR 0103). Every assertion above therefore compares kernel-era recordings against the
 * §4.1 graph — whole agent runs through the real orchestrator, matched **including event
 * ids**, which is the §7.4 contract the sidebar, the durable WAL and the replay harness
 * all depend on.
 *
 * There is deliberately no separate "run it on the graph" block here any more. While both
 * runtimes existed, M7.2 stubbed `FRAMEPILOT_AI_ORCHESTRATOR=graph` to force the new path
 * and stubbed a typo to prove a mistyped flag fell back rather than silently swapping the
 * runtime under real users. M12 removed the flag along with the runtime it selected, so
 * that block would have re-run the identical code with an environment variable nothing
 * reads — a test passing for a reason that no longer exists. The guarantee it carried is
 * not lost; it moved into the fixtures being kernel-era, which is why regenerating them
 * requires its own reviewed commit.
 *
 * `agent-graph.parity.test.ts` covers the driver seam directly with scripted handlers.
 * This file covers everything above it: message assembly, tool dispatch, patch assembly,
 * cost accounting and the settle path.
 */
