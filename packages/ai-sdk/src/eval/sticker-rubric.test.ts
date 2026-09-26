/**
 * The sticker evaluation case (plan/elements 07 section 8, case 2): the rubric scores when a
 * sticker landed and whether its art stays off the face and above the captions, against the
 * fixture's ground truth, and the case carries that ground truth exactly as the generator wrote it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAddStickerOps, applyProjectPatch, type Patch } from '@framepilot/editor-core';
import type { Asset, Clip, Project } from '@framepilot/timeline-schema';
import { GOLDEN_CASES } from './golden-cases.js';
import { scoreMissionScenario, stickerArtBox, type StickerTarget } from './mission-rubric.js';

const LABELS = JSON.parse(
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../tests/fixtures/mission/labels/reaction-demo.json',
    ),
    'utf8',
  ),
) as StickerTarget;

const TARGET: StickerTarget = {
  face: LABELS.face,
  phraseStart: LABELS.phraseStart,
  wordStart: LABELS.wordStart,
  captionBandTop: LABELS.captionBandTop,
};

const footage: Clip = {
  id: 'c1',
  assetId: 'a1',
  trackId: 'v1',
  start: 0,
  end: 12,
  sourceStart: 0,
  sourceEnd: 12,
  effects: [],
  keyframes: [],
};

const fire: Asset = {
  id: 'element_fluent3d_fire',
  path: 'media/p/elements/fluent3d/fire.webp',
  kind: 'image',
  media: { width: 318, height: 318 },
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
} as Asset;

const before = {
  id: 'p',
  name: 'p',
  version: 1,
  fps: 30,
  resolution: { width: 1280, height: 720 },
  assets: [{ id: 'a1', path: 'media/reaction.mp4', kind: 'video', durationSeconds: 12 }],
  folders: [],
  timeline: { tracks: [{ id: 'v1', type: 'video', clips: [footage] }] },
  transcript: [],
  markers: [],
  aiMemory: {},
  history: [],
} as unknown as Project;

/** The project after the sticker is placed as the Stickers tab and `add_sticker` place it. */
function withSticker(start: number, end: number, offset?: { x: number; y: number }): Project {
  const placed = buildAddStickerOps(before, fire, start, end, {
    artFraction: 256 / 318,
    ...(offset !== undefined ? { offset } : {}),
  });
  const patch: Patch = {
    patchId: 'sticker_test' as Patch['patchId'],
    createdBy: 'ai',
    reason: 'Add sticker',
    operations: [...placed.operations],
  };
  return applyProjectPatch(before, patch);
}

const score = (after: Project) =>
  scoreMissionScenario('sticker-on-beat', { before, after, stickerTarget: TARGET });
const check = (after: Project, id: string) => score(after).checks.find((c) => c.id === id)?.ok;

// Up and to the right of the face, above the caption band: canvas pixels from the centre.
const CLEAR = { x: 320, y: -180 };

describe('the sticker case', () => {
  it('carries the ground truth the fixture generator wrote', () => {
    const turn = GOLDEN_CASES.find((c) => c.id === 'sticker-fire-on-beat')!.turns[0]!;
    expect(turn.stickerTarget).toEqual(TARGET);
    expect(turn.rubric).toBe('sticker-on-beat');
  });
});

describe('stickerArtBox', () => {
  it('measures the art, not the padded file, at 30% of the frame height by default', () => {
    const after = withSticker(5, 7);
    const clip = after.timeline.tracks.flatMap((t) => t.clips).find((c) => c.assetId === fire.id)!;
    const box = stickerArtBox(fire, clip, after.resolution);
    expect(box.height).toBeCloseTo(30, 1);
    expect(box.y + box.height / 2).toBeCloseTo(50, 3);
    expect(box.x + box.width / 2).toBeCloseTo(50, 3);
  });
});

describe('scoring a run', () => {
  it('scores a sticker on the phrase, clear of the face and captions, briefly, as a pass', () => {
    const after = withSticker(TARGET.phraseStart, TARGET.phraseStart + 2, CLEAR);
    const failed = score(after)
      .checks.filter((c) => !c.ok)
      .map((c) => c.id);
    expect(failed).toEqual([]);
  });

  it('fails a sticker over the face, one under the captions, a late one and a long one', () => {
    expect(check(withSticker(TARGET.wordStart, TARGET.wordStart + 2), 'sticker-off-face')).toBe(
      false,
    );
    expect(
      check(
        withSticker(TARGET.wordStart, TARGET.wordStart + 2, { x: 400, y: 250 }),
        'sticker-clear-of-captions',
      ),
    ).toBe(false);
    expect(
      check(withSticker(TARGET.wordStart + 1, TARGET.wordStart + 3, CLEAR), 'sticker-on-beat'),
    ).toBe(false);
    expect(
      check(withSticker(TARGET.phraseStart, TARGET.phraseStart + 5, CLEAR), 'sticker-brief'),
    ).toBe(false);
  });

  it('fails a run that added no sticker', () => {
    expect(check(before, 'sticker-added')).toBe(false);
  });
});
