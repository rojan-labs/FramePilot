/**
 * `add_sticker`'s placement (plan/elements EL6a.7): the call's centre, size and rotation become the
 * same base-transform keyframes the on-canvas handles write, on a graphics lane, and the result
 * validates and undoes.
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch, invertProjectPatch } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { assembleEdit } from './assemble.js';
import { makeProject } from './__fixtures__/project.js';
import {
  STICKER_DEFAULT_SECONDS,
  StickerAssetPayloadSchema,
  stickerOpsFromCall,
} from './sticker-placement.js';

const payload = StickerAssetPayloadSchema.parse({
  asset: {
    id: 'element_fluent3d_fire',
    path: 'media/p/elements/fluent3d/fire.webp',
    kind: 'image',
    media: { width: 318, height: 318 },
    sharpSize: 256,
    source: {
      provider: 'fluent-emoji',
      remoteId: 'fire',
      license: 'mit',
      licenseUrl: 'https://example.test/LICENSE',
      attributionRequired: false,
      attribution: 'Fluent Emoji by Microsoft (MIT)',
      creator: 'Microsoft',
      sourceUrl: 'https://example.test/fire.png',
      fetchedAt: '2026-09-26T00:00:00.000Z',
    },
  },
});

const project = (): Project =>
  makeProject({
    resolution: { width: 1920, height: 1080 },
    timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
  } as never);

const base = (ops: readonly { type: string }[], property: string): number =>
  (
    ops.find((op) => op.type === 'add_keyframes') as unknown as {
      keyframes: { property: string; value: number }[];
    }
  ).keyframes.find((k) => k.property === property)!.value;

describe('stickerOpsFromCall', () => {
  it('turns the centre and size into the handles’ offset and scale', () => {
    const placed = stickerOpsFromCall(project(), payload, {
      start: 2,
      xPercent: 75,
      yPercent: 25,
      sizePercent: 20,
    });
    expect(placed.end).toBe(2 + STICKER_DEFAULT_SECONDS);
    expect(base(placed.operations, 'x')).toBe(480);
    expect(base(placed.operations, 'y')).toBe(-270);
    // 20% of 1080 is 216 px of art; the art is 256/318 of a file fitted to 1080 px.
    expect(318 * (1080 / 318) * (256 / 318) * base(placed.operations, 'scale')).toBeCloseTo(216, 0);
  });

  it('adds a rotation, validates, and undoes to the same project', () => {
    const before = project();
    const placed = stickerOpsFromCall(before, payload, { start: 1, end: 2, rotation: -12 });
    const rotation = placed.operations
      .filter((op) => op.type === 'add_keyframes')
      .at(-1) as unknown as {
      keyframes: { property: string; value: number }[];
    };
    expect(rotation.keyframes[0]).toMatchObject({ property: 'rotation', value: -12 });
    const edit = assembleEdit(before, [...placed.operations], 'Add sticker', 'agent');
    expect(edit.validation.valid, JSON.stringify(edit.validation.issues)).toBe(true);
    const after = applyProjectPatch(before, edit.patch);
    expect(applyProjectPatch(after, invertProjectPatch(before, edit.patch))).toEqual(before);
  });
});
