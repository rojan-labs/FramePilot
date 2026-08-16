/**
 * Tests for conversation export (Phase 11 M7): Markdown transcript + JSON round-trip.
 */
import { describe, expect, it } from 'vitest';
import { createTurnEmitter } from '@framepilot/ai-sdk';
import { appendEvent, createConversation } from './conversation.js';
import { toJson, toMarkdown } from './conversationExport.js';

const build = () => {
  const em = createTurnEmitter({ conversationId: 'c', turnId: 't', now: () => 1 });
  let conv = createConversation({ projectId: 'project-1', id: 'c1', model: 'mock', now: 0 });
  conv = appendEvent(conv, em.userMessage('Trim the intro'));
  conv = appendEvent(conv, em.assistant('a', 'Done — trimmed 3s.'));
  return conv;
};

describe('toMarkdown', () => {
  it('renders a titled transcript with You/FramePilot lines', () => {
    const md = toMarkdown(build());
    expect(md).toContain('# Trim the intro');
    expect(md).toContain('**You:** Trim the intro');
    expect(md).toContain('**FramePilot:** Done — trimmed 3s.');
  });
});

describe('toJson', () => {
  it('round-trips the exact conversation record', () => {
    const conv = build();
    expect(JSON.parse(toJson(conv))).toEqual(conv);
  });
});
