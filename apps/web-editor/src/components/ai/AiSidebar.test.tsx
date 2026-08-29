/**
 * Shell tests (Phase 11 M4): empty state, mode switch, and a full streamed turn —
 * submitting a prompt streams events that render in place and drive the run status
 * to Completed. Uses an injected fake session (deterministic) + MemoryPersistence.
 */
import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnEmitter, type AiEvent, type EditResult } from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { createConversation } from '../../ai/conversation.js';
import { MemoryPersistence } from '../../ai/conversationPersistence.js';
import { resetConversationsRemountCache } from '../../ai/useConversations.js';
import type { AiSession, AiSessionInput } from '../../editor/ai.js';
import type { UseEditor } from '../../editor/useEditor.js';
import { AiConfigProvider } from '../../editor/useAiConfig.js';
import { SettingsProvider } from '../../editor/useSettings.js';
import { AiSidebar, type AiSidebarHandle, resetAiSidebarScrollCache } from './AiSidebar.js';

const fakeEdit = {
  text: 'Trim dead air',
  validation: { valid: true, issues: [] },
  diff: { summary: [] },
  patch: {
    patchId: 'p1',
    operations: [{ type: 'delete_range', trackId: 'video_1', start: 0, end: 3 }],
  },
} as unknown as EditResult;

/** A session that streams a single proposed diff then completes. */
class DiffSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('editing');
    yield e.diff(fakeEdit);
    yield e.status('completed');
  }
  public abort(): void {}
  public answer(): void {}
}

const project: Project = parseProject({
  id: 'p',
  name: 'D',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [],
  timeline: { tracks: [] },
  transcript: [],
  aiMemory: {},
  history: [],
});

/** A session that streams a scripted run (status → tool → assistant → completed). */
class FakeSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('thinking');
    yield e.toolCall('c1', 'find_silence', 'running');
    yield e.toolCall('c1', 'find_silence', 'completed', { runtimeMs: 10 });
    yield e.delta(e.assistantId, 'All ');
    yield e.delta(e.assistantId, 'set.');
    yield e.assistant(e.assistantId, 'All set.');
    yield e.status('completed');
  }
  public abort(): void {}
  public answer(): void {}
}

/** A two-step agent stream: each step opens its own reasoning node before its tool. */
class StepSequenceSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('thinking');
    yield e.reasoning(['Reading the timeline'], true, 1);
    yield e.toolCall('step:1', 'find_silence', 'completed');
    yield e.reasoning(['Checking the cut'], true, 2);
    yield e.toolCall('step:2', 'detect_scenes', 'completed');
    yield e.status('completed');
  }
  public abort(): void {}
  public answer(): void {}
}

/**
 * A run whose two thinking blocks share ONE node id — what a producer outside this
 * package (or a route with several model calls per turn) puts on the wire. The transcript
 * must keep both: the reported bug was the second block replacing the first in place.
 */
class ReusedThinkingIdSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('thinking');
    yield e.reasoning(['The intro drags'], false);
    yield e.reasoning(['The intro drags'], true);
    yield e.toolCall('c1', 'find_silence', 'completed');
    yield e.reasoning(['Now cut to the beat'], false);
    yield e.reasoning(['Now cut to the beat'], true);
    yield e.status('completed');
  }
  public abort(): void {}
  public answer(): void {}
}

/** A drafted plan remains one fixed checklist; it is not synthesized by the sidebar. */
class DraftedPlanSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.plan([
      { id: 'plan:1', label: 'Find pauses', status: 'completed' },
      { id: 'plan:2', label: 'Review the cut', status: 'pending' },
    ]);
    yield e.status('completed');
  }
  public abort(): void {}
  public answer(): void {}
}

/**
 * A run that streams `executing` then blocks until aborted, and on abort returns
 * CLEANLY with no terminal status event — modelling the desktop transport, where Stop
 * resolves the stream via `done`. The sidebar must finalize the turn itself, or the
 * conversation shimmers "in progress" forever (the reported bug).
 */
class BlockingSession implements AiSession {
  public aborts = 0;
  public detaches = 0;
  private release: (() => void) | null = null;
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('executing');
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  public abort(): void {
    this.aborts += 1;
    this.release?.();
  }
  public detach(): void {
    this.detaches += 1;
    this.release?.();
  }
  public answer(): void {}
}

/**
 * A session whose durable host run OUTLIVED the last mount: it advertises a recovery
 * conversation and hands back a stream the test drives event by event. `disposals`
 * counts how many times the recovery generator was torn down — the signal that this
 * renderer abandoned a still-live host run.
 */
class RecoveringSession implements AiSession {
  public aborts = 0;
  public detaches = 0;
  public recoveries = 0;
  public disposals = 0;
  private push: ((event: AiEvent | null) => void) | null = null;

  public constructor(private readonly conversationId: string) {}

  public async *run(): AsyncIterable<AiEvent> {
    // Recovery-only fixture; a fresh turn is never started in these tests.
  }
  public abort(): void {
    this.aborts += 1;
    this.emit(null);
  }
  public detach(): void {
    this.detaches += 1;
    this.emit(null);
  }
  public answer(): void {}
  public recoveryConversationId(): string | null {
    return this.conversationId;
  }
  public recover(): AsyncIterable<AiEvent> {
    this.recoveries += 1;
    return this.replay();
  }
  /** True while the consumer is parked waiting for the next event — i.e. still attached. */
  public get awaiting(): boolean {
    return this.push !== null;
  }
  /** Push the next recovered event into the live stream (`null` ends it). */
  public emit(event: AiEvent | null): void {
    const resume = this.push;
    this.push = null;
    resume?.(event);
  }
  private async *replay(): AsyncIterable<AiEvent> {
    try {
      for (;;) {
        const event = await new Promise<AiEvent | null>((resolve) => {
          this.push = resolve;
        });
        if (event === null) return;
        yield event;
      }
    } finally {
      this.disposals += 1;
    }
  }
}

function renderSidebar() {
  return render(
    <AiSidebar
      project={project}
      session={new FakeSession()}
      persistence={new MemoryPersistence()}
    />,
  );
}

// The conversation store deliberately survives a REMOUNT (a host auto-commit remounts
// the editor mid-run and must not lose the un-persisted tail of the event log), so it is
// module state. File-level, not per-describe: every mount in this file shares it.
afterEach(() => resetConversationsRemountCache());
// Same story for the stream's scroll continuity across that remount — module state that
// would otherwise leak one test's scroll position into the next test's first mount.
afterEach(() => resetAiSidebarScrollCache());

describe('AiSidebar', () => {
  // Apply mode and the "Plan first" toggle persist to localStorage; reset it so tests
  // don't leak the choice (a stale 'auto' would auto-apply diffs and remove the Accept
  // button elsewhere; a stale plan-first flag would flip the default).
  afterEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* no storage in this env */
    }
  });

  it('shows the empty state and switches mode', () => {
    renderSidebar();
    expect(screen.getByText(/Edit your video with AI/i)).toBeTruthy();
    // Example starter prompts prefill the composer.
    fireEvent.click(screen.getByRole('button', { name: 'Mute the music track' }));
    expect((screen.getByLabelText('Message FramePilot') as HTMLTextAreaElement).value).toBe(
      'Mute the music track',
    );
    // Mode is a single dropdown now: open it and pick Chat.
    fireEvent.click(screen.getByRole('button', { name: 'AI mode' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Chat/ }));
    expect(screen.getByRole('button', { name: 'AI mode' }).textContent).toContain('Chat');
  });

  it('streams a turn: user message + tool card + assistant render, then the composer goes quiet (#7)', async () => {
    renderSidebar();
    const input = screen.getByLabelText('Message FramePilot');
    fireEvent.change(input, { target: { value: 'Trim the intro' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('Trim the intro')).toBeTruthy());
    expect(screen.getByText('All set.')).toBeTruthy();
    expect(screen.getByText('Find silence')).toBeTruthy();
    // The composer shows activity ONLY while running; once settled it
    // shows nothing (no "Completed" badge) — the outcome lives in the stream (#7).
    expect(document.querySelector('.ai-composer-activity')).toBeNull();
    expect(screen.getByLabelText('Send')).toBeTruthy();
  });

  it('Stop finalizes a blocked run as cancelled — the composer goes quiet and Send returns', async () => {
    const session = new BlockingSession();
    render(<AiSidebar project={project} session={session} persistence={new MemoryPersistence()} />);
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'Trim the intro' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    // Mid-run the kill switch is showing (driven by `running`).
    await waitFor(() => expect(screen.getByLabelText('Stop agent')).toBeTruthy());
    // Stop aborts the session; the sidebar closes the turn out as cancelled even though
    // the transport returned with no terminal status of its own.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Stop agent'));
    });
    await waitFor(() => expect(screen.getByLabelText('Send')).toBeTruthy());
    expect(session.aborts).toBe(1);
    // The turn is preserved and the composer is quiet — a resolved run.
    expect(screen.getByText('Trim the intro')).toBeTruthy();
    expect(document.querySelector('.ai-composer-activity')).toBeNull();
  });

  it('detaches instead of cancelling when the sidebar unmounts mid-run', async () => {
    const session = new BlockingSession();
    const mounted = render(
      <AiSidebar project={project} session={session} persistence={new MemoryPersistence()} />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'Keep editing while the panel remounts' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByLabelText('Stop agent')).toBeTruthy());

    mounted.unmount();

    expect(session.detaches).toBe(1);
    expect(session.aborts).toBe(0);
  });

  it('stays attached to a recovered durable run instead of abandoning it in the background', async () => {
    // The reported bug: the recovery effect set `running` while also DEPENDING on it, so
    // React tore the recovery down on the next render. The subscription was dropped
    // milliseconds after it opened, the once-only guard refused to retry, and the host run
    // streamed on with no UI attached and a Stop button that reached nothing.
    const emitter = createTurnEmitter({
      conversationId: 'conv-recover',
      turnId: 't-recover',
    });
    const conversation = {
      ...createConversation({
        id: 'conv-recover',
        projectId: project.id,
        model: 'mock',
      }),
      events: [emitter.userMessage('Keep editing this conversation.')],
    };
    const session = new RecoveringSession(conversation.id);
    render(
      <AiSidebar
        project={project}
        session={session}
        persistence={new MemoryPersistence([conversation])}
      />,
    );
    // Hydration itself intentionally leaves activeId empty. Recovery must reselect the
    // durable run's conversation after an auto-commit project refresh remounts the editor.
    await waitFor(() => expect(screen.getByText('Keep editing this conversation.')).toBeTruthy());
    await act(async () => {
      session.emit(emitter.status('executing'));
    });
    // Still attached: the recovery generator was never disposed, and the kill switch the
    // recovered run needs is on screen.
    expect(session.recoveries).toBe(1);
    expect(session.disposals).toBe(0);
    await waitFor(() => expect(screen.getByLabelText('Stop agent')).toBeTruthy());
    // Events keep flowing: the consumer asked for the next one, and takes it.
    expect(session.awaiting).toBe(true);
    await act(async () => {
      session.emit(emitter.assistant(emitter.assistantId, 'Back on the timeline.'));
    });
    expect(session.disposals).toBe(0);
    expect(session.awaiting).toBe(true);
    // And Stop reaches the host run rather than silently doing nothing.
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Stop agent'));
    });
    expect(session.aborts).toBe(1);
  });

  it('New chat while a run is live stops it (single-session) and opens an empty chat', async () => {
    const session = new BlockingSession();
    render(<AiSidebar project={project} session={session} persistence={new MemoryPersistence()} />);
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'Trim the intro' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByLabelText('Stop agent')).toBeTruthy());
    // Open a new chat from the overflow menu while the run is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'New chat' }));
    });
    // The live run was stopped (never left orphaned) and the new chat is empty/idle.
    await waitFor(() => expect(screen.getByLabelText('Send')).toBeTruthy());
    expect(session.aborts).toBe(1);
    expect(screen.getByText(/Edit your video with AI/i)).toBeTruthy();
    expect(screen.queryByText('Trim the intro')).toBeNull();
  });

  it('copies the active conversation as a full Markdown transcript from the header menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <AiSidebar
        project={project}
        session={new FakeSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'Trim the intro' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy transcript' }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const md = String(writeText.mock.calls[0]?.[0]);
    expect(md).toContain('### 👤 You');
    expect(md).toContain('Trim the intro');
  });

  it('renders unplanned agent activity as ordered step-local thinking and tool rows, with no plan node', async () => {
    render(
      <AiSidebar
        project={project}
        session={new StepSequenceSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'Tighten this' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('Detect scenes')).toBeTruthy());

    expect(
      Array.from(document.querySelectorAll('.ai-event--reasoning, .ai-event--tool')).map(
        (event) => event.className,
      ),
    ).toEqual([
      'ai-event ai-event--reasoning',
      'ai-event ai-event--tool',
      'ai-event ai-event--reasoning',
      'ai-event ai-event--tool',
    ]);
    expect(document.querySelector('.ai-event--plan')).toBeNull();
    expect(screen.queryByText('Thinking…')).toBeNull();
    const settledReasoning = Array.from(document.querySelectorAll('.ai-reasoning-toggle'));
    expect(settledReasoning).toHaveLength(2);
    expect(settledReasoning.every((node) => node.getAttribute('aria-expanded') === 'false')).toBe(
      true,
    );
  });

  it('keeps every thinking block in the thread, each expandable on its own', async () => {
    // The reported bug: a second block of thinking wiped the first — the transcript kept
    // one accordion whose contents changed under the reviewer, at the earlier block's
    // position (above the tool card it actually followed). Both blocks stay, in order,
    // and opening one leaves the other exactly as the reviewer left it.
    render(
      <AiSidebar
        project={project}
        session={new ReusedThinkingIdSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'Tighten this' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('Find silence')).toBeTruthy());

    expect(
      Array.from(document.querySelectorAll('.ai-event--reasoning, .ai-event--tool')).map(
        (event) => event.className,
      ),
    ).toEqual([
      'ai-event ai-event--reasoning',
      'ai-event ai-event--tool',
      'ai-event ai-event--reasoning',
    ]);

    const toggles = Array.from(document.querySelectorAll('.ai-reasoning-toggle'));
    expect(toggles).toHaveLength(2);
    // The earlier rationale is still there to be read, not overwritten by the later one.
    fireEvent.click(toggles[0] as Element);
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(toggles[1]?.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('The intro drags')).toBeTruthy();
    expect(screen.getByText('Now cut to the beat')).toBeTruthy();
  });

  it('docks a drafted plan as a recent-first accordion above the activity stream', async () => {
    render(
      <AiSidebar
        project={project}
        session={new DraftedPlanSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'Plan the cut' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('Find pauses')).toBeTruthy());
    const plan = document.querySelector('.ai-plan-dock');
    expect(plan).toBeTruthy();
    expect(document.querySelector('.ai-stream .ai-event--plan')).toBeNull();
    expect(within(plan as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('Review the cut')).toBeNull();

    const toggle = within(plan as HTMLElement).getByRole('button', { name: /Plan/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(plan as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Review the cut')).toBeTruthy();
  });

  it('disables Send when the composer is empty', () => {
    renderSidebar();
    expect(screen.getByLabelText('Send').hasAttribute('disabled')).toBe(true);
  });

  it('exposes the accessibility structure the screen reader relies on (M9)', async () => {
    renderSidebar();
    // Landmark region + the mode dropdown (an accessible menu-button).
    expect(screen.getByRole('region', { name: 'AI assistant' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'AI mode' })).toBeTruthy();
    // The composer input is labelled; icon controls carry accessible names.
    expect(screen.getByLabelText('Message FramePilot')).toBeTruthy();
    expect(screen.getByLabelText('Send')).toBeTruthy();
    // New chat / History now live in the overflow menu.
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.getByRole('menuitem', { name: /History/ })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'hi' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('All set.')).toBeTruthy());
    // The list itself carries `role="list"` but NOT `aria-live` (D3a) — it is
    // virtualized/plain-rendered and rows mount/unmount as the user scrolls; an
    // aria-live region there would announce that churn, not genuinely new content.
    const list = document.querySelector('.ai-stream-inner');
    expect(list?.getAttribute('role')).toBe('list');
    expect(list?.hasAttribute('aria-live')).toBe(false);
    // A dedicated, visually-hidden live region (outside the list) exists for the
    // latest STREAMED assistant text; once a reply has settled (as here) it holds
    // nothing — the reader already heard it incrementally, and the settled text
    // is now visible in the bubble (see `liveAnnouncement.test.ts` for the
    // streaming-vs-settled derivation itself).
    const live = document.querySelector('.sr-only[aria-live="polite"]');
    expect(live?.getAttribute('role')).toBe('status');
    expect(live?.textContent).toBe('');
  });

  it('shows the active provider from config and threads it to the session', async () => {
    // The active provider is owned by Settings → AI (no in-header picker). On desktop
    // AiConfigProvider hydrates it from bridge.aiConfigGet; the sidebar shows a badge
    // and threads the provider into each run.
    const win = globalThis as unknown as { window: { framepilot?: unknown } };
    win.window.framepilot = {
      aiConfigGet: async () => ({
        activeProvider: 'anthropic',
        providers: [
          { name: 'anthropic', label: 'Claude (Anthropic)', model: 'claude-opus-4-8', ready: true },
          { name: 'mock', label: 'Offline mock', model: 'mock', ready: true },
        ],
      }),
    };
    const seen: (string | undefined)[] = [];
    class RecordSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        seen.push(input.provider);
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    try {
      render(
        <AiConfigProvider>
          <AiSidebar
            project={project}
            session={new RecordSession()}
            persistence={new MemoryPersistence()}
          />
        </AiConfigProvider>,
      );
      // The active model now lives in the overflow menu; open it to see the
      // configured provider once the async hydrate resolves, then close it.
      fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
      await screen.findByText('Claude (Anthropic)');
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'go' } });
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Send'));
      });
      await waitFor(() => expect(seen).toEqual(['anthropic']));
    } finally {
      delete win.window.framepilot;
    }
  });

  it('hands a plain command to the model-routed auto path (ADR 0055)', async () => {
    // Under ADR 0055 the sidebar no longer keyword-classifies. In Agent mode (the default)
    // every plain command dispatches `auto`, and the orchestrator's single classification
    // call decides chitchat/question/edit — so a request like "add an intro with
    // keyframes" is never hijacked by a greedy template match.
    const seen: { mode: string }[] = [];
    class RecordMode implements AiSession {
      public async *run(mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        seen.push({ mode });
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new RecordMode()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'add an intro using advanced keyframes' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.mode).toBe('auto');
  });

  it('threads range plus live interaction context into the request', async () => {
    // A minimal editor whose `state` carries a live 2-clip selection (0–3s, 3–8s) — the
    // shape `AiSidebar` actually reads (`state.selectedIds`/`state.timeline`), not a
    // full `useEditor` instance.
    const editor = {
      applyPatchChecked: vi.fn(() => []),
      state: {
        selection: 'c2',
        selectedIds: ['c1', 'c2'],
        playhead: 4,
        assets: [{ id: 'a', path: 'a.mp4', kind: 'video', durationSeconds: 10 }],
        timeline: {
          tracks: [
            {
              id: 't1',
              type: 'video',
              clips: [
                {
                  id: 'c1',
                  assetId: 'a',
                  trackId: 't1',
                  start: 0,
                  end: 3,
                  sourceStart: 0,
                  sourceEnd: 3,
                  effects: [],
                  keyframes: [],
                },
                {
                  id: 'c2',
                  assetId: 'a',
                  trackId: 't1',
                  start: 3,
                  end: 8,
                  sourceStart: 0,
                  sourceEnd: 5,
                  effects: [],
                  keyframes: [],
                },
              ],
            },
          ],
        },
      },
      getPlayhead: () => 4,
    } as unknown as UseEditor;
    const seen: AiSessionInput[] = [];
    class RecordSelection implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        seen.push(input);
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        projectRevision={12}
        editor={editor}
        sourceMonitor={{
          assetId: 'a',
          rate: { numerator: 30, denominator: 1 },
          playhead: { seconds: 2, frame: 60 },
          markedRange: { startFrame: 30, endFrame: 90 },
        }}
        session={new RecordSelection()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'go' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.selection).toEqual({ start: 0, end: 8 });
    expect(seen[0]?.interaction).toEqual({
      schemaVersion: 2,
      projectRevision: 12,
      timelineRevision: 0,
      sequenceId: 'p',
      playhead: { seconds: 4, frame: 120 },
      selection: {
        primaryClipId: 'c2',
        clipIds: ['c1', 'c2'],
        trackIds: ['t1'],
        effectLayerIds: [],
        keyframes: [],
        timeRange: { start: 0, end: 8 },
      },
      sourceMonitor: {
        assetId: 'a',
        rate: { numerator: 30, denominator: 1 },
        playhead: { seconds: 2, frame: 60 },
        markedRange: { startFrame: 30, endFrame: 90 },
      },
    });
  });

  it('captures newly imported assets from the live editor store when the turn starts', async () => {
    const imported = {
      id: 'asset_imported',
      path: 'media/imported.mp4',
      kind: 'video' as const,
      durationSeconds: 12,
    };
    const makeEditor = (assets: readonly (typeof imported)[]) =>
      ({
        applyPatchChecked: vi.fn(() => []),
        state: {
          selectedIds: [],
          timeline: { tracks: [] },
          assets,
          folders: [],
          markers: [],
          transcript: [],
        },
      }) as unknown as UseEditor;
    const seen: AiSessionInput[] = [];
    class RecordProject implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        seen.push(input);
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    const session = new RecordProject();
    const persistence = new MemoryPersistence();
    const view = render(
      <AiSidebar
        project={project}
        editor={makeEditor([])}
        session={session}
        persistence={persistence}
      />,
    );

    // App-level persistence still has the original empty project, while the editor
    // has already committed the import and is displaying its thumbnail.
    view.rerender(
      <AiSidebar
        project={project}
        editor={makeEditor([imported])}
        session={session}
        persistence={persistence}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'list my assets' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.project.assets).toEqual([imported]);
  });

  it('makes the selection-scoped direct_edit route reachable via hasSelection (P8.4)', async () => {
    // "tighten this" only routes to direct_edit when the router is told a selection is
    // live — routeCommand's own contract (router.test.ts). With no editor/selection it
    // must stay off that path (falls to the user's chosen mode, here the recipe/plan
    // paths never fire since there's no matching topic — it runs the session as-is).
    const seen: string[] = [];
    class RecordMode implements AiSession {
      public async *run(mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        seen.push(mode);
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    const editor = {
      applyPatchChecked: vi.fn(() => []),
      state: {
        selectedIds: ['c1'],
        timeline: {
          tracks: [
            {
              id: 't1',
              type: 'video',
              clips: [
                {
                  id: 'c1',
                  assetId: 'a',
                  trackId: 't1',
                  start: 0,
                  end: 3,
                  sourceStart: 0,
                  sourceEnd: 3,
                  effects: [],
                  keyframes: [],
                },
              ],
            },
          ],
        },
      },
    } as unknown as UseEditor;
    render(
      <AiSidebar
        project={project}
        editor={editor}
        session={new RecordMode()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'tighten this' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    // Sanity: the run still completes normally (the `direct_edit` kind is reachable
    // today only as a router-level classification — no dedicated execution branch
    // exists yet, so it runs on the sidebar's current mode, same as before).
    await waitFor(() => expect(seen).toHaveLength(1));
  });

  it('does not send a removed "Selected" chip as context for that turn (respects explicit removal)', async () => {
    const editor = {
      applyPatchChecked: vi.fn(() => []),
      state: {
        selectedIds: ['c1'],
        timeline: {
          tracks: [
            {
              id: 't1',
              type: 'video',
              clips: [
                {
                  id: 'c1',
                  assetId: 'a',
                  trackId: 't1',
                  start: 0,
                  end: 3,
                  sourceStart: 0,
                  sourceEnd: 3,
                  effects: [],
                  keyframes: [],
                },
              ],
            },
          ],
        },
      },
    } as unknown as UseEditor;
    const seen: AiSessionInput[] = [];
    class RecordSelection implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        seen.push(input);
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        editor={editor}
        session={new RecordSelection()}
        persistence={new MemoryPersistence()}
      />,
    );
    // The chip renders with a label derived from the selection (composerActions.ts);
    // clicking its remove button is the same affordance every other context/attachment
    // chip uses.
    const chipLabel = 'Selected: 1 clip, 0–3s';
    expect(screen.getByText(chipLabel)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(`Remove ${chipLabel}`));
    expect(screen.queryByText(chipLabel)).toBeNull();

    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'go' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(seen).toHaveLength(1));
    // Removed for THIS turn — never silently re-added, even though the selection
    // itself is still live in the editor.
    expect(seen[0]?.selection).toBeUndefined();
  });

  it('pins an entity via the "@" picker and threads it into the request as ContextInput.pinned (P8.7)', async () => {
    const pinProject: Project = parseProject({
      id: 'p',
      name: 'D',
      version: 1,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      assets: [{ id: 'a1', path: '/media/broll.mp4', kind: 'video' }],
      timeline: { tracks: [] },
      transcript: [],
      aiMemory: {},
      history: [],
    });
    const seen: AiSessionInput[] = [];
    class RecordPinned implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        seen.push(input);
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={pinProject}
        session={new RecordPinned()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'use @bro' },
    });
    fireEvent.click(screen.getByRole('option', { name: /broll\.mp4/ }));
    // The "@query" is consumed and the pin renders as its own removable chip.
    const textarea = screen.getByLabelText('Message FramePilot') as HTMLTextAreaElement;
    expect(textarea.value).toBe('use');
    expect(screen.getByText('broll.mp4')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'go' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.pinned).toEqual([{ kind: 'asset', id: 'a1', label: 'broll.mp4' }]);
  });

  it('does not send an explicitly-removed pinned chip for that turn (same honesty pattern as selection removal)', async () => {
    const pinProject: Project = parseProject({
      id: 'p',
      name: 'D',
      version: 1,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      assets: [{ id: 'a1', path: '/media/broll.mp4', kind: 'video' }],
      timeline: { tracks: [] },
      transcript: [],
      aiMemory: {},
      history: [],
    });
    const seen: AiSessionInput[] = [];
    class RecordPinned implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        seen.push(input);
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={pinProject}
        session={new RecordPinned()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'use @bro' },
    });
    fireEvent.click(screen.getByRole('option', { name: /broll\.mp4/ }));
    fireEvent.click(screen.getByLabelText('Remove broll.mp4'));
    expect(screen.queryByText('broll.mp4')).toBeNull();

    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'go' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.pinned).toBeUndefined();
  });

  it('shows an "Instant · no AI needed" chip after a recipe run that edited (P2.2/P7.2) — never a raw number', async () => {
    // A recipe session that produces an edit and reports its real (zero) cost, exactly
    // as `Orchestrator.streamRecipe` does (P7.1) — the sidebar surfaces the instant win
    // in creator language only, never a raw token/$ figure by default.
    class RecipeDiffSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('editing');
        yield e.diff(fakeEdit);
        yield e.usage({ tokens: 0, usd: 0 });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new RecipeDiffSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'remove the silences' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await screen.findByText('Instant · no AI needed');
    // The hard guardrail: no raw token/$ number anywhere in the default render.
    expect(screen.queryByText(/\d+ tokens/)).toBeNull();
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });

  it('shows an "AI edits used this session" chip (never a raw number) after a run with real, nonzero cost', async () => {
    class PricedRunSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('editing');
        yield e.diff(fakeEdit);
        yield e.usage({ tokens: 500, usd: 0.02 });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new PricedRunSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'remove the silences' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await screen.findByText('AI edits used this session');
    expect(screen.queryByText(/\d+ tokens/)).toBeNull();
    expect(screen.queryByText(/\$\d/)).toBeNull();
  });

  it('shows NO usage chip for a failed run — a $0 total there is missing data, not "instant"', async () => {
    // The regression: a provider that dropped the request reports no usage, so the run's
    // cost folded to zero and the sidebar captioned a FAILED run with the
    // deterministic-recipe phrase "Instant · no AI needed" (see the empty-response guard
    // in the SDK). A failed run's account is its error/warning, never a cost chip.
    class FailedRunSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('editing');
        yield e.usage({ tokens: 0, usd: 0 });
        yield e.status('failed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new FailedRunSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'remove the silences' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    // Wait for the run's own failure affordance before asserting the absence of the chip,
    // so this can't pass by checking too early.
    await screen.findByRole('button', { name: /retry/i });
    expect(screen.queryByText('Instant · no AI needed')).toBeNull();
    expect(screen.queryByText('AI edits used this session')).toBeNull();
  });

  it('updates the composer context ring from the latest exact orchestration event', async () => {
    class ContextSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.contextUsage({
          usedTokens: 20,
          contextWindow: 100,
          estimated: true,
        });
        yield e.contextUsage({
          usedTokens: 24,
          contextWindow: 100,
          estimated: false,
        });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new ContextSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'go' } });
    await act(async () => fireEvent.click(screen.getByLabelText('Send')));
    expect(await screen.findByRole('button', { name: /Context: 24 of 100 tokens/ })).toBeTruthy();
  });

  it('appends the raw token/$ numbers to the chip only when the dev/pro toggle is on (P7.2)', async () => {
    window.localStorage.setItem(
      'framepilot.settings',
      JSON.stringify({ showAiUsageDetails: true }),
    );
    class PricedRunSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('editing');
        yield e.diff(fakeEdit);
        yield e.usage({ tokens: 500, usd: 0.02 });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <SettingsProvider>
        <AiSidebar
          project={project}
          session={new PricedRunSession()}
          persistence={new MemoryPersistence()}
        />
      </SettingsProvider>,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'remove the silences' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await screen.findByText('AI edits used this session · 500 tokens · $0.0200');
  });

  it('threads the agent plan-first toggle into agentOptions (agent mode only)', async () => {
    const seen: AiSessionInput['agentOptions'][] = [];
    class RecordAgent implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        seen.push(input.agentOptions);
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new RecordAgent()}
        persistence={new MemoryPersistence()}
      />,
    );
    // Default mode is Agent → the plan-first toggle is present and on by default.
    const toggle = screen.getByTestId('ai-plan-first');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'edit it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    // P11.3: requirePlanApproval mirrors planFirst — the gate only ever fires when a
    // plan was actually drafted, so it's threaded 1:1 with the existing toggle.
    await waitFor(() => expect(seen).toEqual([{ planFirst: true, requirePlanApproval: true }]));

    // Turning it off threads planFirst:false (and the gate off with it) on the next run.
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'again' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(seen[1]).toEqual({ planFirst: false, requirePlanApproval: false }));

    // In Chat mode the toggle is hidden and no agent options are sent.
    fireEvent.click(screen.getByRole('button', { name: 'AI mode' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Chat/ }));
    expect(screen.queryByTestId('ai-plan-first')).toBeNull();
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'question' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(seen[2]).toBeUndefined());
  });

  it('persists the "Plan first" choice to localStorage and restores it on remount', async () => {
    const noop: AiSession = {
      async *run(_mode, input) {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      },
      abort() {},
      answer() {},
    };
    const { unmount } = render(
      <AiSidebar project={project} session={noop} persistence={new MemoryPersistence()} />,
    );
    // Default is on; turning it off writes through to storage.
    const toggle = screen.getByTestId('ai-plan-first');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(window.localStorage.getItem('framepilot.ai.planFirst')).toBe('false');

    // Remounting reads the persisted choice rather than the default.
    unmount();
    render(<AiSidebar project={project} session={noop} persistence={new MemoryPersistence()} />);
    expect(screen.getByTestId('ai-plan-first').getAttribute('aria-checked')).toBe('false');
  });

  it('threads an opt-in "2 alternatives" toggle into edit-mode requests only (H1.5/P13.1)', async () => {
    const seen: (boolean | undefined)[] = [];
    class RecordVariations implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        seen.push(input.variations);
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new RecordVariations()}
        persistence={new MemoryPersistence()}
      />,
    );
    // Default mode is Agent → no variations toggle at all (edit-mode only affordance).
    expect(screen.queryByTestId('ai-want-variations')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'AI mode' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));
    // Off by default — never silently on (cost-honesty: an extra take is a REAL,
    // separately billed model call).
    const toggle = screen.getByTestId('ai-want-variations');
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'add a text overlay that says thanks' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(seen).toEqual([undefined]));

    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'add a text overlay that says thanks' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(seen[1]).toBe(true));
  });

  it('hides the variations toggle on desktop (browser-only for this slice)', () => {
    const win = globalThis as unknown as { window: { framepilot?: unknown } };
    win.window.framepilot = {
      aiConfigGet: async () => ({ activeProvider: 'mock', providers: [] }),
    };
    try {
      renderSidebar();
      fireEvent.click(screen.getByRole('button', { name: 'AI mode' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));
      expect(screen.queryByTestId('ai-want-variations')).toBeNull();
    } finally {
      delete win.window.framepilot;
    }
  });

  it('offers Resume after an interrupted agent run and continues from the checkpoint', async () => {
    const resumes: AiSessionInput['agentOptions'][] = [];
    // First run cancels mid-flight, leaving a checkpoint; the second (resume) run reads it.
    class CheckpointSession implements AiSession {
      private runs = 0;
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        this.runs += 1;
        if (this.runs === 1) {
          yield e.status('thinking');
          yield e.checkpoint({
            goal: 'edit it',
            ops: [{ type: 'delete_range' }],
            log: ['Step 1'],
            stepsCompleted: 1,
          });
          yield e.status('cancelled');
        } else {
          resumes.push(input.agentOptions);
          yield e.status('completed');
        }
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new CheckpointSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'edit it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    // The cancelled run surfaces a Resume affordance.
    const resume = await screen.findByRole('button', { name: 'Resume' });
    await act(async () => {
      fireEvent.click(resume);
    });
    await waitFor(() => expect(resumes).toHaveLength(1));
    // Resume forwards the checkpoint's ops/steps so the SDK continues, not restarts.
    expect(resumes[0]?.resume).toMatchObject({ stepsCompleted: 1 });
    expect(resumes[0]?.resume?.ops).toEqual([{ type: 'delete_range' }]);
  });

  it('renders a run-level failure (e.g. the desktop max-run timeout) as an error card', async () => {
    // The desktop session THROWS for run-level failures (hub timeout, transport
    // error) rather than emitting an in-stream error event; the sidebar must show
    // the reason instead of silently stopping.
    class ThrowingSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('thinking');
        throw new Error('AI run exceeded the 30-minute limit and was stopped.');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new ThrowingSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'go' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText(/exceeded the 30-minute limit/)).toBeTruthy());
    // The run settles as failed — no stuck status label, composer usable again.
    expect(document.querySelector('.ai-composer-activity')).toBeNull();
  });

  // Auto is the only mode. Accept/Reject, "Apply all" and the apply-mode dropdown are
  // gone with the manual path — a validated edit applies as it lands and Undo takes it
  // back. These replace the decision-flow suite deliberately; see plan/INSTANT-APPLY.md.
  it('commits a streamed diff with no review click and no Accept button', async () => {
    const applyPatchChecked = vi.fn(() => []);
    const editor = { applyPatchChecked } as unknown as UseEditor;
    render(
      <AiSidebar
        project={project}
        editor={editor}
        session={new DiffSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'Trim it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(applyPatchChecked).toHaveBeenCalledWith(fakeEdit.patch));
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByText('Edited')).toBeTruthy();
  });

  it('surfaces a failure honestly when the patch no longer applies (stale timeline)', async () => {
    const applyPatchChecked = vi.fn(() => [
      { code: 'missing_reference', severity: 'error' as const, message: 'clip gone' },
    ]);
    const editor = { applyPatchChecked } as unknown as UseEditor;
    render(
      <AiSidebar
        project={project}
        editor={editor}
        session={new DiffSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'Trim it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    // Never reported as applied — the card says what actually happened.
    await waitFor(() => expect(screen.getByText('Couldn’t apply this edit')).toBeTruthy());
    expect(screen.queryByText('Edited')).toBeNull();
  });

  it('offers Undo run for the edits a run just made', async () => {
    const applyPatchChecked = vi.fn(() => []);
    const undo = vi.fn();
    // The undo stack's newest entry is the run's own patch, so the run is still the top of
    // the stack and "Undo run" can honestly claim to revert exactly it.
    const editor = {
      applyPatchChecked,
      undo,
      history: { entries: [{ patch: { patchId: fakeEdit.patch.patchId } }], cursor: 1 },
    } as unknown as UseEditor;
    const onProjectChange = vi.fn();
    render(
      <AiSidebar
        project={project}
        onProjectChange={onProjectChange}
        editor={editor}
        session={new DiffSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'Trim it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('Made 1 edit')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Undo run' }));
    expect(undo).toHaveBeenCalledTimes(1);
    // Undo is the negative learning signal that replaced the Reject button — and a better
    // one, since it judges an edit the user actually watched rather than only read about.
    await waitFor(() =>
      expect(
        onProjectChange.mock.calls.some(
          ([next]) =>
            ((next as { aiMemory?: { rejectedEdits?: unknown[] } }).aiMemory?.rejectedEdits ?? [])
              .length > 0,
        ),
      ).toBe(true),
    );
  });

  // P8.2 "knows": what the AI remembers is visible, and removing the chip forgets it —
  // a hidden preference would keep steering every later turn with no way to see why.
  it('shows a remembered decision as a chip and forgets it when the chip is removed', () => {
    const remembering = parseProject({
      ...project,
      aiMemory: { captionStyle: 'bold yellow', preferredPacing: 'fast' },
    });
    const onProjectChange = vi.fn();
    render(
      <AiSidebar
        project={remembering}
        onProjectChange={onProjectChange}
        session={new FakeSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    expect(screen.getByText('Remembers caption style: bold yellow')).toBeTruthy();
    expect(screen.getByText('Remembers pacing: fast')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove Remembers caption style: bold yellow'));
    expect(onProjectChange).toHaveBeenCalledTimes(1);
    const next = onProjectChange.mock.calls[0]![0] as { aiMemory?: Record<string, unknown> };
    expect(next.aiMemory?.['captionStyle']).toBeUndefined();
    expect(next.aiMemory?.['preferredPacing']).toBe('fast');
  });

  it('offers "Show on timeline" for the range the last run touched (P8.2 changed)', async () => {
    const applyPatchChecked = vi.fn(() => ({ ok: true as const }));
    const editor = {
      applyPatchChecked,
      undo: vi.fn(),
      history: { entries: [{ patch: { patchId: fakeEdit.patch.patchId } }], cursor: 1 },
    } as unknown as UseEditor;
    const onReveal = vi.fn();
    render(
      <AiSidebar
        project={project}
        editor={editor}
        onReveal={onReveal}
        session={new DiffSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'Trim it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('Made 1 edit')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Show on timeline' }));
    // The fixture's only operation names a track, so that is what gets revealed.
    expect(onReveal).toHaveBeenCalledWith({ kind: 'track', id: 'video_1', label: 'video_1' });
  });

  it('stands the Undo-run button down once the run is no longer the top of the stack', async () => {
    const applyPatchChecked = vi.fn(() => []);
    // Someone edited after the run: undoing now would take back THEIR work, not the run's.
    const editor = {
      applyPatchChecked,
      undo: vi.fn(),
      history: {
        entries: [
          { patch: { patchId: fakeEdit.patch.patchId } },
          { patch: { patchId: 'manual_1' } },
        ],
        cursor: 2,
      },
    } as unknown as UseEditor;
    render(
      <AiSidebar
        project={project}
        editor={editor}
        session={new DiffSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'Trim it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('Made 1 edit')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Undo run' })).toBeNull();
    expect(screen.getByText(/Undo is past this run now/)).toBeTruthy();
  });

  it('commits each per-turn diff the moment it streams, before the run settles (ADR 0056)', async () => {
    // The agent loop emits one scope:'turn' diff per applied turn; each must land on the
    // timeline as it arrives — NOT when the whole run completes. This is the property the
    // whole instant-apply change exists to guarantee.
    const applyPatchChecked = vi.fn(() => []);
    const editor = { applyPatchChecked } as unknown as UseEditor;
    const secondEdit = {
      ...fakeEdit,
      patch: { ...fakeEdit.patch, patchId: 'p2' },
    } as unknown as EditResult;
    let releaseTurn2: (() => void) | undefined;
    class PerTurnSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('editing');
        yield e.diff(fakeEdit, undefined, { scope: 'turn', turnIndex: 1 });
        // Hold the run open: the first diff must apply while the run is still live.
        await new Promise<void>((resolve) => {
          releaseTurn2 = resolve;
        });
        yield e.diff(secondEdit, undefined, { scope: 'turn', turnIndex: 2 });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        editor={editor}
        session={new PerTurnSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'Trim it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    // Turn 1 applied while the run is STILL in flight (turn 2 not yet released).
    await waitFor(() => expect(applyPatchChecked).toHaveBeenCalledWith(fakeEdit.patch));
    expect(document.querySelector('.ai-composer-activity')).toBeTruthy();
    await act(async () => {
      releaseTurn2?.();
    });
    await waitFor(() => expect(applyPatchChecked).toHaveBeenCalledWith(secondEdit.patch));
    expect(applyPatchChecked).toHaveBeenCalledTimes(2);
  });

  it('stacks a card per turn, each labelled by its agent step, all applied (ADR 0056)', async () => {
    const appliedPatchIds: string[] = [];
    const applyPatchChecked = vi.fn((patch: { patchId: string }) => {
      appliedPatchIds.push(patch.patchId);
      return [];
    });
    const editor = { applyPatchChecked } as unknown as UseEditor;
    const secondEdit = {
      ...fakeEdit,
      patch: { ...fakeEdit.patch, patchId: 'p2' },
    } as unknown as EditResult;
    class TwoTurnSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('editing');
        yield e.diff(fakeEdit, undefined, { scope: 'turn', turnIndex: 1 });
        yield e.diff(secondEdit, undefined, { scope: 'turn', turnIndex: 2 });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        editor={editor}
        session={new TwoTurnSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'Trim it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('Step 2')).toBeTruthy());
    expect(screen.getByText('Step 1')).toBeTruthy();
    // Both landed in emit order, with nothing to click.
    await waitFor(() => expect(appliedPatchIds).toEqual(['p1', 'p2']));
    expect(screen.queryByRole('button', { name: 'Apply all' })).toBeNull();
  });

  it('folds a planned step’s edit into the step row instead of a second card', async () => {
    // A step and its edit are the same event described twice. Before this, the sidebar told
    // the story in two parallel narratives the reader had to join by eye.
    const applyPatchChecked = vi.fn(() => []);
    const editor = { applyPatchChecked } as unknown as UseEditor;
    class PlannedSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('editing');
        yield e.plan([{ id: 'step-1', label: 'Trim the intro', status: 'completed' }]);
        yield e.diff(fakeEdit, undefined, {
          scope: 'turn',
          turnIndex: 0,
          planStepId: 'step-1',
        });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        editor={editor}
        session={new PlannedSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'Trim it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    // The step carries its own outcome…
    await waitFor(() => expect(screen.getByText('Trim the intro')).toBeTruthy());
    expect(screen.getByText('1 change')).toBeTruthy();
    // …and the edit does not also appear as a standalone receipt card.
    expect(document.querySelectorAll('.ai-event--diff')).toHaveLength(0);
    // It still applied — folding it into the step is a rendering choice, not a skip.
    expect(applyPatchChecked).toHaveBeenCalledWith(fakeEdit.patch);
  });

  it('keeps a standalone receipt when the run drafted no plan', async () => {
    const applyPatchChecked = vi.fn(() => []);
    const editor = { applyPatchChecked } as unknown as UseEditor;
    render(
      <AiSidebar
        project={project}
        editor={editor}
        session={new DiffSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'Trim it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    // No checklist to fold into, so the receipt must keep its own row or it vanishes.
    await waitFor(() => expect(screen.getByText('Edited')).toBeTruthy());
  });

  it('has no apply-mode control at all', () => {
    window.localStorage.clear();
    render(
      <AiSidebar
        project={project}
        session={new FakeSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    expect(screen.queryByLabelText('Apply mode')).toBeNull();
    expect(screen.queryByRole('menuitemradio', { name: /Manual/ })).toBeNull();
  });

  it('dispatches Agent-mode commands to the auto path, which classifies read-only questions to chat (ADR 0055)', async () => {
    // Routing moved into the orchestrator: the sidebar dispatches `auto` for every Agent-mode
    // command, and `streamAuto` classifies a read-only question to the chat sub-stream (no
    // agent loop, no self-check-as-success). At the sidebar boundary the dispatched mode is
    // `auto`; the question→chat downgrade is covered by the orchestrator's streamAuto tests.
    const modes: string[] = [];
    class RecordModeSession implements AiSession {
      public async *run(mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        modes.push(mode);
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.assistant(e.assistantId, 'It is a 10-second montage.');
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new RecordModeSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    // Default mode is 'agent'; every plain command now dispatches 'auto'.
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'what is this timeline about?' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('It is a 10-second montage.')).toBeTruthy());
    expect(modes).toEqual(['auto']);
  });

  it('does not append a "nothing changed" notice when an editing run applies no edit', async () => {
    // Empty-run gating is intentionally off (runOutcome.emptyRunNotice always returns
    // null): a run that only reads + narrates (e.g. search_visual, planning) stands on
    // its own streamed output instead of being scolded with a synthetic notice.
    class NoEditSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('thinking');
        // The edit route emits an 'editing' status up front (streamAuto, ADR 0055), which is
        // how an `auto` run is recognised as an editing turn even when it applies nothing.
        yield e.status('editing');
        yield e.assistant(e.assistantId, 'Here is a plan.');
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new NoEditSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    // An edit-intent command (not a question) stays in agent mode.
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'make the montage faster and add more clips' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('Here is a plan.')).toBeTruthy());
    expect(screen.queryByText(/No changes were made/)).toBeNull();
  });

  it('shows composer activity before anything else resolves — within one frame of submit (P8.1)', async () => {
    // `emit.status(...)` is the FIRST yielded event in every stream* method (before
    // any `await`) and the frame batcher delivers it within one animation frame —
    // so the run indicator must appear even when the model never produces another
    // event. This session hangs forever right after its first status event: if the
    // composer activity still renders, the indicator truly does not wait on the model.
    class NeverResolvesSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('thinking');
        await new Promise<never>(() => {
          /* never resolves — proves the indicator doesn't wait on this */
        });
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new NeverResolvesSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    // A question routes to 'chat' regardless of the default 'agent' mode (see the
    // routing test above).
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'what is this timeline about?' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => {
      const status = document.querySelector('.ai-composer-activity');
      expect(status).toBeTruthy();
      expect(status?.querySelector('.ai-activity-label')?.textContent).toBe('Thinking…');
    });
  });

  it('updates the composer activity label as later status events arrive', async () => {
    // view.status is last-write-wins: thinking → running_tool must re-label the
    // composer activity live, without waiting for the run to settle.
    let release: (() => void) | undefined;
    class TwoStatusSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('thinking');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield e.status('running_tool');
        await new Promise<never>(() => {
          /* hold the run open so the header stays live */
        });
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new TwoStatusSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'what is this timeline about?' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() =>
      expect(document.querySelector('.ai-composer-activity .ai-activity-label')?.textContent).toBe(
        'Thinking…',
      ),
    );
    await act(async () => {
      release?.();
    });
    await waitFor(() =>
      expect(document.querySelector('.ai-composer-activity .ai-activity-label')?.textContent).toBe(
        'Running tool…',
      ),
    );
  });

  it('shows the run activity and the plan together, not one instead of the other', async () => {
    // Activity was gated on `tasks.length === 0`, from when tasks and the plan were
    // two renderings of the same DAG. They are complementary now — Activity carries
    // the phases that exist BEFORE a plan does (understanding, planning, checking),
    // the plan carries the model's own steps with per-step status — so the first
    // task arriving must not delete a five-step plan from the screen.
    class PlanAndTasksSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('editing');
        yield e.plan([
          { id: 's1', label: 'Trim the intro', status: 'completed' },
          { id: 's2', label: 'Add captions', status: 'running' },
        ]);
        yield e.taskStarted('review', 'Check the edit against the rendered picture and sound');
        await new Promise<never>(() => {
          /* held open: both panels must be on screen at the same time */
        });
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new PlanAndTasksSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'tighten this up' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });

    expect(await screen.findByRole('button', { name: /Activity/ })).toBeTruthy();
    expect(document.querySelector('.ai-plan-dock')).not.toBeNull();
  });

  it('renders two concurrently running DAG tasks as simultaneous cards (P8.2)', async () => {
    // `task_started` for two tasks with neither `task_finished` yet must render BOTH
    // as "running" at once — the whole point of `view.tasks` being separate from the
    // linear `nodes` stream (a sequential list would misrepresent parallel DAG work).
    class ParallelTasksSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('editing');
        yield e.taskStarted('beats', 'Finding the beats');
        yield e.taskStarted('scenes', 'Finding the scenes');
        await new Promise<never>(() => {
          /* both tasks stay running — settlement isn't needed for this assertion */
        });
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new ParallelTasksSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'what is this timeline about?' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    const toggle = await screen.findByRole('button', { name: /Activity/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      within(screen.getByLabelText('Most recent plan task')).getByText('Finding the scenes'),
    ).toBeTruthy();
    expect(screen.queryByText('Finding the beats')).toBeNull();
    fireEvent.click(toggle);
    const runningGroup = screen.getByTestId('ai-tasks-running');
    expect(within(runningGroup).getByText('Finding the beats')).toBeTruthy();
    expect(within(runningGroup).getByText('Finding the scenes')).toBeTruthy();
    // Neither has settled — no trailing "settled" row yet.
    expect(screen.queryByTestId('ai-tasks-settled')).toBeNull();
  });

  it('leaves every existing node/affordance untouched when view.tasks is absent (regression)', async () => {
    // TaskRunView must be a strict no-op for every run that never emits a
    // `task_started` — i.e. every existing test above (tool cards, diffs, plan
    // checklist, history, resume, retry) keeps working unmodified. This asserts the
    // additive guarantee directly on the FakeSession run this file already covers.
    renderSidebar();
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'Trim the intro' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('All set.')).toBeTruthy());
    expect(screen.queryByTestId('ai-tasks-running')).toBeNull();
    expect(screen.queryByTestId('ai-tasks-settled')).toBeNull();
    expect(screen.queryByLabelText('Running tasks')).toBeNull();
  });

  it('runQuickEdit (the Cmd+K / point-react-refine escape hatch) reaches the same runTurn/session path as Send', async () => {
    // Asserts the imperative handle threads through the SAME request builder the
    // composer's Send button uses — same selection, same session.run call — so
    // there is no parallel request-building path for the palette/context-menu
    // entry points (P12.2/P13.3).
    const seen: AiSessionInput[] = [];
    class RecordSession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        seen.push(input);
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    const editor = {
      applyPatchChecked: vi.fn(() => []),
      state: {
        selectedIds: ['c1'],
        timeline: {
          tracks: [
            {
              id: 't1',
              type: 'video',
              clips: [
                {
                  id: 'c1',
                  assetId: 'a',
                  trackId: 't1',
                  start: 2,
                  end: 5,
                  sourceStart: 0,
                  sourceEnd: 3,
                  effects: [],
                  keyframes: [],
                },
              ],
            },
          ],
        },
      },
    } as unknown as UseEditor;
    const ref = createRef<AiSidebarHandle>();
    render(
      <AiSidebar
        ref={ref}
        project={project}
        editor={editor}
        session={new RecordSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    await act(async () => {
      ref.current?.runQuickEdit('brighten this clip');
    });
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.userPrompt).toBe('brighten this clip');
    expect(seen[0]?.selection).toEqual({ start: 2, end: 5 });
    // The user message it produced renders in the transcript, same as a Send.
    await waitFor(() => expect(screen.getByText('brighten this clip')).toBeTruthy());
  });
});

const GATED_STEPS = ['Trim the intro', 'Add captions', 'Balance the audio', 'Export'];

/**
 * A fake session that plays the orchestrator's role in the plan-approval gate
 * (P11.3): emits the drafted plan + `awaiting_approval`, then genuinely awaits the
 * `controls.planApproval` resolver the sidebar wires — exercising the real
 * approve/cancel wiring end to end without a real Orchestrator.
 */
class GatedPlanSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.plan(
      GATED_STEPS.map((label, i) => ({ id: `step-${i + 1}`, label, status: 'pending' })),
    );
    yield e.status('awaiting_approval');
    const decision = await input.controls?.planApproval?.requestApproval(GATED_STEPS);
    if (decision === 'cancelled') {
      yield e.status('cancelled');
      return;
    }
    yield e.status('completed');
  }
  public abort(): void {}
  public answer(): void {}
}

describe('AiSidebar — plan-approval gate (P11.3)', () => {
  it('renders the step list and Approve lets the run finish', async () => {
    render(
      <AiSidebar
        project={project}
        session={new GatedPlanSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'edit it' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByTestId('ai-approval-approve')).toBeTruthy());
    for (const label of GATED_STEPS) {
      // Appears twice: the live plan checklist AND the approval card's step list.
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-approval-approve'));
    });
    await waitFor(() => expect(screen.queryByTestId('ai-approval-approve')).toBeNull());
  });

  it('Cancel ends the run with no edit and clears the card', async () => {
    render(
      <AiSidebar
        project={project}
        session={new GatedPlanSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'edit it' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByTestId('ai-approval-cancel')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-approval-cancel'));
    });
    await waitFor(() => expect(screen.queryByTestId('ai-approval-cancel')).toBeNull());
    // No diff/proposed-edit card ever rendered — the run stopped before any patch.
    expect(screen.queryByText('Accept')).toBeNull();
  });

  it('Edit request cancels the run and repopulates the composer with the original prompt', async () => {
    render(
      <AiSidebar
        project={project}
        session={new GatedPlanSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'edit it' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByTestId('ai-approval-edit')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-approval-edit'));
    });
    await waitFor(() => expect(screen.queryByTestId('ai-approval-edit')).toBeNull());
    expect((screen.getByLabelText('Message FramePilot') as HTMLTextAreaElement).value).toBe(
      'edit it',
    );
  });
});

/**
 * A fake session that plays the orchestrator's role for mid-run steering (P11.4):
 * polls `controls.steering` (mirroring `runTurn`'s per-turn boundary check) until a
 * message is queued, confirms it, then completes — never stopping the run itself.
 */
class SteerableSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('editing');
    let message: string | undefined;
    // A real 5ms `setTimeout` poll racing against the test's own synchronous
    // `fireEvent.change`/`fireEvent.click` steering steps — 600 iterations
    // (~3s worst case) rather than 200 (~1s) so this doesn't flake under
    // full-suite CPU contention, independent of how much per-render work the
    // app under test happens to do.
    for (let i = 0; i < 600 && !message; i += 1) {
      message = input.controls?.steering?.take();
      if (!message) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (message) yield e.notification(`Steering applied: "${message}"`);
    yield e.status('completed');
  }
  public abort(): void {}
  public answer(): void {}
}

describe('AiSidebar — mid-run steering (P11.4)', () => {
  it('queues a message via the steering input and folds it in without stopping the run', async () => {
    render(
      <AiSidebar
        project={project}
        session={new SteerableSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'edit it' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByTestId('ai-steering-input')).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByTestId('ai-steering-input'), {
        target: { value: 'focus on the outro' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-steering-send'));
    });
    // The queued note is genuinely transient: `SteerableSession`'s background poll
    // can discover the message and complete the run within the SAME act() flush that
    // committed the queued-state render, unmounting `SteeringInput` before a separate
    // assertion could ever observe it standalone (this raced and flaked in CI/under
    // coverage instrumentation, which shifts exactly this kind of timing). Accept
    // either observable outcome — the transient queued note, or the run having
    // already folded the message in — since both prove it was queued and processed.
    await waitFor(() => {
      const queued = screen.queryByTestId('ai-steering-queued');
      const applied = screen.queryByText('Steering applied: "focus on the outro"');
      expect(queued ?? applied).toBeTruthy();
    });
    if (screen.queryByTestId('ai-steering-queued')) {
      expect(screen.getByTestId('ai-steering-queued').textContent).toContain('focus on the outro');
    }
    // The run never stopped — it completes normally after folding the steering in.
    await waitFor(() =>
      expect(screen.getByText('Steering applied: "focus on the outro"')).toBeTruthy(),
    );
    await waitFor(() => expect(screen.queryByTestId('ai-steering-input')).toBeNull());
  });

  it('is silent (no queued note) when nothing was sent', async () => {
    render(
      <AiSidebar
        project={project}
        session={new FakeSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'edit it' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    expect(screen.queryByTestId('ai-steering-queued')).toBeNull();
  });
});

describe('AiSidebar — inline notice Retry (D1)', () => {
  it("retries the last turn from a retryable error notice's inline Retry, reusing the SAME retry action as the action bar", async () => {
    let calls = 0;
    class FlakySession implements AiSession {
      public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
        yield e.status('completed');
      }
      public abort(): void {}
      public answer(): void {}
    }
    render(
      <AiSidebar
        project={project}
        session={new FlakySession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'do it' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    // Scope to the notice card itself — the action bar ALSO renders a "Retry"
    // button once the run fails, so a plain `getByRole` would be ambiguous.
    const notice = document.querySelector('.ai-event--notice') as HTMLElement;
    const retryButton = within(notice).getByRole('button', { name: 'Retry' });
    await act(async () => {
      fireEvent.click(retryButton);
    });
    // The session ran a second time — the inline Retry re-ran the exact same last
    // turn `AiSidebar`'s own action-bar Retry uses, not a second implementation.
    await waitFor(() => expect(calls).toBe(2));
  });
});

describe('AiSidebar — persisted conversation UI state (D2)', () => {
  /** Streams a tool call WITH a result summary, so its card is expandable. */
  class ToolSummarySession implements AiSession {
    public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
      const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
      yield e.status('thinking');
      yield e.toolCall('c1', 'find_silence', 'running');
      yield e.toolCall('c1', 'find_silence', 'completed', { runtimeMs: 10 });
      // Include real output so the row is expandable (a trivial one-line summary with
      // no output is a non-expandable status line) — this test persists that expansion.
      yield e.toolResult('c1', {
        summary: 'Found 2 silent gaps',
        result: { gaps: [{ start: 1.2, end: 1.8 }] },
      });
      yield e.status('completed');
    }
    public abort(): void {}
    public answer(): void {}
  }

  it('restores composer draft, tool expansion, and scroll position after a reload', async () => {
    // jsdom does no real layout, so every element's scrollHeight/clientHeight is
    // always 0 unless stubbed — and unlike a per-element stub, this needs to
    // survive `.ai-stream` unmounting/remounting (it lives behind the History
    // drawer's ternary, and selecting a history row swaps the drawer back out for
    // a BRAND NEW `.ai-stream` node in the same click). Stub at the prototype level
    // so any element — including that new one — reports a real overflowing
    // height, matching what a real browser already has (the conversation's rows
    // are committed to the DOM before the restore effect runs post-commit).
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 200,
    });
    try {
      const persistence = new MemoryPersistence();
      const { unmount } = render(
        <AiSidebar
          project={project}
          session={new ToolSummarySession()}
          persistence={persistence}
        />,
      );

      fireEvent.change(screen.getByLabelText('Message FramePilot'), {
        target: { value: 'Trim the intro' },
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Send'));
      });
      await waitFor(() => expect(screen.getByText('Find silence')).toBeTruthy());

      // Fake timers from here on — the debounced autosave (400ms, see
      // CONVERSATION_SAVE_DEBOUNCE_MS) below is a REAL `setTimeout` scheduled the
      // moment `uiState` changes, so timers must already be faked BEFORE steps
      // (1)-(3) below schedule it, or `vi.advanceTimersByTime` would have nothing
      // of ITS to advance. Avoids a real ~500ms sleep, which would otherwise tie
      // up a worker thread and skew wall-clock-sensitive tests elsewhere in the
      // full suite.
      vi.useFakeTimers();
      try {
        // (1) An un-sent composer draft.
        fireEvent.change(screen.getByLabelText('Message FramePilot'), {
          target: { value: 'Second thought' },
        });

        // (2) Expand the tool card.
        const toggle = screen.getByRole('button', { name: /Find silence/ });
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');

        // (3) Scroll the stream away from the top.
        const stream = document.querySelector('.ai-stream') as HTMLElement;
        stream.scrollTop = 260;
        fireEvent.scroll(stream);

        // Let the debounced autosave actually write the conversation — including
        // its `uiState` — to `persistence`.
        act(() => {
          vi.advanceTimersByTime(500);
        });
      } finally {
        vi.useRealTimers();
      }

      // "Reload": tear the sidebar down and mount a fresh instance against the SAME
      // persistence backend, then reopen the same conversation from history —
      // exactly what a reviewer does after restarting the app.
      unmount();
      render(
        <AiSidebar
          project={project}
          session={new ToolSummarySession()}
          persistence={persistence}
        />,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /History/ }));
      fireEvent.click(await screen.findByRole('button', { name: /Trim the intro/ }));

      // Composer draft restored.
      expect((screen.getByLabelText('Message FramePilot') as HTMLTextAreaElement).value).toBe(
        'Second thought',
      );
      // Tool card is still expanded.
      expect(
        screen.getByRole('button', { name: /Find silence/ }).getAttribute('aria-expanded'),
      ).toBe('true');
      // Scroll position restored.
      expect((document.querySelector('.ai-stream') as HTMLElement).scrollTop).toBe(260);
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
      }
    }
  });

  it('keeps following the stream across the remount a mutating tool call forces', async () => {
    // The regression: every mutating tool call publishes an authoritative project, which
    // remounts the editor (`key={project.id}:{reloadNonce}`). The remounted sidebar used
    // to restore the PIXEL offset that happened to be the bottom a moment ago — landing
    // mid-thread and, because that number is no longer the bottom, switching auto-follow
    // OFF. "Jump to latest" then worked only until the next mutation.
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 200,
    });
    try {
      const persistence = new MemoryPersistence();
      const sidebar = (
        <AiSidebar project={project} session={new ToolSummarySession()} persistence={persistence} />
      );
      const { unmount } = render(sidebar);

      fireEvent.change(screen.getByLabelText('Message FramePilot'), {
        target: { value: 'Trim the intro' },
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Send'));
      });
      await waitFor(() => expect(screen.getByText('Find silence')).toBeTruthy());

      // The reader is pinned to the bottom, following the run (scrollHeight 1000 −
      // clientHeight 200 = 800 is the bottom).
      const stream = document.querySelector('.ai-stream') as HTMLElement;
      stream.scrollTop = 800;
      fireEvent.scroll(stream);
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

      // The mutate-driven editor remount.
      unmount();
      render(sidebar);
      await screen.findByText('Find silence');

      // Still at the latest message, and still following — no "Jump to latest" prompt,
      // and no yank back to the stale 800px offset.
      const remounted = document.querySelector('.ai-stream') as HTMLElement;
      expect(remounted.scrollTop).toBe(1000);
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
      }
    }
  });

  it('holds a scrolled-up reader in place across that same remount', async () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 200,
    });
    try {
      const persistence = new MemoryPersistence();
      const sidebar = (
        <AiSidebar project={project} session={new ToolSummarySession()} persistence={persistence} />
      );
      const { unmount } = render(sidebar);
      fireEvent.change(screen.getByLabelText('Message FramePilot'), {
        target: { value: 'Trim the intro' },
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText('Send'));
      });
      await waitFor(() => expect(screen.getByText('Find silence')).toBeTruthy());

      // Reading back through the thread — the opposite of following.
      const stream = document.querySelector('.ai-stream') as HTMLElement;
      stream.scrollTop = 120;
      fireEvent.scroll(stream);

      unmount();
      render(sidebar);
      await screen.findByText('Find silence');

      expect((document.querySelector('.ai-stream') as HTMLElement).scrollTop).toBe(120);
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
      }
    }
  });
});
