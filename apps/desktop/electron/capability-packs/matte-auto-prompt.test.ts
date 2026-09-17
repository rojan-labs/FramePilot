import { describe, expect, it, vi } from 'vitest';
import type { CapabilityPackWorkerRequest, InstalledCapabilityPack } from '@framepilot/capability-packs';
import { createSubjectDetectAutoPrompt, mainSubjectBox } from './matte-auto-prompt.js';
import { CapabilityPackTrackingService, SUBJECT_PACK_ID } from './tracking.js';

type Detection = Parameters<typeof mainSubjectBox>[0][number];

const subjectRecord: InstalledCapabilityPack = {
  identity: { id: SUBJECT_PACK_ID, version: '1.0.0', releaseDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64), os: 'darwin', arch: 'arm64' },
  state: 'installed',
  installRelativePath: `${SUBJECT_PACK_ID}/1.0.0/darwin-arm64`,
  installedBytes: 1,
  installedAt: '2026-09-17T00:00:00.000Z',
  lastUsedAt: '2026-09-17T00:00:00.000Z',
  pinnedProjectIds: [],
  activeLeaseCount: 0,
  health: { checkedAt: '2026-09-17T00:00:00.000Z', workerProtocolVersion: 1, status: 'healthy' },
  acquisition: { catalogDigest: 'c'.repeat(64), approvedAt: '2026-09-17T00:00:00.000Z', licenseSpdx: ['MIT'], mediaEgressApproved: false },
};

function detection(label: Detection['label'], width: number, height: number, confidence = 0.9): Detection {
  return { label, box: { x: 0, y: 0, width, height }, confidence };
}

function setup(options: { ready?: boolean; detections?: Detection[]; fail?: boolean } = {}) {
  const requests: CapabilityPackWorkerRequest[] = [];
  const propose = vi.fn();
  const tracking = new CapabilityPackTrackingService({
    storageRoot: '/packs',
    store: { list: async () => [subjectRecord], acquireLease: async () => ({ release: async () => undefined }) as never },
    platform: { os: 'darwin', arch: 'arm64' },
    propose,
    exists: async () => true,
    runWorker: async ({ request }) => {
      requests.push(request);
      if (options.fail === true) throw new Error('worker crashed');
      return {
        type: 'result',
        protocolVersion: 1,
        requestId: request.requestId,
        projectRevision: request.projectRevision,
        capability: 'subject.detect',
        backend: 'fake',
        modelDigests: {},
        detections: (options.detections ?? []).map((item) => ({ ...item, frame: 30 })),
      };
    },
  });
  const trackingFactory = vi.fn(() => tracking);
  const autoPrompt = createSubjectDetectAutoPrompt({
    subjectPackReady: async () => options.ready ?? true,
    tracking: trackingFactory,
  });
  const context = {
    requestId: 'job1',
    asset: { id: 'asset-1', path: '/project/media/shot.mp4', kind: 'video' } as never,
    frame: { index: 30, seconds: 1, pts: 15360 },
    fps: 30,
    projectRevision: 3,
    mediaRoot: '/project/media',
    signal: new AbortController().signal,
  };
  return { autoPrompt, context, requests, propose, trackingFactory };
}

describe('matte auto prompt via subject.detect', () => {
  it('prompts with the largest confident person on the first in-range frame', async () => {
    const h = setup({ detections: [detection('object', 0.9, 0.9), detection('person', 0.2, 0.5), detection('person', 0.3, 0.6)] });
    expect(await h.autoPrompt(h.context)).toEqual([{ kind: 'box', pts: 15360, box: { x: 0, y: 0, width: 0.3, height: 0.6 } }]);
    const request = h.requests[0]!;
    expect(request).toMatchObject({ capability: 'subject.detect', projectRevision: 3, parameters: { labels: ['person', 'object'] } });
    if (request.capability !== 'subject.detect') return;
    expect(request.media).toMatchObject({ firstFrame: 30, lastFrameExclusive: 31, absolutePath: '/project/media/shot.mp4' });
  });

  it('falls back to the largest object, ignoring faint and tiny detections', async () => {
    expect(mainSubjectBox([detection('person', 0.5, 0.5, 0.2), detection('person', 0.05, 0.05), detection('object', 0.4, 0.4)])).toEqual({
      x: 0,
      y: 0,
      width: 0.4,
      height: 0.4,
    });
    expect(mainSubjectBox([detection('face', 0.5, 0.5)])).toBeUndefined();
  });

  it('returns undefined (needs_prompt) without running or proposing anything when the pack is absent', async () => {
    const h = setup({ ready: false });
    expect(await h.autoPrompt(h.context)).toBeUndefined();
    expect(h.trackingFactory).not.toHaveBeenCalled();
    expect(h.propose).not.toHaveBeenCalled();
  });

  it('returns undefined when detection finds nothing or the worker fails', async () => {
    expect(await setup({ detections: [] }).autoPrompt(setup().context)).toBeUndefined();
    const failing = setup({ fail: true });
    expect(await failing.autoPrompt(failing.context)).toBeUndefined();
    expect(failing.propose).not.toHaveBeenCalled();
  });
});
