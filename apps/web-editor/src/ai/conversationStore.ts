/**
 * In-memory conversation store (Phase 11 M2, ADR 0033).
 *
 * A pure, framework-agnostic store over a map of {@link Conversation}s plus the
 * active id — mirroring `editor/store.ts`. All transitions return a new immutable
 * state so React (the {@link file://./useConversations.ts} adapter) can diff by
 * identity and a persistence adapter can save just what changed. Streaming appends
 * one event at a time via {@link appendEventTo}, touching only the active
 * conversation's identity, not the whole collection.
 */
import type { AiEvent } from '@framepilot/ai-sdk';
import {
  type Conversation,
  type ConversationUiState,
  appendEvent,
  appendEvents,
  markRead,
  withUiState,
} from './conversation.js';

/** The whole sidebar state: conversations by id + the active selection. */
export interface ConversationsState {
  readonly byId: Readonly<Record<string, Conversation>>;
  readonly activeId: string | null;
}

/** An empty store. */
export function createConversationsState(
  conversations: readonly Conversation[] = [],
  activeId: string | null = null,
): ConversationsState {
  const byId: Record<string, Conversation> = {};
  for (const conversation of conversations) byId[conversation.id] = conversation;
  return { byId, activeId };
}

/** Insert or replace a conversation (used by create + persistence hydrate). */
export function upsertConversation(
  state: ConversationsState,
  conversation: Conversation,
): ConversationsState {
  return { ...state, byId: { ...state.byId, [conversation.id]: conversation } };
}

/** Remove a conversation; clears `activeId` if it was the one removed. */
export function removeConversation(state: ConversationsState, id: string): ConversationsState {
  if (!(id in state.byId)) return state;
  const byId = { ...state.byId };
  delete byId[id];
  return { byId, activeId: state.activeId === id ? null : state.activeId };
}

/** Set the active conversation (and mark it read). */
export function setActiveConversation(
  state: ConversationsState,
  id: string | null,
): ConversationsState {
  if (id === null) return { ...state, activeId: null };
  const conversation = state.byId[id];
  if (!conversation) return state;
  return { byId: { ...state.byId, [id]: markRead(conversation) }, activeId: id };
}

/** Append a streamed event to a conversation (no-op if it is unknown). */
export function appendEventTo(
  state: ConversationsState,
  id: string,
  event: AiEvent,
): ConversationsState {
  const conversation = state.byId[id];
  if (!conversation) return state;
  return upsertConversation(state, appendEvent(conversation, event));
}

/** Append a streamed batch while copying the active conversation and state map once. */
export function appendEventsTo(
  state: ConversationsState,
  id: string,
  events: readonly AiEvent[],
): ConversationsState {
  const conversation = state.byId[id];
  if (!conversation || events.length === 0) return state;
  return upsertConversation(state, appendEvents(conversation, events));
}

/** Apply a partial metadata patch to a conversation (rename/pin/favorite/model/mode). */
export function patchConversation(
  state: ConversationsState,
  id: string,
  patch: Partial<Pick<Conversation, 'title' | 'pinned' | 'favorite' | 'model' | 'mode'>>,
): ConversationsState {
  const conversation = state.byId[id];
  if (!conversation) return state;
  return upsertConversation(state, { ...conversation, ...patch });
}

/** Replace a conversation's persisted UI state (scroll/draft/collapsed tools/…). */
export function setConversationUiState(
  state: ConversationsState,
  id: string,
  uiState: ConversationUiState,
): ConversationsState {
  const conversation = state.byId[id];
  if (!conversation) return state;
  return upsertConversation(state, withUiState(conversation, uiState));
}

/**
 * Duplicate a conversation (copies its event log) under a new id.
 *
 * ## Attachment identity is deliberately NOT regenerated
 *
 * The copy carries the source's `uiState.attachments` and every message's attachments
 * verbatim: same attachment ids, same on-disk `path`s, same `ReferenceProfile.id`s. Three
 * separate questions were asked of that, and each answers "safe":
 *
 *  - **The files.** Two conversations naming one path is exactly the case the host's
 *    reachability sweep is built for — a file is reclaimed only when NO conversation in
 *    the project references it, so the copy keeps the original's attachments alive and
 *    deleting either conversation strands nothing the other still shows.
 *  - **`ReferenceProfile.id` as a decision subject.** A reference decision is bound to a
 *    profile id and carried across runs by `carryForwardWorkingState`, which refuses to
 *    carry anything unless the CONVERSATION and the project both match. A run in the copy
 *    can therefore never inherit, retire, or reconsider a decision made in the original,
 *    and `referenceDecisions` builds its lookup from one conversation's live references.
 *    Uniqueness is required within a conversation, and duplication preserves that.
 *  - **Dismissal.** `dismissedReferenceIds` lives in each conversation's own `uiState`, so
 *    stopping a reference in the copy leaves the original using it.
 *
 * Regenerating the ids would have to rewrite the event log — a message's attachments, the
 * profile inside it and the dismissal list all key off each other — which is a rewrite of
 * history to solve a collision that has no consumer. If a project-scoped consumer of
 * `ReferenceProfile.id` is ever added, this is the decision that has to be revisited.
 */
export function duplicateConversation(
  state: ConversationsState,
  id: string,
  newId: string,
  now: number,
): ConversationsState {
  const source = state.byId[id];
  if (!source) return state;
  return upsertConversation(state, {
    ...source,
    id: newId,
    title: `${source.title} (copy)`,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    unread: false,
  });
}

/** Mark a conversation read. */
export function markConversationRead(state: ConversationsState, id: string): ConversationsState {
  const conversation = state.byId[id];
  if (!conversation) return state;
  return upsertConversation(state, markRead(conversation));
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The active conversation, or null. */
export function selectActiveConversation(state: ConversationsState): Conversation | null {
  return state.activeId ? (state.byId[state.activeId] ?? null) : null;
}

/**
 * All conversations ordered for the history list: pinned first, then by most recent
 * activity (`updatedAt` desc), ties broken by id for a stable order.
 */
export function selectOrderedConversations(state: ConversationsState): Conversation[] {
  return Object.values(state.byId).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id.localeCompare(b.id);
  });
}

/** Count of unread conversations (drives a header badge). */
export function selectUnreadCount(state: ConversationsState): number {
  return Object.values(state.byId).filter((c) => c.unread).length;
}
