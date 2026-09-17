import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanUnusedMattes, collectMatteReferences, matteStorageSummary } from './matte-storage.js';

const KEY = (c: string) => c.repeat(64);

async function projectWithStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-matte-storage-'));
  const mattes = path.join(dir, '.framepilot-derived', 'mattes');
  for (const [key, bytes] of [
    [KEY('a'), 100],
    [KEY('b'), 200],
    [KEY('c'), 300],
    [KEY('d'), 400],
  ] as const) {
    await mkdir(path.join(mattes, key), { recursive: true });
    await writeFile(path.join(mattes, key, 'matte.mkv'), Buffer.alloc(bytes));
  }
  await mkdir(path.join(mattes, '.inputs'), { recursive: true });
  await writeFile(path.join(mattes, '.inputs', `${KEY('e')}.png`), Buffer.alloc(10));
  await writeFile(path.join(mattes, '.inputs', `${KEY('f')}.png`), Buffer.alloc(20));
  await mkdir(path.join(mattes, '.results'), { recursive: true });
  await writeFile(path.join(mattes, '.results', `${KEY('b')}.json`), '{}');
  await mkdir(path.join(mattes, '.staging', 'job'), { recursive: true });
  await writeFile(path.join(mattes, '.staging', 'job', 'matte.mkv'), Buffer.alloc(5));
  const project = {
    timeline: {
      tracks: [
        {
          clips: [
            {
              masks: [
                {
                  kind: 'matte',
                  artifact: { key: KEY('a') },
                  prompts: [{ kind: 'brush', sourceTime: 1, sha256: KEY('e') }],
                },
              ],
            },
          ],
        },
      ],
    },
    // A saved history entry still references an earlier matte.
    history: [{ operations: [{ type: 'add_mask', mask: { kind: 'matte', artifact: { key: KEY('c') } } }] }],
  };
  return { dir, mattes, project };
}

describe('matte storage (MD-4)', () => {
  it('finds matte and correction references anywhere in the project', async () => {
    const { project } = await projectWithStore();
    const references = collectMatteReferences(project);
    expect([...references.artifacts].sort()).toEqual([KEY('a'), KEY('c')]);
    expect([...references.inputs]).toEqual([KEY('e')]);
  });

  it('reports bytes per artifact, referenced and unused totals, and staging separately', async () => {
    const { dir, project } = await projectWithStore();
    const summary = await matteStorageSummary(dir, project, [KEY('d')]);
    expect(summary.artifacts.map((item) => [item.key[0], item.bytes, item.referenced])).toEqual([
      ['a', 100, true],
      ['b', 200, false],
      ['c', 300, true],
      ['d', 400, true],
    ]);
    expect(summary.inputs.map((item) => [item.sha256[0], item.referenced])).toEqual(expect.arrayContaining([['e', true], ['f', false]]));
    expect(summary).toMatchObject({ stagingBytes: 5, unusedBytes: 220, referencedBytes: 810, totalBytes: 1035 });
  });

  it('cleans exactly the approved unused entries and keeps anything referenced or protected', async () => {
    const { dir, mattes, project } = await projectWithStore();
    const result = await cleanUnusedMattes(dir, project, [KEY('a'), KEY('b'), KEY('c'), KEY('d'), KEY('f'), KEY('9'), '../../etc'], [KEY('d')]);
    expect([...result.removedKeys].sort()).toEqual([KEY('b'), KEY('f')]);
    expect([...result.keptKeys].sort()).toEqual([KEY('9'), KEY('a'), KEY('c'), KEY('d')]);
    expect(result.freedBytes).toBe(220);
    expect((await readdir(mattes)).sort()).toEqual(['.inputs', '.results', '.staging', KEY('a'), KEY('c'), KEY('d')]);
    expect(await readdir(path.join(mattes, '.results'))).toEqual([]);
    expect(await readdir(path.join(mattes, '.inputs'))).toEqual([`${KEY('e')}.png`]);
  });

  it('never deletes through a link planted as an artifact folder', async () => {
    const { dir, mattes, project } = await projectWithStore();
    const outside = await mkdtemp(path.join(tmpdir(), 'framepilot-outside-'));
    await writeFile(path.join(outside, 'precious.mov'), 'keep');
    await symlink(outside, path.join(mattes, KEY('7')));
    const result = await cleanUnusedMattes(dir, project, [KEY('7')]);
    expect(result.removedKeys).toEqual([KEY('7')]);
    expect(await readdir(outside)).toEqual(['precious.mov']);
  });
});
