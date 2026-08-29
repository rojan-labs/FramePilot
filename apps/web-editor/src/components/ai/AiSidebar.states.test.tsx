/**
 * The five states P8.2 asks the sidebar to hold: what the AI **knows**, what it is
 * **doing**, what it **changed**, what it **needs**, and what **failed**.
 *
 * One test per state, driven through the sidebar itself rather than through the
 * pieces — the point of the task is that a user sitting in front of the panel can
 * read each of the five off the screen, which is only true end to end.
 *
 * No screenshots. The report says so plainly rather than shipping a picture that
 * proves nothing the assertions below do not.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnEmitter, type AiEvent, type EditResult } from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { MemoryPersistence } from '../../ai/conversationPersistence.js';
import { resetConversationsRemountCache } from '../../ai/useConversations.js';
import type { AiSession, AiSessionInput } from '../../editor/ai.js';
import type { UseEditor } from '../../editor/useEditor.js';
import { AiSidebar, resetAiSidebarScrollCache } from './AiSidebar.js';

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

const clip = (id: string, start: number, end: number): Record<string, unknown> => ({
  id,
  assetId: 'a',
  trackId: 'video_1',
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
});

const timelineOf = (end: number): Record<string, unknown> => ({
  tracks: [{ id: 'video_1', type: 'video', clips: [clip('c0', 0, end)] }],
});

/** A run that trims twice and adds a transition, taking the programme 60s → 47.5s. */
const trimRun = {
  text: 'Tighten it',
  validation: { valid: true, issues: [] },
  diff: { summary: [], before: timelineOf(60), after: timelineOf(47.5) },
  patch: {
    patchId: 'p1',
    operations: [
      { type: 'trim_clip', clipId: 'c0', trackId: 'video_1', start: 0, end: 20 },
      { type: 'trim_clip', clipId: 'c0', trackId: 'video_1', start: 20, end: 30 },
      { type: 'add_transition', clipId: 'c0', trackId: 'video_1' },
    ],
  },
} as unknown as EditResult;

class TrimSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('editing');
    yield e.diff(trimRun);
    yield e.status('completed');
  }
  public abort(): void {}
  public answer(): void {}
}

/** Never settles — the panel stays in its "doing" state for the assertion. */
class HangingSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('thinking');
    await new Promise(() => {});
  }
  public abort(): void {}
  public answer(): void {}
}

/** Asks a question with options and waits for the answer. */
class AskingSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.toolCall('ask1', 'ask_user', 'running');
    yield e.ask('ask1', 'Which take should I keep?', [
      { label: 'The second one' },
      { label: 'Both' },
    ]);
    yield e.status('awaiting_answer');
    await new Promise(() => {});
  }
  public abort(): void {}
  public answer(): void {}
}

/** Throws the way a provider rejection reaches the sidebar: a raw HTTP body. */
class RejectedKeySession implements AiSession {
  // Throwing before the first yield is exactly how a rejected key reaches the sidebar.
  // eslint-disable-next-line require-yield
  public async *run(): AsyncIterable<AiEvent> {
    throw new Error(
      'AI request failed: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    );
  }
  public abort(): void {}
  public answer(): void {}
}

function send(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: text } });
  return act(async () => {
    fireEvent.click(screen.getByLabelText('Send'));
  });
}

afterEach(() => {
  resetAiSidebarScrollCache();
  resetConversationsRemountCache();
});

describe('AI sidebar — the five states (P8.2)', () => {
  it('KNOWS: the context strip accounts for the playhead, the memory and the facts it cannot withhold', () => {
    const remembering = parseProject({ ...project, aiMemory: { preferredPacing: 'fast' } });
    const editor = {
      state: { playhead: 72.4, selectedIds: [], timeline: { tracks: [] } },
      getPlayhead: () => 72.4,
    } as unknown as UseEditor;
    render(
      <AiSidebar
        project={remembering}
        editor={editor}
        session={new TrimSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    const strip = screen.getByLabelText('Included context');
    // The playhead is threaded into every request and was the one always-sent fact
    // the strip never showed.
    expect(strip.textContent).toContain('Playhead 1:12');
    expect(strip.textContent).toContain('Remembers pacing: fast');
    // Removable only where removing changes what the AI gets.
    expect(screen.getByLabelText('Remove Remembers pacing: fast')).toBeTruthy();
    expect(screen.queryByLabelText('Remove Current Timeline')).toBeNull();
  });

  it('DOING: a live run says what it is doing and offers the way to stop it', async () => {
    render(
      <AiSidebar
        project={project}
        session={new HangingSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    await send('Tighten the intro');
    expect(await screen.findByText('Thinking…')).toBeTruthy();
    // A run with no stop is a run the user cannot get out of.
    expect(screen.getByLabelText('Stop agent')).toBeTruthy();
  });

  it('CHANGED: the footer says what the run did and what it did to the length', async () => {
    const editor = {
      applyPatchChecked: vi.fn(() => ({ ok: true as const })),
      undo: vi.fn(),
      history: { entries: [{ patch: { patchId: 'p1' } }], cursor: 1 },
    } as unknown as UseEditor;
    render(
      <AiSidebar
        project={project}
        editor={editor}
        session={new TrimSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    await send('Tighten it');
    await waitFor(() => expect(screen.getByText('Made 1 edit')).toBeTruthy());
    // "Made 1 edit" is a patch count; this is the account of the cut.
    expect(screen.getByText('Trimmed clip ×2 · Added transition')).toBeTruthy();
    expect(screen.getByText('−12.5s · now 47.5s')).toBeTruthy();
  });

  it('NEEDS: a question the run is blocked on renders its choices as buttons', async () => {
    render(
      <AiSidebar
        project={project}
        session={new AskingSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    await send('Cut this down');
    expect(await screen.findByText(/Which take should I keep/)).toBeTruthy();
    // Not a chat line to parse — the options are the controls.
    expect(screen.getByRole('button', { name: /The second one/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Both/ })).toBeTruthy();
  });

  it('FAILED: says what to do about it, and keeps the provider body behind "Show details"', async () => {
    render(
      <AiSidebar
        project={project}
        session={new RejectedKeySession()}
        persistence={new MemoryPersistence()}
      />,
    );
    await send('Tighten it');
    // The headline is the action, not the HTTP body.
    expect(await screen.findByText(/Settings → AI/)).toBeTruthy();
    expect(screen.queryByText(/authentication_error/)).toBeNull();
    // The evidence is still one click away.
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText(/authentication_error/)).toBeTruthy();
    // Both the notice and the action bar offer it; either is the one action that helps.
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
  });
});
