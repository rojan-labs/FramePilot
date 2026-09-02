/**
 * ADR 0169 — a full-frame cutaway goes IN FRONT; everything else is still refused.
 *
 * ADR 0140 refused every stacked agent picture placement, because the preview
 * flattened picture from every track into one chain and the export composited it,
 * so the editor approved a frame the render did not produce. The refusal was
 * right about the divergence and wrong about its extent: a layer that covers the
 * whole frame opaquely previews EXACTLY as it exports, because "show the
 * front-most clip" and "composite the layers" agree when nothing shows through.
 *
 * What this file pins:
 *
 * - a full-frame placement over existing picture lands on a layer in front of
 *   what it covers, opening one in the SAME patch when there is none;
 * - one batch (and one turn) opens one layer, not one per clip;
 * - a placement that could not preview honestly — cropped, blended, animated —
 *   is still refused, still as a `refusal` rather than bad arguments, still
 *   carrying `picture_over_picture`;
 * - the compound patch applies and inverts as a unit.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { applyPatch, invertPatch, type AnyOperation } from '@framepilot/editor-core';
import { getTool } from '../tool-registry.js';
import { ToolInvocationError, operationsForCall } from '../tool-dispatch.js';
import { assembleEdit } from '../assemble.js';
import { pictureOverlapAcross, tracksCoveredByPictureInFront } from './picture-layers.js';

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
 * A clip the preview cannot show honestly over another is still refused — because
 * for THOSE the export really does fold in what is underneath, and the monitor
 * paints one picture layer.
 */
describe('a stacked placement that is not full-frame opaque is still refused', () => {
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

  it('a CROP is no longer a reason on its own — it is geometry, and this one covers', () => {
    // 0.8 of a 16:9 source in a 16:9 frame is still fitted to full height and 86% of the
    // width... which does NOT contain the base, so it leaks. What changed is the reason
    // given and the way out offered.
    expect(() => move(withCompositing({ crop: { x: 0.1, y: 0, width: 0.8, height: 1 } }))).toThrow(
      /is 1920x1080 and the 1920x1080 frame fits it with \d+px bars/,
    );
  });

  it('names what leaks, by how much, and the exact crop that would close it', () => {
    let message = '';
    try {
      move(withCompositing({ crop: { x: 0.1, y: 0, width: 0.8, height: 1 } }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('clip_a shows through them at export');
    // The source is already the frame's shape, so the leak IS the crop: the move is to put
    // the whole frame back, not to cut more away.
    expect(message).toContain('set_clip_crop on clip_b with crop null');
    expect(message).toContain('cut a hole for it: split at 4s and 10s');
  });

  it('a cover-cropped front is ALLOWED over picture — the placement 0170 exists for', () => {
    // A 16:9 source in a 9:16 project, cropped to the frame's aspect: the fit becomes a
    // cover, nothing shows through, and it lands on its own front layer.
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
    expect(move(portrait)).toEqual([
      { type: 'add_layer', layerId: 'video_cutaway_1', layerType: 'video', atIndex: 0 },
      { type: 'move_clip', clipId: 'clip_b', toTrackId: 'video_cutaway_1', toStart: 4 },
    ]);
  });

  it('a measured 1:1 front over 16:9 picture leaks, and the refusal carries the JSON crop', () => {
    const square = parseProject({
      ...withCompositing({}),
      assets: [
        { id: 'asset_v', path: 'media/a-roll.mp4', kind: 'video', durationSeconds: 60, media: FRAME },
        {
          id: 'asset_v2',
          path: 'media/b-roll.mp4',
          kind: 'video',
          durationSeconds: 60,
          media: { width: 1000, height: 1000 },
        },
      ],
    });
    let message = '';
    try {
      move(square);
    } catch (error) {
      message = (error as Error).message;
    }
    // 1000x1000 fits to 1080x1080 in a 1920x1080 frame: (1920 - 1080) / 2 = 420.
    expect(message).toContain(
      '"b-roll.mp4" is 1000x1000 and the 1920x1080 frame fits it with 420px bars left and ' +
        'right, and clip_a shows through them at export',
    );
    expect(message).toContain(
      'set_clip_crop on clip_b with crop {"x":0,"y":0.21875,"width":1,"height":0.5625}',
    );
  });

  it('an unmeasured stack of DIFFERENT assets is refused, and no crop is suggested', () => {
    const unmeasured = parseProject({
      ...withCompositing({}),
      assets: [
        { id: 'asset_v', path: 'media/a-roll.mp4', kind: 'video', durationSeconds: 60 },
        { id: 'asset_v2', path: 'media/b-roll.mp4', kind: 'video', durationSeconds: 60 },
      ],
    });
    let message = '';
    try {
      move(unmeasured);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('has not been measured, so nothing can tell whether its bars');
    expect(message).not.toContain('set_clip_crop');
    expect(message).toContain('shows an asset\'s orientation and aspect');
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
    expect(move(montage)).toEqual([
      { type: 'add_layer', layerId: 'video_cutaway_1', layerType: 'video', atIndex: 0 },
      { type: 'move_clip', clipId: 'clip_b', toTrackId: 'video_cutaway_1', toStart: 4 },
    ]);
  });

  it('names the blend mode as the reason', () => {
    expect(() => move(withCompositing({ blendMode: 'multiply' }))).toThrow(
      /it blends with what is under it \(blendMode "multiply"\)/,
    );
  });

  it('names transform keyframes as the reason', () => {
    expect(() =>
      move(
        withCompositing({
          keyframes: [{ id: 'k1', time: 0, property: 'scale', value: 0.5 }],
        }),
      ),
    ).toThrow(/it carries transform keyframes/);
  });

  it('states the divergence, the ADR, and BOTH ways out', () => {
    let message = '';
    try {
      move(withCompositing({ blendMode: 'screen' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('The preview shows one picture layer at a time');
    expect(message).toContain('ADR 0169 / SUC-P1');
    expect(message).toContain('put on its own front layer for you');
    expect(message).toContain('split at 4s and 10s and add it on the same track');
  });

  it('reaches the model as `Refused "move_clip":` — never as invalid arguments', () => {
    const note = modelNote(
      'move_clip',
      { clipId: 'clip_b', toTrackId: 'video_2', toStart: 4 },
      withCompositing({ blendMode: 'multiply' }),
    );
    expect(note.startsWith('Refused "move_clip": Refused: ')).toBe(true);
    expect(note).not.toContain('Invalid arguments');
  });

  it('carries `picture_over_picture` as the cause, all the way to the tool boundary', () => {
    try {
      operationsForCall(
        {
          id: 'c1',
          name: 'move_clip',
          arguments: { clipId: 'clip_b', toTrackId: 'video_2', toStart: 4 },
        },
        { project: withCompositing({ blendMode: 'multiply' }) },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ToolInvocationError);
      expect((error as ToolInvocationError).code).toBe('refusal');
      expect((error as ToolInvocationError).refusalCause).toBe('picture_over_picture');
      return;
    }
    throw new Error('move_clip did not refuse');
  });

  it('gives two placements that differ in every visible way the SAME cause', () => {
    // Asset, times and conflicting clip all differ — which is exactly what defeated the
    // prose key. The sentences must differ (they are written to be acted on) and the
    // cause must not.
    const refuse = (blendMode: string, toStart: number): ToolInvocationError => {
      try {
        operationsForCall(
          {
            id: 'c',
            name: 'move_clip',
            arguments: { clipId: 'clip_b', toTrackId: 'video_2', toStart },
          },
          { project: withCompositing({ blendMode }) },
        );
      } catch (error) {
        return error as ToolInvocationError;
      }
      throw new Error('move_clip did not refuse');
    };
    const first = refuse('multiply', 1);
    const second = refuse('screen', 3);
    expect(first.message).not.toBe(second.message);
    expect(first.refusalCause).toBe(second.refusalCause);
  });

  it('a genuinely malformed add_clip is still "Rejected" with the argument text', () => {
    const note = modelNote('add_clip', { trackId: 'video_2' }, baseProject());
    expect(note.startsWith('Rejected "add_clip": Invalid arguments for "add_clip":')).toBe(true);
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
