/**
 * Relink an asset to another file, then re-check its background removals (BR4.14).
 *
 * The file is chosen in main (native dialog); the edit is the typed, undoable `relink_asset`
 * patch; main then compares every matte on the asset against the frames recorded when it was
 * made. Changed media comes back STALE with the same sentence the export refuses with.
 */
import { useSyncExternalStore } from 'react';
import type { Patch } from '@framepilot/editor-core';
import type { FramePilotBridge, MatteValidationIssueWire } from '@framepilot/shared-types';
import { relinkAssetPatch } from './patch-builders.js';

/**
 * What main found about each relinked asset's background removals, by asset id, with the path it
 * was checked against.
 *
 * WHY a store: the Inspector re-checks a clip's mattes through main, which reads the SAVED project,
 * and the relink reaches disk only with the next autosave; main's one-shot override for the chosen
 * file is spent on the relink's own re-check. Without this the bin said "needs updating" while the
 * Inspector showed nothing until the clip was selected again (found in E2E.6). A finding is shown
 * only while the asset still points at the file it was checked for, so an undo hides it.
 */
const relinked = new Map<string, { readonly path: string; readonly issues: readonly MatteValidationIssueWire[] }>();
const listeners = new Set<() => void>();
let version = 0;

function record(assetId: string, path: string, issues: readonly MatteValidationIssueWire[]): void {
  relinked.set(assetId, { path, issues });
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** Forget every recorded finding (a project closed; test isolation). */
export function forgetRelinkedMatteIssues(): void {
  relinked.clear();
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** Main's findings for `assetId` if it still points at the file they were checked for. */
export function relinkedMatteIssues(assetId: string | null, path: string | undefined): readonly MatteValidationIssueWire[] {
  if (assetId === null || path === undefined) return [];
  const known = relinked.get(assetId);
  return known !== undefined && known.path === path ? known.issues : [];
}

/** {@link relinkedMatteIssues}, re-read whenever a relink records a finding. */
export function useRelinkedMatteIssues(assetId: string | null, path: string | undefined): readonly MatteValidationIssueWire[] {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return relinkedMatteIssues(assetId, path);
}

export type RelinkOutcome =
  | { readonly status: 'relinked'; readonly path: string; readonly staleMattes: readonly MatteValidationIssueWire[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string };

export interface RelinkDependencies {
  readonly bridge: Pick<FramePilotBridge, 'projectChooseRelinkFile' | 'matteRecheckMedia'>;
  /** Apply (and commit) a patch through the editor's normal undoable path. */
  readonly applyPatch: (patch: Patch) => boolean | void | Promise<boolean | void>;
}

export async function relinkAsset(assetId: string, dependencies: RelinkDependencies): Promise<RelinkOutcome> {
  const { bridge } = dependencies;
  if (bridge.projectChooseRelinkFile === undefined) {
    return { status: 'failed', message: 'Relinking media needs the FramePilot desktop app.' };
  }
  const choice = await bridge.projectChooseRelinkFile(assetId);
  if (!choice.ok) return choice.code === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', message: choice.error };
  const applied = await dependencies.applyPatch(relinkAssetPatch(assetId, choice.path));
  if (applied === false) return { status: 'failed', message: 'The relink could not be applied.' };
  if (bridge.matteRecheckMedia === undefined) return { status: 'relinked', path: choice.path, staleMattes: [] };
  const recheck = await bridge.matteRecheckMedia({ assetIds: [assetId] });
  const staleMattes = recheck.ok ? recheck.issues : [];
  record(assetId, choice.path, staleMattes);
  return { status: 'relinked', path: choice.path, staleMattes };
}

/** One status line for the bin. */
export function relinkStatusMessage(outcome: RelinkOutcome): string | undefined {
  if (outcome.status === 'cancelled') return undefined;
  if (outcome.status === 'failed') return outcome.message;
  const stale = outcome.staleMattes.length;
  if (stale === 0) return 'Media relinked.';
  return `Media relinked. ${stale === 1 ? '1 background removal needs' : `${stale} background removals need`} updating: ${outcome.staleMattes[0]!.remedy}`;
}
