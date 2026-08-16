/**
 * Tests for the renderer-facing path sandbox (Phase 8 security audit finding 1.1).
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sandboxProjectPath } from './sandbox.js';

describe('sandboxProjectPath', () => {
  const base = (): string => mkdtempSync(join(tmpdir(), 'fp-ipc-'));

  it('rejects a non-string or empty path', () => {
    const dir = base();
    expect(sandboxProjectPath(dir, undefined)).toEqual({
      ok: false,
      error: expect.stringContaining('non-empty string'),
    });
    expect(sandboxProjectPath(dir, '   ').ok).toBe(false);
  });

  it('resolves a project path inside the projects folder', () => {
    const dir = base();
    const result = sandboxProjectPath(dir, 'my-project.fp.json');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path.endsWith(`${sep}my-project.fp.json`)).toBe(true);
    }
  });

  it('allows a nested path inside the projects folder', () => {
    const dir = base();
    mkdirSync(join(dir, 'demos'));
    expect(sandboxProjectPath(dir, 'demos/a.fp.json').ok).toBe(true);
  });

  it('rejects a `..` traversal escape', () => {
    const dir = base();
    const result = sandboxProjectPath(dir, '../../etc/passwd');
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('outside the FramePilot projects folder'),
    });
  });

  it('rejects an absolute path outside the projects folder', () => {
    const dir = base();
    expect(sandboxProjectPath(dir, '/etc/passwd').ok).toBe(false);
  });
});
