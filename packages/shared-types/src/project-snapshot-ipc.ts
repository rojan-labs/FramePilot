import type { ProjectOpenResult } from './ipc.js';

/**
 * Narrow bridge extension for reading the already-open authoritative Project without
 * performing user-facing "open" side effects such as recents, watchers, or brain warmup.
 */
export interface ProjectSnapshotBridge {
  projectSnapshot(projectId: string): Promise<ProjectOpenResult>;
}

export type FramePilotBridgeWithSnapshot = import('./ipc.js').FramePilotBridge &
  ProjectSnapshotBridge;
