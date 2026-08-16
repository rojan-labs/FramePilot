/**
 * The two-clip storage model and the one ramp that runs across it.
 *
 * The property worth protecting here is that `start` alignment is *bit-for-bit*
 * what the engine did before alignment existed — a single effect on the incoming
 * clip with no `alignment` key — because that is what makes every project made
 * before this feature render identically.
 */
import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import { applyOperation } from './operations.js';
import { validatePatch } from './validator.js';
import {
  DEFAULT_TRANSITION_ALIGNMENT,
  TRANSITION_EFFECT_TYPE,
  TRANSITION_OUT_EFFECT_TYPE,
  clipTransitionEffect,
  clipTransitionOutEffect,
  readAlignment,
  transitionEffectId,
  transitionOutEffectId,
  transitionProgressAt,
  transitionWindow,
} from './transitions.js';

const timeline = (): Timeline => ({
  duration: 8,
  tracks: [
    {
      id: 'v1',
      type: 'video',
      clips: [
        {
          id: 'a',
          assetId: 'asset-1',
          start: 0,
          end: 4,
          sourceStart: 0,
          sourceEnd: 4,
          effects: [],
          keyframes: [],
        },
        {
          id: 'b',
          assetId: 'asset-1',
          start: 4,
          end: 8,
          sourceStart: 4,
          sourceEnd: 8,
          effects: [],
          keyframes: [],
        },
      ],
    },
  ],
});

const add = (alignment?: 'start' | 'centre' | 'end', kind = 'cross-dissolve'): Timeline =>
  applyOperation(timeline(), {
    type: 'add_transition',
    trackId: 'v1',
    fromClipId: 'a',
    toClipId: 'b',
    kind,
    durationSeconds: 1,
    ...(alignment ? { alignment } : {}),
  });

const clip = (t: Timeline, id: string) => t.tracks[0]!.clips.find((c) => c.id === id)!;

describe('transitionWindow', () => {
  it('puts the whole ramp after the cut by default', () => {
    expect(transitionWindow('start', 1)).toEqual({ inSeconds: 1, outSeconds: 0 });
  });

  it('splits evenly for centre and puts it all before the cut for end', () => {
    expect(transitionWindow('centre', 1)).toEqual({ inSeconds: 0.5, outSeconds: 0.5 });
    expect(transitionWindow('end', 1)).toEqual({ inSeconds: 0, outSeconds: 1 });
  });

  it('never returns a negative window for a nonsense duration', () => {
    expect(transitionWindow('centre', -4)).toEqual({ inSeconds: 0, outSeconds: 0 });
  });
});

describe('readAlignment', () => {
  it('falls back to the historical placement for absent or unreadable values', () => {
    expect(readAlignment({})).toBe(DEFAULT_TRANSITION_ALIGNMENT);
    expect(readAlignment({ alignment: 'sideways' })).toBe('start');
    expect(readAlignment({ alignment: 7 })).toBe('start');
  });

  it('reads the three it knows', () => {
    expect(readAlignment({ alignment: 'centre' })).toBe('centre');
    expect(readAlignment({ alignment: 'end' })).toBe('end');
  });
});

describe('transitionProgressAt', () => {
  const params = (alignment: string) => ({ durationSeconds: 1, alignment });

  it('runs 0 → 1 over the incoming clip when start-aligned', () => {
    expect(transitionProgressAt('in', 0, params('start'), 4)).toBe(0);
    expect(transitionProgressAt('in', 0.5, params('start'), 4)).toBeCloseTo(0.5);
    expect(transitionProgressAt('in', 1, params('start'), 4)).toBeNull();
    // Nothing happens on the outgoing clip — the pre-alignment behaviour.
    expect(transitionProgressAt('out', 3.9, params('start'), 4)).toBeNull();
  });

  it('hands the ramp from the outgoing clip to the incoming one at the cut', () => {
    // Outgoing clip is 4s; a centred 1s transition owns its last 0.5s.
    expect(transitionProgressAt('out', 3.5, params('centre'), 4)).toBeCloseTo(0);
    expect(transitionProgressAt('out', 3.75, params('centre'), 4)).toBeCloseTo(0.25);
    expect(transitionProgressAt('out', 3.4, params('centre'), 4)).toBeNull();
    // …and picks up at exactly halfway on the incoming clip. No jump, no repeat.
    expect(transitionProgressAt('in', 0, params('centre'), 4)).toBeCloseTo(0.5);
    expect(transitionProgressAt('in', 0.49, params('centre'), 4)).toBeCloseTo(0.99);
    expect(transitionProgressAt('in', 0.5, params('centre'), 4)).toBeNull();
  });

  it('keeps the whole ramp on the outgoing clip when end-aligned', () => {
    expect(transitionProgressAt('out', 3, params('end'), 4)).toBeCloseTo(0);
    expect(transitionProgressAt('out', 3.5, params('end'), 4)).toBeCloseTo(0.5);
    expect(transitionProgressAt('in', 0, params('end'), 4)).toBeNull();
  });

  it('is inert for a duration that is missing, zero or unreadable', () => {
    expect(transitionProgressAt('in', 0, {}, 4)).toBeNull();
    expect(transitionProgressAt('in', 0, { durationSeconds: 0 }, 4)).toBeNull();
    expect(transitionProgressAt('in', 0, { durationSeconds: 'half' }, 4)).toBeNull();
  });
});

describe('add_transition storage', () => {
  it('writes one effect and no alignment key when start-aligned', () => {
    const after = add();
    const effect = clipTransitionEffect(clip(after, 'b'));
    expect(effect?.id).toBe(transitionEffectId('b'));
    expect(effect?.params).toEqual({
      kind: 'cross-dissolve',
      durationSeconds: 1,
      fromClipId: 'a',
    });
    expect(clipTransitionOutEffect(clip(after, 'a'))).toBeUndefined();
  });

  it('defaults to start when alignment is omitted, explicitly and implicitly alike', () => {
    expect(JSON.stringify(add())).toBe(JSON.stringify(add('start')));
  });

  it('writes the outgoing half for centre and end', () => {
    for (const alignment of ['centre', 'end'] as const) {
      const after = add(alignment);
      const out = clipTransitionOutEffect(clip(after, 'a'));
      expect(out?.id).toBe(transitionOutEffectId('a'));
      expect(out?.type).toBe(TRANSITION_OUT_EFFECT_TYPE);
      expect(out?.params).toMatchObject({ alignment, toClipId: 'b', durationSeconds: 1 });
      const incoming = clipTransitionEffect(clip(after, 'b'));
      expect(incoming?.type).toBe(TRANSITION_EFFECT_TYPE);
      expect(incoming?.params.alignment).toBe(alignment);
    }
  });

  it('removes the outgoing half when a transition is re-aligned back to start', () => {
    // The failure this guards: re-aligning leaves an orphan `transition_out` that
    // keeps fading the outgoing clip out for a transition that no longer has a
    // pre-cut half.
    const centred = add('centre');
    const restarted = applyOperation(centred, {
      type: 'add_transition',
      trackId: 'v1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'cross-dissolve',
      durationSeconds: 1,
      alignment: 'start',
    });
    expect(clipTransitionOutEffect(clip(restarted, 'a'))).toBeUndefined();
  });

  it('replaces rather than stacks when the same cut is re-issued', () => {
    const twice = applyOperation(add('centre'), {
      type: 'add_transition',
      trackId: 'v1',
      fromClipId: 'a',
      toClipId: 'b',
      kind: 'glitch',
      durationSeconds: 0.5,
      alignment: 'centre',
    });
    expect(clip(twice, 'b').effects.filter((e) => e.type === TRANSITION_EFFECT_TYPE)).toHaveLength(
      1,
    );
    expect(
      clip(twice, 'a').effects.filter((e) => e.type === TRANSITION_OUT_EFFECT_TYPE),
    ).toHaveLength(1);
    expect(clipTransitionEffect(clip(twice, 'b'))?.params.kind).toBe('glitch');
  });

  it('accepts every catalog kind, and refuses one it does not know', () => {
    expect(() => add('start', 'kaleidoscope')).not.toThrow();
    expect(() => add('start', 'teleport')).toThrow(/not a transition this build knows/);
  });
});

describe('the validator on a half-written transition', () => {
  /**
   * Validate a harmless patch against `source`, so only the post-apply STATE
   * checks fire. The op targets an effect that really is there and changes
   * nothing, which is the cheapest way to ask "is this timeline legal?".
   */
  const issuesFor = (source: Timeline): readonly string[] => {
    const clip = source.tracks[0]!.clips.find((c) => c.effects.length > 0)!;
    return validatePatch(source, {
      patchId: 'p',
      createdBy: 'user',
      reason: 'check',
      operations: [
        {
          type: 'set_effect_params',
          clipId: clip.id,
          effectId: clip.effects[0]!.id,
          params: {},
        },
      ],
    }).issues.map((issue) => issue.message);
  };

  const withOutHalfOnly = (): Timeline => {
    const base = timeline();
    const track = base.tracks[0]!;
    return {
      ...base,
      tracks: [
        {
          ...track,
          clips: track.clips.map((c) =>
            c.id === 'a'
              ? {
                  ...c,
                  effects: [
                    {
                      id: transitionOutEffectId('a'),
                      type: TRANSITION_OUT_EFFECT_TYPE,
                      params: { kind: 'fade', durationSeconds: 1, toClipId: 'b' },
                      keyframes: [],
                    },
                  ],
                }
              : c,
          ),
        },
      ],
    };
  };

  it('refuses an outgoing half with no transition after it', () => {
    // On its own it ramps a clip's tail away at what is now a hard cut, with
    // nothing selectable to explain why.
    expect(issuesFor(withOutHalfOnly()).join(' ')).toMatch(/no matching transition/);
  });

  it('refuses two halves that disagree about how long the transition is', () => {
    const paired = add('centre');
    const track = paired.tracks[0]!;
    const drifted: Timeline = {
      ...paired,
      tracks: [
        {
          ...track,
          clips: track.clips.map((c) =>
            c.id === 'a'
              ? {
                  ...c,
                  effects: c.effects.map((e) =>
                    e.type === TRANSITION_OUT_EFFECT_TYPE
                      ? { ...e, params: { ...e.params, durationSeconds: 0.25 } }
                      : e,
                  ),
                }
              : c,
          ),
        },
      ],
    };
    expect(issuesFor(drifted).join(' ')).toMatch(/disagree on duration/);
  });

  it('accepts a properly paired transition', () => {
    expect(issuesFor(add('centre'))).toEqual([]);
  });
});
