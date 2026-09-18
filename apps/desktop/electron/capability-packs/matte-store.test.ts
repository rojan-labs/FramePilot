import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { constantRateTiming } from './__fixtures__/fake-matte-worker.js';
import { encodeGrayPng } from './matte-png.js';
import {
  matteRecordPath,
  readMatteInput,
  readMatteRecord,
  saveMatteInput,
  sourceContentFingerprint,
  writeMatteRecord,
} from './matte-store.js';

const project = () => mkdtemp(path.join(tmpdir(), 'framepilot-matte-store-'));

describe('matte project store (MD-4)', () => {
  it('stores a valid correction by digest, idempotently, and reads it back verified', async () => {
    const dir = await project();
    const png = encodeGrayPng(4, 2, Uint8Array.from([0, 128, 255, 128, 0, 0, 255, 255]));
    const saved = await saveMatteInput(dir, png, { width: 4, height: 2, kind: 'brush' });
    expect(await saveMatteInput(dir, png, { width: 4, height: 2, kind: 'brush' })).toEqual(saved);
    expect(await readdir(path.join(dir, '.framepilot-derived', 'mattes', '.inputs'))).toEqual([`${saved.sha256}.png`]);
    expect((await readMatteInput(dir, saved.sha256)).image.width).toBe(4);
  });

  it('accepts an edge brush (64) and refuses the values beside it (BR6.10)', async () => {
    const dir = await project();
    const edge = encodeGrayPng(4, 2, Uint8Array.from([64, 64, 128, 128, 255, 0, 64, 128]));
    const saved = await saveMatteInput(dir, edge, { width: 4, height: 2, kind: 'brush' });
    expect([...(await readMatteInput(dir, saved.sha256)).image.pixels]).toEqual([64, 64, 128, 128, 255, 0, 64, 128]);
    // An antialiased edge stroke (63, 65) is not a fourth value; it fails the whole save.
    for (const near of [63, 65, 127, 129, 1, 254]) {
      const png = encodeGrayPng(4, 2, Uint8Array.from([64, near, 128, 128, 128, 128, 128, 128]));
      await expect(saveMatteInput(dir, png, { width: 4, height: 2, kind: 'brush' }), String(near)).rejects.toMatchObject({
        code: 'invalid_brush',
      });
    }
  });

  it('refuses the wrong size, non-brush values, non-PNG bytes and tampered or escaping references', async () => {
    const dir = await project();
    const png = encodeGrayPng(4, 2, new Uint8Array(8).fill(7));
    await expect(saveMatteInput(dir, png, { width: 4, height: 3, kind: 'lock' })).rejects.toMatchObject({ code: 'wrong_size' });
    await expect(saveMatteInput(dir, png, { width: 4, height: 2, kind: 'brush' })).rejects.toMatchObject({ code: 'invalid_brush' });
    await expect(saveMatteInput(dir, Buffer.from('<svg/>'), { width: 4, height: 2, kind: 'lock' })).rejects.toMatchObject({ code: 'invalid_png' });
    const saved = await saveMatteInput(dir, png, { width: 4, height: 2, kind: 'lock' });
    await writeFile(path.join(dir, '.framepilot-derived', 'mattes', '.inputs', `${saved.sha256}.png`), encodeGrayPng(4, 2, new Uint8Array(8)));
    await expect(readMatteInput(dir, saved.sha256)).rejects.toMatchObject({ code: 'input_corrupt' });
    for (const reference of ['../../../etc/passwd', 'f'.repeat(64)]) {
      await expect(readMatteInput(dir, reference)).rejects.toMatchObject({ code: 'input_missing' });
    }
  });

  it('writes records atomically and treats a malformed or mismatched record as a miss', async () => {
    const dir = await project();
    const key = 'a'.repeat(64);
    const record = {
      version: 1 as const,
      key,
      assetId: 'asset-1',
      files: [
        { name: 'matte.mkv' as const, bytes: 1, sha256: 'b'.repeat(64) },
        { name: 'frames.json' as const, bytes: 1, sha256: 'c'.repeat(64) },
      ],
      width: 4,
      height: 2,
      coverage: { sourceStart: 0, sourceEnd: 1 },
      packId: 'framepilot.smart-mask',
      packVersion: '1.0.0',
      modelDigests: [],
      executionProvider: 'cpu' as const,
      summary: { verifiedFrames: 1, flaggedFrames: 0, lockedFrames: 0, selfCorrectionRounds: 0 },
      lockedPts: [],
      needsReview: [],
      contentFingerprint: 'd'.repeat(64),
      sourceSamples: [],
      createdAt: '2026-09-17T00:00:00.000Z',
    };
    await writeMatteRecord(dir, record);
    expect(await readMatteRecord(dir, key)).toEqual(record);
    expect(await readMatteRecord(dir, '../x')).toBeUndefined();
    await writeFile(matteRecordPath(dir, key), JSON.stringify({ ...record, key: 'e'.repeat(64) }));
    expect(await readMatteRecord(dir, key)).toBeUndefined();
  });

  it('fingerprints content: a changed byte or a changed timing changes it', async () => {
    const dir = await project();
    const file = path.join(dir, 'shot.mp4');
    await writeFile(file, Buffer.alloc(1024, 1));
    const timing = constantRateTiming(10);
    const first = await sourceContentFingerprint(file, timing);
    expect(await sourceContentFingerprint(file, timing)).toBe(first);
    expect(await sourceContentFingerprint(file, constantRateTiming(11))).not.toBe(first);
    const changed = Buffer.alloc(1024, 1);
    changed[1000] = 2;
    await writeFile(file, changed);
    expect(await sourceContentFingerprint(file, timing)).not.toBe(first);
  });
});
