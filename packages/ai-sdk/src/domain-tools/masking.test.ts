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
  CANDIDATE_NEEDS_EDITOR_PICK,
  MASKING_TOOLS,
  UnusableMaskingPayloadError,
  createMaskIntent,
  maskingOpsFromMeasurement,
  removeBackgroundIntent,
} from './masking.js';
import type { MaskCandidate } from '../masking/contracts.js';
import {
  USER_NUMBERS_NOT_TYPED,
  maskGeometrySourceOf,
  unsourcedMaskGeometry,
} from '../masking/geometry-provenance.js';
import type { ToolContext } from '../tool-context.js';
import { overflowingWords } from '../overlay-fit.js';

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
    expect(grade.id).toBe('shot__grade');
  });

  it('leaves the masked grade editable from the Inspector, which writes under its own id', () => {
    const p = project();
    const edit = maskingOpsFromMeasurement(
      'create_mask',
      { ...args, purpose: 'effect', effect: 'darken' },
      { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: FACE },
      ctxOf(p),
    );
    // What the web editor's `setColorGradePatch` sends when the editor moves a grade slider.
    const inspectorEdit = [
      {
        type: 'apply_color_grade',
        clipId: 'shot',
        effect: {
          id: 'shot__grade',
          type: 'color_grade',
          params: { exposure: 0.3 },
          keyframes: [],
        },
      },
    ] as never;
    const clip = clipOf(land(land(p, edit.operations), inspectorEdit));
    const grades = clip.effects.filter((effect) => effect.type === 'color_grade');
    expect(grades).toHaveLength(1);
    expect(grades[0]!.params).toMatchObject({ exposure: 0.3 });
    expect(masksOf(clip)[0]!.target).toEqual({ kind: 'effect', effectId: 'shot__grade' });
  });

  it('blurs a face with the clip blur, and a second face adds a mask to the same blur (E2E.4)', () => {
    const p = project();
    const first = maskingOpsFromMeasurement(
      'create_mask',
      { ...args, purpose: 'effect', effect: 'blur_to_hide' },
      { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: FACE },
      ctxOf(p),
    );
    const once = land(p, first.operations);
    const blurs = clipOf(once).effects.filter((effect) => effect.type === 'blur');
    expect(blurs).toEqual([
      { id: 'shot__blur', type: 'blur', params: { amount: 0.04 }, keyframes: [] },
    ]);
    const other: MaskCandidate = {
      ...FACE,
      candidateId: 'f24_ef56ab78',
      box: { x: 0.7, y: 0.2, width: 0.1, height: 0.2 },
    };
    const second = maskingOpsFromMeasurement(
      'create_mask',
      { ...args, candidateId: other.candidateId, purpose: 'effect', effect: 'blur_to_hide' },
      { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: other },
      ctxOf(once),
    );
    const twice = clipOf(land(once, second.operations));
    expect(twice.effects.filter((effect) => effect.type === 'blur')).toHaveLength(1);
    expect(masksOf(twice).map((mask) => mask.target)).toEqual([
      { kind: 'effect', effectId: 'shot__blur' },
      { kind: 'effect', effectId: 'shot__blur' },
    ]);
  });

  it('refuses an unrenderable effect intent, a second grade, and an effect purpose with no effect', () => {
    const measured = { kind: 'create_mask', precision: 'shape', clipId: 'shot', candidate: FACE };
    expect(() =>
      maskingOpsFromMeasurement(
        'create_mask',
        { ...args, purpose: 'effect', effect: 'grade_match_to' },
        measured,
        ctxOf(project()),
      ),
    ).toThrow(/not available yet/);
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

describe('a candidate the editor was asked to choose', () => {
  const pick = 'pick.f24_ab12cd34';
  const base = { clipId: 'shot', candidateId: pick, precision: 'shape', purpose: 'hide' };

  it('is refused until the editor’s own message names it', () => {
    expect(() => createMaskIntent(base, {})).toThrow(CANDIDATE_NEEDS_EDITOR_PICK);
    expect(() => createMaskIntent(base, { userPickedCandidateIds: ['pick.f24_00000000'] })).toThrow(
      CANDIDATE_NEEDS_EDITOR_PICK,
    );
    expect(createMaskIntent(base, { userPickedCandidateIds: [pick] }).candidateId).toBe(pick);
  });

  it('is the same rule for remove_background, and no rule at all for a resolved id', () => {
    expect(() => removeBackgroundIntent({ clipId: 'shot', candidateId: pick }, {})).toThrow(
      CANDIDATE_NEEDS_EDITOR_PICK,
    );
    expect(
      removeBackgroundIntent(
        { clipId: 'shot', candidateId: pick },
        { userPickedCandidateIds: [pick] },
      ).candidateId,
    ).toBe(pick);
    expect(createMaskIntent({ ...base, candidateId: 'f24_ab12cd34' }, {}).candidateId).toBe(
      'f24_ab12cd34',
    );
  });

  it('carries no number, so a repeat is one guard key', () => {
    expect(CANDIDATE_NEEDS_EDITOR_PICK).not.toMatch(/\d/);
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

  it('fixes a shape to the frame through set_mask_space, the Inspector toggle (MK9.4)', () => {
    const p = project([ellipse]);
    const ops = tool('refine_mask').buildOps!(
      { clipId: 'shot', maskId: 'm1', space: 'frame' },
      ctxOf(p),
    ) as Operation[];
    expect(ops).toEqual([{ type: 'set_mask_space', clipId: 'shot', maskId: 'm1', space: 'frame' }]);
    expect(masksOf(clipOf(land(p, ops)))[0]!.space).toBe('frame');
    // Already there: nothing to change.
    expect(() =>
      tool('refine_mask').buildOps!({ clipId: 'shot', maskId: 'm1', space: 'source' }, ctxOf(p)),
    ).toThrow(/nothing to change/);
    // A cut-out follows the picture: the command's own refusal.
    expect(() =>
      tool('refine_mask').buildOps!(
        { clipId: 'shot', maskId: 'mt', space: 'frame' },
        ctxOf(project([matte])),
      ),
    ).toThrow(/follows the picture/);
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
        // Fits as asked; the box is widened to the title-safe width so it wraps as it measured.
        style: { fontSizePercent: 20, boxWidthPercent: 92 },
      }),
    ]);
    land(p, ops);
  });

  it('fits a title that would run out of the frame instead of letting it', () => {
    // The 2026-09-23 run: a title at a size wider than the frame ran off both sides.
    const p = project([matte]);
    const ops = tool('put_text_behind_subject').buildOps!(
      { clipId: 'shot', text: 'SUPERCALIFRAGILISTIC', style: { sizePercent: 40 } },
      ctxOf(p),
    ) as Operation[];
    const style = (ops[0] as { style: Record<string, unknown> }).style;
    expect(style.boxWidthPercent).toBe(92);
    expect(style.fontSizePercent).toBeLessThan(40);
    expect(overflowingWords({ text: 'SUPERCALIFRAGILISTIC', ...style }, p.resolution)).toEqual([]);
    land(p, ops);
  });

  it('draws a title in a bundled family, and refuses one the export cannot draw', () => {
    const p = project([matte]);
    const ops = tool('put_text_behind_subject').buildOps!(
      {
        clipId: 'shot',
        text: 'MOTION',
        style: { sizePercent: 18, fontFamily: 'Anton', fontWeight: 400 },
      },
      ctxOf(p),
    ) as Operation[];
    expect((ops[0] as { style: Record<string, unknown> }).style).toMatchObject({
      fontFamily: 'Anton',
      fontWeight: 400,
    });
    land(p, ops);
    expect(() =>
      tool('put_text_behind_subject').buildOps!(
        { clipId: 'shot', text: 'MOTION', style: { fontFamily: 'Comic Sans MS' } },
        ctxOf(p),
      ),
    ).toThrow(ZodError);
  });

  it('holds the title for a moment of the shot, not all of it', () => {
    const p = project([matte]);
    const ops = tool('put_text_behind_subject').buildOps!(
      { clipId: 'shot', text: 'MOTION', start: 1, end: 2.5 },
      ctxOf(p),
    ) as Operation[];
    expect(ops[0]).toMatchObject({ type: 'add_text_behind_subject', start: 1, end: 2.5 });
    const landed = land(p, ops);
    const title = landed.timeline.tracks
      .flatMap((t) => t.clips)
      .find((clip) => clip.effects.some((effect) => effect.type === 'text'));
    expect(title).toMatchObject({ start: 1, end: 2.5 });
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

describe('follow_subject', () => {
  const tracking = {
    artifact: { key: SHA('d'), sha256: SHA('e') },
    method: 'position',
    referenceSourceTime: 1,
  };
  const tracked = { kind: 'ellipse', id: 'face', cx: 900, cy: 300, rx: 90, ry: 100, tracking };
  const glow = { kind: 'ellipse', id: 'glow', cx: 900, cy: 300, rx: 140, ry: 150 };

  it('lets a second mask reuse the measured track, reversibly, with the track as its source', () => {
    const p = project([tracked, glow]);
    const ops = tool('follow_subject').buildOps!(
      { clipId: 'shot', maskId: 'face', targetClipId: 'shot', targetMaskId: 'glow' },
      ctxOf(p),
    ) as Operation[];
    expect(ops).toEqual([
      {
        type: 'use_track',
        fromClipId: 'shot',
        fromMaskId: 'face',
        to: { clipId: 'shot', maskId: 'glow' },
      },
    ]);
    expect(maskGeometrySourceOf(ops[0]!)).toEqual({
      kind: 'measurement',
      engine: `track:${SHA('d')}`,
    });
    const masks = masksOf(clipOf(land(p, ops)));
    expect(masks.find((mask) => mask.id === 'glow')?.tracking?.artifact.key).toBe(SHA('d'));
  });

  it('refuses a title following a track (MO-14), an untracked source, and a mask following itself', () => {
    const p = project([tracked, glow]);
    const build = tool('follow_subject').buildOps!;
    expect(() =>
      build({ clipId: 'shot', maskId: 'face', targetClipId: 'unmeasured' }, ctxOf(p)),
    ).toThrow(/cannot follow a tracked subject yet, so nothing was changed/);
    expect(() =>
      build(
        { clipId: 'shot', maskId: 'glow', targetClipId: 'shot', targetMaskId: 'face' },
        ctxOf(p),
      ),
    ).toThrow(/Call track_mask for it first/);
    expect(() =>
      build(
        { clipId: 'shot', maskId: 'face', targetClipId: 'shot', targetMaskId: 'face' },
        ctxOf(p),
      ),
    ).toThrow(/cannot follow itself/);
  });
});

describe('create_shape_mask (MK8)', () => {
  const shapeCall = (
    args: Record<string, unknown>,
    p: Project,
    candidate?: MaskCandidate,
    userNumbers: number[] = [],
  ) =>
    maskingOpsFromMeasurement(
      'create_shape_mask',
      { clipId: 'shot', ...args },
      { kind: 'create_shape_mask', clipId: 'shot', ...(candidate ? { candidate } : {}) },
      ctxOf(p, userNumbers),
    );

  it('is live, host-measured, and every analytic preset lands on the frame, attested', () => {
    expect(tool('create_shape_mask').available).toBe(true);
    const p = project();
    const split = shapeCall({ preset: 'split', side: 'right', edge: 'exact' }, p);
    expect(unsourcedMaskGeometry(split.operations)).toEqual([]);
    expect(maskGeometrySourceOf(split.operations[0]!)).toEqual({ kind: 'frame', preset: 'split' });
    expect(masksOf(clipOf(land(p, split.operations)))[0]).toMatchObject({
      kind: 'linear',
      originX: 960,
      originY: 540,
      angle: 90,
      softnessPx: 0,
    });
    expect(split.target).toBeUndefined();
    const band = masksOf(
      clipOf(land(p, shapeCall({ preset: 'mirror', direction: 'vertical' }, p).operations)),
    )[0];
    expect(band).toMatchObject({ kind: 'band', angle: 90, widthPx: 640 });
    expect((band as { softnessPx: number }).softnessPx).toBeGreaterThan(0);
    const gradient = masksOf(
      clipOf(land(p, shapeCall({ preset: 'gradient', side: 'bottom' }, p).operations)),
    )[0];
    expect(gradient).toMatchObject({
      kind: 'gradient',
      shape: 'linear',
      startY: 1080,
      endY: 0,
      featherOuterPx: 0,
    });
    const radial = masksOf(
      clipOf(land(p, shapeCall({ preset: 'radial_gradient' }, p).operations)),
    )[0];
    expect(radial).toMatchObject({ kind: 'gradient', shape: 'radial', startX: 960, startY: 540 });
  });

  it('draws path presets into a subject box and asks for a spot check of that subject', () => {
    const p = project();
    const edit = shapeCall(
      { candidateId: FACE.candidateId, preset: 'star', count: 6, purpose: 'hide' },
      p,
      FACE,
    );
    expect(maskGeometrySourceOf(edit.operations.find((op) => op.type === 'add_mask')!)).toEqual({
      kind: 'candidate',
      candidateId: FACE.candidateId,
    });
    const [star] = masksOf(clipOf(land(p, edit.operations)));
    expect(star).toMatchObject({ kind: 'path', name: 'Star', invert: true });
    if (star?.kind !== 'path') throw new Error('expected a path');
    expect(star.pathKeyframes[0]!.vertexTypes).toHaveLength(12);
    expect(star.pathKeyframes[0]!.sourceTime).toBe(FACE.sourceTime);
    const xs = star.pathKeyframes[0]!.points.filter((_, index) => index % 6 === 0);
    expect(Math.min(...xs)).toBeCloseTo(768, 6);
    expect(Math.max(...xs)).toBeCloseTo(960, 6);
    expect(edit.target).toMatchObject({ label: 'face', purpose: 'hide' });
  });

  it('builds a rounded frame as two masks and limits an effect with a gradient', () => {
    const p = project();
    const frame = shapeCall({ preset: 'rounded_frame' }, p);
    expect(masksOf(clipOf(land(p, frame.operations))).map((mask) => mask.mode)).toEqual([
      'add',
      'subtract',
    ]);
    expect(() => shapeCall({ preset: 'rounded_frame', purpose: 'hide' }, p)).toThrow(
      /already keeps only its border/,
    );
    const sky = shapeCall({ preset: 'gradient', purpose: 'effect', effect: 'darken' }, p);
    const landed = clipOf(land(p, sky.operations));
    expect(landed.effects.map((effect) => effect.type)).toEqual(['color_grade']);
    expect(masksOf(landed)[0]!.target).toEqual({
      kind: 'effect',
      effectId: landed.effects[0]!.id,
    });
  });

  it('takes a userBox only with numbers the editor typed, and one placement', () => {
    const p = project();
    const args = { preset: 'heart', userBox: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } };
    expect(() => shapeCall(args, p)).toThrow(USER_NUMBERS_NOT_TYPED);
    const typed = shapeCall(args, p, undefined, [25, 25, 50, 50]);
    expect(maskGeometrySourceOf(typed.operations[0]!)).toEqual({ kind: 'user_numbers' });
    expect(() =>
      shapeCall({ ...args, candidateId: FACE.candidateId }, p, FACE, [25, 25, 50, 50]),
    ).toThrow(/not both/);
    expect(() =>
      maskingOpsFromMeasurement(
        'create_shape_mask',
        { clipId: 'shot', preset: 'heart', candidateId: FACE.candidateId },
        { kind: 'create_shape_mask', clipId: 'shot' },
        ctxOf(p),
      ),
    ).toThrow(/different candidate/);
    expect(() =>
      maskingOpsFromMeasurement(
        'create_shape_mask',
        { clipId: 'shot', preset: 'heart' },
        { kind: 'create_mask', clipId: 'shot' },
        ctxOf(p),
      ),
    ).toThrow(UnusableMaskingPayloadError);
  });
});

describe('mask_with_layer (MK8.2)', () => {
  function withTitle(): Project {
    const p = project();
    return {
      ...p,
      timeline: {
        ...p.timeline,
        tracks: [
          {
            id: 't1',
            type: 'video',
            clips: [
              {
                id: 'title',
                assetId: '__text__',
                trackId: 't1',
                start: 0,
                end: 4,
                sourceStart: 0,
                sourceEnd: 4,
                effects: [{ id: 'tx', type: 'text', params: { text: 'HI' }, keyframes: [] }],
                keyframes: [],
              },
            ],
          },
          ...p.timeline.tracks,
        ],
      },
    } as Project;
  }

  it('uses a title as the clip’s mask through the Mask tab’s own command', () => {
    const p = withTitle();
    const ops = tool('mask_with_layer').buildOps!(
      { clipId: 'shot', sourceClipId: 'title', channel: 'luma' },
      ctxOf(p),
    );
    expect(unsourcedMaskGeometry(ops)).toEqual([]);
    const landed = land(p, ops);
    const shot = landed.timeline.tracks[1]!.clips.find((clip) => clip.id === 'shot')!;
    expect(masksOf(shot)[0]).toMatchObject({
      kind: 'layer',
      source: { kind: 'clip', clipId: 'title' },
      channel: 'luma',
    });
  });

  it('refuses no source, two sources, itself and a loop', () => {
    const p = withTitle();
    const build = tool('mask_with_layer').buildOps!;
    expect(() => build({ clipId: 'shot' }, ctxOf(p))).toThrow(/exactly one source/);
    expect(() =>
      build({ clipId: 'shot', sourceClipId: 'title', sourceTrackId: 't1' }, ctxOf(p)),
    ).toThrow(/exactly one source/);
    expect(() => build({ clipId: 'shot', sourceClipId: 'shot' }, ctxOf(p))).toThrow(
      /own track matte/,
    );
    expect(() => build({ clipId: 'shot', sourceTrackId: 'v1' }, ctxOf(p))).toThrow(/lead back/);
  });
});

describe('style_cutout_edge (MK9.2)', () => {
  const cut = [{ id: 'm', kind: 'ellipse', cx: 960, cy: 540, rx: 300, ry: 400 }];

  it('outlines a cut-out with the catalog look, through the Mask tab’s own operation', () => {
    const p = project(cut);
    const ops = tool('style_cutout_edge').buildOps!(
      { clipId: 'shot', style: 'outline', preset: 'sticker-outline', color: '#ff0080' },
      ctxOf(p),
    );
    expect(ops).toEqual([
      {
        type: 'set_clip_edge_style',
        clipId: 'shot',
        kind: 'stroke',
        params: { widthPx: 20, red: 255, green: 0, blue: 128, opacity: 1 },
      },
    ]);
    const shot = land(p, ops).timeline.tracks[0]!.clips[0]!;
    expect(shot.effects.find((effect) => effect.type === 'edge_style')?.params).toMatchObject({
      kind: 'stroke',
      widthPx: 20,
    });
  });

  it('defaults to the first look of the style and removes one that is there', () => {
    const p = project(cut);
    const build = tool('style_cutout_edge').buildOps!;
    const [shadow] = build({ clipId: 'shot', style: 'shadow' }, ctxOf(p));
    expect(shadow).toMatchObject({ kind: 'shadow', params: { offsetXPx: 12, softnessPx: 16 } });
    const styled = land(p, [shadow!]);
    expect(build({ clipId: 'shot', style: 'shadow', remove: true }, ctxOf(styled))).toEqual([
      { type: 'set_clip_edge_style', clipId: 'shot', kind: 'shadow', params: null },
    ]);
  });

  it('refuses a clip with nothing cut out, a preset of another style, and a missing style', () => {
    const build = tool('style_cutout_edge').buildOps!;
    expect(() => build({ clipId: 'shot', style: 'glow' }, ctxOf(project()))).toThrow(
      /no cut-out to style/,
    );
    expect(() =>
      build({ clipId: 'shot', style: 'glow', preset: 'drop-shadow' }, ctxOf(project(cut))),
    ).toThrow(/is not a glow/);
    expect(() =>
      build({ clipId: 'shot', style: 'glow', remove: true }, ctxOf(project(cut))),
    ).toThrow(/no glow to remove/);
  });
});
