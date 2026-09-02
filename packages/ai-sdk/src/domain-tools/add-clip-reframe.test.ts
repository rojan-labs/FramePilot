/**
 * `add_clip` / `add_clips` — automatic fill crop for a portrait sequence (GAP-009 follow-up).
 *
 * The failure these exist for: a talking-head run placed a LANDSCAPE recording in a
 * 1080x1920 portrait project with no crop, so the export pillarboxed, and the run reported
 * success. The renderer FITS (`_place_video_clip` uses `min(tw/w, th/h)`), so bars were not
 * a risk — they were the guaranteed output — and the only mention came from the end-of-run
 * Critic, after every edit had been committed.
 *
 * So the geometry is now decided where the picture lands, in the same turn, deterministically,
 * from measured dimensions only. These tests pin all three halves of that:
 * the maths, the gates that keep it from firing on a guess, and the end-to-end result on a
 * real applied patch.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  invertPatch,
  validatePatch,
  type Operation,
  type Patch,
} from '@framepilot/editor-core';
import { CropRectSchema, type Project } from '@framepilot/timeline-schema';
import { critique } from '../critic.js';
import { getTool } from '../tool-registry.js';
import type { ToolContext } from '../tool-context.js';
import { makeProject } from '../__fixtures__/project.js';
import { MAX_CLIPS_PER_BATCH, coverCropForFrame } from './timeline.js';

/** A 1080x1920 project with an empty video track and a nominated source asset. */
const portraitProject = (
  media: Record<string, unknown> | undefined,
  extra: Partial<Project> = {},
): Project =>
  makeProject({
    resolution: { width: 1080, height: 1920 },
    assets: [
      {
        id: 'src',
        path: 'media/talk.mp4',
        kind: 'video',
        durationSeconds: 300,
        ...(media ? { media } : {}),
      },
    ] as Project['assets'],
    timeline: {
      tracks: [
        { id: 'v_main', type: 'video', clips: [] },
        { id: 'ov_1', type: 'overlay', clips: [] },
        { id: 'a_1', type: 'audio', clips: [] },
      ],
    } as Project['timeline'],
    ...extra,
  });

const place = (project: Project, args: Record<string, unknown>, tool = 'add_clip'): Operation[] => {
  const spec = getTool(tool);
  if (!spec?.buildOps) throw new Error(`no buildOps for ${tool}`);
  const ctx: ToolContext = { project };
  return spec.buildOps(args, ctx) as Operation[];
};

const LANDSCAPE_1080P = { width: 1920, height: 1080 };

describe('coverCropForFrame — the crop that turns "contain" into "cover"', () => {
  it('cuts a 16:9 source to the 9:16 frame, full height, centred', () => {
    // 0.5625 / 1.7778 = 0.31640625 of the source width; the rest is what the bars were.
    expect(coverCropForFrame(LANDSCAPE_1080P, { width: 1080, height: 1920 })).toEqual({
      x: 0.341797,
      y: 0,
      width: 0.316406,
      height: 1,
    });
  });

  it('produces a rect the schema accepts, with the right edge inside the frame', () => {
    for (const source of [
      { width: 1920, height: 1080 },
      { width: 4032, height: 3024 },
      { width: 3840, height: 1600 },
    ]) {
      const crop = coverCropForFrame(source, { width: 1080, height: 1920 });
      expect(CropRectSchema.parse(crop)).toEqual(crop);
      expect(crop!.x + crop!.width).toBeLessThanOrEqual(1);
      // The kept region must carry the target aspect, or the fit that follows still bars.
      const keptAspect = (source.width * crop!.width) / source.height;
      expect(keptAspect).toBeCloseTo(1080 / 1920, 4);
    }
  });

  it('returns nothing when the source is not wider than the frame', () => {
    // Nothing to cut horizontally: a taller-than-target source is a different problem, and
    // cropping its height is a different editorial decision.
    expect(
      coverCropForFrame({ width: 1080, height: 1920 }, { width: 1080, height: 1920 }),
    ).toBeUndefined();
    expect(
      coverCropForFrame({ width: 1080, height: 1440 }, { width: 1080, height: 1080 }),
    ).toBeUndefined();
  });

  it('CAN crop a portrait source that is still wider than the frame', () => {
    // 4:5 in 9:16 letterboxes too, and the maths handles it. `add_clip` deliberately does
    // not USE it there — see the gates below — because padding a 4:5 still is a real
    // editorial choice, not an obvious defect. The Critic warns about it instead.
    expect(coverCropForFrame({ width: 1080, height: 1350 }, { width: 1080, height: 1920 })).toEqual(
      { x: 0.148438, y: 0, width: 0.703125, height: 1 },
    );
  });

  it('refuses a degenerate size rather than dividing by zero', () => {
    expect(
      coverCropForFrame({ width: 0, height: 1080 }, { width: 1080, height: 1920 }),
    ).toBeUndefined();
    expect(
      coverCropForFrame({ width: 1920, height: 1080 }, { width: 1080, height: 0 }),
    ).toBeUndefined();
  });
});

describe('add_clip — measured landscape source in a portrait project', () => {
  it('places the clip AND the crop that makes it fill the frame, in one patch', () => {
    const ops = place(portraitProject(LANDSCAPE_1080P), {
      trackId: 'v_main',
      assetId: 'src',
      start: 0,
      end: 5,
    });
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ type: 'add_clip', trackId: 'v_main', assetId: 'src' });
    const clipId = (ops[0] as { clipId?: string }).clipId;
    expect(clipId).toBeTruthy();
    expect(ops[1]).toEqual({
      type: 'set_clip_crop',
      clipId,
      crop: { x: 0.341797, y: 0, width: 0.316406, height: 1 },
    });
  });

  it('the pair validates, applies, and leaves the clip actually cropped', () => {
    // The end-to-end evidence: a tool that returns a crop for a clip it names in the same
    // patch is only useful if the crop lands on that clip.
    const project = portraitProject(LANDSCAPE_1080P);
    const patch: Patch = {
      patchId: 'p1',
      createdBy: 'agent',
      reason: 'place',
      operations: place(project, { trackId: 'v_main', assetId: 'src', start: 0, end: 5 }),
    };
    expect(validatePatch(project.timeline, patch).valid).toBe(true);
    const after = applyPatch(project.timeline, patch);
    const clip = after.tracks[0]?.clips[0];
    expect(clip?.crop).toEqual({ x: 0.341797, y: 0, width: 0.316406, height: 1 });
  });

  it('is reversible — the inverse removes both the crop and the clip', () => {
    const project = portraitProject(LANDSCAPE_1080P);
    const patch: Patch = {
      patchId: 'p1',
      createdBy: 'agent',
      reason: 'place',
      operations: place(project, { trackId: 'v_main', assetId: 'src', start: 0, end: 5 }),
    };
    const after = applyPatch(project.timeline, patch);
    const back = applyPatch(after, invertPatch(project.timeline, patch));
    expect(back.tracks[0]?.clips).toEqual([]);
  });

  it('satisfies the reframe check that used to fail the same placement', () => {
    // Before: `checkReframeCoverage` failed a measured landscape source sitting uncropped
    // in a portrait frame. The tool now prevents that state from being reachable by accident.
    const project = portraitProject(LANDSCAPE_1080P);
    const timeline = applyPatch(project.timeline, {
      patchId: 'p1',
      createdBy: 'agent',
      reason: 'place',
      operations: place(project, { trackId: 'v_main', assetId: 'src', start: 0, end: 5 }),
    });
    const report = critique({ ...project, timeline }, { minShotCount: 1 });
    expect(report.checks.find((c) => c.id === 'reframe_coverage')).toMatchObject({
      status: 'pass',
    });
  });
});

describe('add_clip — the gates that keep the crop off a guess', () => {
  const plain = (project: Project): Operation[] =>
    place(project, { trackId: 'v_main', assetId: 'src', start: 0, end: 5 });

  it('does nothing when the source was never measured', () => {
    // The rule the whole file is built on: absent dimensions mean unknown, never landscape.
    // Cropping on a guess would cut the wrong axis out of a portrait recording.
    expect(plain(portraitProject(undefined))).toHaveLength(1);
  });

  it('does nothing when only one dimension is known', () => {
    expect(plain(portraitProject({ width: 1920 }))).toHaveLength(1);
  });

  it('does nothing when the source is already portrait', () => {
    expect(plain(portraitProject({ width: 1080, height: 1920 }))).toHaveLength(1);
  });

  it('does nothing in a landscape project — a landscape source there is the ordinary case', () => {
    const project = makeProject({
      assets: [
        { id: 'src', path: 'media/talk.mp4', kind: 'video', media: LANDSCAPE_1080P },
      ] as Project['assets'],
      timeline: { tracks: [{ id: 'v_main', type: 'video', clips: [] }] } as Project['timeline'],
    });
    expect(plain(project)).toHaveLength(1);
  });

  it('does nothing on an overlay track — a picture-in-picture is deliberately not full-bleed', () => {
    const ops = place(portraitProject(LANDSCAPE_1080P), {
      trackId: 'ov_1',
      assetId: 'src',
      start: 0,
      end: 5,
    });
    expect(ops).toHaveLength(1);
  });

  it('does nothing for an unknown track or asset id', () => {
    const project = portraitProject(LANDSCAPE_1080P);
    expect(place(project, { trackId: 'nope', assetId: 'src', start: 0, end: 5 })).toHaveLength(1);
    expect(place(project, { trackId: 'v_main', assetId: 'nope', start: 0, end: 5 })).toHaveLength(
      1,
    );
  });

  it('does nothing for an audio asset that happens to carry dimensions', () => {
    const project = portraitProject(undefined, {
      assets: [
        { id: 'src', path: 'media/m.mp3', kind: 'audio', media: LANDSCAPE_1080P },
      ] as Project['assets'],
    });
    expect(plain(project)).toHaveLength(1);
  });
});

/**
 * ADR 0170 — the placement guard now sees the crop, because the crop is what makes the
 * placement legal.
 *
 * Before this the order was backwards: `picture.place()` was asked about a BARE clip and
 * the reframe crop was applied afterwards, so a landscape source over occupied picture in a
 * portrait project was refused for leaking bars it was never going to have.
 */
describe('add_clip — a reframed landscape source is legal OVER picture', () => {
  /** The portrait project, with the whole first ten seconds already occupied by picture. */
  const occupied = (): Project => {
    const project = portraitProject(LANDSCAPE_1080P);
    return {
      ...project,
      assets: [
        ...project.assets,
        {
          id: 'base',
          path: 'media/base.mp4',
          kind: 'video',
          durationSeconds: 60,
          media: { width: 1080, height: 1920 },
        },
      ] as Project['assets'],
      timeline: {
        ...project.timeline,
        // `v_main` is index 0 — the visual FRONT — and holds the A-roll. `v_back` is the
        // lane the model names, and it sits behind, so the placer has to open one in front.
        tracks: [
          {
            id: 'v_main',
            type: 'video',
            clips: [
              {
                id: 'clip_base',
                assetId: 'base',
                trackId: 'v_main',
                start: 0,
                end: 10,
                sourceStart: 0,
                sourceEnd: 10,
                effects: [],
                keyframes: [],
              },
            ],
          },
          { id: 'v_back', type: 'video', clips: [] },
          ...project.timeline.tracks.slice(1),
        ],
      } as Project['timeline'],
    };
  };

  it('lands on a front layer WITH the cover crop, in one patch, not refused', () => {
    const ops = place(occupied(), { trackId: 'v_back', assetId: 'src', start: 2, end: 6 });
    expect(ops).toHaveLength(3);
    expect(ops[0]).toEqual({
      type: 'add_layer',
      layerId: 'video_cutaway_1',
      layerType: 'video',
      atIndex: 0,
    });
    expect(ops[1]).toMatchObject({ type: 'add_clip', trackId: 'video_cutaway_1', assetId: 'src' });
    expect(ops[2]).toMatchObject({
      type: 'set_clip_crop',
      crop: { x: 0.341797, y: 0, width: 0.316406, height: 1 },
    });
  });

  it('the whole compound validates and applies', () => {
    const project = occupied();
    const patch: Patch = {
      patchId: 'p1',
      createdBy: 'agent',
      reason: 'b-roll',
      operations: place(project, { trackId: 'v_back', assetId: 'src', start: 2, end: 6 }),
    };
    expect(validatePatch(project.timeline, patch).valid).toBe(true);
    const after = applyPatch(project.timeline, patch);
    expect(after.tracks[0]?.clips[0]?.crop).toEqual({
      x: 0.341797,
      y: 0,
      width: 0.316406,
      height: 1,
    });
  });
});

describe('add_clips — the batch follows exactly the same rule', () => {
  it('crops every measured landscape entry and names each clip distinctly', () => {
    const project = portraitProject(LANDSCAPE_1080P);
    const ops = place(
      project,
      {
        trackId: 'v_main',
        clips: [
          { assetId: 'src', start: 0, end: 2 },
          { assetId: 'src', start: 2, end: 4, sourceStart: 10 },
        ],
      },
      'add_clips',
    );
    expect(ops.map((op) => op.type)).toEqual([
      'add_clip',
      'set_clip_crop',
      'add_clip',
      'set_clip_crop',
    ]);
    const ids = ops
      .filter((op) => op.type === 'set_clip_crop')
      .map((op) => (op as { clipId: string }).clipId);
    expect(new Set(ids).size).toBe(2);

    const patch: Patch = {
      patchId: 'p1',
      createdBy: 'agent',
      reason: 'montage',
      operations: ops,
    };
    expect(validatePatch(project.timeline, patch).valid).toBe(true);
    const after = applyPatch(project.timeline, patch);
    expect(after.tracks[0]?.clips.map((clip) => clip.crop?.width)).toEqual([0.316406, 0.316406]);
  });

  it('leaves an unmeasured batch untouched', () => {
    const ops = place(
      portraitProject(undefined),
      {
        trackId: 'v_main',
        clips: [
          { assetId: 'src', start: 0, end: 2 },
          { assetId: 'src', start: 2, end: 4 },
        ],
      },
      'add_clips',
    );
    expect(ops.map((op) => op.type)).toEqual(['add_clip', 'add_clip']);
  });
});

describe('add_clips — a full batch still fits one turn', () => {
  it('produces at most the smaller per-turn operation cap, crops included', () => {
    // The reason `MAX_CLIPS_PER_BATCH` was halved. A placement is no longer one operation:
    // in a portrait project a measured landscape entry carries its crop, so a full batch is
    // 2N. `orchestrator.ts` refuses a turn over 100 operations, and a montage refused
    // wholesale for a crop the model never asked for is the worst of both.
    const ORCHESTRATOR_MAX_OPS_PER_TURN = 100;
    const project = portraitProject(LANDSCAPE_1080P);
    const ops = place(
      project,
      {
        trackId: 'v_main',
        clips: Array.from({ length: MAX_CLIPS_PER_BATCH }, (_, index) => ({
          assetId: 'src',
          start: index,
          end: index + 0.5,
        })),
      },
      'add_clips',
    );
    expect(ops).toHaveLength(MAX_CLIPS_PER_BATCH * 2);
    expect(ops.length).toBeLessThanOrEqual(ORCHESTRATOR_MAX_OPS_PER_TURN);
  });
});
