/**
 * Tests for conversation persistence (Phase 11 M2): the Memory and Desktop adapters,
 * the conversation guard, summary projection, and the backend resolver. The
 * Memory adapter doubles as the round-trip + "20k events restore" assertion; the
 * Desktop adapter is exercised through a fake bridge (no Electron).
 */
import { describe, expect, it, vi } from 'vitest';
import { createTurnEmitter } from '@framepilot/ai-sdk';
import { appendEvent, createConversation } from './conversation.js';
import {
  type ConversationBridge,
  DesktopPersistence,
  MemoryPersistence,
  ProjectConversationPersistence,
  parseConversation,
  resolveConversationPersistence,
  toRecord,
  toSummary,
} from './conversationPersistence.js';

const conv = (id = 'c1') =>
  createConversation({ id, projectId: 'project-1', model: 'mock', now: 0 });

describe('toSummary / toRecord / parseConversation', () => {
  it('projects a summary and round-trips a record', () => {
    const c = appendEvent(
      conv(),
      createTurnEmitter({ conversationId: 'c1', turnId: 't', now: () => 1 }).userMessage('hi'),
    );
    const summary = toSummary(c);
    expect(summary).toMatchObject({ id: 'c1', eventCount: 1, title: 'hi' });
    expect(toRecord(c)).toEqual({ summary, data: c });
  });

  it('rejects corrupt conversation JSON', () => {
    expect(parseConversation(null)).toBeNull();
    expect(parseConversation({ id: 1 })).toBeNull();
    expect(parseConversation({ id: 'c', events: 'no' })).toBeNull();
    expect(parseConversation({ id: 'c', events: [], uiState: {} })).toBeNull();
    expect(parseConversation({ id: 'c', events: [], uiState: null })).toBeNull();
    expect(parseConversation(conv())).not.toBeNull();
  });
});

describe('ProjectConversationPersistence', () => {
  it('lists and loads only conversations owned by the active project', async () => {
    const backing = new MemoryPersistence([
      conv('mine'),
      { ...conv('other'), projectId: 'project-2' },
    ]);
    const store = new ProjectConversationPersistence(backing, 'project-1');

    expect((await store.list()).map((summary) => summary.id)).toEqual(['mine']);
    expect((await store.load('mine'))?.id).toBe('mine');
    expect(await store.load('other')).toBeNull();
  });

  it('rejects cross-project saves and cannot delete another project history', async () => {
    const other = { ...conv('other'), projectId: 'project-2' };
    const backing = new MemoryPersistence([other]);
    const store = new ProjectConversationPersistence(backing, 'project-1');

    await expect(store.save(other)).rejects.toThrow('outside its project');
    await store.delete('other');
    expect(await backing.load('other')).toEqual(other);
  });
});

describe('MemoryPersistence', () => {
  it('saves, lists, loads, and deletes', async () => {
    const store = new MemoryPersistence([conv('seed')]);
    await store.save(conv('a'));
    expect((await store.list()).map((s) => s.id).sort()).toEqual(['a', 'seed']);
    expect((await store.load('a'))?.id).toBe('a');
    expect(await store.load('missing')).toBeNull();
    await store.delete('a');
    expect(await store.load('a')).toBeNull();
  });

  it('round-trips a 20k-event conversation', async () => {
    const e = createTurnEmitter({ conversationId: 'big', turnId: 't', now: () => 1 });
    let big = conv('big');
    for (let i = 0; i < 20_000; i += 1) big = appendEvent(big, e.delta('big:assistant', 'x'));
    const store = new MemoryPersistence();
    await store.save(big);
    const restored = await store.load('big');
    expect(restored?.events).toHaveLength(20_000);
    // Building + persisting 20k immutable-event copies is CPU-bound and sits
    // near the package's 15s budget when coverage instrumentation and turbo's
    // package parallelism stack up, so give this stress run explicit headroom.
  }, 60_000);
});

describe('DesktopPersistence', () => {
  const fakeBridge = (): ConversationBridge & { saved: unknown[] } => {
    const saved: unknown[] = [];
    return {
      saved,
      conversationsList: vi.fn(async () => [toSummary(conv('a'))]),
      conversationsLoad: vi.fn(async (id: string) => (id === 'a' ? conv('a') : null)),
      conversationsSave: vi.fn(async (record) => {
        saved.push(record);
        return { ok: true };
      }),
      conversationsDelete: vi.fn(async () => ({ ok: true })),
    };
  };

  it('delegates list/load/save/delete to the bridge', async () => {
    const bridge = fakeBridge();
    const store = new DesktopPersistence(bridge);
    expect((await store.list())[0]?.id).toBe('a');
    expect((await store.load('a'))?.id).toBe('a');
    expect(await store.load('missing')).toBeNull();
    await store.save(conv('b'));
    expect(bridge.saved).toHaveLength(1);
    await store.delete('a');
    expect(bridge.conversationsDelete).toHaveBeenCalledWith('a');
  });

  it('throws on a failed save or delete', async () => {
    const bridge = fakeBridge();
    bridge.conversationsSave = vi.fn(async () => ({ ok: false, error: 'disk full' }));
    bridge.conversationsDelete = vi.fn(async () => ({ ok: false }));
    const store = new DesktopPersistence(bridge);
    await expect(store.save(conv('b'))).rejects.toThrow('disk full');
    await expect(store.delete('a')).rejects.toThrow('Failed to delete');
  });
});

describe('resolveConversationPersistence', () => {
  it('degrades a PARTIAL bridge (missing conversations API) to browser backends', () => {
    const partial = { conversationsList: vi.fn() } as unknown as ConversationBridge;
    expect(resolveConversationPersistence(partial, undefined)).toBeInstanceOf(MemoryPersistence);
  });

  it('prefers the desktop bridge, then IndexedDB, then memory', () => {
    const bridge = {
      conversationsList: vi.fn(),
      conversationsLoad: vi.fn(),
      conversationsSave: vi.fn(),
      conversationsDelete: vi.fn(),
    } as unknown as ConversationBridge;
    expect(resolveConversationPersistence(bridge)).toBeInstanceOf(DesktopPersistence);
    const idbFactory = {} as IDBFactory;
    expect(resolveConversationPersistence(null, idbFactory).constructor.name).toBe(
      'IndexedDbPersistence',
    );
    expect(resolveConversationPersistence(null, undefined)).toBeInstanceOf(MemoryPersistence);
  });
});
