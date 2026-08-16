/**
 * Tests for the pure conversation helpers (Phase 11 M2): create/append/title/
 * date-grouping/markRead. These are the load-bearing logic the store + persistence
 * build on, so they are covered thoroughly.
 */
import { describe, expect, it } from 'vitest';
import { createTurnEmitter } from '@framepilot/ai-sdk';
import {
  DEFAULT_TITLE,
  appendEvent,
  createConversation,
  deriveTitle,
  groupByDate,
  markRead,
} from './conversation.js';

const emitter = (turnId = 'turn_1') =>
  createTurnEmitter({ conversationId: 'c1', turnId, now: () => 1000 });

const base = () => createConversation({ projectId: 'project-1', id: 'c1', model: 'mock', now: 0 });

describe('createConversation', () => {
  it('starts empty, unread-false, agent mode, with the default title', () => {
    const conv = base();
    expect(conv).toMatchObject({ title: DEFAULT_TITLE, mode: 'agent', unread: false, events: [] });
    expect(conv.createdAt).toBe(0);
  });

  it('honors an explicit mode', () => {
    expect(
      createConversation({ projectId: 'project-1', id: 'c1', model: 'm', mode: 'chat', now: 0 })
        .mode,
    ).toBe('chat');
  });
});

describe('deriveTitle', () => {
  it('uses the first user message, truncating long prompts', () => {
    const e = emitter();
    expect(deriveTitle([e.userMessage('Trim the intro')])).toBe('Trim the intro');
    const long = 'x'.repeat(100);
    expect(deriveTitle([e.userMessage(long)]).endsWith('…')).toBe(true);
  });

  it('falls back to the default with no/blank user message', () => {
    const e = emitter();
    expect(deriveTitle([])).toBe(DEFAULT_TITLE);
    expect(deriveTitle([e.userMessage('   ')])).toBe(DEFAULT_TITLE);
    expect(deriveTitle([e.status('thinking')])).toBe(DEFAULT_TITLE);
  });
});

describe('appendEvent', () => {
  it('appends, advances updatedAt, derives the title from the first prompt', () => {
    const e = emitter();
    const next = appendEvent(base(), e.userMessage('Make it punchy'));
    expect(next.events).toHaveLength(1);
    expect(next.updatedAt).toBe(1000);
    expect(next.title).toBe('Make it punchy');
  });

  it('marks unread for assistant activity but not the user’s own message', () => {
    const e = emitter();
    expect(appendEvent(base(), e.userMessage('hi')).unread).toBe(false);
    expect(appendEvent(base(), e.assistant('a', 'done')).unread).toBe(true);
  });

  it('keeps a user-set title instead of re-deriving', () => {
    const e = emitter();
    const renamed = { ...base(), title: 'Custom' };
    expect(appendEvent(renamed, e.userMessage('ignored')).title).toBe('Custom');
  });
});

describe('markRead', () => {
  it('clears unread and is a no-op when already read', () => {
    const unread = { ...base(), unread: true };
    expect(markRead(unread).unread).toBe(false);
    const read = base();
    expect(markRead(read)).toBe(read);
  });
});

describe('groupByDate', () => {
  const now = new Date('2026-06-30T12:00:00Z').getTime();
  const day = 86_400_000;
  const at = (id: string, updatedAt: number) => ({ ...base(), id, updatedAt });

  it('buckets by recency in display order and drops empty groups', () => {
    const groups = groupByDate(
      [
        at('today', now),
        at('yesterday', now - day),
        at('week', now - 4 * day),
        at('month', now - 20 * day),
        at('old', now - 200 * day),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 Days',
      'Previous 30 Days',
      'Older',
    ]);
  });

  it('orders within a group most-recent-first', () => {
    const groups = groupByDate([at('a', now - 1000), at('b', now - 10)], now);
    expect(groups[0]?.conversations.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('returns nothing for an empty input', () => {
    expect(groupByDate([], now)).toEqual([]);
  });
});
