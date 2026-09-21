import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CreateMaskMeasurementSchema,
  MaskTargetsResultSchema,
  TrackMaskMeasurementSchema,
  maskingOpsFromMeasurement,
  parseCandidateId,
  type HostExecutionContext,
} from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type { CapabilityPackMatteService, MatteRunOutcome } from '../capability-packs/matte.js';
import type { CapabilityPackTrackingService } from '../capability-packs/tracking.js';
import {
  createMaskingExecutor,
  detectionWindows,
  ledgerEvidence,
  type MaskingExecutorOptions,
} from './masking-executor.js';

const FPS = 24;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function openProject(
  seconds = 2,
  masks: unknown[] = [],
): Promise<{ project: Project; projectPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fp-masking-exec-'));
  dirs.push(dir);
  const project = parseProject({
    id: 'masking_exec',
    name: 'Masking executor',
    version: 1,
    fps: FPS,
    resolution: { width: 1920, height: 1080 },
    assets: [
      {
        id: 'asset',
        path: path.join(dir, 'shot.mp4'),
        kind: 'video',
        durationSeconds: 60,
        media: { width: 1920, height: 1080, fps: FPS },
      },
    ],
    timeline: {
      revision: 9,
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
              end: seconds,
              sourceStart: 0,
              sourceEnd: seconds,
              effects: [],
              ...(masks.length === 0 ? {} : { masks }),
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
  return { project, projectPath: path.join(dir, 'project.fp.json') };
}

const IDENTITY = {
  id: 'framepilot.subject-intelligence',
  version: '1.0.0',
  releaseDigest: 'a'.repeat(64),
};
const FACE_BOX = { x: 0.4, y: 0.2, width: 0.1, height: 0.2 };

type Run = CapabilityPackTrackingService['run'];

/** A pack authority that detects one steady face, and measures a plane for any track. */
function tracking(
  calls: string[] = [],
  faces = [FACE_BOX],
): () => Promise<CapabilityPackTrackingService> {
  const run: Run = async (request) => {
    calls.push(request.capability);
    const first = request.media.firstFrame;
    const count = request.media.lastFrameExclusive - first;
    const frames = Array.from({ length: count }, (_, index) => first + index);
    if (request.capability === 'subject.detect') {
      return {
        status: 'completed',
        identity: IDENTITY,
        result: {
          backend: 'opencv',
          modelDigests: [],
          detections: frames.flatMap((frame) =>
            faces.map((box) => ({ frame, label: 'face', box, confidence: 0.9 })),
          ),
        },
      } as never;
    }
    return {
      status: 'completed',
      identity: { ...IDENTITY, id: 'framepilot.tracking-lite' },
      result: {
        backend: 'opencv',
        samples: frames.map((frame, index) => ({
          frame,
          box: FACE_BOX,
          confidence: 0.95,
          occluded: false,
          transform: [1, 0, index * 0.001, 0, 1, 0, 0, 0, 1],
        })),
      },
    } as never;
  };
  return async () => ({ run }) as unknown as CapabilityPackTrackingService;
}

const matte = (
  outcome: MatteRunOutcome,
  seen: unknown[] = [],
  quality: 'fast' | 'best' = 'best',
): (() => Promise<CapabilityPackMatteService>) => {
  return async () =>
    ({
      defaultQuality: async () => quality,
      run: async (intent: unknown, context: { project: Project; projectRevision: number }) => {
        seen.push({ intent, revision: context.projectRevision });
        return outcome;
      },
      cancel: () => undefined,
    }) as unknown as CapabilityPackMatteService;
};

const sha = (c: string): string => c.repeat(64);
const MATTE_DONE: MatteRunOutcome = {
  status: 'completed',
  artifact: {
    key: sha('a'),
    files: [{ name: 'matte.mkv', sha256: sha('b') }],
    width: 1920,
    height: 1080,
    coverage: { sourceStart: 0, sourceEnd: 4 },
    packId: 'framepilot.smart-mask',
    packVersion: '1.0.0',
    modelDigests: [sha('c')],
  },
  summary: { verifiedFrames: 90, flaggedFrames: 6 } as never,
  needsReview: [{ start: 1, end: 1.25, reason: 'estimates_disagree' }] as never,
  executionProvider: 'cpu',
  cacheHit: false,
  projectRevision: 9,
};

function executor(projectPath: string, over: Partial<MaskingExecutorOptions> = {}) {
  return createMaskingExecutor({
    tracking: tracking(),
    matte: matte(MATTE_DONE),
    activeProjectPath: async () => projectPath,
    ...over,
  });
}

const ctxOf = (project: Project): HostExecutionContext => ({ project });

describe('find_mask_targets', () => {
  it('resolves the only face and returns a candidate the contract admits', async () => {
    const { project, projectPath } = await openProject();
    const outcome = await executor(projectPath).run(
      { name: 'find_mask_targets', arguments: { clipId: 'shot', description: 'blur her face' } },
      ctxOf(project),
    );
    expect(outcome.status).toBe('completed');
    const result = MaskTargetsResultSchema.parse(outcome.data);
    expect(result.status).toBe('resolved');
    expect(result.reranker).toBe('none');
    expect(result.chosenCandidateIds).toHaveLength(1);
  });

  it('asks instead of choosing between two faces, and reports it as a warning, not a success', async () => {
    const { project, projectPath } = await openProject();
    const two = [FACE_BOX, { x: 0.7, y: 0.2, width: 0.1, height: 0.2 }];
    const outcome = await executor(projectPath, { tracking: tracking([], two) }).run(
      { name: 'find_mask_targets', arguments: { clipId: 'shot', description: 'blur the face' } },
      ctxOf(project),
    );
    expect(outcome.status).toBe('warning');
    const result = MaskTargetsResultSchema.parse(outcome.data);
    expect(result.status).toBe('ambiguous_target');
    expect(
      result.candidates.every((candidate) => parseCandidateId(candidate.candidateId)?.pickRequired),
    ).toBe(true);
  });

  it('never computes identity without the project’s consent, and does with it', async () => {
    const { project, projectPath } = await openProject();
    let asked = 0;
    const identities = async () => {
      asked += 1;
      return new Map<string, string>();
    };
    const call = {
      name: 'find_mask_targets',
      arguments: { clipId: 'shot', description: 'everyone except the host' },
    };
    await executor(projectPath, {
      evidence: { identities, faceRecognitionConsent: async () => false },
    }).run(call, ctxOf(project));
    expect(asked).toBe(0);
    await executor(projectPath, {
      evidence: { identities, faceRecognitionConsent: async () => true },
    }).run(call, ctxOf(project));
    expect(asked).toBe(1);
  });

  it('uses a re-ranker when the host has one, and says which in the result', async () => {
    const { project, projectPath } = await openProject();
    const rerank: NonNullable<MaskingExecutorOptions['evidence']>['rerank'] = async ({
      candidates,
    }) =>
      new Map(
        candidates.map((candidate, index) => [candidate.candidateId, index === 0 ? 0.9 : 0.2]),
      );
    const outcome = await executor(projectPath, { evidence: { rerank } }).run(
      { name: 'find_mask_targets', arguments: { clipId: 'shot', description: 'her face' } },
      ctxOf(project),
    );
    expect(MaskTargetsResultSchema.parse(outcome.data).reranker).toBe('siglip');
  });

  it('asks the pack for classes and filters objects by them (AM2.5)', async () => {
    const { project, projectPath } = await openProject();
    const sent: unknown[] = [];
    const objects = [
      { box: { x: 0.35, y: 0.45, width: 0.3, height: 0.3 }, class: 'car' },
      { box: { x: 0.7, y: 0.5, width: 0.2, height: 0.2 }, class: 'dog' },
    ];
    const run: Run = async (request) => {
      sent.push(request.parameters);
      const frames = Array.from(
        { length: request.media.lastFrameExclusive - request.media.firstFrame },
        (_, index) => request.media.firstFrame + index,
      );
      return {
        status: 'completed',
        identity: { ...IDENTITY, version: '1.1.0' },
        result: {
          backend: 'opencv',
          modelDigests: [],
          detections: frames.flatMap((frame) =>
            objects.map((thing) => ({
              frame,
              label: 'object',
              box: thing.box,
              confidence: 0.9,
              class: thing.class,
              classScore: 0.95,
            })),
          ),
        },
      } as never;
    };
    const outcome = await executor(projectPath, {
      tracking: async () => ({ run }) as unknown as CapabilityPackTrackingService,
    }).run(
      { name: 'find_mask_targets', arguments: { clipId: 'shot', description: 'the car' } },
      ctxOf(project),
    );
    expect(sent[0]).toMatchObject({ classes: true });
    const result = MaskTargetsResultSchema.parse(outcome.data);
    expect(result.status).toBe('resolved');
    const chosen = result.candidates.find((c) => c.candidateId === result.chosenCandidateIds[0]);
    expect(chosen).toMatchObject({ label: 'object', objectClass: 'car' });
  });

  it('samples a long clip in windows rather than detecting on every frame', () => {
    expect(detectionWindows(0, 100)).toEqual([[0, 100]]);
    const windows = detectionWindows(0, 2400);
    expect(windows).toHaveLength(3);
    expect(windows[0]).toEqual([0, 48]);
    expect(windows[2]![1]).toBe(2400);
  });
});

describe('create_mask', () => {
  async function faceId(
    project: Project,
    projectPath: string,
    run = executor(projectPath),
  ): Promise<string> {
    const outcome = await run.run(
      { name: 'find_mask_targets', arguments: { clipId: 'shot', description: 'her face' } },
      ctxOf(project),
    );
    return MaskTargetsResultSchema.parse(outcome.data).chosenCandidateIds[0]!;
  }

  it('returns a measurement the orchestrator turns into a tracked ellipse, in one patch', async () => {
    const { project, projectPath } = await openProject();
    const calls: string[] = [];
    const run = executor(projectPath, { tracking: tracking(calls) });
    const candidateId = await faceId(project, projectPath, run);
    const args = {
      clipId: 'shot',
      candidateId,
      precision: 'shape',
      purpose: 'hide',
      edge: 'soft',
      track: true,
    };
    const outcome = await run.run({ name: 'create_mask', arguments: args }, ctxOf(project));
    expect(outcome.status).toBe('completed');
    const measurement = CreateMaskMeasurementSchema.parse(outcome.data);
    expect(measurement.precision === 'shape' && measurement.track?.engine).toBe(
      'framepilot.tracking-lite@1.0.0',
    );
    // The mask the host tracked is the mask the orchestrator builds: same id, same patch.
    const edit = maskingOpsFromMeasurement('create_mask', args, outcome.data, { project });
    expect(edit.operations.map((operation) => operation.type)).toEqual([
      'add_mask',
      'update_mask',
      'apply_mask_tracking',
    ]);
    expect(calls.some((capability) => capability.startsWith('tracking.'))).toBe(true);
  });

  it('resolves a recalled id after the cache is gone, by re-detecting the one frame it names', async () => {
    const { project, projectPath } = await openProject();
    const candidateId = await faceId(project, projectPath);
    const calls: string[] = [];
    const fresh = executor(projectPath, { tracking: tracking(calls) });
    const outcome = await fresh.run(
      {
        name: 'create_mask',
        arguments: { clipId: 'shot', candidateId, precision: 'shape', purpose: 'cutout' },
      },
      ctxOf(project),
    );
    expect(outcome.status).toBe('completed');
    expect(calls).toEqual(['subject.detect']);
    expect(CreateMaskMeasurementSchema.parse(outcome.data).candidate?.candidateId).toBe(
      candidateId,
    );
  });

  it('refuses an id nobody measured, without running a job for it', async () => {
    const { project, projectPath } = await openProject();
    const calls: string[] = [];
    const run = executor(projectPath, { tracking: tracking(calls) });
    const invented = await run.run(
      {
        name: 'create_mask',
        arguments: { clipId: 'shot', candidateId: 'face_1', precision: 'shape', purpose: 'hide' },
      },
      ctxOf(project),
    );
    expect(invented.status).toBe('failed');
    expect(invented.summary).toContain('unknown_candidate');
    expect(calls).toEqual([]);
    const gone = await run.run(
      {
        name: 'create_mask',
        arguments: {
          clipId: 'shot',
          candidateId: 'f3_0000beef',
          precision: 'shape',
          purpose: 'hide',
        },
      },
      ctxOf(project),
    );
    expect(gone.status).toBe('failed');
    expect(gone.summary).toContain('no longer found');
  });

  it('resolves a pick id the editor chose, and refuses it with the pick marker stripped (AM5.3)', async () => {
    const { project, projectPath } = await openProject();
    const two = [FACE_BOX, { x: 0.7, y: 0.2, width: 0.1, height: 0.2 }];
    const run = executor(projectPath, { tracking: tracking([], two) });
    const asked = MaskTargetsResultSchema.parse(
      (
        await run.run(
          { name: 'find_mask_targets', arguments: { clipId: 'shot', description: 'the face' } },
          ctxOf(project),
        )
      ).data,
    );
    const pick = asked.candidates[0]!.candidateId;
    expect(parseCandidateId(pick)?.pickRequired).toBe(true);
    const shape = (candidateId: string) => ({
      name: 'create_mask',
      arguments: { clipId: 'shot', candidateId, precision: 'shape', purpose: 'hide' },
    });
    const stripped = await run.run(shape(pick.slice('pick.'.length)), ctxOf(project));
    expect(stripped.status).toBe('failed');
    expect(stripped.summary).toContain('no longer found');
    // The editor's pick resolves from the cache, and after a restart by re-detecting its frame.
    expect((await run.run(shape(pick), ctxOf(project))).status).toBe('completed');
    const restarted = executor(projectPath, { tracking: tracking([], two) });
    const recalled = await restarted.run(shape(pick), ctxOf(project));
    expect(CreateMaskMeasurementSchema.parse(recalled.data).candidate?.candidateId).toBe(pick);
  });

  it('refuses structurally bad arguments with ai-sdk’s own sentence', async () => {
    const { project, projectPath } = await openProject();
    const outcome = await executor(projectPath).run(
      { name: 'create_mask', arguments: { clipId: 'shot', precision: 'shape', purpose: 'hide' } },
      ctxOf(project),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('needs a candidateId');
  });
});

describe('create_shape_mask (MK8)', () => {
  async function faceId(project: Project, projectPath: string): Promise<string> {
    const outcome = await executor(projectPath).run(
      { name: 'find_mask_targets', arguments: { clipId: 'shot', description: 'her face' } },
      ctxOf(project),
    );
    return MaskTargetsResultSchema.parse(outcome.data).chosenCandidateIds[0]!;
  }

  it('echoes the clip for a preset on the frame, running no job', async () => {
    const { project, projectPath } = await openProject();
    const calls: string[] = [];
    const run = executor(projectPath, { tracking: tracking(calls) });
    const args = { clipId: 'shot', preset: 'split', side: 'right' };
    const outcome = await run.run({ name: 'create_shape_mask', arguments: args }, ctxOf(project));
    expect(outcome.status).toBe('completed');
    expect(outcome.data).toEqual({ kind: 'create_shape_mask', clipId: 'shot' });
    expect(calls).toEqual([]);
    const edit = maskingOpsFromMeasurement('create_shape_mask', args, outcome.data, { project });
    expect(edit.operations.map((operation) => operation.type)).toEqual(['add_mask']);
  });

  it('re-resolves the candidate a preset is placed on, and the orchestrator draws it there', async () => {
    const { project, projectPath } = await openProject();
    const candidateId = await faceId(project, projectPath);
    const fresh = executor(projectPath, { tracking: tracking([]) });
    const args = { clipId: 'shot', preset: 'heart', candidateId };
    const outcome = await fresh.run({ name: 'create_shape_mask', arguments: args }, ctxOf(project));
    expect(outcome.status).toBe('completed');
    const data = outcome.data as { candidate?: { candidateId: string } };
    expect(data.candidate?.candidateId).toBe(candidateId);
    const edit = maskingOpsFromMeasurement('create_shape_mask', args, outcome.data, { project });
    expect(edit.target?.label).toBe('face');
    expect(edit.operations[0]!.type).toBe('add_mask');
  });
});

describe('cut-outs', () => {
  it('runs a short job against the RUN’s project revision, not the file on disk', async () => {
    // 0.1 s of clip + handles is still over the confirm threshold on the CPU numbers, so this
    // uses a tiny picture: the estimate scales with pixels.
    const { project, projectPath } = await openProject(0.1);
    const small = {
      ...project,
      assets: project.assets.map((asset) => ({
        ...asset,
        media: { ...asset.media, width: 64, height: 36 },
      })),
    } as Project;
    const seen: { intent: { prompts: unknown[]; timelineRevision: number }; revision: number }[] =
      [];
    const outcome = await executor(projectPath, { matte: matte(MATTE_DONE, seen) }).run(
      { name: 'remove_background', arguments: { clipId: 'shot' } },
      ctxOf(small),
    );
    expect(outcome.status).toBe('completed');
    expect(seen[0]?.revision).toBe(9);
    expect(seen[0]?.intent.timelineRevision).toBe(9);
    expect(seen[0]?.intent.prompts).toEqual([]);
    const measurement = CreateMaskMeasurementSchema.parse(outcome.data);
    expect(measurement.precision === 'cutout' && measurement.needsReview).toEqual([
      { start: 1, end: 1.25 },
    ]);
  });

  it('hands a long job to the editor instead of starting it, with the exact intent and no number in the sentence', async () => {
    const { project, projectPath } = await openProject(4);
    const seen: unknown[] = [];
    const outcome = await executor(projectPath, { matte: matte(MATTE_DONE, seen) }).run(
      { name: 'remove_background', arguments: { clipId: 'shot' } },
      ctxOf(project),
    );
    expect(outcome.status).toBe('failed');
    expect(seen).toEqual([]);
    expect(outcome.summary).not.toMatch(/\d/);
    expect(outcome.data).toMatchObject({
      code: 'needs_editor_start',
      job: { assetId: 'asset', clipId: 'shot', sourceStart: 0, sourceEnd: 6, prompts: [] },
    });
    expect((outcome.data as { estimateSeconds: number }).estimateSeconds).toBeGreaterThan(600);
  });

  it('judges the cost by the engine that will run: the same clip starts when Fast is available (ADR 0182)', async () => {
    const { project, projectPath } = await openProject(4);
    const seen: unknown[] = [];
    const outcome = await executor(projectPath, { matte: matte(MATTE_DONE, seen, 'fast') }).run(
      { name: 'remove_background', arguments: { clipId: 'shot' } },
      ctxOf(project),
    );
    expect(outcome.status).not.toBe('failed');
    expect(seen).toHaveLength(1);
  });

  it('carries a missing pack’s signed proposal to the install card, for every pack it uses', async () => {
    const proposal = { ok: true, proposal: { proposalId: 'p', displayName: 'Pack' } };
    const { project, projectPath } = await openProject(0.1, [
      { kind: 'ellipse', id: 'm1', cx: 900, cy: 400, rx: 120, ry: 160 },
    ]);
    const small = {
      ...project,
      assets: project.assets.map((asset) => ({
        ...asset,
        media: { ...asset.media, width: 64, height: 36 },
      })),
    } as Project;
    const missing = async () =>
      ({
        run: async () => ({ status: 'pack_missing', proposal }),
      }) as unknown as CapabilityPackTrackingService;
    // Subject Intelligence (detection), Tracking Lite (tracks), Smart Mask (mattes).
    const detect = await executor(projectPath, { tracking: missing }).run(
      { name: 'find_mask_targets', arguments: { clipId: 'shot', description: 'her face' } },
      ctxOf(project),
    );
    const track = await executor(projectPath, { tracking: missing }).run(
      { name: 'track_mask', arguments: { clipId: 'shot', maskId: 'm1' } },
      ctxOf(project),
    );
    const cut = await executor(projectPath, {
      matte: matte({ status: 'pack_missing', proposal } as never),
    }).run({ name: 'remove_background', arguments: { clipId: 'shot' } }, ctxOf(small));
    for (const outcome of [detect, track, cut]) {
      expect(outcome.status).toBe('failed');
      expect(outcome.data).toEqual({ code: 'pack_missing', proposal });
      expect(outcome.summary).toContain('do not call');
    }
  });
});

describe('track_mask', () => {
  it('tracks an existing mask and returns flagged ranges and the residual', async () => {
    const { project, projectPath } = await openProject(2, [
      { kind: 'ellipse', id: 'm1', cx: 900, cy: 400, rx: 120, ry: 160 },
    ]);
    const outcome = await executor(projectPath).run(
      { name: 'track_mask', arguments: { clipId: 'shot', maskId: 'm1' } },
      ctxOf(project),
    );
    expect(outcome.status).toBe('completed');
    const measurement = TrackMaskMeasurementSchema.parse(outcome.data);
    expect(measurement.track.frames).toBeGreaterThan(1);
    expect(measurement.track.worstResidualPx).toBeGreaterThanOrEqual(0);
  });

  it('refuses a mask the clip does not have, and a tool that is not its own', async () => {
    const { project, projectPath } = await openProject();
    const missing = await executor(projectPath).run(
      { name: 'track_mask', arguments: { clipId: 'shot', maskId: 'nope' } },
      ctxOf(project),
    );
    expect(missing.summary).toContain('unknown_mask');
    expect(missing.summary).toContain('get_masks');
    const misrouted = await executor(projectPath).run(
      { name: 'trim_clip', arguments: {} },
      ctxOf(project),
    );
    expect(misrouted.summary).toContain('routing_error');
  });
});

describe('ledger evidence', () => {
  const clip = { sourceStart: 10, sourceEnd: 14 } as never;
  const shot = (assetId: string, t0: number, t1: number, value: string, p: number) =>
    ({
      assetId,
      contentHash: 'h',
      shotIndex: 0,
      t0,
      t1,
      keyframeT: t0,
      splitOf: false,
      labelled: { tier1Version: 1, model: 'm', subjectKind: { value, p }, faces: 0, entities: [] },
    }) as never;
  const ledgerOf = (shots: never[]) => ({ shots, digests: [], coverage: {} }) as never;

  it('takes the kind the shots the clip SHOWS most agree on', () => {
    const ledger = ledgerOf([
      shot('asset', 9, 12, 'person', 0.9),
      shot('asset', 12, 15, 'person', 0.7),
      shot('asset', 11, 13, 'vehicle', 0.8),
    ]);
    expect(ledgerEvidence({ ledger }, { assetId: 'asset', clip })).toEqual({
      ledgerSubjectKind: 'person',
    });
  });

  it('has no opinion without a ledger, a confident label, or a shot of this clip', () => {
    expect(ledgerEvidence({}, { assetId: 'asset', clip })).toEqual({});
    expect(ledgerEvidence({ ledger: null }, { assetId: 'asset', clip })).toEqual({});
    const elsewhere = ledgerOf([
      shot('asset', 0, 5, 'person', 0.9),
      shot('other', 10, 14, 'person', 0.9),
      shot('asset', 10, 14, 'person', 0.2),
    ]);
    expect(ledgerEvidence({ ledger: elsewhere }, { assetId: 'asset', clip })).toEqual({});
  });
});
