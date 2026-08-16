/**
 * The rail-layout hook now lives in `@framepilot/ui`'s WorkspaceShell (J1
 * extraction — plan FRAMEPILOT-AI-PRODUCT-PLAN.md §6), so the same
 * resizable/collapsible rail mechanism can back other hosts, not just this
 * app. This file is a thin re-export that keeps the app's existing import
 * path and `localStorage`-backed behavior (the hook's default
 * {@link WorkspacePersistenceAdapter}) unchanged — `useRailLayout.test.ts`
 * exercises this exact path with zero changes.
 */
export {
  RAIL_BOUNDS,
  COLLAPSED_WIDTH,
  clampRailWidth,
  useRailLayout,
  type RailSide,
  type RailLayout,
} from '@framepilot/ui';
