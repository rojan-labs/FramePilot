import { mkdir, mkdtemp, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commitMatteStaging,
  createMatteStaging,
  matteArtifactDirectory,
  matteStagingRoot,
  sweepMatteStaging,
} from './matte-staging.js';

const KEY = 'a'.repeat(64);

async function project(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'framepilot-matte-staging-'));
}

describe('matte staging (MD-3)', () => {
  it('creates one empty per-job directory with host input folders', async () => {
    const dir = await project();
    const staging = await createMatteStaging(dir, 'job_1');
    expect(staging.directory).toBe(path.join(dir, '.framepilot-derived', 'mattes', '.staging', 'job_1'));
    expect((await readdir(staging.directory)).sort()).toEqual(['inputs']);
    expect((await readdir(staging.inputsDirectory)).sort()).toEqual(['corrections', 'locked']);
    await expect(createMatteStaging(dir, 'job_1')).rejects.toMatchObject({ code: 'staging_exists' });
    expect(staging.outputHandle(['matte.mkv', 'frames.json'], 10)).toMatchObject({
      absolutePath: staging.directory,
      allowedFiles: ['matte.mkv', 'frames.json'],
    });
    expect(staging.inputHandle([])).toBeUndefined();
  });

  it.each(['../escape', 'a/b', '', '.', 'x'.repeat(65), 'job:1', '..'])(
    'refuses job id %j',
    async (jobId) => {
      await expect(createMatteStaging(await project(), jobId)).rejects.toMatchObject({ code: 'invalid_job_id' });
    },
  );

  it('refuses to write through a symlink anywhere in the matte store', async () => {
    const dir = await project();
    const elsewhere = await project();
    await mkdir(path.join(dir, '.framepilot-derived'));
    await symlink(elsewhere, path.join(dir, '.framepilot-derived', 'mattes'));
    await expect(createMatteStaging(dir, 'job')).rejects.toMatchObject({ code: 'unsafe_path' });
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('writes only named inputs, never over an existing file or outside inputs/', async () => {
    const staging = await createMatteStaging(await project(), 'job');
    await staging.writeInput('locked/512.png', Buffer.from('png'));
    await expect(staging.writeInput('locked/512.png', Buffer.from('x'))).rejects.toMatchObject({ code: 'EEXIST' });
    for (const bad of ['../matte.mkv', 'locked/../../x.png', 'previous/matte.mkv', '/etc/passwd', 'locked/1.png/..']) {
      await expect(staging.writeInput(bad, Buffer.from('x'))).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('clones a previous artifact into inputs/previous without touching the original', async () => {
    const dir = await project();
    const previous = path.join(dir, 'prev');
    await mkdir(previous);
    await writeFile(path.join(previous, 'matte.mkv'), 'alpha');
    await writeFile(path.join(previous, 'frames.json'), '{}');
    const staging = await createMatteStaging(dir, 'job');
    expect(await staging.clonePrevious(previous, ['matte.mkv', 'frames.json'])).toEqual([
      'previous/matte.mkv',
      'previous/frames.json',
    ]);
    await writeFile(path.join(staging.inputsDirectory, 'previous', 'matte.mkv'), 'changed');
    expect((await stat(path.join(previous, 'matte.mkv'))).size).toBe(5);
    const linked = path.join(dir, 'linked');
    await mkdir(linked);
    await symlink('/etc/hosts', path.join(linked, 'matte.mkv'));
    const other = await createMatteStaging(dir, 'job2');
    await expect(other.clonePrevious(linked, ['matte.mkv'])).rejects.toMatchObject({ code: 'unsafe_path' });
  });

  it('commits by one rename, drops input copies, and lets the first commit of a key win', async () => {
    const dir = await project();
    const first = await createMatteStaging(dir, 'one');
    await writeFile(path.join(first.directory, 'matte.mkv'), 'a');
    await first.writeInput('locked/0.png', Buffer.from('png'));
    expect(await commitMatteStaging(dir, first, KEY)).toBe('committed');
    const target = matteArtifactDirectory(dir, KEY)!;
    expect(await readdir(target)).toEqual(['matte.mkv']);
    const second = await createMatteStaging(dir, 'two');
    await writeFile(path.join(second.directory, 'matte.mkv'), 'b');
    expect(await commitMatteStaging(dir, second, KEY)).toBe('already_present');
    expect(await readdir(matteStagingRoot(dir))).toEqual([]);
    await expect(commitMatteStaging(dir, second, '../x')).rejects.toMatchObject({ code: 'invalid_key' });
    expect(matteArtifactDirectory(dir, 'A'.repeat(64))).toBeUndefined();
  });

  it('refuses to commit a directory from outside this project’s staging root', async () => {
    const dir = await project();
    const foreign = await project();
    const staging = await createMatteStaging(foreign, 'job');
    await expect(commitMatteStaging(dir, staging, KEY)).rejects.toMatchObject({ code: 'unsafe_path' });
  });

  it('sweeps orphans older than 24 h, keeps live jobs and fresh directories, never follows links', async () => {
    const dir = await project();
    const now = new Date('2026-09-17T12:00:00Z');
    const old = new Date(now.getTime() - 25 * 3600 * 1000);
    const orphan = await createMatteStaging(dir, 'orphan');
    const live = await createMatteStaging(dir, 'live');
    await createMatteStaging(dir, 'fresh');
    const outside = await project();
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    const link = path.join(matteStagingRoot(dir), 'link');
    await symlink(outside, link);
    for (const target of [orphan.directory, live.directory]) await utimes(target, old, old);
    const { lutimes } = await import('node:fs/promises');
    await lutimes(link, old, old);
    expect(await sweepMatteStaging(dir, { now, activeJobIds: new Set(['live']) })).toBe(2);
    expect((await readdir(matteStagingRoot(dir))).sort()).toEqual(['fresh', 'live']);
    expect(await readdir(outside)).toEqual(['keep.txt']);
    expect(await sweepMatteStaging(await project(), { now, activeJobIds: new Set() })).toBe(0);
  });
});

describe('commit re-check after verification (BR4.12 H1)', () => {
  const setup = async () => {
    const dir = await project();
    const staging = await createMatteStaging(dir, 'job');
    await writeFile(path.join(staging.directory, 'matte.mkv'), 'alpha');
    await writeFile(path.join(staging.directory, 'frames.json'), '{}');
    return { dir, staging, files: [{ name: 'matte.mkv', bytes: 5 }, { name: 'frames.json', bytes: 2 }] };
  };

  it('commits when the staging directory still holds exactly the verified files', async () => {
    const { dir, staging, files } = await setup();
    expect(await commitMatteStaging(dir, staging, KEY, files)).toBe('committed');
  });

  it('refuses a hard link, an added file, a changed size or a swapped symlink', async () => {
    const { link, rm: remove, symlink: makeSymlink } = await import('node:fs/promises');
    const hard = await setup();
    await link(path.join(hard.staging.directory, 'matte.mkv'), path.join(hard.dir, 'alias.mkv'));
    await expect(commitMatteStaging(hard.dir, hard.staging, KEY, hard.files)).rejects.toMatchObject({ code: 'changed_after_verify' });

    const added = await setup();
    await writeFile(path.join(added.staging.directory, 'run.sh'), 'x');
    await expect(commitMatteStaging(added.dir, added.staging, KEY, added.files)).rejects.toMatchObject({ code: 'changed_after_verify' });

    const grown = await setup();
    await writeFile(path.join(grown.staging.directory, 'matte.mkv'), 'alpha plus');
    await expect(commitMatteStaging(grown.dir, grown.staging, KEY, grown.files)).rejects.toMatchObject({ code: 'changed_after_verify' });

    const swapped = await setup();
    await remove(path.join(swapped.staging.directory, 'frames.json'));
    await makeSymlink('/etc/hosts', path.join(swapped.staging.directory, 'frames.json'));
    await expect(commitMatteStaging(swapped.dir, swapped.staging, KEY, swapped.files)).rejects.toMatchObject({ code: 'changed_after_verify' });
    expect(matteArtifactDirectory(swapped.dir, KEY)).toBeDefined();
    await expect(stat(matteArtifactDirectory(swapped.dir, KEY)!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
