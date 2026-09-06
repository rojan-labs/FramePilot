/**
 * Arguments a model reaches for that mean exactly one thing, accepted rather than refused.
 *
 * Run `cc907070` lost turns to three of these: `trim_clip {clipId, end}` ("start: expected
 * number, received undefined"), `search_stock {kind: "footage"}` ("expected one of
 * photo|video"), and `professional_audio duck_roles {target: "playhead"}`. The last is
 * covered in `professional-audio.test.ts`; these are the first two.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { operationsForCall } from '../tool-dispatch.js';
import type { ToolContext } from '../tool-context.js';
import { getTool } from '../tool-registry.js';

function project(): Project {
  return parseProject({
    id: 'lenient',
    name: 'Lenient args',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'a', path: 'a.mp4', kind: 'video', durationSeconds: 20 }],
    timeline: {
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'a',
              trackId: 'v1',
              start: 2,
              end: 6,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
  });
}

const ctx = (): ToolContext => ({ project: project() }) as unknown as ToolContext;

describe('trim_clip fills in the edge that was left out', () => {
  it('reads the missing start from the clip', () => {
    const ops = operationsForCall(
      { id: 'c', name: 'trim_clip', arguments: { clipId: 'clip_a', end: 5 } },
      ctx(),
    );
    expect(ops).toEqual([{ type: 'trim_clip', clipId: 'clip_a', start: 2, end: 5 }]);
  });

  it('reads the missing end from the clip', () => {
    const ops = operationsForCall(
      { id: 'c', name: 'trim_clip', arguments: { clipId: 'clip_a', start: 3 } },
      ctx(),
    );
    expect(ops).toEqual([{ type: 'trim_clip', clipId: 'clip_a', start: 3, end: 6 }]);
  });

  it('still refuses a trim with no edge at all, and an unknown clip with one missing', () => {
    expect(() =>
      operationsForCall({ id: 'c', name: 'trim_clip', arguments: { clipId: 'clip_a' } }, ctx()),
    ).toThrow(/Give start, end, or both/);
    expect(() =>
      operationsForCall(
        { id: 'c', name: 'trim_clip', arguments: { clipId: 'nope', end: 5 } },
        ctx(),
      ),
    ).toThrow(/no clip "nope"/);
  });
});

describe('detect_beats tolerates the retired hardSync argument', () => {
  it('drops hardSync instead of refusing the call over an unrecognized key', () => {
    const parsed = getTool('detect_beats')!.parse({ assetId: 'a', hardSync: true }) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ assetId: 'a' });
    expect(() => getTool('detect_beats')!.parse({ assetId: 'a', wobble: 1 })).toThrow();
  });
});

describe('stock kind accepts the words a model reaches for', () => {
  const parse = (name: string, args: unknown) => getTool(name)!.parse(args) as { kind: string };

  it('maps footage/clip/videos to video and image/still/photos to photo', () => {
    expect(parse('search_stock', { query: 'chairlift', kind: 'footage' }).kind).toBe('video');
    expect(parse('search_stock', { query: 'chairlift', kind: 'Clips' }).kind).toBe('video');
    expect(parse('search_stock', { query: 'snow', kind: 'image' }).kind).toBe('photo');
    expect(parse('add_stock', { remoteId: '123', kind: 'still' }).kind).toBe('photo');
  });

  it('still refuses a kind that means neither', () => {
    expect(() => parse('search_stock', { query: 'x', kind: 'audio' })).toThrow();
  });
});

describe('stock cutaways are held to the number the brief asked for', () => {
  const stock = (id: string) => ({
    id,
    path: `${id}.mp4`,
    kind: 'video',
    durationSeconds: 20,
    media: { width: 1920, height: 1080 },
    source: {
      provider: 'pexels',
      remoteId: '1',
      license: 'Pexels',
      attributionRequired: false,
      fetchedAt: '2026-09-06T00:00:00Z',
    },
  });
  const withCap = (cap: number | undefined): ToolContext => {
    const p = parseProject({
      ...project(),
      assets: [
        {
          id: 'a',
          path: 'a.mp4',
          kind: 'video',
          durationSeconds: 20,
          media: { width: 1920, height: 1080 },
        },
        stock('stock_1'),
        stock('stock_2'),
        stock('stock_3'),
      ],
      timeline: {
        tracks: [
          {
            id: 'v1',
            type: 'video',
            clips: [
              {
                id: 'own',
                assetId: 'a',
                trackId: 'v1',
                start: 0,
                end: 20,
                sourceStart: 0,
                sourceEnd: 20,
                effects: [],
                keyframes: [],
              },
            ],
          },
          {
            id: 'cut',
            type: 'video',
            clips: [
              {
                id: 'c1',
                assetId: 'stock_1',
                trackId: 'cut',
                start: 2,
                end: 4,
                sourceStart: 0,
                sourceEnd: 2,
                effects: [],
                keyframes: [],
              },
              {
                id: 'c2',
                assetId: 'stock_2',
                trackId: 'cut',
                start: 6,
                end: 8,
                sourceStart: 0,
                sourceEnd: 2,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    });
    return {
      project: p,
      ...(cap === undefined ? {} : { stockCutawayCap: cap }),
    } as unknown as ToolContext;
  };
  const place = (ctx: ToolContext) =>
    operationsForCall(
      {
        id: 'c',
        name: 'add_clip',
        arguments: { trackId: 'cut', assetId: 'stock_3', start: 10, end: 12, sourceStart: 0 },
      },
      ctx,
    );

  it('refuses a third stock cutaway when two were asked for, naming the two that are there', () => {
    // Run `4a8e`: "two cutaways I never shot" → eight stock clips.
    expect(() => place(withCap(2))).toThrow(
      /asked for 2 stock cutaways and 2 are already on the timeline/,
    );
    expect(() => place(withCap(2))).toThrow(/c1 \(2–4s\), c2 \(6–8s\)/);
    expect(() => place(withCap(2))).toThrow(/delete_clip that one first/);
  });

  it('allows it under the cap, with no cap, and never counts the editor’s own footage', () => {
    expect(place(withCap(3)).some((op) => op.type === 'add_clip')).toBe(true);
    expect(place(withCap(undefined)).some((op) => op.type === 'add_clip')).toBe(true);
    const own = operationsForCall(
      {
        id: 'c',
        name: 'add_clip',
        arguments: { trackId: 'cut', assetId: 'a', start: 10, end: 12, sourceStart: 5 },
      },
      withCap(2),
    );
    expect(own.some((op) => op.type === 'add_clip')).toBe(true);
  });
});

describe('a title that cannot fit its box is refused with the size that would', () => {
  it('names the word, the box, and the largest size that fits', () => {
    // Run `4a8e`: "Breck, opening weekend" at a size where "weekend" needed 119% of the
    // frame in an 80% box, caught only by the safe-area check afterwards.
    const call = (sizePercent: number) =>
      operationsForCall(
        {
          id: 'c',
          name: 'add_text_layer',
          arguments: {
            trackId: 'titles',
            text: 'Breck, opening weekend',
            start: 0,
            end: 4,
            sizePercent,
            boxWidthPercent: 80,
          },
        },
        // Portrait, as the captured run was: the frame is narrow and the word is wide.
        {
          project: parseProject({ ...project(), resolution: { width: 1080, height: 1920 } }),
        } as unknown as ToolContext,
      );
    expect(() => call(30)).toThrow(/"weekend" does not fit/);
    expect(() => call(30)).toThrow(/largest size that fits this box is sizePercent \d+(\.\d)?/);
    expect(call(8).some((op) => op.type === 'add_text_overlay')).toBe(true);
  });
});
