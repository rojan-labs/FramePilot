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
import {
  CapabilityPackTrackingService,
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

  it('refuses a capability this pack does not provide', async () => {
    const { service, leases } = harness({});

    const outcome = await service.run(
      request({ capability: 'subject.detect' } as Partial<CapabilityPackWorkerRequest>),
      { projectRevision: 12, mediaRoot: MEDIA_ROOT },
    );

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(leases.acquired).toBe(0);
  });
});
