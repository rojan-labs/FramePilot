import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCapabilityPackRootKeys } from './config.js';

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-pack-config-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('loadCapabilityPackRootKeys', () => {
  it('loads a bounded public-only embedded root list', async () => {
    const root = await createRoot();
    const file = path.join(root, 'keys.json');
    const keys = [{ keyId: 'framepilot.offline.2026', publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${'a'.repeat(80)}\n-----END PUBLIC KEY-----` }];
    await writeFile(file, JSON.stringify(keys), 'utf8');
    expect(await loadCapabilityPackRootKeys(file)).toEqual(keys);
  });

  it('returns unavailable for an omitted or missing optional build resource', async () => {
    const root = await createRoot();
    expect(await loadCapabilityPackRootKeys(undefined)).toEqual([]);
    expect(await loadCapabilityPackRootKeys(path.join(root, 'missing.json'))).toEqual([]);
  });

  it('rejects duplicate, malformed, or oversized trust input', async () => {
    const root = await createRoot();
    const file = path.join(root, 'keys.json');
    const key = { keyId: 'framepilot.offline.2026', publicKeyPem: 'a'.repeat(80) };
    await writeFile(file, JSON.stringify([key, key]), 'utf8');
    await expect(loadCapabilityPackRootKeys(file)).rejects.toThrow('duplicate');
    await writeFile(file, JSON.stringify([{ keyId: '../bad', publicKeyPem: 'a'.repeat(80) }]), 'utf8');
    await expect(loadCapabilityPackRootKeys(file)).rejects.toThrow('invalid');
  });
});
