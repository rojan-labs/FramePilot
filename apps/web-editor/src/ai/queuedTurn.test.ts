/**
 * The queued-turn helpers put a message back into a composer without losing what is
 * already there — the whole point of queueing is that nothing typed disappears.
 */
import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '@framepilot/ai-sdk';
import type { Attachment } from './conversation.js';
import { joinDrafts, returnAttachments } from './queuedTurn.js';

describe('joinDrafts', () => {
  it('keeps both drafts, separated by a blank line, in the given order', () => {
    expect(joinDrafts('add captions', 'and a title')).toBe('add captions\n\nand a title');
  });

  it('drops a blank side instead of leaving stray separators', () => {
    expect(joinDrafts('add captions', '   ')).toBe('add captions');
    expect(joinDrafts('', 'and a title')).toBe('and a title');
    expect(joinDrafts('', '')).toBe('');
  });
});

describe('returnAttachments', () => {
  const queued: MessageAttachment[] = [
    { id: 'r1', kind: 'video', name: 'ref.mp4' },
    { id: 'r2', kind: 'image', name: 'look.png' },
  ];

  it('returns the queued references as ready, ahead of what the composer holds', () => {
    const live: Attachment[] = [{ id: 'r3', kind: 'image', name: 'new.png', status: 'analyzing' }];
    const result = returnAttachments(queued, live);
    expect(result.map((a) => a.id)).toEqual(['r1', 'r2', 'r3']);
    expect(result[0]?.status).toBe('ready');
    // The live one is untouched — its analysis is still running.
    expect(result[2]?.status).toBe('analyzing');
  });

  it('does not add a reference the composer already holds', () => {
    const live: Attachment[] = [{ id: 'r1', kind: 'video', name: 'ref.mp4', status: 'ready' }];
    expect(returnAttachments(queued, live).map((a) => a.id)).toEqual(['r2', 'r1']);
  });

  it('hands back the same list when there is nothing to return', () => {
    const live: Attachment[] = [];
    expect(returnAttachments([], live)).toBe(live);
  });
});
