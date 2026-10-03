/**
 * Incremental conversation-view hook (Phase 15 H1).
 *
 * `reduceEvents` re-folds the WHOLE event log on every render — during streaming
 * that is O(n²) per turn and was a measured root cause of laggy token updates on
 * long conversations. This hook holds a {@link ConversationViewBuilder} and feeds it
 * only the events appended since the previous render, falling back to a full rebuild
 * whenever the log is not a continuation (conversation switch, hydrate, delete).
 *
 * The common check is O(1): the log is append-only and immutable (`appendEvent`
 * copies the array, never its elements), so "same conversation id, not shorter, and
 * the element at the old tail is identical" proves the old log is a prefix.
 *
 * One append is not a pure extension: when a turn's next `run_state` ledger arrives,
 * `conversation.ts` drops the one it supersedes. Only `run_state` is ever dropped, so the
 * fold resumes after the last folded event that is NOT a ledger — its {@link anchor} —
 * which is found by a short scan back from the tail. Ledgers after the anchor may be
 * folded twice; a ledger only replaces the view's `runState`, so that is harmless.
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
  /** The last folded event that compaction can never remove: anything but a `run_state`. */
  readonly anchor: AiEvent | undefined;
}

/** The last event of `events` that is not a `run_state`, scanning back from `end`. */
function lastAnchor(events: readonly AiEvent[], end = events.length): AiEvent | undefined {
  for (let i = end - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.type !== 'run_state') return event;
  }
  return undefined;
}

/**
 * Where the unfolded part of `events` starts when it continues `cache`'s log, or `-1`
 * when it does not (a different conversation, a reload, a removal).
 */
export function resumeIndex(
  cache: Pick<ViewCache, 'conversationId' | 'events' | 'anchor'>,
  conversationId: string,
  events: readonly AiEvent[],
): number {
  if (cache.conversationId !== conversationId) return -1;
  const folded = cache.events.length;
  if (folded === 0) return 0;
  if (events.length >= folded && events[folded - 1] === cache.events[folded - 1]) return folded;
  // A compacting append. The anchor sits within the last batch or two of the tail, so
  // this scan is proportional to what was appended, not to the conversation.
  const anchor = cache.anchor;
  if (anchor === undefined) return -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i] === anchor) return i + 1;
  }
  return -1;
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
    const resumeAt = cache ? resumeIndex(cache, id, events) : -1;

    if (cache && resumeAt >= 0) {
      if (events === cache.events) return cache.view;
      for (let i = resumeAt; i < events.length; i += 1) {
        const event = events[i];
        if (event) cache.builder.push(event);
      }
      const next: ViewCache = {
        ...cache,
        events,
        view: cache.builder.view(),
        anchor: lastAnchor(events) ?? cache.anchor,
      };
      cacheRef.current = next;
      return next.view;
    }

    const builder = createConversationViewBuilder();
    for (const event of events) builder.push(event);
    const fresh: ViewCache = {
      conversationId: id,
      events,
      builder,
      view: builder.view(),
      anchor: lastAnchor(events),
    };
    cacheRef.current = fresh;
    return fresh.view;
  }, [conversation]);
}
