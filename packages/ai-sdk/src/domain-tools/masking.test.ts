import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  invertPatch,
  validatePatch,
  type Operation,
  type Patch,
} from '@framepilot/editor-core';
import { masksOf, parseProject, type Project } from '@framepilot/timeline-schema';
import { ZodError } from 'zod/v4';
import {
  MASKING_TOOLS,
  UnusableMaskingPayloadError,
  createMaskIntent,
  maskingOpsFromMeasurement,
} from './masking.js';
import type { MaskCandidate } from '../masking/contracts.js';
import {
  USER_NUMBERS_NOT_TYPED,
  maskGeometrySourceOf,
  unsourcedMaskGeometry,
} from '../masking/geometry-provenance.js';
import type { ToolContext } from '../tool-context.js';

const SHA = (seed: string): string => seed.repeat(64).slice(0, 64);

function project(masks: unknown[] = [], effects: unknown[] = []): Project {
  return parseProject({
    id: 'masking_project',
    name: 'Masking fixture',
    version: 1,
    fps: 24,
    resolution: { width: 1920, height: 1080 },
    assets: [
      {
        id: 'asset',
        path: 'shot.mp4',
        kind: 'video',
        durationSeconds: 60,
        media: { width: 1920, height: 1080 },
      },
      { id: 'raw', path: 'raw.mp4', kind: 'video', durationSeconds: 60 },
    ],
    timeline: {
      revision: 3,
      tracks: [
        {
          id: 'v1',
          type: 'video',
          clips: [
            {
              id: 'shot',
              assetId: 'asset',
              trackId: 'v1',
              start: 0,
              end: 4,
              sourceStart: 1,
              sourceEnd: 5,
              effects,
              ...(masks.length === 0 ? {} : { masks }),
              keyframes: [],
            },
            {
              id: 'unmeasured',
              assetId: 'raw',
              trackId: 'v1',
              start: 4,
              end: 8,
              sourceStart: 0,
              sourceEnd: 4,
              effects: [],
              keyframes: [],
            },
          ],
        },
      ],
    },
    transcript: [],
    aiMemory: {},
    history: [],
  });
}

const ctxOf = (p: Project, userNumbers: number[] = []): ToolContext => ({
  project: p,
  userNumbers,
});

const FACE: MaskCandidate = {
  candidateId: 'f24_ab12cd34',
  label: 'face',
  score: 0.92,
  box: { x: 0.4, y: 0.2, width: 0.1, height: 0.2 },
  sourceTime: 2,
  persistence: 1,
};

const artifact = {
  key: SHA('a'),
  files: [{ name: 'matte.mkv', sha256: SHA('b') }],
  width: 1920,
  height: 1080,
  coverage: { sourceStart: 0, sourceEnd: 6 },
  packId: 'framepilot.smart-mask',
  packVersion: '1.0.0',
  modelDigests: [SHA('c')],
};

const track = {
  artifact: { key: SHA('d'), sha256: SHA('e') },
  method: 'position-scale-rotation' as const,
  referenceSourceTime: 2,
  flagged: [{ start: 3, end: 3.5 }],
  frames: 96,
  worstResidualPx: 1.4,
  engine: 'framepilot.tracking-lite@1.2.0',
};

/** Apply as the orchestrator would: validate, apply, and prove the inverse restores. */
function land(p: Project, operations: Operation[]): Project {
  const patch: Patch = { patchId: 'p' as never, createdBy: 'agent', reason: 'test', operations };
  const validation = validatePatch(p.timeline, patch, {
    assetIds: p.assets.map((a) => a.id),
    fps: p.fps,
  });
  expect(validation.issues).toEqual([]);
  const timeline = applyPatch(p.timeline, patch);
  const restored = applyPatch(timeline, invertPatch(p.timeline, patch));
  // The same comparison `validateProfessionalOperationBatch` makes: content, not revision.
  expect(JSON.parse(JSON.stringify({ ...restored, revision: 0 }))).toEqual(
    JSON.parse(JSON.stringify({ ...p.timeline, revision: 0 })),
  );
  return { ...p, timeline };
}

const clipOf = (p: Project, id = 'shot') =>
  p.timeline.tracks[0]!.clips.find((clip) => clip.id === id)!;
const tool = (name: string) => MASKING_TOOLS.find((spec) => spec.name === name)!;

describe('create_mask from a measurement', () => {
  const args = {
    clipId: 'shot',
    candidateId: FACE.candidateId,
    precision: 'shape',
    purpose: 'hide',
    edge: 'soft',
    track: false,
  };

  it('fits the candidate box as the ellipse a face gets, inverted with a margin for hide', () => {
    const p = project();
    const edit = maskingOpsFromMeasurement(
      'create_mask',
      args,
      { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: FACE },
      ctxOf(p),
    );
    const [mask] = masksOf(clipOf(land(p, edit.operations)));
    expect(mask).toMatchObject({ kind: 'ellipse', invert: true });
    if (mask?.kind !== 'ellipse') throw new Error('expected an ellipse');
    expect([mask.cx, mask.cy, mask.rx, mask.ry].map((n) => Math.round(n))).toEqual([
      864, 324, 96, 108,
    ]);
    expect(mask!.expansionPx).toBeGreaterThan(0);
    expect(mask!.featherOuterPx).toBeGreaterThan(0);
    expect(edit.maskId).toBe(mask!.id);
  });

  it('attests every geometry operation to the candidate it came from', () => {
    const edit = maskingOpsFromMeasurement(
      'create_mask',
      args,
      { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: FACE },
      ctxOf(project()),
    );
    expect(unsourcedMaskGeometry(edit.operations)).toEqual([]);
    const add = edit.operations.find((operation) => operation.type === 'add_mask')!;
    expect(maskGeometrySourceOf(add)).toEqual({ kind: 'candidate', candidateId: FACE.candidateId });
  });

  it('attaches a measured track in the same patch and reports its flagged ranges', () => {
    const p = project();
    const edit = maskingOpsFromMeasurement(
      'create_mask',
      { ...args, purpose: 'cutout', track: true },
      { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: FACE, track },
      ctxOf(p),
    );
    const [mask] = masksOf(clipOf(land(p, edit.operations)));
    expect(mask!.tracking).toMatchObject({
      method: 'position-scale-rotation',
      review: { flagged: [{ start: 3, end: 3.5 }] },
    });
    expect(edit.needsReview).toEqual([{ start: 3, end: 3.5 }]);
    expect(edit.trackConfidence).toEqual({ frames: 96, worstResidualPx: 1.4, flaggedCount: 1 });
  });

  it('commits a cut-out through add_matte_mask with the pack flags on the review list', () => {
    const p = project();
    const edit = maskingOpsFromMeasurement(
      'create_mask',
      { ...args, precision: 'cutout', purpose: 'cutout', edge: 'exact' },
      {
        kind: 'create_mask',
        precision: 'cutout',
        clipId: 'shot',
        candidate: FACE,
        artifact,
        needsReview: [{ start: 1, end: 1.2 }],
        verifiedFrames: 90,
        flaggedFrames: 6,
      },
      ctxOf(p),
    );
    const [mask] = masksOf(clipOf(land(p, edit.operations)));
    expect(mask).toMatchObject({
      kind: 'matte',
      edgeMode: 'sharp',
      artifact: { key: artifact.key },
      prompts: [{ kind: 'candidate', candidateId: FACE.candidateId }],
      review: { flagged: [{ start: 1, end: 1.2 }] },
    });
    expect(edit.needsReview).toHaveLength(1);
  });

  it('limits a grade to the mask for an effect purpose', () => {
    const p = project();
    const edit = maskingOpsFromMeasurement(
      'create_mask',
      { ...args, purpose: 'effect', effect: 'darken' },
      { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: FACE },
      ctxOf(p),
    );
    const clip = clipOf(land(p, edit.operations));
    const grade = clip.effects.find((effect) => effect.type === 'color_grade')!;
    expect(grade.params).toMatchObject({ exposure: -0.6 });
    expect(masksOf(clip)[0]!.target).toEqual({ kind: 'effect', effectId: grade.id });
  });

  it('refuses a masked blur, a second grade, and an effect purpose with no effect', () => {
    const measured = { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: FACE };
    expect(() =>
      maskingOpsFromMeasurement(
        'create_mask',
        { ...args, purpose: 'effect', effect: 'blur_to_hide' },
        measured,
        ctxOf(project()),
      ),
    ).toThrow(/not something FramePilot can render yet/);
    expect(() =>
      maskingOpsFromMeasurement(
        'create_mask',
        { ...args, purpose: 'effect' },
        measured,
        ctxOf(project()),
      ),
    ).toThrow(/needs an effect/);
    const graded = project(
      [],
      [{ id: 'g', type: 'color_grade', params: { exposure: 0.1 }, keyframes: [] }],
    );
    expect(() =>
      maskingOpsFromMeasurement(
        'create_mask',
        { ...args, purpose: 'effect', effect: 'darken' },
        measured,
        ctxOf(graded),
      ),
    ).toThrow(/already has a grade/);
  });

  it('never substitutes: a measurement for another clip, candidate or precision is refused', () => {
    const ctx = ctxOf(project());
    expect(() =>
      maskingOpsFromMeasurement(
        'create_mask',
        args,
        { kind: 'create_mask', precision: 'shape', clipId: 'other', candidate: FACE },
        ctx,
      ),
    ).toThrow(/does not answer this request/);
    expect(() =>
      maskingOpsFromMeasurement(
        'create_mask',
        args,
        {
          kind: 'create_mask',
          precision: 'shape',
          clipId: 'shot',
          candidate: { ...FACE, candidateId: 'p1_zz' },
        },
        ctx,
      ),
    ).toThrow(/different candidate/);
    expect(() =>
      maskingOpsFromMeasurement(
        'create_mask',
        args,
        {
          kind: 'create_mask',
          precision: 'shape',
          clipId: 'shot',
          candidate: FACE,
          box: [0, 0, 1, 1],
        },
        ctx,
      ),
    ).toThrow(UnusableMaskingPayloadError);
  });

  it('refuses a path with no measured outline and unmeasured media, each with its remedy', () => {
    expect(() =>
      maskingOpsFromMeasurement(
        'create_mask',
        { ...args, shape: 'path' },
        { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: FACE },
        ctxOf(project()),
      ),
    ).toThrow(/needs a measured outline/);
    expect(() =>
      maskingOpsFromMeasurement(
        'create_mask',
        { ...args, clipId: 'unmeasured' },
        { kind: 'create_mask', precision: 'shape', clipId: 'unmeasured', candidate: FACE },
        ctxOf(project()),
      ),
    ).toThrow(/Measure this media first/);
  });
});

describe('create_mask arguments', () => {
  const shape = { shape: 'rectangle', x: 0.2, y: 0.1, width: 0.5, height: 0.25 };
  const base = { clipId: 'shot', precision: 'shape', purpose: 'cutout' };

  it('admits a userShape only when the editor typed every number', () => {
    expect(
      createMaskIntent({ ...base, userShape: shape }, { userNumbers: [20, 10, 50, 25] }).userShape,
    ).toEqual(shape);
    expect(() =>
      createMaskIntent({ ...base, userShape: shape }, { userNumbers: [20, 10, 50] }),
    ).toThrow(USER_NUMBERS_NOT_TYPED);
    expect(() => createMaskIntent({ ...base, userShape: shape }, {})).toThrow(
      USER_NUMBERS_NOT_TYPED,
    );
  });

  it('builds the typed shape with a user-number source', () => {
    const p = project();
    const edit = maskingOpsFromMeasurement(
      'create_mask',
      { ...base, userShape: shape },
      { kind: 'create_mask', precision: 'shape', clipId: 'shot' },
      ctxOf(p, [20, 10, 50, 25]),
    );
    expect(
      maskGeometrySourceOf(edit.operations.find((operation) => operation.type === 'add_mask')!),
    ).toEqual({ kind: 'user_numbers' });
    expect(masksOf(clipOf(land(p, edit.operations)))[0]).toMatchObject({
      kind: 'rectangle',
      width: 960,
      height: 270,
    });
  });

  it('requires exactly one source, and a candidate for a cut-out', () => {
    expect(() => createMaskIntent(base, {})).toThrow(/needs a candidateId/);
    expect(() =>
      createMaskIntent(
        { ...base, candidateId: 'f1_aa', userShape: shape },
        { userNumbers: [20, 10, 50, 25] },
      ),
    ).toThrow(/not both/);
    expect(() =>
      createMaskIntent(
        { ...base, precision: 'cutout', userShape: shape },
        { userNumbers: [20, 10, 50, 25] },
      ),
    ).toThrow(/needs a candidateId/);
  });

  it('has no argument that carries a coordinate list, and rejects unknown keys', () => {
    expect(() =>
      tool('create_mask').parse({ ...base, candidateId: 'f1_aa', points: [[0, 0]] }),
    ).toThrow(ZodError);
    expect(() =>
      tool('create_mask').parse({ ...base, candidateId: 'f1_aa', bounds: { x: 0 } }),
    ).toThrow(ZodError);
    expect(() => tool('find_mask_targets').parse({ clipId: 'shot' })).toThrow(ZodError);
  });
});

describe('remove_background and track_mask', () => {
  it('commits the main-subject matte with no candidate prompt', () => {
    const p = project();
    const edit = maskingOpsFromMeasurement(
      'remove_background',
      { clipId: 'shot' },
      {
        kind: 'create_mask',
        precision: 'cutout',
        clipId: 'shot',
        artifact,
        needsReview: [],
        verifiedFrames: 96,
        flaggedFrames: 0,
      },
      ctxOf(p),
    );
    expect(masksOf(clipOf(land(p, edit.operations)))[0]).toMatchObject({
      kind: 'matte',
      prompts: [],
      edgeMode: 'smooth',
      invert: false,
    });
    expect(edit.needsReview).toEqual([]);
  });

  it('tracks an existing mask and refuses a measurement for another one', () => {
    const p = project([{ kind: 'ellipse', id: 'm1', cx: 900, cy: 300, rx: 90, ry: 100 }]);
    const edit = maskingOpsFromMeasurement(
      'track_mask',
      { clipId: 'shot', maskId: 'm1' },
      { kind: 'track_mask', clipId: 'shot', maskId: 'm1', track },
      ctxOf(p),
    );
    expect(masksOf(clipOf(land(p, edit.operations)))[0]!.tracking?.artifact.key).toBe(
      track.artifact.key,
    );
    expect(() =>
      maskingOpsFromMeasurement(
        'track_mask',
        { clipId: 'shot', maskId: 'm1' },
        { kind: 'track_mask', clipId: 'shot', maskId: 'm2', track },
        ctxOf(p),
      ),
    ).toThrow(/different mask/);
    expect(() =>
      maskingOpsFromMeasurement(
        'track_mask',
        { clipId: 'shot', maskId: 'gone' },
        { kind: 'track_mask', clipId: 'shot', maskId: 'gone', track },
        ctxOf(p),
      ),
    ).toThrow(/Call get_masks/);
  });
});

describe('in-process masking tools', () => {
  const ellipse = { kind: 'ellipse', id: 'm1', cx: 900, cy: 300, rx: 90, ry: 100 };
  const matte = { kind: 'matte', id: 'mt', artifact, review: { flagged: [{ start: 1, end: 2 }] } };

  it('refines by intent: a looser, very soft, inverted shape', () => {
    const p = project([ellipse]);
    const ops = tool('refine_mask').buildOps!(
      { clipId: 'shot', maskId: 'm1', edge: 'very_soft', grow: 'looser', invert: true },
      ctxOf(p),
    );
    const [mask] = masksOf(clipOf(land(p, ops as Operation[])));
    expect(mask!.expansionPx).toBeCloseTo(10.8);
    expect(mask!.featherOuterPx).toBeCloseTo(32.4);
    expect(mask!.invert).toBe(true);
  });

  it('refines a matte through its own edge controls, never by re-running', () => {
    const p = project([matte]);
    const ops = tool('refine_mask').buildOps!(
      { clipId: 'shot', maskId: 'mt', edge: 'exact', grow: 'tighter' },
      ctxOf(p),
    );
    expect(masksOf(clipOf(land(p, ops as Operation[])))[0]).toMatchObject({
      edgeMode: 'sharp',
      edgeShiftPx: -10.8,
    });
  });

  it('refuses an empty refinement and an unknown mask', () => {
    const p = project([ellipse]);
    expect(() => tool('refine_mask').buildOps!({ clipId: 'shot', maskId: 'm1' }, ctxOf(p))).toThrow(
      /nothing to change/,
    );
    expect(() =>
      tool('refine_mask').buildOps!({ clipId: 'shot', maskId: 'nope', invert: true }, ctxOf(p)),
    ).toThrow(/Call get_masks/);
  });

  it('reads masks compactly and never says verified', () => {
    const rows = tool('get_masks').read!({ clipId: 'shot' }, ctxOf(project([ellipse, matte]))) as {
      masks: Record<string, unknown>[];
    };
    expect(rows.masks).toEqual([
      expect.objectContaining({
        maskId: 'm1',
        kind: 'ellipse',
        target: 'clip',
        tracked: false,
        review: 'none',
        flaggedCount: 0,
      }),
      expect.objectContaining({
        maskId: 'mt',
        kind: 'matte',
        review: 'needs a look',
        flaggedCount: 1,
      }),
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/verified/i);
  });

  it('deletes a mask reversibly', () => {
    const p = project([ellipse]);
    const ops = tool('delete_mask').buildOps!({ clipId: 'shot', maskId: 'm1' }, ctxOf(p));
    expect(masksOf(clipOf(land(p, ops as Operation[])))).toEqual([]);
  });

  it('puts text behind a subject only once the background is removed', () => {
    expect(() =>
      tool('put_text_behind_subject').buildOps!(
        { clipId: 'shot', text: 'HELLO' },
        ctxOf(project()),
      ),
    ).toThrow(/Remove the background on this clip first/);
    const p = project([matte]);
    const ops = tool('put_text_behind_subject').buildOps!(
      { clipId: 'shot', text: 'HELLO', style: { sizePercent: 20 } },
      ctxOf(p),
    ) as Operation[];
    expect(ops).toEqual([
      expect.objectContaining({
        type: 'add_text_behind_subject',
        text: 'HELLO',
        maskId: 'mt',
        style: { fontSizePercent: 20 },
      }),
    ]);
    land(p, ops);
  });
});

describe('model-facing text', () => {
  it('carries no varying number in any refusal a guard could key on', () => {
    const p = project();
    const refusals: string[] = [];
    for (const attempt of [
      () => tool('refine_mask').buildOps!({ clipId: 'nope', maskId: 'm', invert: true }, ctxOf(p)),
      () => tool('delete_mask').buildOps!({ clipId: 'shot', maskId: 'm' }, ctxOf(p)),
    ]) {
      try {
        attempt();
      } catch (error) {
        refusals.push((error as Error).message);
      }
    }
    expect(refusals).toHaveLength(2);
    for (const message of refusals) expect(message).not.toMatch(/\d/);
  });
});
