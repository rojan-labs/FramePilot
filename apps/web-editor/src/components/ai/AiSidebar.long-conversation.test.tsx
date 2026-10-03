/**
 * A long conversation must open fast and read cleanly, and a dead run must not keep a
 * live-looking plan.
 *
 * Driven from run 001be135 / f8574746: an 11,424-event conversation that rendered every
 * turn on open, a caption pass that put 1,047 identical action rows in the thread, and a
 * run killed by a host error whose plan dock kept spinning afterwards.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createTurnEmitter, type AiEvent } from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { createConversation, type Conversation } from '../../ai/conversation.js';
import { MemoryPersistence } from '../../ai/conversationPersistence.js';
import { resetConversationsRemountCache } from '../../ai/useConversations.js';
import type { AiSession, AiSessionInput } from '../../editor/ai.js';
import { AiSidebar, resetAiSidebarScrollCache } from './AiSidebar.js';
import { INITIAL_VISIBLE_TURNS, REVEAL_TURNS_STEP } from './activityWindow.js';

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
 * Opening a conversation from history is an async load plus a render; under a parallel
 * jsdom run that can outlast the 1 s default, which is load, not a defect.
 */
const LOAD_WAIT = { timeout: 5_000 };

class IdleSession implements AiSession {
  public async *run(): AsyncIterable<AiEvent> {
    // Never used: these tests only read a seeded conversation.
  }
  public abort(): void {}
  public answer(): void {}
}

/**
 * One conversation per test. Every test shares project `p`, and async work left over from
 * the previous test can still commit into the cross-remount store after its reset — a
 * shared conversation id then opened the previous test's log instead of this one's.
 */
let seededCount = 0;
function nextSeed(): { readonly id: string; readonly title: string } {
  seededCount += 1;
  return {
    id: `conv-long-${String(seededCount)}`,
    title: `Long edit session ${String(seededCount)}.`,
  };
}

/** `count` complete turns: the editor's message, the reply, a terminal status. */
function turns(conversationId: string, count: number): AiEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const e = createTurnEmitter({ conversationId, turnId: `t${String(index)}` });
    return [
      e.userMessage(`Request number ${String(index + 1)}`),
      e.assistant(e.assistantId, `Reply number ${String(index + 1)}`),
      e.status('completed'),
    ];
  }).flat();
}

async function openSeeded(
  seed: { readonly id: string; readonly title: string },
  events: readonly AiEvent[],
): Promise<void> {
  const conversation: Conversation = {
    ...createConversation({ id: seed.id, projectId: project.id, model: 'mock' }),
    title: seed.title,
    events,
  };
  render(
    <AiSidebar
      project={project}
      session={new IdleSession()}
      persistence={new MemoryPersistence([conversation])}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /History/ }));
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(seed.title) }, LOAD_WAIT));
}

afterEach(() => {
  resetAiSidebarScrollCache();
  resetConversationsRemountCache();
});

describe('AiSidebar — a long conversation opens on its most recent turns', () => {
  it('renders the latest turns and reveals earlier ones on demand', async () => {
    const total = INITIAL_VISIBLE_TURNS + REVEAL_TURNS_STEP + 1;
    const seed = nextSeed();
    await openSeeded(seed, turns(seed.id, total));

    await screen.findByText(`Request number ${String(total)}`, undefined, LOAD_WAIT);
    const firstShown = total - INITIAL_VISIBLE_TURNS + 1;
    expect(screen.getByText(`Request number ${String(firstShown)}`)).toBeTruthy();
    expect(screen.queryByText(`Request number ${String(firstShown - 1)}`)).toBeNull();
    const reveal = screen.getByRole('button', {
      name: `Show earlier messages ${String(total - INITIAL_VISIBLE_TURNS)} more`,
    });

    fireEvent.click(reveal);
    expect(
      screen.getByText(`Request number ${String(firstShown - REVEAL_TURNS_STEP)}`),
    ).toBeTruthy();
    expect(screen.queryByText('Request number 1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Show earlier messages/ }));
    expect(screen.getByText('Request number 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show earlier messages/ })).toBeNull();
  });

  it('shows everything, with no reveal control, when the conversation is short', async () => {
    const seed = nextSeed();
    await openSeeded(seed, turns(seed.id, INITIAL_VISIBLE_TURNS));
    await screen.findByText('Request number 1', undefined, LOAD_WAIT);
    expect(screen.queryByRole('button', { name: /Show earlier messages/ })).toBeNull();
  });
});

describe('AiSidebar — a turn that applied hundreds of operations', () => {
  it('collapses each action kind of the run into one counted row', async () => {
    const seed = nextSeed();
    const e = createTurnEmitter({ conversationId: seed.id, turnId: 'captions' });
    const actions: AiEvent[] = [];
    for (let cue = 0; cue < 150; cue += 1)
      actions.push(e.timelineAction('Deleted range', `${cue}s`));
    // Interleaved cue by cue, exactly as a caption regeneration emits them.
    for (let cue = 0; cue < 150; cue += 1) {
      actions.push(e.timelineAction('Added captions', `cue ${String(cue)}`));
      actions.push(e.timelineAction('Set caption cue', `cue ${String(cue)}`));
    }
    await openSeeded(seed, [
      e.userMessage('Regenerate the captions'),
      ...actions,
      e.assistant(e.assistantId, 'Captions regenerated.'),
      e.status('completed'),
    ]);

    await screen.findByText('Captions regenerated.', undefined, LOAD_WAIT);
    expect(document.querySelectorAll('.ai-action-group')).toHaveLength(3);
    const deleted = screen.getByRole('button', { name: 'Deleted range: 150 changes' });
    expect(screen.getByRole('button', { name: 'Added captions: 150 changes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set caption cue: 150 changes' })).toBeTruthy();
    expect(screen.queryByText('cue 7')).toBeNull();

    fireEvent.click(deleted);
    const list = screen.getByRole('list', { name: 'Deleted range changes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(150);
  });
});

/** A run whose plan is mid-step when the host refuses the next event and the stream throws. */
class HostFailureSession implements AiSession {
  public async *run(_mode: string, input: AiSessionInput): AsyncIterable<AiEvent> {
    const e = createTurnEmitter({ conversationId: input.conversationId, turnId: input.turnId });
    yield e.status('executing');
    yield e.plan([
      { id: 'step-1', label: 'Map the footage', status: 'completed' },
      { id: 'step-2', label: 'Cut the montage', status: 'running' },
      { id: 'step-3', label: 'Check the rhythm', status: 'pending' },
    ]);
    throw new Error('Run "f8574746" exceeded the 67108864-character durable log limit.');
  }
  public abort(): void {}
  public answer(): void {}
}

describe('AiSidebar — the plan settles when its run dies', () => {
  it('shows no spinner on the plan dock after a host error ends the run', async () => {
    render(
      <AiSidebar
        project={project}
        session={new HostFailureSession()}
        persistence={new MemoryPersistence()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message FramePilot'), {
      target: { value: 'Cut a montage' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send'));
    });
    // The run is over once its failure is on screen (the error card is the run's last word).
    await screen.findByText(/durable log limit/, undefined, LOAD_WAIT);
    await waitFor(() => expect(screen.queryByLabelText('Stop agent')).toBeNull(), LOAD_WAIT);

    const dock = document.querySelector('.ai-plan-dock') as HTMLElement;
    expect(dock).toBeTruthy();
    fireEvent.click(within(dock).getByRole('button', { name: /Plan/ }));
    expect(dock.querySelector('.ai-spinner')).toBeNull();
    // Not done — and not failed: nothing went wrong with the steps, the run ended first.
    expect(within(dock).getAllByLabelText('Not done')).toHaveLength(2);
    expect(within(dock).queryByLabelText('Failed')).toBeNull();
    expect(within(dock).getByText('1/3')).toBeTruthy();
  });
});
