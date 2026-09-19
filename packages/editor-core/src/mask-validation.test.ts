/**
 * Validator rules for the v22 mask stack, exercised through `validatePatch` exactly as every
 * product path calls it.
 */
import { describe, expect, it } from 'vitest';
import {
  MaskLayerSchema,
  type Asset,
  type MaskLayer,
  type MaskLayerInput,
  type Timeline,
} from '@framepilot/timeline-schema';
import type { AnyOperation } from './patch.js';
import { validatePatch, type ValidateOptions } from './validator.js';

const SHA = 'd'.repeat(64);
const measured: Asset[] = [
  { id: 'a1', path: 'a.mp4', kind: 'video', media: { width: 1920, height: 1080 } },
  { id: 'a2', path: 'b.mp4', kind: 'video', media: { width: 1920, height: 1080 } },
];
const unmeasured: Asset[] = [
  { id: 'a1', path: 'a.mp4', kind: 'video' },
  { id: 'a2', path: 'b.mp4', kind: 'video' },
];

const parse = (input: MaskLayerInput): MaskLayer => MaskLayerSchema.parse(input);
const rect = (id: string, over: Record<string, unknown> = {}): MaskLayerInput =>
  ({ kind: 'rectangle', id, cx: 10, cy: 10, width: 5, height: 5, ...over }) as MaskLayerInput;
const matte = (id: string, over: Record<string, unknown> = {}): MaskLayerInput =>
  ({
    kind: 'matte',
    id,
    artifact: {
      key: SHA,
      files: [{ name: 'matte.mkv', sha256: SHA }],
      width: 1920,
      height: 1080,
      coverage: { sourceStart: 2, sourceEnd: 6 },
      packId: 'subject-matte',
      packVersion: '1.0.0',
      modelDigests: [SHA],
      ...over,
    },
  }) as MaskLayerInput;

function timeline(c1Masks: MaskLayerInput[] = [], c2Masks: MaskLayerInput[] = []): Timeline {
  const clip = (id: string, assetId: string, start: number, masks: MaskLayerInput[]) => ({
    id,
    assetId,
    trackId: 'v1',
    start,
    end: start + 4,
    sourceStart: 2,
    sourceEnd: 6,
    effects: [],
    keyframes: [],
    ...(masks.length > 0 ? { masks: masks.map(parse) } : {}),
  });
  return {
    tracks: [
      {
        id: 'v1',
        type: 'video',
        clips: [clip('c1', 'a1', 0, c1Masks), clip('c2', 'a2', 4, c2Masks)],
      },
      {
        id: 'fx',
        type: 'effect',
        clips: [],
        effectLayers: [
          {
            id: 'L1',
            effectId: 'gaussian-blur',
            kind: 'blur-gaussian',
            start: 0,
            end: 2,
            params: {},
            keyframes: [],
          },
        ],
      },
    ],
  };
}

const validate = (
  base: Timeline,
  operations: readonly unknown[],
  options: ValidateOptions = { assets: measured },
) => validatePatch(base, { operations: operations as AnyOperation[] }, options);

const codes = (result: ReturnType<typeof validate>) =>
  result.issues.map((issue) => `${issue.severity}:${issue.code}`);

describe('mask validator rules', () => {
  it('refuses a pixel mask on media nobody measured, and accepts it once measured', () => {
    const op = { type: 'add_mask', clipId: 'c1', mask: rect('m') };
    const refused = validate(timeline(), [op], { assets: unmeasured });
    expect(refused.valid).toBe(false);
    expect(codes(refused)).toEqual(['error:mask_needs_media_dimensions']);
    expect(refused.issues[0]!.message).toMatch(/Measure this media first/);
    expect(validate(timeline(), [op]).valid).toBe(true);
    // Without asset evidence the rule is skipped, not guessed.
    expect(validate(timeline(), [op], {}).valid).toBe(true);
  });

  it('surfaces a migrated normalised mask as a warning without blocking edits to the clip', () => {
    const base = timeline([
      rect('legacy', { units: 'normalized', cx: 0.5, cy: 0.5, width: 0.2, height: 0.2 }),
    ]);
    const result = validate(
      base,
      [{ type: 'update_mask', clipId: 'c1', maskId: 'legacy', changes: { opacity: 0.5 } }],
      {
        assets: unmeasured,
      },
    );
    expect(result.valid).toBe(true);
    expect(codes(result)).toEqual(['warning:mask_needs_media_dimensions']);
  });

  it('refuses authored keyframes outside the source range plus the handle, with a message that never varies', () => {
    const base = timeline([rect('m')]);
    const keyframeAt = (sourceTime: number) =>
      validate(base, [
        {
          type: 'add_mask_keyframe',
          clipId: 'c1',
          maskId: 'm',
          keyframe: { id: 'k', sourceTime, property: 'cx', value: 1 },
        },
      ]);
    expect(keyframeAt(6.9).valid).toBe(true);
    expect(keyframeAt(1.1).valid).toBe(true);
    const late = keyframeAt(9);
    const later = keyframeAt(42.5);
    expect(codes(late)).toEqual(['error:mask_keyframe_out_of_range']);
    // The repeated-failure guard keys on this text: the magnitude must not be in it.
    expect(later.issues[0]!.message).toBe(late.issues[0]!.message);
    expect(late.issues[0]!.message).toMatch(/SOURCE time/);
    // Timeline seconds passed where source seconds belong land before the in-point.
    expect(keyframeAt(0).valid).toBe(false);
  });

  it('does not re-judge existing keyframes when an unrelated field changes', () => {
    const base = timeline([
      rect('m', { keyframes: [{ id: 'old', sourceTime: 30, property: 'cx', value: 1 }] }),
    ]);
    expect(
      validate(base, [{ type: 'update_mask', clipId: 'c1', maskId: 'm', changes: { name: 'x' } }])
        .valid,
    ).toBe(true);
  });

  it('refuses the retired mask effect type in a clip written wholesale', () => {
    const result = validate(timeline(), [
      {
        type: 'add_layer',
        layerId: 'v2',
        layerType: 'video',
        atIndex: 0,
        clips: [
          {
            id: 'n',
            assetId: 'a1',
            trackId: 'v2',
            start: 0,
            end: 1,
            sourceStart: 0,
            sourceEnd: 1,
            effects: [{ id: 'n__mask', type: 'mask', params: { shape: 'ellipse' }, keyframes: [] }],
            keyframes: [],
          },
        ],
      },
    ]);
    expect(codes(result)).toEqual(['error:unsupported_effect']);
    expect(result.issues[0]!.message).toMatch(/Use add_mask/);
  });

  it('detects layer masks that loop, and layer masks that read nothing', () => {
    const base = timeline([
      { kind: 'layer', id: 'from-c2', source: { kind: 'clip', clipId: 'c2' } } as MaskLayerInput,
    ]);
    const loop = validate(base, [
      {
        type: 'add_mask',
        clipId: 'c2',
        mask: { kind: 'layer', id: 'from-c1', source: { kind: 'clip', clipId: 'c1' } },
      },
    ]);
    expect(codes(loop)).toEqual(['error:mask_layer_cycle']);
    const viaTrack = validate(base, [
      {
        type: 'add_mask',
        clipId: 'c2',
        mask: { kind: 'layer', id: 't', source: { kind: 'track', trackId: 'v1' } },
      },
    ]);
    expect(codes(viaTrack)).toContain('error:mask_layer_cycle');
    const dangling = validate(timeline(), [
      {
        type: 'add_mask',
        clipId: 'c1',
        mask: { kind: 'layer', id: 'x', source: { kind: 'clip', clipId: 'ghost' } },
      },
    ]);
    expect(codes(dangling)).toEqual(['error:missing_reference']);
    // A disabled layer mask reads nothing, so it cannot close a loop.
    const disabled = validate(base, [
      {
        type: 'add_mask',
        clipId: 'c2',
        mask: { kind: 'layer', id: 'off', enabled: false, source: { kind: 'clip', clipId: 'c1' } },
      },
    ]);
    expect(disabled.valid).toBe(true);
    // A track matte takes its edge from its source: expansion and feathers are refused (MK8.2).
    const feathered = validate(timeline(), [
      {
        type: 'add_mask',
        clipId: 'c1',
        mask: {
          kind: 'layer',
          id: 'f',
          source: { kind: 'clip', clipId: 'c2' },
          featherOuterPx: 4,
        },
      },
    ]);
    expect(codes(feathered)).toEqual(['error:invalid_mask']);
    expect(feathered.issues[0]!.message).toMatch(/finesse controls/);
  });

  it('refuses a trim that plays source frames the matte does not cover, and a matte made for another size', () => {
    const base = timeline([matte('subject')]);
    expect(validate(base, [{ type: 'trim_clip', clipId: 'c1', start: 0.5, end: 4 }]).valid).toBe(
      true,
    );
    const slipped = validate(base, [
      { type: 'set_clip_source_range', clipId: 'c1', sourceStart: 3, sourceEnd: 7 },
    ]);
    expect(codes(slipped)).toEqual(['error:matte_out_of_coverage']);
    expect(slipped.issues[0]!.message).toMatch(/Update the background removal/);
    const wrongSize = validate(timeline(), [
      { type: 'add_mask', clipId: 'c1', mask: matte('s', { width: 1280, height: 720 }) },
    ]);
    expect(codes(wrongSize)).toEqual(['error:invalid_mask']);
  });

  it('sizes a matte in display space: rotation turns it, pixel aspect ratio stretches it (BR2.6)', () => {
    const turned: Asset[] = [
      {
        id: 'a1',
        path: 'a.mp4',
        kind: 'video',
        media: { width: 1920, height: 1080, rotation: 90 },
      },
      measured[1]!,
    ];
    const add = (width: number, height: number, assets: Asset[]) =>
      codes(
        validate(
          timeline(),
          [{ type: 'add_mask', clipId: 'c1', mask: matte('s', { width, height }) }],
          {
            assets,
          },
        ),
      );
    expect(add(1080, 1920, turned)).toEqual([]);
    expect(add(1920, 1080, turned)).toEqual(['error:invalid_mask']);
    const anamorphic: Asset[] = [
      {
        id: 'a1',
        path: 'a.mp4',
        kind: 'video',
        media: { width: 1440, height: 1080, pixelAspectRatio: 4 / 3 },
      },
      measured[1]!,
    ];
    expect(add(1920, 1080, anamorphic)).toEqual([]);
    expect(add(1440, 1080, anamorphic)).toEqual(['error:invalid_mask']);
  });

  it('re-checks the invariants on a restored stack a hand-built patch could break', () => {
    const base = timeline([rect('m')]);
    const restore = (masks: unknown[]) =>
      validate(base, [{ type: 'restore_masks', clipId: 'c1', masks }]);
    expect(codes(restore([parse(rect('a')), parse(rect('a'))]))).toEqual(['error:duplicate_mask']);
    expect(codes(restore([{ ...parse(rect('a')), cx: Number.POSITIVE_INFINITY }]))).toEqual([
      'error:invalid_mask',
    ]);
    expect(
      codes(restore([parse(rect('a', { target: { kind: 'effect', effectId: 'ghost' } }))])),
    ).toEqual(['error:invalid_mask_target']);
    const mismatched = {
      ...parse({
        kind: 'path',
        id: 'p',
        pathKeyframes: [
          { id: 'k0', sourceTime: 2, points: Array(18).fill(0), vertexTypes: [0, 0, 0] },
        ],
      }),
    } as MaskLayer & { pathKeyframes: unknown[] };
    mismatched.pathKeyframes = [
      ...mismatched.pathKeyframes,
      {
        id: 'k1',
        sourceTime: 3,
        easing: 'linear',
        points: Array(24).fill(0),
        vertexTypes: [0, 0, 0, 0],
      },
    ];
    expect(codes(restore([mismatched]))).toEqual(['error:invalid_mask_path']);
    const lane = validate(timeline(), [
      { type: 'restore_masks', layerId: 'L1', masks: [parse(rect('lane'))] },
    ]);
    expect(codes(lane)).toEqual(['error:invalid_mask']);
  });
});
