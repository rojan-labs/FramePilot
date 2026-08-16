import { describe, expect, it } from 'vitest';
import type { ViewNode } from '@framepilot/ai-sdk';
import { latestStreamingAssistantText } from './liveAnnouncement.js';

const userNode: ViewNode = { kind: 'user', id: 'u', ts: 0, turnId: 't', text: 'Trim it' };
const toolNode: ViewNode = {
  kind: 'tool',
  id: 'c1',
  ts: 0,
  turnId: 't',
  toolName: 'find_silence',
  status: 'completed',
};

describe('latestStreamingAssistantText (D3a)', () => {
  it('returns "" for an empty log', () => {
    expect(latestStreamingAssistantText([])).toBe('');
  });

  it('returns the growing text while the latest node is a streaming assistant message', () => {
    const nodes: ViewNode[] = [
      userNode,
      { kind: 'assistant', id: 'a', ts: 1, turnId: 't', text: 'All ', streaming: true },
    ];
    expect(latestStreamingAssistantText(nodes)).toBe('All ');
  });

  it('returns "" once the assistant message has settled (streaming: false)', () => {
    const nodes: ViewNode[] = [
      userNode,
      { kind: 'assistant', id: 'a', ts: 1, turnId: 't', text: 'All set.', streaming: false },
    ];
    // The reader already heard it incrementally while it streamed — the settled
    // text is now visible in the bubble, so the live region does not duplicate it.
    expect(latestStreamingAssistantText(nodes)).toBe('');
  });

  it('returns "" when the latest node is not an assistant message', () => {
    expect(latestStreamingAssistantText([userNode, toolNode])).toBe('');
  });

  it('ignores an EARLIER streaming assistant node once something newer has landed', () => {
    const nodes: ViewNode[] = [
      { kind: 'assistant', id: 'a', ts: 0, turnId: 't', text: 'Old reply', streaming: true },
      toolNode,
    ];
    expect(latestStreamingAssistantText(nodes)).toBe('');
  });
});
