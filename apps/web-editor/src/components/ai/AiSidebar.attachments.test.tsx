/**
 * The attachment lifecycle bugs the state-half fix left behind (D7, D15).
 *
 * Both are cases where the sidebar was RIGHT about what to show and wrong about what to
 * say — one destroyed persisted attachments while correctly refusing to redraw them, the
 * other reported a licensing refusal as a failed measurement. Driven through the sidebar
 * because both are only observable end to end: through what survives a reload, and
 * through which buttons the tile offers afterwards.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnEmitter, type AiEvent } from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { createConversation, type Attachment, type Conversation } from '../../ai/conversation.js';
import { MemoryPersistence } from '../../ai/conversationPersistence.js';
import { resetConversationsRemountCache } from '../../ai/useConversations.js';
import type { AiSession, AiSessionInput } from '../../editor/ai.js';
import { AiSidebar, resetAiSidebarScrollCache } from './AiSidebar.js';

const analyzeReference = vi.hoisted(() => vi.fn());

vi.mock('../../editor/bridge.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../editor/bridge.js')>('../../editor/bridge.js');
  return { ...actual, analyzeReference, isDesktop: () => true };
});

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

/** Idle: neither test runs a turn — what is under test happens before one starts. */
class IdleSession implements AiSession {
  // eslint-disable-next-line require-yield
  public async *run(_mode: string, _input: AiSessionInput): AsyncIterable<AiEvent> {
    await new Promise(() => {});
  }
  public abort(): void {}
  public answer(): void {}
}

const reference = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'r1',
  kind: 'video',
  name: 'fast-cut.mp4',
  role: 'pacing',
  status: 'ready',
  path: 'media/p/attachments/fast-cut.mp4',
  profile: {
    id: 'r1',
    role: 'pacing',
    kind: 'video',
    fileName: 'fast-cut.mp4',
    contentHash: 'hash_r1_0123456789',
    analyzedAt: '2026-08-29T10:00:00Z',
    constraints: ['Measured fast-cut.mp4'],
  },
  ...over,
});

function seeded(attachments: readonly Attachment[], draft = ''): Conversation {
  const base = createConversation({ id: 'conv-refs', projectId: project.id, model: 'mock' });
  const emitter = createTurnEmitter({ conversationId: 'conv-refs', turnId: 't1' });
  return {
    ...base,
    title: 'Make it feel like this',
    events: [emitter.userMessage('Make it feel like this')],
    uiState: { ...base.uiState, attachments, composerDraft: draft },
  };
}

async function openFromHistory(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /History/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Make it feel like this/ }));
}

afterEach(() => {
  resetAiSidebarScrollCache();
  resetConversationsRemountCache();
  analyzeReference.mockReset();
});

/**
 * D7: a conversation opened after a cold start arrives as a stub, and its real `uiState`
 * lands a moment later. The old guard refused the re-seed once the reviewer had typed —
 * correctly, for the screen — but the persist effect then wrote the live (empty)
 * attachment list straight over the saved one, so a reference that had been persisted
 * properly was gone by the next reload.
 */
describe('a late disk load cannot destroy persisted attachments (D7)', () => {
  /** `MemoryPersistence` whose FIRST `load` settles only when the test says so. */
  class DeferredPersistence extends MemoryPersistence {
    private release: (() => void) | null = null;
    private held = false;

    public override async load(id: string): Promise<Conversation | null> {
      // Only the app's own first read is held open — the test reads the record back
      // afterwards to check what actually reached disk, and that must not block.
      if (!this.held) {
        this.held = true;
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
      }
      return super.load(id);
    }

    /** Let the pending disk read complete. */
    public async settle(): Promise<void> {
      await act(async () => {
        this.release?.();
        this.release = null;
        await Promise.resolve();
      });
    }
  }

  it('keeps the saved reference on disk when the reviewer typed before the load landed', async () => {
    const persistence = new DeferredPersistence([seeded([reference()])]);
    const { unmount } = render(
      <AiSidebar project={project} session={new IdleSession()} persistence={persistence} />,
    );
    await openFromHistory();

    // The stub is open and its uiState has not arrived: no tiles yet.
    expect(document.querySelectorAll('.ai-ref-tile')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'now tighten the middle' },
    });

    await persistence.settle();

    // Live typing still wins for the draft — the half the guard was right about.
    await waitFor(() =>
      expect((screen.getByLabelText('Message FramePilot') as HTMLTextAreaElement).value).toBe(
        'now tighten the middle',
      ),
    );
    // …and the saved reference is back rather than silently dropped. Attachments are a
    // set, so restoring one removes nothing the reviewer did.
    await waitFor(() => expect(document.querySelectorAll('.ai-ref-tile')).toHaveLength(1));

    // The assertion that actually pins the defect: the record on disk still has it.
    // Unmount flushes the debounced autosave rather than cancelling it, so this reads the
    // write the persist effect made with the merged state.
    unmount();
    const saved = await persistence.load('conv-refs');
    expect(saved?.uiState.attachments.map((a) => a.path)).toEqual([
      'media/p/attachments/fast-cut.mp4',
    ]);
    expect(saved?.uiState.composerDraft).toBe('now tighten the middle');
  });

  it('restores the saved chip without taking the live draft off the screen', async () => {
    // The half the original guard was protecting: a load landing mid-sentence must not
    // replace what the reviewer is typing. It still does not — only the attachment set,
    // which can be merged without removing anything, comes across.
    const persistence = new DeferredPersistence([seeded([reference()])]);
    render(<AiSidebar project={project} session={new IdleSession()} persistence={persistence} />);
    await openFromHistory();
    fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: 'x' } });
    await persistence.settle();

    await waitFor(() => expect(screen.getByText('fast-cut.mp4')).toBeTruthy());
    expect((screen.getByLabelText('Message FramePilot') as HTMLTextAreaElement).value).toBe('x');
  });
});

/**
 * D15: an unlicensed build refuses to analyze anything. It used to report that through
 * the same channel a broken file uses, so the tile showed a failed ANALYSIS with a
 * Re-analyze button that was guaranteed to be refused again.
 */
describe('a licensing refusal is not a failed analysis (D15)', () => {
  it('states the reason and stops offering a retry that cannot work', async () => {
    analyzeReference.mockResolvedValue({
      ok: false,
      reason: 'unlicensed',
      error: 'Activate FramePilot to analyze references. The file was not measured.',
    });
    // Unanalyzed and failed: the state whose tile carries a Re-analyze button.
    const { profile: _unused, ...unanalyzed } = reference();
    const failed: Attachment = { ...unanalyzed, status: 'failed', error: 'Analysis timed out.' };
    const persistence = new MemoryPersistence([seeded([failed])]);
    const { unmount } = render(
      <AiSidebar project={project} session={new IdleSession()} persistence={persistence} />,
    );
    await openFromHistory();

    await waitFor(() => expect(document.querySelectorAll('.ai-ref-tile')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /What FramePilot learned from fast-cut/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }));
    });

    await waitFor(() =>
      expect(document.querySelector('.ai-ref-tile')?.getAttribute('data-status')).toBe(
        'unsupported',
      ),
    );

    // Reopened, which is how the reviewer meets the tile from here on: it no longer
    // claims a failed analysis, states the real reason, and offers no retry — the
    // disclosure that carried the Re-analyze button is not there to open.
    unmount();
    resetConversationsRemountCache();
    resetAiSidebarScrollCache();
    render(<AiSidebar project={project} session={new IdleSession()} persistence={persistence} />);
    await openFromHistory();

    await waitFor(() =>
      expect(document.querySelector('.ai-ref-tile')?.getAttribute('data-status')).toBe(
        'unsupported',
      ),
    );
    expect(
      screen.queryByRole('button', { name: /What FramePilot learned from fast-cut/ }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-analyze' })).toBeNull();
    expect(document.querySelector('.ai-chip-status')?.getAttribute('title')).toBe(
      'Activate FramePilot to analyze references. The file was not measured.',
    );
  });
});
