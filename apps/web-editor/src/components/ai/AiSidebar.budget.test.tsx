/**
 * Workstream D: the run budget is the editor's to set.
 *
 * The SDK bounds every agent run by cost and wall clock and announces the bound as the
 * run's second event. Before this the renderer never sent one, so the panel could only
 * ever be *told* the default it had no way to change. These tests hold the three things
 * that makes true: the defaults go on the wire, a changed budget survives a reload and
 * goes on the wire next run, and a stored value this UI could never have written is not
 * trusted as a choice.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTurnEmitter,
  DEFAULT_MAX_RUN_MINUTES,
  DEFAULT_MAX_RUN_USD,
  type AiEvent,
} from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { MemoryPersistence } from '../../ai/conversationPersistence.js';
import { resetConversationsRemountCache } from '../../ai/useConversations.js';
import type { AiSession, AiSessionInput } from '../../editor/ai.js';
import { AiSidebar, resetAiSidebarScrollCache } from './AiSidebar.js';

const project: Project = parseProject({
  id: 'p',
  name: 'B',
  version: 1,
  fps: 30,
  resolution: { width: 1920, height: 1080 },
  assets: [],
  timeline: { tracks: [] },
  transcript: [],
  aiMemory: {},
  history: [],
});

/** Records the `agentOptions` of every run so the assertions can read the wire. */
class RecordAgent implements AiSession {
  public readonly seen: AiSessionInput['agentOptions'][] = [];
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    this.seen.push(input.agentOptions);
    yield e.status('completed');
  }
  public abort(): void {}
  public answer(): void {}
}

const USD_LABEL = 'Stop a run after $';
const MINUTES_LABEL = 'min';

function renderSidebar(session: AiSession): ReturnType<typeof render> {
  return render(
    <AiSidebar project={project} session={session} persistence={new MemoryPersistence()} />,
  );
}

async function send(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('Message FramePilot'), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByLabelText('Send'));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetAiSidebarScrollCache();
  resetConversationsRemountCache();
});

describe('AI sidebar — run budget (Workstream D)', () => {
  it('renders the SDK defaults and sends them in agentOptions', async () => {
    const session = new RecordAgent();
    renderSidebar(session);

    const usd = screen.getByLabelText(USD_LABEL) as HTMLInputElement;
    const minutes = screen.getByLabelText(MINUTES_LABEL) as HTMLInputElement;
    expect(usd.value).toBe(String(DEFAULT_MAX_RUN_USD));
    expect(minutes.value).toBe(String(DEFAULT_MAX_RUN_MINUTES));
    // The sentence that makes the two numbers mean something is on screen, not in a tooltip.
    expect(
      screen.getByText(
        'The AI stops at the next step once a run reaches either limit, and tells you what it applied.',
      ),
    ).toBeTruthy();

    await send('edit it');
    await waitFor(() => expect(session.seen).toHaveLength(1));
    expect(session.seen[0]).toMatchObject({
      maxUsd: DEFAULT_MAX_RUN_USD,
      maxMinutes: DEFAULT_MAX_RUN_MINUTES,
    });
  });

  it('persists a changed budget and sends it on the next run', async () => {
    const session = new RecordAgent();
    const { unmount } = renderSidebar(session);

    const usd = screen.getByLabelText(USD_LABEL);
    fireEvent.change(usd, { target: { value: '2.5' } });
    fireEvent.blur(usd);
    const minutes = screen.getByLabelText(MINUTES_LABEL);
    fireEvent.change(minutes, { target: { value: '7' } });
    fireEvent.blur(minutes);

    expect(window.localStorage.getItem('framepilot.ai.maxUsd')).toBe('2.5');
    expect(window.localStorage.getItem('framepilot.ai.maxMinutes')).toBe('7');

    await send('edit it');
    await waitFor(() => expect(session.seen).toHaveLength(1));
    expect(session.seen[0]).toMatchObject({ maxUsd: 2.5, maxMinutes: 7 });

    // A reload reads the saved budget, not the default.
    unmount();
    const next = new RecordAgent();
    renderSidebar(next);
    expect((screen.getByLabelText(USD_LABEL) as HTMLInputElement).value).toBe('2.5');
    expect((screen.getByLabelText(MINUTES_LABEL) as HTMLInputElement).value).toBe('7');
  });

  it('clamps an out-of-range entry into the allowed range', async () => {
    const session = new RecordAgent();
    renderSidebar(session);

    const usd = screen.getByLabelText(USD_LABEL);
    fireEvent.change(usd, { target: { value: '999' } });
    fireEvent.blur(usd);
    const minutes = screen.getByLabelText(MINUTES_LABEL);
    fireEvent.change(minutes, { target: { value: '0' } });
    fireEvent.blur(minutes);

    expect((usd as HTMLInputElement).value).toBe('50');
    expect((minutes as HTMLInputElement).value).toBe('1');

    await send('edit it');
    await waitFor(() => expect(session.seen).toHaveLength(1));
    expect(session.seen[0]).toMatchObject({ maxUsd: 50, maxMinutes: 1 });
  });

  it('falls back to the default for a garbage or out-of-range stored value', async () => {
    // Neither of these is a value this UI could have written, so neither is trusted
    // as a choice — and a NaN must never reach the SDK as a bound.
    window.localStorage.setItem('framepilot.ai.maxUsd', 'lots');
    window.localStorage.setItem('framepilot.ai.maxMinutes', '9999');

    const session = new RecordAgent();
    renderSidebar(session);
    expect((screen.getByLabelText(USD_LABEL) as HTMLInputElement).value).toBe(
      String(DEFAULT_MAX_RUN_USD),
    );
    expect((screen.getByLabelText(MINUTES_LABEL) as HTMLInputElement).value).toBe(
      String(DEFAULT_MAX_RUN_MINUTES),
    );

    await send('edit it');
    await waitFor(() => expect(session.seen).toHaveLength(1));
    expect(session.seen[0]).toMatchObject({
      maxUsd: DEFAULT_MAX_RUN_USD,
      maxMinutes: DEFAULT_MAX_RUN_MINUTES,
    });
    expect(Number.isNaN(session.seen[0]?.maxUsd)).toBe(false);
  });

  it('sends the budget on a resumed run too', async () => {
    const resumes: AiSessionInput['agentOptions'][] = [];
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
    renderSidebar(new CheckpointSession());

    const usd = screen.getByLabelText(USD_LABEL);
    fireEvent.change(usd, { target: { value: '3' } });
    fireEvent.blur(usd);

    await send('edit it');
    const resume = await screen.findByRole('button', { name: 'Resume' });
    await act(async () => {
      fireEvent.click(resume);
    });
    await waitFor(() => expect(resumes).toHaveLength(1));
    // A resumed run is a fresh run to the SDK — it needs the bound as much as the first.
    expect(resumes[0]).toMatchObject({ maxUsd: 3, maxMinutes: DEFAULT_MAX_RUN_MINUTES });
  });

  it('is agent-mode only — chat sends no agent options', async () => {
    const session = new RecordAgent();
    renderSidebar(session);
    fireEvent.click(screen.getByRole('button', { name: 'AI mode' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Chat/ }));

    expect(screen.queryByLabelText(USD_LABEL)).toBeNull();
    await send('question');
    await waitFor(() => expect(session.seen).toHaveLength(1));
    expect(session.seen[0]).toBeUndefined();
  });
});
