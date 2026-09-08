/**
 * VU2.5 — the existing reads return facts.
 *
 * The point of each assertion here is that a tool's payload now answers a question the run
 * previously had to spend a `get_frame` on, AND that it says nothing when nothing is known:
 * an unmeasured project must not come back looking like a uniformly average one.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { LedgerSnapshot, MeasuredFacts, ShotRecord } from '../ledger.js';
import type { ToolContext } from '../tool-context.js';
import { TOOL_REGISTRY } from '../tool-registry.js';
import { pacingOf, pictureBlockFor, pictureOf } from './picture-facts.js';

// --- fixtures ---------------------------------------------------------------

function project(): Project {
  return parseProject({
    id: 'picture_facts',
    name: 'Picture facts fixture',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'a', path: 'a.mp4', kind: 'video', durationSeconds: 20 },
      { id: 'b', path: 'b.mp4', kind: 'video', durationSeconds: 20 },
    ],
    timeline: {
      revision: 3,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'a',
              trackId: 'v1',
              start: 0,
              end: 4,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
            {
              id: 'c2',
              assetId: 'b',
              trackId: 'v1',
              start: 4,
              end: 10,
              sourceStart: 0,
              sourceEnd: 6,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

const measured = (over: Partial<MeasuredFacts> = {}): MeasuredFacts => ({
  tier0Version: 1,
  luma: { mean: 0.5, std: 0.1, p10: 0.2, p90: 0.8 },
  chroma: { uMean: 128, vMean: 128, satMean: 0.3 },
  warmth: 0,
  contrastIdx: 0.6,
  motion: { si: 40, ti: 8, class: 'static' },
  cutScore: 0.3,
  black: false,
  freeze: false,
  sharpness: 0.8,
  phash: '0000000000000000',
  ...over,
});

const shot = (
  assetId: string,
  shotIndex: number,
  t0: number,
  t1: number,
  over: Partial<ShotRecord> = {},
): ShotRecord => ({
  assetId,
  contentHash: 'hash_1',
  shotIndex,
  t0,
  t1,
  keyframeT: (t0 + t1) / 2,
  splitOf: false,
  measured: measured(),
  ...over,
});

const ledgerOf = (shots: ShotRecord[]): LedgerSnapshot => ({
  shots,
  digests: [],
  coverage: { measured: shots.length, labelled: 0, described: 0, total: shots.length },
});

function context(ledger?: LedgerSnapshot): ToolContext {
  const base = project();
  return { project: base, projectRevision: 3, ...(ledger === undefined ? {} : { ledger }) };
}

function read(name: string, args: Record<string, unknown>, ctx: ToolContext): unknown {
  const spec = TOOL_REGISTRY.find((tool) => tool.name === name);
  if (!spec?.read) throw new Error(`no read tool "${name}"`);
  return spec.read(args, ctx);
}

/** A ledger where the two shots differ enough to raise flags across the cut. */
function contrastingLedger(): LedgerSnapshot {
  return ledgerOf([
    shot('a', 0, 0, 4, {
      measured: measured({ luma: { mean: 0.7, std: 0.1, p10: 0.4, p90: 0.95 } }),
      labelled: {
        tier1Version: 1,
        model: 'siglip',
        shotSize: { value: 'WS', p: 0.9 },
        setting: { value: 'street', p: 0.9 },
        faces: 0,
        entities: [],
      },
    }),
    shot('b', 0, 0, 6, {
      measured: measured({ luma: { mean: 0.25, std: 0.1, p10: 0.05, p90: 0.5 } }),
      labelled: {
        tier1Version: 1,
        model: 'siglip',
        shotSize: { value: 'CU', p: 0.9 },
        setting: { value: 'office', p: 0.9 },
        faces: 1,
        entities: [{ id: 'person_01', kind: 'person', p: 0.8 }],
      },
      described: {
        tier2Version: 1,
        model: 'vlm',
        summary: 'a man at a desk, talking',
        subject: 'man',
        action: 'talking',
        setting: 'office',
        camera: { shotSize: 'CU', movement: 'static' },
        mood: 'calm',
        onScreenText: [],
        quality: [],
        p: 0.8,
      },
    }),
  ]);
}

// --- get_clip / get_clips ---------------------------------------------------

describe('get_clip / get_clips carry the picture block', () => {
  it('returns the dominant shot with each tier and its confidences intact', () => {
    const result = read('get_clip', { clipId: 'c2' }, context(contrastingLedger())) as {
      picture?: {
        dominant: {
          labelled: { shotSize: { value: string; p: number } } | null;
          described: { summary: string } | null;
          measured: { motion: string } | null;
          words: string;
        } | null;
        shots?: { start: number; end: number }[];
      };
    };
    expect(result.picture?.dominant?.labelled?.shotSize).toEqual({ value: 'CU', p: 0.9 });
    expect(result.picture?.dominant?.described?.summary).toBe('a man at a desk, talking');
    expect(result.picture?.dominant?.measured?.motion).toBe('static');
    expect(result.picture?.dominant?.words).not.toBe('');
    // The deep read carries the spans too, in TIMELINE seconds.
    expect(result.picture?.shots).toEqual([expect.objectContaining({ start: 4, end: 10 })]);
  });

  it('states which clock the block uses, on the block itself', () => {
    const result = read('get_clip', { clipId: 'c1' }, context(contrastingLedger())) as {
      picture: { timeBase: string; dominant: { assetStart: number; assetEnd: number } };
    };
    expect(result.picture.timeBase).toContain('timeline seconds');
    expect(result.picture.timeBase).toContain('asset seconds');
    expect(result.picture.dominant.assetStart).toBe(0);
    expect(result.picture.dominant.assetEnd).toBe(4);
  });

  it('omits the block entirely when nothing has measured the footage', () => {
    const listing = read('get_clips', {}, context()) as { clips: Record<string, unknown>[] };
    expect(listing.clips).toHaveLength(2);
    for (const row of listing.clips) expect(row).not.toHaveProperty('picture');
    const deep = read('get_clip', { clipId: 'c1' }, context());
    expect(deep).not.toHaveProperty('picture');
  });

  it('keeps the listing compact: the dominant shot, not every span', () => {
    const listing = read('get_clips', {}, context(contrastingLedger())) as {
      clips: { id: string; picture?: { shots?: unknown; shotCount: number } }[];
    };
    const row = listing.clips.find((clip) => clip.id === 'c2');
    expect(row?.picture?.shotCount).toBe(1);
    expect(row?.picture?.shots).toBeUndefined();
  });
});

// --- list_edit_boundaries ---------------------------------------------------

describe('list_edit_boundaries carries the cut delta and flags', () => {
  it('reports the measured delta, signed to − from, with the flags it raised', () => {
    const [boundary] = read('list_edit_boundaries', {}, context(contrastingLedger())) as {
      at: number;
      delta: { luma: number | null; sameSetting: boolean | null; shotSizeSteps: number | null };
      flags: string[];
    }[];
    expect(boundary?.at).toBe(4);
    // 0.25 − 0.7: the cut gets darker, so the delta is negative.
    expect(boundary?.delta.luma).toBeCloseTo(-0.45, 5);
    expect(boundary?.delta.sameSetting).toBe(false);
    // WS → CU is four steps tighter on the ladder, past the size_jump threshold of three.
    expect(boundary?.delta.shotSizeSteps).toBe(4);
    expect(boundary?.flags).toEqual(expect.arrayContaining(['exposure_jump', 'size_jump']));
  });

  it('leaves delta and flags off entirely when the cut has not been measured', () => {
    const [boundary] = read('list_edit_boundaries', {}, context()) as Record<string, unknown>[];
    expect(boundary).toBeDefined();
    expect(boundary).not.toHaveProperty('delta');
    expect(boundary).not.toHaveProperty('flags');
  });
});

// --- the helpers ------------------------------------------------------------

describe('pacing and the block helper', () => {
  it('reads pacing off the picture clips of one layer, ledger or no ledger', () => {
    // Clips of 4s and 6s: the median of an even list is the mean of the middle pair.
    expect(pacingOf(pictureOf(context()), 'v1')).toBe(5);
  });

  it('returns 0 for a layer with no picture, which the policy reads as unknown', () => {
    expect(pacingOf(pictureOf(context()), 'nope')).toBe(0);
  });

  it('has no block for a clip id that is not on the timeline', () => {
    expect(
      pictureBlockFor(pictureOf(context(contrastingLedger())), 'ghost', 'full'),
    ).toBeUndefined();
  });
});
