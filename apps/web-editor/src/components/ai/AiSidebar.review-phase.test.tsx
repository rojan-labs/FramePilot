/**
 * The finished run reviewing its own edit (run fb90e58d).
 *
 * The orchestrator holds a run's terminal status until the perceptual review of its last
 * edit settles, and reports `verifying` while it waits. The reply is written and the edits
 * are on the timeline by then. The editor in fb90e58d waited 77 s under "Generating…",
 * pressed Stop, and the finished turn was stamped `cancelled`. Ending the run in this phase
 * ends the review, never the turn; and a message sent during it goes out now instead of
 * waiting behind the render.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createTurnEmitter, type AiEvent } from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { Conversation } from '../../ai/conversation.js';
import { MemoryPersistence } from '../../ai/conversationPersistence.js';
import { resetConversationsRemountCache } from '../../ai/useConversations.js';
import type { AiSession, AiSessionInput } from '../../editor/ai.js';
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

/**
 * Each run replies, reports `verifying`, and parks there until aborted — as the
 * orchestrator does while a review renders. `terminalOnAbort` mirrors the two transports:
 * the in-process one delivers the orchestrator's `completed` after the abort, the desktop
 * one can end on `done` with no terminal event at all.
 */
class ReviewingSession implements AiSession {
  public readonly prompts: string[] = [];
  public aborts = 0;
  private release: (() => void) | null = null;
  private reviewing = true;
  public constructor(private readonly terminalOnAbort: boolean) {}
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    this.prompts.push(input.userPrompt);
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('executing');
    yield e.assistant(e.assistantId, `Done: ${input.userPrompt}`);
    if (!this.reviewing) {
      yield e.status('completed');
      return;
    }
    // Only the first run reviews; the follow-up completes straight away.
    this.reviewing = false;
    yield e.status('verifying');
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    if (!this.terminalOnAbort) return;
    yield e.notification('Review skipped — it was still checking when you moved on.');
    yield e.status('completed');
  }
  public abort(): void {
    this.aborts += 1;
    const release = this.release;
    this.release = null;
    release?.();
  }
  public answer(): void {}
}

/** Remembers every save so a test can read the statuses a turn was left with. */
class CapturingPersistence extends MemoryPersistence {
  public last: Conversation | null = null;
  public override async save(conversation: Conversation): Promise<void> {
    this.last = conversation;
    await super.save(conversation);
  }
}

afterEach(() => resetConversationsRemountCache());
afterEach(() => resetAiSidebarScrollCache());
afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* no storage in this env */
  }
});

const composer = (): HTMLTextAreaElement =>
  screen.getByLabelText('Message FramePilot') as HTMLTextAreaElement;

function type(text: string): void {
  fireEvent.change(composer(), { target: { value: text } });
}

async function startReviewingRun(
  session: ReviewingSession,
  persistence: CapturingPersistence,
): Promise<void> {
  render(<AiSidebar project={project} session={session} persistence={persistence} />);
  type('Emphasise the captions');
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Send'));
  });
  await waitFor(() => expect(screen.getByText('Done: Emphasise the captions')).toBeTruthy());
  await waitFor(() => expect(screen.getByLabelText('Stop agent')).toBeTruthy());
}

/** The statuses recorded for the first turn, in order. */
function firstTurnStatuses(persistence: CapturingPersistence): string[] {
  const events = persistence.last?.events ?? [];
  const firstTurn = events.find((event) => event.type === 'status')?.turnId;
  return events
    .filter((event) => event.type === 'status' && event.turnId === firstTurn)
    .map((event) => (event as { status: string }).status);
}

describe('AiSidebar — ending a finished run’s review', () => {
  it.each([
    ['the transport delivers the orchestrator’s completed', true],
    ['the transport ends with no terminal event', false],
  ])('Stop during the check leaves the turn completed when %s', async (_label, terminal) => {
    const session = new ReviewingSession(terminal);
    const persistence = new CapturingPersistence();
    await startReviewingRun(session, persistence);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Stop agent'));
    });

    await waitFor(() => expect(firstTurnStatuses(persistence)).toContain('completed'));
    expect(firstTurnStatuses(persistence)).not.toContain('cancelled');
  });

  it('a message sent during the check ends the review and goes out now', async () => {
    const session = new ReviewingSession(true);
    const persistence = new CapturingPersistence();
    await startReviewingRun(session, persistence);

    type('Now make them bigger');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    });

    // The review was ended by the send, not by waiting it out, and the next turn started.
    expect(session.aborts).toBe(1);
    await waitFor(() =>
      expect(session.prompts).toEqual(['Emphasise the captions', 'Now make them bigger']),
    );
    await waitFor(() => expect(screen.getByText('Done: Now make them bigger')).toBeTruthy());
    expect(firstTurnStatuses(persistence)).not.toContain('cancelled');
  });
});
