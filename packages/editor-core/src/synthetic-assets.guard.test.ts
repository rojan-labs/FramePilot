/**
 * Synthetic asset ids are decided in one module per runtime (plan/elements EL3). Adding a
 * synthetic kind — a shape — must be a change to `synthetic-assets.ts`, not a hunt through every
 * module that compares a sentinel. This guard fails when a sentinel literal, a local copy of a
 * sentinel constant, or a direct comparison against one appears in any TypeScript source
 * outside that module. Tests are exempt: fixtures are allowed to spell a project out.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ROOTS = ['packages', 'apps'];
const HOME = path.join('packages', 'editor-core', 'src', 'synthetic-assets.ts');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.next', 'coverage']);

const SENTINEL_LITERAL = /['"`]__(?:text|caption)__['"`]/;
const LOCAL_COPY = /\bconst\s+(?:TEXT_OVERLAY_ASSET_ID|CAPTION_ASSET_ID|SYNTHETIC_ASSET_IDS)\b/;
const DIRECT_COMPARISON =
  /[!=]==?\s*(?:TEXT_OVERLAY_ASSET_ID|CAPTION_ASSET_ID)\b|\b(?:TEXT_OVERLAY_ASSET_ID|CAPTION_ASSET_ID)\s*[!=]==?/;

function isSource(name: string): boolean {
  if (!/\.(?:ts|tsx)$/.test(name) || name.endsWith('.d.ts')) return false;
  return !/\.(?:test|spec)\.tsx?$/.test(name);
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIPPED_DIRS.has(name) || name.startsWith('.')) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return isSource(name) ? [full] : [];
  });
}

function offenders(pattern: RegExp): string[] {
  return ROOTS.flatMap((root) => sources(path.join(REPO, root)))
    .map((file) => path.relative(REPO, file))
    .filter((file) => file !== HOME)
    .flatMap((file) =>
      readFileSync(path.join(REPO, file), 'utf8')
        .split('\n')
        .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : [])),
    );
}

describe('synthetic asset ids live in one module', () => {
  it('no source spells a sentinel id', () => {
    expect(offenders(SENTINEL_LITERAL)).toEqual([]);
  });

  it('no source keeps its own copy of a sentinel constant', () => {
    expect(offenders(LOCAL_COPY)).toEqual([]);
  });

  it('no source compares an asset id against a sentinel directly', () => {
    expect(offenders(DIRECT_COMPARISON)).toEqual([]);
  });
});
