/**
 * @framepilot/ai-sdk/scoped-memory — resolve the persisted memory scopes into what the
 * model actually sees (redesign §16.1, Phase K5.1).
 *
 * The redesign splits memory into five scopes with deliberately different lifetimes:
 *
 *  - **task** — one task's inputs + prior results; *ephemeral*, never persisted. This is
 *    the scheduler's in-flight task-result state — derivable, so it is not a store here.
 *  - **run** — the conversation/session; persisted as the `events.ts` AiEvent WAL and
 *    threaded into context as bounded history (not re-modelled here).
 *  - **project** — `memory-store.ts` (`Project.aiMemory`) — what *this* file wants.
 *  - **user** — `user-memory.ts` — cross-project editorial defaults.
 *  - **workflow** — `workflow-memory.ts` — taught, replayable recipes.
 *
 * This module owns the one rule that ties the persisted *editorial* scopes together:
 * **project overrides user, field by field.** A project's learned style is more specific
 * than a cross-project default, so it wins; a user default only fills a field the project
 * has left blank. The result is a plain {@link ProjectMemory} so the existing
 * {@link summarizeMemory} renders it unchanged.
 */
import { type ProjectMemory, summarizeMemory } from './memory-store.js';
import { type UserMemory } from './user-memory.js';

/**
 * Layer user defaults *under* project memory: every editorial field falls back to the
 * user default only when the project has none, and `exportPlatforms` falls back to the
 * user's `favoriteExportPlatforms` only when the project lists none. Accepted/rejected
 * edits are project-only (a per-project learning signal) and pass through untouched.
 *
 * @param project - This project's memory (higher precedence).
 * @param user - The user's cross-project defaults (lower precedence); omitted ⇒ no change.
 * @returns The effective editorial memory to inject into context.
 */
export function effectiveEditorialMemory(project: ProjectMemory, user?: UserMemory): ProjectMemory {
  if (!user) return project;
  return {
    ...project,
    targetAudience: project.targetAudience ?? user.targetAudience,
    brandStyle: project.brandStyle ?? user.brandStyle,
    captionStyle: project.captionStyle ?? user.captionStyle,
    preferredPacing: project.preferredPacing ?? user.preferredPacing,
    exportPlatforms:
      project.exportPlatforms.length > 0
        ? project.exportPlatforms
        : [...user.favoriteExportPlatforms],
  };
}

/**
 * Convenience: the effective editorial memory rendered as the context prompt block
 * (project layered over user). Returns '' when nothing is remembered in either scope.
 */
export function summarizeScopedMemory(project: ProjectMemory, user?: UserMemory): string {
  return summarizeMemory(effectiveEditorialMemory(project, user));
}
