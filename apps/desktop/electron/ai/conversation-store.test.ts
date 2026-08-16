/**
 * Tests for the main-process conversation store (Phase 11 M2): file-per-conversation
 * + index, id sanitization (no path traversal), and corruption tolerance. IO is an
 * in-memory fake, so no Electron/fs.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationRecord, ConversationSummary } from '../ipc/contract.js';
import {
  ConversationStore,
  type ConversationStoreIO,
  isValidConversationId,
} from './conversation-store.js';

/** In-memory fake of the conversations directory. */
function fakeIO(): ConversationStoreIO & { files: Map<string, string>; index: string | null } {
  const state = { files: new Map<string, string>(), index: null as string | null };
  return {
    ...state,
    readIndex: async () => state.index,
    writeIndex: async (contents) => void (state.index = contents),
    readConversation: async (id) => state.files.get(id) ?? null,
    writeConversation: async (id, contents) => void state.files.set(id, contents),
    deleteConversation: async (id) => void state.files.delete(id),
  };
}

const summary = (id: string, updatedAt = 1): ConversationSummary => ({
  id,
  projectId: 'project-1',
  title: id,
  createdAt: 0,
  updatedAt,
  model: 'mock',
  mode: 'agent',
  pinned: false,
  favorite: false,
  unread: false,
  eventCount: 0,
});
const record = (id: string, updatedAt = 1): ConversationRecord => ({
  summary: summary(id, updatedAt),
  data: { id, projectId: 'project-1', events: [], uiState: {} },
});

describe('isValidConversationId', () => {
  it('accepts safe ids and rejects traversal/empty/oversized/non-strings', () => {
    expect(isValidConversationId('conv_1-AB')).toBe(true);
    expect(isValidConversationId('../etc/passwd')).toBe(false);
    expect(isValidConversationId('a/b')).toBe(false);
    expect(isValidConversationId('')).toBe(false);
    expect(isValidConversationId('x'.repeat(200))).toBe(false);
    expect(isValidConversationId(42)).toBe(false);
  });
});

describe('ConversationStore', () => {
  it('saves a file + index entry, lists, loads, and deletes', async () => {
    const io = fakeIO();
    const store = new ConversationStore(io);
    expect(await store.list()).toEqual([]);

    expect(await store.save(record('a'))).toEqual({ ok: true });
    expect(await store.save(record('b', 2))).toEqual({ ok: true });
    expect((await store.list()).map((s) => s.id)).toEqual(['b', 'a']);
    expect(await store.load('a')).toMatchObject({ id: 'a' });

    expect(await store.delete('a')).toEqual({ ok: true });
    expect(await store.load('a')).toBeNull();
    expect((await store.list()).map((s) => s.id)).toEqual(['b']);
  });

  it('replaces an existing conversation in the index rather than duplicating', async () => {
    const store = new ConversationStore(fakeIO());
    await store.save(record('a', 1));
    await store.save(record('a', 5));
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.updatedAt).toBe(5);
  });

  it('rejects invalid records and ids', async () => {
    const store = new ConversationStore(fakeIO());
    expect(await store.save(null)).toMatchObject({ ok: false });
    expect(await store.save({ summary: { id: 1 }, data: {} })).toMatchObject({ ok: false });
    expect(await store.save({ summary: summary('../x'), data: {} })).toMatchObject({ ok: false });
    expect(await store.load('../x')).toBeNull();
    expect(await store.delete('../x')).toMatchObject({ ok: false });
  });

  it('tolerates a missing or corrupt index/file', async () => {
    const io = fakeIO();
    const store = new ConversationStore(io);
    io.index = '{not json';
    expect(await store.list()).toEqual([]);
    io.index = JSON.stringify({ not: 'an array' });
    expect(await store.list()).toEqual([]);
    io.files.set('a', '{bad');
    expect(await store.load('a')).toBeNull();
  });
});
