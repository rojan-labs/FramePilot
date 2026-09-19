/**
 * The monitor's transform-track reader (MK7.1): the export's refusal order (missing → digest →
 * parse → method), and `ensure`, which the monitor awaits before presenting a seek so a tracked
 * mask is drawn from its first frame (found in E2E.3: nothing read tracks at all).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MaskLayerSchema, type MaskLayer } from '@framepilot/timeline-schema';
import { TrackSource } from './track-source.js';

const DOCUMENT = {
  version: 1,
  method: 'perspective',
  timeBase: [1, 15360],
  originPts: 0,
  firstFrame: 0,
  pts: [0, 512],
  transforms: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 3, 0, 1, 0.5, 0, 0, 1],
  confidence: [0.95, 0.9],
};
const TEXT = `${JSON.stringify(DOCUMENT)}\n`;
const BYTES = new TextEncoder().encode(TEXT);
const SHA = createHash('sha256').update(TEXT).digest('hex');
const KEY = 'a'.repeat(64);

function tracked(method = 'perspective', sha256 = SHA): MaskLayer {
  return MaskLayerSchema.parse({
    id: 'm',
    kind: 'rectangle',
    cx: 10,
    cy: 10,
    width: 4,
    height: 4,
    tracking: {
      artifact: { key: KEY, sha256 },
      method,
      referenceSourceTime: 0,
      constraints: [],
      review: { flagged: [], approved: [], locked: [] },
    },
  });
}

const source = (bytes: Uint8Array | null) =>
  new TrackSource(
    (key) => `file:///${key}`,
    async () => bytes,
  );

describe('TrackSource', () => {
  it('is pending until ensure resolves, then ready with the parsed track', async () => {
    const tracks = source(BYTES);
    expect(tracks.lookup(tracked()).state).toBe('pending');
    await tracks.ensure([tracked()]);
    const found = tracks.lookup(tracked());
    expect(found.state).toBe('ready');
    expect(found.state === 'ready' && found.artifact.method).toBe('perspective');
  });

  it('refuses in the export order: missing, then digest, then method', async () => {
    const missing = source(null);
    await missing.ensure([tracked()]);
    expect(missing.lookup(tracked())).toEqual({ state: 'refused', code: 'track_missing' });

    const tampered = source(BYTES);
    await tampered.ensure([tracked('perspective', 'f'.repeat(64))]);
    expect(tampered.lookup(tracked())).toEqual({ state: 'refused', code: 'track_digest_mismatch' });

    const other = source(BYTES);
    await other.ensure([tracked()]);
    expect(other.lookup(tracked('position'))).toEqual({
      state: 'refused',
      code: 'track_method_mismatch',
    });
  });

  it('says a host without artifacts cannot preview a track, instead of drawing it untracked', async () => {
    const nowhere = new TrackSource(() => null);
    await nowhere.ensure([tracked()]);
    expect(nowhere.lookup(tracked())).toEqual({ state: 'refused', code: 'track_unavailable' });
  });

  it('ignores untracked masks and joins a load already in flight', async () => {
    let fetches = 0;
    const tracks = new TrackSource(
      (key) => `file:///${key}`,
      async () => {
        fetches += 1;
        return BYTES;
      },
    );
    const untracked = MaskLayerSchema.parse({
      id: 'u',
      kind: 'ellipse',
      cx: 1,
      cy: 1,
      rx: 1,
      ry: 1,
    });
    await Promise.all([tracks.ensure([tracked(), untracked]), tracks.ensure([tracked()])]);
    expect(fetches).toBe(1);
  });
});
