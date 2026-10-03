import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listProjectPage, PROJECT_LIST_MAX_LIMIT } from './project-list.js';
import { createProjectListIO } from './project-list-io.js';

const ALL = { offset: 0, limit: PROJECT_LIST_MAX_LIMIT };

let sandbox: string;
let root: string;
let outside: string;

async function writeProject(dir: string, fileName: string, name: string, mtimeSeconds: number) {
  const target = path.join(dir, fileName);
  await writeFile(target, JSON.stringify({ schemaVersion: 25, id: fileName, name }, null, 2));
  await utimes(target, mtimeSeconds, mtimeSeconds);
  return target;
}

beforeEach(async () => {
  // realpath: macOS tmpdir sits behind the /var -> /private/var symlink, and the sandbox
  // reports paths under the real root.
  sandbox = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'fp-project-list-')));
  root = path.join(sandbox, 'FramePilot Projects');
  outside = path.join(sandbox, 'Elsewhere');
  await mkdir(root);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('createProjectListIO (real file system)', () => {
  it('lists the top-level projects and nothing else', async () => {
    await writeProject(root, 'project_a.fp.json', 'Project A', 2_000);
    await writeProject(root, 'project_b.fp.json', 'Project B', 1_000);
    await writeProject(root, 'project_a.v21.backup.fp.json', 'Backup', 3_000);
    await writeFile(path.join(root, '.framepilot-active.json'), '{}');
    await mkdir(path.join(root, 'media'));
    await mkdir(path.join(root, 'folder.fp.json'));
    await writeProject(path.join(root, 'media'), 'nested.fp.json', 'Nested', 4_000);

    const { entries, total } = await listProjectPage(createProjectListIO(root), [], ALL);

    expect(entries).toEqual([
      {
        path: path.join(root, 'project_a.fp.json'),
        name: 'Project A',
        lastActiveAt: 2_000_000,
        recent: false,
      },
      {
        path: path.join(root, 'project_b.fp.json'),
        name: 'Project B',
        lastActiveAt: 1_000_000,
        recent: false,
      },
    ]);
    expect(total).toBe(2);
  });

  it('skips a symlink that leads outside the root, but lists one that stays inside once', async () => {
    await writeProject(root, 'real.fp.json', 'Real', 1_000);
    const secret = await writeProject(outside, 'secret.fp.json', 'Secret', 2_000);
    await symlink(secret, path.join(root, 'escape.fp.json'));
    await symlink(path.join(root, 'real.fp.json'), path.join(root, 'alias.fp.json'));

    const { entries } = await listProjectPage(createProjectListIO(root), [], ALL);

    expect(entries.map((entry) => entry.name)).toEqual(['Real']);
  });

  it('skips a recent that lies outside the root and never reads it', async () => {
    const secret = await writeProject(outside, 'secret.fp.json', 'Secret', 2_000);
    const io = createProjectListIO(root);

    const { entries } = await listProjectPage(
      io,
      [{ path: secret, name: 'Secret', openedAt: 1 }],
      ALL,
    );

    expect(entries).toEqual([]);
    expect(await io.statProjectFile(secret)).toBeNull();
    await expect(io.readHead(secret, 64)).rejects.toThrow(/outside the projects folder/);
  });

  it('lists nothing for a missing root and does not create it', async () => {
    const missing = path.join(sandbox, 'Not There');

    const result = await listProjectPage(createProjectListIO(missing), [], ALL);

    expect(result).toEqual({ entries: [], total: 0 });
    expect(existsSync(missing)).toBe(false);
  });

  it('reads at most the requested number of bytes', async () => {
    const target = await writeProject(root, 'p.fp.json', 'P', 1);
    const head = await createProjectListIO(root).readHead(target, 10);
    expect(head).toHaveLength(10);
  });
});
