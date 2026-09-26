/**
 * What the editor's polite live region says once an element lands (plan/elements 02 §3,
 * "Added … at 0:12"): every add says what landed and where, by the name the panel shows.
 */
import { describe, expect, it } from 'vitest';
import type { Patch } from '@framepilot/editor-core';
import {
  placedClipOf,
  shapeAddedAnnouncement,
  stickerAddedAnnouncement,
  stickerReplacedAnnouncement,
} from './element-announcements.js';

describe('element announcements', () => {
  it('names a shape by what it is, lower-cased as a noun', () => {
    expect(shapeAddedAnnouncement('rounded-rect/highlight', 12.7)).toBe(
      'Added the highlight box at 0:12',
    );
  });

  it('falls back to "shape" for a preset this build does not know', () => {
    expect(shapeAddedAnnouncement('nope/nothing', 0)).toBe('Added the shape at 0:00');
  });

  it('names a sticker as the Stickers tab does', () => {
    expect(stickerAddedAnnouncement('Grinning face', 75)).toBe('Added Grinning face at 1:15');
  });

  it('says what a replace swapped', () => {
    expect(stickerReplacedAnnouncement('Fire', 'Red heart')).toBe('Replaced Fire with Red heart');
  });

  it('finds the clip a placement adds, and where', () => {
    const patch = {
      patchId: 'p',
      createdBy: 'user',
      reason: 'r',
      operations: [
        { type: 'add_asset', asset: { id: 'a', path: 'a.mp4', kind: 'video' } },
        {
          type: 'add_clip',
          trackId: 'video_2',
          assetId: 'a',
          clipId: 'video_2_clip',
          start: 4,
          end: 10,
          sourceStart: 0,
          sourceEnd: 6,
        },
      ],
    } as unknown as Patch;
    expect(placedClipOf(patch)).toEqual({ clipId: 'video_2_clip', start: 4 });
    expect(placedClipOf({ ...patch, operations: [] })).toBeNull();
  });
});
