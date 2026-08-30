/**
 * Tests for the pure conversation store (Phase 11 M2): upsert/remove/active/append,
 * metadata patches, UI state, and the ordering/selector logic.
 */
import { describe, expect, it } from 'vitest';
import { createTurnEmitter } from '@framepilot/ai-sdk';
import { createConversation, emptyUiState } from './conversation.js';
import {
  appendEventTo,
  createConversationsState,
  duplicateConversation,
  markConversationRead,
  patchConversation,
  removeConversation,
  selectActiveConversation,
  selectOrderedConversations,
  selectUnreadCount,
  setActiveConversation,
  setConversationUiState,
  upsertConversation,
} from './conversationStore.js';

const conv = (id: string, over: Partial<ReturnType<typeof createConversation>> = {}) => ({
  ...createConversation({ id, projectId: 'project-1', model: 'mock', now: 0 }),
  ...over,
});
const e = createTurnEmitter({ conversationId: 'c1', turnId: 't', now: () => 5 });

describe('conversation store transitions', () => {
  it('upserts and removes, clearing active when the active one is removed', () => {
    let state = createConversationsState();
    state = upsertConversation(state, conv('a'));
    state = setActiveConversation(state, 'a');
    expect(selectActiveConversation(state)?.id).toBe('a');
    state = removeConversation(state, 'a');
    expect(state.activeId).toBeNull();
    expect(removeConversation(state, 'missing')).toBe(state);
  });

  it('marks a conversation read when it becomes active', () => {
    let state = createConversationsState([conv('a', { unread: true })]);
    state = setActiveConversation(state, 'a');
    expect(selectActiveConversation(state)?.unread).toBe(false);
    expect(setActiveConversation(state, 'missing')).toBe(state);
    expect(setActiveConversation(state, null).activeId).toBeNull();
  });

  it('appends events only to known conversations', () => {
    let state = createConversationsState([conv('a')]);
    state = appendEventTo(state, 'a', e.userMessage('hi'));
    expect(selectActiveConversation(setActiveConversation(state, 'a'))?.events).toHaveLength(1);
    expect(appendEventTo(state, 'missing', e.userMessage('x'))).toBe(state);
  });

  it('patches metadata, sets UI state, and marks read (no-op on unknown id)', () => {
    let state = createConversationsState([conv('a', { unread: true })]);
    state = patchConversation(state, 'a', { title: 'Renamed', pinned: true });
    expect(state.byId['a']).toMatchObject({ title: 'Renamed', pinned: true });
    const ui = { ...emptyUiState(), composerDraft: 'draft' };
    state = setConversationUiState(state, 'a', ui);
    expect(state.byId['a']?.uiState.composerDraft).toBe('draft');
    state = markConversationRead(state, 'a');
    expect(state.byId['a']?.unread).toBe(false);
    expect(patchConversation(state, 'x', { title: 't' })).toBe(state);
    expect(setConversationUiState(state, 'x', ui)).toBe(state);
    expect(markConversationRead(state, 'x')).toBe(state);
  });

  it('duplicates a conversation under a new id, unpinned, "(copy)"', () => {
    const e2 = createTurnEmitter({ conversationId: 'a', turnId: 't', now: () => 5 });
    let state = createConversationsState([{ ...conv('a', { pinned: true, title: 'Mine' }) }]);
    state = appendEventTo(state, 'a', e2.userMessage('hi'));
    state = duplicateConversation(state, 'a', 'a-copy', 99);
    expect(state.byId['a-copy']).toMatchObject({
      id: 'a-copy',
      title: 'Mine (copy)',
      pinned: false,
      createdAt: 99,
    });
    expect(state.byId['a-copy']?.events).toHaveLength(1);
    expect(duplicateConversation(state, 'missing', 'x', 1)).toBe(state);
  });

  /**
   * D10: the copy carries attachment identity verbatim, and this pins the two properties
   * that make that safe rather than merely convenient — the shared file stays referenced
   * by BOTH conversations (so the host's reachability sweep can never free it while
   * either still shows it), and dismissal stays per-conversation (so stopping a reference
   * in the copy does not retire it in the original).
   */
  it('shares attachment identity with the original, and keeps dismissal per conversation', () => {
    const attachment = {
      id: 'r1',
      kind: 'video' as const,
      name: 'ref.mp4',
      path: 'media/p/attachments/ref.mp4',
    };
    const source = conv('a', {
      uiState: { ...emptyUiState(), attachments: [attachment] },
    });
    let state = createConversationsState([source]);
    state = duplicateConversation(state, 'a', 'a-copy', 99);

    expect(state.byId['a-copy']?.uiState.attachments?.[0]?.path).toBe(attachment.path);
    // Both conversations name the file, which is exactly the union the sweep computes.
    const referenced = Object.values(state.byId).flatMap((c) =>
      (c.uiState.attachments ?? []).map((a) => a.path),
    );
    expect(referenced).toEqual([attachment.path, attachment.path]);

    // Dismissal lives in each conversation's own uiState, so the copy's decision is its own.
    state = setConversationUiState(state, 'a-copy', {
      ...state.byId['a-copy']!.uiState,
      dismissedReferenceIds: ['r1'],
    });
    expect(state.byId['a']?.uiState.dismissedReferenceIds ?? []).toEqual([]);
  });
});

describe('selectors', () => {
  it('orders pinned first, then by recency, then by id', () => {
    const state = createConversationsState([
      conv('a', { updatedAt: 10 }),
      conv('b', { updatedAt: 30 }),
      conv('c', { updatedAt: 20, pinned: true }),
    ]);
    expect(selectOrderedConversations(state).map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });

  it('counts unread conversations and returns null active by default', () => {
    const state = createConversationsState([conv('a', { unread: true }), conv('b')]);
    expect(selectUnreadCount(state)).toBe(1);
    expect(selectActiveConversation(state)).toBeNull();
  });
});
