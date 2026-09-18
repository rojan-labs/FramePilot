/**
 * What export must say about background removal (BR6.6).
 *
 * The count is read from the project rather than from a job, so it is still right after a reopen,
 * and "nothing behind this clip" follows the compositor's own z-order rather than a guess.
 */
import { describe, expect, it } from 'vitest';
import { MaskLayerSchema, type Timeline } from '@framepilot/timeline-schema';
import {
  hasPictureBehind,
  matteAssetIds,
  uncheckedMattes,
  uncheckedMomentCount,
} from './matteReview.js';

const KEY = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

const matte = (flagged: { start: number; end: number }[], over: Record<string, unknown> = {}) =>
  MaskLayerSchema.parse({
    id: 'm1',
    kind: 'matte',
    artifact: {
      key: KEY,
      files: [{ name: 'matte.mkv', sha256: SHA }],
      width: 64,
      height: 36,
      coverage: { sourceStart: 0, sourceEnd: 4 },
      packId: 'p',
      packVersion: '1',
      modelDigests: [SHA],
    },
    review: { flagged, approved: [], locked: [] },
    ...over,
  });

const clip = (id: string, trackId: string, masks: unknown[] = []) => ({
  id,
  assetId: `asset-${id}`,
  trackId,
  start: 0,
  end: 4,
  sourceStart: 0,
  sourceEnd: 4,
  effects: [],
  keyframes: [],
  ...(masks.length > 0 ? { masks } : {}),
});

const timeline = (tracks: unknown[]): Timeline => ({ revision: 1, tracks }) as unknown as Timeline;

describe('uncheckedMattes', () => {
  it('counts the moments nobody has looked at, per clip', () => {
    const tl = timeline([
      {
        id: 'v1',
        type: 'video',
        clips: [
          clip('c1', 'v1', [
            matte([
              { start: 1, end: 1.5 },
              { start: 3, end: 3.2 },
            ]),
          ]),
          clip('c2', 'v1', [matte([])]),
        ],
      },
    ]);
    expect(uncheckedMattes(tl)).toEqual([{ clipId: 'c1', maskId: 'm1', moments: 2 }]);
    expect(uncheckedMomentCount(tl)).toBe(2);
  });

  it('ignores a matte the editor turned off', () => {
    const tl = timeline([
      {
        id: 'v1',
        type: 'video',
        clips: [clip('c1', 'v1', [matte([{ start: 1, end: 1.5 }], { enabled: false })])],
      },
    ]);
    expect(uncheckedMattes(tl)).toEqual([]);
  });

  it('lists the assets worth re-checking before an export', () => {
    const tl = timeline([
      { id: 'v1', type: 'video', clips: [clip('c1', 'v1', [matte([])]), clip('c2', 'v1')] },
    ]);
    expect(matteAssetIds(tl)).toEqual(['asset-c1']);
  });
});

describe('hasPictureBehind', () => {
  it('is false when the cut-out is the only picture, so the removed area exports as black', () => {
    const tl = timeline([{ id: 'v1', type: 'video', clips: [clip('c1', 'v1', [matte([])])] }]);
    expect(hasPictureBehind(tl, 'c1')).toBe(false);
  });

  it('follows the compositor order: tracks[0] is the FRONT, so behind is later in the list', () => {
    const tl = timeline([
      { id: 'v2', type: 'video', clips: [clip('c1', 'v2', [matte([])])] },
      { id: 'v1', type: 'video', clips: [clip('c0', 'v1')] },
    ]);
    expect(hasPictureBehind(tl, 'c1')).toBe(true);
    expect(hasPictureBehind(tl, 'c0')).toBe(false);
  });

  it('does not count audio under the clip as something to see', () => {
    const tl = timeline([
      { id: 'v1', type: 'video', clips: [clip('c1', 'v1', [matte([])])] },
      { id: 'a1', type: 'audio', clips: [clip('c9', 'a1')] },
    ]);
    expect(hasPictureBehind(tl, 'c1')).toBe(false);
  });
});
