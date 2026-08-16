import type { Project } from '@framepilot/timeline-schema';

/**
 * Merge renderer-live editable slices with host-owned recovery history. The renderer
 * deliberately omits history from AI requests because inverse patches can be enormous.
 */
export function mergeLiveProjectForHost(supplied: Project, authoritative?: Project): Project {
  if (authoritative === undefined || authoritative.id !== supplied.id) return supplied;
  return { ...supplied, history: authoritative.history };
}
