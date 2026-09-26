/**
 * The critic's element checks (plan/elements EL8.1, 07 §4). Advisories, never failures: an element
 * over a face the run measured, an element in the caption band, the frame's edge or a platform's
 * own UI, more than three on screen at once, a sticker drawn soft. And one failure: a request that
 * asked for a sticker or a callout, finishing with none on the timeline.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProjectPatch,
  buildAddShapeOps,
  buildAddStickerOps,
  type Operation,
  type Patch,
} from '@framepilot/editor-core';
import { presetShapeParams, type Asset, type Project } from '@framepilot/timeline-schema';
import { makeProject } from './__fixtures__/project.js';
import { critique, type CritiqueOptions } from './critic.js';

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

const patchOf = (operations: readonly Operation[]): Patch => ({
  patchId: `t_${String(operations.length)}` as Patch['patchId'],
  createdBy: 'agent',
  reason: 't',
  operations: [...operations],
});

function base(resolution = { width: 1920, height: 1080 }): Project {
  return {
    ...makeProject({
      timeline: { tracks: [{ id: 'v', type: 'video', clips: [] }] },
    } as never),
    resolution,
  };
}

/** A sticker placed as add_sticker places it, offset in canvas pixels from the centre. */
function withSticker(
  project: Project,
  start: number,
  end: number,
  offset?: { x: number; y: number },
): Project {
  const placed = buildAddStickerOps(project, fire, start, end, {
    artFraction: 256 / 318,
    ...(offset === undefined ? {} : { offset }),
  });
  return applyProjectPatch(project, patchOf(placed.operations));
}

const find = (project: Project, id: string, options: CritiqueOptions = {}) =>
  critique(project, options).checks.find((check) => check.id === id)!;

describe('element checks', () => {
  it('have nothing to say about a timeline with no elements', () => {
    for (const id of [
      'element_faces',
      'element_safe_area',
      'element_busy_frame',
      'sticker_sharp',
    ]) {
      expect(find(base(), id).status, id).toBe('skipped');
    }
  });

  it('warn when an element sits over the face the run measured for most of its span', () => {
    const over = withSticker(base(), 1, 3);
    const face = { start: 0, end: 5, face: { x: 0.4, y: 0.3, width: 0.2, height: 0.3 } };
    expect(find(over, 'element_faces', { subjects: [face] }).status).toBe('warn');
    const beside = withSticker(base(), 1, 3, { x: 700, y: -200 });
    expect(find(beside, 'element_faces', { subjects: [face] }).status).toBe('pass');
    // Nothing measured: said, not guessed.
    expect(find(over, 'element_faces').status).toBe('skipped');
  });

  it('warn about an element in the caption band while captions show, or at the frame’s edge', () => {
    const low = withSticker(base(), 0, 3, { x: 0, y: 380 });
    const captioned: Project = {
      ...low,
      timeline: {
        ...low.timeline,
        tracks: [
          {
            id: 'captions',
            type: 'caption',
            clips: [
              {
                id: 'cue',
                assetId: '__caption__',
                trackId: 'captions',
                start: 0,
                end: 3,
                sourceStart: 0,
                sourceEnd: 3,
                effects: [
                  { id: 'cue__caption', type: 'caption', params: { text: 'hi' }, keyframes: [] },
                ],
                keyframes: [],
              },
            ],
          },
          ...low.timeline.tracks,
        ],
      },
    };
    expect(find(captioned, 'element_safe_area').status).toBe('warn');
    const edge = withSticker(base(), 0, 3, { x: 900, y: 0 });
    expect(find(edge, 'element_safe_area').status).toBe('warn');
    expect(find(withSticker(base(), 0, 3), 'element_safe_area').status).toBe('pass');
  });

  it('keeps clear of a vertical platform’s own buttons and caption block', () => {
    const vertical = { width: 1080, height: 1920 };
    // Inside the frame's safe margin, its right edge under the platform's button rail.
    const rail = withSticker(base(vertical), 0, 3, { x: 122, y: 0 });
    expect(find(rail, 'element_safe_area', { targetPlatform: 'tiktok' }).status).toBe('warn');
    expect(find(rail, 'element_safe_area', { targetPlatform: 'linkedin' }).status).not.toBe('warn');
  });

  it('warn when more than three elements are on screen at once', () => {
    let busy = base();
    for (let n = 0; n < 4; n += 1) busy = withSticker(busy, 0, 3, { x: -600 + n * 400, y: 0 });
    expect(find(busy, 'element_busy_frame').status).toBe('warn');
    let calm = base();
    for (let n = 0; n < 3; n += 1) calm = withSticker(calm, 0, 3, { x: -600 + n * 400, y: 0 });
    expect(find(calm, 'element_busy_frame').status).toBe('pass');
  });

  it('warn about a sticker drawn beyond its sharp size at the export resolution', () => {
    expect(find(withSticker(base(), 0, 3), 'sticker_sharp').status).toBe('pass');
    const uhd = withSticker(base({ width: 3840, height: 2160 }), 0, 3);
    expect(find(uhd, 'sticker_sharp').status).toBe('warn');
  });

  it('name the elements by id and never carry a varying magnitude', () => {
    let busy = withSticker(base({ width: 3840, height: 2160 }), 0, 3, { x: 1700, y: 0 });
    for (let n = 0; n < 4; n += 1) busy = withSticker(busy, 0, 3);
    for (const id of ['element_safe_area', 'element_busy_frame', 'sticker_sharp']) {
      const check = find(busy, id);
      expect(check.status, id).toBe('warn');
      // Clip ids are quoted, so the fix can target them; nothing else is a number.
      expect(check.detail.replace(/"[^"]*"/g, ''), id).not.toMatch(/\d/);
    }
  });
});

describe('the elements a request asked for', () => {
  it('fails a run that was asked for a sticker or a callout and placed none', () => {
    const none = base();
    expect(find(none, 'elements_placed', { requiredElements: ['sticker'] }).status).toBe('fail');
    const sticker = withSticker(base(), 0, 3);
    expect(find(sticker, 'elements_placed', { requiredElements: ['sticker'] }).status).toBe('pass');
    expect(find(sticker, 'elements_placed', { requiredElements: ['callout'] }).status).toBe('fail');
    const shape = applyProjectPatch(
      base(),
      patchOf(
        buildAddShapeOps(base().timeline, presetShapeParams('line-arrow/red')!, 0, 2).operations,
      ),
    );
    expect(find(shape, 'elements_placed', { requiredElements: ['callout'] }).status).toBe('pass');
    expect(find(none, 'elements_placed').status).toBe('skipped');
  });
});
