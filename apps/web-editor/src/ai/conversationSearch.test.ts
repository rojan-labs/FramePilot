/**
 * Tests for conversation search (Phase 11 M7): searchable text spans titles,
 * messages, tool output, and edit summaries; substring match with recency order.
 */
import { describe, expect, it } from 'vitest';
import { createTurnEmitter } from '@framepilot/ai-sdk';
import { appendEvent, createConversation } from './conversation.js';
import { conversationText, searchConversations } from './conversationSearch.js';

const e = (turnId: string) => createTurnEmitter({ conversationId: 'c', turnId, now: () => 1 });

const withEvents = (
  id: string,
  updatedAt: number,
  build: (em: ReturnType<typeof e>) => unknown[],
) => {
  let conv = {
    ...createConversation({ id, projectId: 'project-1', model: 'mock', now: 0 }),
    updatedAt,
  };
  for (const event of build(e(id)) as Parameters<typeof appendEvent>[1][]) {
    conv = { ...appendEvent(conv, event), updatedAt };
  }
  return conv;
};

describe('conversationText', () => {
  it('includes title, messages, tool output, and edit summaries', () => {
    const conv = withEvents('c1', 1, (em) => [
      em.userMessage('Trim the intro'),
      em.toolResult('t', { summary: 'found 3 silent gaps', files: ['voiceover.wav'] }),
      em.timelineAction('Deleted range', '0s–3s'),
    ]);
    const text = conversationText(conv).toLowerCase();
    expect(text).toContain('trim the intro');
    expect(text).toContain('silent gaps');
    expect(text).toContain('voiceover.wav');
    expect(text).toContain('deleted range');
  });
});

describe('searchConversations', () => {
  const a = withEvents('a', 10, (em) => [em.userMessage('add captions please')]);
  const b = withEvents('b', 20, (em) => [em.userMessage('remove silence')]);

  it('returns all, most-recent-first, for an empty query', () => {
    expect(searchConversations([a, b], '   ').map((h) => h.conversation.id)).toEqual(['b', 'a']);
  });

  it('matches across message text and returns a snippet', () => {
    const hits = searchConversations([a, b], 'captions');
    expect(hits.map((h) => h.conversation.id)).toEqual(['a']);
    expect(hits[0]?.snippet.toLowerCase()).toContain('captions');
  });

  it('returns nothing when there is no match', () => {
    expect(searchConversations([a, b], 'zzz')).toEqual([]);
  });
});
