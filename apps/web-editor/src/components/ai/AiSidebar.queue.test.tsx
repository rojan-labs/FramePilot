/**
 * Sending while the agent is working (the reported bug: the message vanished on Send).
 *
 * `runTurn` refuses a second run, and the composer had already been emptied, so the text
 * was simply gone. Now it is queued — one slot — shown above the composer, editable and
 * removable, and sent as the next turn when the run finishes. Ending the run yourself
 * hands it back instead of sending it.
 */
import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createTurnEmitter, type AiEvent } from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { MemoryPersistence } from '../../ai/conversationPersistence.js';
import { resetConversationsRemountCache } from '../../ai/useConversations.js';
import type { AiSession, AiSessionInput } from '../../editor/ai.js';
import { AiSidebar, type AiSidebarHandle, resetAiSidebarScrollCache } from './AiSidebar.js';

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

/** Each run parks after its first status until the test finishes it (or Stop aborts it). */
class GatedSession implements AiSession {
  public readonly prompts: string[] = [];
  public aborts = 0;
  private release: ((completed: boolean) => void) | null = null;
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    this.prompts.push(input.userPrompt);
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('executing');
    const completed = await new Promise<boolean>((resolve) => {
      this.release = resolve;
    });
    if (!completed) return;
    yield e.assistant(e.assistantId, `Done: ${input.userPrompt}`);
    yield e.status('completed');
  }
  /** Let the live run complete normally. */
  public finish(): void {
    const release = this.release;
    this.release = null;
    release?.(true);
  }
  public abort(): void {
    this.aborts += 1;
    const release = this.release;
    this.release = null;
    release?.(false);
  }
  public answer(): void {}
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

async function startRun(
  session: GatedSession,
  text = 'Trim the intro',
  ref = createRef<AiSidebarHandle>(),
): Promise<void> {
  render(
    <AiSidebar
      ref={ref}
      project={project}
      session={session}
      persistence={new MemoryPersistence()}
    />,
  );
  type(text);
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Send'));
  });
  await waitFor(() => expect(screen.getByLabelText('Stop agent')).toBeTruthy());
}

async function queue(text: string): Promise<void> {
  type(text);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  });
}

async function finishRun(session: GatedSession): Promise<void> {
  await act(async () => {
    session.finish();
  });
}

describe('AiSidebar — sending while the agent is working', () => {
  it('queues the message instead of dropping it, and sends it when the run finishes', async () => {
    const session = new GatedSession();
    await startRun(session);

    await queue('Then add captions');
    // Visible, not gone: the composer is free for the next thought, the message waits.
    expect(screen.getByTestId('ai-queued').textContent).toContain('Then add captions');
    expect(composer().value).toBe('');
    expect(session.prompts).toEqual(['Trim the intro']);

    await finishRun(session);
    await waitFor(() => expect(session.prompts).toEqual(['Trim the intro', 'Then add captions']));
    expect(screen.queryByTestId('ai-queued')).toBeNull();
    // It went out as an ordinary turn — its own user message in the conversation.
    expect(screen.getByText('Then add captions')).toBeTruthy();

    await finishRun(session);
    await waitFor(() => expect(screen.getByLabelText('Send')).toBeTruthy());
  });

  it('holds one message: a second send is refused and stays in the composer', async () => {
    const session = new GatedSession();
    await startRun(session);
    await queue('Then add captions');

    type('And a title card');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(composer().value).toBe('And a title card');
    expect(screen.getByText(/One message is already queued/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Queue message' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId('ai-queued').textContent).toContain('Then add captions');
    expect(screen.getByTestId('ai-queued').textContent).not.toContain('And a title card');
  });

  it('sends the edited text, not the original', async () => {
    const session = new GatedSession();
    await startRun(session);
    await queue('Then add captions');

    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    fireEvent.change(screen.getByLabelText('Queued message text'), {
      target: { value: 'Then add bold captions' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('ai-queued').textContent).toContain('Then add bold captions');

    await finishRun(session);
    await waitFor(() =>
      expect(session.prompts).toEqual(['Trim the intro', 'Then add bold captions']),
    );
  });

  it('never sends while the queued message is open for editing', async () => {
    const session = new GatedSession();
    await startRun(session);
    await queue('Then add captions');

    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    await finishRun(session);
    // The run is over, but the reviewer is mid-edit: nothing goes out yet.
    await waitFor(() => expect(screen.getByText('Sends when you finish editing')).toBeTruthy());
    expect(session.prompts).toEqual(['Trim the intro']);

    fireEvent.change(screen.getByLabelText('Queued message text'), {
      target: { value: 'Then add captions in yellow' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() =>
      expect(session.prompts).toEqual(['Trim the intro', 'Then add captions in yellow']),
    );
  });

  it('does not send a removed message', async () => {
    const session = new GatedSession();
    await startRun(session);
    await queue('Then add captions');

    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message' }));
    expect(screen.queryByTestId('ai-queued')).toBeNull();
    // The slot is free again.
    await queue('Actually, add a title');
    expect(screen.getByTestId('ai-queued').textContent).toContain('Actually, add a title');

    await finishRun(session);
    await waitFor(() =>
      expect(session.prompts).toEqual(['Trim the intro', 'Actually, add a title']),
    );
  });

  it('Stop hands the queued message back to the composer instead of sending it', async () => {
    const session = new GatedSession();
    await startRun(session);
    await queue('Then add captions');
    type('and music');

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Stop agent'));
    });
    await waitFor(() => expect(screen.getByLabelText('Send')).toBeTruthy());
    expect(session.aborts).toBe(1);
    expect(session.prompts).toEqual(['Trim the intro']);
    expect(screen.queryByTestId('ai-queued')).toBeNull();
    // Nothing typed is lost: the queued text first, then what was in the box.
    expect(composer().value).toBe('Then add captions\n\nand music');
  });

  it('queues a palette prompt the same way, and never drops one when the slot is taken', async () => {
    const session = new GatedSession();
    const ref = createRef<AiSidebarHandle>();
    await startRun(session, 'Trim the intro', ref);

    act(() => ref.current?.runQuickEdit('Remove silence'));
    expect(screen.getByTestId('ai-queued').textContent).toContain('Remove silence');
    // Slot taken: the second one lands in the composer instead of vanishing.
    act(() => ref.current?.runQuickEdit('Add captions'));
    expect(composer().value).toBe('Add captions');

    await finishRun(session);
    await waitFor(() => expect(session.prompts).toEqual(['Trim the intro', 'Remove silence']));
  });

  it('New chat mid-run keeps the queued message with the chat it was written for', async () => {
    const session = new GatedSession();
    await startRun(session);
    await queue('Then add captions');

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'New chat' }));
    });
    await waitFor(() => expect(screen.getByLabelText('Send')).toBeTruthy());
    // Not sent into the new chat, and not dumped into its composer.
    expect(session.prompts).toEqual(['Trim the intro']);
    expect(composer().value).toBe('');
    expect(screen.queryByTestId('ai-queued')).toBeNull();

    // Back in the original chat, it is waiting in that chat's composer.
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /History/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Trim the intro/ }));
    await waitFor(() => expect(composer().value).toBe('Then add captions'));
  });
});
