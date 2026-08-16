/**
 * Conversation persistence (Phase 11 M2, ADR 0033, Approval A1 — JSON files).
 *
 * One canonical JSON record **per conversation**, behind a single
 * {@link ConversationPersistence} interface so the storage backend is a thin swap:
 *  - **Desktop (canonical):** JSON files under the app data dir via the
 *    `conversations:*` IPC channels (sandboxed in the main process).
 *  - **Browser/dev:** the **byte-identical JSON record** in IndexedDB (localStorage
 *    is too small for 20k-event logs).
 *  - **Memory:** an in-process fallback used by tests and any runtime where neither
 *    backend is reachable.
 *
 * Nothing is written to `project.fp.json`. Every adapter reads/writes the same
 * `Conversation` shape, so the on-disk and IndexedDB records are interchangeable.
 */
import type { ConversationRecord, ConversationSummary } from '@framepilot/shared-types';
import type { Conversation } from './conversation.js';

/** Project a conversation to its lightweight summary (for the history list). */
export function toSummary(conversation: Conversation): ConversationSummary {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    model: conversation.model,
    mode: conversation.mode,
    pinned: conversation.pinned,
    favorite: conversation.favorite,
    unread: conversation.unread,
    eventCount: conversation.events.length,
  };
}

/** Build the `{ summary, data }` record the desktop IPC channel persists. */
export function toRecord(conversation: Conversation): ConversationRecord {
  return { summary: toSummary(conversation), data: conversation };
}

/**
 * A light runtime guard that a loaded JSON value is shaped like a conversation.
 * Conversations are not Zod-schema'd (they are a UI store, not the project), so we
 * check the load-bearing fields and treat anything else as corrupt (→ `null`),
 * mirroring how `persistence.ts` refuses to load an invalid project.
 */
export function parseConversation(data: unknown): Conversation | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record['id'] !== 'string') return null;
  if (typeof record['projectId'] !== 'string') return null;
  if (!Array.isArray(record['events'])) return null;
  if (typeof record['uiState'] !== 'object' || record['uiState'] === null) return null;
  return data as Conversation;
}

/** One record per conversation; read/write the same JSON shape on every backend. */
export interface ConversationPersistence {
  /** Lightweight summaries for the history list (no event logs). */
  list(): Promise<ConversationSummary[]>;
  /** Load one full conversation, or `null` if absent/corrupt. */
  load(id: string): Promise<Conversation | null>;
  /** Insert or replace one conversation. */
  save(conversation: Conversation): Promise<void>;
  /** Delete one conversation. */
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Memory adapter (tests + fallback)
// ---------------------------------------------------------------------------

/** In-process persistence — deterministic, used by tests and as a last resort. */
export class MemoryPersistence implements ConversationPersistence {
  private readonly store = new Map<string, Conversation>();

  public constructor(seed: readonly Conversation[] = []) {
    for (const conversation of seed) this.store.set(conversation.id, conversation);
  }

  public async list(): Promise<ConversationSummary[]> {
    return [...this.store.values()].map(toSummary);
  }

  public async load(id: string): Promise<Conversation | null> {
    return this.store.get(id) ?? null;
  }

  public async save(conversation: Conversation): Promise<void> {
    this.store.set(conversation.id, conversation);
  }

  public async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Desktop adapter (canonical) — JSON files via the conversations:* IPC channels
// ---------------------------------------------------------------------------

/** The narrow bridge surface the desktop adapter depends on (a subset of the bridge). */
export interface ConversationBridge {
  conversationsList(): Promise<ConversationSummary[]>;
  conversationsLoad(id: string): Promise<unknown | null>;
  conversationsSave(record: ConversationRecord): Promise<{ ok: boolean; error?: string }>;
  conversationsDelete(id: string): Promise<{ ok: boolean; error?: string }>;
}

/** Persists conversations as sandboxed JSON files in the Electron main process. */
export class DesktopPersistence implements ConversationPersistence {
  public constructor(private readonly bridge: ConversationBridge) {}

  public async list(): Promise<ConversationSummary[]> {
    return this.bridge.conversationsList();
  }

  public async load(id: string): Promise<Conversation | null> {
    return parseConversation(await this.bridge.conversationsLoad(id));
  }

  public async save(conversation: Conversation): Promise<void> {
    const result = await this.bridge.conversationsSave(toRecord(conversation));
    if (!result.ok) throw new Error(result.error ?? 'Failed to save conversation.');
  }

  public async delete(id: string): Promise<void> {
    const result = await this.bridge.conversationsDelete(id);
    if (!result.ok) throw new Error(result.error ?? 'Failed to delete conversation.');
  }
}

// ---------------------------------------------------------------------------
// IndexedDB adapter (browser/dev) — same JSON shape, append-friendly
// ---------------------------------------------------------------------------

const DB_NAME = 'framepilot';
const STORE_NAME = 'conversations';

/** Promisify an IDBRequest. */
function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Persists conversations as one record per id in IndexedDB. */
export class IndexedDbPersistence implements ConversationPersistence {
  public constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    const request = this.factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    return promisifyRequest(request);
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await this.open();
    try {
      const store = db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
      return await run(store);
    } finally {
      db.close();
    }
  }

  public async list(): Promise<ConversationSummary[]> {
    const all = await this.tx('readonly', (store) => promisifyRequest(store.getAll()));
    return (all as unknown[])
      .map(parseConversation)
      .filter((conversation): conversation is Conversation => conversation !== null)
      .map(toSummary);
  }

  public async load(id: string): Promise<Conversation | null> {
    const value = await this.tx('readonly', (store) => promisifyRequest(store.get(id)));
    return parseConversation(value);
  }

  public async save(conversation: Conversation): Promise<void> {
    await this.tx('readwrite', (store) => promisifyRequest(store.put(conversation)));
  }

  public async delete(id: string): Promise<void> {
    await this.tx('readwrite', (store) => promisifyRequest(store.delete(id)));
  }
}

// ---------------------------------------------------------------------------
// Project scoping + resolver
// ---------------------------------------------------------------------------

/**
 * Restrict a persistence backend to one project.
 *
 * The backing desktop/IndexedDB store remains shared so projects do not need to
 * know where app data lives, but every list/load/save crosses this guard. Legacy
 * records without `projectId` fail parsing and remain hidden: guessing ownership
 * would leak them into whichever project happened to open first.
 */
export class ProjectConversationPersistence implements ConversationPersistence {
  public constructor(
    private readonly persistence: ConversationPersistence,
    private readonly projectId: string,
  ) {}

  public async list(): Promise<ConversationSummary[]> {
    return (await this.persistence.list()).filter(
      (summary) => summary.projectId === this.projectId,
    );
  }

  public async load(id: string): Promise<Conversation | null> {
    const conversation = await this.persistence.load(id);
    return conversation?.projectId === this.projectId ? conversation : null;
  }

  public async save(conversation: Conversation): Promise<void> {
    if (conversation.projectId !== this.projectId) {
      throw new Error('Cannot save a conversation outside its project.');
    }
    await this.persistence.save(conversation);
  }

  public async delete(id: string): Promise<void> {
    const conversation = await this.persistence.load(id);
    if (conversation?.projectId === this.projectId) {
      await this.persistence.delete(id);
    }
  }
}

/** Bind an app-wide storage adapter to one project's conversation history. */
export function scopeConversationPersistence(
  persistence: ConversationPersistence,
  projectId: string,
): ConversationPersistence {
  return new ProjectConversationPersistence(persistence, projectId);
}

/**
 * Pick the right persistence backend: the desktop IPC bridge when present,
 * otherwise IndexedDB in a browser that has it, otherwise in-memory.
 *
 * @param bridge - The desktop bridge (or `null` in a browser/test).
 * @param idbFactory - IndexedDB factory (defaults to `globalThis.indexedDB`).
 */
export function resolveConversationPersistence(
  bridge: ConversationBridge | null,
  idbFactory: IDBFactory | undefined = typeof indexedDB !== 'undefined' ? indexedDB : undefined,
): ConversationPersistence {
  // Feature-detect the conversations surface rather than trusting the bridge's
  // presence — a partial bridge (older shell, test double) must degrade to the
  // browser backends instead of failing every hydrate/save with a rejection.
  if (
    bridge &&
    typeof bridge.conversationsList === 'function' &&
    typeof bridge.conversationsLoad === 'function' &&
    typeof bridge.conversationsSave === 'function' &&
    typeof bridge.conversationsDelete === 'function'
  ) {
    return new DesktopPersistence(bridge);
  }
  if (idbFactory) return new IndexedDbPersistence(idbFactory);
  return new MemoryPersistence();
}
