/**
 * What the suggestion shelf offers, and why.
 *
 * The property worth protecting is that every suggestion is derived from the
 * TIMELINE and carries a reason. A shelf whose picks cannot be explained stops
 * being trusted the first time one is wrong, and a shelf that depends on an
 * analysis pass appears and disappears for reasons the user cannot see.
 */
import { describe, expect, it } from 'vitest';
import type { Clip, Timeline } from '@framepilot/timeline-schema';
import { recommendTransitions } from './transition-recommendations.js';

const clip = (id: string, start: number, end: number, overrides: Partial<Clip> = {}): Clip => ({
  id,
  assetId: 'a1',
  trackId: 'v',
  start,
  end,
  sourceStart: start,
  sourceEnd: end,
  effects: [],
  keyframes: [],
  ...overrides,
});

const lane = (clips: Clip[]): Timeline => ({ tracks: [{ id: 'v', type: 'video', clips }] });

const ids = (timeline: Timeline, toClipId: string, images = new Set<string>()): string[] =>
  recommendTransitions(timeline, toClipId, images).map((s) => s.transition.id);

describe('recommendTransitions', () => {
  it('says nothing when there is no cut to treat', () => {
    expect(recommendTransitions(lane([clip('a', 0, 4)]), 'a')).toEqual([]);
    expect(recommendTransitions(lane([clip('a', 0, 4)]), 'ghost')).toEqual([]);
  });

  it('gives every suggestion a reason', () => {
    for (const suggestion of recommendTransitions(lane([clip('a', 0, 4), clip('b', 4, 8)]), 'b')) {
      expect(suggestion.reason.length).toBeGreaterThan(15);
    }
  });

  it('never repeats a transition', () => {
    const list = ids(lane([clip('a', 0, 1), clip('b', 1, 2)]), 'b');
    expect(new Set(list).size).toBe(list.length);
  });

  it('recognises two halves of one shot before anything else', () => {
    // Same asset, continuous source range: the user split a take, and the right
    // transition there is one nobody notices.
    const timeline = lane([
      clip('a', 0, 4, { sourceStart: 0, sourceEnd: 4 }),
      clip('b', 4, 8, { sourceStart: 4, sourceEnd: 8 }),
    ]);
    expect(ids(timeline, 'b')[0]).toBe('smooth-zoom');
    expect(recommendTransitions(timeline, 'b')[0]?.reason).toContain('one shot');
  });

  it('matches the transition on the neighbouring cut', () => {
    const timeline = lane([
      clip('a', 0, 2, { assetId: 'a1' }),
      clip('b', 2, 4, {
        assetId: 'a2',
        effects: [
          {
            id: 'b__transition',
            type: 'transition',
            params: { kind: 'glitch', durationSeconds: 0.3, fromClipId: 'a' },
            keyframes: [],
          },
        ],
      }),
      clip('c', 4, 6, { assetId: 'a3' }),
    ]);
    expect(ids(timeline, 'c')).toContain('glitch');
  });

  it('suggests a fast transition between two short shots', () => {
    const quick = ids(
      lane([clip('a', 0, 1, { assetId: 'x' }), clip('b', 1, 2, { assetId: 'y' })]),
      'b',
    );
    expect(quick).toContain('punch-zoom');
    expect(quick).not.toContain('soft-dissolve');
  });

  it('suggests a slow one between two long shots', () => {
    const slow = ids(
      lane([clip('a', 0, 6, { assetId: 'x' }), clip('b', 6, 12, { assetId: 'y' })]),
      'b',
    );
    expect(slow).toContain('soft-dissolve');
    expect(slow).not.toContain('punch-zoom');
  });

  it('treats two stills differently from two shots', () => {
    const timeline = lane([
      clip('a', 0, 3, { assetId: 'img1' }),
      clip('b', 3, 6, { assetId: 'img2' }),
    ]);
    expect(ids(timeline, 'b', new Set(['img1', 'img2']))).toContain('luma-fade');
    // Without being told they are stills it does not guess.
    expect(ids(timeline, 'b')).not.toContain('luma-fade');
  });

  it('offers a fade out on the last cut of the sequence', () => {
    const timeline = lane([clip('a', 0, 3, { assetId: 'x' }), clip('b', 3, 6, { assetId: 'y' })]);
    expect(ids(timeline, 'b')).toContain('fade-to-black');
  });

  it('always has something to say, and never more than asked for', () => {
    const list = recommendTransitions(
      lane([clip('a', 0, 3, { assetId: 'x' }), clip('b', 3, 6, { assetId: 'y' })]),
      'b',
      new Set(),
      3,
    );
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThanOrEqual(3);
  });
});
