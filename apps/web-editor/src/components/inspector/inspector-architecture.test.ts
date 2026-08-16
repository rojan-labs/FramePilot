/**
 * The inspector's architecture (revamp Phase 4, F6) — selection model, section
 * registry and mixed values, all pure.
 *
 * These are the cases that make the decomposition worth doing: they assert the
 * *rules* about which sections apply and how a multi-selection reads, which used to
 * be inline `if`s inside a 1,049-line render and were therefore untestable.
 */
import { describe, expect, it } from 'vitest';
import type { Timeline } from '@framepilot/timeline-schema';
import {
  INSPECTOR_SECTIONS,
  sectionById,
  visibleSections,
  type InspectorSectionDef,
} from './registry.js';
import { hasClipSelection, resolveInspectorSelection } from './selection.js';
import { MIXED_INDICATOR, mixedNumberValue, mixedText, sharedFrom, sharedValue } from './mixed.js';

const clip = (
  id: string,
  start: number,
  end: number,
  trackId = 'v',
  extra: Record<string, unknown> = {},
) => ({
  id,
  assetId: 'a',
  trackId,
  start,
  end,
  sourceStart: 0,
  sourceEnd: end - start,
  effects: [],
  keyframes: [],
  ...extra,
});

const videoTimeline: Timeline = {
  tracks: [{ id: 'v', type: 'video', clips: [clip('c1', 0, 4), clip('c2', 4, 8)] }],
};

/** A caption track carries no audio, so the Audio section must not apply. */
const captionTimeline: Timeline = {
  tracks: [{ id: 'cap', type: 'caption', clips: [clip('t1', 0, 4, 'cap')] }],
};

const textTimeline: Timeline = {
  tracks: [
    {
      id: 'v',
      type: 'video',
      clips: [
        clip('c1', 0, 4, 'v', {
          effects: [{ id: 'e1', type: 'text', params: { text: 'hi' }, keyframes: [] }],
        }),
        clip('c2', 4, 8),
      ],
    },
  ],
};

describe('resolveInspectorSelection', () => {
  it('is "none" with nothing selected', () => {
    const selection = resolveInspectorSelection(videoTimeline, null, []);
    expect(selection.kind).toBe('none');
    expect(selection.primary).toBeNull();
    expect(hasClipSelection(selection)).toBe(false);
  });

  it('is "clip" for one clip', () => {
    const selection = resolveInspectorSelection(videoTimeline, 'c1', ['c1']);
    expect(selection.kind).toBe('clip');
    expect(selection.primary?.clip.id).toBe('c1');
    expect(selection.primary?.track.id).toBe('v');
    expect(hasClipSelection(selection)).toBe(true);
  });

  it('is "multi-clip" for several, PRIMARY FIRST', () => {
    // `selectedIds` order is not primary order: shift-clicking a second clip leaves
    // the first primary, and single-value controls must keep editing that one.
    const selection = resolveInspectorSelection(videoTimeline, 'c2', ['c1', 'c2']);
    expect(selection.kind).toBe('multi-clip');
    expect(selection.clips.map((location) => location.clip.id)).toEqual(['c2', 'c1']);
    expect(selection.primary?.clip.id).toBe('c2');
  });

  it('ignores ids that are not on the timeline', () => {
    const selection = resolveInspectorSelection(videoTimeline, 'gone', ['gone']);
    expect(selection.kind).toBe('none');
  });

  it('drops missing ids but keeps the real ones', () => {
    const selection = resolveInspectorSelection(videoTimeline, 'c1', ['c1', 'ghost']);
    expect(selection.kind).toBe('clip');
    expect(selection.clips.length).toBe(1);
  });

  it('lets an EFFECT LAYER outrank any clip selection', () => {
    // The layer was the last thing clicked and its controls are what the user is
    // reaching for; it is also not attached to a clip, so it must be editable with
    // nothing selected — which is the normal case.
    const withLayer: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [clip('c1', 0, 4)],
          effectLayers: [{ id: 'fx1', kind: 'blur', start: 0, end: 4, params: {}, keyframes: [] }],
        } as never,
      ],
    };
    const selection = resolveInspectorSelection(withLayer, 'c1', ['c1'], ['fx1']);
    expect(selection.kind).toBe('effect-layer');
    expect(selection.effectLayer?.layer.id).toBe('fx1');
    // No clip leaks through — the clip sections must not render alongside.
    expect(selection.primary).toBeNull();
  });

  it('falls back to the clip when the effect layer id is stale', () => {
    const selection = resolveInspectorSelection(videoTimeline, 'c1', ['c1'], ['gone']);
    expect(selection.kind).toBe('clip');
  });

  it('reports hasAudio from the TRACK, not the clip', () => {
    expect(resolveInspectorSelection(videoTimeline, 'c1', ['c1']).hasAudio).toBe(true);
    expect(resolveInspectorSelection(captionTimeline, 't1', ['t1']).hasAudio).toBe(false);
  });

  it('requires EVERY selected clip to have text, not just one', () => {
    // A section only some of the selection can accept would silently no-op on the
    // rest, which is worse than not offering it.
    expect(resolveInspectorSelection(textTimeline, 'c1', ['c1']).hasText).toBe(true);
    expect(resolveInspectorSelection(textTimeline, 'c1', ['c1', 'c2']).hasText).toBe(false);
  });

  it('reports a transition on the primary clip', () => {
    const withTransition: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            clip('c1', 0, 4),
            clip('c2', 4, 8, 'v', {
              effects: [{ id: 'tr', type: 'transition', params: { kind: 'fade' }, keyframes: [] }],
            }),
          ],
        },
      ],
    };
    expect(resolveInspectorSelection(withTransition, 'c2', ['c2']).hasTransition).toBe(true);
    expect(resolveInspectorSelection(withTransition, 'c1', ['c1']).hasTransition).toBe(false);
  });
});

describe('the section registry', () => {
  it('has unique ids and unique orders', () => {
    // Ids are PERSISTED (they key the collapse preference), and a duplicate order
    // makes display position depend on array order — the thing `order` exists to
    // stop mattering.
    const ids = INSPECTOR_SECTIONS.map((section) => section.id);
    const orders = INSPECTOR_SECTIONS.map((section) => section.order);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('shows nothing at all when nothing is selected', () => {
    const selection = resolveInspectorSelection(videoTimeline, null, []);
    expect(visibleSections(selection)).toEqual([]);
  });

  it('sorts by `order`, not by array position', () => {
    // The contract that lets a section be appended at the bottom of the file with
    // `order: 15` and still land where it says.
    const selection = resolveInspectorSelection(videoTimeline, 'c1', ['c1']);
    const orders = visibleSections(selection).map((section) => section.order);
    expect([...orders]).toEqual([...orders].sort((a, b) => a - b));
  });

  it('gates Audio on an audio-bearing track', () => {
    const video = resolveInspectorSelection(videoTimeline, 'c1', ['c1']);
    const caption = resolveInspectorSelection(captionTimeline, 't1', ['t1']);
    expect(visibleSections(video).map((s) => s.id)).toContain('audio');
    expect(visibleSections(caption).map((s) => s.id)).not.toContain('audio');
  });

  it('gates Text on the clip actually having text', () => {
    const withText = resolveInspectorSelection(textTimeline, 'c1', ['c1']);
    const without = resolveInspectorSelection(videoTimeline, 'c1', ['c1']);
    expect(visibleSections(withText).map((s) => s.id)).toContain('text');
    expect(visibleSections(without).map((s) => s.id)).not.toContain('text');
  });

  it('shows Transition exactly when the PRIMARY clip has one', () => {
    // Revamp Phase 9 replaced the old `kind === 'clip'` rule. It hid the section for
    // any multi-selection, on the reasoning that "the transition" is ambiguous across
    // several clips — but Phase 4's primary-first rule already resolves that (the
    // panel edits the primary, like every other single-value control), and the old
    // rule made "apply to selected cuts" unreachable: the section vanished the
    // instant you selected the cuts you wanted to apply to.
    const withTransition: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            clip('c1', 0, 4),
            {
              ...clip('c2', 4, 8),
              effects: [
                {
                  id: 'c2__transition',
                  type: 'transition',
                  params: { kind: 'fade', durationSeconds: 0.5, fromClipId: 'c1' },
                  keyframes: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const primaryHasOne = resolveInspectorSelection(withTransition, 'c2', ['c1', 'c2']);
    const primaryHasNone = resolveInspectorSelection(withTransition, 'c1', ['c1', 'c2']);
    expect(visibleSections(primaryHasOne).map((s) => s.id)).toContain('transition');
    expect(visibleSections(primaryHasNone).map((s) => s.id)).not.toContain('transition');
    // And a clip with no transition no longer grows an empty section to open.
    const plain = resolveInspectorSelection(videoTimeline, 'c1', ['c1']);
    expect(visibleSections(plain).map((s) => s.id)).not.toContain('transition');
  });

  it('shows no clip sections for an effect-layer selection', () => {
    const withLayer: Timeline = {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [clip('c1', 0, 4)],
          effectLayers: [{ id: 'fx1', kind: 'blur', start: 0, end: 4, params: {}, keyframes: [] }],
        } as never,
      ],
    };
    const selection = resolveInspectorSelection(withLayer, 'c1', ['c1'], ['fx1']);
    expect(visibleSections(selection)).toEqual([]);
  });

  it('respects a caller-supplied section list', () => {
    const custom: InspectorSectionDef[] = [
      { id: 'x', title: 'X', label: 'x', order: 2, defaultOpen: true, appliesTo: () => true },
      { id: 'y', title: 'Y', label: 'y', order: 1, defaultOpen: false, appliesTo: () => false },
    ];
    const selection = resolveInspectorSelection(videoTimeline, 'c1', ['c1']);
    expect(visibleSections(selection, custom).map((s) => s.id)).toEqual(['x']);
  });

  it('looks a section up by id, and reports an unknown one as missing', () => {
    expect(sectionById('transform')?.title).toBe('Position & size');
    expect(sectionById('nope')).toBeUndefined();
  });
});

describe('mixed values', () => {
  it('is shared when every value agrees', () => {
    expect(sharedValue([2, 2, 2])).toEqual({ mixed: false, value: 2 });
    expect(sharedValue(['a'])).toEqual({ mixed: false, value: 'a' });
  });

  it('is mixed as soon as one differs', () => {
    expect(sharedValue([2, 2, 3])).toEqual({ mixed: true });
  });

  it('treats an EMPTY selection as mixed rather than inventing a value', () => {
    expect(sharedValue([])).toEqual({ mixed: true });
  });

  it('compares with Object.is, so NaN equals NaN', () => {
    // A NaN in a numeric field is a corrupt project, but two of them are still the
    // same fact — reporting "mixed" would send the user hunting for a difference.
    expect(sharedValue([Number.NaN, Number.NaN])).toEqual({ mixed: false, value: Number.NaN });
    expect(sharedValue([0, -0])).toEqual({ mixed: true });
  });

  it('reads a property off each item', () => {
    const items = [{ v: 1 }, { v: 1 }];
    expect(sharedFrom(items, (item) => item.v)).toEqual({ mixed: false, value: 1 });
    expect(sharedFrom([{ v: 1 }, { v: 2 }], (item) => item.v)).toEqual({ mixed: true });
  });

  it('seeds a control with a usable number even when mixed', () => {
    // The field SHOWS the em-dash, but a scrub gesture has to start somewhere, and
    // starting at a plausible default beats starting at NaN.
    expect(mixedNumberValue({ mixed: false, value: 3 }, 1)).toBe(3);
    expect(mixedNumberValue({ mixed: true }, 1)).toBe(1);
  });

  it('renders the em-dash for a mixed value', () => {
    expect(mixedText({ mixed: false, value: 2 }, (v) => `${v}x`)).toBe('2x');
    expect(mixedText({ mixed: true }, (v) => `${v}x`)).toBe(MIXED_INDICATOR);
    expect(MIXED_INDICATOR).toBe('—');
  });
});
