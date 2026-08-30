/**
 * P1.1's read cache, pinned.
 *
 * The mission ledger (`docs/reports/system-mission/01-call-classification.md`) found the
 * repetition concentrated in reads — `get_clips` 53 %, `get_timeline` 52 %, `get_clip`
 * 39 % — and every mutation at 0 %, and asked for a cache keyed on
 * `(tool, args, project revision)`.
 *
 * That cache exists: `kernel/evidence-store.ts` keys a read's payload on
 * `callMemoKey(call)` (tool + exact arguments) and `EvidenceStore.invalidate` drops every
 * `timeline_dependent` entry the moment an applied patch changes the arrangement — which
 * is what "project revision" means for a read, expressed as the thing that actually moves
 * it. Nothing in the suite asserted the pair end to end, so this does: a repeat read pays
 * nothing and says so, and a read after an edit is re-executed.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, type StreamOptions } from './orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from './providers/types.js';
import type { ContextInput } from './context-builder.js';
import type { AiEvent } from './events.js';
import { makeProject } from './__fixtures__/project.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten this' };
const opts = (): StreamOptions => ({ conversationId: 'c', turnId: 't', now: () => 1000 });

/** Emits one turn of tool calls, then finishes, keeping every request it was sent. */
class RecordingProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public readonly requests: AiCompletionRequest[] = [];
  private index = 0;
  public constructor(private readonly calls: readonly ToolCall[]) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    this.index += 1;
    return this.index === 1 ? { text: 'reading', toolCalls: [...this.calls] } : { text: 'done' };
  }
}

async function drain(stream: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Every note the run fed back to the model, across every request. */
function feedback(provider: RecordingProvider): string {
  return provider.requests
    .flatMap((request) => request.messages.map((message) => String(message.content)))
    .join('\n');
}

const MEMO_MARKER = 'unchanged since you last read it';

const read = (id: string): ToolCall => ({ id, name: 'get_clips', arguments: {} });
const trim: ToolCall = {
  id: 'm',
  name: 'trim_clip',
  arguments: { clipId: 'clip_a', start: 0, end: 4 },
};

async function run(calls: readonly ToolCall[]): Promise<RecordingProvider> {
  const provider = new RecordingProvider(calls);
  await drain(new Orchestrator(provider).streamAgent(input, opts(), { maxSteps: 3 }));
  return provider;
}

describe('the read memo (P1.1)', () => {
  it('serves a repeated read from the store and says so', async () => {
    const provider = await run([read('a'), read('b')]);
    const notes = feedback(provider);
    expect(notes.split(MEMO_MARKER).length - 1).toBe(1);
  });

  it('re-executes a read once an edit has moved the timeline', async () => {
    const provider = await run([read('a'), trim, read('b')]);
    expect(feedback(provider)).not.toContain(MEMO_MARKER);
  });

  it('does not confuse two reads with different arguments', async () => {
    const provider = await run([
      { id: 'a', name: 'get_clips', arguments: { trackId: 'video_1' } },
      { id: 'b', name: 'get_clips', arguments: { trackId: 'audio_1' } },
    ]);
    expect(feedback(provider)).not.toContain(MEMO_MARKER);
  });
});
