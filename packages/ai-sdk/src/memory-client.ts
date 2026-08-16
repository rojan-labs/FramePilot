/**
 * @framepilot/ai-sdk/memory-client — append to the project's narrative memory
 * tiers via the engine sidecar (plan B6.1).
 *
 * WHY: `memory-store.ts` records an accepted/rejected patch as a TYPED entry in
 * `project.aiMemory` — authoritative, but terse: a patch id and a one-line
 * reason. The narrative tiers (`corrections.md`, `decisions.md`) are the prose
 * layer the model actually reads at session start, and they live under the brain
 * dir, which only the sidecar may write (single-writer invariant). This module is
 * the host's way to feed them.
 *
 * **Fire-and-forget, never blocking.** Recording that the user rejected an edit
 * must never delay the UI or fail a review action: every call resolves to a
 * boolean and swallows its own errors. Absent sidecar (browser build) → the typed
 * store still records the signal, so nothing is lost that we ever promised.
 *
 * The typed store stays authoritative — this is additive narrative, not a second
 * source of truth (no drift: both are written from the same patch).
 */
import { createLogger } from '@framepilot/shared-types';
import type { Patch } from '@framepilot/editor-core';
import type { BrainClientOptions } from './brain-client.js';

const log = createLogger('ai-sdk:memory-client');

/** Default timeout — appending a markdown entry is a small local write. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** The narrative tiers, mirroring the engine's `MemoryTier` (plan B6.1). */
export type MemoryTier = 'corrections' | 'decisions' | 'session_notes';

/**
 * The cross-project soul documents, mirroring the engine's `SoulDoc` (B6.2).
 * Passing one is the explicit "remember this across projects" path; omit it and
 * a correction still reaches the soul on its own, but only once a SECOND project
 * repeats it (the promotion heuristic).
 */
export type SoulDoc = 'working_style' | 'learned_from_corrections' | 'perspective';

export interface MemoryEntryInput {
  readonly projectId: string;
  readonly tier: MemoryTier;
  /** One-line summary — becomes the entry's heading, and a correction's promotion key. */
  readonly title: string;
  readonly body?: string;
  /** The patch this entry is about; keeps the prose traceable to real history (B6.4). */
  readonly patchId?: string;
  /** Set to ALSO record this across projects, immediately (B6.2). */
  readonly soulDoc?: SoulDoc;
}

/** Appends one narrative memory entry. Resolves `false` when it could not be recorded. */
export type MemoryRecorder = (entry: MemoryEntryInput) => Promise<boolean>;

/**
 * Create a {@link MemoryRecorder} against `POST /brain/memory`. Never throws and
 * never rejects: a memory append is a side-benefit of a user action, so it can
 * fail silently (with a debug log) but must never surface as a failed action.
 */
export function createMemoryRecorder(options: BrainClientOptions): MemoryRecorder {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (entry) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Split like `brain-client`'s readers: the fetch attempt owns its own
    // try/catch (never throws), the outer try/finally only clears `timer` — no
    // combined try/catch/finally, so there is no rethrow path to leave dead.
    const attempt = async (): Promise<boolean> => {
      try {
        const response = await fetchFn(`${options.baseUrl}/brain/memory`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: entry.projectId,
            tier: entry.tier,
            title: entry.title,
            ...(entry.body !== undefined ? { body: entry.body } : {}),
            ...(entry.patchId !== undefined ? { patchId: entry.patchId } : {}),
            ...(entry.soulDoc !== undefined ? { soulDoc: entry.soulDoc } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          log.debug('memory append → HTTP error; the typed store still has the signal', {
            tier: entry.tier,
            status: response.status,
          });
          return false;
        }
        log.action('memory append → recorded', { tier: entry.tier, patchId: entry.patchId });
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.debug('memory append → request failed; the typed store still has the signal', {
          tier: entry.tier,
          reason,
        });
        return false;
      }
    };
    try {
      return await attempt();
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The narrative entry for a patch the user rejected (plan B6.1).
 *
 * The patch's own `reason` is the model's past-tense description of what it did
 * ("Tightened pacing"), so the title reads as what was turned down. We do NOT
 * invent a why: the user pressed Reject, they did not explain themselves, and a
 * fabricated motive is exactly the kind of thing that would poison later runs.
 */
export function rejectionEntry(projectId: string, patch: Patch): MemoryEntryInput {
  return {
    projectId,
    tier: 'corrections',
    title: `Rejected: ${patch.reason}`,
    body: 'The user rejected this proposed edit in review.',
    patchId: patch.patchId,
  };
}

/** The narrative entry for a patch the user accepted (plan B6.1). */
export function acceptanceEntry(projectId: string, patch: Patch): MemoryEntryInput {
  return {
    projectId,
    tier: 'decisions',
    title: `Accepted: ${patch.reason}`,
    body: 'The user kept this edit.',
    patchId: patch.patchId,
  };
}
