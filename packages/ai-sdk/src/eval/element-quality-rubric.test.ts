/**
 * The last three element evaluation cases (plan/elements 07 section 8, cases 4–6), scored on the
 * timeline a run leaves, never on the calls it made:
 *
 * - 4, a product still: "Underline the headline and put an arrow pointing at the price." An
 *   underline under the fixture's headline box and an arrow whose tip is inside its price box.
 * - 5, restyle: "Make all the highlight boxes red and thicker." Every box red with a wider stroke,
 *   the same clips in the same places, and the arrow beside them untouched.
 * - 6, undo: "Remove the stickers." Every sticker gone; the footage and the arrow untouched.
 *
 * Each rubric passes the edit that was asked for and fails each way of getting it wrong.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyProjectPatch,
  buildAddShapeOps,
  buildAddStickerOps,
  setShapeParamsOp,
  shapeClipParams,
  type Operation,
  type Patch,
} from '@framepilot/editor-core';
import {
  presetShapeParams,
  type Asset,
  type Clip,
  type Project,
  type ShapeParams,
} from '@framepilot/timeline-schema';
import { GOLDEN_CASES } from './golden-cases.js';
import {
  scoreMissionScenario,
  type MissionScenarioId,
  type ProductTarget,
} from './mission-rubric.js';

const LABELS = JSON.parse(
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../tests/fixtures/mission/labels/product-still.json',
    ),
    'utf8',
  ),
) as ProductTarget & { resolution: { width: number; height: number } };

const TARGET: ProductTarget = { headline: LABELS.headline, price: LABELS.price };

const sticker = (id: string): Asset =>
  ({
    id: `element_fluent3d_${id}`,
    path: `media/p/elements/fluent3d/${id}.webp`,
    kind: 'image',
    media: { width: 318, height: 318 },
    source: {
      provider: 'fluent-emoji',
      remoteId: id,
      license: 'mit',
      licenseUrl: 'https://example.test/LICENSE',
      attributionRequired: false,
      attribution: 'Fluent Emoji by Microsoft (MIT)',
      creator: 'Microsoft',
      sourceUrl: `https://example.test/${id}.png`,
      fetchedAt: '2026-09-26T00:00:00.000Z',
    },
  }) as Asset;

let patches = 0;
const patchOf = (operations: readonly Operation[]): Patch => ({
  patchId: `test_${String((patches += 1))}` as Patch['patchId'],
  createdBy: 'ai',
  reason: 'test',
  operations: [...operations],
});

/** Footage alone, as the fixture builder lays it: one video clip on `video_1`. */
function footage(seconds: number): Project {
  return {
    id: 'p',
    name: 'p',
    version: 1,
    fps: 30,
    resolution: { width: 1280, height: 720 },
    assets: [{ id: 'a1', path: 'media/demo.mp4', kind: 'video', durationSeconds: seconds }],
    folders: [],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_001',
              assetId: 'a1',
              trackId: 'video_1',
              start: 0,
              end: seconds,
              sourceStart: 0,
              sourceEnd: seconds,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    markers: [],
    aiMemory: {},
    history: [],
  } as unknown as Project;
}

function withShape(
  project: Project,
  preset: string,
  start: number,
  end: number,
  place: Partial<ShapeParams> = {},
): Project {
  const params = { ...presetShapeParams(preset)!, ...place } as ShapeParams;
  return applyProjectPatch(
    project,
    patchOf(buildAddShapeOps(project.timeline, params, start, end).operations),
  );
}

function withSticker(project: Project, id: string, start: number, end: number): Project {
  const placed = buildAddStickerOps(project, sticker(id), start, end, { artFraction: 256 / 318 });
  return applyProjectPatch(project, patchOf(placed.operations));
}

const clips = (project: Project): Clip[] => project.timeline.tracks.flatMap((t) => t.clips);
const shapes = (project: Project): Clip[] =>
  clips(project).filter((clip) => shapeClipParams(clip) !== null);

function edited(project: Project, operations: readonly Operation[]): Project {
  return applyProjectPatch(project, patchOf(operations));
}

/** What `delete_clip` sends: the clip's span on its own track, cleared. */
function deleted(project: Project, clipId: string): Operation {
  const clip = clips(project).find((c) => c.id === clipId)!;
  return { type: 'delete_range', trackId: clip.trackId, start: clip.start, end: clip.end };
}

const failures = (
  scenario: MissionScenarioId,
  before: Project,
  after: Project,
  productTarget?: ProductTarget,
): string[] =>
  scoreMissionScenario(scenario, {
    before,
    after,
    ...(productTarget === undefined ? {} : { productTarget }),
  })
    .checks.filter((check) => !check.ok)
    .map((check) => check.id);

describe('case 4: underline the headline and point at the price', () => {
  const { headline, price } = TARGET;
  const underlineY = headline.y + headline.height + 1.5;
  const underline = {
    x1: headline.x,
    y1: underlineY,
    x2: headline.x + headline.width,
    y2: underlineY,
  };
  const tipX = price.x + price.width / 2;
  const tipY = price.y + price.height / 2;
  const arrow = { x1: tipX - 20, y1: tipY - 25, x2: tipX, y2: tipY };

  it('is a callout case on the product still, carrying the fixture’s labels', () => {
    const found = GOLDEN_CASES.find((c) => c.id === 'underline-and-arrow-on-product')!;
    expect(found.category).toBe('callout');
    expect(found.project).toBe('mission-product-still');
    const turn = found.turns[0]!;
    expect(turn.prompt).toBe('Underline the headline and put an arrow pointing at the price.');
    expect(turn.rubric).toBe('underline-and-arrow');
    expect(turn.productTarget).toEqual(TARGET);
    // The labels describe the frame the fixture project is built at.
    expect(LABELS.resolution).toEqual({ width: 1280, height: 720 });
  });

  it('passes an underline under the headline and an arrow ending in the price', () => {
    const before = footage(8);
    let after = withShape(before, 'underline-marker/yellow', 0, 8, underline);
    after = withShape(after, 'line-arrow/red', 0, 8, arrow);
    expect(failures('underline-and-arrow', before, after, TARGET)).toEqual([]);
  });

  it('fails an underline through the headline, and one nowhere near it', () => {
    const before = footage(8);
    const through = { ...underline, y1: headline.y + 2, y2: headline.y + 2 };
    const beside = { x1: 5, y1: 95, x2: 25, y2: 95 };
    for (const ends of [through, beside]) {
      const after = withShape(
        withShape(before, 'underline-marker/yellow', 0, 8, ends),
        'line-arrow/red',
        0,
        8,
        arrow,
      );
      expect(failures('underline-and-arrow', before, after, TARGET)).toContain(
        'underline-under-headline',
      );
    }
  });

  it('fails an arrow whose tip misses the price, and a missing element', () => {
    const before = footage(8);
    const missed = { ...arrow, x2: 5, y2: 5 };
    const after = withShape(
      withShape(before, 'underline-marker/yellow', 0, 8, underline),
      'line-arrow/red',
      0,
      8,
      missed,
    );
    expect(failures('underline-and-arrow', before, after, TARGET)).toContain('arrow-on-price');
    const onlyUnderline = withShape(before, 'underline-marker/yellow', 0, 8, underline);
    expect(failures('underline-and-arrow', before, onlyUnderline, TARGET)).toContain('arrow-added');
    const onlyArrow = withShape(before, 'line-arrow/red', 0, 8, arrow);
    expect(failures('underline-and-arrow', before, onlyArrow, TARGET)).toContain('underline-added');
  });

  it('never passes without the labels', () => {
    const before = footage(8);
    const after = withShape(before, 'line-arrow/red', 0, 8, arrow);
    expect(failures('underline-and-arrow', before, after)).toContain('underline-added');
  });
});

describe('case 5: make all the highlight boxes red and thicker', () => {
  /** The screen demo with three highlight boxes and an arrow, as `mission-restyle-demo` has. */
  function demo(): Project {
    let project = footage(20);
    for (const [start, end] of [
      [2, 4],
      [7, 9],
      [12, 14],
    ] as const) {
      project = withShape(project, 'rounded-rect/highlight', start, end);
    }
    return withShape(project, 'line-arrow/red', 15, 17);
  }
  const boxes = (project: Project) =>
    shapes(project).filter((c) => shapeClipParams(c)!.x1 === undefined);
  const restyle = (project: Project, changes: Record<string, unknown>, which = boxes(project)) =>
    edited(
      project,
      which.map((clip) => setShapeParamsOp(clip.id, changes)),
    );

  it('is a restyle case on the demo with boxes', () => {
    const found = GOLDEN_CASES.find((c) => c.id === 'restyle-highlight-boxes')!;
    expect(found.category).toBe('restyle');
    expect(found.project).toBe('mission-restyle-demo');
    expect(found.turns[0]!.prompt).toBe('Make all the highlight boxes red and thicker.');
    expect(found.turns[0]!.rubric).toBe('restyle-highlight-boxes');
  });

  it('passes every box red with a wider stroke, in place, the arrow untouched', () => {
    const before = demo();
    const width = Number(shapeClipParams(boxes(before)[0]!)!.strokeWidth);
    const after = restyle(before, { stroke: '#FF3B30', strokeWidth: width * 2 });
    expect(failures('restyle-highlight-boxes', before, after)).toEqual([]);
  });

  it('fails a box left out, a colour that is not red, and a stroke no wider', () => {
    const before = demo();
    const width = Number(shapeClipParams(boxes(before)[0]!)!.strokeWidth);
    const two = boxes(before).slice(0, 2);
    expect(
      failures(
        'restyle-highlight-boxes',
        before,
        restyle(before, { stroke: '#FF3B30', strokeWidth: width * 2 }, two),
      ),
    ).toEqual(expect.arrayContaining(['boxes-red', 'boxes-thicker']));
    expect(
      failures(
        'restyle-highlight-boxes',
        before,
        restyle(before, { stroke: '#0A84FF', strokeWidth: width * 2 }),
      ),
    ).toContain('boxes-red');
    expect(
      failures('restyle-highlight-boxes', before, restyle(before, { stroke: '#FF3B30' })),
    ).toContain('boxes-thicker');
  });

  it('fails a box moved or re-made, and the arrow restyled too', () => {
    const before = demo();
    const width = Number(shapeClipParams(boxes(before)[0]!)!.strokeWidth);
    const red = restyle(before, { stroke: '#FF3B30', strokeWidth: width * 2 });
    const box = boxes(red)[0]!;
    const moved = edited(red, [
      { type: 'move_clip', clipId: box.id, toTrackId: box.trackId, toStart: 1 },
    ]);
    expect(failures('restyle-highlight-boxes', before, moved)).toContain('boxes-kept');
    const arrow = shapes(before).find((c) => shapeClipParams(c)!.x1 !== undefined)!;
    const everything = restyle(red, { strokeWidth: width * 2 }, [arrow]);
    expect(failures('restyle-highlight-boxes', before, everything)).toContain(
      'only-boxes-restyled',
    );
  });
});

describe('case 6: remove the stickers', () => {
  /** The reaction demo with two stickers and an arrow, as `mission-sticker-cleanup` has. */
  function demo(): Project {
    let project = withShape(footage(12), 'line-arrow/red', 2, 6);
    project = withSticker(project, 'fire', 3, 5);
    return withSticker(project, 'party_popper', 7, 9);
  }
  const stickerIds = (project: Project) =>
    clips(project)
      .filter((c) => c.assetId.startsWith('element_'))
      .map((c) => c.id);

  it('is a removal case on the demo with stickers', () => {
    const found = GOLDEN_CASES.find((c) => c.id === 'remove-the-stickers')!;
    expect(found.category).toBe('removal');
    expect(found.project).toBe('mission-sticker-cleanup');
    expect(found.turns[0]!.prompt).toBe('Remove the stickers.');
    expect(found.turns[0]!.rubric).toBe('remove-stickers');
  });

  it('passes every sticker deleted and everything else as it was', () => {
    const before = demo();
    const after = edited(
      before,
      stickerIds(before).map((clipId) => deleted(before, clipId)),
    );
    expect(failures('remove-stickers', before, after)).toEqual([]);
  });

  it('fails a sticker left behind, and the arrow or the footage removed with them', () => {
    const before = demo();
    const [first] = stickerIds(before);
    const one = edited(before, [deleted(before, first!)]);
    expect(failures('remove-stickers', before, one)).toContain('stickers-removed');
    const arrow = shapes(before)[0]!;
    const withArrow = edited(before, [
      ...stickerIds(before).map((clipId) => deleted(before, clipId)),
      deleted(before, arrow.id),
    ]);
    expect(failures('remove-stickers', before, withArrow)).toContain('others-kept');
  });
});
