import path from 'node:path';
import { resolveWithin } from '@framepilot/shared-types/safety';
import type { Patch } from '@framepilot/editor-core';

/**
 * Does every asset this patch adds actually point at a file?
 *
 * ## Why the host has to answer this
 *
 * The agent's `add_asset` schema rejects the shapes a model invents when it is guessing —
 * provider URIs, traversal, a name with no extension. It cannot do more: the tool layer is
 * pure by contract (PRD §18.2 — a tool touches no filesystem), so it can judge a path's
 * SHAPE and never its truth. `stock/pexels/8474616.mp4` is a perfectly well-formed relative
 * media path and was still a fabrication; a captured run proposed exactly that, the patch
 * validated, and the bin gained a reference to nothing.
 *
 * The host is the only layer holding the projects root and the project's own directory, so
 * the existence proof belongs here — ahead of the commit, where a rejection still costs the
 * user nothing. Every legitimate producer (`add_stock`, `add_music`, the user's own import)
 * has already written the file by the time its patch arrives, so this refuses guesses
 * without ever refusing real work.
 */

/** An asset reference the host could not resolve to a real file. */
export interface UnresolvableAsset {
  readonly assetId: string;
  readonly assetPath: string;
  /** `'escapes_sandbox'` when the path resolved outside the projects root. */
  readonly cause: 'missing' | 'escapes_sandbox';
}

export interface AssetPathCheckIO {
  /** True when an absolute path names an existing file. */
  exists(absolutePath: string): boolean;
}

/**
 * Find the `add_asset` operations in `patch` whose media does not exist on disk.
 *
 * @param patch - The proposed patch, before commit.
 * @param projectFilePath - Absolute path of the project file the patch will be written to;
 *   relative asset paths are resolved against its directory, exactly as the media pipeline
 *   and the `fp-media://` handler do.
 * @param projectsRoot - The sandbox root every resolved path must stay inside.
 * @param io - Filesystem probe, injected so this is testable without a real tree.
 * @returns One entry per unresolvable asset, in patch order. Empty means the patch is safe.
 */
export function unresolvableAddedAssets(
  patch: Patch,
  projectFilePath: string,
  projectsRoot: string,
  io: AssetPathCheckIO,
): readonly UnresolvableAsset[] {
  const problems: UnresolvableAsset[] = [];
  for (const operation of patch.operations) {
    if (operation.type !== 'add_asset') continue;
    const asset = operation.asset;
    let absolute: string;
    try {
      absolute = resolveWithin(
        projectsRoot,
        path.resolve(path.dirname(projectFilePath), asset.path),
      );
    } catch {
      // `resolveWithin` throws `PathTraversalError` for anything outside the root. A patch
      // is never a reason to widen the sandbox, so this is a refusal, not a fallback.
      problems.push({ assetId: asset.id, assetPath: asset.path, cause: 'escapes_sandbox' });
      continue;
    }
    if (!io.exists(absolute)) {
      problems.push({ assetId: asset.id, assetPath: asset.path, cause: 'missing' });
    }
  }
  return problems;
}

/**
 * The editor-facing sentence for a refused patch. Names the files, because "an asset was
 * missing" sends the user looking through a bin for something that was never in it.
 */
export function describeUnresolvableAssets(problems: readonly UnresolvableAsset[]): string {
  const named = problems
    .map((p) => `"${p.assetPath}"${p.cause === 'escapes_sandbox' ? ' (outside this project)' : ''}`)
    .join(', ');
  return (
    `This edit references media that is not in this project: ${named}. Nothing was changed. ` +
    `Stock and music have to be downloaded through the app before they can be used.`
  );
}
