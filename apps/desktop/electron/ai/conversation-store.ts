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

/** Read `value.path` when it is a usable string; anything else contributes nothing. */
function attachmentPathOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = (value as Record<string, unknown>)['path'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/** Collect `path` from an `attachments` array wherever one appears. */
function collectAttachmentPaths(container: unknown, into: Set<string>): void {
  if (typeof container !== 'object' || container === null) return;
  const attachments = (container as Record<string, unknown>)['attachments'];
  if (!Array.isArray(attachments)) return;
  for (const attachment of attachments) {
    const attachmentPath = attachmentPathOf(attachment);
    if (attachmentPath !== null) into.add(attachmentPath);
  }
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

  /**
   * Every attachment file this project's conversations still reference, or `null`.
   *
   * Two places hold a reference to an imported attachment file, and both count:
   *
   *  - a sent message's `attachments` — the immutable record of what the turn carried,
   *    which the chat bubble renders a thumbnail from;
   *  - the conversation's `uiState.attachments` — chips sitting in a composer, attached
   *    but not yet sent.
   *
   * Every event is read, not only `user_message`: over-collecting costs a file left on
   * disk, while missing an event kind that grows attachments later costs a live reference
   * its bytes. The asymmetry decides it.
   *
   * `null` means the set is INCOMPLETE — a conversation the index lists could not be
   * parsed — and the caller must treat that as "reclaim nothing", because "I could not
   * read it" is not "nothing references it". A conversation whose FILE is gone is not
   * incomplete: it no longer exists, so it references nothing.
   *
   * The documents are read defensively rather than typed. They are JSON written by
   * whatever version of the renderer saved them, and a field that has since moved must
   * cost a skipped sweep, never a deleted file.
   */
  public async referencedAttachmentPaths(projectId: string): Promise<Set<string> | null> {
    const paths = new Set<string>();
    for (const summary of await this.list()) {
      if (summary.projectId !== projectId) continue;
      if (!isValidConversationId(summary.id)) return null;
      const raw = await this.io.readConversation(summary.id);
      if (raw === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (typeof parsed !== 'object' || parsed === null) return null;
      const document = parsed as Record<string, unknown>;
      collectAttachmentPaths(document['uiState'], paths);
      const events = document['events'];
      if (!Array.isArray(events)) return null;
      for (const event of events) collectAttachmentPaths(event, paths);
    }
    return paths;
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
