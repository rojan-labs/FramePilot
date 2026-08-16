import type { Project } from '@framepilot/timeline-schema';
import type { EditorState } from './store.js';

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
): Project {
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
