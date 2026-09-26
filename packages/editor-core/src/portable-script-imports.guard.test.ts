/**
 * Build and tool scripts load a module by URL, never by a filesystem path.
 *
 * `import()` takes a module specifier, and on Windows an absolute path is not one: Node reads
 * `D:\…` as a URL with the scheme `d:` and refuses it (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). That is
 * how every Windows release build stopped at editor-core's first generator, and the ai-sdk
 * generators after it would have stopped the same way. `pathToFileURL(path).href` is correct on
 * every platform, so the guard fails on any script that hands `import()` a joined or resolved
 * path, or a variable holding one, instead.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ROOTS = ['scripts', 'packages', 'apps', 'engine'];
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'release',
  '.next',
  '.venv',
  'coverage',
]);

/** `import(join(…))`, `import(path.resolve(…))`, or `import(somethingPath)` — a path, not a URL. */
const PATH_IMPORT = /\bimport\(\s*(?:(?:path\.)?(?:join|resolve)\(|[A-Za-z_$][\w$]*Path\s*\))/;

function scripts(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIPPED_DIRS.has(name) || name.startsWith('.')) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return scripts(full);
    return /\.(?:mjs|cjs|js)$/.test(name) ? [full] : [];
  });
}

describe('scripts import modules portably', () => {
  it('no script hands import() a filesystem path', () => {
    const offenders = ROOTS.flatMap((root) => scripts(path.join(REPO, root)))
      .map((file) => path.relative(REPO, file))
      .filter((file) => file.split(path.sep).includes('scripts') || file.startsWith('scripts'))
      .filter((file) => PATH_IMPORT.test(readFileSync(path.join(REPO, file), 'utf8')));
    expect(
      offenders,
      'Wrap the path in pathToFileURL(…).href: on Windows an absolute path is not a module URL.',
    ).toEqual([]);
  });

  it('recognises the shapes that break, and passes the portable one', () => {
    expect(PATH_IMPORT.test("await import(join(HERE, '..', 'dist', 'index.js'))")).toBe(true);
    expect(PATH_IMPORT.test('await import(\n  join(pkgRoot, "dist"))')).toBe(true);
    expect(PATH_IMPORT.test('await import(path.join(root, "x.js"))')).toBe(true);
    expect(PATH_IMPORT.test('await import(enginePath)')).toBe(true);
    expect(PATH_IMPORT.test("await import(pathToFileURL(join(HERE, 'x.js')).href)")).toBe(false);
    expect(PATH_IMPORT.test("await import('@framepilot/timeline-schema')")).toBe(false);
  });
});
