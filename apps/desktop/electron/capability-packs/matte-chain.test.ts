/**
 * BR4.12 M1: nothing in the matte store is listed, hashed, read or deleted through a symlinked
 * parent, at any level of `<project>/.framepilot-derived/mattes/{.inputs,.staging,.results,<key>}`.
 */
import { mkdir, mkdtemp, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeGrayPng } from './matte-png.js';
import { existingRealDirectory } from './matte-staging.js';
import { sweepMatteStaging } from './matte-staging.js';
import { cleanUnusedMattes, matteStorageSummary } from './matte-storage.js';
import { readMatteInput, readMatteRecord } from './matte-store.js';
import { validateProjectMattes } from './matte-validation.js';

const KEY = 'a'.repeat(64);

/** A real store tree built OUTSIDE the project, then linked in at `level`. */
async function linkedStore(level: 'derived' | 'mattes' | 'inputs' | 'staging' | 'results' | 'artifact') {
  const project = await mkdtemp(path.join(tmpdir(), 'framepilot-chain-project-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'framepilot-chain-outside-'));
  const png = encodeGrayPng(2, 2, new Uint8Array(4));
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(png).digest('hex');
  // What the outside tree holds at each level: something valuable a follower would touch.
  const build = async (root: string, parts: readonly string[]) => {
    const base = path.join(root, ...parts);
    await mkdir(path.join(base, KEY), { recursive: true });
    await writeFile(path.join(base, KEY, 'matte.mkv'), 'precious');
    await writeFile(path.join(base, KEY, 'frames.json'), '{}');
    await mkdir(path.join(base, '.inputs'), { recursive: true });
    await writeFile(path.join(base, '.inputs', `${sha}.png`), png);
    await mkdir(path.join(base, '.staging', 'orphan'), { recursive: true });
    await mkdir(path.join(base, '.results'), { recursive: true });
    await writeFile(path.join(base, '.results', `${KEY}.json`), '{}');
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    await utimes(path.join(base, '.staging', 'orphan'), old, old);
  };
  const derived = path.join(project, '.framepilot-derived');
  const mattes = path.join(derived, 'mattes');
  if (level === 'derived') {
    await build(outside, ['mattes']);
    await symlink(outside, derived);
  } else if (level === 'mattes') {
    await mkdir(derived);
    await build(outside, []);
    await symlink(outside, mattes);
  } else {
    await build(project, ['.framepilot-derived', 'mattes']);
    const name = { inputs: '.inputs', staging: '.staging', results: '.results', artifact: KEY }[level];
    await build(outside, []);
    const target = { inputs: '.inputs', staging: '.staging', results: '.results', artifact: KEY }[level];
    const { rm } = await import('node:fs/promises');
    await rm(path.join(mattes, name), { recursive: true, force: true });
    await symlink(path.join(outside, target), path.join(mattes, name));
  }
  const projectJson = {
    timeline: { tracks: [{ clips: [{ id: 'c', masks: [{ id: 'm', kind: 'matte', decontaminate: false, artifact: { key: KEY, files: [{ name: 'matte.mkv', sha256: 'b'.repeat(64) }, { name: 'frames.json', sha256: 'c'.repeat(64) }], width: 2, height: 2 } }] }] }] },
  };
  return { project, outside, sha, projectJson };
}

async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      out.push(`${rel}${entry.name}`);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
    }
  };
  await walk(root, '');
  return out.sort();
}

describe.each(['derived', 'mattes', 'inputs', 'staging', 'results', 'artifact'] as const)('a symlinked %s level', (level) => {
  it('is never listed, read, hashed or deleted through', async () => {
    const { project, outside, sha, projectJson } = await linkedStore(level);
    const before = await snapshot(outside);

    if (level === 'derived' || level === 'mattes' || level === 'inputs' || level === 'staging') {
      await expect(matteStorageSummary(project, projectJson)).rejects.toMatchObject({ code: 'unsafe_path' });
      await expect(cleanUnusedMattes(project, {}, [KEY, sha])).rejects.toMatchObject({ code: 'unsafe_path' });
      if (level === 'derived' || level === 'mattes') {
        await expect(existingRealDirectory(project, ['.framepilot-derived', 'mattes'])).rejects.toMatchObject({ code: 'unsafe_path' });
      }
    } else {
      const summary = await matteStorageSummary(project, {});
      if (level === 'artifact') expect(summary.artifacts.map((item) => item.key)).toEqual([]);
      const cleaned = await cleanUnusedMattes(project, {}, [KEY, sha]).catch((error: unknown) => error);
      expect(cleaned).toBeDefined();
    }
    expect(await sweepMatteStaging(project, { now: new Date(), activeJobIds: new Set() })).toBe(level === 'derived' || level === 'mattes' || level === 'staging' ? 0 : 1);
    if (level !== 'artifact' && level !== 'staging' && level !== 'results') {
      await expect(readMatteInput(project, sha)).rejects.toMatchObject({ code: 'input_missing' });
    }
    if (level !== 'inputs' && level !== 'staging' && level !== 'artifact') {
      expect(await readMatteRecord(project, KEY)).toBeUndefined();
    }
    if (level !== 'inputs' && level !== 'staging' && level !== 'results') {
      expect((await validateProjectMattes(project, projectJson, { mode: 'full' })).map((issue) => issue.code)).toEqual(['matte_missing']);
    }
    expect(await snapshot(outside)).toEqual(before);
  });
});
