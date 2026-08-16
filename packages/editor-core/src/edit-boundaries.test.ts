/**
 * Tests for edit-boundary detection and transition eligibility (ADR 0076).
 *
 * The failure these exist to prevent: `add_transition` used to accept any pair
 * of clip ids, so asking for a transition "at the narrative pivot" — a moment
 * inside a continuous clip, where there is no cut — applied cleanly, reported
 * success, and rendered nothing. So the assertions here are about what is
 * *refused*, and about whether the refusal explains itself well enough for the
 * caller to do something else.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, Clip, Timeline } from '@framepilot/timeline-schema';
import { applyOperation, OperationError, type Operation } from './operations.js';
import {
  listEditBoundaries,
  readTransitionAt,
  transitionEligibility,
} from './edit-boundaries.js';

const clip = (over: Partial<Clip> & Pick<Clip, 'id'>): Clip => ({
  assetId: 'asset_1',
  trackId: 'video_1',
  start: 0,
  end: 10,
  sourceStart: 0,
  sourceEnd: 10,
  effects: [],
  keyframes: [],
  ...over,
});

/** Two clips butted at t=10, each with 5s of handle on both sides. */
const cutTimeline = (): Timeline => ({
  tracks: [
    {
      id: 'video_1',
      type: 'video',
      clips: [
        clip({ id: 'a', start: 0, end: 10, sourceStart: 5, sourceEnd: 15 }),
        clip({ id: 'b', start: 10, end: 20, sourceStart: 40, sourceEnd: 50 }),
      ],
    },
  ],
});

/** One continuous clip — no cut anywhere in it. */
const continuousTimeline = (): Timeline => ({
  tracks: [
    { id: 'video_1', type: 'video', clips: [clip({ id: 'solo', start: 0, end: 30, sourceEnd: 30 })] },
  ],
});

const assets: readonly Asset[] = [{ id: 'asset_1', path: '/a.mp4', kind: 'video', durationSeconds: 120 }];

describe('listEditBoundaries', () => {
  it('finds the cut where two clips meet', () => {
    const boundaries = listEditBoundaries(cutTimeline(), assets);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({ at: 10, fromClipId: 'a', toClipId: 'b' });
  });

  it('finds no boundary inside a continuous clip', () => {
    // The case that used to accept a transition and render nothing.
    expect(listEditBoundaries(continuousTimeline(), assets)).toEqual([]);
  });

  it('does not treat a gap as a cut', () => {
    const gapped: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip({ id: 'a', start: 0, end: 10 }), clip({ id: 'b', start: 12, end: 20 })],
        },
      ],
    };
    expect(listEditBoundaries(gapped, assets)).toEqual([]);
  });

  it('measures handles from the source in/out points and the asset duration', () => {
    const [boundary] = listEditBoundaries(cutTimeline(), assets);
    // "a" ends at source 15 of a 120s asset ⇒ 105s of tail available.
    expect(boundary!.outgoingHandle).toBe(105);
    // "b" starts at source 40 ⇒ 40s available before its in-point.
    expect(boundary!.incomingHandle).toBe(40);
    // Capped by half the shorter clip (both 10s) ⇒ 5s — by the CLIPS, not the
    // handles, because this renderer borrows nothing from beyond the cut.
    expect(boundary!.maxTransitionSeconds).toBe(5);
  });

  it('reports an unbounded tail handle when the asset duration is unknown', () => {
    // Honest "as far as we can tell" beats a guess of zero, which would refuse
    // every transition on a project whose assets were never probed.
    const [boundary] = listEditBoundaries(cutTimeline());
    expect(boundary!.outgoingHandle).toBe(Number.POSITIVE_INFINITY);
  });

  it('ignores caption and overlay tracks, which cannot carry a transition', () => {
    const withCaptions: Timeline = {
      tracks: [
        ...cutTimeline().tracks,
        {
          id: 'caption_1',
          type: 'caption',
          clips: [
            clip({ id: 'c1', trackId: 'caption_1', start: 0, end: 2, sourceEnd: 2 }),
            clip({ id: 'c2', trackId: 'caption_1', start: 2, end: 4, sourceEnd: 2 }),
          ],
        },
      ],
    };
    expect(listEditBoundaries(withCaptions, assets).map((b) => b.trackId)).toEqual(['video_1']);
  });
});

describe('transitionEligibility', () => {
  it('accepts a blend at a real cut with handles on both sides', () => {
    const verdict = transitionEligibility(
      cutTimeline(),
      { fromClipId: 'a', toClipId: 'b', durationSeconds: 1, kind: 'cross-dissolve' },
      assets,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.durationSeconds).toBe(1);
  });

  it('refuses a transition where there is no cut, and says why', () => {
    const verdict = transitionEligibility(
      continuousTimeline(),
      { fromClipId: 'solo', toClipId: 'solo', durationSeconds: 1, kind: 'cross-dissolve' },
      assets,
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe('not_adjacent');
  });

  it('refuses a transition across a real gap, and reports its size', () => {
    const gapped: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [clip({ id: 'a', start: 0, end: 10 }), clip({ id: 'b', start: 15, end: 20 })],
        },
      ],
    };
    const verdict = transitionEligibility(
      gapped,
      { fromClipId: 'a', toClipId: 'b', durationSeconds: 1, kind: 'cross-dissolve' },
      assets,
    );
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe('not_adjacent');
    expect(!verdict.ok && verdict.detail).toMatch(/a 5s gap separates them/);
  });

  it('reports an unmeasurable gap as "∞s" rather than a nonsensical number', () => {
    // A clip whose start cannot be expressed as a finite offset (hand-edited or
    // corrupted project JSON) must still produce a readable message, not NaN or
    // "Infinitys".
    const wild: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({ id: 'a', start: 0, end: 10 }),
            clip({ id: 'b', start: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY }),
          ],
        },
      ],
    };
    const verdict = transitionEligibility(
      wild,
      { fromClipId: 'a', toClipId: 'b', durationSeconds: 1 },
      assets,
    );
    expect(!verdict.ok && verdict.reason).toBe('not_adjacent');
    expect(!verdict.ok && verdict.detail).toMatch(/a ∞s gap separates them/);
  });

  it('refuses clips on different tracks', () => {
    const twoTracks: Timeline = {
      tracks: [
        { id: 'video_1', type: 'video', clips: [clip({ id: 'a' })] },
        { id: 'video_2', type: 'video', clips: [clip({ id: 'b', trackId: 'video_2', start: 10, end: 20 })] },
      ],
    };
    const verdict = transitionEligibility(
      twoTracks,
      { fromClipId: 'a', toClipId: 'b', durationSeconds: 1 },
      assets,
    );
    expect(!verdict.ok && verdict.reason).toBe('different_tracks');
  });

  it('refuses a reversed pair', () => {
    const verdict = transitionEligibility(
      cutTimeline(),
      { fromClipId: 'b', toClipId: 'a', durationSeconds: 1 },
      assets,
    );
    expect(!verdict.ok && verdict.reason).toBe('wrong_order');
  });

  it('refuses a clip id that is not on the timeline', () => {
    const verdict = transitionEligibility(
      cutTimeline(),
      { fromClipId: 'a', toClipId: 'ghost', durationSeconds: 1 },
      assets,
    );
    expect(!verdict.ok && verdict.reason).toBe('no_such_clip');
  });

  it('refuses a fromClipId that is not on the timeline', () => {
    // Mirrors the toClipId case above: either half of the pair can be the ghost,
    // and the error must name whichever one actually is.
    const verdict = transitionEligibility(
      cutTimeline(),
      { fromClipId: 'ghost', toClipId: 'b', durationSeconds: 1 },
      assets,
    );
    expect(!verdict.ok && verdict.reason).toBe('no_such_clip');
    expect(!verdict.ok && verdict.detail).toMatch(/"ghost"/);
  });

  it('accepts a dissolve at a cut with no handles — this engine needs none', () => {
    // Both clips start at source 0, so there is nothing beyond the cut to
    // borrow. That gates a transition in a conforming NLE but not here: the
    // renderer ramps the INCOMING clip's own first seconds, which composites as
    // a fade-from-black when the clips are sequential
    // (engine/python/framepilot_engine/render/transitions.py). Refusing this
    // would reject transitions the engine renders perfectly well.
    const noHandles: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({ id: 'a', start: 0, end: 10, sourceStart: 0, sourceEnd: 10 }),
            clip({ id: 'b', start: 10, end: 20, sourceStart: 0, sourceEnd: 10 }),
          ],
        },
      ],
    };
    for (const kind of ['cross-dissolve', 'fade', 'wipe', 'push'] as const) {
      const verdict = transitionEligibility(
        noHandles,
        { fromClipId: 'a', toClipId: 'b', durationSeconds: 1, kind },
        assets,
      );
      expect(verdict.ok, `${kind} should be eligible`).toBe(true);
    }
  });

  it('still reports handle availability, so callers can say what it will look like', () => {
    // Not a gate, but the difference between "blends two shots" and "fades
    // through black" — worth knowing before promising a look.
    const [blended] = listEditBoundaries(cutTimeline(), assets);
    expect(blended!.incomingHandle).toBeGreaterThan(0);
  });

  it('refuses a transition on clips too short to carry one', () => {
    const tiny: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({ id: 'a', start: 0, end: 0.0000001, sourceStart: 0, sourceEnd: 0.0000001 }),
            clip({
              id: 'b',
              start: 0.0000001,
              end: 0.0000002,
              sourceStart: 0,
              sourceEnd: 0.0000001,
            }),
          ],
        },
      ],
    };
    const verdict = transitionEligibility(
      tiny,
      { fromClipId: 'a', toClipId: 'b', durationSeconds: 1 },
      assets,
    );
    expect(!verdict.ok && verdict.reason).toBe('clip_too_short');
  });

  it('clamps an over-long request rather than refusing it', () => {
    // The editor asked for a dissolve here; a shorter one is what the footage
    // supports, so the honest answer is the shorter dissolve plus a note.
    const verdict = transitionEligibility(
      cutTimeline(),
      { fromClipId: 'a', toClipId: 'b', durationSeconds: 30, kind: 'cross-dissolve' },
      assets,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.durationSeconds).toBe(5);
    expect(verdict.ok && verdict.clampedFrom).toBe(30);
  });

  it('explains every rejection in terms an editor can act on', () => {
    const verdict = transitionEligibility(
      continuousTimeline(),
      { fromClipId: 'solo', toClipId: 'solo', durationSeconds: 1 },
      assets,
    );
    // Not a stack trace, not a code — something a person can read and respond to.
    expect(!verdict.ok && verdict.detail).toMatch(/cut|gap|overlap/i);
  });
});

describe('add_transition enforcement', () => {
  const op = (over: Partial<Extract<Operation, { type: 'add_transition' }>> = {}): Operation => ({
    type: 'add_transition',
    trackId: 'video_1',
    fromClipId: 'a',
    toClipId: 'b',
    kind: 'cross-dissolve',
    durationSeconds: 1,
    ...over,
  });

  it('applies at a real boundary', () => {
    const after = applyOperation(cutTimeline(), op());
    expect(readTransitionAt(after, { trackId: 'video_1', toClipId: 'b' })).toMatchObject({
      kind: 'cross-dissolve',
      durationSeconds: 1,
      fromClipId: 'a',
    });
  });

  it('throws rather than silently succeeding where there is no cut', () => {
    // The whole point: an operation that cannot render must not return "applied".
    expect(() =>
      applyOperation(continuousTimeline(), op({ fromClipId: 'solo', toClipId: 'solo' })),
    ).toThrow(OperationError);
  });

  it('throws for a clip that does not exist', () => {
    expect(() => applyOperation(cutTimeline(), op({ toClipId: 'ghost' }))).toThrow(
      /No media clip/,
    );
  });

  it('does not bump the timeline revision — a transition moves no footage', () => {
    expect(applyOperation(cutTimeline(), op()).revision).toBeUndefined();
  });
});

describe('readTransitionAt', () => {
  it('returns null when nothing was applied', () => {
    expect(readTransitionAt(cutTimeline(), { trackId: 'video_1', toClipId: 'b' })).toBeNull();
  });

  it('returns null for a track that does not exist', () => {
    expect(readTransitionAt(cutTimeline(), { trackId: 'ghost', toClipId: 'b' })).toBeNull();
  });

  it('reads back what was actually committed, not what was requested', () => {
    // "The operation returned success" is not evidence; this is.
    const after = applyOperation(cutTimeline(), {
      type: 'add_transition',
      trackId: 'video_1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'wipe',
      durationSeconds: 2,
    });
    expect(readTransitionAt(after, { trackId: 'video_1', toClipId: 'b' })?.kind).toBe('wipe');
  });

  it('falls back to safe defaults when effect params are malformed', () => {
    // `params` is an untyped record (schema v12), so hand-edited or corrupted
    // project JSON can put anything there. readTransitionAt must not crash or
    // lie about the type of a field it cannot trust.
    const malformed: Timeline = {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            clip({
              id: 'b',
              effects: [
                {
                  id: 'b__transition',
                  type: 'transition',
                  params: { kind: 123, durationSeconds: 'two', fromClipId: 999 },
                  keyframes: [],
                },
              ],
            }),
          ],
        },
      ],
    };
    expect(readTransitionAt(malformed, { trackId: 'video_1', toClipId: 'b' })).toEqual({
      kind: 'unknown',
      durationSeconds: 0,
      fromClipId: '',
    });
  });
});
