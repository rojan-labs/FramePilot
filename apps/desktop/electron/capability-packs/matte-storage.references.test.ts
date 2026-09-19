/** BR4.12 re-review: the Clean reference scan covers plain .json projects, links and the recovery snapshot. */
import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanUnusedMattes } from './matte-storage.js';

const KEY = (c: string) => c.repeat(64);
const referencing = (key: string) =>
  JSON.stringify({ timeline: { tracks: [{ clips: [{ masks: [{ kind: 'matte', artifact: { key } }] }] }] } });

async function store() {
  const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-refs-'));
  const mattes = path.join(dir, '.framepilot-derived', 'mattes');
  for (const c of ['a', 'b', 'c']) {
    await mkdir(path.join(mattes, KEY(c)), { recursive: true });
    await writeFile(path.join(mattes, KEY(c), 'matte.mkv'), 'x');
  }
  return { dir, mattes };
}

describe('Clean reference scan', () => {
  it('keeps mattes referenced by a plain .json project and by the recovery snapshot', async () => {
    const { dir, mattes } = await store();
    await writeFile(path.join(dir, 'edit.json'), referencing(KEY('a')));
    const userData = await mkdtemp(path.join(tmpdir(), 'framepilot-userdata-'));
    const recovery = path.join(userData, 'recovery-snapshot.json');
    await writeFile(recovery, JSON.stringify({ project: JSON.parse(referencing(KEY('b'))) }));
    const result = await cleanUnusedMattes(dir, {}, [KEY('a'), KEY('b'), KEY('c')], [], [recovery]);
    expect(result.removedKeys).toEqual([KEY('c')]);
    expect((await readdir(mattes)).sort()).toEqual([KEY('a'), KEY('b')]);
  });

  it('works without a recovery snapshot on disk', async () => {
    const { dir } = await store();
    const result = await cleanUnusedMattes(dir, {}, [KEY('c')], [], [path.join(dir, 'no-such-recovery.json')]);
    expect(result.removedKeys).toEqual([KEY('c')]);
  });

  it('refuses to clean when a project file in the folder is a symlink', async () => {
    const { dir, mattes } = await store();
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'framepilot-elsewhere-'));
    await writeFile(path.join(elsewhere, 'real.fp.json'), referencing(KEY('c')));
    await symlink(path.join(elsewhere, 'real.fp.json'), path.join(dir, 'linked.fp.json'));
    await expect(cleanUnusedMattes(dir, {}, [KEY('c')])).rejects.toMatchObject({ code: 'references_incomplete' });
    expect((await readdir(mattes)).includes(KEY('c'))).toBe(true);
  });
});
