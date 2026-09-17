/**
 * Relink an asset to another file, then re-check its background removals (BR4.14).
 *
 * The file is chosen in main (native dialog); the edit is the typed, undoable `relink_asset`
 * patch; main then compares every matte on the asset against the frames recorded when it was
 * made. Changed media comes back STALE with the same sentence the export refuses with.
 */
import type { Patch } from '@framepilot/editor-core';
import type { FramePilotBridge, MatteValidationIssueWire } from '@framepilot/shared-types';
import { relinkAssetPatch } from './patch-builders.js';

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
  return { status: 'relinked', path: choice.path, staleMattes: recheck.ok ? recheck.issues : [] };
}

/** One status line for the bin. */
export function relinkStatusMessage(outcome: RelinkOutcome): string | undefined {
  if (outcome.status === 'cancelled') return undefined;
  if (outcome.status === 'failed') return outcome.message;
  const stale = outcome.staleMattes.length;
  if (stale === 0) return 'Media relinked.';
  return `Media relinked. ${stale === 1 ? '1 background removal needs' : `${stale} background removals need`} updating: ${outcome.staleMattes[0]!.remedy}`;
}
