import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isStaleLock, writeLockOwner } from './installer.js';

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  lockPath: string;
  ownerPath: string;
  createdAt: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-pack-lock-'));
  roots.push(root);
  const lockPath = path.join(root, 'lock');
  await mkdir(lockPath);
  const ownerPath = path.join(lockPath, 'owner.json');
  const createdAt = new Date(Date.now() - 31 * 60 * 1_000).toISOString();
  return { root, lockPath, ownerPath, createdAt };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Capability Pack install lock ownership', () => {
  it('never classifies a live lock as stale while a heartbeat is atomically replaced', async () => {
    const { lockPath, ownerPath, createdAt } = await fixture();
    await writeLockOwner(ownerPath, createdAt);
    const staleDirectoryTime = new Date(Date.now() - 31 * 60 * 1_000);
    await utimes(lockPath, staleDirectoryTime, staleDirectoryTime);

    for (let index = 0; index < 32; index += 1) {
      const [, stale] = await Promise.all([
        writeLockOwner(ownerPath, createdAt),
        isStaleLock(lockPath, ownerPath),
      ]);
      expect(stale).toBe(false);
    }
  });

  it('fails closed for malformed fresh owner metadata even when the directory is old', async () => {
    const { lockPath, ownerPath } = await fixture();
    await writeFile(ownerPath, '{', 'utf8');
    const staleDirectoryTime = new Date(Date.now() - 31 * 60 * 1_000);
    await utimes(lockPath, staleDirectoryTime, staleDirectoryTime);

    expect(await isStaleLock(lockPath, ownerPath)).toBe(false);

    const staleOwnerTime = new Date(Date.now() - 31 * 60 * 1_000);
    await utimes(ownerPath, staleOwnerTime, staleOwnerTime);
    expect(await isStaleLock(lockPath, ownerPath)).toBe(true);
  });
});
