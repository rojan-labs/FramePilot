import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathTraversalError, resolveWithin } from './safety.js';

describe('resolveWithin', () => {
  it('resolves a relative path inside the sandbox', () => {
    const base = mkdtempSync(join(tmpdir(), 'fp-safe-'));
    const resolved = resolveWithin(base, 'sub/clip.fp.json');
    expect(resolved.endsWith(`${sep}sub${sep}clip.fp.json`)).toBe(true);
  });

  it('allows a not-yet-existing file whose parent is inside the sandbox', () => {
    const base = mkdtempSync(join(tmpdir(), 'fp-safe-'));
    expect(() => resolveWithin(base, 'new.fp.json')).not.toThrow();
  });

  it('rejects `..` traversal', () => {
    const base = mkdtempSync(join(tmpdir(), 'fp-safe-'));
    expect(() => resolveWithin(base, '../escape.json')).toThrow(PathTraversalError);
  });

  it('rejects an absolute path outside the sandbox', () => {
    const base = mkdtempSync(join(tmpdir(), 'fp-safe-'));
    expect(() => resolveWithin(base, '/etc/passwd')).toThrow(PathTraversalError);
  });

  it('rejects a symlink whose target escapes the sandbox', () => {
    const base = mkdtempSync(join(tmpdir(), 'fp-safe-'));
    const outside = mkdtempSync(join(tmpdir(), 'fp-outside-'));
    writeFileSync(join(outside, 'secret.key'), 'top-secret');
    symlinkSync(outside, join(base, 'link'));
    expect(() => resolveWithin(base, 'link/secret.key')).toThrow(PathTraversalError);
  });

  it('allows a symlink whose target stays inside the sandbox', () => {
    const base = mkdtempSync(join(tmpdir(), 'fp-safe-'));
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    expect(() => resolveWithin(base, 'link/clip.fp.json')).not.toThrow();
  });
});
