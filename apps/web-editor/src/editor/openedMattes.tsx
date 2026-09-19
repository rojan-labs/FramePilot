/**
 * The matte issues main found when it opened the project (BR4.15).
 *
 * WHY a context: the desktop checks every matte's files as it opens a project
 * (`ProjectOpenResult.mattes`: missing, resized or unparseable artifacts, with the engine's remedy).
 * Two surfaces far apart in the tree show them, the Inspector's background-removal row and the
 * export dialog, and both must show a BROKEN matte from the first paint rather than only after
 * their own `matteRecheckMedia` call answers (which needs main, and the sidecar for stale checks).
 * `App` owns the value; nothing else writes it.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { MatteValidationIssueWire } from '@framepilot/shared-types';

const NONE: readonly MatteValidationIssueWire[] = [];

const OpenedMatteIssuesContext = createContext<readonly MatteValidationIssueWire[]>(NONE);

/**
 * Provides the open-time issues of the project on screen.
 *
 * @param props.issues - `ProjectOpenResult.mattes` of the last open; empty for a new or browser project.
 */
export function OpenedMatteIssuesProvider({
  issues,
  children,
}: {
  readonly issues: readonly MatteValidationIssueWire[];
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <OpenedMatteIssuesContext.Provider value={issues}>{children}</OpenedMatteIssuesContext.Provider>
  );
}

/**
 * The open-time issues, unfiltered. Pass them through `currentMatteIssues` so a finding the
 * editor has since fixed (re-run, removed mask) is not shown.
 *
 * @returns The issues main reported on open; empty outside a provider.
 */
export function useOpenedMatteIssues(): readonly MatteValidationIssueWire[] {
  return useContext(OpenedMatteIssuesContext);
}
