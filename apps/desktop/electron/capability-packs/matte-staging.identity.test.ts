/** BR4.12: the pre-rename re-check compares inode and mtime, not only size. */
import { lstat, rename, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { commitMatteStaging, createMatteStaging } from './matte-staging.js';

const KEY = 'd'.repeat(64);

async function staged() {
  const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-identity-'));
  const staging = await createMatteStaging(dir, 'job');
  const file = path.join(staging.directory, 'matte.mkv');
  await writeFile(file, 'alpha');
  const stat = await lstat(file);
  return { dir, staging, file, verified: [{ name: 'matte.mkv', bytes: 5, ino: stat.ino, mtimeMs: stat.mtimeMs }] };
}

describe('commit identity re-check', () => {
  it('refuses a same-size file swapped in by rename (new inode)', async () => {
    const { dir, staging, file, verified } = await staged();
    const replacement = path.join(staging.directory, 'swap.tmp');
    await writeFile(replacement, 'omega');
    await rename(replacement, file);
    await expect(commitMatteStaging(dir, staging, KEY, verified)).rejects.toMatchObject({ code: 'changed_after_verify' });
  });

  it('refuses a same-size rewrite in place (new mtime)', async () => {
    const { dir, staging, file, verified } = await staged();
    await writeFile(file, 'omega');
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    await expect(commitMatteStaging(dir, staging, KEY, verified)).rejects.toMatchObject({ code: 'changed_after_verify' });
  });

  it('commits when nothing changed', async () => {
    const { dir, staging, verified } = await staged();
    expect(await commitMatteStaging(dir, staging, KEY, verified)).toBe('committed');
  });
});
