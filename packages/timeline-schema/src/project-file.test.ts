/**
 * Tests for atomic project.fp.json file IO (PLAN §1.1).
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
