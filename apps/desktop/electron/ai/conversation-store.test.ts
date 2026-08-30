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

/**
 * The reachability half of the attachment lifecycle (D2).
 *
 * An imported attachment is referenced by nothing in `project.assets` — only by
 * conversations — so this is the only thing that can answer "is this file still needed?".
 * Getting it wrong in one direction leaves disk behind; getting it wrong in the other
 * deletes a reference the editor can still see, so every ambiguous answer is `null`.
 */
describe('ConversationStore.referencedAttachmentPaths', () => {
  const withAttachments = (
    id: string,
    projectId: string,
    data: Record<string, unknown>,
  ): ConversationRecord => ({
    summary: { ...summary(id), projectId },
    data: { id, projectId, events: [], uiState: {}, ...data },
  });

  it('collects paths from sent messages and from composer chips', async () => {
    const store = new ConversationStore(fakeIO());
    await store.save(
      withAttachments('a', 'project-1', {
        events: [
          { type: 'user_message', attachments: [{ id: 'r1', path: 'media/p/attachments/a.mp4' }] },
          { type: 'status' },
        ],
        uiState: { attachments: [{ id: 'r2', path: 'media/p/attachments/b.png' }] },
      }),
    );
    expect(await store.referencedAttachmentPaths('project-1')).toEqual(
      new Set(['media/p/attachments/a.mp4', 'media/p/attachments/b.png']),
    );
  });

  it('ignores other projects, so one cannot free another project\u2019s files', async () => {
    const store = new ConversationStore(fakeIO());
    await store.save(
      withAttachments('a', 'project-1', {
        uiState: { attachments: [{ id: 'r1', path: 'media/one/attachments/a.mp4' }] },
      }),
    );
    await store.save(
      withAttachments('b', 'project-2', {
        uiState: { attachments: [{ id: 'r2', path: 'media/two/attachments/b.mp4' }] },
      }),
    );
    expect(await store.referencedAttachmentPaths('project-2')).toEqual(
      new Set(['media/two/attachments/b.mp4']),
    );
  });

  it('reports an unreadable conversation as unknown rather than as unreferenced', async () => {
    const io = fakeIO();
    const store = new ConversationStore(io);
    await store.save(withAttachments('a', 'project-1', {}));
    io.files.set('a', '{corrupt');
    expect(await store.referencedAttachmentPaths('project-1')).toBeNull();

    // Same for a document whose event log is not a log any more: its attachments cannot
    // be enumerated, so nothing may be reclaimed on its word.
    io.files.set('a', JSON.stringify({ id: 'a', projectId: 'project-1', events: null }));
    expect(await store.referencedAttachmentPaths('project-1')).toBeNull();
  });

  it('treats a conversation whose file is gone as referencing nothing', async () => {
    const io = fakeIO();
    const store = new ConversationStore(io);
    await store.save(
      withAttachments('a', 'project-1', {
        uiState: { attachments: [{ id: 'r1', path: 'media/p/attachments/a.mp4' }] },
      }),
    );
    // The index still lists it but the document is gone: it exists no more, so it holds
    // no references — that is a complete answer, not an unknown one.
    io.files.delete('a');
    expect(await store.referencedAttachmentPaths('project-1')).toEqual(new Set());
  });

  it('skips attachment entries with no usable path', async () => {
    const store = new ConversationStore(fakeIO());
    await store.save(
      withAttachments('a', 'project-1', {
        uiState: { attachments: [{ id: 'r1' }, { id: 'r2', path: '' }, null, 'nonsense'] },
      }),
    );
    expect(await store.referencedAttachmentPaths('project-1')).toEqual(new Set());
  });
});
