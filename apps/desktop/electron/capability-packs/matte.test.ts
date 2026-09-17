import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilityPackWorkerRequest,
  InstalledCapabilityPack,
} from '@framepilot/capability-packs';
import type { CapabilityPackProposalResultWire } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import {
  constantRateTiming,
  fakeMatteInspector,
  fakeMatteWorker,
  type FakeMatteScenario,
} from './__fixtures__/fake-matte-worker.js';
import {
  CapabilityPackMatteService,
  frameAt,
  frameRange,
  sampleSourcePts,
  SMART_MASK_PACK_ID,
  type MatteProgress,
  type MatteRunContext,
} from './matte.js';
import type { MatteVideoTiming } from './matte-media-inspector.js';
import { encodeGrayPng } from './matte-png.js';
import { matteArtifactDirectory, matteStagingRoot } from './matte-staging.js';
import { readMatteRecord, saveMatteInput } from './matte-store.js';

const TIMING = constantRateTiming(90); // 3 s at 30 fps, time base 1/15360
const PROPOSAL = { ok: false, code: 'catalog_unconfigured', error: 'no catalog' } as CapabilityPackProposalResultWire;

function packRecord(overrides: Partial<InstalledCapabilityPack> = {}): InstalledCapabilityPack {
  return {
    identity: {
      id: SMART_MASK_PACK_ID,
      version: '1.0.0',
      releaseDigest: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      os: 'darwin',
      arch: 'arm64',
    },
    state: 'installed',
    installRelativePath: `${SMART_MASK_PACK_ID}/1.0.0/darwin-arm64`,
    installedBytes: 1_024,
    installedAt: '2026-09-17T00:00:00.000Z',
    lastUsedAt: '2026-09-17T00:00:00.000Z',
    pinnedProjectIds: [],
    activeLeaseCount: 0,
    health: { checkedAt: '2026-09-17T00:00:00.000Z', workerProtocolVersion: 1, status: 'healthy' },
    acquisition: {
      catalogDigest: 'c'.repeat(64),
      approvedAt: '2026-09-17T00:00:00.000Z',
      licenseSpdx: ['Apache-2.0'],
      mediaEgressApproved: false,
    },
    ...overrides,
  };
}

interface HarnessOptions {
  scenario?: FakeMatteScenario;
  records?: InstalledCapabilityPack[];
  isFile?: boolean;
  timing?: MatteVideoTiming;
}

async function harness(options: HarnessOptions = {}) {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'framepilot-matte-'));
  const mediaPath = path.join(projectDir, 'media', 'shot.mp4');
  await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(mediaPath)));
  await writeFile(mediaPath, 'fake camera bytes');
  const timing = options.timing ?? TIMING;
  const requests: CapabilityPackWorkerRequest[] = [];
  const worker = vi.fn(fakeMatteWorker({ scenario: options.scenario ?? 'ok', timing, onRequest: (request) => requests.push(request) }));
  const leases = { acquired: 0, released: 0 };
  const propose = vi.fn(async () => PROPOSAL);
  const inspector = fakeMatteInspector(new Map([[mediaPath, { timing }]]));
  const service = new CapabilityPackMatteService({
    storageRoot: '/packs',
    store: {
      list: async () => options.records ?? [packRecord()],
      acquireLease: async () => {
        leases.acquired += 1;
        return { release: async () => void (leases.released += 1) } as never;
      },
    },
    platform: { os: 'darwin', arch: 'arm64' },
    propose,
    inspector,
    runWorker: worker,
    isFile: async () => options.isFile ?? true,
    now: () => new Date('2026-09-17T12:00:00Z'),
  });
  let project = {
    id: 'p',
    assets: [{ id: 'asset-1', path: mediaPath, kind: 'video', media: { width: 64, height: 36 } }],
    timeline: { tracks: [], revision: 4 },
  } as unknown as Project;
  let revision = 4;
  const progress: MatteProgress[] = [];
  const context = (): MatteRunContext => ({
    projectDir,
    project,
    projectRevision: 4,
    readCurrent: async () => ({ revision, project }),
    onProgress: (event) => progress.push(event),
  });
  const intent = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'job1',
    assetId: 'asset-1',
    sourceStart: 0.5,
    sourceEnd: 1.5,
    prompts: [{ kind: 'box', sourceTime: 0.5, box: { x: 0.1, y: 0.1, width: 0.4, height: 0.8 } }],
    foreground: false,
    timelineRevision: 4,
    ...overrides,
  });
  return {
    projectDir,
    mediaPath,
    service,
    worker,
    requests,
    leases,
    propose,
    progress,
    inspector,
    context,
    intent,
    setRevision: (value: number) => void (revision = value),
    setProject: (value: Project) => void (project = value),
  };
}

describe('CapabilityPackMatteService lifecycle', () => {
  it('runs, verifies and commits an artifact the mask can pin', async () => {
    const h = await harness();
    const outcome = await h.service.run(h.intent(), h.context());
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.cacheHit).toBe(false);
    expect(outcome.artifact).toMatchObject({ width: 64, height: 36, packId: SMART_MASK_PACK_ID, packVersion: '1.0.0', coverage: { sourceStart: 0.5, sourceEnd: 1.5 } });
    expect(outcome.artifact.files.map((file) => file.name).sort()).toEqual(['frames.json', 'matte.mkv', 'report.json']);
    const directory = matteArtifactDirectory(h.projectDir, outcome.artifact.key)!;
    expect((await readdir(directory)).sort()).toEqual(['frames.json', 'matte.mkv', 'report.json']);
    expect(await readdir(matteStagingRoot(h.projectDir))).toEqual([]);
    const record = await readMatteRecord(h.projectDir, outcome.artifact.key);
    expect(record?.sourceSamples.map((sample) => sample.pts)[0]).toBe(TIMING.pts[15]);
    expect(record?.sourceSamples.at(-1)?.pts).toBe(TIMING.pts[44]);
    expect(outcome.needsReview[0]).toMatchObject({ start: 0.5, reason: 'occlusion' });
    // Frames 15..44 cover [0.5 s, 1.5 s) at 30 fps.
    const request = h.requests[0]!;
    if (request.capability !== 'subject.matte') throw new Error('expected a matte request');
    expect(request.media).toMatchObject({ firstFrame: 15, lastFrameExclusive: 45 });
    expect(h.worker.mock.calls[0]![0].outputRoot).toBe(matteStagingRoot(h.projectDir));
    expect(h.leases).toEqual({ acquired: 1, released: 1 });
    expect(h.progress.map((event) => event.phase)).toEqual(['decode', 'matte', 'verify', 'verify']);
  });

  it('returns a cache hit for the same media, range, prompts and pack without running the worker', async () => {
    const h = await harness();
    const first = await h.service.run(h.intent(), h.context());
    const second = await h.service.run(h.intent({ requestId: 'job2' }), h.context());
    expect(second).toMatchObject({ status: 'completed', cacheHit: true });
    expect(first.status === 'completed' && second.status === 'completed' && first.artifact.key === second.artifact.key).toBe(true);
    expect(h.worker).toHaveBeenCalledTimes(1);
    // Different prompt → different key → a new run.
    const moved = await h.service.run(
      h.intent({ requestId: 'job3', prompts: [{ kind: 'points', sourceTime: 1, points: [{ x: 0.5, y: 0.5, label: 'include' }] }] }),
      h.context(),
    );
    expect(moved).toMatchObject({ status: 'completed', cacheHit: false });
    expect(h.worker).toHaveBeenCalledTimes(2);
  });

  it('does not trust a cached artifact whose files changed on disk', async () => {
    const h = await harness();
    const first = await h.service.run(h.intent(), h.context());
    if (first.status !== 'completed') throw new Error('expected completion');
    await writeFile(path.join(matteArtifactDirectory(h.projectDir, first.artifact.key)!, 'report.json'), '{"tampered":1}');
    // The committed folder still holds the old artifact; a re-run's rename finds it present.
    const second = await h.service.run(h.intent({ requestId: 'job2' }), h.context());
    expect(h.worker).toHaveBeenCalledTimes(2);
    expect(second.status).toBe('completed');
  });

  it('proposes the pack when it is missing or too old, and refuses unhealthy or incomplete installs', async () => {
    const missing = await harness({ records: [] });
    expect(await missing.service.run(missing.intent(), missing.context())).toMatchObject({ status: 'pack_missing' });
    const old = await harness({ records: [packRecord({ identity: { ...packRecord().identity, version: '0.9.0' } })] });
    expect(await old.service.run(old.intent(), old.context())).toMatchObject({ status: 'pack_missing', proposal: PROPOSAL });
    expect(old.propose).toHaveBeenCalledWith('subject.matte');
    const unhealthy = await harness({
      records: [packRecord({ health: { checkedAt: '2026-09-17T00:00:00.000Z', workerProtocolVersion: 1, status: 'unhealthy' } })],
    });
    expect(await unhealthy.service.run(unhealthy.intent(), unhealthy.context())).toMatchObject({ status: 'failed', code: 'pack_unhealthy' });
    const incomplete = await harness({ isFile: false });
    expect(await incomplete.service.run(incomplete.intent(), incomplete.context())).toMatchObject({ status: 'failed', code: 'pack_incomplete' });
    expect(incomplete.worker).not.toHaveBeenCalled();
  });

  it('cancels a running job and removes its staging directory', async () => {
    const h = await harness({ scenario: 'hang' });
    const running = h.service.run(h.intent(), h.context());
    await vi.waitFor(() => expect(h.worker).toHaveBeenCalled());
    expect([...h.service.activeJobIds()]).toEqual(['job1']);
    h.service.cancel('job1');
    expect(await running).toMatchObject({ status: 'failed', code: 'cancelled' });
    expect(await readdir(matteStagingRoot(h.projectDir))).toEqual([]);
    expect(h.leases).toEqual({ acquired: 1, released: 1 });
    expect([...h.service.activeJobIds()]).toEqual([]);
  });

  it('refuses a request built for an older revision before any work', async () => {
    const h = await harness();
    expect(await h.service.run(h.intent({ timelineRevision: 3 }), h.context())).toMatchObject({ status: 'failed', code: 'stale_revision' });
    expect(h.worker).not.toHaveBeenCalled();
  });

  it('discards the result when the project changed mid-job, keeping the verified artifact for a cached retry', async () => {
    const h = await harness();
    h.setRevision(5);
    const stale = await h.service.run(h.intent(), h.context());
    expect(stale).toMatchObject({ status: 'failed', code: 'stale_revision', retryable: true });
    h.setRevision(4);
    expect(await h.service.run(h.intent({ requestId: 'retry' }), h.context())).toMatchObject({ status: 'completed', cacheHit: true });
  });

  it('commits nothing when the project changed and the asset is gone', async () => {
    const h = await harness();
    h.setRevision(5);
    h.setProject({ id: 'p', assets: [], timeline: { tracks: [] } } as unknown as Project);
    const context = { ...h.context(), project: { id: 'p', assets: [{ id: 'asset-1', path: h.mediaPath, kind: 'video', media: { width: 64, height: 36 } }], timeline: { tracks: [] } } as unknown as Project };
    expect(await h.service.run(h.intent(), context)).toMatchObject({ status: 'failed', code: 'stale_revision' });
    const mattes = await readdir(path.dirname(matteStagingRoot(h.projectDir)));
    expect(mattes.filter((name) => /^[0-9a-f]{64}$/u.test(name))).toEqual([]);
    expect(await readdir(matteStagingRoot(h.projectDir))).toEqual([]);
  });

  it.each([
    ['extra_file', 'undeclared_file'],
    ['wrong_digest', 'digest_mismatch'],
    ['misaligned', 'frames_misaligned'],
  ] as const)('discards a %s artifact as verification_failed/%s', async (scenario, verificationCode) => {
    const h = await harness({ scenario });
    expect(await h.service.run(h.intent(), h.context())).toMatchObject({ status: 'failed', code: 'verification_failed', verificationCode });
    expect(await readdir(matteStagingRoot(h.projectDir))).toEqual([]);
    const mattes = await readdir(path.dirname(matteStagingRoot(h.projectDir)));
    expect(mattes.filter((name) => /^[0-9a-f]{64}$/u.test(name))).toEqual([]);
  });

  it('maps output_unwritable to its own retryable code', async () => {
    const h = await harness({ scenario: 'output_unwritable' });
    expect(await h.service.run(h.intent(), h.context())).toMatchObject({
      status: 'failed',
      code: 'output_unwritable',
      retryable: true,
      detail: 'Disk full or folder not writable. Free up space and try again.',
    });
  });

  it('re-runs from a previous artifact with locked frames kept bit-identical', async () => {
    const h = await harness();
    const first = await h.service.run(h.intent(), h.context());
    if (first.status !== 'completed') throw new Error('expected completion');
    const lock = await saveMatteInput(h.projectDir, encodeGrayPng(64, 36, new Uint8Array(64 * 36).fill(255)), {
      width: 64,
      height: 36,
      kind: 'lock',
    });
    const rerun = await h.service.run(
      h.intent({
        requestId: 'rerun',
        previousArtifactKey: first.artifact.key,
        prompts: [
          { kind: 'box', sourceTime: 0.5, box: { x: 0.1, y: 0.1, width: 0.4, height: 0.8 } },
          { kind: 'lock', sourceTime: 1, sha256: lock.sha256 },
        ],
      }),
      h.context(),
    );
    expect(rerun, JSON.stringify(rerun)).toMatchObject({ status: 'completed', cacheHit: false });
    const request = h.requests[1]!;
    if (request.capability !== 'subject.matte') throw new Error('expected matte');
    expect(request.parameters.previousArtifact).toBe(first.artifact.key);
    expect(request.parameters.inputs?.files).toEqual(['locked/15360.png', 'previous/matte.mkv', 'previous/frames.json']);
    // A worker that ignores the lock is refused.
    const bad = await harness({ scenario: 'ignore_locks' });
    await writeFile(bad.mediaPath, 'fake camera bytes');
    const badFirst = await bad.service.run(bad.intent(), bad.context());
    if (badFirst.status !== 'completed') throw new Error('expected completion');
    const badLock = await saveMatteInput(bad.projectDir, encodeGrayPng(64, 36, new Uint8Array(64 * 36).fill(255)), { width: 64, height: 36, kind: 'lock' });
    expect(
      await bad.service.run(
        bad.intent({ requestId: 'rerun', previousArtifactKey: badFirst.artifact.key, prompts: [{ kind: 'lock', sourceTime: 1, sha256: badLock.sha256 }] }),
        bad.context(),
      ),
    ).toMatchObject({ status: 'failed', code: 'verification_failed', verificationCode: 'locked_frame_changed' });
  });

  it('refuses malformed intents, out-of-range prompts, unknown corrections and duplicate jobs', async () => {
    const h = await harness();
    for (const bad of [
      h.intent({ requestId: '../escape' }),
      h.intent({ sourceEnd: 0.1 }),
      h.intent({ extra: true }),
      h.intent({ prompts: [{ kind: 'box', sourceTime: 2.5, box: { x: 0, y: 0, width: 1, height: 1 } }] }),
    ]) {
      expect(await h.service.run(bad, h.context())).toMatchObject({ status: 'failed', code: 'invalid_intent' });
    }
    expect(await h.service.run(h.intent({ prompts: [{ kind: 'candidate', candidateId: 'c1' }] }), h.context())).toMatchObject({
      code: 'candidate_unresolved',
    });
    expect(
      await h.service.run(h.intent({ prompts: [{ kind: 'brush', sourceTime: 1, sha256: 'd'.repeat(64) }], previousArtifactKey: 'e'.repeat(64) }), h.context()),
    ).toMatchObject({ code: 'correction_invalid' });
    expect(await h.service.run(h.intent({ assetId: 'nope' }), h.context())).toMatchObject({ code: 'missing_asset' });
    const hanging = await harness({ scenario: 'hang' });
    const running = hanging.service.run(hanging.intent(), hanging.context());
    await vi.waitFor(() => expect(hanging.worker).toHaveBeenCalled());
    expect(await hanging.service.run(hanging.intent(), hanging.context())).toMatchObject({ code: 'job_running' });
    hanging.service.cancel('job1');
    await running;
  });

  it('asks for a click when there is no prompt and no auto prompt', async () => {
    const h = await harness();
    expect(await h.service.run(h.intent({ prompts: [] }), h.context())).toEqual({ status: 'needs_prompt' });
    expect(h.worker).not.toHaveBeenCalled();
  });
});

describe('matte frame ranges', () => {
  it('maps source seconds to the frames shown, on constant and variable frame rates', () => {
    expect(frameRange(TIMING, 0.5, 1.5)).toEqual({ firstFrame: 15, frameCount: 30 });
    expect(frameAt(TIMING, 0.51)).toBe(15);
    const vfr: MatteVideoTiming = { timeBase: [1, 1000], pts: [0, 40, 50, 100, 200] };
    expect(frameRange(vfr, 0.045, 0.15)).toEqual({ firstFrame: 1, frameCount: 3 });
    expect(frameRange(TIMING, 10, 11)).toBeUndefined();
    expect(sampleSourcePts(TIMING, 15, 30, 16)[0]).toBe(TIMING.pts[15]);
    expect(sampleSourcePts(TIMING, 15, 30, 16).at(-1)).toBe(TIMING.pts[44]);
    expect(sampleSourcePts(TIMING, 15, 30, 16)).toHaveLength(18);
  });
});
