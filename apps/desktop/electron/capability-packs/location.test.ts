import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCapabilityPackLocation } from './location.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'framepilot-pack-location-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('FileCapabilityPackLocation', () => {
  it('uses the default until an atomic custom-root pointer is committed', async () => {
    const directory = await root();
    const config = path.join(directory, 'location.json');
    const fallback = path.join(directory, 'default-packs');
    const custom = path.join(directory, 'external', 'packs');
    const location = new FileCapabilityPackLocation(
      config,
      fallback,
      () => new Date('2026-08-13T00:00:00.000Z'),
    );

    expect(await location.resolve()).toEqual({ activeRoot: fallback });
    await location.commit(custom, fallback);
    expect(await location.resolve()).toEqual({ activeRoot: custom, previousRoot: fallback });
    expect(JSON.parse(await readFile(config, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      activeRoot: custom,
      previousRoot: fallback,
      committedAt: '2026-08-13T00:00:00.000Z',
    });
  });

  it('fails closed for corrupt or relative authority instead of silently orphaning packs', async () => {
    const directory = await root();
    const config = path.join(directory, 'location.json');
    const location = new FileCapabilityPackLocation(config, path.join(directory, 'default'));
    await writeFile(config, '{broken', 'utf8');
    await expect(location.resolve()).rejects.toThrow('storage location is invalid');
    await writeFile(config, JSON.stringify({
      schemaVersion: 1,
      activeRoot: 'relative/packs',
      committedAt: '2026-08-13T00:00:00.000Z',
    }), 'utf8');
    await expect(location.resolve()).rejects.toThrow('storage root must be absolute');
  });
});
