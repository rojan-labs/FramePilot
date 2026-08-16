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
