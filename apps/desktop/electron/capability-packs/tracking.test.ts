import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityPackWorkerRuntimeError,
  type CapabilityPackLease,
} from '@framepilot/capability-packs/node';
import type {
  CapabilityPackInstallIdentity,
  CapabilityPackWorkerRequest,
  CapabilityPackWorkerResult,
  InstalledCapabilityPack,
} from '@framepilot/capability-packs';
import type { CapabilityPackProposalResultWire } from '@framepilot/shared-types';
import { VISUAL_EMBED_PACK_ID } from './visual-packs.js';
import {
  CapabilityPackTrackingService,
  SUBJECT_PACK_ID,
  TRACKING_PACK_ID,
  type TrackingPackStore,
} from './tracking.js';

const STORAGE_ROOT = '/packs';
const MEDIA_ROOT = '/project/media';

function identity(version = '1.0.0'): CapabilityPackInstallIdentity {
  return {
    id: TRACKING_PACK_ID,
    version,
    releaseDigest: 'a'.repeat(64),
    os: 'darwin',
    arch: 'arm64',
    artifactDigest: 'c'.repeat(64),
  };
}

function installed(overrides: Partial<InstalledCapabilityPack> = {}): InstalledCapabilityPack {
  const base: InstalledCapabilityPack = {
    identity: identity(),
    state: 'installed',
    installRelativePath: `${TRACKING_PACK_ID}/1.0.0/darwin-arm64`,
    installedBytes: 1_024,
    installedAt: '2026-08-13T00:00:00.000Z',
    lastUsedAt: '2026-08-13T00:00:00.000Z',
    pinnedProjectIds: [],
    activeLeaseCount: 0,
    health: { checkedAt: '2026-08-13T00:00:00.000Z', workerProtocolVersion: 1, status: 'healthy' },
    acquisition: {
      catalogDigest: 'b'.repeat(64),
      approvedAt: '2026-08-13T00:00:00.000Z',
      licenseSpdx: ['Apache-2.0'],
      mediaEgressApproved: false,
    },
  };
  return { ...base, ...overrides };
}

function installedSubject(): InstalledCapabilityPack {
  return installed({
    identity: { ...identity(), id: SUBJECT_PACK_ID, artifactDigest: 'd'.repeat(64) },
    installRelativePath: `${SUBJECT_PACK_ID}/1.0.0/darwin-arm64`,
    acquisition: {
      catalogDigest: 'e'.repeat(64),
      approvedAt: '2026-08-13T00:00:00.000Z',
      licenseSpdx: ['Apache-2.0'],
      mediaEgressApproved: false,
    },
  });
}

function request(overrides: Partial<CapabilityPackWorkerRequest> = {}): CapabilityPackWorkerRequest {
  return {
    type: 'request',
    protocolVersion: 1,
    requestId: 'req-1',
    projectRevision: 12,
    capability: 'tracking.region',
    media: {
      handleId: 'handle-1',
      assetId: 'asset-1',
      absolutePath: `${MEDIA_ROOT}/shot.mp4`,
      sourceStartSeconds: 0,
      sourceEndSeconds: 2,
      fps: 30,
      firstFrame: 0,
      lastFrameExclusive: 60,
    },
    parameters: { region: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    ...overrides,
  } as CapabilityPackWorkerRequest;
}

function result(): CapabilityPackWorkerResult {
  return {
    type: 'result',
    protocolVersion: 1,
    requestId: 'req-1',
    projectRevision: 12,
    capability: 'tracking.region',
    backend: 'opencv-5.0.0-cpu',
    modelDigests: {},
    samples: [
      {
        frame: 0,
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        confidence: 1,
        occluded: false,
      },
    ],
  };
}

const PROPOSAL: CapabilityPackProposalResultWire = {
  ok: false,
  code: 'approval_required',
  error: 'Tracking Lite must be downloaded first.',
} as CapabilityPackProposalResultWire;

interface Harness {
  readonly service: CapabilityPackTrackingService;
  readonly leases: { acquired: number; released: number };
  readonly propose: ReturnType<typeof vi.fn>;
}

function harness(options: {
  records?: readonly InstalledCapabilityPack[];
  runWorker?: (input: unknown) => Promise<CapabilityPackWorkerResult>;
  exists?: boolean;
}): Harness {
  const leases = { acquired: 0, released: 0 };
  const store: TrackingPackStore = {
    list: async () => options.records ?? [installed()],
    acquireLease: async (): Promise<CapabilityPackLease> => {
      leases.acquired += 1;
      return {
        identity: identity(),
        release: async () => {
          leases.released += 1;
        },
      } as CapabilityPackLease;
    },
  };
  const propose = vi.fn(async () => PROPOSAL);
  const service = new CapabilityPackTrackingService({
    storageRoot: STORAGE_ROOT,
    store,
    platform: { os: 'darwin', arch: 'arm64' },
    propose,
    exists: async () => options.exists ?? true,
    runWorker: (options.runWorker ?? (async () => result())) as never,
  });
  return { service, leases, propose };
}

describe('CapabilityPackTrackingService', () => {
  it('runs the resolved signed entrypoint and returns measurements', async () => {
    const seen: { entrypoint?: string; mediaRoot?: string } = {};
    const { service, leases } = harness({
      runWorker: async (input) => {
        const typed = input as { entrypoint: string; mediaRoot: string };
        seen.entrypoint = typed.entrypoint;
        seen.mediaRoot = typed.mediaRoot;
        return result();
      },
    });

    const outcome = await service.run(request(), {
      projectRevision: 12,
      mediaRoot: MEDIA_ROOT,
    });

    expect(outcome.status).toBe('completed');
    expect(seen.entrypoint).toBe(
      `${STORAGE_ROOT}/${TRACKING_PACK_ID}/1.0.0/darwin-arm64/bin/framepilot-tracking-lite`,
    );
    expect(seen.mediaRoot).toBe(MEDIA_ROOT);
    expect(leases).toEqual({ acquired: 1, released: 1 });
  });

  it('prefers the newest healthy installed release', async () => {
    const seen: string[] = [];
    const { service } = harness({
      records: [
        installed({ identity: identity('1.2.0'), installRelativePath: 'p/1.2.0/darwin-arm64' }),
        installed({ identity: identity('1.10.0'), installRelativePath: 'p/1.10.0/darwin-arm64' }),
      ],
      runWorker: async (input) => {
        seen.push((input as { entrypoint: string }).entrypoint);
        return result();
      },
    });

    await service.run(request(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });

    expect(seen[0]).toContain('/p/1.10.0/');
  });

  it('proposes an install instead of pretending tracking exists', async () => {
    const { service, propose, leases } = harness({ records: [] });

    const outcome = await service.run(request(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });

    expect(outcome).toEqual({ status: 'pack_missing', proposal: PROPOSAL });
    expect(propose).toHaveBeenCalledWith('tracking.region');
    expect(leases.acquired).toBe(0);
  });

  it.each([
    ['quarantined', installed({ state: 'quarantined' })],
    ['pending removal', installed({ state: 'pending_removal' })],
    [
      'unhealthy',
      installed({
        health: {
          checkedAt: '2026-08-13T00:00:00.000Z',
          workerProtocolVersion: 1,
          status: 'unhealthy',
        },
      }),
    ],
  ])('refuses to run a %s pack and reports it as unhealthy, not missing', async (_label, record) => {
    const { service, propose } = harness({ records: [record] });

    const outcome = await service.run(request(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });

    expect(outcome).toMatchObject({ status: 'failed', code: 'pack_unhealthy' });
    expect(propose).not.toHaveBeenCalled();
  });

  it('rejects a request built against a stale project revision', async () => {
    const { service, leases } = harness({});

    const outcome = await service.run(request({ projectRevision: 11 }), {
      projectRevision: 12,
      mediaRoot: MEDIA_ROOT,
    });

    expect(outcome).toMatchObject({ status: 'failed', code: 'stale_revision', retryable: true });
    expect(leases.acquired).toBe(0);
  });

  it('reports an incomplete install rather than launching a missing executable', async () => {
    const ran = vi.fn();
    const { service, leases } = harness({
      exists: false,
      runWorker: async () => {
        ran();
        return result();
      },
    });

    const outcome = await service.run(request(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });

    expect(outcome).toMatchObject({ status: 'failed', code: 'pack_incomplete' });
    expect(ran).not.toHaveBeenCalled();
    expect(leases.acquired).toBe(0);
  });

  it.each([
    ['cancelled', 'cancelled', 'cancelled'],
    ['timed_out', 'timed_out', 'timed_out'],
    ['media_escape', 'media_rejected', 'media_rejected'],
    ['worker_failed', 'worker_failed', 'worker_failed'],
  ])('maps a %s worker error to %s', async (workerError, expected) => {
    const { service, leases } = harness({
      runWorker: async () => {
        throw new CapabilityPackWorkerRuntimeError(
          workerError as 'cancelled',
          'worker stopped',
          'target_lost',
        );
      },
    });

    const outcome = await service.run(request(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });

    expect(outcome).toMatchObject({ status: 'failed', code: expected });
    // The lease must be released even though the worker failed.
    expect(leases).toEqual({ acquired: 1, released: 1 });
  });

  it('keeps the worker failure code visible so a lost target stays honest', async () => {
    const { service } = harness({
      runWorker: async () => {
        throw new CapabilityPackWorkerRuntimeError(
          'worker_failed',
          'tracking target lost after frame 12',
          'target_lost',
        );
      },
    });

    const outcome = await service.run(request(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });

    expect(outcome).toMatchObject({ status: 'failed', code: 'worker_failed', retryable: false });
    expect((outcome as { detail: string }).detail).toContain('target_lost');
  });

  it('does not offer a retry for a worker output overflow reported by its stable code', async () => {
    const { service } = harness({
      runWorker: async () => {
        throw new CapabilityPackWorkerRuntimeError(
          'worker_failed',
          'worker output line exceeded its 1 MiB bound.',
          'output_too_large',
        );
      },
    });

    const outcome = await service.run(request(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });

    expect(outcome).toMatchObject({ status: 'failed', code: 'worker_failed', retryable: false });
  });

  it('falls back to matching the message when an older pack reports overflow as a plain internal_error', async () => {
    const { service } = harness({
      runWorker: async () => {
        throw new CapabilityPackWorkerRuntimeError(
          'worker_failed',
          'worker output line exceeded its 1 MiB bound.',
          'internal_error',
        );
      },
    });

    const outcome = await service.run(request(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });

    expect(outcome).toMatchObject({ status: 'failed', code: 'worker_failed', retryable: false });
  });

  it('keeps other worker internal errors retryable', async () => {
    const { service } = harness({
      runWorker: async () => {
        throw new CapabilityPackWorkerRuntimeError('worker_failed', 'decoder hiccup', 'internal_error');
      },
    });

    const outcome = await service.run(request(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });

    expect(outcome).toMatchObject({ status: 'failed', retryable: true });
  });

  it('splits a long segmentation into bounded chunks and concatenates the masks in order', async () => {
    const chunks: CapabilityPackWorkerRequest['media'][] = [];
    const progress: { completed: number; total: number }[] = [];
    const { service, leases } = harness({
      records: [installed(), installedSubject()],
      runWorker: async (input) => {
        const typed = input as {
          request: CapabilityPackWorkerRequest;
          onProgress?: (p: { phase: string; completed: number; total: number }) => void;
        };
        const { media } = typed.request;
        chunks.push(media);
        const frames = media.lastFrameExclusive - media.firstFrame;
        typed.onProgress?.({ phase: 'segment', completed: frames, total: frames });
        return {
          type: 'result',
          protocolVersion: 1,
          requestId: 'req-1',
          projectRevision: 12,
          capability: 'subject.segment',
          backend: 'opencv-dnn-5.0.0',
          modelDigests: {},
          masks: Array.from({ length: frames }, (_unused, index) => ({
            frame: media.firstFrame + index,
            width: 4,
            height: 4,
            counts: [16],
            confidence: 0.9,
          })),
        } as CapabilityPackWorkerResult;
      },
    });

    const outcome = await service.run(
      request({
        capability: 'subject.segment',
        media: {
          handleId: 'handle-1',
          assetId: 'asset-1',
          absolutePath: `${MEDIA_ROOT}/shot.mp4`,
          sourceStartSeconds: 1,
          sourceEndSeconds: 1 + 320 / 30,
          fps: 30,
          firstFrame: 30,
          lastFrameExclusive: 350,
        },
      }),
      {
        projectRevision: 12,
        mediaRoot: MEDIA_ROOT,
        onProgress: (p) => progress.push({ completed: p.completed, total: p.total }),
      },
    );

    expect(outcome.status).toBe('completed');
    expect(chunks.map((media) => [media.firstFrame, media.lastFrameExclusive])).toEqual([
      [30, 180],
      [180, 330],
      [330, 350],
    ]);
    expect(chunks[1]!.sourceStartSeconds).toBeCloseTo(1 + 150 / 30, 9);
    expect(chunks[2]!.sourceEndSeconds).toBeCloseTo(1 + 320 / 30, 9);
    if (outcome.status !== 'completed' || !('masks' in outcome.result)) throw new Error('expected masks');
    expect(outcome.result.masks.map((mask) => mask.frame)).toEqual(
      Array.from({ length: 320 }, (_unused, index) => 30 + index),
    );
    expect(progress.at(-1)).toEqual({ completed: 320, total: 320 });
    // One lease covers every chunk.
    expect(leases).toEqual({ acquired: 1, released: 1 });
  });

  it('releases the lease when the worker process crashes outright', async () => {
    const { service, leases } = harness({
      runWorker: async () => {
        throw new Error('spawn ENOENT');
      },
    });

    const outcome = await service.run(request(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });

    expect(outcome).toMatchObject({ status: 'failed', code: 'worker_failed' });
    expect(leases).toEqual({ acquired: 1, released: 1 });
  });

  it('routes subject.detect to the Subject Intelligence pack and provisions its model root', async () => {
    const seen: { entrypoint?: string; extraEnvironment?: Record<string, string> } = {};
    const { service, leases } = harness({
      records: [installed(), installedSubject()],
      runWorker: async (input) => {
        const typed = input as {
          entrypoint: string;
          extraEnvironment?: Record<string, string>;
        };
        seen.entrypoint = typed.entrypoint;
        seen.extraEnvironment = typed.extraEnvironment;
        return {
          type: 'result',
          protocolVersion: 1,
          requestId: 'req-1',
          projectRevision: 12,
          capability: 'subject.detect',
          backend: 'opencv-dnn-5.0.0',
          modelDigests: {},
          detections: [],
        };
      },
    });

    const outcome = await service.run(
      request({ capability: 'subject.detect' } as Partial<CapabilityPackWorkerRequest>),
      { projectRevision: 12, mediaRoot: MEDIA_ROOT },
    );

    // Weights-backed pack: the worker resolves models inside its own install root.
    expect(seen.entrypoint).toBe(
      '/packs/framepilot.subject-intelligence/1.0.0/darwin-arm64/bin/framepilot-subject-intelligence',
    );
    expect(seen.extraEnvironment?.FRAMEPILOT_CAPABILITY_PACK_ROOT).toBe(
      '/packs/framepilot.subject-intelligence/1.0.0/darwin-arm64',
    );
    expect(outcome.status).toBe('completed');
    expect(leases).toEqual({ acquired: 1, released: 1 });
  });

  it('proposes the subject install when only the tracking pack is present', async () => {
    const { service, leases, propose } = harness({});

    const outcome = await service.run(
      request({ capability: 'subject.segment' } as Partial<CapabilityPackWorkerRequest>),
      { projectRevision: 12, mediaRoot: MEDIA_ROOT },
    );

    expect(outcome.status).toBe('pack_missing');
    expect(propose).toHaveBeenCalledWith('subject.segment');
    expect(leases.acquired).toBe(0);
  });

  describe('AM2.5 negotiation: subject.detect classes', () => {
    const detect = (): CapabilityPackWorkerRequest =>
      request({
        capability: 'subject.detect',
        parameters: { labels: ['object', 'person'], maxDetections: 12, classes: true },
      } as Partial<CapabilityPackWorkerRequest>);
    const subjectAt = (version: string): InstalledCapabilityPack => ({
      ...installedSubject(),
      identity: { ...installedSubject().identity, version },
      installRelativePath: `${SUBJECT_PACK_ID}/${version}/darwin-arm64`,
    });
    const sentBy = async (version: string): Promise<Record<string, unknown>> => {
      let sent: Record<string, unknown> = {};
      const { service } = harness({
        records: [subjectAt(version)],
        runWorker: async (input) => {
          sent = (input as { request: { parameters: Record<string, unknown> } }).request.parameters;
          return result();
        },
      });
      const outcome = await service.run(detect(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });
      expect(outcome.status).toBe('completed');
      return sent;
    };

    it('new host, old pack: the 1.0 pack is asked without `classes`, which it would refuse', async () => {
      const sent = await sentBy('1.0.0');
      expect(sent).not.toHaveProperty('classes');
      expect(sent).toMatchObject({ labels: ['object', 'person'], maxDetections: 12 });
    });

    it('new host, new pack: a 1.1 pack is asked for classes', async () => {
      expect(await sentBy('1.1.0')).toMatchObject({ classes: true });
      expect(await sentBy('2.0.0')).toMatchObject({ classes: true });
    });
  });

  describe('AM2.5: Visual Embed crops for the colour re-ranker', () => {
    const embedAt = (version: string): InstalledCapabilityPack => ({
      ...installed(),
      identity: { ...identity(version), id: VISUAL_EMBED_PACK_ID, artifactDigest: 'f'.repeat(64) },
      installRelativePath: `${VISUAL_EMBED_PACK_ID}/${version}/darwin-arm64`,
    });
    const crops = (): CapabilityPackWorkerRequest =>
      request({
        capability: 'visual.embed',
        parameters: {
          promptBankVersion: 1,
          shots: [{ shotIndex: 0, keyframeT: 1, region: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } }],
        },
      } as Partial<CapabilityPackWorkerRequest>);

    it('runs visual.embed with the installed Visual Embed pack and its model root', async () => {
      const seen: { entrypoint?: string; env?: Record<string, string> } = {};
      const { service } = harness({
        records: [embedAt('1.1.0')],
        runWorker: async (input) => {
          const typed = input as { entrypoint: string; extraEnvironment: Record<string, string> };
          seen.entrypoint = typed.entrypoint;
          seen.env = typed.extraEnvironment;
          return result();
        },
      });
      const outcome = await service.run(crops(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });
      expect(outcome.status).toBe('completed');
      expect(seen.entrypoint).toBe(
        `${STORAGE_ROOT}/${VISUAL_EMBED_PACK_ID}/1.1.0/darwin-arm64/bin/framepilot-visual-embed`,
      );
      expect(seen.env?.FRAMEPILOT_CAPABILITY_PACK_ROOT).toBe(
        `${STORAGE_ROOT}/${VISUAL_EMBED_PACK_ID}/1.1.0/darwin-arm64`,
      );
    });

    it('refuses a crop to a 1.0 pack before spawning it: a whole frame is not a crop', async () => {
      let spawned = 0;
      const { service, leases } = harness({
        records: [embedAt('1.0.0')],
        runWorker: async () => {
          spawned += 1;
          return result();
        },
      });
      const outcome = await service.run(crops(), { projectRevision: 12, mediaRoot: MEDIA_ROOT });
      expect(outcome).toMatchObject({ status: 'failed', code: 'pack_outdated' });
      expect(spawned).toBe(0);
      expect(leases.acquired).toBe(0);
    });

    it('answers pack_absent without building an install proposal when the caller skips', async () => {
      const { service, propose } = harness({ records: [installed()] });
      const outcome = await service.run(crops(), {
        projectRevision: 12,
        mediaRoot: MEDIA_ROOT,
        whenMissing: 'skip',
      });
      expect(outcome).toMatchObject({ status: 'failed', code: 'pack_absent' });
      expect(propose).not.toHaveBeenCalled();
    });
  });
});
