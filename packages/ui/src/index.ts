/**
 * @framepilot/ui — component library public surface.
 * See plan/PLAN.md Phase 3.2 (editor UI) and 4.3 (review UX).
 */
export { Button } from './Button.js';
export type { ButtonProps, ButtonVariant } from './Button.js';
export { Input } from './Input.js';
export type { InputProps, InputSize } from './Input.js';
export { Switch } from './Switch.js';
export type { SwitchProps } from './Switch.js';
export { SegmentedControl } from './SegmentedControl.js';
export type { SegmentedControlOption, SegmentedControlProps } from './SegmentedControl.js';
export { TimelineDiffView } from './TimelineDiffView.js';
export { PatchReviewPanel } from './PatchReviewPanel.js';
export {
  WorkspaceShell,
  RailSplitter,
  StageSplitter,
  RAIL_BOUNDS,
  COLLAPSED_WIDTH,
  clampRailWidth,
  useRailLayout,
  TIMELINE_MIN,
  TOP_REGION_MIN,
  DEFAULT_TIMELINE_HEIGHT,
  TIMELINE_DOCK_KEY,
  maxDockHeight,
  useDockHeight,
  localStorageAdapter,
} from './WorkspaceShell/index.js';
export type {
  WorkspaceShellProps,
  WorkspaceRailSlot,
  WorkspaceDockSlot,
  RailSplitterProps,
  StageSplitterProps,
  RailSide,
  RailLayout,
  DockHeightOptions,
  DockLayout,
  WorkspacePersistenceAdapter,
} from './WorkspaceShell/index.js';
