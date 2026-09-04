/**
 * Workstream D: the run budget is a setting the sidebar OBEYS, not one it owns.
 *
 * The SDK bounds every agent run by cost and wall clock. The bound used to be two fields
 * docked under the composer (plus a notification the run emitted before its first model
 * call); it now lives in Settings → AI → Run budget — set once, applied to every run,
 * readable at any time, and never restated in the transcript. What still has to be true
 * here is what always was: the SDK defaults go on the wire, a budget changed in Settings
 * survives a reload and goes on the wire on the next run, and a stored value this UI
 * could never have written is not trusted as a choice.
 *
 * The control itself is covered in `SettingsDialog.test.tsx` ("AI → Run budget"); the
 * store's validation policy in `editor/useSettings.test.tsx`.
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
import { DEFAULT_SETTINGS, SettingsProvider } from '../../editor/useSettings.js';
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

/** Write a budget the way Settings does: through the one settings key, before mount. */
function storeBudget(patch: Record<string, unknown>): void {
  window.localStorage.setItem(
    'framepilot.settings',
    JSON.stringify({ ...DEFAULT_SETTINGS, ...patch }),
  );
}

function renderSidebar(session: AiSession): ReturnType<typeof render> {
  return render(
    <SettingsProvider>
      <AiSidebar project={project} session={session} persistence={new MemoryPersistence()} />
    </SettingsProvider>,
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
  it('sends the SDK defaults in agentOptions when nothing has been set', async () => {
    const session = new RecordAgent();
    renderSidebar(session);

    await send('edit it');
    await waitFor(() => expect(session.seen).toHaveLength(1));
    expect(session.seen[0]).toMatchObject({
      maxUsd: DEFAULT_MAX_RUN_USD,
      maxMinutes: DEFAULT_MAX_RUN_MINUTES,
    });
  });

  it('owns no budget control of its own — it is set in Settings', () => {
    renderSidebar(new RecordAgent());
    // The fields moved; a run is no longer configured from the composer, and the panel
    // does not repeat the sentence that belongs to the setting.
    expect(screen.queryByLabelText('Stop a run after, dollars')).toBeNull();
    expect(screen.queryByLabelText('Stop a run after, minutes')).toBeNull();
    expect(screen.queryByTestId('ai-max-usd')).toBeNull();
    expect(screen.queryByTestId('ai-max-minutes')).toBeNull();
  });

  it('sends a budget saved in Settings — it survives a reload and goes on the wire', async () => {
    // What a commit in Settings → AI leaves behind, read fresh by a new sidebar.
    storeBudget({ maxRunUsd: 2.5, maxRunMinutes: 7 });

    const session = new RecordAgent();
    renderSidebar(session);
    await send('edit it');
    await waitFor(() => expect(session.seen).toHaveLength(1));
    expect(session.seen[0]).toMatchObject({ maxUsd: 2.5, maxMinutes: 7 });
  });

  it('falls back to the default for a garbage or out-of-range stored value', async () => {
    // Neither is a value the Settings control could have written (it clamps on commit),
    // so neither is trusted as a choice — and a NaN must never reach the SDK as a bound.
    storeBudget({ maxRunUsd: 'lots', maxRunMinutes: 9999 });

    const session = new RecordAgent();
    renderSidebar(session);
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
    storeBudget({ maxRunUsd: 3 });
    renderSidebar(new CheckpointSession());

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

    await send('question');
    await waitFor(() => expect(session.seen).toHaveLength(1));
    expect(session.seen[0]).toBeUndefined();
  });
});
