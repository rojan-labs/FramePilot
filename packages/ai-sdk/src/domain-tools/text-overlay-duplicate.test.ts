/**
 * The same title, twice, is not two titles.
 *
 * `add_text_layer` resolves its own lane, because two DIFFERENT simultaneous elements on
 * one track cannot both exist and the validator's rejection taught the model nothing it
 * could act on. That fallback cannot tell two elements from one element sent twice, and
 * the difference is what the viewer sees.
 *
 * Run `137d8fd0` called it with `text: "Breck, opening weekend", trackId: "v_titles",
 * start: 0, end: 5` and then called it again with exactly those arguments. The lane was
 * busy — with the first one — so the second opened a new overlay layer, and the export
 * composited the headline on top of itself. In the preview it is illegible.
 *
 * Nothing else catches it: a second placement really does change the project, so the
 * run's no-change guard cannot see it, and the two clips share no track so the validator
 * cannot either.
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch, type AnyOperation } from '@framepilot/editor-core';
import type { Project } from '@framepilot/timeline-schema';
import { assembleEdit } from '../assemble.js';
import { getTool } from '../tool-registry.js';
import { makeProject } from '../__fixtures__/project.js';

const TITLE = 'Breck, opening weekend';

function addTitle(project: Project, args: Record<string, unknown> = {}): Project {
  const tool = getTool('add_text_layer');
  if (!tool || tool.kind !== 'mutate') throw new Error('add_text_layer is not a mutate tool');
  const ops = tool.buildOps(
    { trackId: 'v_titles', text: TITLE, start: 0, end: 5, ...args },
    { project },
  ) as AnyOperation[];
  return applyProjectPatch(project, assembleEdit(project, ops, 'title', 'agent').patch);
}

const withTitleTrack = (): Project =>
  makeProject({
    timeline: {
      tracks: [
        { id: 'video_1', type: 'video', clips: [] },
        { id: 'v_titles', type: 'overlay', clips: [] },
      ],
    },
  } as never);

describe('add_text_layer refuses the same title over the same moment', () => {
  it('places the first one', () => {
    const after = addTitle(withTitleTrack());
    const clips = after.timeline.tracks.flatMap((t) => t.clips);
    expect(clips).toHaveLength(1);
  });

  it('refuses the identical second call, and says where the first one is', () => {
    const once = addTitle(withTitleTrack());
    expect(() => addTitle(once)).toThrow(/already on screen/);
    expect(() => addTitle(once)).toThrow(/v_titles/);
  });

  it('refuses it even when the range only overlaps', () => {
    // "The same title again, a frame later" is the same mistake, and the viewer cannot
    // tell the two apart either.
    const once = addTitle(withTitleTrack());
    expect(() => addTitle(once, { start: 2, end: 7 })).toThrow(/already on screen/);
  });

  it('treats whitespace differences as the same title', () => {
    const once = addTitle(withTitleTrack());
    expect(() => addTitle(once, { text: '  Breck,   opening weekend ' })).toThrow(
      /already on screen/,
    );
  });

  it('allows a different title at the same moment — that is what the lane fallback is for', () => {
    const once = addTitle(withTitleTrack());
    const twice = addTitle(once, { text: 'Day one' });
    const overlays = twice.timeline.tracks.flatMap((t) => t.clips);
    expect(overlays.length).toBe(2);
  });

  it('allows the same title again once the first one is over', () => {
    const once = addTitle(withTitleTrack());
    const twice = addTitle(once, { start: 20, end: 25 });
    expect(twice.timeline.tracks.flatMap((t) => t.clips)).toHaveLength(2);
  });
});

/**
 * The same shot at the same moment, twice.
 *
 * The picture placer's job is to find a lane for a clip that collides with picture, and
 * it cannot tell a genuinely new clip from the same clip sent again. Run `137d8fd0`
 * placed `Video_6381282` over 0–9s three times and finished with nineteen video lanes for
 * a sixty-second edit; two of those copies can never be seen.
 */
describe('add_clip refuses the same shot over the same moment', () => {
  const project = (): Project =>
    makeProject({
      assets: [
        { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 },
        { id: 'asset_2', path: 'media/b.mp4', kind: 'video', durationSeconds: 30 },
      ],
      timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
    } as never);

  const place = (p: Project, args: Record<string, unknown> = {}): Project => {
    const tool = getTool('add_clip');
    if (!tool || tool.kind !== 'mutate') throw new Error('add_clip is not a mutate tool');
    const ops = tool.buildOps(
      { trackId: 'video_1', assetId: 'asset_1', start: 0, end: 5, sourceStart: 0, ...args },
      { project: p },
    ) as AnyOperation[];
    return applyProjectPatch(p, assembleEdit(p, ops, 'place', 'agent').patch);
  };

  it('places the first copy', () => {
    expect(place(project()).timeline.tracks.flatMap((t) => t.clips)).toHaveLength(1);
  });

  it('refuses an identical second copy instead of opening a lane for it', () => {
    const once = place(project());
    expect(() => place(once)).toThrow(/already shows these same frames/);
    expect(() => place(once)).toThrow(/a\.mp4/);
  });

  it('allows the same shot at a different moment', () => {
    const once = place(project());
    expect(
      place(once, { start: 10, end: 15 }).timeline.tracks.flatMap((t) => t.clips),
    ).toHaveLength(2);
  });

  it('allows a different shot at the same moment — that is what layering is for', () => {
    const once = place(project());
    expect(
      place(once, { assetId: 'asset_2' }).timeline.tracks.flatMap((t) => t.clips).length,
    ).toBeGreaterThan(1);
  });

  /**
   * The duplicate guard keys on the source range too, so a DIFFERENT moment of the same
   * file at the same instant passes it. It is refused anyway, one layer down: a clip id
   * is derived from track + asset + start, so the second placement collides with the
   * first's id. Documented rather than changed — two moments of one file stacked at one
   * instant is not a placement this product supports, the second is invisible behind the
   * first, and the guard is not the thing saying so.
   */
  it('is still refused from a different point in the file, by the clip-id rule', () => {
    const once = place(project());
    expect(() => place(once, { sourceStart: 12 })).toThrow(/Clip id already exists/);
  });
});

/**
 * The batch has to see itself. `existingPlacement` reads the pre-call timeline, and
 * `add_clips` plans every entry against that one snapshot — which is exactly why its lane
 * allocators are per-call too. Without a per-call booking set, two identical entries in
 * one batch both pass the duplicate check and the allocator dutifully finds each a lane.
 */
describe('add_clips cannot duplicate inside one batch', () => {
  const batch = (entries: readonly Record<string, unknown>[]): Project => {
    const p = makeProject({
      assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 }],
      timeline: { tracks: [{ id: 'video_1', type: 'video', clips: [] }] },
    } as never);
    const tool = getTool('add_clips');
    if (!tool || tool.kind !== 'mutate') throw new Error('add_clips is not a mutate tool');
    const ops = tool.buildOps(
      { trackId: 'video_1', clips: entries },
      { project: p },
    ) as AnyOperation[];
    return applyProjectPatch(p, assembleEdit(p, ops, 'batch', 'agent').patch);
  };

  it('places a batch of distinct spans', () => {
    const after = batch([
      { assetId: 'asset_1', start: 0, end: 5, sourceStart: 0 },
      { assetId: 'asset_1', start: 5, end: 10, sourceStart: 5 },
    ]);
    expect(after.timeline.tracks.flatMap((t) => t.clips)).toHaveLength(2);
  });

  it('refuses a batch that repeats one of its own entries', () => {
    expect(() =>
      batch([
        { assetId: 'asset_1', start: 0, end: 5, sourceStart: 0 },
        { assetId: 'asset_1', start: 0, end: 5, sourceStart: 0 },
      ]),
    ).toThrow(/this call placed it already/);
  });
});

/**
 * The same frames at the same moment, over a DIFFERENT span.
 *
 * The exact-span guard above missed the shape run `137d8fd0` actually produced: asset
 * 6381282 at 0–9.9s from source 0, and then again at 0–28.3s from source 0. The spans
 * differ, so nothing matched — but the first 9.9 seconds are the identical frames at the
 * identical moment, one of them behind the other. What makes two placements the same is
 * the PIN (`sourceStart - start`), not the span.
 *
 * The same run finished with one music file playing 0–60s on two lanes, which is why the
 * sentence has to work for sound too.
 */
describe('add_clip refuses a partial same-frames duplicate', () => {
  const twoLanes = (assets: readonly Record<string, unknown>[]): Project =>
    makeProject({
      assets,
      timeline: {
        tracks: [
          { id: 'video_1', type: 'video', clips: [] },
          { id: 'video_2', type: 'video', clips: [] },
          { id: 'audio_1', type: 'audio', clips: [] },
          { id: 'audio_2', type: 'audio', clips: [] },
        ],
      },
    } as never);

  const PICTURE = [
    { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 60 },
  ] as const;
  const SOUND = [{ id: 'bed', path: 'media/bed.mp3', kind: 'audio', durationSeconds: 60 }] as const;

  const add = (p: Project, args: Record<string, unknown>): Project => {
    const tool = getTool('add_clip');
    if (!tool || tool.kind !== 'mutate') throw new Error('add_clip is not a mutate tool');
    const ops = tool.buildOps(args, { project: p }) as AnyOperation[];
    return applyProjectPatch(p, assembleEdit(p, ops, 'place', 'agent').patch);
  };

  it('refuses a longer second placement that starts on the same frame', () => {
    const once = add(twoLanes(PICTURE), {
      trackId: 'video_1',
      assetId: 'asset_1',
      start: 0,
      end: 9.9,
      sourceStart: 0,
    });
    expect(() =>
      add(once, {
        trackId: 'video_2',
        assetId: 'asset_1',
        start: 0,
        end: 28.3,
        sourceStart: 0,
      }),
    ).toThrow(/already shows these same frames from 0s to 9\.9s, on video_1/);
  });

  it('says "plays" for a music bed, and names the doubling', () => {
    const once = add(twoLanes(SOUND), {
      trackId: 'audio_1',
      assetId: 'bed',
      start: 0,
      end: 60,
      sourceStart: 0,
    });
    let message = '';
    try {
      add(once, { trackId: 'audio_2', assetId: 'bed', start: 10, end: 60, sourceStart: 10 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('already plays these same seconds from 10s to 60s, on audio_1');
    expect(message).toContain('twice as loud');
  });

  it('allows the same file from a DIFFERENT point — that is a real, if strange, edit', () => {
    const once = add(twoLanes(PICTURE), {
      trackId: 'video_1',
      assetId: 'asset_1',
      start: 0,
      end: 10,
      sourceStart: 0,
    });
    const twice = add(once, {
      trackId: 'video_2',
      assetId: 'asset_1',
      start: 2,
      end: 8,
      sourceStart: 30,
    });
    expect(twice.timeline.tracks.flatMap((t) => t.clips)).toHaveLength(2);
  });

  it('does not refuse two placements that merely touch', () => {
    const once = add(twoLanes(SOUND), {
      trackId: 'audio_1',
      assetId: 'bed',
      start: 0,
      end: 10,
      sourceStart: 0,
    });
    const twice = add(once, {
      trackId: 'audio_2',
      assetId: 'bed',
      start: 10,
      end: 20,
      sourceStart: 10,
    });
    expect(twice.timeline.tracks.flatMap((t) => t.clips)).toHaveLength(2);
  });
});
