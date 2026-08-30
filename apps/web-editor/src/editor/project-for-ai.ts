import type { Project } from '@framepilot/timeline-schema';
import type { EditorState } from './store.js';

/**
 * A {@link Project} shaped for the AI layer: the live document with `history` deliberately
 * emptied.
 *
 * It is structurally a `Project`, which is exactly the trap: it can be handed to anything
 * that takes a `Project` — including the persistence callback — and the missing history
 * reads as "the user reverted everything" rather than "this copy never carried it". Any
 * value derived from one of these that travels back toward persistence must go through
 * {@link restoreStrippedHistory} first. The host does the mirror-image merge for AI
 * requests in `apps/desktop/electron/projects/project-transport.ts`.
 */
export type AiFacingProject = Project;

/**
 * Build the project supplied to AI from the editor's live working state. The
 * app-level project mirrors it asynchronously for persistence and can briefly lag.
 */
export function projectForAi(
  project: Project,
  state: Pick<
    EditorState,
    'timeline' | 'assets' | 'folders' | 'markers' | 'transcript'
  >,
): AiFacingProject {
  return {
    ...project,
    timeline: state.timeline,
    assets: state.assets as Project['assets'],
    folders: state.folders as Project['folders'],
    markers: state.markers as Project['markers'],
    transcript: state.transcript as Project['transcript'],
    // Undo history can dwarf the editable document (large inverse transcript patches
    // produced a captured 116 MB request). It is editor recovery state, not model
    // context; Electron preserves the host-owned copy when refreshing live slices.
    history: [],
  };
}

/**
 * Put back the history {@link projectForAi} stripped, before an AI-derived project is
 * routed anywhere that persists.
 *
 * WHY this exists: the AI sidebar answers "forget this preference" / "undo this run" /
 * "patch applied" by deriving a new Project from the one it was given — which is the
 * history-stripped copy. That value used to reach `App`'s persistence callback, where the
 * history differ compared the real `[user, user, agent]` against `[]`, read it as a
 * time-travel to the start of the session, and committed the inverses of the user's own
 * edits to disk. The timeline on screen never moved, so the only symptom was the user's
 * last edits being gone after a reload.
 *
 * The module that strips the history is the one that owes its restoration, so the fix
 * lives here rather than in the differ.
 *
 * @param update - A project derived from an {@link AiFacingProject}.
 * @param live - The current app-level project, the owner of the real history.
 * @returns `update` carrying `live`'s history when it has none of its own.
 */
export function restoreStrippedHistory(update: Project, live: Project): Project {
  const updateHistory = Array.isArray(update.history) ? update.history : [];
  // A non-empty history could only come from the editor's own lift path, which is never
  // AI-shaped: leave it alone rather than overwriting a real transition.
  if (updateHistory.length > 0) return update;
  return { ...update, history: live.history };
}
