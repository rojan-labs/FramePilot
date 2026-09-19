import path from 'node:path';

/**
 * Resolve a path inside an installed pack root, refusing any escape.
 *
 * Shared by every main-process consumer of installed pack files so a traversal
 * check can never be forgotten at one call site.
 */
export function resolveInside(rootInput: string, relativePath: string): string {
  const root = path.resolve(rootInput);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Capability Pack runtime path escaped its installed root.');
  }
  return resolved;
}

/**
 * A project asset's media file on disk. A saved desktop project stores imported media relative
 * to the project file (`media/<projectId>/clip.mp4`, `importMediaFile`), and the engine, the
 * `fp-media://` handler and the relink re-check all resolve it against the project's folder; a
 * pack job must read the same file. Absolute paths (linked media) pass through unchanged.
 */
export function projectMediaPath(projectDir: string, assetPath: string): string {
  return path.isAbsolute(assetPath) ? assetPath : path.resolve(projectDir, assetPath);
}

/** `project` with every asset path resolved by {@link projectMediaPath}; nothing else changes. */
export function withProjectMediaPaths<T extends { readonly assets: readonly { readonly path: string }[] }>(
  project: T,
  projectDir: string,
): T {
  return {
    ...project,
    assets: project.assets.map((asset) => ({ ...asset, path: projectMediaPath(projectDir, asset.path) })),
  };
}

/** Compare release versions by their numeric core; pre-release order is not meaningful here. */
export function compareSemver(left: string, right: string): number {
  const numeric = (value: string): readonly number[] =>
    value.split('-', 1)[0]!.split('.').map((part) => Number(part));
  const a = numeric(left);
  const b = numeric(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
