import { describe, expect, it, vi } from 'vitest';
import {
  AUTOMATIC_TRACKING_TOOL_NAME,
  DETECT_SUBJECTS_TOOL_NAME,
  captureEditorInteractionContext,
  type HostExecutionContext,
} from '@framepilot/ai-sdk';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type {
  CapabilityPackTrackingService,
  TrackingRunOutcome,
} from '../capability-packs/tracking.js';
import type { CapabilityPackWorkerRequest } from '@framepilot/capability-packs';
import { createAutomaticTrackingExecutor } from './automatic-tracking-executor.js';

function project(): Project {
  const mask = {
    id: 'shot__mask',
    type: 'mask',
    params: {
      shape: 'rectangle',
      bounds: { x: 0.2, y: 0.1, width: 0.25, height: 0.4 },
    },
    keyframes: [],
  };
  return parseProject({
    id: 'auto_tracking_project',
    name: 'Automatic tracking fixture',
    version: 1,
    fps: 24,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset', path: '/tmp/media/shot.mp4', kind: 'video', durationSeconds: 900 }],
    timeline: {
      revision: 7,
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
              sourceStart: 0,
              sourceEnd: 4,
              effects: [mask],
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

function context(base: Project): HostExecutionContext {
  return {
    project: base,
    interaction: captureEditorInteractionContext({
      project: base,
      projectRevision: base.timeline.revision ?? 0,
      playheadSeconds: 2,
      selectedClipIds: ['shot'],
      primaryClipId: 'shot',
    }),
  };
}

const samples = Array.from({ length: 6 }, (_, index) => ({
  frame: index * 8,
  box: { x: 0.2 + index * 0.005, y: 0.1, width: 0.25, height: 0.4 },
  confidence: 0.92,
  occluded: false,
}));

function completedOutcome(): TrackingRunOutcome {
  return {
    status: 'completed',
    identity: {
      id: 'framepilot.tracking-lite',
      version: '1.0.0-dev.local',
      releaseDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      os: 'darwin',
      arch: 'arm64',
    },
    result: {
      type: 'result',
      protocolVersion: 1,
      requestId: 'req_1',
      projectRevision: 7,
      capability: 'tracking.region',
      backend: 'opencv',
      modelDigests: {},
      samples,
    },
  };
}

function serviceWith(outcome: TrackingRunOutcome | Error) {
  const run = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { service: { run } as unknown as CapabilityPackTrackingService, run };
}

// The orchestrator schema-validates args before dispatch; mirror that here.
const call = (argumentsValue: Record<string, unknown> = {}) => ({
  name: AUTOMATIC_TRACKING_TOOL_NAME,
  arguments: { intent: 'track_subject_automatically', ...argumentsValue },
});

describe('createAutomaticTrackingExecutor', () => {
  it('refuses a call that was not routed to it', async () => {
    const executor = createAutomaticTrackingExecutor({
      tracking: async () => serviceWith(completedOutcome()).service,
    });
    const outcome = await executor.run(
      { name: 'analyze_silence', arguments: {} },
      context(project()),
    );
    expect(outcome.status).toBe('failed');
  });

  it('fails honestly without a live editor selection', async () => {
    const executor = createAutomaticTrackingExecutor({
      tracking: async () => serviceWith(completedOutcome()).service,
    });
    const outcome = await executor.run(call(), { project: project() });
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('target_unresolved');
  });

  it('surfaces the controller refusal when no mask exists', async () => {
    const bare = project();
    const clip = bare.timeline.tracks[0]!.clips[0]!;
    bare.timeline.tracks[0]!.clips[0] = { ...clip, effects: [] };
    const executor = createAutomaticTrackingExecutor({
      tracking: async () => serviceWith(completedOutcome()).service,
    });
    const outcome = await executor.run(call(), context(bare));
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('mask_unresolved');
  });

  it('builds the exact pack request and returns a validated measurement', async () => {
    const { service, run } = serviceWith(completedOutcome());
    const executor = createAutomaticTrackingExecutor({ tracking: async () => service });
    const outcome = await executor.run(
      call({ intent: 'track_subject_automatically', subject: 'region' }),
      context(project()),
    );

    expect(run).toHaveBeenCalledTimes(1);
    const [request, options] = run.mock.calls[0] as [
      CapabilityPackWorkerRequest,
      { projectRevision: number; mediaRoot: string },
    ];
    expect(request.capability).toBe('tracking.region');
    expect(request.projectRevision).toBe(7);
    expect(request.media.absolutePath).toBe('/tmp/media/shot.mp4');
    expect(request.media.firstFrame).toBe(0);
    expect(request.media.lastFrameExclusive).toBe(96);
    // The worker is sandboxed to the asset's own directory.
    expect(options.mediaRoot).toBe('/tmp/media');
    expect(options.projectRevision).toBe(7);

    expect(outcome.status).toBe('completed');
    const data = outcome.data as Record<string, unknown>;
    expect(data.engine).toBe('framepilot.tracking-lite@1.0.0-dev.local');
    expect(data.backend).toBe('opencv');
    expect(Array.isArray(data.samples)).toBe(true);
    expect(outcome.summary).toContain('6 frames with framepilot.tracking-lite@1.0.0-dev.local');
  });

  it('turns pack_missing into an honest failure carrying the install proposal', async () => {
    const proposal = {
      ok: true as const,
      proposal: { proposalId: 'p1', displayName: 'Tracking Lite', downloadBytes: 1024 },
    };
    const { service } = serviceWith({ status: 'pack_missing', proposal });
    const executor = createAutomaticTrackingExecutor({ tracking: async () => service });
    const outcome = await executor.run(call(), context(project()));
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('not installed');
    expect((outcome.data as { code: string }).code).toBe('pack_missing');
    expect((outcome.data as { proposal: unknown }).proposal).toEqual(proposal);
  });

  it('maps typed worker failures and retryability into the summary', async () => {
    const { service } = serviceWith({
      status: 'failed',
      code: 'timed_out',
      detail: 'worker exceeded its budget',
      retryable: true,
    });
    const executor = createAutomaticTrackingExecutor({ tracking: async () => service });
    const outcome = await executor.run(call(), context(project()));
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('timed_out');
    // `(Retryable.)` was a parenthetical fact. The model can only act on a call, so the
    // authority's boolean is now rendered as the call to make — and as the close for when
    // that one fails too.
    expect(outcome.summary).toContain('Call track_subject_automatically once more');
    expect(outcome.summary).toContain('do not call it again');
  });

  it('renders a final worker failure as a close rather than an invitation to retry', async () => {
    const { service } = serviceWith({
      status: 'failed',
      code: 'worker_crashed',
      detail: 'the worker exited',
      retryable: false,
    });
    const executor = createAutomaticTrackingExecutor({ tracking: async () => service });
    const outcome = await executor.run(call(), context(project()));
    expect(outcome.summary).toContain('worker_crashed');
    expect(outcome.summary).toContain('Do not call track_subject_automatically again');
  });

  it('reports cancellation as cancelled', async () => {
    const { service } = serviceWith({
      status: 'failed',
      code: 'cancelled',
      detail: 'aborted',
      retryable: false,
    });
    const executor = createAutomaticTrackingExecutor({ tracking: async () => service });
    const outcome = await executor.run(call(), context(project()));
    expect(outcome.status).toBe('cancelled');
  });

  it('returns frame-indexed detection evidence for detect_subjects', async () => {
    const { service, run } = serviceWith({
      status: 'completed',
      identity: {
        id: 'framepilot.subject-intelligence',
        version: '1.0.0-dev.local',
        releaseDigest: 'a'.repeat(64),
        artifactDigest: 'c'.repeat(64),
        os: 'darwin',
        arch: 'arm64',
      },
      result: {
        type: 'result',
        protocolVersion: 1,
        requestId: 'req_2',
        projectRevision: 7,
        capability: 'subject.detect',
        backend: 'opencv-dnn-5.0.0',
        modelDigests: {},
        detections: [
          {
            frame: 3,
            label: 'face',
            box: { x: 0.4, y: 0.2, width: 0.1, height: 0.1 },
            confidence: 0.91,
          },
          {
            frame: 9,
            label: 'person',
            box: { x: 0.35, y: 0.15, width: 0.25, height: 0.6 },
            confidence: 0.87,
          },
          {
            frame: 9,
            label: 'face',
            box: { x: 0.41, y: 0.19, width: 0.09, height: 0.09 },
            confidence: 0.83,
          },
        ],
      },
    });
    const executor = createAutomaticTrackingExecutor({ tracking: async () => service });
    const outcome = await executor.run(
      { name: DETECT_SUBJECTS_TOOL_NAME, arguments: { intent: 'detect_subjects' } },
      context(project()),
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toContain('2 face');
    expect(outcome.summary).toContain('1 person');
    const data = outcome.data as Record<string, unknown>;
    expect(data.kind).toBe('detect_subjects');
    expect(data.totalDetections).toBe(3);
    expect(data.engine).toBe('framepilot.subject-intelligence@1.0.0-dev.local');
    // The request went to the SUBJECT pack capability, not a tracker.
    const [request] = run.mock.calls[0] as [CapabilityPackWorkerRequest, unknown];
    expect(request.capability).toBe('subject.detect');
  });

  it('reports an empty detection sweep as a warning, never as subjects', async () => {
    const { service } = serviceWith({
      status: 'completed',
      identity: {
        id: 'framepilot.subject-intelligence',
        version: '1.0.0-dev.local',
        releaseDigest: 'a'.repeat(64),
        artifactDigest: 'c'.repeat(64),
        os: 'darwin',
        arch: 'arm64',
      },
      result: {
        type: 'result',
        protocolVersion: 1,
        requestId: 'req_3',
        projectRevision: 7,
        capability: 'subject.detect',
        backend: 'opencv-dnn-5.0.0',
        modelDigests: {},
        detections: [],
      },
    });
    const executor = createAutomaticTrackingExecutor({ tracking: async () => service });
    const outcome = await executor.run(
      { name: DETECT_SUBJECTS_TOOL_NAME, arguments: { intent: 'detect_subjects' } },
      context(project()),
    );
    expect(outcome.status).toBe('warning');
    expect(outcome.summary).toContain('Detected nothing');
  });

  it('converts silhouette mask runs into region samples for the same edit path', async () => {
    // A 4x4 mask over two frames: rows 1-2 fully foreground (COCO RLE starting
    // with the zero run) — bounding box must be y in [0.25, 0.75).
    const counts = [4, 8, 4];
    const { service } = serviceWith({
      status: 'completed',
      identity: {
        id: 'framepilot.subject-intelligence',
        version: '1.0.0-dev.local',
        releaseDigest: 'a'.repeat(64),
        artifactDigest: 'c'.repeat(64),
        os: 'darwin',
        arch: 'arm64',
      },
      result: {
        type: 'result',
        protocolVersion: 1,
        requestId: 'req_4',
        projectRevision: 7,
        capability: 'subject.segment',
        backend: 'opencv-dnn-5.0.0',
        modelDigests: {},
        masks: [
          { frame: 0, width: 4, height: 4, counts, confidence: 0.9 },
          { frame: 8, width: 4, height: 4, counts: [8, 8], confidence: 0.88 },
        ],
      },
    });
    const executor = createAutomaticTrackingExecutor({ tracking: async () => service });
    const objective = {
      intent: 'track_subject_automatically',
      subject: 'silhouette',
    };
    const outcome = await executor.run(call(objective), context(project()));
    expect(outcome.status).toBe('completed');
    const data = outcome.data as {
      samples: { frame: number; box: { y: number; height: number }; confidence: number }[];
    };
    expect(data.samples).toHaveLength(2);
    expect(data.samples[0]).toMatchObject({
      frame: 0,
      box: { x: 0, y: 0.25, width: 1, height: 0.5 },
      confidence: 0.9,
    });
    expect(data.samples[1]?.confidence).toBe(0.88);
  });
});
