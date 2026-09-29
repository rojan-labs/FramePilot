/**
 * Layered picture looks, built end to end with the agent's own tools (ADR 0180 amendment
 * 2026-09-29, plan AL34).
 *
 * Desktop run `88c8b27d` blocked a brief's split screen and its "fill the vertical frame"
 * answer on "the preview refuses see-through or scaled picture overlays". The monitor has
 * composited every stack since ADR 0180, so the refusal was the only thing missing. These
 * tests drive the real tool calls through `operationsForCall` (the input contract included),
 * validate and apply every patch, undo the whole chain, and ask the Critic about the result.
 *
 * The finished projects are written to `tests/fixtures/layered-picture/`, where
 * `engine/python/tests/test_layered_picture_render.py` renders them through the export's own
 * compositor and measures the pixels. Regenerate with `FRAMEPILOT_GOLDEN_UPDATE=1`; a changed
 * fixture is a behaviour change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  parseProject,
  type Project,
  type Timeline,
} from '@framepilot/timeline-schema';
import { applyPatch, invertPatch, type Patch } from '@framepilot/editor-core';
import { assembleEdit } from '../assemble.js';
import { critique } from '../critic.js';
import { operationsForCall } from '../tool-dispatch.js';
import { hiddenPictureClips } from './picture-layers.js';

const UPDATE = process.env['FRAMEPILOT_GOLDEN_UPDATE'] === '1';
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/fixtures/layered-picture',
);

/** A 16:9 source, small so the engine renders it quickly. */
const SOURCE = { width: 640, height: 360 };
/** The vertical delivery frame. */
const FRAME = { width: 1080, height: 1920 };

function portraitProject(assetIds: readonly string[]): Project {
  return parseProject({
    id: 'proj_layered',
    name: 'Layered picture',
    version: SCHEMA_VERSION,
    fps: 30,
    resolution: FRAME,
    assets: assetIds.map((id) => ({
      id,
      path: `${id}.mp4`,
      kind: 'video',
      durationSeconds: 1,
      media: SOURCE,
    })),
    timeline: {
      tracks: [
        { id: 'v_main', type: 'video', clips: [] },
        // An empty lane BEHIND the main one, the lane a run most often names.
        { id: 'v_back', type: 'video', clips: [] },
      ],
      markers: [],
    },
  });
}

interface Step {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface Chain {
  readonly project: Project;
  /** Each step's patch and the timeline it applied to, for undo. */
  readonly applied: readonly { readonly before: Timeline; readonly patch: Patch }[];
  readonly opTypes: readonly (readonly string[])[];
}

/** Every step through the real dispatch path, validated, then applied — as the run does it. */
function runChain(start: Project, steps: readonly ((project: Project) => Step)[]): Chain {
  let project = start;
  const applied: { before: Timeline; patch: Patch }[] = [];
  const opTypes: string[][] = [];
  steps.forEach((stepFor, index) => {
    const step = stepFor(project);
    const ops = operationsForCall(
      { id: `c${String(index)}`, name: step.name, arguments: step.arguments },
      { project },
    );
    const edit = assembleEdit(project, ops, step.name);
    expect(edit.validation.valid, `${step.name}: ${JSON.stringify(edit.validation)}`).toBe(true);
    applied.push({ before: project.timeline, patch: edit.patch });
    opTypes.push(ops.map((op) => op.type));
    project = { ...project, timeline: applyPatch(project.timeline, edit.patch) };
  });
  return { project, applied, opTypes };
}

/** Undo the whole chain, newest first. */
function undoAll(chain: Chain): Timeline {
  return [...chain.applied]
    .reverse()
    .reduce(
      (timeline, { before, patch }) => applyPatch(timeline, invertPatch(before, patch)),
      chain.project.timeline,
    );
}

/** The one clip of `assetId` on the given track. */
function clipOn(project: Project, trackIndex: number, assetId: string) {
  const clip = project.timeline.tracks[trackIndex]?.clips.find((c) => c.assetId === assetId);
  if (!clip) throw new Error(`no ${assetId} clip on track ${String(trackIndex)}`);
  return clip;
}

/** Compare with — or, under FRAMEPILOT_GOLDEN_UPDATE, rewrite — the engine's render fixture. */
function matchesFixture(name: string, project: Project): void {
  const file = path.join(FIXTURES, `${name}.json`);
  const text = `${JSON.stringify(project, null, 2)}\n`;
  if (UPDATE) writeFileSync(file, text);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(text));
}

describe('blurred fill: a 16:9 shot fitted whole over a blurred, cover-cropped copy of itself', () => {
  const build = (): Chain =>
    runChain(portraitProject(['wide']), [
      // 1. The shot, placed as any shot is: a portrait project cover-crops a landscape source.
      () => ({
        name: 'add_clip',
        arguments: { trackId: 'v_main', assetId: 'wide', start: 0, end: 1 },
      }),
      // 2. Blur that copy — the background.
      (project) => ({
        name: 'apply_color_grade',
        arguments: {
          clipId: clipOn(project, 0, 'wide').id,
          type: 'blur',
          params: { amount: 0.06 },
        },
      }),
      // 3. The same shot again, whole: fitted inside the frame with transparent bars.
      () => ({
        name: 'add_clip',
        arguments: { trackId: 'v_back', assetId: 'wide', start: 0, end: 1, crop: null },
      }),
    ]);

  it('each step validates, and the foreground lands on its own front layer', () => {
    const chain = build();
    expect(chain.opTypes).toEqual([
      ['add_clip', 'set_clip_crop'],
      ['apply_color_grade'],
      ['add_layer', 'add_clip'],
    ]);
    const tracks = chain.project.timeline.tracks;
    expect(tracks.map((track) => track.id)).toEqual(['video_cutaway_1', 'v_main', 'v_back']);
    const foreground = clipOn(chain.project, 0, 'wide');
    const background = clipOn(chain.project, 1, 'wide');
    // The whole picture, never upscaled: 640x360 fitted to 1080 wide is 1080x607.5.
    expect(foreground.crop).toBeUndefined();
    expect(foreground.keyframes).toEqual([]);
    expect(background.crop).toEqual({ x: 0.341797, y: 0, width: 0.316406, height: 1 });
    expect(background.effects).toEqual([
      { id: `${background.id}__blur`, type: 'blur', params: { amount: 0.06 }, keyframes: [] },
    ]);
  });

  it('undoes to the empty timeline, one patch at a time', () => {
    const chain = build();
    expect(undoAll(chain).tracks).toEqual(portraitProject(['wide']).timeline.tracks);
  });

  it('the Critic sees a filled frame and nothing buried', () => {
    const { project } = build();
    const checks = critique(project).checks;
    expect(checks.find((c) => c.id === 'reframe_coverage')?.status).toBe('pass');
    expect(checks.find((c) => c.id === 'hidden_picture')?.status).toBe('pass');
    expect(hiddenPictureClips(project)).toEqual([]);
  });

  it('the fitted shot WITHOUT the background behind it is still called letterboxed', () => {
    // The exemption is the picture behind, not the missing crop: take the background away
    // and the same foreground renders with black bars, which the check must keep saying.
    const { project } = build();
    const alone: Project = {
      ...project,
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.map((track, index) =>
          index === 1 ? { ...track, clips: [] } : track,
        ),
      },
    };
    expect(critique(alone).checks.find((c) => c.id === 'reframe_coverage')?.status).toBe('fail');
  });

  it('is the project the engine render test measures', () => {
    matchesFixture('blurred-fill', build().project);
  });
});

describe('3-up split screen: three shots, each cropped to a third of the frame and moved', () => {
  /** A 1080x640 panel of a 16:9 source: the full height, 1.6875/1.7778 of the width. */
  const PANEL = { x: 0.025390625, y: 0, width: 0.94921875, height: 1 };
  /** Project pixels from the frame centre to the centre of the top and bottom thirds. */
  const THIRD = FRAME.height / 3;

  const build = (): Chain =>
    runChain(portraitProject(['top', 'middle', 'bottom']), [
      () => ({
        name: 'add_clip',
        arguments: { trackId: 'v_main', assetId: 'middle', start: 0, end: 1, crop: PANEL },
      }),
      () => ({
        name: 'add_clip',
        arguments: { trackId: 'v_back', assetId: 'top', start: 0, end: 1, crop: PANEL },
      }),
      (project) => ({
        name: 'add_keyframes',
        arguments: {
          clipId: clipOn(project, 0, 'top').id,
          keyframes: [{ time: 0, property: 'y', value: -THIRD }],
        },
      }),
      // Lands centred over the middle panel, which it would hide until it is moved — a
      // window being built, not a burial.
      () => ({
        name: 'add_clip',
        arguments: { trackId: 'v_back', assetId: 'bottom', start: 0, end: 1, crop: PANEL },
      }),
      (project) => ({
        name: 'add_keyframes',
        arguments: {
          clipId: clipOn(project, 0, 'bottom').id,
          keyframes: [{ time: 0, property: 'y', value: THIRD }],
        },
      }),
    ]);

  it('each step validates, and each panel gets its own layer', () => {
    const chain = build();
    expect(chain.opTypes).toEqual([
      ['add_clip', 'set_clip_crop'],
      ['add_layer', 'add_clip', 'set_clip_crop'],
      ['add_keyframes'],
      ['add_layer', 'add_clip', 'set_clip_crop'],
      ['add_keyframes'],
    ]);
    expect(chain.project.timeline.tracks.map((track) => track.id)).toEqual([
      'video_cutaway_2',
      'video_cutaway_1',
      'v_main',
      'v_back',
    ]);
    for (const [index, assetId] of [
      [0, 'bottom'],
      [1, 'top'],
      [2, 'middle'],
    ] as const) {
      expect(clipOn(chain.project, index, assetId).crop).toEqual(PANEL);
    }
  });

  it('undoes to the empty timeline', () => {
    const chain = build();
    expect(undoAll(chain).tracks).toEqual(
      portraitProject(['top', 'middle', 'bottom']).timeline.tracks,
    );
  });

  it('no panel is reported buried — each one is moved clear of the others', () => {
    const { project } = build();
    expect(hiddenPictureClips(project)).toEqual([]);
    expect(critique(project).checks.find((c) => c.id === 'hidden_picture')?.status).toBe('pass');
  });

  it('is the project the engine render test measures', () => {
    matchesFixture('split-3up', build().project);
  });
});
