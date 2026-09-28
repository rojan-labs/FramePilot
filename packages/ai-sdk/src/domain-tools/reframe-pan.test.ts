/**
 * `reframe_pan` — a reframe that holds on, or pans across, a wider source.
 *
 * Run `6cb12e30`'s brief asked for "a slow pan across the 16:9 frame inside the 9:16 window"
 * on the aerials and for the window to follow its subjects; nothing could express a moving
 * reframe, and the run shipped static centre crops. The arithmetic is the render compiler's
 * own placement formula (`editor-core` `planAutomaticReframe`), so the numbers asserted here
 * are that formula's for a 1920×1080 source in a 1080×1920 frame:
 *
 *   fit = min(1080/1920, 1920/1080) = 0.5625
 *   cover = max(0.5625, 1.7778) / 0.5625 ≈ 3.1605
 *   rendered width = 1920 × 0.5625 × cover ≈ 3413.3 px
 *   x for a window centred at p = rendered width × (0.5 − p), clamped to ±1166.7 px
 */
import { describe, expect, it } from 'vitest';
import {
  applyProjectPatch,
  evaluateKeyframes,
  framePlanAt,
  invertPatch,
  type AnyOperation,
} from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';
import { makeProject } from '../__fixtures__/project.js';

const RENDERED_WIDTH = 1920 * 0.5625 * (1920 / 1080 / 0.5625);

const LANDSCAPE = { width: 1920, height: 1080 };

/** `media: null` = a source whose size was never probed. */
const vertical = (clipOver: Record<string, unknown> = {}, media: unknown = LANDSCAPE): Project =>
  makeProject({
    fps: 30,
    resolution: { width: 1080, height: 1920 },
    assets: [
      {
        id: 'aerial',
        path: 'media/aerial.mp4',
        kind: 'video',
        durationSeconds: 20,
        ...(media === null ? {} : { media }),
      },
    ],
    timeline: {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'shot',
              assetId: 'aerial',
              trackId: 'v1',
              start: 0,
              end: 4,
              sourceStart: 2,
              sourceEnd: 6,
              effects: [],
              keyframes: [],
              crop: { x: 0.341797, y: 0, width: 0.316406, height: 1 },
              ...clipOver,
            },
          ],
        },
      ],
    },
  } as never);

function pan(
  project: Project,
  args: Record<string, unknown>,
): { ops: AnyOperation[]; after: Project } {
  const tool = getTool('reframe_pan');
  if (!tool || tool.kind !== 'mutate') throw new Error('reframe_pan is not a mutate tool');
  const ops = tool.buildOps!({ clipId: 'shot', ...args }, { project }) as AnyOperation[];
  const edit = assembleEdit(project, ops, 'pan', 'agent');
  expect(edit.validation.valid).toBe(true);
  return { ops, after: applyProjectPatch(project, edit.patch) };
}

const keyframesOf = (project: Project, property: string) =>
  project.timeline.tracks[0]!.clips[0]!.keyframes.filter((k) => k.property === property);

describe('reframe_pan', () => {
  it('pans the window across the source, left to right, at the zoom that covers the frame', () => {
    const { after } = pan(vertical(), { from: { x: 0.2 }, to: { x: 0.8 } });
    const clip = after.timeline.tracks[0]!.clips[0]!;
    // The crop is replaced — the zoom and offset now do the reframing.
    expect(clip.crop).toBeUndefined();
    const scale = keyframesOf(after, 'scale');
    expect(scale.map((k) => k.value)).toEqual([
      expect.closeTo(3.1605, 3),
      expect.closeTo(3.1605, 3),
    ]);
    const x = keyframesOf(after, 'x');
    expect(x.map((k) => k.time)).toEqual([0, 4]);
    expect(x[0]!.value).toBeCloseTo(RENDERED_WIDTH * 0.3, 0);
    expect(x[1]!.value).toBeCloseTo(-RENDERED_WIDTH * 0.3, 0);
    expect(x[0]!.easing).toBe('ease-in-out');
  });

  it('fills the delivered frame at both ends of the pan — no bars', () => {
    const { after } = pan(vertical(), { from: { x: 0.1 }, to: { x: 0.9 } });
    for (const t of [0, 2, 3.9]) {
      const layer = framePlanAt(after.timeline, after.assets, t, after.resolution).layers[0]!;
      const { left, top, width, height } = layer.geometry!;
      // The picture is placed centred then offset; it must still cover 0…1080 × 0…1920.
      expect(left!).toBeLessThanOrEqual(0.5);
      expect(top!).toBeLessThanOrEqual(0.5);
      expect(left! + width!).toBeGreaterThanOrEqual(1079.5);
      expect(top! + height!).toBeGreaterThanOrEqual(1919.5);
    }
  });

  it('holds on one spot when there is nowhere to pan to', () => {
    const { after } = pan(vertical(), { from: { x: 0.25 } });
    const x = keyframesOf(after, 'x');
    expect(new Set(x.map((k) => Math.round(k.value)))).toEqual(
      new Set([Math.round(RENDERED_WIDTH * 0.25)]),
    );
  });

  it('clamps a window pushed past the edge rather than showing beyond the picture', () => {
    const { after } = pan(vertical(), { from: { x: 0 }, to: { x: 1 } });
    const limit = (RENDERED_WIDTH - 1080) / 2;
    const x = keyframesOf(after, 'x');
    expect(x[0]!.value).toBeCloseTo(limit, 0);
    expect(x[1]!.value).toBeCloseTo(-limit, 0);
  });

  it('replaces the x, y and scale keyframes it owns, and leaves the rest', () => {
    const { ops, after } = pan(
      vertical({
        keyframes: [
          { id: 'k1', time: 0, property: 'scale', value: 1, easing: 'linear' },
          { id: 'k2', time: 1, property: 'opacity', value: 1, easing: 'linear' },
        ],
      }),
      { from: { x: 0.5 }, to: { x: 0.6 } },
    );
    expect(ops.map((op) => op.type)).toEqual([
      'set_clip_crop',
      'remove_keyframes',
      'add_keyframes',
    ]);
    expect(keyframesOf(after, 'opacity')).toHaveLength(1);
    expect(keyframesOf(after, 'scale').every((k) => k.value > 3)).toBe(true);
  });

  it('refuses a source whose size was never measured, and one already the frame shape', () => {
    const tool = getTool('reframe_pan')!;
    expect(() =>
      tool.buildOps!({ clipId: 'shot', from: { x: 0.5 } }, { project: vertical({}, null) }),
    ).toThrow(/not been measured/);
    expect(() =>
      tool.buildOps!(
        { clipId: 'shot', from: { x: 0.5 } },
        { project: vertical({ crop: undefined }, { width: 1080, height: 1920 }) },
      ),
    ).toThrow(/already has the frame's shape/);
  });
});

/**
 * Issue #139: a punch-in on a panned clip. Run 4 of the travel brief stripped 22 pans by
 * hand (19 remove_keyframes, 31 set_clip_crop) before it could punch in, because a punch
 * wrote absolute scale 1.0 → 1.2 over the cover zoom and letterboxed the shot.
 */
describe('punch_in on a reframe_pan clip', () => {
  const COVER = 1920 / 1080 / 0.5625;

  function punch(project: Project, args: Record<string, unknown>) {
    const tool = getTool('punch_in');
    if (!tool || tool.kind !== 'mutate') throw new Error('punch_in is not a mutate tool');
    const ops = tool.buildOps!({ clipId: 'shot', ...args }, { project }) as AnyOperation[];
    const edit = assembleEdit(project, ops, 'punch', 'agent');
    expect(edit.validation.valid).toBe(true);
    return { ops, edit, after: applyProjectPatch(project, edit.patch) };
  }

  const scaleAt = (project: Project, t: number) =>
    evaluateKeyframes(project.timeline.tracks[0]!.clips[0]!.keyframes, 'scale', t)!;

  function expectCovers(project: Project, t: number): void {
    const layer = framePlanAt(project.timeline, project.assets, t, project.resolution).layers[0]!;
    const { left, top, width, height } = layer.geometry!;
    expect(left!).toBeLessThanOrEqual(0.5);
    expect(top!).toBeLessThanOrEqual(0.5);
    expect(left! + width!).toBeGreaterThanOrEqual(1079.5);
    expect(top! + height!).toBeGreaterThanOrEqual(1919.5);
  }

  it('pushes in on top of the cover zoom inside the window, keeps it outside, and keeps panning', () => {
    const { after: panned } = pan(vertical(), { from: { x: 0.1 }, to: { x: 0.9 } });
    const { ops, after } = punch(panned, { startTime: 1, endTime: 3, toScale: 1.3 });
    expect(ops.map((op) => op.type)).toEqual(['remove_keyframes', 'add_keyframes']);

    // Outside the window: the pan's cover before it, the held punch factor after it.
    expect(scaleAt(after, 0)).toBeCloseTo(COVER, 6);
    expect(scaleAt(after, 0.5)).toBeCloseTo(COVER, 6);
    expect(scaleAt(after, 3.5)).toBeCloseTo(COVER * 1.3, 6);
    // Inside: the pan's scale × the punch's own eased factor, not an absolute 1.0 → 1.3.
    const plainPunch = punchInFactor(1, 3, 1.3);
    for (const t of [1, 1.5, 2, 2.5, 3]) {
      expect(scaleAt(after, t)).toBeCloseTo(COVER * plainPunch(t), 6);
    }
    // The pan is untouched and still covers at every instant, zoomed or not.
    expect(keyframesOf(after, 'x')).toEqual(keyframesOf(panned, 'x'));
    expect(keyframesOf(after, 'y')).toEqual(keyframesOf(panned, 'y'));
    for (const t of [0, 0.5, 1, 1.7, 2, 2.9, 3.5, 3.9]) {
      expect(scaleAt(after, t)).toBeGreaterThanOrEqual(COVER - 1e-9);
      expectCovers(after, t);
    }
  });

  it("undo restores the pan's keyframes exactly", () => {
    const { after: panned } = pan(vertical(), { from: { x: 0.2 }, to: { x: 0.7 } });
    const { edit, after } = punch(panned, { startTime: 0.5, endTime: 2 });
    const inverse = invertPatch(panned.timeline, edit.patch);
    const undone = applyProjectPatch(after, inverse);
    expect(undone.timeline.tracks[0]!.clips[0]!.keyframes).toEqual(
      panned.timeline.tracks[0]!.clips[0]!.keyframes,
    );
  });

  it('compounds with an earlier punch, and leaves an unanimated clip with the plain punch', () => {
    const plain = vertical({ crop: undefined, keyframes: [] });
    const { ops: firstOps, after: once } = punch(plain, {});
    expect(firstOps.map((op) => op.type)).toEqual(['add_keyframes']);
    expect(keyframesOf(once, 'scale').map((k) => k.value)).toEqual([1, 1.2]);
    const { after: twice } = punch(once, {});
    expect(scaleAt(twice, 4)).toBeCloseTo(1.44, 9);
    expect(scaleAt(twice, 0)).toBeCloseTo(1, 9);
  });

  it('keeps the existing curve outside the window when it is itself animated', () => {
    // A linear 2 → 4 zoom across the clip; punch only the middle second.
    const ramp = vertical({
      crop: undefined,
      keyframes: [
        { id: 'a', time: 0, property: 'scale', value: 2, easing: 'linear' },
        { id: 'b', time: 4, property: 'scale', value: 4, easing: 'linear' },
      ],
    });
    const { after } = punch(ramp, { startTime: 1.5, endTime: 2.5, fromScale: 1, toScale: 1 });
    for (const t of [0, 0.75, 1.5, 2, 2.5, 3.25, 4]) {
      expect(scaleAt(after, t)).toBeCloseTo(2 + t / 2, 9);
    }
  });

  it('refuses a punch that would zoom a panned clip out below its cover, with the remedy', () => {
    const { after: panned } = pan(vertical(), { from: { x: 0.3 } });
    const tool = getTool('punch_in')!;
    expect(() =>
      tool.buildOps!({ clipId: 'shot', fromScale: 1, toScale: 0.8 }, { project: panned }),
    ).toThrow(/black bars[\s\S]*1 or above/);
    // A pull-back that stays at or above the cover is still a punch.
    expect(() =>
      tool.buildOps!({ clipId: 'shot', fromScale: 1.2, toScale: 1 }, { project: panned }),
    ).not.toThrow();
  });
});

/** The factor a plain punch_in applies at clip time t (its default ease-in-out, from 1). */
function punchInFactor(start: number, end: number, to: number): (t: number) => number {
  const keyframes = [
    { id: 'p0', time: start, property: 'scale', value: 1, easing: 'ease-in-out' as const },
    { id: 'p1', time: end, property: 'scale', value: to, easing: 'ease-in-out' as const },
  ];
  return (t) => evaluateKeyframes(keyframes, 'scale', t)!;
}
