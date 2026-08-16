/**
 * @framepilot/ui/WorkspaceShell — the resizable/collapsible rail + timeline-dock
 * shell (J1). See `WorkspaceShell.tsx` for the extraction rationale.
 */
export { WorkspaceShell } from './WorkspaceShell.js';
export type { WorkspaceShellProps, WorkspaceRailSlot, WorkspaceDockSlot } from './WorkspaceShell.js';
export { RailSplitter } from './RailSplitter.js';
export type { RailSplitterProps } from './RailSplitter.js';
export { StageSplitter } from './StageSplitter.js';
export type { StageSplitterProps } from './StageSplitter.js';
export {
  RAIL_BOUNDS,
  COLLAPSED_WIDTH,
  clampRailWidth,
  useRailLayout,
} from './useRailLayout.js';
export type { RailSide, RailLayout } from './useRailLayout.js';
export {
  TIMELINE_MIN,
  TOP_REGION_MIN,
  DEFAULT_TIMELINE_HEIGHT,
  TIMELINE_DOCK_KEY,
  maxDockHeight,
  useDockHeight,
} from './useDockHeight.js';
export type { DockHeightOptions, DockLayout } from './useDockHeight.js';
export { localStorageAdapter } from './persistence.js';
export type { WorkspacePersistenceAdapter } from './persistence.js';
