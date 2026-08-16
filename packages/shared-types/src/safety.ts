/**
 * @framepilot/shared-types/safety — the canonical TS path sandbox.
 *
 * WHY this is shared (node-only) and not per-package: every TS surface that turns
 * a user/agent-supplied path into filesystem IO MUST confine it to a sandbox root
 * and reject traversal (`..`, absolute escapes, and symlinks whose target leaves
 * the sandbox) — PRD §18.1, AGENTS.md §6. This used to live only in the MCP server
 * while the Electron IPC handlers had NO check (Phase 8 security audit finding 1.1).
 * Hoisting it here gives the MCP host and the desktop main process one
 * implementation, and it is a faithful mirror of the engine's
 * `framepilot_engine.safety.resolve_within`, so all three runtimes enforce the same
 * containment rule. See ADR 0025.
 *
 * Imported via the `@framepilot/shared-types/safety` subpath so browser bundles
 * (the renderer) never pull in `node:fs`/`node:path`.
 */
import { realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/** Raised when a candidate path escapes its sandbox base directory. */
export class PathTraversalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

/**
 * Realpath the longest existing ancestor of `target`. The candidate file itself
 * may not exist yet (e.g. a not-yet-saved project), but we still resolve symlinks
 * in its existing prefix — and in the final component when it exists — so a
 * symlinked directory OR a symlinked file cannot smuggle the path out of the
 * sandbox. The non-existing tail was already `..`-collapsed by `resolve()`.
 */
function realExistingPrefix(target: string): string {
  let current = target;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      /* v8 ignore next -- base always exists, so we resolve before reaching root. */
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Resolve `candidate` and guarantee it stays inside `base`.
 *
 * Because `realExistingPrefix` realpaths the deepest existing portion of the
 * resolved target (including the final component when it is an existing symlink),
 * a symlink whose target leaves `base` is rejected even when its parent directory
 * is inside the sandbox.
 *
 * @param base - The sandbox root (e.g. `FRAMEPILOT_PROJECTS_ROOT`). Must exist.
 * @param candidate - An untrusted relative or absolute path from the agent/user.
 * @returns The resolved absolute path (symlinks in its existing prefix collapsed).
 * @throws {PathTraversalError} If the resolved path escapes `base`.
 */
export function resolveWithin(base: string, candidate: string): string {
  const resolvedBase = realpathSync(base);
  // `candidate` may be absolute; resolve() honours that, which is exactly why we
  // must re-check containment after resolving (PRD §18.1).
  const resolved = resolve(resolvedBase, candidate);
  const realPrefix = realExistingPrefix(resolved);
  const contained = realPrefix === resolvedBase || realPrefix.startsWith(resolvedBase + sep);
  if (!contained) {
    throw new PathTraversalError(
      `Path escapes sandbox. base=${resolvedBase} candidate=${JSON.stringify(candidate)} resolved=${resolved}`,
    );
  }
  return resolved;
}
