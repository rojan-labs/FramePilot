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
  MAX_PARSED_PROJECT_BYTES,
  readProjectFile,
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
