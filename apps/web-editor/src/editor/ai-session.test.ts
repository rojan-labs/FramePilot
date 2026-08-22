/**
 * Tests for the AiSession transport facade (Phase 11 M3): the browser session
 * streams the SDK directly; the desktop session drives the requestId-scoped IPC
 * push channel through a fake bridge (events in order, races buffered, foreign
 * requestIds ignored, errors surfaced, abort wired). No Electron.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiEvent } from '@framepilot/ai-sdk';
import type { AiStreamEventMessage, DurableRunEvent } from '@framepilot/shared-types';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { createAiSession, type AiSession, type AiSessionInput } from './ai.js';
import type { RendererBridge } from './bridge.js';

const project: Project = parseProject({
  id: 'p',
  name: 'D',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [{ id: 'asset_1', path: 'a.mp4', kind: 'video', durationSeconds: 30 }],
  timeline: {
    tracks: [
      {
        id: 'video_1',
        type: 'video',
        clips: [
          {
            id: 'c',
            assetId: 'asset_1',
            trackId: 'video_1',
            start: 0,
            end: 6,
            sourceStart: 0,
            sourceEnd: 6,
            effects: [],
            keyframes: [],
          },
        ],
      },
    ],
  },
  transcript: [],
  aiMemory: {},
  history: [],
});

const input: AiSessionInput = {
  project,
  userPrompt: 'tighten it',
  conversationId: 'conv_1',
  turnId: 'turn_1',
};

async function collect(
  session: AiSession,
  mode: 'auto' | 'chat' | 'edit' | 'agent',
  runInput: AiSessionInput = input,
): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of session.run(mode, runInput)) events.push(event);
  return events;
}

afterEach(() => {
  delete (window as { framepilot?: unknown }).framepilot;
  globalThis.localStorage?.clear();
});

describe('BrowserAiSession', () => {
  it('streams a chat run to a completed status', async () => {
    const events = await collect(createAiSession('mock'), 'chat');
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
    expect(events.some((e) => e.type === 'assistant_message')).toBe(true);
  });

  it('aborts mid-run to a cancelled status', async () => {
    const session = createAiSession('mock');
    const iterator = session.run('chat', input)[Symbol.asyncIterator]();
    const first = await iterator.next(); // status: thinking
    session.abort();
    const rest: AiEvent[] = first.value ? [first.value] : [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next())
      rest.push(next.value);
    expect(rest.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
  });

  // Review no longer gates the edit (ADR 0122): an unreachable reviewer says nothing about
  // the edit, so the proposal is delivered plainly and the run completes. What must remain
  // true is that the run never claims the work was perceptually checked.
  it('delivers the proposal and says review could not run when it is unavailable', async () => {
    const session = createAiSession('mock');
    const events = await collect(session, 'edit');
    const diff = events.find((event) => event.type === 'diff');
    expect(diff).toMatchObject({ type: 'diff' });
    expect(diff).not.toHaveProperty('verification', 'verified');
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
    const durable = JSON.parse(
      localStorage.getItem('framepilot:orchestration:v1:run:turn_1') ?? 'null',
    ) as { snapshot?: string } | null;
    expect(JSON.parse(durable?.snapshot ?? 'null')).toMatchObject({
      runId: 'turn_1',
      projectId: 'p',
      status: 'completed',
    });
    expect(session.recoveryConversationId?.('p')).toBeNull();
  });

  it('persists an accepted browser patch exactly once and never replays it after reload', async () => {
    const session = createAiSession('mock');
    const events = await collect(session, 'edit');
    const diff = events.find((event) => event.type === 'diff');
    expect(diff?.type).toBe('diff');
    if (diff?.type !== 'diff') throw new Error('Expected the edit route to propose a patch.');

    const key = 'framepilot:orchestration:v1:run:turn_1';
    const readDurable = (): {
      readonly snapshot: string;
      readonly wal: string;
      readonly runId: string;
      readonly updatedAt: number;
    } => JSON.parse(localStorage.getItem(key) ?? 'null') as {
      snapshot: string;
      wal: string;
      runId: string;
      updatedAt: number;
    };
    expect(JSON.parse(readDurable().snapshot)).toMatchObject({
      patchDecisions: [{ patchId: diff.edit.patch.patchId, state: 'pending' }],
    });

    session.decidePatch?.(diff.edit.patch.patchId, 'accepted', 3);
    await vi.waitFor(() => {
      expect(JSON.parse(readDurable().snapshot)).toMatchObject({
        currentProjectRevision: 3,
        outcome: { kind: 'completed_with_changes', changed: true },
        patchDecisions: [{
          patchId: diff.edit.patch.patchId,
          state: 'committed',
          projectRevision: 3,
        }],
      });
    });
    expect(session.patchRunId?.()).toBe('turn_1');

    session.decidePatch?.(diff.edit.patch.patchId, 'accepted', 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const acceptedEvents = readDurable().wal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string })
      .filter(({ kind }) => kind === 'run.patch_accepted');
    expect(acceptedEvents).toHaveLength(1);

    localStorage.setItem(
      'framepilot:browser-run-handle:v1:p',
      JSON.stringify({
        schemaVersion: 1,
        runId: 'turn_1',
        projectId: 'p',
        conversationId: 'conv_1',
      }),
    );
    const recovered = createAiSession('mock').recover?.('p', []);
    const recoveredEvents: AiEvent[] = [];
    if (recovered) for await (const event of recovered) recoveredEvents.push(event);
    expect(recoveredEvents.some((event) => event.type === 'diff')).toBe(false);
    expect(JSON.parse(readDurable().snapshot)).toMatchObject({
      patchDecisions: [{ patchId: diff.edit.patch.patchId, state: 'committed' }],
    });
  });

  it('classifies a browser run interrupted by reload without replaying its diff', async () => {
    const session = createAiSession('mock');
    await collect(session, 'edit');
    const key = 'framepilot:orchestration:v1:run:turn_1';
    const durable = JSON.parse(localStorage.getItem(key) ?? 'null') as {
      snapshot: string;
      wal: string;
      runId: string;
      updatedAt: number;
    };
    const snapshot = JSON.parse(durable.snapshot) as Record<string, unknown>;
    snapshot['status'] = 'executing';
    delete snapshot['outcome'];
    localStorage.setItem(key, JSON.stringify({ ...durable, snapshot: JSON.stringify(snapshot) }));
    localStorage.setItem(
      'framepilot:browser-run-handle:v1:p',
      JSON.stringify({
        schemaVersion: 1,
        runId: 'turn_1',
        projectId: 'p',
        conversationId: 'conv_1',
      }),
    );

    const recovered = session.recover?.('p', []);
    const events: AiEvent[] = [];
    if (recovered) for await (const event of recovered) events.push(event);
    expect(events.some((event) => event.type === 'diff')).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', message: expect.stringContaining('closed before') }),
      expect.objectContaining({ type: 'status', status: 'failed' }),
    ]));
    const persisted = JSON.parse(
      (JSON.parse(localStorage.getItem(key) ?? 'null') as { snapshot: string }).snapshot,
    ) as { outcome: { kind: string } };
    expect(persisted.outcome.kind).toBe('interrupted');
  });

  it.each([
    ['agent', {}],
    ['auto', {}],
  ] as const)('persists the %s editing route through the same terminal authority', async (mode, extra) => {
    const turnId = `turn_${mode}`;
    const session = createAiSession('mock');
    const events = await collect(session, mode, { ...input, ...extra, turnId });
    const diff = events.find((event) => event.type === 'diff');
    const durable = JSON.parse(
      localStorage.getItem(`framepilot:orchestration:v1:run:${turnId}`) ?? 'null',
    ) as { snapshot?: string } | null;
    const snapshot = JSON.parse(durable?.snapshot ?? 'null') as {
      status?: string;
      patchDecisions?: readonly { readonly patchId: string; readonly state: string }[];
    } | null;
    expect(['completed', 'failed', 'cancelled']).toContain(snapshot?.status);
    if (diff?.type === 'diff') {
      expect(snapshot?.patchDecisions).toContainEqual({
        patchId: diff.edit.patch.patchId,
        state: 'pending',
      });

      session.decidePatch?.(diff.edit.patch.patchId, 'accepted', 2);
      await vi.waitFor(() => {
        const latest = JSON.parse(
          (JSON.parse(
            localStorage.getItem(`framepilot:orchestration:v1:run:${turnId}`) ?? 'null',
          ) as { snapshot: string }).snapshot,
        ) as { patchDecisions: readonly { patchId: string; state: string }[] };
        expect(latest.patchDecisions).toContainEqual(expect.objectContaining({
          patchId: diff.edit.patch.patchId,
          state: 'committed',
        }));
      });
    } else {
      expect(snapshot?.patchDecisions).toEqual([]);
    }
    expect(localStorage.getItem('framepilot:browser-run-handle:v1:p')).toBeNull();
  });

});

/** A fake desktop bridge that replays scripted stream messages to its listener. */
function installStreamingBridge(
  messages: (requestId: string) => Omit<AiStreamEventMessage, 'requestId'>[],
): {
  abort: ReturnType<typeof vi.fn>;
} {
  const abort = vi.fn();
  let listener: ((m: AiStreamEventMessage) => void) | null = null;
  const bridge = {
    onAiStreamEvent: (l: (m: AiStreamEventMessage) => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    aiStreamStart: async () => {
      const requestId = 'req_42';
      // Push synchronously before resolving the id — exercises the buffer-before-id race.
      for (const message of messages(requestId)) listener?.({ requestId, ...message });
      return requestId;
    },
    aiStreamAbort: abort,
  } as unknown as RendererBridge;
  (window as { framepilot?: RendererBridge }).framepilot = bridge;
  return { abort };
}

describe('DesktopAiSession', () => {
  const ev = (text: string): AiEvent => ({
    id: text,
    conversationId: 'conv_1',
    ts: 1,
    turnId: 'turn_1',
    type: 'notification',
    text,
  });

  it('yields events in order, ignoring foreign requestIds, until done', async () => {
    installStreamingBridge(() => [
      { event: ev('one') },
      { requestId: 'other', event: ev('skip') } as never,
      { event: ev('two') },
      { done: true },
    ]);
    const events = await collect(createAiSession(), 'chat');
    expect(events.map((e) => (e.type === 'notification' ? e.text : ''))).toEqual(['one', 'two']);
  });

  it('sends the live project snapshot even when desktop has an authoritative revision', async () => {
    let listener: ((m: AiStreamEventMessage) => void) | null = null;
    const aiStreamStart = vi.fn(async () => {
      listener?.({ requestId: 'req_snapshot', done: true });
      return 'req_snapshot';
    });
    (window as { framepilot?: RendererBridge }).framepilot = {
      onAiStreamEvent: (next: (m: AiStreamEventMessage) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      aiStreamStart,
      aiStreamAbort: vi.fn(),
    } as unknown as RendererBridge;

    const events: AiEvent[] = [];
    for await (const event of createAiSession().run('chat', { ...input, projectRevision: 7 })) {
      events.push(event);
    }
    expect(events).toEqual([]);

    expect(aiStreamStart).toHaveBeenCalledWith(
      expect.objectContaining({ project, projectId: project.id, projectRevision: 7 }),
    );
  });

  it('routes an agent run over desktop IPC instead of executing in the renderer', async () => {
    let listener: ((m: AiStreamEventMessage) => void) | null = null;
    const aiStreamStart = vi.fn(async () => {
      listener?.({ requestId: 'req_route', done: true });
      return 'req_route';
    });
    (window as { framepilot?: RendererBridge }).framepilot = {
      onAiStreamEvent: (next: (m: AiStreamEventMessage) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      aiStreamStart,
      aiStreamAbort: vi.fn(),
    } as unknown as RendererBridge;

    await collect(createAiSession(), 'agent');

    expect(aiStreamStart).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: 'agent' }));
  });

  it('throws when the run reports an error', async () => {
    installStreamingBridge(() => [{ error: 'provider exploded' }]);
    const session = createAiSession();
    await expect(collect(session, 'chat')).rejects.toThrow('provider exploded');
  });

  it('wires abort() to the bridge with the active requestId', async () => {
    const { abort } = installStreamingBridge((requestId) => [
      { requestId, event: ev('one') } as never,
    ]);
    const session = createAiSession();
    const iterator = session.run('chat', input)[Symbol.asyncIterator]();
    await iterator.next(); // drain the first event so the requestId is active
    session.abort();
    expect(abort).toHaveBeenCalledWith('req_42');
  });

  it('persists one sourced cancel command for a durable Stop and does not race the legacy abort', async () => {
    let listener: ((message: AiStreamEventMessage) => void) | null = null;
    const aiStreamAbort = vi.fn();
    const runCommand = vi.fn().mockResolvedValue({});
    const bridge = {
      onAiStreamEvent: (next: (message: AiStreamEventMessage) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      runStart: vi.fn().mockResolvedValue({
        snapshot: { runId: 'run_1', projectId: 'p' },
        event: { sequence: 1 },
      }),
      aiStreamStart: async () => {
        listener?.({ requestId: 'req_durable', event: ev('started'), durableSequence: 2 });
        return 'req_durable';
      },
      aiStreamAbort,
      runCommand,
    } as unknown as RendererBridge;
    (window as { framepilot?: RendererBridge }).framepilot = bridge;
    const session = createAiSession();
    const iterator = session.run('chat', input)[Symbol.asyncIterator]();
    await iterator.next();

    session.abort();
    session.abort();
    await Promise.resolve();

    expect(aiStreamAbort).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith({
      runId: 'run_1',
      projectId: 'p',
      kind: 'cancel',
      payload: { source: 'user_stop', reason: 'Stopped by the editor.' },
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    session.detach?.();
    await iterator.next();
  });

  it('detaches a durable renderer without emitting any cancellation', async () => {
    let listener: ((message: AiStreamEventMessage) => void) | null = null;
    const aiStreamAbort = vi.fn();
    const runCommand = vi.fn();
    const bridge = {
      onAiStreamEvent: (next: (message: AiStreamEventMessage) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      runStart: vi.fn().mockResolvedValue({
        snapshot: { runId: 'run_1', projectId: 'p' },
        event: { sequence: 1 },
      }),
      aiStreamStart: async () => {
        listener?.({ requestId: 'req_durable', event: ev('started'), durableSequence: 2 });
        return 'req_durable';
      },
      aiStreamAbort,
      runCommand,
    } as unknown as RendererBridge;
    (window as { framepilot?: RendererBridge }).framepilot = bridge;
    const session = createAiSession();
    const iterator = session.run('chat', input)[Symbol.asyncIterator]();
    await iterator.next();

    session.detach?.();
    expect((await iterator.next()).done).toBe(true);
    expect(aiStreamAbort).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('can still cancel a durable run this renderer detached from', async () => {
    // Detaching drops the projection, not the host run. Forgetting the run here made Stop
    // a silent no-op on a live-but-detached run — it kept editing in the background with
    // nothing the user could press to end it.
    let listener: ((message: AiStreamEventMessage) => void) | null = null;
    const runCommand = vi.fn().mockResolvedValue({});
    const bridge = {
      onAiStreamEvent: (next: (message: AiStreamEventMessage) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      runStart: vi.fn().mockResolvedValue({
        snapshot: { runId: 'run_1', projectId: 'p' },
        event: { sequence: 1 },
      }),
      aiStreamStart: async () => {
        listener?.({ requestId: 'req_durable', event: ev('started'), durableSequence: 2 });
        return 'req_durable';
      },
      aiStreamAbort: vi.fn(),
      runCommand,
    } as unknown as RendererBridge;
    (window as { framepilot?: RendererBridge }).framepilot = bridge;
    const session = createAiSession();
    const iterator = session.run('chat', input)[Symbol.asyncIterator]();
    await iterator.next();

    session.detach?.();
    expect((await iterator.next()).done).toBe(true);

    session.abort();
    await Promise.resolve();
    expect(runCommand).toHaveBeenCalledWith({
      runId: 'run_1',
      projectId: 'p',
      kind: 'cancel',
      payload: { source: 'user_stop', reason: 'Stopped by the editor.' },
    });
  });
});

describe('DesktopAiSession — durable run recovery', () => {
  const RUN_HANDLE_KEY = 'framepilot:durable-run:p';
  const streamEvent = (seq: number, text: string): DurableRunEvent => ({
    schemaVersion: 1,
    eventId: `e${seq}`,
    runId: 'run_1',
    projectId: 'p',
    sequence: seq,
    occurredAt: 1,
    kind: 'run.stream_event',
    payload: { event: ev(text) },
  });
  const terminalEvent = (seq: number): DurableRunEvent => ({
    schemaVersion: 1,
    eventId: `e${seq}`,
    runId: 'run_1',
    projectId: 'p',
    sequence: seq,
    occurredAt: 1,
    kind: 'run.terminal',
    payload: { status: 'completed' },
  });

  const ev = (text: string): AiEvent => ({
    id: text,
    conversationId: 'conv_1',
    ts: 1,
    turnId: 'turn_1',
    type: 'notification',
    text,
  });

  function seedHandle(cursor = 0): void {
    globalThis.localStorage.setItem(
      RUN_HANDLE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        runId: 'run_1',
        projectId: 'p',
        conversationId: 'conv_1',
        cursor,
      }),
    );
  }

  // Regression: a run that reached a terminal state WHILE the sidebar was closed
  // replays its `run.terminal` in the initial buffered batch (not as a live message)
  // — and with a non-terminal/absent snapshot status. Before the fix the generator
  // fell through to the live-inbox wait and blocked forever, so AiSidebar never
  // cleared `running` and the composer stayed stuck on "Stop". Recovery must finish.
  it('completes recovery when the terminal event arrives in the buffered replay batch', async () => {
    seedHandle();
    const runUnsubscribe = vi.fn();
    const bridge = {
      runSubscribe: async () => ({
        subscriptionId: 'sub_1',
        snapshot: null, // deliberately no terminal status — only the event proves it ended
        events: [streamEvent(1, 'one'), terminalEvent(2)],
        hasMore: false,
      }),
      onRunEvent: () => () => {},
      runUnsubscribe,
      runAck: vi.fn(),
    } as unknown as RendererBridge;
    (window as { framepilot?: RendererBridge }).framepilot = bridge;

    const session = createAiSession();
    const iterable = session.recover?.('p', []);
    expect(iterable).toBeTruthy();

    const events: AiEvent[] = [];
    // If the generator hangs (the bug), this loop never ends and the test times out.
    for await (const event of iterable!) events.push(event);

    expect(
      events.filter((e) => e.type === 'notification').map((e) => (e as { text: string }).text),
    ).toEqual(['one']);
    // The replayed `run.terminal` also yields the matching status, so the recovered
    // conversation resolves instead of shimmering at its last streamed status.
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
    // The run handle is cleared, so the next mount does not try to recover a dead run.
    expect(globalThis.localStorage.getItem(RUN_HANDLE_KEY)).toBeNull();
    expect(runUnsubscribe).toHaveBeenCalledWith('sub_1');
  }, 2000);

  it('projects a terminal snapshot when cancellation settled before its terminal event replay', async () => {
    seedHandle(2);
    const bridge = {
      runSubscribe: async () => ({
        subscriptionId: 'sub_1',
        snapshot: {
          schemaVersion: 1,
          runId: 'run_1',
          projectId: 'p',
          status: 'cancelled',
          outcome: {
            kind: 'cancelled',
            source: 'user_stop',
            reason: 'Stopped by the editor.',
            changed: false,
            warnings: [],
          },
          baseProjectRevision: 0,
          currentProjectRevision: 0,
          lastSequence: 2,
          graphVersion: 1,
          tasks: [],
          effects: [],
          patchDecisions: [],
          budgets: {},
          contextHandles: [],
          patchPolicy: 'review',
          createdAt: 1,
          updatedAt: 2,
        },
        events: [],
        hasMore: false,
      }),
      onRunEvent: () => () => {},
      runUnsubscribe: vi.fn(),
      runAck: vi.fn(),
    } as unknown as RendererBridge;
    (window as { framepilot?: RendererBridge }).framepilot = bridge;

    const iterable = createAiSession().recover?.('p', []);
    const events: AiEvent[] = [];
    for await (const event of iterable!) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({ type: 'notification', text: 'Stopped by the editor.' }),
      expect.objectContaining({ type: 'status', status: 'cancelled' }),
    ]);
  });
});
