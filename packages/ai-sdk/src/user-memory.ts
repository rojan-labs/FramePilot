/**
 * @framepilot/ai-sdk/user-memory — the **user** memory scope (redesign §16.1, Phase K5.1).
 *
 * Project memory ({@link './memory-store.js'}) learns what a *single* project wants.
 * User memory is the scope *above* it: cross-project editorial preferences that follow
 * the person, not the file — "I always caption karaoke-style", "I export to Reels + Shorts".
 * A new project starts from these defaults; its own {@link ProjectMemory} then overrides
 * them per field (see {@link './scoped-memory.js'}).
 *
 * Like `memory-store.ts` this module is **pure and persistence-agnostic**: it parses a
 * free-form record (read from the desktop app profile / web localStorage) and returns a
 * new record; the caller persists it. It is parsed defensively — a hand-edited or
 * stale profile falls back to safe defaults rather than throwing.
 *
 * **Not here:** model/provider configuration. It is operational configuration rather
 * than editorial memory.
 */
import { z } from 'zod/v4';
import { createLogger } from '@framepilot/shared-types';

const log = createLogger('ai-sdk:user-memory');

/**
 * Cross-project editorial defaults. The optional style keys mirror {@link ProjectMemory}'s
 * so a project value can override a user default field-for-field; `favoriteExportPlatforms`
 * is the user-scope analogue of the project's `exportPlatforms`.
 */
const UserMemorySchema = z.object({
  targetAudience: z.string().optional(),
  brandStyle: z.string().optional(),
  captionStyle: z.string().optional(),
  preferredPacing: z.string().optional(),
  favoriteExportPlatforms: z.array(z.string()).default([]),
});

/** Typed view of the user's cross-project preferences (redesign §16.1). */
export type UserMemory = z.infer<typeof UserMemorySchema>;

/** Free-text preference keys the user can set once and reuse across every project. */
export type UserPreferenceKey =
  | 'targetAudience'
  | 'brandStyle'
  | 'captionStyle'
  | 'preferredPacing';

/** The empty user memory (a fresh profile, or an unreadable one). */
export const EMPTY_USER_MEMORY: UserMemory = { favoriteExportPlatforms: [] };

/** Parse a raw profile record into a typed {@link UserMemory} (never throws). */
export function readUserMemory(raw: unknown): UserMemory {
  const parsed = UserMemorySchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...EMPTY_USER_MEMORY };
}

/** Serialise user memory back to a plain record for the profile writer. */
export function writeUserMemory(memory: UserMemory): Record<string, unknown> {
  return { ...memory };
}

/** Set one cross-project free-text preference (returns a new memory). */
export function setUserPreference(
  memory: UserMemory,
  key: UserPreferenceKey,
  value: string,
): UserMemory {
  log.action('setUserPreference → memory write', { key });
  return { ...memory, [key]: value };
}

/** Replace the user's favourite export platforms (returns a new memory). */
export function setFavoriteExportPlatforms(
  memory: UserMemory,
  platforms: readonly string[],
): UserMemory {
  log.action('setFavoriteExportPlatforms → memory write', { platforms: platforms.length });
  return { ...memory, favoriteExportPlatforms: [...platforms] };
}

/**
 * Render user memory as a compact prompt block. Used only when a project has no value
 * of its own for a field (project memory takes precedence — see `scoped-memory.ts`);
 * returns '' when nothing is set.
 */
export function summarizeUserMemory(memory: UserMemory): string {
  const lines: string[] = [];
  if (memory.targetAudience) lines.push(`Target audience: ${memory.targetAudience}`);
  if (memory.brandStyle) lines.push(`Brand style: ${memory.brandStyle}`);
  if (memory.captionStyle) lines.push(`Caption style: ${memory.captionStyle}`);
  if (memory.preferredPacing) lines.push(`Preferred pacing: ${memory.preferredPacing}`);
  if (memory.favoriteExportPlatforms.length > 0) {
    lines.push(`Favourite export platforms: ${memory.favoriteExportPlatforms.join(', ')}`);
  }
  return lines.join('\n');
}
