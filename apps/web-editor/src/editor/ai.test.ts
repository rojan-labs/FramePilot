/**
 * Tests for the AI panel glue: orchestrator factory + review-card projection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Orchestrator,
  type AiCompletionRequest,
  type AiProvider,
  type AiResponse,
} from '@framepilot/ai-sdk';
import { structuredDiffTimeline } from '@framepilot/editor-core';
import {
  createOrchestrator,
  historyFromEvents,
  probeEngineReachable,
  resolveEngineBaseUrl,
  toReviewCard,
} from './ai.js';
import { demoProject } from './demo.js';
import type { AiEvent } from '@framepilot/ai-sdk';

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public constructor(private readonly response: AiResponse) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    return this.response;
  }
}

describe('createOrchestrator', () => {
  it('returns an Orchestrator over the offline mock by default', () => {
    expect(createOrchestrator()).toBeInstanceOf(Orchestrator);
    expect(createOrchestrator('mock')).toBeInstanceOf(Orchestrator);
  });
});

describe('historyFromEvents', () => {
  const base = { id: 'e', conversationId: 'c', turnId: 't', ts: 0 };
  it('keeps only non-empty user/assistant messages, in order', () => {
    const events: AiEvent[] = [
      { ...base, type: 'user_message', text: 'cut intro' },
      { ...base, type: 'assistant_delta', parentId: 'a', chunk: 'ignored' },
      { ...base, type: 'assistant_message', text: 'done' },
      { ...base, type: 'status', status: 'completed' },
      { ...base, type: 'user_message', text: '  ' },
    ];
    expect(historyFromEvents(events)).toEqual([
      { role: 'user', content: 'cut intro' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('returns empty for a fresh conversation', () => {
    expect(historyFromEvents([])).toEqual([]);
  });

  it("keeps one assistant message per turn — the turn's last — so narration cannot crowd out the request", () => {
    // Run 6cb12e30: 28 narration messages in one agent turn filled the SDK's eight-message
    // window, and the follow-up "load the tools and complete the task" reached the model
    // without the brief it referred to.
    const turn = (turnId: string) => ({ ...base, turnId });
    const narration: AiEvent[] = Array.from({ length: 12 }, (_, index) => ({
      ...turn('t1'),
      type: 'assistant_message' as const,
      text: `step ${String(index)}`,
    }));
    const events: AiEvent[] = [
      { ...turn('t1'), type: 'user_message', text: 'THE BRIEF' },
      ...narration,
      { ...turn('t1'), type: 'assistant_message', text: 'Applied 83 edits' },
      { ...turn('t2'), type: 'user_message', text: 'load the tools and complete the task' },
      { ...turn('t2'), type: 'assistant_message', text: 'fading the music' },
      { ...turn('t2'), type: 'assistant_message', text: 'measuring the clips' },
    ];
    const history = historyFromEvents(events);
    expect(history).toEqual([
      { role: 'user', content: 'THE BRIEF' },
      { role: 'assistant', content: 'Applied 83 edits' },
      { role: 'user', content: 'load the tools and complete the task' },
      { role: 'assistant', content: 'measuring the clips' },
    ]);
    // Inside the SDK's eight-message window, which is the point.
    expect(history.slice(-8)[0]).toEqual({ role: 'user', content: 'THE BRIEF' });
  });
});

describe('toReviewCard', () => {
  it('projects a valid edit into a review card (why / what / op count)', async () => {
    const result = await createOrchestrator('mock').edit({
      project: demoProject,
      userPrompt: 'tighten intro',
    });
    const card = toReviewCard(result);
    expect(card.valid).toBe(true);
    expect(card.reason).toContain('intro');
    expect(card.operationCount).toBe(1);
    expect(card.problems).toEqual([]);
    // The before/after Timelines and their structured diff must survive the trip
    // from EditResult.diff onto the card unchanged (so a before/after player can
    // render them without recomputing anything).
    expect(card.before).toEqual(result.diff?.before);
    expect(card.after).toEqual(result.diff?.after);
    expect(card.before).not.toBe(card.after);
    expect(card.changedRegions.length).toBeGreaterThan(0);
    expect(card.changedRegions).toEqual(
      structuredDiffTimeline(result.diff!.before, result.diff!.after),
    );
  });

  it('surfaces validation problems for an inapplicable edit', async () => {
    const provider = new FakeProvider({
      text: 'delete a ghost track',
      toolCalls: [
        { id: 'c', name: 'delete_range', arguments: { trackId: 'ghost', start: 0, end: 1 } },
      ],
    });
    const result = await new Orchestrator(provider).edit({
      project: demoProject,
      userPrompt: 'x',
    });
    const card = toReviewCard(result);
    expect(card.valid).toBe(false);
    expect(card.changes).toEqual([]);
    expect(card.problems.length).toBeGreaterThan(0);
    // No diff was computed for an invalid patch — the before/after fields stay
    // absent rather than fabricating empty timelines.
    expect(card.before).toBeUndefined();
    expect(card.after).toBeUndefined();
    expect(card.changedRegions).toEqual([]);
  });
});

describe('resolveEngineBaseUrl', () => {
  it('defaults to the same host/port the desktop shell spawns its sidecar on', () => {
    // No VITE_FRAMEPILOT_PYTHON_API_URL is set in the test env — the plan P5.1
    // default must match apps/desktop/electron/main.ts's DEFAULT_ENGINE_HOST/PORT.
    expect(resolveEngineBaseUrl()).toBe('http://127.0.0.1:8765');
  });
});

describe('probeEngineReachable', () => {
  it('resolves true for a healthy (2xx) /health response', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('http://engine.local/health');
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchImpl);
    await expect(probeEngineReachable('http://engine.local')).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves false for a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    await expect(probeEngineReachable('http://engine.local')).resolves.toBe(false);
  });

  it('resolves false when fetch throws (network failure, e.g. ECONNREFUSED)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(probeEngineReachable('http://engine.local')).resolves.toBe(false);
  });

  it('resolves false when the probe exceeds timeoutMs (aborts, never hangs)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );
    await expect(probeEngineReachable('http://engine.local', { timeoutMs: 5 })).resolves.toBe(
      false,
    );
  });
});
