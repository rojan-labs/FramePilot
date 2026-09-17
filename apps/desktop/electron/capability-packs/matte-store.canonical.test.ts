/** BR4.12 L2: the stored correction is the canonical re-encode of its pixels, not the given bytes. */
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodeGrayPng, pngChunk } from './matte-png.js';
import { readMatteInput, saveMatteInput } from './matte-store.js';

describe('canonical correction storage', () => {
  it('stores and names the re-encode, so equal pixels in different encodings are one input', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-canonical-'));
    const pixels = Uint8Array.from([255, 255, 128, 0]);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(2, 4);
    header[8] = 8;
    // Same pixels, sub-filtered rows and maximum compression: different bytes.
    const alternative = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(Buffer.from([1, 255, 0, 1, 128, 128]), { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const canonical = encodeGrayPng(2, 2, pixels);
    expect(alternative.equals(canonical)).toBe(false);
    const first = await saveMatteInput(dir, alternative, { width: 2, height: 2, kind: 'brush' });
    const second = await saveMatteInput(dir, canonical, { width: 2, height: 2, kind: 'brush' });
    expect(first.sha256).toBe(second.sha256);
    const stored = await readMatteInput(dir, first.sha256);
    expect(stored.bytes.equals(canonical)).toBe(true);
    expect(
      (await readFile(path.join(dir, '.framepilot-derived', 'mattes', '.inputs', `${first.sha256}.png`))).equals(canonical),
    ).toBe(true);
    await expect(saveMatteInput(dir, encodeGrayPng(4, 4, new Uint8Array(16)), { width: 2, height: 2, kind: 'lock' })).rejects.toMatchObject({
      code: 'wrong_size',
    });
  });
});
