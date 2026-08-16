import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  DEFAULT_PROJECTS_FOLDER,
  defaultProjectPath,
  projectFileName,
  resolveProjectsDir,
} from './projects-dir.js';

describe('resolveProjectsDir', () => {
  it('uses FRAMEPILOT_PROJECTS_ROOT when set (resolved to absolute)', () => {
    const dir = resolveProjectsDir(
      { FRAMEPILOT_PROJECTS_ROOT: '/srv/projects' },
      '/home/u/Documents',
    );
    expect(dir).toBe(path.resolve('/srv/projects'));
  });

  it('trims a whitespace-only root and falls back to Documents', () => {
    const dir = resolveProjectsDir({ FRAMEPILOT_PROJECTS_ROOT: '   ' }, '/home/u/Documents');
    expect(dir).toBe(path.resolve('/home/u/Documents', DEFAULT_PROJECTS_FOLDER));
  });

  it('defaults to a folder under the Documents dir when no root is configured', () => {
    const dir = resolveProjectsDir({}, '/home/u/Documents');
    expect(dir).toBe(path.resolve('/home/u/Documents', DEFAULT_PROJECTS_FOLDER));
  });
});

describe('projectFileName', () => {
  it('keeps an already-slugged id and appends the extension', () => {
    expect(projectFileName('project_my_demo')).toBe('project_my_demo.fp.json');
  });

  it('sanitises unsafe characters and path separators (no traversal possible)', () => {
    expect(projectFileName('../../etc/passwd')).toBe('etc_passwd.fp.json');
    expect(projectFileName('a/b\\c')).toBe('a_b_c.fp.json');
  });

  it('falls back to "untitled" when nothing safe remains', () => {
    expect(projectFileName('///')).toBe('untitled.fp.json');
    expect(projectFileName('')).toBe('untitled.fp.json');
  });
});

describe('defaultProjectPath', () => {
  it('joins the projects dir with the bare derived file name', () => {
    expect(defaultProjectPath('/srv/projects', 'project_demo')).toBe(
      path.join('/srv/projects', 'project_demo.fp.json'),
    );
  });

  it('cannot escape the projects dir even for a malicious id', () => {
    const target = defaultProjectPath('/srv/projects', '../../../../etc/x');
    expect(target.startsWith(path.join('/srv/projects'))).toBe(true);
  });
});
