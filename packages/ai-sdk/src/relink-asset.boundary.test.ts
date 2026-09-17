/**
 * BR4.12 L5: relinking media is a human action through a native file dialog. No AI tool may
 * emit `relink_asset`; the only ai-sdk files that may name it describe or classify history.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY } from './index.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED = new Set(['describe.ts', path.join('kernel', 'evidence-store.ts')]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('relink_asset is not reachable by AI tools', () => {
  it('appears only in the describe and evidence-store modules', () => {
    const mentions = sources(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('relink_asset'))
      .map((file) => path.relative(SRC, file));
    expect(mentions.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });

  it('is not the name of any registered tool', () => {
    const names = (TOOL_REGISTRY as readonly { name: string }[]).map((tool) => tool.name);
    expect(names.some((name) => name.includes('relink'))).toBe(false);
  });
});
