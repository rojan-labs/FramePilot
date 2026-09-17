/** BR4.12 re-review: a relinked asset whose matte has no host record is STALE, not skipped. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { constantRateTiming, fakeMatteInspector } from './__fixtures__/fake-matte-worker.js';
import { recheckProjectMatteMedia } from './matte-media-recheck.js';

const KEY = 'f'.repeat(64);

describe('re-check without a record', () => {
  it('marks every matte on the relinked asset STALE, and leaves other assets alone', async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), 'framepilot-norecord-'));
    await mkdir(path.join(projectDir, '.framepilot-derived', 'mattes', KEY), { recursive: true });
    const media = path.join(projectDir, 'shot.mov');
    await writeFile(media, 'bytes');
    const mask = { id: 'm1', kind: 'matte', artifact: { key: KEY } };
    const project = {
      assets: [
        { id: 'relinked', path: media },
        { id: 'other', path: media },
      ],
      timeline: {
        tracks: [
          {
            clips: [
              { id: 'c1', assetId: 'relinked', masks: [mask] },
              { id: 'c2', assetId: 'other', masks: [{ ...mask, id: 'm2' }] },
            ],
          },
        ],
      },
    };
    const inspector = fakeMatteInspector(new Map([[media, { timing: constantRateTiming(10) }]]));
    const issues = await recheckProjectMatteMedia(projectDir, project, inspector, { assetIds: ['relinked'] });
    expect(issues).toEqual([expect.objectContaining({ clipId: 'c1', maskId: 'm1', code: 'matte_media_changed', status: 'stale' })]);
  });
});
