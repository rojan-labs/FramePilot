/**
 * Tests for atomic project.fp.json file IO (PLAN §1.1).
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type Project } from './index.js';
import { writeFile } from 'node:fs/promises';
import {
  isProjectFileConflictError,
  MAX_PARSED_PROJECT_BYTES,
  PROJECT_FILE_CONFLICT_CODE,
  preMigrationBackupPath,
  readProjectFile,
  serializeProject,
  stripTopLevelHistory,
  writeProjectFile,
} from './project-file.js';

const sampleProject = (): Project => ({
  id: 'p1',
  name: 'IO Test',
  version: 1,
  fps: 30,
  resolution: { width: 1080, height: 1920 },
  assets: [],
  folders: [],
  timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
  transcript: [],
  markers: [],
  angleGroups: [],
  aiMemory: {},
  history: [],
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'framepilot-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeProjectFile / readProjectFile', () => {
  it('round-trips a project through disk', async () => {
    const path = join(dir, 'project.fp.json');
    const project = sampleProject();
    await writeProjectFile(path, project);
    expect(await readProjectFile(path)).toEqual(project);
  });

  it('creates missing parent directories', async () => {
    const path = join(dir, 'nested', 'deep', 'project.fp.json');
    await writeProjectFile(path, sampleProject());
    expect(await readProjectFile(path)).toEqual(sampleProject());
  });

  it('leaves no temp file behind after an atomic write', async () => {
    const path = join(dir, 'project.fp.json');
    await writeProjectFile(path, sampleProject());
    const entries = await readdir(dir);
    expect(entries).toEqual(['project.fp.json']);
  });

  it('survives two interleaved writers without publishing a mixture', async () => {
    // The MCP server edits the SAME project.fp.json from a separate OS process, and the
    // desktop only serialises its own writes. With one fixed `<path>.tmp` both writers
    // opened the same file with 'w', their bytes interleaved, and one rename published the
    // mixture while the other threw ENOENT. Two concurrent writers of DIFFERENT projects
    // is the sharpest form of that: whichever wins, the file must parse and must be one of
    // the two — never a splice of both.
    const path = join(dir, 'project.fp.json');
    const small = sampleProject();
    const large: Project = {
      ...sampleProject(),
      id: 'p2',
      // Big enough that a single write is not one atomic syscall, which is what made the
      // old shared temp file interleave rather than merely race.
      name: 'L'.repeat(2 * 1024 * 1024),
    };
    await Promise.all([writeProjectFile(path, small), writeProjectFile(path, large)]);

    const loaded = await readProjectFile(path);
    expect([small.id, large.id]).toContain(loaded.id);
    expect(loaded).toEqual(loaded.id === small.id ? small : large);
    // Neither writer may leave a fragment beside the project.
    expect(await readdir(dir)).toEqual(['project.fp.json']);
  });

  it('does not fail a concurrent write with ENOENT on a shared temp file', async () => {
    // Guards the mechanism directly: with one shared `<path>.tmp`, the first rename
    // consumes the file the second writer is still counting on, and that writer rejects
    // with ENOENT — an autosave that reports failure while the user keeps editing.
    const path = join(dir, 'project.fp.json');
    await expect(
      Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          writeProjectFile(path, { ...sampleProject(), name: `n${String(i)}` }),
        ),
      ),
    ).resolves.toHaveLength(8);
    expect(await readdir(dir)).toEqual(['project.fp.json']);
  });

  it('removes its temp file when the rename fails', async () => {
    // A directory cannot be replaced by a file, so the rename fails after the temp file
    // exists — the exact window that used to leave a multi-MB fragment beside the project.
    const path = join(dir, 'occupied');
    await mkdir(join(path, 'child'), { recursive: true });
    await expect(writeProjectFile(path, sampleProject())).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['occupied']);
  });

  it('writes human-diffable JSON carrying the schema envelope', async () => {
    const path = join(dir, 'project.fp.json');
    await writeProjectFile(path, sampleProject());
    const text = await readFile(path, 'utf8');
    // Asserted against the constant, not a literal: a hard-coded version turns
    // every future schema bump into an unrelated test failure here.
    expect(text).toContain(`\n  "schemaVersion": ${SCHEMA_VERSION}`);
  });
});

/**
 * The other process is simulated with a RAW `fs.writeFile`, never with
 * {@link writeProjectFile}. Going through our own writer would update the per-process
 * observed-content registry, which is precisely the knowledge a second OS process does
 * NOT share — a test that fakes a second writer with this process's writer proves nothing
 * about the guard.
 */
async function externalProcessWrites(path: string, project: Project): Promise<void> {
  await writeFile(path, serializeProject(project), 'utf8');
}

describe('writeProjectFile — cross-process lost-update guard', () => {
  it('writes blind to a path this process has never seen', async () => {
    // Save-as and first saves have no baseline to protect; refusing them would break
    // saving rather than protect it.
    const path = join(dir, 'brand-new.fp.json');
    await writeProjectFile(path, sampleProject());
    expect((await readProjectFile(path)).id).toBe('p1');
  });

  it('refuses to publish over content written by another process', async () => {
    const path = join(dir, 'project.fp.json');
    await writeProjectFile(path, sampleProject());
    await readProjectFile(path);
    await externalProcessWrites(path, { ...sampleProject(), name: 'Edited elsewhere' });

    await expect(
      writeProjectFile(path, { ...sampleProject(), name: 'Mine' }),
    ).rejects.toMatchObject({ code: PROJECT_FILE_CONFLICT_CODE });
    // The other writer's edit survives — the lost update was prevented, not clobbered.
    expect((await readProjectFile(path)).name).toBe('Edited elsewhere');
  });

  it('does not lose an update across two interleaved read-modify-write cycles', async () => {
    // Both writers read the SAME starting document, then each edits a different field.
    // Without the guard the later rename publishes a whole document and the earlier
    // writer's field is simply gone; with it, the second publish is refused instead.
    const path = join(dir, 'project.fp.json');
    await writeProjectFile(path, sampleProject());

    const mine = await readProjectFile(path); // this process reads…
    const theirs = await readProjectFile(path); // …and so does the other one
    await externalProcessWrites(path, { ...theirs, name: 'Their edit' });

    await expect(writeProjectFile(path, { ...mine, fps: 60 })).rejects.toSatisfy(
      isProjectFileConflictError,
    );
    const onDisk = await readProjectFile(path);
    expect(onDisk.name).toBe('Their edit');
    expect(onDisk.fps).toBe(30);
  });

  it('re-establishes the baseline on re-read, so the guard is not a permanent deadlock', async () => {
    // The desktop watcher re-reads the file on every debounced fs event; that read is what
    // lets the refused writer retry instead of being locked out of its own project.
    const path = join(dir, 'project.fp.json');
    await writeProjectFile(path, sampleProject());
    await externalProcessWrites(path, { ...sampleProject(), name: 'Their edit' });
    await expect(writeProjectFile(path, sampleProject())).rejects.toSatisfy(
      isProjectFileConflictError,
    );

    const reloaded = await readProjectFile(path);
    await writeProjectFile(path, { ...reloaded, name: 'Merged' });
    expect((await readProjectFile(path)).name).toBe('Merged');
  });

  it('allows the write when the file was deleted (nothing to clobber)', async () => {
    const path = join(dir, 'project.fp.json');
    await writeProjectFile(path, sampleProject());
    await rm(path);

    await writeProjectFile(path, { ...sampleProject(), name: 'Recreated' });
    expect((await readProjectFile(path)).name).toBe('Recreated');
  });

  it('refuses when the known target cannot be read at all', async () => {
    // EISDIR/EACCES is "I could not look", not "there is nothing there". Overwriting an
    // unknown target is exactly the mistake the guard exists to prevent.
    const path = join(dir, 'project.fp.json');
    await writeProjectFile(path, sampleProject());
    await rm(path);
    await mkdir(path);

    await expect(writeProjectFile(path, sampleProject())).rejects.toSatisfy(
      isProjectFileConflictError,
    );
  });

  it('leaves no temp fragment behind when a write is refused', async () => {
    const path = join(dir, 'project.fp.json');
    await writeProjectFile(path, sampleProject());
    await externalProcessWrites(path, { ...sampleProject(), name: 'Their edit' });

    await expect(writeProjectFile(path, sampleProject())).rejects.toSatisfy(
      isProjectFileConflictError,
    );
    expect(await readdir(dir)).toEqual(['project.fp.json']);
  });

  it('names the file and the recovery step in the refusal message', async () => {
    // `dispatch.ts` renders a session error as `[code] message`, so instructions that are
    // not IN the message never reach the agent that has to act on them.
    const path = join(dir, 'project.fp.json');
    await writeProjectFile(path, sampleProject());
    await externalProcessWrites(path, { ...sampleProject(), name: 'Their edit' });

    await expect(writeProjectFile(path, sampleProject())).rejects.toThrow(
      /changed on disk[\s\S]*Reload the project/,
    );
  });

  it('identifies a conflict by code, not by class identity', () => {
    // Consumers import this module through its built dist; a duplicated module identity
    // makes `instanceof` quietly false, and a guard that quietly stops guarding is worse
    // than none.
    expect(isProjectFileConflictError({ code: PROJECT_FILE_CONFLICT_CODE })).toBe(true);
    expect(isProjectFileConflictError(new Error('nope'))).toBe(false);
    expect(isProjectFileConflictError(null)).toBe(false);
  });
});

describe('stripTopLevelHistory', () => {
  it('empties the top-level history array', () => {
    const text = JSON.stringify({ id: 'p', history: [{ a: 1 }, { b: 2 }], name: 'x' }, null, 2);
    const stripped = stripTopLevelHistory(text);
    expect(stripped).not.toBeNull();
    expect(JSON.parse(stripped!)).toEqual({ id: 'p', history: [], name: 'x' });
  });

  it('is not fooled by brackets, quotes or escapes inside caption text', () => {
    // Real caption/clip text contains all of these; a regex would end the array early.
    const nasty = 'a "]" b [ \\" ] c';
    const text = JSON.stringify(
      { id: 'p', history: [{ reason: nasty }], name: nasty, markers: [1, 2] },
      null,
      2,
    );
    const stripped = stripTopLevelHistory(text);
    expect(JSON.parse(stripped!)).toEqual({
      id: 'p',
      history: [],
      name: nasty,
      markers: [1, 2],
    });
  });

  it('ignores a nested "history" key so only the real one is dropped', () => {
    const text = JSON.stringify(
      { id: 'p', timeline: { history: ['keep me'] }, history: [{ drop: true }] },
      null,
      2,
    );
    const parsed = JSON.parse(stripTopLevelHistory(text)!) as Record<string, unknown>;
    expect(parsed['timeline']).toEqual({ history: ['keep me'] });
    expect(parsed['history']).toEqual([]);
  });

  it('returns null when there is no top-level history array to drop', () => {
    expect(stripTopLevelHistory(JSON.stringify({ id: 'p' }))).toBeNull();
  });
});

describe('readProjectFile over the parse budget', () => {
  it('opens the project without its history instead of exhausting memory', async () => {
    // A project whose history alone pushes the file past the budget. Parsing it
    // whole is what aborted the Electron main process with a V8 heap OOM.
    const path = join(dir, 'project.fp.json');
    const filler = 'x'.repeat(1024);
    const project = sampleProject();
    // 32k entries lands ~75MB — safely over the 64MiB budget (asserted below,
    // so a future format change that shrinks the fixture fails loudly) while
    // keeping stringify + scan + parse inside CI's time budget.
    const bloated = {
      ...project,
      history: Array.from({ length: 32 * 1024 }, (_, i) => ({
        patch: { patchId: `p${String(i)}`, createdBy: 'agent', reason: filler, operations: [] },
        inverse: { patchId: `i${String(i)}`, createdBy: 'agent', reason: filler, operations: [] },
      })),
    };
    const text = JSON.stringify(bloated, null, 2);
    expect(text.length).toBeGreaterThan(MAX_PARSED_PROJECT_BYTES);
    await writeFile(path, text, 'utf8');

    const loaded = await readProjectFile(path);
    expect(loaded.history).toEqual([]);
    // Everything that is not history survives — the user loses undo, not work.
    expect(loaded.id).toBe(project.id);
    expect(loaded.timeline).toEqual(project.timeline);
    // The ~75MB fixture is intentionally heavy; stringify + scan + parse took
    // ~42s on the 2-vCPU CI runner once coverage instrumentation and turbo's
    // package parallelism were stacked on top, so give the stress run real
    // headroom instead of a load-dependent flake.
  }, 120_000);
});

describe('pre-migration backup and newer-format refusal (schema v22)', () => {
  const v21Text = (): string =>
    JSON.stringify(
      {
        ...sampleProject(),
        schemaVersion: 21,
        assets: [{ id: 'a1', path: 'a.mp4', media: { width: 1920, height: 1080 } }],
        timeline: {
          tracks: [
            {
              id: 'video_1',
              type: 'video',
              clips: [
                {
                  id: 'c1',
                  assetId: 'a1',
                  trackId: 'video_1',
                  start: 0,
                  end: 2,
                  sourceStart: 0,
                  sourceEnd: 2,
                  effects: [{ id: 'c1__mask', type: 'mask', params: { shape: 'ellipse' } }],
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );

  it('names the backup after the project and the version it was written with', () => {
    expect(preMigrationBackupPath('/p/demo.fp.json', 21)).toBe('/p/demo.v21.backup.fp.json');
    expect(preMigrationBackupPath('/p/demo.json', 21)).toBe('/p/demo.v21.backup.fp.json');
  });

  it('copies the exact older bytes aside before migrating, and opens the migrated project', async () => {
    const path = join(dir, 'demo.fp.json');
    const original = v21Text();
    await writeFile(path, original, 'utf8');
    const project = await readProjectFile(path, { backupBeforeMigration: true });
    expect(project.timeline.tracks[0]!.clips[0]!.masks?.[0]?.kind).toBe('ellipse');
    expect(await readFile(join(dir, 'demo.v21.backup.fp.json'), 'utf8')).toBe(original);
  });

  it('never overwrites an earlier backup, so it keeps the file as it first was', async () => {
    const path = join(dir, 'demo.fp.json');
    const backup = join(dir, 'demo.v21.backup.fp.json');
    await writeFile(backup, 'the first copy', 'utf8');
    await writeFile(path, v21Text(), 'utf8');
    await readProjectFile(path, { backupBeforeMigration: true });
    expect(await readFile(backup, 'utf8')).toBe('the first copy');
  });

  it('writes no backup for a current file or when the caller did not ask', async () => {
    const current = join(dir, 'current.fp.json');
    await writeProjectFile(current, sampleProject());
    await readProjectFile(current, { backupBeforeMigration: true });
    const older = join(dir, 'older.fp.json');
    await writeFile(older, v21Text(), 'utf8');
    await readProjectFile(older);
    expect((await readdir(dir)).filter((name) => name.includes('backup'))).toEqual([]);
  });

  it('refuses a newer project format without writing anything', async () => {
    const path = join(dir, 'future.fp.json');
    await writeFile(
      path,
      JSON.stringify({ ...sampleProject(), schemaVersion: SCHEMA_VERSION + 1 }),
      'utf8',
    );
    await expect(readProjectFile(path, { backupBeforeMigration: true })).rejects.toThrow(
      /^Update FramePilot to open this project\./,
    );
    expect((await readdir(dir)).sort()).toEqual(['future.fp.json']);
  });
});
