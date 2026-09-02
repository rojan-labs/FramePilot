/**
 * ADR 0140's refusal, extended from stock to every agent picture placement.
 *
 * The defect this pins: the preview flattens picture clips from every track into
 * one chain while the export composites them, so an agent that put video over
 * video on a second layer handed the editor an approval for an edit that does
 * not render. `add_stock` has refused that since ADR 0140; `add_clip`,
 * `add_clips` and `move_clip` did not.
 */
import { describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import { getTool } from '../tool-registry.js';
import { ToolInvocationError, operationsForCall } from '../tool-dispatch.js';
import { pictureOverlapAcross } from './picture-layers.js';
import type { AnyOperation } from '@framepilot/editor-core';

const TEXT_ASSET = '__text__';
const CAPTION_ASSET = '__caption__';

interface ClipSpec {
  readonly id: string;
  readonly assetId: string;
  readonly start: number;
  readonly end: number;
}

function clip(trackId: string, spec: ClipSpec) {
  return {
    ...spec,
    trackId,
    sourceStart: 0,
    sourceEnd: spec.end - spec.start,
    effects: [],
    keyframes: [],
  };
}

/**
 * `video_1` holds `clip_a` (0–10s). Every other track is empty, and each carries a
 * different advisory role so the kind/layer split is exercised by construction.
 */
function projectWith(tracks: readonly { id: string; type?: string; clips: ClipSpec[] }[]): Project {
  return parseProject({
    id: 'proj_pic',
    name: 'Picture layers',
    version: 1,
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [
      { id: 'asset_v', path: 'media/a-roll.mp4', kind: 'video', durationSeconds: 60 },
      { id: 'asset_v2', path: 'media/b-roll.mp4', kind: 'video', durationSeconds: 60 },
      { id: 'asset_img', path: 'media/photo.jpg', kind: 'image' },
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
  it('reports video landing on another track over existing video', () => {
    const hits = pictureOverlapAcross(baseProject(), {
      trackId: 'video_2',
      assetId: 'asset_v2',
      start: 2,
      end: 6,
    });
    expect(hits).toEqual([{ clipId: 'clip_a', trackId: 'video_1', start: 0, end: 10 }]);
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

describe('agent picture placement is refused across tracks', () => {
  it('add_clip onto a second video layer over existing picture is refused, with no ops', () => {
    const project = baseProject();
    expect(() =>
      buildOps(
        'add_clip',
        { trackId: 'video_2', assetId: 'asset_v2', start: 2, end: 6, sourceStart: 0 },
        project,
      ),
    ).toThrow(/Refused: "b-roll\.mp4" at 2–6s would sit on top of clip_a on video_1/);
  });

  it('reaches the model as `Refused "add_clip":` — never as invalid arguments', () => {
    // The whole point of the refusal code. "Invalid arguments" would send the
    // model to fix a `start` that is already correct, and the alternative the
    // sentence names — the cutaway — would go untaken.
    const note = modelNote(
      'add_clip',
      { trackId: 'video_2', assetId: 'asset_v2', start: 2, end: 6, sourceStart: 0 },
      baseProject(),
    );
    expect(note.startsWith('Refused "add_clip": Refused: "b-roll.mp4" at 2–6s')).toBe(true);
    expect(note).not.toContain('Invalid arguments');
    expect(note).not.toContain('Rejected');
  });

  it('move_clip earns the same prefix', () => {
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
    const note = modelNote(
      'move_clip',
      { clipId: 'clip_b', toTrackId: 'video_2', toStart: 4 },
      project,
    );
    expect(note.startsWith('Refused "move_clip": Refused: ')).toBe(true);
    expect(note).not.toContain('Invalid arguments');
  });

  it('a genuinely malformed add_clip is still "Rejected" with the argument text', () => {
    const note = modelNote('add_clip', { trackId: 'video_2' }, baseProject());
    expect(note.startsWith('Rejected "add_clip": Invalid arguments for "add_clip":')).toBe(true);
  });

  it('the refusal names the reason, the ADR, and the cutaway alternative', () => {
    const project = baseProject();
    let message = '';
    try {
      buildOps(
        'add_clip',
        { trackId: 'video_2', assetId: 'asset_v2', start: 2, end: 6, sourceStart: 0 },
        project,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('The preview shows only one picture layer');
    expect(message).toContain('ADR 0140 / SUC-P1');
    expect(message).toContain('split at 2s and 6s and add it on the same track');
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

  it('add_clips refuses the batch when one entry would stack picture', () => {
    expect(() =>
      buildOps(
        'add_clips',
        {
          trackId: 'video_2',
          clips: [
            { assetId: 'asset_v2', start: 12, end: 14, sourceStart: 0 },
            { assetId: 'asset_v2', start: 4, end: 6, sourceStart: 0 },
          ],
        },
        baseProject(),
      ),
    ).toThrow(/would sit on top of clip_a on video_1/);
  });

  it('a text overlay over picture on another track is untouched', () => {
    const ops = buildOps(
      'add_text_layer',
      { trackId: 'overlay_1', text: 'Hello', start: 2, end: 6 },
      baseProject(),
    );
    expect(ops.length).toBeGreaterThan(0);
  });

  it('move_clip into cross-track picture overlap is refused', () => {
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
    expect(() =>
      buildOps('move_clip', { clipId: 'clip_b', toTrackId: 'video_2', toStart: 4 }, project),
    ).toThrow(/would sit on top of clip_a on video_1/);
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
