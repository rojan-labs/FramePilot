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
import type { AiEvent, MessageAttachment, ReferenceProfile } from '@framepilot/ai-sdk';
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
  /** What the reference is for (plan/system-mission P3.2); shown on the tile. */
  readonly role?: ReferenceProfile['role'];
  /** `analyzing` while the host measures it; `ready` once a profile exists. */
  readonly status?: 'analyzing' | 'ready' | 'failed' | 'unsupported';
  readonly error?: string;
  /** Where the imported copy lives (relative to the projects root). */
  readonly path?: string;
  /**
   * The analyzed profile, validated at the host boundary.
   *
   * The SDK's own `ReferenceProfile`, not the IPC mirror `AiStreamReferenceProfile` —
   * which widens `video`/`image` to `Record<string, unknown>` and so cannot be assigned
   * to the type the run actually needs. The sidebar bridged the gap with an
   * `as unknown as` double cast, which would have kept compiling if either shape moved.
   * The host's answer is external input; it is parsed with `ReferenceProfileSchema`
   * where it arrives, and everything from there on holds the canonical type.
   */
  readonly profile?: ReferenceProfile;
}

/**
 * Freeze the composer's attachments into the message that is being sent.
 *
 * This is the whole point of the split. A composer `Attachment` is a mutable
 * work-in-progress record — it carries `status: 'analyzing'` and an `error` to retry
 * from — and it used to be the ONLY record of an attachment anywhere. So a sent
 * attachment had nowhere to live except the composer it was sent from: it stayed on
 * screen after submit, it was silently re-sent as a reference on every later turn, and
 * the chat bubble could not show it at all because a message carried nothing but text.
 *
 * Everything currently attached moves, including one whose analysis has not finished.
 * Leaving that one behind would empty the composer only partly, which is the confusing
 * half-state this change exists to remove; it simply travels without a `profile`, and
 * the bubble shows it as attached-but-unanalyzed rather than pretending it was not sent.
 *
 * `status` and `error` are dropped rather than copied: they describe work that is over
 * the moment the message is sent, and a message that keeps them would re-render when a
 * spinner elsewhere moved.
 */
export function toMessageAttachments(
  composerAttachments: readonly Attachment[],
): readonly MessageAttachment[] {
  return composerAttachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    ...(attachment.role === undefined ? {} : { role: attachment.role }),
    ...(attachment.path === undefined ? {} : { path: attachment.path }),
    ...(attachment.profile === undefined ? {} : { profile: attachment.profile }),
  }));
}

/**
 * The references currently in force for a conversation.
 *
 * Two different questions were being answered by one array, and conflating them is what
 * made the attachment lifecycle wrong in both directions:
 *
 *  - *What did the user attach to THIS message?* — provenance. Immutable, owned by the
 *    message, rendered in its bubble, replayed by Retry. That is `MessageAttachment`.
 *  - *Which references is the AI working under RIGHT NOW?* — policy. Conversation-scoped,
 *    and the SDK is explicit that it wants the complete live set on every turn: a subject
 *    missing from it means the tile is gone and its decision must stop binding
 *    (`kernel/conductor.ts`, P3.5). Sending only "what this message carried" would retire
 *    every reference on the next turn, which is the opposite of what the editor asked for
 *    by attaching it.
 *
 * So the live set is derived, not stored: every reference any message in the conversation
 * attached, in the order they were attached, minus the ones the editor has since
 * dismissed. De-duplicated by profile id, because attaching the same file to two messages
 * is still one reference — the model should not be told about it twice.
 */
export function activeReferences(
  events: readonly AiEvent[],
  dismissedIds: readonly string[] = [],
): readonly ReferenceProfile[] {
  const dismissed = new Set(dismissedIds);
  const seen = new Set<string>();
  const live: ReferenceProfile[] = [];
  for (const event of events) {
    if (event.type !== 'user_message') continue;
    for (const attachment of event.attachments ?? []) {
      const { profile } = attachment;
      if (profile === undefined) continue;
      if (dismissed.has(attachment.id) || seen.has(profile.id)) continue;
      seen.add(profile.id);
      live.push(profile);
    }
  }
  return live;
}

/** An included-context chip above the composer (M8). */
export interface ContextItem {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  /**
   * Whether the chip's remove control actually excludes this from the next turn.
   *
   * Only the selection, the pinned entities and the remembered decisions can be
   * withheld — everything else on the strip is a fact of the project snapshot the
   * orchestrator builds from, so it goes whether or not a chip is on screen. An
   * always-on fact therefore renders with no remove button: a control that
   * silently does nothing is worse than no control, and this strip's whole job is
   * to be an honest account of what the AI is given (P8.2 "knows").
   */
  readonly removable: boolean;
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
  /**
   * Attachment ids the editor has taken out of force.
   *
   * Kept as a dismissal list rather than an "active" list so it stays correct as the
   * conversation grows: a new message's attachments are in force by default, which is
   * what attaching one means.
   */
  readonly dismissedReferenceIds: readonly string[];
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
    dismissedReferenceIds: [],
  };
}

/**
 * Whether a UI state is still the untouched default — nothing typed, nothing attached,
 * nothing expanded, never scrolled.
 *
 * Used to tell a conversation STUB (opened from history, its real state still being read
 * from disk) apart from a conversation whose saved state genuinely is empty, so the
 * sidebar can re-seed itself exactly once when the load lands. Compared by value, not by
 * identity: the stub's state is a fresh {@link emptyUiState} object every time.
 */
export function isDefaultUiState(uiState: ConversationUiState): boolean {
  return (
    uiState.composerDraft === '' &&
    uiState.attachments.length === 0 &&
    uiState.context.length === 0 &&
    (uiState.dismissedReferenceIds ?? []).length === 0 &&
    uiState.collapsedToolIds.length === 0 &&
    uiState.expandedToolIds.length === 0 &&
    uiState.scrollOffset === 0 &&
    uiState.selectedEventId === null
  );
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
