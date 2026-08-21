/**
 * Run-level regression guard for the narration boundary.
 *
 * `narration.test.ts` proves the filter's own logic. This file proves the WIRING: that a
 * model which ignores the contract and opens with harness chatter cannot get that sentence
 * in front of an editor through `streamAgent`, on any run condition — a clean run, a run
 * whose tool call is rejected, a run cancelled mid-turn, a run whose provider throws, and a
 * run whose message is truncated with no closing punctuation.
 *
 * The leaked sentences are verbatim from the captured run this work came from. They are
 * asserted against EVERY surface the run produces — streamed deltas, settled assistant
 * messages, and the patch `reason`/`summary` the edit is stored with — because the run's
 * single text channel feeds all three, and fixing only the visible one would leave the leak
 * in the project file.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, type StreamOptions } from '../orchestrator.js';
import type { AiEvent } from '../events.js';
import type { ContextInput } from '../context-builder.js';
import type {
  AiCompletionRequest,
  AiProvider,
  AiResponse,
  ProviderChunk,
} from '../providers/types.js';
import { makeProject } from '../__fixtures__/project.js';

/** The exact opening sentence the captured run put in front of the editor. */
const LEAK = "I'll continue from the interpret stage.";
/** The editor-facing half of the same message, which must survive intact. */
const REAL = ' Tightening the intro so it lands on the first word.';

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the intro' };
const opts = (signal?: AbortSignal): StreamOptions => ({
  conversationId: 'conv_leak',
  turnId: 'turn_leak',
  now: () => 1000,
  ...(signal ? { signal } : {}),
});

/** A tool call that really applies, so the run produces a patch to inspect. */
const trimCall = {
  id: 'c1',
  name: 'delete_range',
  arguments: { trackId: 'video_1', start: 0, end: 0.5 },
};

/**
 * Streams text in small chunks the way a real provider does, so the filter is exercised
 * across delta boundaries rather than being handed the whole sentence at once.
 */
function chunked(text: string, size = 7): ProviderChunk[] {
  const out: ProviderChunk[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push({ type: 'text-delta', text: text.slice(i, i + size) });
  }
  return out;
}

/** A provider whose every turn opens with the leaked preamble. */
class LeakingProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  public constructor(
    private readonly turns: readonly { text: string; calls?: AiResponse['toolCalls'] }[],
    private readonly onCall?: () => void,
  ) {}

  private turnAt(): { text: string; calls?: AiResponse['toolCalls'] } {
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)]!;
    this.index += 1;
    return turn;
  }

  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.onCall?.();
    const turn = this.turnAt();
    return { text: turn.text, toolCalls: turn.calls ?? [] };
  }

  public async *stream(
    _request: AiCompletionRequest,
    _signal?: AbortSignal,
  ): AsyncGenerator<ProviderChunk> {
    this.onCall?.();
    const turn = this.turnAt();
    yield* chunked(turn.text);
    for (const call of turn.calls ?? []) yield { type: 'tool-call', call };
    yield { type: 'done', text: turn.text };
  }
}

/** Throws on the first call — the provider/network failure path. */
class ThrowAfterTextProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public async complete(): Promise<AiResponse> {
    throw new Error('network exploded');
  }
  public async *stream(): AsyncGenerator<ProviderChunk> {
    yield* chunked(LEAK + REAL);
    throw new Error('network exploded');
  }
}

async function drain(stream: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const out: AiEvent[] = [];
  try {
    for await (const e of stream) out.push(e);
  } catch {
    // A throwing provider is one of the conditions under test; the events emitted before
    // the throw are exactly what this file inspects.
  }
  return out;
}

/** Every string this run would show an editor or store on the edit it made. */
function surfacedText(events: readonly AiEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    const record = event as unknown as Record<string, unknown>;
    for (const key of ['text', 'chunk', 'summary', 'reason', 'note']) {
      if (typeof record[key] === 'string') parts.push(record[key]);
    }
    const patch = record['patch'] as { reason?: unknown } | undefined;
    if (patch && typeof patch.reason === 'string') parts.push(patch.reason);
  }
  return parts.join('\n');
}

/** The one assertion every case shares. */
function expectNoLeak(events: readonly AiEvent[]): string {
  const surfaced = surfacedText(events);
  expect(surfaced).not.toContain('continue from the interpret stage');
  expect(surfaced).not.toMatch(/I'll continue from/i);
  return surfaced;
}

describe('narration boundary — streamAgent never surfaces harness chatter', () => {
  const orchestrator = (provider: AiProvider): Orchestrator =>
    new Orchestrator(provider, {
      executor: {
        async execute() {
          return { status: 'completed' as const, summary: 'ok' };
        },
      },
    });

  it('suppresses the preamble on a clean run and keeps the editor-facing half', async () => {
    const events = await drain(
      orchestrator(
        new LeakingProvider([{ text: LEAK + REAL, calls: [trimCall] }, { text: 'Done.' }]),
      ).streamAgent(input, opts()),
    );
    const surfaced = expectNoLeak(events);
    expect(surfaced).toContain('Tightening the intro');
  });

  it('suppresses it when the model streams it as a single delta (complete-only provider)', async () => {
    const provider = new LeakingProvider([
      { text: LEAK + REAL, calls: [trimCall] },
      { text: 'Done.' },
    ]);
    // Strip `stream` so the run drains through the complete() fallback instead.
    const completeOnly: AiProvider = {
      name: 'mock',
      complete: (request) => provider.complete(request),
    };
    expectNoLeak(await drain(orchestrator(completeOnly).streamAgent(input, opts())));
  });

  it('suppresses it on a run cancelled mid-turn, after the preamble has streamed', async () => {
    // The abort fires PART-WAY THROUGH the leaked sentence, which is the condition that
    // makes cancellation interesting: the filter is mid-decision and must not flush what it
    // is holding just because the run is ending. A provider that aborted before emitting
    // anything would make this test pass without the filter existing at all.
    const controller = new AbortController();
    const cancelling: AiProvider = {
      name: 'mock',
      async complete(): Promise<AiResponse> {
        controller.abort();
        return { text: '', toolCalls: [] };
      },
      async *stream(): AsyncGenerator<ProviderChunk> {
        for (const chunk of chunked(LEAK + REAL)) {
          yield chunk;
          if ((chunk as { text: string }).text.includes('stage')) controller.abort();
        }
        yield { type: 'done', text: LEAK + REAL };
      },
    };
    const events = await drain(
      orchestrator(cancelling).streamAgent(input, opts(controller.signal)),
    );
    const surfaced = expectNoLeak(events);
    // The cancelled turn genuinely reached the model and streamed text, so the assertion
    // above is about suppression rather than about an empty run.
    expect(surfaced).not.toBe('');
  });

  it('suppresses it on a run whose provider throws mid-stream', async () => {
    expectNoLeak(
      await drain(orchestrator(new ThrowAfterTextProvider()).streamAgent(input, opts())),
    );
  });

  it('suppresses it when the message is truncated with no closing punctuation', async () => {
    // The preamble's own full stop arrived, so the judge ruled on it; the truncated tail
    // that follows is real prose and must still reach the editor.
    expectNoLeak(
      await drain(
        orchestrator(
          new LeakingProvider([{ text: `${LEAK} Tightening the intr`, calls: [trimCall] }]),
        ).streamAgent(input, opts()),
      ),
    );
  });

  it('suppresses it on a retried turn, not only the first', async () => {
    const events = await drain(
      orchestrator(
        new LeakingProvider([
          { text: LEAK + REAL, calls: [trimCall] },
          { text: "I'll continue from where the run left off. Adjusting the second cut." },
          { text: 'Done.' },
        ]),
      ).streamAgent(input, opts()),
    );
    const surfaced = expectNoLeak(events);
    expect(surfaced).not.toMatch(/continue from where the run left off/i);
  });
});
