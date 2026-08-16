import type { Project } from '@framepilot/timeline-schema';
import { safeParseProject } from '@framepilot/timeline-schema';
import type { ProjectPatchCommitResult } from '@framepilot/shared-types';

export interface PendingManualAuthority {
  readonly project: Project;
  readonly revision: number;
}

type SuccessfulManualCommit = Extract<ProjectPatchCommitResult, { readonly ok: true }>;

/**
 * Track a host Project only when a manual commit was rebased over concurrent authority.
 * Once a rebase happens, every later queued commit refreshes the pending snapshot so the
 * renderer adopts the final authoritative Project only after its local commit lane drains.
 * The normal non-rebased path does not parse/clone the returned Project.
 */
export function manualAuthorityAfterCommit(
  projectId: string,
  pending: PendingManualAuthority | null,
  result: SuccessfulManualCommit,
): PendingManualAuthority | null {
  if (!result.rebased && pending === null) return null;

  const parsed = safeParseProject(result.project);
  if (!parsed.success || parsed.data.id !== projectId) {
    throw new Error('The host committed the manual patch but returned an invalid authoritative Project.');
  }
  return { project: parsed.data, revision: result.revision };
}
