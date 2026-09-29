/**
 * Where agent picture placements land (ADR 0169, 0170, and ADR 0180's 2026-09-29 amendment).
 *
 * ADR 0140 refused every stacked agent placement and ADR 0169 every one that was not
 * full-frame, because the monitor painted one picture layer. It composites every stack now,
 * so what this file pins is where a placement goes and what is still a real defect:
 *
 * - any placement over existing picture — full-frame, cropped, blended, animated,
 *   unmeasured — lands on a layer in front of what it covers, opening one in the SAME patch
 *   when there is none, and one batch opens one layer, not one per clip;
 * - `add_clip`'s own `crop` (null = the whole picture) is the geometry of a layered look;
 * - a full-frame placement that would swallow a cutaway whole is refused (`hides_a_cutaway`);
 * - `add_stock`'s `cutawaysOnly` placer keeps refusing a cutaway that would not hide what it
 *   covers (`picture_over_picture`);
 * - the compound patch applies and inverts as a unit.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { applyPatch, invertPatch, type AnyOperation } from '@framepilot/editor-core';
import { getTool } from '../tool-registry.js';
import { ToolInvocationError, operationsForCall } from '../tool-dispatch.js';
import { assembleEdit } from '../assemble.js';
import { ToolRefusalError } from '../tool-refusal.js';
import {
  backedByFullFramePicture,
  createPicturePlacer,
  hiddenPictureClips,
  pictureOverlapAcross,
  tracksCoveredByPictureInFront,
  visiblePictureSeconds,
} from './picture-layers.js';

/** The project frame, and every picture asset's measured shape. */
const FRAME = { width: 1920, height: 1080 };

const TEXT_ASSET = '__text__';
const CAPTION_ASSET = '__caption__';

interface ClipSpec {
  readonly id: string;
  readonly assetId: string;
  readonly start: number;
  readonly end: number;
  /** Compositing that makes the clip something other than a full-frame layer. */
  readonly crop?: { x: number; y: number; width: number; height: number };
  readonly blendMode?: string;
  readonly keyframes?: { id: string; time: number; property: string; value: number }[];
}

function clip(trackId: string, spec: ClipSpec) {
  return {
    id: spec.id,
    assetId: spec.assetId,
    start: spec.start,
    end: spec.end,
    trackId,
    sourceStart: 0,
    sourceEnd: spec.end - spec.start,
    effects: [],
    keyframes: spec.keyframes ?? [],
    ...(spec.crop ? { crop: spec.crop } : {}),
    ...(spec.blendMode ? { blendMode: spec.blendMode } : {}),
  };
}

/**
 * Tracks in z-order — index 0 is the visual front, exactly as the export reads
 * them (`render/compiler.py` composites `reversed(picture_by_track)`).
 */
function projectWith(tracks: readonly { id: string; type?: string; clips: ClipSpec[] }[]): Project {
  return parseProject({
    id: 'proj_pic',
    name: 'Picture layers',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      // MEASURED, and measured to the project frame. Coverage is a relation (ADR 0170):
      // two DIFFERENT assets nobody probed are refused because nothing can say whether
      // their bars line up, so an unmeasured fixture would exercise the unmeasured arm
      // rather than the placement rules this file is about. The desktop path measures
      // footage when the engine derives proxies and stock on download, so measured is
      // what production looks like.
      { id: 'asset_v', path: 'media/a-roll.mp4', kind: 'video', durationSeconds: 60, media: FRAME },
      {
        id: 'asset_v2',
        path: 'media/b-roll.mp4',
        kind: 'video',
        durationSeconds: 60,
        media: FRAME,
      },
      { id: 'asset_img', path: 'media/photo.jpg', kind: 'image', media: FRAME },
      { id: 'asset_aud', path: 'media/bed.mp3', kind: 'audio', durationSeconds: 60 },
    ],
    timeline: {
      tracks: tracks.map((track) => ({
        id: track.id,
        ...(track.type ? { type: track.type } : {}),
        clips: track.clips.map((spec) => clip(track.id, spec)),
      })),
      markers: [],
    },
  });
}

/** `video_1` (the front lane) holds `clip_a` 0–10s; `video_2` sits BEHIND it, empty. */
const baseProject = (): Project =>
  projectWith([
    {
      id: 'video_1',
      type: 'video',
      clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
    },
    { id: 'video_2', type: 'video', clips: [] },
    { id: 'overlay_1', type: 'overlay', clips: [] },
    { id: 'audio_1', type: 'audio', clips: [] },
  ]);

describe('pictureOverlapAcross', () => {
  it('reports video landing on another track over existing video, with its z-order slot', () => {
    const hits = pictureOverlapAcross(baseProject(), {
      trackId: 'video_2',
      assetId: 'asset_v2',
      start: 2,
      end: 6,
    });
    expect(hits).toMatchObject([
      { clipId: 'clip_a', trackId: 'video_1', start: 0, end: 10, depth: 0 },
    ]);
    // The covered clip's shape rides along, because deciding coverage needs it (ADR 0170).
    expect(hits[0]?.shaped.source).toEqual(FRAME);
  });

  it('reports an image over video — kind comes from the asset, not the layer', () => {
    const hits = pictureOverlapAcross(baseProject(), {
      trackId: 'video_2',
      assetId: 'asset_img',
      start: 2,
      end: 6,
    });
    expect(hits.map((hit) => hit.clipId)).toEqual(['clip_a']);
  });

  it('ignores overlap on the SAME track — that is the validator’s message to give', () => {
    const hits = pictureOverlapAcross(baseProject(), {
      trackId: 'video_1',
      assetId: 'asset_v2',
      start: 2,
      end: 6,
    });
    expect(hits).toEqual([]);
  });

  it('does not fire for a text overlay, a caption, or an audio bed over picture', () => {
    const project = baseProject();
    for (const assetId of [TEXT_ASSET, CAPTION_ASSET, 'asset_aud']) {
      expect(
        pictureOverlapAcross(project, { trackId: 'overlay_1', assetId, start: 2, end: 6 }),
      ).toEqual([]);
    }
  });

  it('does not fire when the candidate misses the existing picture in time', () => {
    expect(
      pictureOverlapAcross(baseProject(), {
        trackId: 'video_2',
        assetId: 'asset_v2',
        start: 12,
        end: 18,
      }),
    ).toEqual([]);
  });

  it('treats touching edges as free — a cutaway butts against its neighbour', () => {
    expect(
      pictureOverlapAcross(baseProject(), {
        trackId: 'video_2',
        assetId: 'asset_v2',
        start: 10,
        end: 14,
      }),
    ).toEqual([]);
  });

  it('does not count picture on an overlay/audio layer, which composites separately', () => {
    const project = projectWith([
      {
        id: 'overlay_1',
        type: 'overlay',
        clips: [{ id: 'clip_o', assetId: 'asset_v', start: 0, end: 10 }],
      },
      { id: 'video_2', type: 'video', clips: [] },
    ]);
    expect(
      pictureOverlapAcross(project, {
        trackId: 'video_2',
        assetId: 'asset_v2',
        start: 2,
        end: 6,
      }),
    ).toEqual([]);
  });

  it('lets a move_clip candidate ignore its own current position', () => {
    const project = projectWith([
      {
        id: 'video_1',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      { id: 'video_2', type: 'video', clips: [] },
    ]);
    expect(
      pictureOverlapAcross(project, {
        trackId: 'video_2',
        assetId: 'asset_v',
        start: 1,
        end: 11,
        ignoreClipId: 'clip_a',
      }),
    ).toEqual([]);
  });
});

function buildOps(toolName: string, args: Record<string, unknown>, project: Project) {
  const tool = getTool(toolName);
  if (!tool || tool.kind !== 'mutate') throw new Error(`${toolName} is not a mutate tool`);
  return tool.buildOps(args, { project }) as AnyOperation[];
}

/**
 * The note the MODEL reads, assembled exactly as `runAgentCall`'s mutating path
 * assembles it from the thrown `ToolInvocationError` (orchestrator.ts). Built
 * here rather than asserted through a whole streamed run, because the only thing
 * under test is which of the two prefixes the refusal earns.
 */
function modelNote(toolName: string, args: Record<string, unknown>, project: Project): string {
  try {
    operationsForCall({ id: 'c1', name: toolName, arguments: args }, { project });
  } catch (error) {
    const refused = error instanceof ToolInvocationError && error.code === 'refusal';
    const reason = (error as Error).message;
    return refused ? `Refused "${toolName}": ${reason}` : `Rejected "${toolName}": ${reason}`;
  }
  throw new Error(`${toolName} did not refuse`);
}

describe('a full-frame placement over existing picture goes in front', () => {
  it('opens a front layer in the SAME patch when there is none to use', () => {
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_2', assetId: 'asset_v2', start: 2, end: 6, sourceStart: 0 },
      baseProject(),
    );
    expect(ops).toEqual([
      { type: 'add_layer', layerId: 'video_cutaway_1', layerType: 'video', atIndex: 0 },
      {
        type: 'add_clip',
        trackId: 'video_cutaway_1',
        assetId: 'asset_v2',
        start: 2,
        end: 6,
        sourceStart: 0,
        sourceEnd: 4,
      },
    ]);
  });

  it('opens that layer under the graphics in front, never over a sticker or a title', () => {
    // A cutaway covers FOOTAGE. A sticker, a shape or a title on a graphics lane in front of
    // the footage stays in front of the cutaway too: opening the layer at index 0 put the
    // b-roll over them, and the export stacks by index, so they vanished (plan/elements 12 F).
    const project = projectWith([
      {
        id: 'graphics_1',
        type: 'overlay',
        clips: [{ id: 'sticker', assetId: 'asset_img', start: 0, end: 10 }],
      },
      {
        id: 'video_1',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      { id: 'video_2', type: 'video', clips: [] },
    ]);
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_2', assetId: 'asset_v2', start: 2, end: 6, sourceStart: 0 },
      project,
    );
    expect(ops[0]).toEqual({
      type: 'add_layer',
      layerId: 'video_cutaway_1',
      layerType: 'video',
      atIndex: 1,
    });
    const after = applyPatch(project.timeline, {
      patchId: 'p' as never,
      createdBy: 'ai',
      reason: 'test',
      operations: ops,
    });
    expect(after.tracks.map((track) => track.id)).toEqual([
      'graphics_1',
      'video_cutaway_1',
      'video_1',
      'video_2',
    ]);
  });

  it('keeps the lane the model named when that lane is already in front', () => {
    const project = projectWith([
      { id: 'video_over', type: 'video', clips: [] },
      {
        id: 'video_main',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
    ]);
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_over', assetId: 'asset_v2', start: 2, end: 6, sourceStart: 0 },
      project,
    );
    expect(ops.map((op) => op.type)).toEqual(['add_clip']);
    expect((ops[0] as { trackId: string }).trackId).toBe('video_over');
  });

  it('reuses an existing front lane rather than opening another', () => {
    // The model named the lane BEHIND the footage; there is already an empty one
    // in front with room, and opening a third would litter the timeline.
    const project = projectWith([
      { id: 'video_over', type: 'video', clips: [] },
      {
        id: 'video_main',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      { id: 'video_behind', type: 'video', clips: [] },
    ]);
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_behind', assetId: 'asset_v2', start: 2, end: 6, sourceStart: 0 },
      project,
    );
    expect(ops.map((op) => op.type)).toEqual(['add_clip']);
    expect((ops[0] as { trackId: string }).trackId).toBe('video_over');
  });

  it('never lands on a hidden or locked lane, which would render nothing', () => {
    const project = parseProject({
      ...projectWith([
        { id: 'video_over', type: 'video', clips: [] },
        {
          id: 'video_main',
          type: 'video',
          clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
        },
      ]),
      timeline: {
        tracks: [
          { id: 'video_over', type: 'video', clips: [], hidden: true },
          {
            id: 'video_main',
            type: 'video',
            clips: [
              {
                id: 'clip_a',
                assetId: 'asset_v',
                trackId: 'video_main',
                start: 0,
                end: 10,
                sourceStart: 0,
                sourceEnd: 10,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
        markers: [],
      },
    });
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_main', assetId: 'asset_v2', start: 12, end: 16, sourceStart: 0 },
      project,
    );
    // Free span, so nothing is resolved at all — the point is the next case.
    expect(ops.map((op) => op.type)).toEqual(['add_clip']);

    const stacked = buildOps(
      'add_clip',
      { trackId: 'video_main', assetId: 'asset_v2', start: 2, end: 6, sourceStart: 0 },
      project,
    );
    expect(stacked.map((op) => op.type)).toEqual(['add_clip']);
    // `video_main` holds the picture, so the candidate conflicts with nothing across
    // tracks and the validator owns the same-track overlap, as it always did.
    expect((stacked[0] as { trackId: string }).trackId).toBe('video_main');
  });

  it('lays a whole batch onto ONE opened layer', () => {
    const ops = buildOps(
      'add_clips',
      {
        trackId: 'video_2',
        clips: [
          { assetId: 'asset_v2', start: 0, end: 1, sourceStart: 0 },
          { assetId: 'asset_v2', start: 1, end: 2, sourceStart: 0 },
          { assetId: 'asset_img', start: 2, end: 3, sourceStart: 0 },
        ],
      },
      baseProject(),
    );
    expect(ops.filter((op) => op.type === 'add_layer')).toHaveLength(1);
    expect(ops.filter((op) => op.type === 'add_clip')).toHaveLength(3);
    for (const op of ops.filter((o) => o.type === 'add_clip')) {
      expect((op as { trackId: string }).trackId).toBe('video_cutaway_1');
    }
  });

  it('applies and inverts as ONE unit — undo takes the layer back with the clip', () => {
    const project = baseProject();
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_2', assetId: 'asset_v2', start: 2, end: 6, sourceStart: 0 },
      project,
    );
    const result = assembleEdit(project, ops, 'cutaway');
    expect(result.validation.valid).toBe(true);
    const after = applyPatch(project.timeline, result.patch);
    expect(after.tracks[0]?.id).toBe('video_cutaway_1'); // the visual front
    expect(after.tracks[0]?.clips).toHaveLength(1);
    const back = applyPatch(after, invertPatch(project.timeline, result.patch));
    // Byte-identical arrangement: the layer is gone with the clip on it. `revision`
    // is the only field that moves, because it counts applied patches by design.
    expect(back.tracks).toEqual(project.timeline.tracks);
  });

  it('add_clip onto a second video layer in a FREE span still builds its ops', () => {
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_2', assetId: 'asset_v2', start: 12, end: 18, sourceStart: 0 },
      baseProject(),
    );
    expect(ops.map((op) => op.type)).toEqual(['add_clip']);
    expect((ops[0] as { trackId: string }).trackId).toBe('video_2');
  });

  it('a text overlay over picture on another track is untouched', () => {
    const ops = buildOps(
      'add_text_layer',
      { trackId: 'overlay_1', text: 'Hello', start: 2, end: 6 },
      baseProject(),
    );
    expect(ops.length).toBeGreaterThan(0);
  });

  it('move_clip lifts a full-frame clip in front of what it would cover', () => {
    const project = projectWith([
      {
        id: 'video_1',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      {
        id: 'video_2',
        type: 'video',
        clips: [{ id: 'clip_b', assetId: 'asset_v2', start: 20, end: 26 }],
      },
    ]);
    const ops = buildOps(
      'move_clip',
      { clipId: 'clip_b', toTrackId: 'video_2', toStart: 4 },
      project,
    );
    expect(ops).toEqual([
      { type: 'add_layer', layerId: 'video_cutaway_1', layerType: 'video', atIndex: 0 },
      { type: 'move_clip', clipId: 'clip_b', toTrackId: 'video_cutaway_1', toStart: 4 },
    ]);
  });

  it('move_clip to a free destination is unaffected', () => {
    const project = projectWith([
      {
        id: 'video_1',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      {
        id: 'video_2',
        type: 'video',
        clips: [{ id: 'clip_b', assetId: 'asset_v2', start: 20, end: 26 }],
      },
    ]);
    const ops = buildOps(
      'move_clip',
      { clipId: 'clip_b', toTrackId: 'video_2', toStart: 30 },
      project,
    );
    expect(ops).toEqual([
      { type: 'move_clip', clipId: 'clip_b', toTrackId: 'video_2', toStart: 30 },
    ]);
  });

  it('move_clip of an unknown clip is still the validator’s to reject', () => {
    const ops = buildOps(
      'move_clip',
      { clipId: 'clip_zz', toTrackId: 'video_2', toStart: 4 },
      baseProject(),
    );
    expect(ops).toEqual([
      { type: 'move_clip', clipId: 'clip_zz', toTrackId: 'video_2', toStart: 4 },
    ]);
  });
});

/**
 * ADR 0180 (amendment 2026-09-29): the monitor composites every stack, so a placement that
 * does NOT hide what it covers — cropped, letterboxed, blended, animated, masked, unmeasured —
 * is layered in front like any other. Desktop run `88c8b27d` blocked three brief items and
 * the 115% answer on the refusal these tests used to pin.
 */
describe('a stacked placement that is not full-frame goes in front too', () => {
  /** `clip_b` on the BACK lane, carrying whatever makes it non-opaque. */
  const withCompositing = (spec: Omit<ClipSpec, 'id' | 'assetId' | 'start' | 'end'>): Project =>
    projectWith([
      {
        id: 'video_1',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      {
        id: 'video_2',
        type: 'video',
        clips: [{ id: 'clip_b', assetId: 'asset_v2', start: 20, end: 26, ...spec }],
      },
    ]);

  const move = (project: Project): AnyOperation[] =>
    buildOps('move_clip', { clipId: 'clip_b', toTrackId: 'video_2', toStart: 4 }, project);

  const lifted = [
    { type: 'add_layer', layerId: 'video_cutaway_1', layerType: 'video', atIndex: 0 },
    { type: 'move_clip', clipId: 'clip_b', toTrackId: 'video_cutaway_1', toStart: 4 },
  ];

  it.each([
    ['a crop that letterboxes', { crop: { x: 0.1, y: 0, width: 0.8, height: 1 } }],
    ['a blend mode', { blendMode: 'multiply' }],
    ['transform keyframes', { keyframes: [{ id: 'k1', time: 0, property: 'scale', value: 0.5 }] }],
  ] as const)('move_clip layers a clip carrying %s in front of what it covers', (_name, spec) => {
    expect(
      move(withCompositing(spec as Omit<ClipSpec, 'id' | 'assetId' | 'start' | 'end'>)),
    ).toEqual(lifted);
  });

  it('a cover-cropped front still goes in front — the placement 0170 exists for', () => {
    const portrait = parseProject({
      ...projectWith([
        {
          id: 'video_1',
          type: 'video',
          clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
        },
        {
          id: 'video_2',
          type: 'video',
          clips: [
            {
              id: 'clip_b',
              assetId: 'asset_v2',
              start: 20,
              end: 26,
              crop: { x: 0.341797, y: 0, width: 0.316406, height: 1 },
            },
          ],
        },
      ]),
      resolution: { width: 1080, height: 1920 },
    });
    expect(move(portrait)).toEqual(lifted);
  });

  it('a FRESH add whose only problem is its shape gets the cover crop', () => {
    // Run `cc907070`: a 1080x2048 stock clip over a 1080x1920 sequence. The crop is fully
    // determined by the two measured shapes, so the placer applies it, lifts the clip in
    // front, and the `set_clip_crop` rides the same patch.
    const portrait = parseProject({
      id: 'proj_tall',
      name: 'Tall stock',
      version: 1,
      fps: 30,
      resolution: { width: 1080, height: 1920 },
      assets: [
        {
          id: 'asset_p',
          path: 'media/pov.mp4',
          kind: 'video',
          durationSeconds: 60,
          media: { width: 1080, height: 1920 },
        },
        {
          id: 'asset_tall',
          path: 'media/chairlift.mp4',
          kind: 'video',
          durationSeconds: 30,
          media: { width: 1080, height: 2048 },
        },
      ],
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [clip('video_1', { id: 'clip_a', assetId: 'asset_p', start: 0, end: 10 })],
          },
          { id: 'video_2', type: 'video', clips: [] },
        ],
        markers: [],
      },
    });
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_2', assetId: 'asset_tall', start: 2, end: 6, sourceStart: 0 },
      portrait,
    );
    expect(ops.map((op) => op.type)).toEqual(['add_layer', 'add_clip', 'set_clip_crop']);
    expect(ops[0]).toMatchObject({ type: 'add_layer', layerId: 'video_cutaway_1', atIndex: 0 });
    const clipId = (ops[1] as { clipId: string }).clipId;
    expect(ops[1]).toMatchObject({
      type: 'add_clip',
      trackId: 'video_cutaway_1',
      start: 2,
      end: 6,
    });
    // 1080x2048 in a 1080x1920 frame: keep the full width, trim (1 - 1920/2048)/2 top and bottom.
    expect(ops[2]).toEqual({
      type: 'set_clip_crop',
      clipId,
      crop: { x: 0, y: 0.03125, width: 1, height: 0.9375 },
    });
  });

  it('a measured 1:1 clip moved over 16:9 picture keeps its shape, and its own lane', () => {
    const square = parseProject({
      ...withCompositing({}),
      assets: [
        {
          id: 'asset_v',
          path: 'media/a-roll.mp4',
          kind: 'video',
          durationSeconds: 60,
          media: FRAME,
        },
        {
          id: 'asset_v2',
          path: 'media/b-roll.mp4',
          kind: 'video',
          durationSeconds: 60,
          media: { width: 1000, height: 1000 },
        },
      ],
    });
    // A move never writes a crop: the clip already exists and its geometry is the editor's.
    expect(move(square)).toEqual(lifted);
  });

  it('an unmeasured stack of DIFFERENT assets is layered, not refused for want of a shape', () => {
    const unmeasured = parseProject({
      ...withCompositing({}),
      assets: [
        { id: 'asset_v', path: 'media/a-roll.mp4', kind: 'video', durationSeconds: 60 },
        { id: 'asset_v2', path: 'media/b-roll.mp4', kind: 'video', durationSeconds: 60 },
      ],
    });
    expect(move(unmeasured)).toEqual(lifted);
  });

  it('the SAME unmeasured asset stacked on itself is allowed — identical by construction', () => {
    const montage = parseProject({
      ...projectWith([
        {
          id: 'video_1',
          type: 'video',
          clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
        },
        {
          id: 'video_2',
          type: 'video',
          clips: [{ id: 'clip_b', assetId: 'asset_v', start: 20, end: 26 }],
        },
      ]),
      assets: [{ id: 'asset_v', path: 'media/a-roll.mp4', kind: 'video', durationSeconds: 60 }],
    });
    expect(move(montage)).toEqual(lifted);
  });

  it('a genuinely malformed add_clip is still "Rejected" with the argument text', () => {
    const note = modelNote('add_clip', { trackId: 'video_2' }, baseProject());
    expect(note.startsWith('Rejected "add_clip": Invalid arguments for "add_clip":')).toBe(true);
  });
});

/**
 * `add_clip`'s `crop`: the geometry of a layered look, chosen at placement. `null` is the whole
 * picture fitted inside the frame; a rect is a window. Either way the placer layers it in front
 * and writes no cover crop over it.
 */
describe('add_clip with its own crop', () => {
  /** A 9:16 project with the 16:9 A-roll already placed and cover-cropped (the auto-reframe). */
  const portrait = (): Project =>
    parseProject({
      ...projectWith([
        {
          id: 'v_main',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'asset_v',
              start: 0,
              end: 10,
              crop: { x: 0.341797, y: 0, width: 0.316406, height: 1 },
            },
          ],
        },
        // An empty lane BEHIND the A-roll: the placer lifts whatever is named here in front.
        { id: 'v_back', type: 'video', clips: [] },
      ]),
      resolution: { width: 1080, height: 1920 },
    });

  it('crop: null places the same shot WHOLE over its cover-cropped copy — a blurred-fill foreground', () => {
    // The same asset at the same moment from the same source point: without a crop of its
    // own this is "the same frames twice" and refused. Fitted whole it is a different
    // picture, so it lands — in front, with no crop, not even the portrait auto-reframe.
    const ops = buildOps(
      'add_clip',
      { trackId: 'v_back', assetId: 'asset_v', start: 0, end: 10, sourceStart: 0, crop: null },
      portrait(),
    );
    expect(ops.map((op) => op.type)).toEqual(['add_layer', 'add_clip']);
    expect(ops[1]).toMatchObject({ trackId: 'video_cutaway_1', assetId: 'asset_v', start: 0 });
  });

  it('the same shot at the same moment WITHOUT its own crop is still the invisible duplicate', () => {
    const note = modelNote(
      'add_clip',
      { trackId: 'v_back', assetId: 'asset_v', start: 0, end: 10, sourceStart: 0 },
      portrait(),
    );
    expect(note).toMatch(/^Refused "add_clip": .*already shows these same frames/);
  });

  it('a crop equal to the copy already there is the invisible duplicate too', () => {
    const note = modelNote(
      'add_clip',
      {
        trackId: 'v_back',
        assetId: 'asset_v',
        start: 0,
        end: 10,
        sourceStart: 0,
        crop: { x: 0.341797, y: 0, width: 0.316406, height: 1 },
      },
      portrait(),
    );
    expect(note).toContain('already shows these same frames');
  });

  it('a window rect is written as given and buries nothing, even over a cutaway', () => {
    // A full-frame placement over 0–5s would swallow `clip_cut` whole and be refused
    // (hides_a_cutaway). A third-of-the-width window shows the cutaway round it.
    const project = projectWith([
      {
        id: 'video_cutaway_1',
        type: 'video',
        clips: [{ id: 'clip_cut', assetId: 'asset_v2', start: 1, end: 4 }],
      },
      {
        id: 'v_main',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
    ]);
    const panel = { x: 1 / 3, y: 0, width: 1 / 3, height: 1 };
    const ops = buildOps(
      'add_clip',
      { trackId: 'v_main', assetId: 'asset_img', start: 0, end: 5, sourceStart: 0, crop: panel },
      project,
    );
    expect(ops.map((op) => op.type)).toEqual(['add_layer', 'add_clip', 'set_clip_crop']);
    expect(ops[2]).toMatchObject({ type: 'set_clip_crop', crop: panel });
    // …while the same placement full-frame is still the burial the lift refuses.
    expect(
      modelNote(
        'add_clip',
        { trackId: 'v_main', assetId: 'asset_img', start: 0, end: 5, sourceStart: 0 },
        project,
      ),
    ).toMatch(/^Refused "add_clip": /);
  });

  it('the patch applies and inverts as one unit', () => {
    const project = portrait();
    const ops = buildOps(
      'add_clip',
      { trackId: 'v_back', assetId: 'asset_v', start: 0, end: 10, sourceStart: 0, crop: null },
      project,
    );
    const edit = assembleEdit(project, ops, 'blurred-fill foreground');
    expect(edit.validation.valid).toBe(true);
    const applied = applyPatch(project.timeline, edit.patch);
    expect(applied.tracks.map((track) => track.id)).toEqual([
      'video_cutaway_1',
      'v_main',
      'v_back',
    ]);
    expect(applied.tracks[0]?.clips[0]?.crop).toBeUndefined();
    // `revision` counts applied patches by design; the arrangement is byte-identical.
    expect(applyPatch(applied, invertPatch(project.timeline, edit.patch)).tracks).toEqual(
      project.timeline.tracks,
    );
  });
});

/**
 * `add_stock` keeps the cutaway rule: it takes no geometry, so a stock clip that could not hide
 * the footage under it would leave that footage showing round its edges. The refusal names the
 * route that layers it on purpose.
 */
describe('the cutawaysOnly placer (add_stock)', () => {
  const unmeasuredStack = (): Project =>
    parseProject({
      ...projectWith([
        {
          id: 'v_main',
          type: 'video',
          clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
        },
      ]),
      assets: [
        { id: 'asset_v', path: 'media/a-roll.mp4', kind: 'video', durationSeconds: 60 },
        { id: 'asset_v2', path: 'media/b-roll.mp4', kind: 'video', durationSeconds: 60 },
      ],
    });
  const candidate = {
    trackId: '__stock__',
    assetId: 'asset_v2',
    start: 2,
    end: 6,
    compositing: {},
  };

  it('refuses a cutaway that cannot be shown to hide what it covers, as picture_over_picture', () => {
    let error: unknown;
    try {
      createPicturePlacer(unmeasuredStack(), { cutawaysOnly: true }).place(candidate);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ToolRefusalError);
    expect((error as ToolRefusalError).refusalCause).toBe('picture_over_picture');
    const message = (error as Error).message;
    expect(message).toContain('would sit on top of clip_a on v_main');
    expect(message).toContain('has not been measured');
    expect(message).toContain('split at 2s and 6s');
    expect(message).toContain('call add_stock without atSeconds and place it with add_clip');
    // The monitor composites any stack (ADR 0180): the old premise is not the reason.
    expect(message).not.toMatch(/one picture layer|preview/);
  });

  it('the same placement without the option is layered in front', () => {
    const placed = createPicturePlacer(unmeasuredStack()).place(candidate);
    expect(placed.trackId).toBe('video_cutaway_1');
  });

  it('a letterboxed stock clip names its bars, the hole and the add_clip route', () => {
    const square = parseProject({
      ...unmeasuredStack(),
      assets: [
        {
          id: 'asset_v',
          path: 'media/a-roll.mp4',
          kind: 'video',
          durationSeconds: 60,
          media: FRAME,
        },
        {
          id: 'asset_v2',
          path: 'media/b-roll.mp4',
          kind: 'video',
          durationSeconds: 60,
          media: { width: 1000, height: 1000 },
        },
      ],
    });
    // Measured, so the placer crops it to cover — no refusal at all.
    expect(createPicturePlacer(square, { cutawaysOnly: true }).place(candidate).crop).toEqual({
      x: 0,
      y: 0.21875,
      width: 1,
      height: 0.5625,
    });
    // A caller that chose the geometry keeps it, and a cutaway must hide: refused, with bars.
    expect(() =>
      createPicturePlacer(square, { cutawaysOnly: true }).place({
        ...candidate,
        keepGeometry: true,
      }),
    ).toThrow(/is 1000x1000 and the 1920x1080 frame fits it with 420px bars left and right/);
  });
});

describe('tracksCoveredByPictureInFront', () => {
  it('names an empty video track that picture IN FRONT covers end to end', () => {
    const blocked = tracksCoveredByPictureInFront(
      projectWith([
        {
          id: 'video_1',
          type: 'video',
          clips: [
            { id: 'clip_a', assetId: 'asset_v', start: 0, end: 5 },
            { id: 'clip_b', assetId: 'asset_v', start: 5, end: 10 },
          ],
        },
        { id: 'video_2', type: 'video', clips: [] },
        { id: 'overlay_1', type: 'overlay', clips: [] },
        { id: 'audio_1', type: 'audio', clips: [] },
      ]),
    );
    // Only the lane BEHIND the covering picture. `video_1` is in front of everything;
    // overlay and audio composite outside the picture chain and stack freely.
    expect([...blocked]).toEqual(['video_2']);
  });

  it('says nothing about a lane the covering picture sits BEHIND', () => {
    // The same two lanes, z-order reversed: the empty lane is now the front one, so
    // anything placed on it is seen. Under the old time-only rule this reported it as
    // unusable, which is the invitation ADR 0169 had to withdraw in the other direction.
    const blocked = tracksCoveredByPictureInFront(
      projectWith([
        { id: 'video_2', type: 'video', clips: [] },
        {
          id: 'video_1',
          type: 'video',
          clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
        },
      ]),
    );
    expect([...blocked]).toEqual([]);
  });

  it('leaves a track alone when there is a gap, however small', () => {
    const blocked = tracksCoveredByPictureInFront(
      projectWith([
        {
          id: 'video_1',
          type: 'video',
          clips: [
            { id: 'clip_a', assetId: 'asset_v', start: 0, end: 5 },
            { id: 'clip_b', assetId: 'asset_v', start: 5.5, end: 10 },
          ],
        },
        { id: 'video_2', type: 'video', clips: [] },
      ]),
    );
    expect([...blocked]).toEqual([]);
  });

  it('does not count a text overlay sitting on a video track as picture', () => {
    // Kind comes from the asset, exactly as `pictureOverlapAcross` reads it — otherwise
    // a title parked on a video layer would falsely close every other layer.
    const blocked = tracksCoveredByPictureInFront(
      projectWith([
        {
          id: 'video_1',
          type: 'video',
          clips: [{ id: 'clip_t', assetId: TEXT_ASSET, start: 0, end: 10 }],
        },
        { id: 'video_2', type: 'video', clips: [] },
      ]),
    );
    expect([...blocked]).toEqual([]);
  });

  it('blocks nothing on an empty timeline', () => {
    expect([
      ...tracksCoveredByPictureInFront(projectWith([{ id: 'video_1', type: 'video', clips: [] }])),
    ]).toEqual([]);
  });
});

/**
 * ADR 0169 lifts a full-frame placement in FRONT of the picture it covers. Run `137d8fd0`
 * did that thirteen times at t=0 for a sixty-second highlight and finished with 25 tracks,
 * 48 picture clips, and 37 of them never visible — every lift reported `completed`, with a
 * summary that said only which layer had been opened.
 *
 * The rule the lift was missing: covering the BASE is what a cutaway is for; swallowing
 * another cutaway whole is not an edit, it is a clip nobody will ever see.
 */
describe('a lift that would bury a cutaway is refused', () => {
  /** A cutaway 0–5s in front of the A-roll, and an empty lane behind everything. */
  const stacked = (): Project =>
    projectWith([
      {
        id: 'video_cutaway_1',
        type: 'video',
        clips: [{ id: 'clip_cut', assetId: 'asset_v2', start: 0, end: 5 }],
      },
      {
        id: 'v_main',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      { id: 'video_back', type: 'video', clips: [] },
    ]);

  it('refuses, names the buried clip, and gives the moves', () => {
    const note = modelNote(
      'add_clip',
      { trackId: 'video_back', assetId: 'asset_img', start: 0, end: 8, sourceStart: 0 },
      stacked(),
    );
    expect(note).toMatch(/^Refused "add_clip": /);
    expect(note).toContain('"b-roll.mp4" on video_cutaway_1 (0–5s)');
    // The remedy names a tool that exists: it said `remove_clip` once, and there is none.
    expect(note).toContain('delete_clip clip_cut');
    expect(note).not.toContain('remove_clip');
    expect(note).toContain('trim_clip');
    expect(note).toContain('photo.jpg');
  });

  it('carries hides_a_cutaway, so run memory knows which rule said no', () => {
    let cause: unknown;
    try {
      operationsForCall(
        {
          id: 'c1',
          name: 'add_clip',
          arguments: {
            trackId: 'video_back',
            assetId: 'asset_img',
            start: 0,
            end: 8,
            sourceStart: 0,
          },
        },
        { project: stacked() },
      );
    } catch (error) {
      cause = (error as { refusalCause?: unknown }).refusalCause;
    }
    expect(cause).toBe('hides_a_cutaway');
  });

  it('still lifts a placement that covers the A-roll base entirely (ADR 0169 unchanged)', () => {
    const project = projectWith([
      {
        id: 'v_main',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      { id: 'video_back', type: 'video', clips: [] },
    ]);
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_back', assetId: 'asset_v2', start: 0, end: 12, sourceStart: 0 },
      project,
    );
    expect(ops.map((op) => op.type)).toEqual(['add_layer', 'add_clip']);
  });

  it('still lifts a placement that only PARTLY covers a cutaway', () => {
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_back', assetId: 'asset_img', start: 0, end: 3, sourceStart: 0 },
      stacked(),
    );
    expect(ops.map((op) => op.type)).toEqual(['add_layer', 'add_clip']);
  });

  it('does not refuse for a cutaway that was ALREADY buried — an inherited defect is an advisory', () => {
    const project = projectWith([
      {
        id: 'video_cutaway_2',
        type: 'video',
        clips: [{ id: 'clip_top', assetId: 'asset_img', start: 0, end: 6 }],
      },
      {
        id: 'video_cutaway_1',
        type: 'video',
        clips: [{ id: 'clip_cut', assetId: 'asset_v2', start: 1, end: 5 }],
      },
      {
        id: 'v_main',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      { id: 'video_back', type: 'video', clips: [] },
    ]);
    // 0–5.5s swallows clip_cut, which clip_top already hides end to end; a different
    // source point, so the same-frames guard is not what is under test here.
    const ops = buildOps(
      'add_clip',
      { trackId: 'video_back', assetId: 'asset_v', start: 0, end: 5.5, sourceStart: 20 },
      project,
    );
    expect(ops.map((op) => op.type)).toEqual(['add_layer', 'add_clip']);
  });

  it('sees itself: entry 2 of one add_clips cannot bury entry 1', () => {
    const project = projectWith([
      {
        id: 'v_main',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      { id: 'video_back', type: 'video', clips: [] },
    ]);
    const note = modelNote(
      'add_clips',
      {
        trackId: 'video_back',
        clips: [
          { assetId: 'asset_v2', start: 0, end: 5, sourceStart: 0 },
          { assetId: 'asset_img', start: 0, end: 8, sourceStart: 0 },
        ],
      },
      project,
    );
    expect(note).toMatch(/^Refused "add_clips": /);
    expect(note).toContain('drop one of the two from this call');
    expect(note).toContain('"b-roll.mp4" on video_cutaway_1 (0–5s)');
  });
});

/**
 * What run `137d8fd0` produced, in miniature: the A-roll and one stock cutaway both
 * completely under a second stock cutaway placed at the same instant.
 */
describe('hiddenPictureClips', () => {
  const buriedStack = (): Project =>
    projectWith([
      {
        id: 'video_cutaway_2',
        type: 'video',
        clips: [{ id: 'clip_top', assetId: 'asset_img', start: 0, end: 17.3 }],
      },
      {
        id: 'video_cutaway_1',
        type: 'video',
        clips: [{ id: 'clip_mid', assetId: 'asset_v2', start: 0, end: 9.9 }],
      },
      {
        id: 'v_main',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 17.3 }],
      },
    ]);

  it('names every clip nothing ever shows, and not the one in front', () => {
    expect(hiddenPictureClips(buriedStack()).map((clip) => clip.clipId)).toEqual([
      'clip_mid',
      'clip_a',
    ]);
  });

  it('is empty when every clip has a moment of its own', () => {
    expect(hiddenPictureClips(baseProject())).toEqual([]);
  });

  it('measures the visible seconds a lift leaves behind', () => {
    const project = buriedStack();
    const front = project.timeline.tracks[0]?.clips[0];
    const mid = project.timeline.tracks[1]?.clips[0];
    /* v8 ignore next -- the fixture has both */
    if (!front || !mid) throw new Error('fixture');
    expect(visiblePictureSeconds(project, 0, front)).toBeCloseTo(17.3);
    expect(visiblePictureSeconds(project, 1, mid)).toBe(0);
  });
});

/**
 * Picture in front hides what is behind it only when it covers it (ADR 0170's relation). With
 * picture-in-picture a legal placement, "anything in front" would report the A-roll under a
 * window as buried and the lane behind it as unusable.
 */
describe('only picture that hides counts as covering', () => {
  const scaledDown = [{ id: 'k_scale', time: 0, property: 'scale', value: 0.4 }];
  /** A-roll 0–10s, and a picture-in-picture over all of it on a lane in front. */
  const pip = (): Project =>
    projectWith([
      {
        id: 'v_pip',
        type: 'video',
        clips: [{ id: 'clip_pip', assetId: 'asset_v2', start: 0, end: 10, keyframes: scaledDown }],
      },
      {
        id: 'v_main',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
      { id: 'v_back', type: 'video', clips: [] },
    ]);

  it('the A-roll under a picture-in-picture is not buried', () => {
    expect(hiddenPictureClips(pip())).toEqual([]);
    const project = pip();
    const main = project.timeline.tracks[1]?.clips[0];
    /* v8 ignore next -- the fixture has it */
    if (!main) throw new Error('fixture');
    expect(visiblePictureSeconds(project, 1, main)).toBeCloseTo(10);
  });

  it('a lane behind a picture-in-picture alone is not "hidden behind picture"', () => {
    // v_back sits behind the full-frame A-roll, so it is covered; take the A-roll away and
    // only the window is in front of it.
    expect([...tracksCoveredByPictureInFront(pip())]).toEqual(['v_back']);
    const windowOnly = projectWith([
      pip().timeline.tracks[0] as unknown as { id: string; type: string; clips: ClipSpec[] },
      { id: 'v_back', type: 'video', clips: [] },
    ]);
    expect([...tracksCoveredByPictureInFront(windowOnly)]).toEqual([]);
  });

  it('a letterboxed window in front of full-frame picture is backed; the base is not', () => {
    const project = pip();
    const [window, base] = [
      project.timeline.tracks[0]?.clips[0],
      project.timeline.tracks[1]?.clips[0],
    ];
    /* v8 ignore next -- the fixture has both */
    if (!window || !base) throw new Error('fixture');
    expect(backedByFullFramePicture(project, window)).toBe(true);
    expect(backedByFullFramePicture(project, base)).toBe(false);
  });

  it('a window that outlasts the picture behind it is not backed', () => {
    const project = projectWith([
      {
        id: 'v_pip',
        type: 'video',
        clips: [{ id: 'clip_pip', assetId: 'asset_v2', start: 0, end: 12, keyframes: scaledDown }],
      },
      {
        id: 'v_main',
        type: 'video',
        clips: [{ id: 'clip_a', assetId: 'asset_v', start: 0, end: 10 }],
      },
    ]);
    const window = project.timeline.tracks[0]?.clips[0];
    /* v8 ignore next -- the fixture has it */
    if (!window) throw new Error('fixture');
    expect(backedByFullFramePicture(project, window)).toBe(false);
  });
});
