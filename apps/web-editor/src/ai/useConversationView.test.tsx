/**
 * Tests for the incremental conversation view (Phase 15 H1): identical output to
 * `reduceEvents`, O(new events) work on append-only growth, cache reset on
 * conversation switch / non-extension change, and a stable empty view.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createTurnEmitter, reduceEvents, type AiEvent } from '@framepilot/ai-sdk';
import { appendEvent, createConversation, type Conversation } from './conversation.js';
import { useConversationView } from './useConversationView.js';

const emitter = createTurnEmitter({ conversationId: 'c1', turnId: 't1', now: () => 1000 });

function conversationWith(id: string, events: readonly AiEvent[]): Conversation {
  let conversation = createConversation({ id, projectId: 'project-1', model: 'mock', now: 1000 });
  for (const event of events) conversation = appendEvent(conversation, event);
  return conversation;
}

describe('useConversationView', () => {
  it('returns an empty idle view for null', () => {
    const { result } = renderHook(() => useConversationView(null));
    expect(result.current).toEqual({ nodes: [], status: 'idle' });
  });

  it('matches reduceEvents for a full log', () => {
    const events = [
      emitter.userMessage('Trim the intro'),
      emitter.status('thinking'),
      emitter.reasoning(['Looking at the timeline'], false),
      emitter.reasoningDelta(' for silence'),
      emitter.status('completed'),
    ];
    const conversation = conversationWith('c1', events);
    const { result } = renderHook(() => useConversationView(conversation));
    expect(result.current).toEqual(reduceEvents(conversation.events));
  });

  it('extends incrementally on append-only growth and matches the full fold', () => {
    const first = conversationWith('c1', [emitter.userMessage('Hi'), emitter.status('thinking')]);
    const { result, rerender } = renderHook(({ c }) => useConversationView(c), {
      initialProps: { c: first },
    });
    const grown = appendEvent(
      appendEvent(first, emitter.delta('t1:assistant', 'Hel')),
      emitter.delta('t1:assistant', 'lo'),
    );
    rerender({ c: grown });
    expect(result.current).toEqual(reduceEvents(grown.events));
    const assistant = result.current.nodes.find((n) => n.kind === 'assistant');
    expect(assistant && 'text' in assistant ? assistant.text : '').toBe('Hello');
  });

  it('returns the cached view when the events array is unchanged', () => {
    const conversation = conversationWith('c1', [emitter.userMessage('Hi')]);
    const { result, rerender } = renderHook(({ c }) => useConversationView(c), {
      initialProps: { c: conversation },
    });
    const before = result.current;
    rerender({ c: conversation });
    expect(result.current).toBe(before);
  });

  it('rebuilds from scratch when switching conversations', () => {
    const a = conversationWith('a', [emitter.userMessage('In A')]);
    const b = conversationWith('b', [emitter.userMessage('In B')]);
    const { result, rerender } = renderHook(({ c }) => useConversationView(c), {
      initialProps: { c: a },
    });
    rerender({ c: b });
    expect(result.current).toEqual(reduceEvents(b.events));
    expect(result.current.nodes).toHaveLength(1);
  });

  it('rebuilds when the log shrinks (not an extension)', () => {
    const full = conversationWith('c1', [emitter.userMessage('One'), emitter.status('completed')]);
    const shorter = conversationWith('c1', [emitter.userMessage('One')]);
    const { result, rerender } = renderHook(({ c }) => useConversationView(c), {
      initialProps: { c: full },
    });
    rerender({ c: shorter });
    expect(result.current).toEqual(reduceEvents(shorter.events));
  });

  it('rebuilds when the tail identity differs (replaced log)', () => {
    const original = conversationWith('c1', [emitter.userMessage('One')]);
    // Same length +1 but a DIFFERENT first element identity → not an extension.
    const replaced = conversationWith('c1', [
      emitter.userMessage('Other'),
      emitter.status('completed'),
    ]);
    const { result, rerender } = renderHook(({ c }) => useConversationView(c), {
      initialProps: { c: original },
    });
    rerender({ c: replaced });
    expect(result.current).toEqual(reduceEvents(replaced.events));
  });
});
