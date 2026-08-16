/**
 * Incremental conversation-view hook (Phase 15 H1).
 *
 * `reduceEvents` re-folds the WHOLE event log on every render — during streaming
 * that is O(n²) per turn and was a measured root cause of laggy token updates on
 * long conversations. This hook holds a {@link ConversationViewBuilder} and feeds it
 * only the events appended since the previous render, falling back to a full rebuild
 * whenever the log is not a pure extension (conversation switch, hydrate, delete).
 *
 * The extension check is O(1): the log is append-only and immutable (`appendEvent`
 * copies the array, never its elements), so "same conversation id, not shorter, and
 * the element at the old tail is identical" proves the old log is a prefix.
 */
import { useMemo, useRef } from 'react';
import {
  createConversationViewBuilder,
  type AiEvent,
  type ConversationView,
  type ConversationViewBuilder,
} from '@framepilot/ai-sdk';
import type { Conversation } from './conversation.js';

const EMPTY_VIEW: ConversationView = { nodes: [], status: 'idle' };

interface ViewCache {
  readonly conversationId: string;
  readonly events: readonly AiEvent[];
  readonly builder: ConversationViewBuilder;
  readonly view: ConversationView;
}

/** True when `events` extends `cache.events` for the same conversation (O(1)). */
function extendsCache(
  cache: ViewCache,
  conversationId: string,
  events: readonly AiEvent[],
): boolean {
  if (cache.conversationId !== conversationId) return false;
  if (events.length < cache.events.length) return false;
  if (cache.events.length === 0) return true;
  return events[cache.events.length - 1] === cache.events[cache.events.length - 1];
}

/** The render-ready view of `conversation`, computed incrementally across renders. */
export function useConversationView(conversation: Conversation | null): ConversationView {
  const cacheRef = useRef<ViewCache | null>(null);

  return useMemo(() => {
    if (!conversation) {
      cacheRef.current = null;
      return EMPTY_VIEW;
    }
    const { id, events } = conversation;
    const cache = cacheRef.current;

    if (cache && extendsCache(cache, id, events)) {
      if (events === cache.events) return cache.view;
      for (let i = cache.events.length; i < events.length; i += 1) {
        const event = events[i];
        if (event) cache.builder.push(event);
      }
      const next: ViewCache = { ...cache, events, view: cache.builder.view() };
      cacheRef.current = next;
      return next.view;
    }

    const builder = createConversationViewBuilder();
    for (const event of events) builder.push(event);
    const fresh: ViewCache = { conversationId: id, events, builder, view: builder.view() };
    cacheRef.current = fresh;
    return fresh.view;
  }, [conversation]);
}
