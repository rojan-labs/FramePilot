/**
 * Conversation model for the streaming AI sidebar (Phase 11 M2, ADR 0033).
 *
 * A conversation IS an append-only log of {@link AiEvent}s plus light metadata and
 * per-conversation UI state. These are **pure, framework-agnostic** types and
 * helpers — the in-memory store ({@link file://./conversationStore.ts}) and the
 * persistence adapters ({@link file://./conversationPersistence.ts}) build on them.
 * Nothing here is stored in `project.fp.json`; conversations are a separate store
 * (AGENTS.md invariant 4 / ADR 0033).
 *
 * Snapshots are treated as immutable: every helper returns a new object rather than
 * mutating, mirroring `editor/store.ts` so React can diff by identity.
 */
import type { AiEvent } from '@framepilot/ai-sdk';
import type { ConversationSummary } from '@framepilot/shared-types';

export type ConversationMode = 'agent' | 'chat' | 'edit';

/** The default title before the first user prompt derives a real one. */
export const DEFAULT_TITLE = 'New chat';

/** Max characters of the first prompt used as an auto-derived title. */
const MAX_TITLE_LENGTH = 60;

const MS_PER_DAY = 86_400_000;

/** A composer attachment chip (M8 threads these into the orchestrator context). */
export interface Attachment {
  readonly id: string;
  readonly kind: 'image' | 'video' | 'audio' | 'timeline' | 'project' | 'document';
  readonly name: string;
}

/** An included-context chip above the composer (M8). */
export interface ContextItem {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
}

/** Per-conversation UI state, persisted so a reload restores exactly where you were. */
export interface ConversationUiState {
  readonly collapsedToolIds: readonly string[];
  readonly expandedToolIds: readonly string[];
  readonly scrollOffset: number;
  readonly selectedEventId: string | null;
  readonly composerDraft: string;
  readonly attachments: readonly Attachment[];
  readonly context: readonly ContextItem[];
}

/** One persisted conversation: metadata + the append-only event log + UI state. */
export interface Conversation {
  readonly id: string;
  /** Project that owns this conversation. */
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Provider/model label used (e.g. "anthropic/claude-opus-4-8"). */
  readonly model: string;
  readonly mode: ConversationMode;
  readonly pinned: boolean;
  readonly favorite: boolean;
  readonly unread: boolean;
  readonly events: readonly AiEvent[];
  readonly uiState: ConversationUiState;
}

/** A fresh, empty UI state. */
export function emptyUiState(): ConversationUiState {
  return {
    collapsedToolIds: [],
    expandedToolIds: [],
    scrollOffset: 0,
    selectedEventId: null,
    composerDraft: '',
    attachments: [],
    context: [],
  };
}

/** Options for {@link createConversation}. */
export interface CreateConversationOptions {
  readonly id: string;
  readonly projectId: string;
  readonly model: string;
  readonly mode?: ConversationMode;
  /** Creation clock (injectable for deterministic tests). */
  readonly now?: number;
}

/** Create a new, empty conversation. */
export function createConversation(options: CreateConversationOptions): Conversation {
  const now = options.now ?? Date.now();
  return {
    id: options.id,
    projectId: options.projectId,
    title: DEFAULT_TITLE,
    createdAt: now,
    updatedAt: now,
    model: options.model,
    mode: options.mode ?? 'agent',
    pinned: false,
    favorite: false,
    unread: false,
    events: [],
    uiState: emptyUiState(),
  };
}

/**
 * A conversation the history list can show but whose event log has not been read yet.
 *
 * WHY this shape exists: hydrating the sidebar used to `load()` every conversation in
 * the project, so opening an editor pulled every past run's full event log — including
 * every tool-result payload — into the heap and kept it there for the whole session. A
 * handful of long agent runs is tens of megabytes apiece, and none of it is on screen:
 * the history list renders only the metadata a `ConversationSummary` already carries.
 * The log is now fetched when a conversation is actually opened, and dropped again when
 * it falls out of the working set (see `useConversations`).
 *
 * A stub is indistinguishable from a loaded conversation to every consumer except that
 * its `events` are empty and its `uiState` is the default — both restored verbatim by
 * the load that opening it triggers.
 *
 * @param summary - The lightweight record `ConversationPersistence.list()` returns.
 */
export function stubFromSummary(summary: ConversationSummary): Conversation {
  return {
    id: summary.id,
    projectId: summary.projectId,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    model: summary.model,
    mode: summary.mode as ConversationMode,
    pinned: summary.pinned,
    favorite: summary.favorite,
    unread: summary.unread,
    events: [],
    uiState: emptyUiState(),
  };
}

/**
 * Derive a conversation title from its first user message, truncated. Falls back to
 * {@link DEFAULT_TITLE} when there is no (non-empty) user message yet.
 */
export function deriveTitle(events: readonly AiEvent[]): string {
  const firstUser = events.find((e) => e.type === 'user_message');
  const text = firstUser?.type === 'user_message' ? firstUser.text.trim() : '';
  if (text.length === 0) return DEFAULT_TITLE;
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH).trimEnd()}…` : text;
}

/**
 * Append one event to a conversation's log (immutably). Advances `updatedAt` to the
 * event's timestamp, auto-derives the title while it is still the default, and marks
 * the conversation unread when the new event is not the user's own message.
 */
export function appendEvent(conversation: Conversation, event: AiEvent): Conversation {
  const events = [...conversation.events, event];
  const title = conversation.title === DEFAULT_TITLE ? deriveTitle(events) : conversation.title;
  const unread = event.type === 'user_message' ? conversation.unread : true;
  return { ...conversation, events, updatedAt: event.ts, title, unread };
}

/**
 * Append one streamed UI batch with a single event-array allocation. Repeatedly
 * calling {@link appendEvent} copied the growing conversation once per token in
 * the batch, turning a high-throughput agent stream into avoidable main-thread work.
 */
export function appendEvents(
  conversation: Conversation,
  incoming: readonly AiEvent[],
): Conversation {
  if (incoming.length === 0) return conversation;
  const events = [...conversation.events, ...incoming];
  const title = conversation.title === DEFAULT_TITLE ? deriveTitle(events) : conversation.title;
  const unread = incoming.some((event) => event.type !== 'user_message') || conversation.unread;
  const last = incoming[incoming.length - 1];
  return {
    ...conversation,
    events,
    updatedAt: last?.ts ?? conversation.updatedAt,
    title,
    unread,
  };
}

/** Mark a conversation read (clears the unread dot). */
export function markRead(conversation: Conversation): Conversation {
  return conversation.unread ? { ...conversation, unread: false } : conversation;
}

/** Replace a conversation's UI state (immutably). */
export function withUiState(
  conversation: Conversation,
  uiState: ConversationUiState,
): Conversation {
  return { ...conversation, uiState };
}

/** The date-bucket labels, in display order. */
export const DATE_GROUP_ORDER = [
  'Today',
  'Yesterday',
  'Previous 7 Days',
  'Previous 30 Days',
  'Older',
] as const;

export type DateGroupLabel = (typeof DATE_GROUP_ORDER)[number];

/** A labeled group of conversations for the history drawer. */
export interface ConversationGroup {
  readonly label: DateGroupLabel;
  readonly conversations: readonly Conversation[];
}

/** Pick the date-bucket a timestamp falls into, relative to the start of today. */
function bucketFor(updatedAt: number, startOfToday: number): DateGroupLabel {
  if (updatedAt >= startOfToday) return 'Today';
  if (updatedAt >= startOfToday - MS_PER_DAY) return 'Yesterday';
  if (updatedAt >= startOfToday - 7 * MS_PER_DAY) return 'Previous 7 Days';
  if (updatedAt >= startOfToday - 30 * MS_PER_DAY) return 'Previous 30 Days';
  return 'Older';
}

/**
 * Group conversations into Today / Yesterday / Previous 7 / Previous 30 / Older by
 * `updatedAt`, most-recent-first within each group, dropping empty groups.
 *
 * @param conversations - The conversations to group.
 * @param now - The reference clock (injectable for deterministic tests).
 */
export function groupByDate(
  conversations: readonly Conversation[],
  now: number = Date.now(),
): ConversationGroup[] {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const byLabel = new Map<DateGroupLabel, Conversation[]>();
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const conversation of sorted) {
    const label = bucketFor(conversation.updatedAt, startOfToday);
    const existing = byLabel.get(label);
    if (existing) existing.push(conversation);
    else byLabel.set(label, [conversation]);
  }
  return DATE_GROUP_ORDER.filter((label) => byLabel.has(label)).map((label) => ({
    label,
    conversations: byLabel.get(label) ?? [],
  }));
}
