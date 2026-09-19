import { link, mkdir, mkdtemp, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
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

  it('makes the worker’s temp folder under scratch/, and clears only what the host made (F3)', async () => {
    const dir = await project();
    const staging = await createMatteStaging(dir, 'job_1');
    const temp = await staging.temporaryDirectory();
    expect(temp).toBe(path.join(staging.directory, 'scratch', 'tmp'));
    expect((await stat(temp)).mode & 0o777).toBe(0o700);
    await writeFile(path.join(temp, 'ffconcat.txt'), 'x');
    await staging.clearTemporaryDirectory();
    expect((await readdir(staging.directory)).sort()).toEqual(['inputs']);
    // Something else the worker left in scratch/ stays, for verification to refuse.
    await staging.temporaryDirectory();
    await writeFile(path.join(staging.directory, 'scratch', 'frames.u8'), 'x');
    await staging.clearTemporaryDirectory();
    expect(await readdir(path.join(staging.directory, 'scratch'))).toEqual(['frames.u8']);
    // A linked scratch/ is refused, never followed.
    const other = await createMatteStaging(dir, 'job_2');
    await symlink(await project(), path.join(other.directory, 'scratch'));
    await expect(other.temporaryDirectory()).rejects.toMatchObject({ code: 'unsafe_path' });
  });

  it('holds <jobId>.lock while staged; commit and discard release it (F5)', async () => {
    const dir = await project();
    const staging = await createMatteStaging(dir, 'job_1');
    const root = matteStagingRoot(dir);
    expect((await readdir(root)).sort()).toEqual(['job_1', 'job_1.lock']);
    expect(JSON.parse(await readFile(path.join(root, 'job_1.lock'), 'utf8'))).toEqual({ pid: process.pid });
    expect((await stat(path.join(root, 'job_1.lock'))).mode & 0o777).toBe(0o600);
    await staging.discard();
    expect(await readdir(root)).toEqual([]);
    const second = await createMatteStaging(dir, 'job_2');
    await writeFile(path.join(second.directory, 'matte.mkv'), 'm');
    await commitMatteStaging(dir, second, KEY);
    expect(await readdir(root)).toEqual([]);
  });

  it('never adopts a directory another running app instance holds, and takes over a dead one’s lock (F5)', async () => {
    const dir = await project();
    const root = matteStagingRoot(dir);
    const first = await createMatteStaging(dir, 'job_1');
    await mkdir(path.join(first.directory, 'windows', '1'), { recursive: true });
    await writeFile(path.join(first.directory, 'windows', '1', 'done.json'), '{}');
    // The lock now names another process that is running.
    await writeFile(path.join(root, 'job_1.lock'), JSON.stringify({ pid: 424242 }));
    const alive = (pid: number) => pid === 424242;
    await expect(
      createMatteStaging(dir, 'job_1', undefined, { adoptOrphan: true, isProcessAlive: alive }),
    ).rejects.toMatchObject({ code: 'staging_exists' });
    await expect(createMatteStaging(dir, 'job_1', undefined, { isProcessAlive: alive })).rejects.toMatchObject({
      code: 'staging_exists',
    });
    // Nothing was removed and the live lock is intact.
    expect(await readdir(path.join(first.directory, 'windows', '1'))).toEqual(['done.json']);
    expect(JSON.parse(await readFile(path.join(root, 'job_1.lock'), 'utf8'))).toEqual({ pid: 424242 });
    // That process died: its lock is stale, and a resume adopts the directory.
    const adopted = await createMatteStaging(dir, 'job_1', undefined, { adoptOrphan: true, isProcessAlive: () => false });
    expect(adopted.directory).toBe(first.directory);
    expect(JSON.parse(await readFile(path.join(root, 'job_1.lock'), 'utf8'))).toEqual({ pid: process.pid });
    // A new request still refuses the existing directory, and leaves no lock of its own.
    await adopted.release();
    await expect(createMatteStaging(dir, 'job_1', undefined, { isProcessAlive: () => false })).rejects.toMatchObject({
      code: 'staging_exists',
    });
    expect((await readdir(root)).sort()).toEqual(['job_1']);
  });

  it('refuses a lock that is a link or half-written', async () => {
    const dir = await project();
    const root = matteStagingRoot(dir);
    await createMatteStaging(dir, 'job_0').then((staging) => staging.discard());
    await symlink(await project(), path.join(root, 'job_1.lock'));
    await expect(createMatteStaging(dir, 'job_1')).rejects.toMatchObject({ code: 'unsafe_path' });
    await writeFile(path.join(root, 'job_2.lock'), '');
    await expect(createMatteStaging(dir, 'job_2')).rejects.toMatchObject({ code: 'staging_exists' });
  });

  it('adopts an orphan of a stopped app, keeping only the worker’s finished windows', async () => {
    const dir = await project();
    const first = await createMatteStaging(dir, 'job_1');
    // What an app that died mid-job leaves: a finished window, scratch, a half-written output
    // and the old host inputs.
    await mkdir(path.join(first.directory, 'windows', '1'), { recursive: true });
    await writeFile(path.join(first.directory, 'windows', '1', 'done.json'), '{}');
    await mkdir(path.join(first.directory, 'scratch'));
    await writeFile(path.join(first.directory, 'matte.mkv'), 'partial');
    await first.writeInput('locked/0.png', new Uint8Array([1]));

    const adopted = await createMatteStaging(dir, 'job_1', undefined, { adoptOrphan: true });
    expect(adopted.directory).toBe(first.directory);
    expect((await readdir(adopted.directory)).sort()).toEqual(['inputs', 'windows']);
    expect(await readdir(path.join(adopted.directory, 'windows', '1'))).toEqual(['done.json']);
    expect((await readdir(adopted.inputsDirectory)).sort()).toEqual(['corrections', 'locked']);
    expect(await readdir(path.join(adopted.inputsDirectory, 'locked'))).toEqual([]);
  });

  it('never keeps a checkpoint tree holding a link, and refuses a linked staging folder', async () => {
    const dir = await project();
    const outside = await project();
    const first = await createMatteStaging(dir, 'job_1');
    await mkdir(path.join(first.directory, 'windows', '1'), { recursive: true });
    await symlink(outside, path.join(first.directory, 'windows', '1', 'segments'));
    const adopted = await createMatteStaging(dir, 'job_1', undefined, { adoptOrphan: true });
    expect((await readdir(adopted.directory)).sort()).toEqual(['inputs']);
    expect(await readdir(outside)).toEqual([]);

    const linked = await project();
    await mkdir(matteStagingRoot(linked), { recursive: true });
    await symlink(outside, path.join(matteStagingRoot(linked), 'job_2'));
    await expect(
      createMatteStaging(linked, 'job_2', undefined, { adoptOrphan: true }),
    ).rejects.toMatchObject({ code: 'unsafe_path' });
  });

  it('drops a checkpoint tree holding a hard-linked file, or deeper or wider than its bounds (F6)', async () => {
    const dir = await project();
    const outside = await project();
    const adopt = () => createMatteStaging(dir, 'job_1', undefined, { adoptOrphan: true });
    const first = await createMatteStaging(dir, 'job_1');
    await first.release();
    // A hard link aliasing a file outside staging.
    await writeFile(path.join(outside, 'precious.bin'), 'x');
    await mkdir(path.join(first.directory, 'windows', '1'), { recursive: true });
    await link(path.join(outside, 'precious.bin'), path.join(first.directory, 'windows', '1', 'matte.mkv'));
    await (await adopt()).release();
    expect((await readdir(first.directory)).sort()).toEqual(['inputs']);
    expect(await readFile(path.join(outside, 'precious.bin'), 'utf8')).toBe('x');
    // Too deep.
    await mkdir(path.join(first.directory, 'windows', 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true });
    await (await adopt()).release();
    expect((await readdir(first.directory)).sort()).toEqual(['inputs']);
    // A normal checkpoint is kept.
    await mkdir(path.join(first.directory, 'windows', '1'), { recursive: true });
    await writeFile(path.join(first.directory, 'windows', '1', 'done.json'), '{}');
    await (await adopt()).release();
    expect((await readdir(first.directory)).sort()).toEqual(['inputs', 'windows']);
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
    // orphan's lock is as old as it is, and names this process (no live job): stale.
    await utimes(path.join(matteStagingRoot(dir), 'orphan.lock'), old, old);
    await utimes(path.join(matteStagingRoot(dir), 'live.lock'), old, old);
    expect(await sweepMatteStaging(dir, { now, activeJobIds: new Set(['live']) })).toBe(3);
    expect((await readdir(matteStagingRoot(dir))).sort()).toEqual(['fresh', 'fresh.lock', 'live', 'live.lock']);
    expect(await readdir(outside)).toEqual(['keep.txt']);
    expect(await sweepMatteStaging(await project(), { now, activeJobIds: new Set() })).toBe(0);
  });
});

describe('staging sweep and other app instances (F5)', () => {
  it('leaves an old directory alone while another running process holds its lock', async () => {
    const dir = await project();
    const now = new Date(Date.now() + 25 * 3600 * 1000);
    const staging = await createMatteStaging(dir, 'job_1');
    await writeFile(path.join(matteStagingRoot(dir), 'job_1.lock'), JSON.stringify({ pid: 424242 }));
    const alive = (pid: number) => pid === 424242;
    expect(await sweepMatteStaging(dir, { now, activeJobIds: new Set(), isProcessAlive: alive })).toBe(0);
    expect((await readdir(matteStagingRoot(dir))).sort()).toEqual(['job_1', 'job_1.lock']);
    expect(await sweepMatteStaging(dir, { now, activeJobIds: new Set(), isProcessAlive: () => false })).toBe(2);
    await expect(readdir(staging.directory)).rejects.toMatchObject({ code: 'ENOENT' });
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
