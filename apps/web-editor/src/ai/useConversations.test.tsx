/**
 * Tests for the useConversations hook (Phase 11 M2): create/append/open/rename/
 * toggle/remove, and the debounced autosave + hydrate round-trip through a
 * MemoryPersistence (the "restore across reload" guarantee).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createTurnEmitter } from '@framepilot/ai-sdk';
import { MemoryPersistence } from './conversationPersistence.js';
import { createConversation } from './conversation.js';
import {
  CONVERSATION_SAVE_DEBOUNCE_MS,
  MAX_LOADED_CONVERSATIONS,
  resetConversationsRemountCache,
  useConversations,
  type UseConversations,
} from './useConversations.js';

const e = createTurnEmitter({ conversationId: 'c', turnId: 't', now: () => 1 });

describe('useConversations', () => {
  // The store survives a remount on purpose (see `resetConversationsRemountCache`), so
  // it is module state: clear it or each test inherits the last one's conversations.
  afterEach(() => resetConversationsRemountCache());

  it('creates, appends, and exposes the active conversation', () => {
    const { result } = renderHook(() => useConversations());
    let id = '';
    act(() => {
      id = result.current.create({ id: 'c1', projectId: 'project-1', model: 'mock', now: 0 }).id;
    });
    expect(result.current.active?.id).toBe('c1');
    act(() => result.current.append(id, e.userMessage('Trim it')));
    expect(result.current.active?.title).toBe('Trim it');
  });

  it('appendMany folds a frame batch into one state transition (H1)', () => {
    const { result } = renderHook(() => useConversations());
    act(
      () =>
        void result.current.create({
          id: 'c1',
          projectId: 'project-1',
          model: 'mock',
          now: 0,
        }),
    );
    act(() =>
      result.current.appendMany('c1', [
        e.userMessage('Batch me'),
        e.delta('t:assistant', 'Hel'),
        e.delta('t:assistant', 'lo'),
      ]),
    );
    expect(result.current.active?.events).toHaveLength(3);
    expect(result.current.active?.title).toBe('Batch me');
  });

  it('renames, toggles pin/favorite, and removes', () => {
    const { result } = renderHook(() => useConversations());
    act(
      () =>
        void result.current.create({
          id: 'c1',
          projectId: 'project-1',
          model: 'mock',
          now: 0,
        }),
    );
    act(() => result.current.rename('c1', 'Renamed'));
    act(() => result.current.togglePinned('c1'));
    act(() => result.current.toggleFavorite('c1'));
    expect(result.current.conversations[0]).toMatchObject({
      title: 'Renamed',
      pinned: true,
      favorite: true,
    });
    act(() => result.current.remove('c1'));
    expect(result.current.conversations).toHaveLength(0);
  });

  it('autosaves to persistence and restores via hydrate', async () => {
    const persistence = new MemoryPersistence();
    const { result } = renderHook(() => useConversations(persistence));
    act(
      () =>
        void result.current.create({
          id: 'c1',
          projectId: 'project-1',
          model: 'mock',
          now: 0,
        }),
    );
    act(() => result.current.append('c1', e.userMessage('Persist me')));

    await waitFor(async () => {
      expect((await persistence.load('c1'))?.title).toBe('Persist me');
    });

    // A fresh hook hydrates the persisted conversation back.
    const second = renderHook(() => useConversations(persistence));
    await act(async () => {
      await second.result.current.hydrate();
    });
    expect(second.result.current.conversations.map((c) => c.id)).toEqual(['c1']);
  });

  it('keeps events appended since the last autosave across a remount', async () => {
    // Repro from a real desktop log. A host auto-commit used to remount the editor so the
    // timeline could re-seed from the authoritative project. That remount took the
    // conversation store with it: everything appended inside the 400ms autosave debounce
    // was gone, and hydrate restored the older on-disk record over the top — a hole in
    // the middle of a live run. The lost tail included the `reasoning done` event, which
    // is why a mid-run commit stranded a "Thinking…" row in the thread forever.
    const persistence = new MemoryPersistence();
    const first = renderHook(() => useConversations(persistence));
    act(
      () =>
        void first.result.current.create({
          id: 'c1',
          projectId: 'project-1',
          model: 'mock',
          now: 0,
        }),
    );
    act(() => first.result.current.append('c1', e.userMessage('Add transitions')));
    // Inside the debounce window — nothing has reached persistence yet.
    act(() =>
      first.result.current.appendMany('c1', [e.reasoning([], false), e.reasoning([], true)]),
    );
    expect(await persistence.load('c1')).toBeNull();

    first.unmount();
    const second = renderHook(() => useConversations(persistence));
    await act(async () => {
      await second.result.current.hydrate();
    });

    const restored = second.result.current.state.byId['c1'];
    expect(restored?.events.map((event) => event.type)).toEqual([
      'user_message',
      'reasoning',
      'reasoning',
    ]);
    // The remount also flushes what the debounce still owed, so the record on disk
    // catches up instead of staying a stale prefix.
    await waitFor(async () => {
      expect((await persistence.load('c1'))?.events).toHaveLength(3);
    });
  });

  it('restores the store on remount WITHOUT waiting for persistence', () => {
    // The unmount flush and hydrate are both async, so relying on them alone leaves a
    // window where the remounted sidebar reads an empty (or stale) store while the run
    // is still streaming into it. The restore has to be synchronous with the mount.
    const persistence = new MemoryPersistence();
    const first = renderHook(() => useConversations(persistence));
    act(
      () =>
        void first.result.current.create({
          id: 'c1',
          projectId: 'project-1',
          model: 'mock',
          now: 0,
        }),
    );
    act(() => first.result.current.append('c1', e.userMessage('Mid-run')));
    first.unmount();

    const second = renderHook(() => useConversations(persistence));
    expect(second.result.current.state.byId['c1']?.events).toHaveLength(1);
    // The active selection survives too — recovery used to re-attach a live run behind
    // an empty "new chat" screen because hydrate restores records but no selection.
    expect(second.result.current.active?.id).toBe('c1');
  });

  it('hydrate is a no-op without persistence', async () => {
    const { result } = renderHook(() => useConversations());
    await act(async () => {
      await result.current.hydrate();
    });
    expect(result.current.conversations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bounded memory: logs are loaded on demand and evicted when idle
// ---------------------------------------------------------------------------

describe('useConversations — resident event logs', () => {
  afterEach(() => resetConversationsRemountCache());

  /** `count` persisted conversations, each carrying one message. */
  function seeded(count: number): MemoryPersistence {
    return new MemoryPersistence(
      Array.from({ length: count }, (_, i) => ({
        ...createConversation({ id: `c${i}`, projectId: 'project-1', model: 'mock', now: i }),
        events: [e.userMessage(`Message ${i}`)],
      })),
    );
  }

  const resident = (result: { current: UseConversations }): string[] =>
    result.current.conversations.filter((c) => c.events.length > 0).map((c) => c.id);

  it('hydrates the history list without reading a single event log', async () => {
    // The failure this pins: opening the editor used to pull every past run's full log
    // into the heap — tens of megabytes of tool output nobody had asked to see.
    const persistence = seeded(8);
    const { result } = renderHook(() => useConversations(persistence));
    await act(async () => {
      await result.current.hydrate();
    });
    expect(result.current.conversations).toHaveLength(8);
    expect(resident(result)).toEqual([]);
  });

  it('reads a conversation’s log when it is opened', async () => {
    const persistence = seeded(4);
    const { result } = renderHook(() => useConversations(persistence));
    await act(async () => {
      await result.current.hydrate();
    });
    await act(async () => {
      result.current.open('c2');
    });
    expect(result.current.active?.events).toHaveLength(1);
  });

  it('keeps at most MAX_LOADED_CONVERSATIONS logs in memory', async () => {
    const persistence = seeded(8);
    const { result } = renderHook(() => useConversations(persistence));
    await act(async () => {
      await result.current.hydrate();
    });
    for (const id of ['c0', 'c1', 'c2', 'c3', 'c4']) {
      await act(async () => {
        result.current.open(id);
      });
    }
    expect(resident(result).length).toBeLessThanOrEqual(MAX_LOADED_CONVERSATIONS);
    // The one being read is never the one dropped.
    expect(resident(result)).toContain('c4');
  });

  it('never writes an unread log back over the record on disk', async () => {
    // The hazard of holding metadata without events: any save of that shape replaces a
    // real conversation with an empty one. Opening marks a conversation read, which is
    // exactly such a metadata change.
    const persistence = seeded(4);
    const { result } = renderHook(() => useConversations(persistence));
    await act(async () => {
      await result.current.hydrate();
    });
    await act(async () => {
      result.current.togglePinned('c3');
    });
    await new Promise((resolve) => setTimeout(resolve, CONVERSATION_SAVE_DEBOUNCE_MS * 3));
    const onDisk = await persistence.load('c3');
    expect(onDisk?.events).toHaveLength(1);
    expect(onDisk?.pinned).toBe(true);
  });

  it('re-reads an evicted log when it is opened again', async () => {
    const persistence = seeded(8);
    const { result } = renderHook(() => useConversations(persistence));
    await act(async () => {
      await result.current.hydrate();
    });
    for (const id of ['c0', 'c1', 'c2', 'c3', 'c4']) {
      await act(async () => {
        result.current.open(id);
      });
    }
    expect(resident(result)).not.toContain('c0');
    await act(async () => {
      result.current.open('c0');
    });
    expect(result.current.active?.events).toHaveLength(1);
  });

  it('loadAll brings every log in, so history search can match tool text', async () => {
    const persistence = seeded(6);
    const { result } = renderHook(() => useConversations(persistence));
    await act(async () => {
      await result.current.hydrate();
    });
    await act(async () => {
      await result.current.loadAll();
    });
    expect(resident(result)).toHaveLength(6);
  });
});
