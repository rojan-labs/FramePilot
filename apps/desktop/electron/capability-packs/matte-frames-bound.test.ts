/** BR4.12 L4: frames.json is bounded by its frame count and not re-parsed at project open. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { framesJsonByteBound, readMatteFrames } from './matte-verify.js';

describe('frames.json byte bound', () => {
  it('fits an honest document and refuses a padded one before reading it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'framepilot-frames-bound-'));
    const pts = Array.from({ length: 1000 }, (_, index) => 4_503_599_627_370_000 + index);
    const honest = JSON.stringify({ version: 1, timeBase: [1, 15360], originPts: 0, firstFrame: 0, pts });
    expect(Buffer.byteLength(honest)).toBeLessThan(framesJsonByteBound(1000));
    await writeFile(path.join(dir, 'frames.json'), honest);
    expect((await readMatteFrames(dir, framesJsonByteBound(1000))).pts).toHaveLength(1000);
    await writeFile(path.join(dir, 'frames.json'), honest.replace('"pts"', `${' '.repeat(40_000)}"pts"`));
    await expect(readMatteFrames(dir, framesJsonByteBound(1000))).rejects.toMatchObject({ code: 'frames_invalid' });
    expect(framesJsonByteBound(Number.POSITIVE_INFINITY)).toBe(64 * 1024 * 1024);
  });
});
