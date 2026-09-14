import type { Patch } from '@framepilot/editor-core';
import { recordAccepted } from '@framepilot/ai-sdk';
import type { Project } from '@framepilot/timeline-schema';

/**
 * Record an auto-committed AI patch as an accepted edit (D10).
 *
 * ## Why this exists
 *
 * `AiSidebar.applyPatch` is the ONLY place the renderer ever called `recordAccepted` — and
 * it is reached only through an effect that explicitly stands down whenever a desktop
 * bridge is present ("Desktop auto-commit is an explicit durable run policy executed in
 * Electron"). On desktop, the durable run's own `beforePublish` commits every auto-policy
 * patch directly against `ProjectCommandService`, with no call into that renderer code at
 * all. The result: `aiMemory.acceptedEdits` stayed empty forever on desktop, however many
 * edits a run committed.
 *
 * An auto-commit has no separate human "accept" gesture — the run's patch policy already
 * decided the patch may be written, and validation plus the revision check are what stood
 * in for review. That is a real, on-disk edit and a real (if weaker) learning signal, so it
 * is recorded — honestly labelled `auto_applied` rather than folded in as an
 * indistinguishable human accept (see `MemoryEdit.origin` in `@framepilot/ai-sdk`).
 *
 * Pure and IO-free: the caller is responsible for actually persisting the returned project
 * (a second, patch-less write through the normal `ProjectCommandService` — the same shape
 * the browser path already uses for a memory-only change that carries no timeline `Patch`
 * to replay).
 */
export function recordAutoAcceptedMemory(committedProject: Project, patch: Patch): Project {
  return recordAccepted(committedProject, patch, { origin: 'auto_applied' });
}
