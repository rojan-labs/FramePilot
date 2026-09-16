/**
 * Schema v21 → v22: `mask` effects become `Clip.masks` (ADR 0178).
 *
 * Every expectation here is stated in terms of what the v21 export compiler drew, because
 * the point of the step is that an upgraded project renders the same picture.
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, parseProject, type MaskLayer } from './index.js';
import {
  MASK_DISABLED_EXTRA_NOTE,
  MASK_MEASURE_MEDIA_NOTE,
  migrateMaskEffectsToStack,
} from './mask-migration.js';
import { migrateToCurrent, type RawProject } from './migrations.js';
import { sourceTimeAt } from './speed-curve.js';

type Raw = Record<string, unknown>;

const WIDTH = 1920;
const HEIGHT = 1080;

function v21Project(clip: Raw, media: Raw | null = { width: WIDTH, height: HEIGHT }): RawProject {
  return {
    schemaVersion: 21,
    id: 'p',
    name: 'masks',
    version: 1,
    fps: 30,
    resolution: { width: WIDTH, height: HEIGHT },
    assets: [{ id: 'a1', path: 'a.mp4', kind: 'video', ...(media ? { media } : {}) }],
    timeline: {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'c1',
              assetId: 'a1',
              trackId: 'v1',
              start: 0,
              end: 4,
              sourceStart: 3,
              sourceEnd: 7,
              keyframes: [],
              ...clip,
            },
          ],
        },
      ],
    },
  };
}

const maskEffect = (params: Raw, keyframes: Raw[] = [], id = 'c1__mask'): Raw => ({
  id,
  type: 'mask',
  params,
  keyframes,
});

/** Migrate through the registered chain and validate against the v22 schema. */
function migrated(raw: RawProject): { clip: Raw; masks: MaskLayer[] } {
  const result = migrateToCurrent(raw);
  expect(result.appliedTo).toEqual([22]);
  const project = parseProject(result.raw);
  const rawClip = (((result.raw.timeline as Raw).tracks as Raw[])[0]!.clips as Raw[])[0]!;
  return { clip: rawClip, masks: [...(project.timeline.tracks[0]!.clips[0]!.masks ?? [])] };
}

describe('v21 → v22 mask effects → mask stack', () => {
  it('turns the first rectangle into an enabled gaussian-legacy alpha mask in source pixels', () => {
    const { clip, masks } = migrated(
      v21Project({
        effects: [
          { id: 'grade', type: 'color_grade', params: {} },
          maskEffect({
            shape: 'rectangle',
            bounds: { x: 0.25, y: 0.1, width: 0.5, height: 0.4 },
            feather: 0.02,
            opacity: 0.8,
            invert: true,
          }),
        ],
      }),
    );
    expect((clip.effects as Raw[]).map((effect) => effect.type)).toEqual(['color_grade']);
    expect(masks).toHaveLength(1);
    expect(masks[0]).toMatchObject({
      id: 'c1__mask',
      kind: 'rectangle',
      enabled: true,
      target: { kind: 'alpha' },
      mode: 'add',
      featherModel: 'gaussian-legacy',
      space: 'source',
      opacity: 0.8,
      invert: true,
      cx: (0.25 + 0.25) * WIDTH,
      cy: (0.1 + 0.2) * HEIGHT,
      width: 0.5 * WIDTH,
      height: 0.4 * HEIGHT,
      rotation: 0,
      roundness: 0,
      featherInnerPx: 0,
      featherOuterPx: 0.02 * HEIGHT,
    });
    expect(masks[0]!.units).toBeUndefined();
    expect(masks[0]!.migrationNote).toBeUndefined();
  });

  it('maps geometry through the crop, because v21 masks were drawn on the cropped frame', () => {
    const { masks } = migrated(
      v21Project({
        crop: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        effects: [
          maskEffect({
            shape: 'ellipse',
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            feather: 0.1,
          }),
        ],
      }),
    );
    expect(masks[0]).toMatchObject({
      kind: 'ellipse',
      cx: 0.75 * WIDTH,
      cy: 0.25 * HEIGHT,
      rx: (0.5 * WIDTH) / 2,
      ry: (0.5 * HEIGHT) / 2,
      // Smaller side of the CROPPED frame: 0.5 * 1080 = 540.
      featherOuterPx: 0.1 * 540,
    });
  });

  it('turns a polygon into a path with zero tangents, and a degenerate polygon into its bounds', () => {
    const { masks } = migrated(
      v21Project({
        effects: [
          maskEffect({
            shape: 'polygon',
            points: [
              [0, 0],
              [1, 0],
              [0.5, 1],
            ],
          }),
        ],
      }),
    );
    const path = masks[0]!;
    expect(path.kind).toBe('path');
    if (path.kind !== 'path') throw new Error('unreachable');
    expect(path.pathKeyframes).toEqual([
      {
        id: 'c1__mask__path__0',
        sourceTime: 3,
        easing: 'linear',
        points: [0, 0, 0, 0, 0, 0, WIDTH, 0, 0, 0, 0, 0, 0.5 * WIDTH, HEIGHT, 0, 0, 0, 0],
        vertexTypes: [0, 0, 0],
      },
    ]);

    const degenerate = migrated(
      v21Project({
        effects: [
          maskEffect({
            shape: 'polygon',
            points: [[0.1, 0.1]],
            bounds: { x: 0, y: 0, width: 0.5, height: 0.5 },
          }),
        ],
      }),
    ).masks[0]!;
    expect(degenerate).toMatchObject({ kind: 'rectangle', width: 0.5 * WIDTH });
  });

  it('brings later masks through disabled, with a note, because they never rendered', () => {
    const { masks } = migrated(
      v21Project({
        effects: [
          maskEffect({ shape: 'rectangle' }, [], 'first'),
          maskEffect({ shape: 'ellipse' }, [], 'second'),
        ],
      }),
    );
    expect(masks.map((mask) => [mask.id, mask.enabled])).toEqual([
      ['first', true],
      ['second', false],
    ]);
    expect(masks[1]!.migrationNote).toContain(MASK_DISABLED_EXTRA_NOTE);
  });

  it('keeps frame fractions and asks for a measurement when the media size is unknown', () => {
    const { masks } = migrated(
      v21Project(
        {
          effects: [
            maskEffect({
              shape: 'rectangle',
              bounds: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
              feather: 0.05,
            }),
          ],
        },
        null,
      ),
    );
    expect(masks[0]).toMatchObject({
      units: 'normalized',
      cx: 0.5,
      cy: 0.5,
      width: 0.6,
      height: 0.6,
      featherOuterPx: 0.05,
    });
    expect(masks[0]!.migrationNote).toContain(MASK_MEASURE_MEDIA_NOTE);
  });

  it('preserves a tracked mask: box keyframes become source-time centre/size keyframes', () => {
    const box = (time: number, x: number, y: number): Raw[] => [
      { id: `x${time}`, time, property: 'x', value: x, easing: 'linear' },
      { id: `y${time}`, time, property: 'y', value: y, easing: 'linear' },
      { id: `w${time}`, time, property: 'width', value: 0.2, easing: 'linear' },
      { id: `h${time}`, time, property: 'height', value: 0.3, easing: 'linear' },
    ];
    const { masks } = migrated(
      v21Project({
        end: 2,
        speed: 2,
        effects: [
          { id: 'c1__track', type: 'object_track', params: { target: 'object' } },
          maskEffect({ shape: 'rectangle', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 } }, [
            ...box(0, 0.1, 0.1),
            ...box(0.5, 0.3, 0.2),
            ...box(1, 0.5, 0.4),
          ]),
        ],
      }),
    );
    const cx = masks[0]!.keyframes.filter((keyframe) => keyframe.property === 'cx');
    // Timeline t → source 3 + 2t, the clip's speed.
    expect(cx.map((keyframe) => keyframe.sourceTime)).toEqual([3, 4, 5]);
    expect(cx.map((keyframe) => keyframe.value)).toEqual([
      (0.1 + 0.1) * WIDTH,
      (0.3 + 0.1) * WIDTH,
      (0.5 + 0.1) * WIDTH,
    ]);
    expect(new Set(masks[0]!.keyframes.map((keyframe) => keyframe.property))).toEqual(
      new Set(['cx', 'cy', 'width', 'height']),
    );
    expect(masks[0]!.migrationNote).toBeUndefined();
  });

  it('derives centre keyframes from one animated input against the other static value', () => {
    const { masks } = migrated(
      v21Project({
        effects: [
          maskEffect({ shape: 'rectangle', bounds: { x: 0, y: 0, width: 0.5, height: 0.5 } }, [
            { id: 'k1', time: 0, property: 'x', value: 0, easing: 'ease-in' },
            { id: 'k2', time: 2, property: 'x', value: 0.5, easing: 'linear' },
          ]),
        ],
      }),
    );
    expect(masks[0]!.keyframes).toEqual([
      {
        id: 'c1__mask__cx__0',
        sourceTime: 3,
        property: 'cx',
        value: 0.25 * WIDTH,
        easing: 'ease-in',
      },
      {
        id: 'c1__mask__cx__1',
        sourceTime: 5,
        property: 'cx',
        value: 0.75 * WIDTH,
        easing: 'linear',
      },
    ]);
  });

  it('resamples x and width set at different instants, and says so', () => {
    const { masks } = migrated(
      v21Project({
        effects: [
          maskEffect({ shape: 'rectangle' }, [
            { id: 'x0', time: 0, property: 'x', value: 0, easing: 'linear' },
            { id: 'x2', time: 2, property: 'x', value: 0.4, easing: 'linear' },
            { id: 'w1', time: 1, property: 'width', value: 0.2, easing: 'linear' },
          ]),
        ],
      }),
    );
    const cx = masks[0]!.keyframes.filter((keyframe) => keyframe.property === 'cx');
    expect(cx.map((keyframe) => keyframe.sourceTime)).toEqual([3, 4, 5]);
    // x is evaluated at 1s (0.2) against width's only point (0.2): cx = 0.2 + 0.1.
    [0.1, 0.3, 0.5].forEach((fraction, index) => {
      expect(cx[index]!.value).toBeCloseTo(fraction * WIDTH, 9);
    });
    expect(masks[0]!.migrationNote).toContain('combined at every instant');
  });

  it('mirrors easing on a reversed clip so the same curve plays against source time', () => {
    const { masks } = migrated(
      v21Project({
        speed: -1,
        effects: [
          maskEffect({ shape: 'rectangle' }, [
            { id: 'o0', time: 0, property: 'opacity', value: 0, easing: 'ease-in' },
            { id: 'o4', time: 4, property: 'opacity', value: 1, easing: 'linear' },
          ]),
        ],
      }),
    );
    expect(masks[0]!.keyframes.map((k) => [k.sourceTime, k.value, k.easing])).toEqual([
      [3, 1, 'ease-out'],
      [7, 0, 'linear'],
    ]);
  });

  it('keeps only the first value on a freeze frame, with a note', () => {
    const { masks } = migrated(
      v21Project({
        speed: 0,
        effects: [
          maskEffect({ shape: 'rectangle' }, [
            { id: 'o0', time: 0, property: 'opacity', value: 0.2, easing: 'linear' },
            { id: 'o4', time: 4, property: 'opacity', value: 1, easing: 'linear' },
          ]),
        ],
      }),
    );
    expect(masks[0]!.keyframes.map((k) => [k.sourceTime, k.value])).toEqual([[3, 0.2]]);
    expect(masks[0]!.migrationNote).toContain('freeze frame');
  });

  it('maps keyframe instants through a speed ramp', () => {
    const ramp = [
      { id: 'r0', sourceTime: 0, rate: 1, easing: 'linear' },
      { id: 'r1', sourceTime: 4, rate: 2, easing: 'linear' },
    ];
    const { masks } = migrated(
      v21Project({
        speedRamp: ramp,
        effects: [
          maskEffect({ shape: 'rectangle' }, [
            { id: 'o1', time: 1.5, property: 'opacity', value: 0.5, easing: 'linear' },
          ]),
        ],
      }),
    );
    expect(masks[0]!.keyframes[0]!.sourceTime).toBe(3 + sourceTimeAt(ramp as never, 0, 1.5, 4));
    expect(masks[0]!.migrationNote).toContain('speed ramp');
  });

  it('drops keyframes on properties a v21 mask never animated, with a note', () => {
    const { masks } = migrated(
      v21Project({
        effects: [
          maskEffect({ shape: 'rectangle' }, [
            { id: 'r', time: 0, property: 'rotation', value: 45, easing: 'linear' },
          ]),
        ],
      }),
    );
    expect(masks[0]!.keyframes).toEqual([]);
    expect(masks[0]!.migrationNote).toContain('never animated');
  });

  it('leaves a project without mask effects byte-identical and passes malformed shapes through', () => {
    const plain = v21Project({ effects: [{ id: 'g', type: 'color_grade', params: {} }] });
    expect(migrateMaskEffectsToStack(plain)).toBe(plain);
    const malformed = { timeline: { tracks: [null, { clips: 'nope' }, { clips: [7] }] } };
    expect(migrateMaskEffectsToStack(malformed)).toBe(malformed);
  });

  it('round-trips: the migrated project parses, re-serialises and re-parses unchanged', () => {
    const result = migrateToCurrent(
      v21Project({
        effects: [
          maskEffect({ shape: 'ellipse', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }),
        ],
      }),
    );
    expect(result.raw.schemaVersion).toBe(SCHEMA_VERSION);
    const once = parseProject(result.raw);
    const twice = parseProject(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    // A second migration pass finds nothing left to migrate.
    expect(migrateMaskEffectsToStack(result.raw)).toBe(result.raw);
  });
});
