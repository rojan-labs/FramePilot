/**
 * React adapter over the pure conversation store (Phase 11 M2, ADR 0033).
 *
 * A thin `useReducer` wrapper — all logic lives in `conversation.ts` /
 * `conversationStore.ts` (unit-tested there); this marshals actions, derives the
 * ordered list, and (when a {@link ConversationPersistence} is supplied) **debounce-
 * autosaves** changed conversations and deletes removed ones, so a reload restores
 * exactly where you were. Nothing is written to `project.fp.json`.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { AiEvent } from '@framepilot/ai-sdk';
import { createLogger } from '@framepilot/shared-types';
import {
  type Conversation,
  type ConversationUiState,
  type CreateConversationOptions,
  createConversation,
  emptyUiState,
  stubFromSummary,
} from './conversation.js';
import {
  type ConversationsState,
  appendEventTo,
  appendEventsTo,
  createConversationsState,
  duplicateConversation,
  patchConversation,
  removeConversation,
  selectActiveConversation,
  selectOrderedConversations,
  selectUnreadCount,
  setActiveConversation,
  setConversationUiState,
  upsertConversation,
} from './conversationStore.js';
import type { ConversationPersistence } from './conversationPersistence.js';

/** Default debounce window before a changed conversation is persisted (ms). */
export const CONVERSATION_SAVE_DEBOUNCE_MS = 400;

const log = createLogger('web-editor:ai:conversations');

/**
 * How many conversations may hold their event log in memory at once.
 *
 * Every log is on disk, so an evicted one costs a re-read (milliseconds) to open again;
 * a retained one costs its full size (tens of MB for a long agent run) for the whole
 * session. Three covers the real working set — the run you are in, the one you just came
 * from, and the one you are comparing against — and bounds the sidebar's heap by
 * construction rather than by hoping nobody keeps thirty chats.
 */
export const MAX_LOADED_CONVERSATIONS = 3;

/**
 * The last committed store state, held OUTSIDE React so a remount cannot lose it.
 *
 * WHY this exists: a host-side auto-commit publishes `projectChanged`, and the app
 * deliberately remounts the editor (`key={project.id}:{reloadNonce}` in `App.tsx`) so the
 * timeline store re-seeds from the authoritative project. That remount also re-creates
 * this hook. With the event log living only in `useReducer` state, everything appended
 * since the last {@link CONVERSATION_SAVE_DEBOUNCE_MS} autosave was simply gone, and
 * hydrate then restored the older on-disk record over the top — a silent hole in the
 * middle of a live run. It cost real transcript rows: the step's tool cards AND the
 * `reasoning done` event that settles its "Thinking…" row, which is why a mid-run commit
 * left a shimmer stranded in the thread forever.
 *
 * The log is append-only and the remount is same-document, so carrying the exact state
 * across it is a restore, never a merge: the run keeps streaming into the same records it
 * was already writing to, and the autosave diff (`prevById`) rides along so the restore
 * does not re-write every conversation it just recovered.
 *
 * Scoped by `projectId`: the same `App.tsx` remount key (`project.id:reloadNonce`) also
 * fires on an actual project switch, not just a same-project auto-commit. Without the
 * `projectId` guard, `hydrate`'s merge-only reducer case never evicts the previous
 * project's conversations, so they kept accumulating in the history list across switches.
 */
let remountCache: {
  projectId: string | null;
  state: ConversationsState;
  prevById: ConversationsState['byId'];
  /** Ids whose event log is NOT in memory — see {@link MAX_LOADED_CONVERSATIONS}. */
  stubIds: ReadonlySet<string>;
} | null = null;

/**
 * Drop the cross-remount cache. Tests only — each test must start from an empty store,
 * and the cache is module state that would otherwise leak between them.
 */
export function resetConversationsRemountCache(): void {
  remountCache = null;
}

type MetaPatch = Parameters<typeof patchConversation>[2];

type Action =
  | { readonly type: 'hydrate'; readonly conversations: readonly Conversation[] }
  | { readonly type: 'loaded'; readonly conversation: Conversation }
  | { readonly type: 'evict'; readonly id: string }
  | { readonly type: 'create'; readonly conversation: Conversation }
  | { readonly type: 'open'; readonly id: string | null }
  | { readonly type: 'append'; readonly id: string; readonly event: AiEvent }
  | { readonly type: 'appendMany'; readonly id: string; readonly events: readonly AiEvent[] }
  | { readonly type: 'patch'; readonly id: string; readonly patch: MetaPatch }
  | { readonly type: 'toggle'; readonly id: string; readonly field: 'pinned' | 'favorite' }
  | { readonly type: 'uiState'; readonly id: string; readonly uiState: ConversationUiState }
  | {
      readonly type: 'duplicate';
      readonly id: string;
      readonly newId: string;
      readonly now: number;
    }
  | { readonly type: 'remove'; readonly id: string };

function reducer(state: ConversationsState, action: Action): ConversationsState {
  switch (action.type) {
    case 'hydrate': {
      // Merge loaded conversations into the current set WITHOUT clobbering any
      // created since hydrate started (hydrate is async and races with new chats).
      const byId = { ...state.byId };
      for (const conversation of action.conversations) {
        if (!(conversation.id in byId)) byId[conversation.id] = conversation;
      }
      return { ...state, byId };
    }
    case 'loaded': {
      // Fill a stub with the log just read from disk. The in-memory copy wins wherever
      // it already has events: a run can stream into a conversation while its own load
      // is still in flight, and the disk record is by definition the older one.
      const current = state.byId[action.conversation.id];
      if (!current) return state;
      if (current.events.length > 0) return state;
      // Metadata stays as the store has it (a pin or a read-mark may have landed on the
      // stub); only the log and the UI state the stub could not know come from disk.
      return upsertConversation(state, {
        ...current,
        events: action.conversation.events,
        uiState: action.conversation.uiState,
      });
    }
    case 'evict': {
      // Drop an idle log back to its stub form. Safe because it is already persisted —
      // see `MAX_LOADED_CONVERSATIONS`.
      const current = state.byId[action.id];
      if (!current || current.events.length === 0) return state;
      return upsertConversation(state, { ...current, events: [], uiState: emptyUiState() });
    }
    case 'create':
      return setActiveConversation(
        upsertConversation(state, action.conversation),
        action.conversation.id,
      );
    case 'open':
      return setActiveConversation(state, action.id);
    case 'append':
      return appendEventTo(state, action.id, action.event);
    case 'appendMany':
      // One dispatch per frame-batched chunk of streamed events (H1): fold the whole
      // batch into a single state transition so React commits once per frame.
      return appendEventsTo(state, action.id, action.events);
    case 'patch':
      return patchConversation(state, action.id, action.patch);
    case 'toggle': {
      const current = state.byId[action.id];
      if (!current) return state;
      return patchConversation(state, action.id, { [action.field]: !current[action.field] });
    }
    case 'uiState':
      return setConversationUiState(state, action.id, action.uiState);
    case 'duplicate':
      return duplicateConversation(state, action.id, action.newId, action.now);
    case 'remove':
      return removeConversation(state, action.id);
  }
}

/** The conversation API surfaced to the sidebar. */
export interface UseConversations {
  readonly state: ConversationsState;
  /** All conversations ordered for the history list (pinned first, recent next). */
  readonly conversations: readonly Conversation[];
  readonly active: Conversation | null;
  readonly unreadCount: number;
  /** Create a new conversation and make it active. */
  readonly create: (options: CreateConversationOptions) => Conversation;
  readonly open: (id: string | null) => void;
  readonly append: (id: string, event: AiEvent) => void;
  /** Append a frame-batched run of streamed events as ONE state transition. */
  readonly appendMany: (id: string, events: readonly AiEvent[]) => void;
  readonly rename: (id: string, title: string) => void;
  readonly togglePinned: (id: string) => void;
  readonly toggleFavorite: (id: string) => void;
  readonly setUiState: (id: string, uiState: ConversationUiState) => void;
  readonly duplicate: (id: string) => void;
  readonly remove: (id: string) => void;
  /**
   * Read the project's conversation list from persistence. Only metadata is read; each
   * event log is fetched when its conversation is opened (see
   * {@link MAX_LOADED_CONVERSATIONS}).
   */
  readonly hydrate: () => Promise<void>;
  /**
   * Force every conversation's log into memory — for the history search, which reads
   * message and tool text across the whole project and can only match what is loaded.
   * Deliberately explicit and deliberately rare: this is the cost hydrate used to pay
   * on every editor open.
   */
  readonly loadAll: () => Promise<void>;
}

/**
 * Wire the conversation store into React, optionally persisting through `persistence`.
 *
 * @param persistence - Storage backend (desktop/IndexedDB/memory). When `null`, the
 *   store is in-memory only (no autosave, no hydrate).
 * @param projectId - Scopes the cross-remount cache (see {@link remountCache}) so a
 *   project switch starts from an empty store instead of inheriting the previous
 *   project's conversations. Pass the same value the `persistence` was scoped with.
 */
export function useConversations(
  persistence: ConversationPersistence | null = null,
  projectId: string | null = null,
): UseConversations {
  const cached = remountCache?.projectId === projectId ? remountCache : null;
  const [state, dispatch] = useReducer(
    reducer,
    undefined,
    () => cached?.state ?? createConversationsState(),
  );

  // Debounced autosave: persist a conversation whose identity changed, delete those
  // that disappeared. Keyed timers coalesce a burst of streamed appends into one write.
  const persistenceRef = useRef(persistence);
  persistenceRef.current = persistence;
  const prevById = useRef<ConversationsState['byId']>(cached?.prevById ?? {});
  /**
   * Conversations present in the store as metadata only. Tracked as the EXCEPTION rather
   * than tracking loaded ones, so anything this hook has not explicitly stubbed stays
   * saveable — the safe direction, since the failure it guards against is writing an
   * empty log over a full record on disk.
   */
  const stubIds = useRef<Set<string>>(new Set(cached?.stubIds ?? []));
  /** Loaded ids, most-recently-opened last — the eviction order. */
  const recency = useRef<string[]>([]);
  // The pending write rides WITH its timer so an unmount can still perform it (see the
  // teardown below) instead of only cancelling it.
  const timers = useRef(
    new Map<string, { timer: ReturnType<typeof setTimeout>; conversation: Conversation }>(),
  );

  useEffect(() => {
    const adapter = persistenceRef.current;
    const prev = prevById.current;
    prevById.current = state.byId;
    // Recorded on every commit (not on unmount): a remount that races an in-flight run
    // must find the state as of the LAST append, not as of some teardown that may never
    // run in order. `prevById` is the pre-update snapshot the restored mount continues
    // its autosave diff from.
    remountCache = { projectId, state, prevById: prev, stubIds: new Set(stubIds.current) };
    if (!adapter) return;

    for (const [id, conversation] of Object.entries(state.byId)) {
      if (prev[id] === conversation) continue;
      // A stub's log lives on disk and not here, so persisting it would replace a real
      // conversation with an empty one. Every mutator loads before it mutates (see
      // `ensureLoaded`), so a stub that reaches this line changed only by being stubbed.
      if (stubIds.current.has(id)) continue;
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing.timer);
      timers.current.set(id, {
        conversation,
        timer: setTimeout(() => {
          timers.current.delete(id);
          // A failed autosave must be OBSERVABLE (H9): an unhandled rejection is a
          // silent data-loss path. The conversation stays in memory; the next
          // append re-schedules a save, so logging (not crashing) is correct.
          adapter.save(conversation).catch((error: unknown) => {
            log.warn('conversation autosave failed', { error });
          });
        }, CONVERSATION_SAVE_DEBOUNCE_MS),
      });
    }
    for (const id of Object.keys(prev)) {
      if (id in state.byId) continue;
      const pending = timers.current.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        timers.current.delete(id);
      }
      adapter.delete(id).catch((error: unknown) => {
        log.warn('conversation delete failed', { error });
      });
    }
  }, [state]);

  // Flush pending timers on unmount so an in-flight edit is never lost. It has to WRITE
  // them, not just cancel them: an auto-commit remount arrives mid-run, well inside the
  // debounce window, and a cancelled save is a dropped tail of the event log.
  const timersAtUnmount = timers.current;
  useEffect(
    () => () => {
      const adapter = persistenceRef.current;
      for (const pending of timersAtUnmount.values()) {
        clearTimeout(pending.timer);
        adapter?.save(pending.conversation).catch((error: unknown) => {
          log.warn('conversation autosave failed', { error });
        });
      }
      timersAtUnmount.clear();
    },
    [timersAtUnmount],
  );

  const hydrate = useCallback(async () => {
    const adapter = persistenceRef.current;
    if (!adapter) return;
    let summaries: Awaited<ReturnType<ConversationPersistence['list']>>;
    try {
      summaries = await adapter.list();
    } catch (error) {
      // A broken store must not take the sidebar down (H9): start empty, log why.
      log.warn('conversation hydrate failed', { error });
      return;
    }
    // Metadata only. The history list shows nothing else, and reading every log here is
    // what used to put a session's worth of past runs in the heap before a single one
    // was opened.
    const conversations = summaries.map(stubFromSummary);
    for (const conversation of conversations) stubIds.current.add(conversation.id);
    // Already persisted — seed the diff so hydrate is not immediately re-saved.
    prevById.current = Object.fromEntries(conversations.map((c) => [c.id, c]));
    dispatch({ type: 'hydrate', conversations });
  }, []);

  /**
   * Make sure `id`'s event log is in memory, then retire the least-recently-opened logs
   * beyond the cap. Called by everything that opens or mutates a conversation, so a
   * stub is never the thing being written back.
   */
  const ensureLoaded = useCallback(async (id: string): Promise<void> => {
    const adapter = persistenceRef.current;
    // Touch the recency order first: opening a conversation must keep it out of its own
    // eviction pass, loaded from disk or already resident.
    recency.current = [...recency.current.filter((other) => other !== id), id];
    if (adapter && stubIds.current.has(id)) {
      // Cleared before awaiting, so a run that streams into this conversation while the
      // read is in flight is saved rather than skipped as a stub.
      stubIds.current.delete(id);
      try {
        const conversation = await adapter.load(id);
        if (conversation) dispatch({ type: 'loaded', conversation });
      } catch (error) {
        log.warn('conversation load failed', { error });
      }
    }
    for (const stale of recency.current.slice(0, -MAX_LOADED_CONVERSATIONS)) {
      if (stubIds.current.has(stale)) continue;
      // A debounced write may still be owed — switching conversations marks the old one
      // read, and a run's last appends land inside the window. Settle it NOW rather than
      // skipping the eviction: dropping a log whose disk copy is a prefix of it is the
      // one way this loses data, and waiting for the timer instead would keep the very
      // conversations a busy session cycles through resident forever.
      const pending = timers.current.get(stale);
      if (pending) {
        clearTimeout(pending.timer);
        timers.current.delete(stale);
        void adapter?.save(pending.conversation).catch((error: unknown) => {
          log.warn('conversation autosave failed', { error });
        });
      }
      // Its log is on disk, so this is a drop, never a discard.
      stubIds.current.add(stale);
      dispatch({ type: 'evict', id: stale });
    }
    recency.current = recency.current.slice(-MAX_LOADED_CONVERSATIONS);
  }, []);

  const loadAll = useCallback(async () => {
    const adapter = persistenceRef.current;
    if (!adapter) return;
    const pending = [...stubIds.current];
    stubIds.current.clear();
    // Search reads them all, so none of them may be evicted out from under it until the
    // next open — hence the recency order is left alone rather than filled with all of them.
    const loaded = await Promise.all(
      pending.map((id) =>
        adapter.load(id).catch((error: unknown) => {
          log.warn('conversation load failed', { error });
          return null;
        }),
      ),
    );
    for (const conversation of loaded) {
      if (conversation) dispatch({ type: 'loaded', conversation });
    }
  }, []);

  const actions = useMemo(
    () => ({
      create: (options: CreateConversationOptions): Conversation => {
        const conversation = createConversation(options);
        dispatch({ type: 'create', conversation });
        void ensureLoaded(conversation.id);
        return conversation;
      },
      open: (id: string | null) => {
        dispatch({ type: 'open', id });
        if (id !== null) void ensureLoaded(id);
      },
      append: (id: string, event: AiEvent) => dispatch({ type: 'append', id, event }),
      appendMany: (id: string, events: readonly AiEvent[]) =>
        dispatch({ type: 'appendMany', id, events }),
      // Metadata edits load first: they change the record that gets written back, and
      // writing back a stub would replace its log on disk with nothing.
      rename: (id: string, title: string) => {
        void ensureLoaded(id);
        dispatch({ type: 'patch', id, patch: { title } });
      },
      togglePinned: (id: string) => {
        void ensureLoaded(id);
        dispatch({ type: 'toggle', id, field: 'pinned' });
      },
      toggleFavorite: (id: string) => {
        void ensureLoaded(id);
        dispatch({ type: 'toggle', id, field: 'favorite' });
      },
      setUiState: (id: string, uiState: ConversationUiState) =>
        dispatch({ type: 'uiState', id, uiState }),
      duplicate: (id: string) => {
        void ensureLoaded(id).then(() =>
          dispatch({ type: 'duplicate', id, newId: crypto.randomUUID(), now: Date.now() }),
        );
      },
      remove: (id: string) => {
        stubIds.current.delete(id);
        recency.current = recency.current.filter((other) => other !== id);
        dispatch({ type: 'remove', id });
      },
    }),
    [ensureLoaded],
  );

  return {
    state,
    conversations: selectOrderedConversations(state),
    active: selectActiveConversation(state),
    unreadCount: selectUnreadCount(state),
    hydrate,
    loadAll,
    ...actions,
  };
}
