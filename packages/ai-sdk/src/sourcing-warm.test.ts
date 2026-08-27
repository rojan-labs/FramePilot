/**
 * 03 — a turn's sourcing downloads are acquired concurrently, then committed serially.
 *
 * In captured run `e36235cc` all eighteen `add_stock` calls ran strictly serially: each
 * call's start timestamp equalled the previous call's end. ~960 seconds — 16 of the run's
 * 30 minutes — with six failing. `search_stock` was already parallel; `add_stock` was
 * excluded by one `tool-contract.ts` row that conflates a network fetch with a timeline
 * patch.
 *
 * The COMMIT must stay serial: placement is computed against the turn's advancing project,
 * `buildAddStockOps` derives `nextLayerId` from `timeline.tracks.length` and mints
 * deterministic clip ids, so two placements against the same stale project would collide in
 * one patch. What overlaps is the DOWNLOAD, warmed ahead of the serial pass and then served
 * from the host's ledger dedupe at zero bytes.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, type StreamOptions } from './orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from './providers/types.js';
import type { HostToolOutcome } from './tool-executor.js';
import type { ContextInput } from './context-builder.js';
import type { AiEvent } from './events.js';
import { makeProject } from './__fixtures__/project.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'build a montage' };
const opts = (): StreamOptions => ({ conversationId: 'c', turnId: 't', now: () => 1000 });

/** Emits one turn of tool calls, then finishes. */
class OneTurnProvider implements AiProvider {
  public readonly name = 'mock' as const;
  private index = 0;
  public constructor(private readonly calls: readonly ToolCall[]) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.index += 1;
    return this.index === 1 ? { text: 'sourcing', toolCalls: [...this.calls] } : { text: 'done' };
  }
}

/** A host whose downloads take real time, recording how many overlapped. */
function recordingHost(delayMs: number) {
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];
  return {
    peak: () => peak,
    started,
    run: async (call: ToolCall): Promise<HostToolOutcome> => {
      if (call.name !== 'add_stock') {
        return { status: 'completed', summary: 'ok', data: {} };
      }
      started.push(String(call.arguments.remoteId));
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      // Deliberately not a valid StockAssetPayload: this asserts WHEN the host is called,
      // not placement, and a rejected payload leaves the timeline untouched.
      return { status: 'completed', summary: 'Downloaded', data: {} };
    },
  };
}

const stockCall = (index: number): ToolCall => ({
  id: `c${String(index)}`,
  name: 'add_stock',
  arguments: { remoteId: `r${String(index)}`, kind: 'video' },
});

async function drain(stream: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('sourcing downloads overlap', () => {
  it('issues a turn of add_stock downloads concurrently', async () => {
    const host = recordingHost(25);
    const calls = Array.from({ length: 6 }, (_, i) => stockCall(i));
    await drain(
      new Orchestrator(new OneTurnProvider(calls), {
        executor: { run: host.run as never },
      }).streamAgent(input, opts(), { maxSteps: 3 }),
    );
    // Every download was issued...
    expect(new Set(host.started)).toEqual(new Set(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']));
    // ...and more than one was in flight at a time, which is the whole change.
    expect(host.peak()).toBeGreaterThan(1);
  });

  it('never warms a lone call — there is nothing to overlap it with', async () => {
    const host = recordingHost(1);
    await drain(
      new Orchestrator(new OneTurnProvider([stockCall(0)]), {
        executor: { run: host.run as never },
      }).streamAgent(input, opts(), { maxSteps: 3 }),
    );
    // Exactly one host call: the serial commit. No speculative extra request.
    expect(host.started).toEqual(['r0']);
  });

  it('leaves non-sourcing calls alone', async () => {
    const host = recordingHost(1);
    const reads: ToolCall[] = [
      { id: 'a', name: 'get_timeline', arguments: {} },
      { id: 'b', name: 'list_assets', arguments: {} },
    ];
    await drain(
      new Orchestrator(new OneTurnProvider(reads), {
        executor: { run: host.run as never },
      }).streamAgent(input, opts(), { maxSteps: 3 }),
    );
    expect(host.started).toEqual([]);
  });
});
