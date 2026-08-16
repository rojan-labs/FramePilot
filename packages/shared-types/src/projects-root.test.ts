import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  ACTIVE_POINTER_FILENAME,
  DEFAULT_PROJECTS_FOLDER,
  activePointerPath,
  isActivePointer,
  resolveProjectsRoot,
} from './projects-root.js';

describe('resolveProjectsRoot', () => {
  it('uses FRAMEPILOT_PROJECTS_ROOT when set (resolved to absolute)', () => {
    const root = resolveProjectsRoot(
      { FRAMEPILOT_PROJECTS_ROOT: '/srv/projects' },
      '/home/u/Documents',
    );
    expect(root).toBe(path.resolve('/srv/projects'));
  });

  it('trims a whitespace-only root and falls back to Documents', () => {
    const root = resolveProjectsRoot({ FRAMEPILOT_PROJECTS_ROOT: '   ' }, '/home/u/Documents');
    expect(root).toBe(path.resolve('/home/u/Documents', DEFAULT_PROJECTS_FOLDER));
  });

  it('defaults to a folder under the Documents dir when no root is configured', () => {
    const root = resolveProjectsRoot({}, '/home/u/Documents');
    expect(root).toBe(path.resolve('/home/u/Documents', DEFAULT_PROJECTS_FOLDER));
  });
});

describe('activePointerPath', () => {
  it('places the hidden pointer file inside the projects root', () => {
    expect(activePointerPath('/srv/projects')).toBe(
      path.join('/srv/projects', ACTIVE_POINTER_FILENAME),
    );
  });
});

describe('isActivePointer', () => {
  it('accepts a well-formed pointer', () => {
    expect(isActivePointer({ path: '/p/demo.fp.json', projectId: 'p1', updatedAt: 1 })).toBe(true);
  });

  it('rejects non-objects and missing/mistyped fields', () => {
    expect(isActivePointer(null)).toBe(false);
    expect(isActivePointer('x')).toBe(false);
    expect(isActivePointer({ path: '/p', projectId: 'p1' })).toBe(false);
    expect(isActivePointer({ path: 1, projectId: 'p1', updatedAt: 1 })).toBe(false);
    expect(isActivePointer({ path: '/p', projectId: 2, updatedAt: 1 })).toBe(false);
    expect(isActivePointer({ path: '/p', projectId: 'p1', updatedAt: 'now' })).toBe(false);
  });
});
