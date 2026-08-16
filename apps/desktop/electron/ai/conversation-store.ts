/**
 * AI-sidebar conversation persistence — main-process store (Phase 11 M2, ADR 0033).
 *
 * Persists one conversation per JSON file plus a small `index.json` of
 * {@link ConversationSummary} entries (so `list` never parses the big event logs).
 * All file IO is injected ({@link ConversationStoreIO}) so the id-sanitization,
 * indexing, and corruption-tolerance logic is unit-testable and this module stays
 * free of `electron`/`fs` imports (those live in `main`, mirroring `recent-files.ts`).
 *
 * SECURITY: the conversation id becomes a file name, so it is strictly validated
 * (`[A-Za-z0-9_-]`, bounded length) — a traversal-shaped id is rejected, never
 * joined into a path. Conversations are a separate store; nothing here touches
 * `project.fp.json`.
 */
import type {
  ConversationRecord,
  ConversationSaveResult,
  ConversationSummary,
} from '../ipc/contract.js';

/** Per-file IO for the conversations directory (atomic writes live in `main`). */
export interface ConversationStoreIO {
  /** The conversations index JSON, or `null` if it does not exist yet. */
  readIndex(): Promise<string | null>;
  writeIndex(contents: string): Promise<void>;
  /** One conversation's JSON document by id, or `null` if absent. */
  readConversation(id: string): Promise<string | null>;
  writeConversation(id: string, contents: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
}

/** Max id length kept sane (also bounds the file name). */
const MAX_ID_LENGTH = 128;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** True when `id` is a safe file-name component (no traversal, bounded). */
export function isValidConversationId(id: unknown): id is string {
  return (
    typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH && ID_PATTERN.test(id)
  );
}

function isSummary(value: unknown): value is ConversationSummary {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['projectId'] === 'string' &&
    typeof entry['updatedAt'] === 'number'
  );
}

/** Reads/maintains the conversations directory: one file per conversation + an index. */
export class ConversationStore {
  public constructor(private readonly io: ConversationStoreIO) {}

  /** Summaries from the index (a missing/corrupt index reads as empty). */
  public async list(): Promise<ConversationSummary[]> {
    const raw = await this.io.readIndex();
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isSummary) : [];
  }

  /** Load one conversation's document, or `null` if the id is invalid/absent/corrupt. */
  public async load(id: unknown): Promise<unknown | null> {
    if (!isValidConversationId(id)) return null;
    const raw = await this.io.readConversation(id);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Save one conversation (writes its file, then updates the index). */
  public async save(record: unknown): Promise<ConversationSaveResult> {
    if (typeof record !== 'object' || record === null) {
      return { ok: false, error: 'Invalid conversation record.' };
    }
    const { summary, data } = record as Partial<ConversationRecord>;
    if (!isSummary(summary)) return { ok: false, error: 'Invalid conversation summary.' };
    if (!isValidConversationId(summary.id)) return { ok: false, error: 'Invalid conversation id.' };

    await this.io.writeConversation(summary.id, JSON.stringify(data));
    const index = await this.list();
    const next = [summary, ...index.filter((s) => s.id !== summary.id)];
    await this.io.writeIndex(JSON.stringify(next, null, 2));
    return { ok: true };
  }

  /** Delete one conversation (removes its file and its index entry). */
  public async delete(id: unknown): Promise<ConversationSaveResult> {
    if (!isValidConversationId(id)) return { ok: false, error: 'Invalid conversation id.' };
    await this.io.deleteConversation(id);
    const index = await this.list();
    await this.io.writeIndex(
      JSON.stringify(
        index.filter((s) => s.id !== id),
        null,
        2,
      ),
    );
    return { ok: true };
  }
}
