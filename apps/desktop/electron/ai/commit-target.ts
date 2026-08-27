import type { ActiveProjectPointer } from '@framepilot/shared-types/projects-root';

/**
 * Can this run's edits actually be written to disk?
 *
 * ## Why this exists
 *
 * The host auto-commit path checked "is this the project the GUI has open?" in exactly one
 * place: `beforePublish`, at the moment a patch arrived. Everything upstream — starting the
 * run, spending the model's tokens, spending METERED third-party stock/music quota — ran
 * without ever asking. A captured run against a project the GUI was not on searched a
 * stock provider nineteen times across two attempts, proposed two edits, and had both
 * rejected with "the project is no longer the active authoritative project". It could not
 * have succeeded from its first token; nothing said so until the money was gone.
 *
 * "This project is the authoritative one" is a RUN-level precondition, not a per-operation
 * one. It is checked here so both callers read the same rule:
 *
 * - at `aiStreamStart`, as a pre-flight that refuses the run outright;
 * - in `beforePublish`, as the race guard it was always meant to be (the user can switch
 *   projects mid-run, and that must still be caught).
 *
 * Pure and IO-free so the decision is unit-testable without Electron, a filesystem, or a
 * live run — the whole reason the original inline check had no coverage.
 */

/** Machine-readable cause of a refusal. Callers map it to transport errors or commit state. */
export type CommitTargetRefusalCode = 'no_project_open' | 'different_project_active';

export interface CommitTargetAllowed {
  readonly ok: true;
  /** The authoritative on-disk path a commit must write to. */
  readonly path: string;
}

export interface CommitTargetRefused {
  readonly ok: false;
  readonly code: CommitTargetRefusalCode;
  /**
   * Editor-facing sentence. Carried to the UI verbatim (`DiffEvent.commit.reason`) because
   * the remedy differs per code and a single generic "the timeline changed" line sent the
   * captured run's user into a retry that could never succeed.
   */
  readonly reason: string;
}

export type CommitTargetDecision = CommitTargetAllowed | CommitTargetRefused;

/**
 * Decide whether `projectId` is the project the GUI currently has open.
 *
 * @param active - The active-project pointer, or `null` when none is recorded or it is corrupt.
 * @param projectId - The project the run intends to edit.
 * @returns The authoritative write path, or a refusal naming the cause and the remedy.
 */
export function decideCommitTarget(
  active: ActiveProjectPointer | null,
  projectId: string,
): CommitTargetDecision {
  if (!active) {
    return {
      ok: false,
      code: 'no_project_open',
      reason:
        'No project is open in FramePilot, so there is nowhere to write this edit. Open the ' +
        'project you want to edit and ask again.',
    };
  }
  if (active.projectId !== projectId) {
    return {
      ok: false,
      code: 'different_project_active',
      // Naming the open project is the difference between an actionable message and a
      // riddle: the user is looking at a window and being told it is the wrong one.
      reason:
        'This edit belongs to a project FramePilot no longer has open — the app is on a ' +
        'different project now, so the edit was not written. Reopen that project and ask again.',
    };
  }
  return { ok: true, path: active.path };
}
