/**
 * `add_sticker`'s placement (plan/elements EL6a.7): the call's centre, size and rotation become the
 * same base-transform keyframes the on-canvas handles write, on a graphics lane, and the result
 * validates and undoes.
 */
import { describe, expect, it } from 'vitest';
import {
  STICKER_SOFT_ENLARGEMENT,
  applyProjectPatch,
  elementRectAt,
  invertProjectPatch,
  stickerEnlargement,
  type Patch,
} from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { assembleEdit } from './assemble.js';
import { SAFE_AREA_INSET, critique } from './critic.js';
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

  it('without a size, places the sticker as big as it stays sharp on a vertical short', () => {
    // 30% of a 1920-row frame is 2.25× the 256 px art; the export would draw it soft.
    const vertical = makeProject({
      resolution: { width: 1080, height: 1920 },
      timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
    } as never);
    const placed = stickerOpsFromCall(vertical, payload, { start: 1 });
    const patch: Patch = {
      patchId: 'sticker' as Patch['patchId'],
      createdBy: 'ai',
      reason: 'Add sticker',
      operations: [...placed.operations],
    };
    const after = applyProjectPatch(vertical, patch);
    expect(stickerEnlargement(after, placed.clipId)!).toBeLessThanOrEqual(STICKER_SOFT_ENLARGEMENT);
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

  describe('keeps the sticker in frame, and says when it leaves the safe area (#150)', () => {
    const vertical = (): Project =>
      makeProject({
        resolution: { width: 1080, height: 1920 },
        timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
      } as never);
    const placedOn = (on: Project, args: Parameters<typeof stickerOpsFromCall>[2]) => {
      const placed = stickerOpsFromCall(on, payload, args);
      const edit = assembleEdit(on, [...placed.operations], 'Add sticker', 'agent');
      expect(edit.validation.valid, JSON.stringify(edit.validation.issues)).toBe(true);
      const after = applyProjectPatch(on, edit.patch);
      return { placed, after, rect: elementRectAt(after, placed.clipId, args.start + 0.5)! };
    };

    it('moves a sticker placed partly off the frame just far enough in', () => {
      const { rect, placed } = placedOn(vertical(), {
        start: 1,
        xPercent: 98,
        yPercent: 1,
        sizePercent: 20,
      });
      expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-6);
      expect(rect.y).toBeGreaterThanOrEqual(-1e-6);
      // Not pushed further than the frame: it still touches the edges it was asked for.
      expect((1 - (rect.x + rect.width)) * 1080).toBeLessThan(2);
      expect(rect.y * 1920).toBeLessThan(2);
      expect(placed.safeAreaNote).toMatch(/outside the 10% safe area/);
    });

    it('names the centres that keep it inside the margin, and they do, by the critic', () => {
      const edge = placedOn(vertical(), { start: 1, xPercent: 88, yPercent: 50, sizePercent: 10 });
      const note = edge.placed.safeAreaNote!;
      const match = /xPercent (\d+)–(\d+) and yPercent (\d+)–(\d+)/.exec(note)!;
      expect(match).not.toBeNull();
      expect(critique(edge.after).checks.find((c) => c.id === 'element_safe_area')?.status).toBe(
        'warn',
      );
      for (const xPercent of [Number(match[1]), Number(match[2])]) {
        const moved = placedOn(vertical(), { start: 1, xPercent, yPercent: 50, sizePercent: 10 });
        expect(moved.placed.safeAreaNote).toBeUndefined();
        expect(moved.rect.x).toBeGreaterThanOrEqual(SAFE_AREA_INSET - 1e-6);
        expect(moved.rect.x + moved.rect.width).toBeLessThanOrEqual(1 - SAFE_AREA_INSET + 1e-6);
        expect(critique(moved.after).checks.find((c) => c.id === 'element_safe_area')?.status).toBe(
          'pass',
        );
      }
    });

    it('says nothing for a sticker placed where it was asked inside the margin, or by default', () => {
      expect(placedOn(vertical(), { start: 1 }).placed.safeAreaNote).toBeUndefined();
      const asked = stickerOpsFromCall(project(), payload, {
        start: 2,
        xPercent: 75,
        yPercent: 25,
        sizePercent: 20,
      });
      expect(asked.safeAreaNote).toBeUndefined();
      expect(base(asked.operations, 'x')).toBe(480);
    });

    it('tells a sticker too big for the margin to shrink', () => {
      const { placed } = placedOn(vertical(), { start: 1, sizePercent: 60 });
      expect(placed.safeAreaNote).toMatch(/smaller sizePercent/);
    });
  });
});
