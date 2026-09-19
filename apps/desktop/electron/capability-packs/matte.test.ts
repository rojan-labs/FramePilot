import { readdirSync, readFileSync, rmSync } from 'node:fs';
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
  FAKE_WORKER_PID,
  constantRateTiming,
  fakeMatteInspector,
  fakeMatteWorker,
  type FakeMatteScenario,
} from './__fixtures__/fake-matte-worker.js';
import {
  CapabilityPackMatteService,
  frameAt,
  frameRange,
  layeredBrush,
  sampleSourcePts,
  SMART_MASK_PACK_ID,
  type MatteAutoPrompt,
  type MatteJobReport,
  type MatteProgress,
  type MatteRunContext,
} from './matte.js';
import {
  MatteInspectorError,
  type MatteMediaInspector,
  type MatteVideoTiming,
} from './matte-media-inspector.js';
import { decodeGrayPng, encodeGrayPng } from './matte-png.js';
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
  autoPrompt?: MatteAutoPrompt;
  freeDiskBytes?: number;
  /** The volume cannot report free space (statfs fails), as on some network mounts. */
  freeDiskFails?: boolean;
  observer?: (report: MatteJobReport) => void;
  watchdog?: ConstructorParameters<typeof CapabilityPackMatteService>[0]['watchdog'];
  onRequest?: (request: CapabilityPackWorkerRequest) => void;
}

async function harness(options: HarnessOptions = {}) {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'framepilot-matte-'));
  const mediaPath = path.join(projectDir, 'media', 'shot.mp4');
  await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(mediaPath)));
  await writeFile(mediaPath, 'fake camera bytes');
  const timing = options.timing ?? TIMING;
  const requests: CapabilityPackWorkerRequest[] = [];
  const worker = vi.fn(fakeMatteWorker({ scenario: options.scenario ?? 'ok', timing, onRequest: (request) => {
    requests.push(request);
    options.onRequest?.(request);
  } }));
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
    ...(options.autoPrompt === undefined ? {} : { autoPrompt: options.autoPrompt }),
    freeDiskBytes: async () => {
      if (options.freeDiskFails === true) throw Object.assign(new Error('statfs failed'), { code: 'ENOSYS' });
      return options.freeDiskBytes ?? Number.MAX_SAFE_INTEGER;
    },
    ...(options.observer === undefined ? {} : { observer: options.observer }),
    // Tests never sample real processes: a tiny footprint unless a test says otherwise.
    watchdog: { footprintBytes: async () => 1024, killGroup: () => undefined, ...options.watchdog },
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

  it('resumes a job an app stopped mid-way: the worker finds its finished windows (E2E.6)', async () => {
    const seen: string[][] = [];
    let record: string | undefined;
    const h = await harness({
      onRequest: (request) => {
        if (request.capability !== 'subject.matte') return;
        const directory = request.parameters.output.absolutePath;
        seen.push(readdirSync(directory).sort());
        record ??= readFileSync(path.join(directory, 'inputs', 'staging.json'), 'utf8');
        // The real worker reuses the checkpoint, then removes its private folders.
        rmSync(path.join(directory, 'windows'), { recursive: true, force: true });
      },
    });
    // A first run of the same request, only to learn what its staging records (F2), then its
    // artifact is removed so the resume is not a cache hit.
    const first = await h.service.run(h.intent({ requestId: 'job0' }), h.context());
    if (first.status !== 'completed') throw new Error('expected the first run to complete');
    rmSync(path.join(path.dirname(matteStagingRoot(h.projectDir)), first.artifact.key), { recursive: true });
    // The app died while this job ran: its staging directory holds window 1's checkpoint, a
    // half-written file and the host's record of what the job was for; nothing removed it.
    const orphan = (id: string) =>
      import('node:fs/promises').then(async (fs) => {
        const directory = path.join(matteStagingRoot(h.projectDir), id);
        await fs.mkdir(path.join(directory, 'windows', '1'), { recursive: true });
        await fs.writeFile(path.join(directory, 'windows', '1', 'done.json'), '{}');
        await fs.writeFile(path.join(directory, 'matte.mkv'), 'partial');
        await fs.mkdir(path.join(directory, 'inputs'));
        await fs.writeFile(path.join(directory, 'inputs', 'staging.json'), record!, { mode: 0o400 });
        return directory;
      });
    const directory = await orphan('job1');
    const outcome = await h.service.run(h.intent(), { ...h.context(), resume: true });
    expect(outcome.status).toBe('completed');
    const request = h.requests[1]!;
    if (request.capability !== 'subject.matte') throw new Error('expected a matte request');
    expect(request.parameters.output.absolutePath).toBe(directory);
    // The worker started with the checkpoint and fresh host inputs, not the half-written file.
    expect(seen[1]).toEqual(['inputs', 'scratch', 'windows']);
    // Committed and cleaned up as any other run.
    expect(await readdir(matteStagingRoot(h.projectDir))).toEqual([]);
  });

  it('recomputes every window of a job resumed after its media changed (F2)', async () => {
    const seen: string[][] = [];
    let record: string | undefined;
    const h = await harness({
      onRequest: (request) => {
        if (request.capability !== 'subject.matte') return;
        const directory = request.parameters.output.absolutePath;
        seen.push(readdirSync(directory).sort());
        record ??= readFileSync(path.join(directory, 'inputs', 'staging.json'), 'utf8');
        rmSync(path.join(directory, 'windows'), { recursive: true, force: true });
      },
    });
    const first = await h.service.run(h.intent({ requestId: 'job0' }), h.context());
    expect(first.status).toBe('completed');
    const directory = path.join(matteStagingRoot(h.projectDir), 'job1');
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(path.join(directory, 'windows', '1'), { recursive: true });
      await fs.writeFile(path.join(directory, 'windows', '1', 'done.json'), '{}');
      await fs.mkdir(path.join(directory, 'inputs'));
      await fs.writeFile(path.join(directory, 'inputs', 'staging.json'), record!, { mode: 0o400 });
      // Relinked while the app was closed: same asset id, same length, different bytes.
      await fs.writeFile(h.mediaPath, 'fake camera BYTES');
    });
    const outcome = await h.service.run(h.intent(), { ...h.context(), resume: true });
    expect(outcome).toMatchObject({ status: 'completed', cacheHit: false });
    // The orphan's windows were for other media: the worker starts from nothing.
    expect(seen[1]).toEqual(['inputs', 'scratch']);
    // And the worker is told the media's content, so its own checkpoints disagree too.
    const [before, after] = h.requests;
    if (before?.capability !== 'subject.matte' || after?.capability !== 'subject.matte') throw new Error('expected matte requests');
    expect(before.parameters.contentFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(after.parameters.contentFingerprint).not.toBe(before.parameters.contentFingerprint);
  });

  it('reads imported media stored relative to the project file (E2E.6)', async () => {
    const h = await harness();
    const relative = {
      id: 'p',
      assets: [{ id: 'asset-1', path: 'media/shot.mp4', kind: 'video', media: { width: 64, height: 36 } }],
      timeline: { tracks: [], revision: 4 },
    } as unknown as Project;
    h.setProject(relative);
    const outcome = await h.service.run(h.intent(), { ...h.context(), project: relative });
    expect(outcome.status).toBe('completed');
    const request = h.requests[0]!;
    if (request.capability !== 'subject.matte') throw new Error('expected a matte request');
    expect(request.media.absolutePath).toBe(h.mediaPath);
  });

  it('never adopts an existing staging directory for a new request, only on resume (F5)', async () => {
    const h = await harness();
    // Another app instance's live job (or anything else) already uses this id's directory.
    const existing = path.join(matteStagingRoot(h.projectDir), 'job1');
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(path.join(existing, 'windows', '1'), { recursive: true });
      await fs.writeFile(path.join(existing, 'windows', '1', 'done.json'), '{}');
    });
    expect(await h.service.run(h.intent(), h.context())).toMatchObject({ status: 'failed', code: 'job_running' });
    expect(h.worker).not.toHaveBeenCalled();
    // Untouched, and no lock left behind.
    expect(await readdir(path.join(existing, 'windows', '1'))).toEqual(['done.json']);
    expect(await readdir(matteStagingRoot(h.projectDir))).toEqual(['job1']);
  });

  it('points the worker’s temp folder into its staging directory and removes it after (F3)', async () => {
    const h = await harness();
    const outcome = await h.service.run(h.intent(), h.context());
    expect(outcome.status).toBe('completed');
    const options = h.worker.mock.calls[0]![0];
    const request = h.requests[0]!;
    if (request.capability !== 'subject.matte') throw new Error('expected a matte request');
    expect(options.temporaryDirectory).toBe(path.join(request.parameters.output.absolutePath, 'scratch', 'tmp'));
    expect(options.outputRoot).toBe(matteStagingRoot(h.projectDir));
    // Committed without the host's temp folder: verification saw only declared files.
    expect(await readdir(matteStagingRoot(h.projectDir))).toEqual([]);
  });

  it('reports phase timings, provider, flagged ratio and failure codes, never paths or prompts', async () => {
    const reports: MatteJobReport[] = [];
    const h = await harness({ observer: (report) => reports.push(report) });
    await h.service.run(h.intent(), h.context());
    await h.service.run(h.intent({ requestId: 'again' }), h.context());
    await h.service.run(h.intent({ requestId: 'stale', timelineRevision: 1 }), h.context());
    expect(reports.map((report) => [report.status, report.code, report.cacheHit])).toEqual([
      ['completed', undefined, false],
      ['completed', undefined, true],
      ['failed', 'stale_revision', undefined],
    ]);
    expect(reports[0]).toMatchObject({ executionProvider: 'cpu', packVersion: '1.0.0', verifiedFrames: 29, flaggedFrames: 1, flaggedRatio: 0.033 });
    expect(Object.keys(reports[0]!.phasesMs).sort()).toEqual(['cache', 'commit', 'media', 'stage', 'verify', 'worker', 'worker.decode', 'worker.matte', 'worker.verify'].sort());
    const text = JSON.stringify(reports);
    for (const forbidden of [h.projectDir, h.mediaPath, 'shot.mp4', 'asset-1', 'job1', '0.4', 'box']) {
      expect(text).not.toContain(forbidden);
    }
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

  it('refuses to start without enough free disk space, before creating anything', async () => {
    const h = await harness({ freeDiskBytes: 1_000 });
    const outcome = await h.service.run(h.intent({ foreground: true }), h.context());
    expect(outcome).toMatchObject({ status: 'failed', code: 'insufficient_disk', retryable: true, freeBytes: 1_000 });
    if (outcome.status !== 'failed') return;
    expect(outcome.requiredBytes).toBeGreaterThan(1_000);
    expect(h.worker).not.toHaveBeenCalled();
    await expect(readdir(matteStagingRoot(h.projectDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  describe('host watchdog (BR4.12 H2)', () => {
    const GIB = 1024 ** 3;

    it('stops a worker whose process group grows past 0.6 x RAM and kills the group', async () => {
      const killGroup = vi.fn();
      let attached: number | undefined;
      const h = await harness({
        scenario: 'hang',
        watchdog: {
          totalMemoryBytes: 8 * GIB,
          intervalMs: 5,
          footprintBytes: async (pid) => {
            attached = pid;
            return 6 * GIB;
          },
          killGroup,
        },
      });
      expect(await h.service.run(h.intent(), h.context())).toMatchObject({
        status: 'failed',
        code: 'resource_exhausted',
        resourceLimit: 'memory',
        retryable: false,
      });
      expect(attached).toBe(FAKE_WORKER_PID);
      expect(killGroup).toHaveBeenCalledWith(FAKE_WORKER_PID);
      expect(await readdir(matteStagingRoot(h.projectDir))).toEqual([]);
    });

    it('stops a silent worker after the stall limit', async () => {
      const h = await harness({ scenario: 'hang', watchdog: { stallMs: 20, intervalMs: 5 } });
      expect(await h.service.run(h.intent(), h.context())).toMatchObject({ code: 'resource_exhausted', resourceLimit: 'stalled' });
    });

    it('stops a worker writing past free space minus the 1 GB reserve', async () => {
      const h = await harness({ scenario: 'grow', freeDiskBytes: GIB + 256 * 1024, watchdog: { intervalMs: 5 } });
      expect(await h.service.run(h.intent(), h.context())).toMatchObject({ code: 'resource_exhausted', resourceLimit: 'disk' });
      expect(await readdir(matteStagingRoot(h.projectDir))).toEqual([]);
    });

    it('still bounds the staging folder when the volume cannot report free space (F1)', async () => {
      // The worker fills its own scratch/, which the artifact ceiling does not count; without
      // free space, the staging budget is what stops it.
      const h = await harness({
        scenario: 'grow_scratch',
        freeDiskFails: true,
        watchdog: { intervalMs: 5, stagingBudgetBytes: 512 * 1024 },
      });
      expect(await h.service.run(h.intent(), h.context())).toMatchObject({ code: 'resource_exhausted', resourceLimit: 'disk' });
      expect(await readdir(matteStagingRoot(h.projectDir))).toEqual([]);
    });

    it('runs a healthy job on a volume that cannot report free space (F1)', async () => {
      const h = await harness({ freeDiskFails: true, watchdog: { intervalMs: 5 } });
      expect(await h.service.run(h.intent(), h.context())).toMatchObject({ status: 'completed' });
    });

    it('leaves a well-behaved job alone', async () => {
      const h = await harness({ watchdog: { intervalMs: 5, totalMemoryBytes: 16 * GIB } });
      expect(await h.service.run(h.intent(), h.context())).toMatchObject({ status: 'completed' });
    });
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

  it('passes the pack asking for a box through with the remedy the editor acts on (BR7.5)', async () => {
    const h = await harness({ scenario: 'needs_box' });
    const outcome = await h.service.run(h.intent(), h.context());
    expect(outcome).toMatchObject({ status: 'failed', code: 'needs_box', retryable: false });
    expect(outcome.status === 'failed' && outcome.detail).toContain('drag a box around the subject');
  });

  it('layers a second brush fix on the same frame instead of refusing it (BR7 convergence)', async () => {
    const h = await harness();
    const first = await h.service.run(h.intent(), h.context());
    if (first.status !== 'completed') throw new Error('expected completion');
    const fix = (value: number, from: number) => {
      const pixels = new Uint8Array(64 * 36).fill(128);
      pixels.fill(value, from, from + 64);
      return saveMatteInput(h.projectDir, encodeGrayPng(64, 36, pixels), { width: 64, height: 36, kind: 'brush' });
    };
    const keep = await fix(255, 0);
    const edge = await fix(64, 64 * 10);
    const rerun = await h.service.run(
      h.intent({
        requestId: 'fix2',
        previousArtifactKey: first.artifact.key,
        prompts: [
          { kind: 'brush', sourceTime: 1, sha256: keep.sha256 },
          { kind: 'brush', sourceTime: 1, sha256: edge.sha256 },
        ],
      }),
      h.context(),
    );
    expect(rerun, JSON.stringify(rerun)).toMatchObject({ status: 'completed' });
    const request = h.requests.at(-1)!;
    if (request.capability !== 'subject.matte') throw new Error('expected matte');
    // One correction file for the frame, and one brush prompt.
    expect(request.parameters.inputs?.files.filter((file) => file.startsWith('corrections/'))).toEqual(['corrections/15360.png']);
    expect(request.parameters.prompts.filter((prompt) => prompt.kind === 'brush')).toHaveLength(1);
    // Two locks on one frame still contradict each other.
    const lock = await saveMatteInput(h.projectDir, encodeGrayPng(64, 36, new Uint8Array(64 * 36)), { width: 64, height: 36, kind: 'lock' });
    expect(
      await h.service.run(
        h.intent({
          requestId: 'twolocks',
          previousArtifactKey: first.artifact.key,
          prompts: [
            { kind: 'lock', sourceTime: 1, sha256: lock.sha256 },
            { kind: 'lock', sourceTime: 1, sha256: lock.sha256 },
          ],
        }),
        h.context(),
      ),
    ).toMatchObject({ status: 'failed', code: 'invalid_intent' });
  });

  it('layeredBrush: later fixes win where they say something, and sizes must agree', () => {
    const image = (pixels: number[]) => ({ width: 4, height: 1, pixels: Buffer.from(pixels) });
    const layered = layeredBrush([image([255, 255, 128, 0]), image([128, 64, 0, 128])]);
    expect([...layered.image.pixels]).toEqual([255, 64, 0, 0]);
    expect([...decodeGrayPng(layered.bytes).pixels]).toEqual([255, 64, 0, 0]);
    expect(() => layeredBrush([image([128, 128, 128, 128]), { width: 2, height: 2, pixels: Buffer.alloc(4) }])).toThrow(/different sizes/u);
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

  it('uses the auto prompt for the first in-range frame, and still asks for a click when it finds nothing', async () => {
    const seen: unknown[] = [];
    const autoPrompt = vi.fn<MatteAutoPrompt>(async (context) => {
      seen.push(context.frame);
      return [{ kind: 'box' as const, pts: context.frame.pts, box: { x: 0.2, y: 0.1, width: 0.5, height: 0.8 } }];
    });
    const h = await harness({ autoPrompt });
    const outcome = await h.service.run(h.intent({ prompts: [] }), h.context());
    expect(outcome.status).toBe('completed');
    expect(seen).toEqual([{ index: 15, seconds: 0.5, pts: TIMING.pts[15] }]);
    const request = h.requests[0]!;
    if (request.capability !== 'subject.matte') throw new Error('expected a matte request');
    expect(request.parameters.prompts).toEqual([{ kind: 'box', pts: TIMING.pts[15], box: { x: 0.2, y: 0.1, width: 0.5, height: 0.8 } }]);
    autoPrompt.mockResolvedValueOnce([]);
    expect(await h.service.run(h.intent({ requestId: 'again', prompts: [], sourceStart: 1 }), h.context())).toEqual({ status: 'needs_prompt' });
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

describe('unmeasured media (BR4.12 L3)', () => {
  it('refuses media_unreadable instead of skipping the display-size check', async () => {
    const h = await harness();
    const context = h.context();
    const unmeasured = {
      ...context,
      project: { ...context.project, assets: [{ id: 'asset-1', path: h.mediaPath, kind: 'video' }] } as unknown as Project,
    };
    expect(await h.service.run(h.intent(), unmeasured)).toMatchObject({ status: 'failed', code: 'media_unreadable', retryable: true });
    expect(h.worker).not.toHaveBeenCalled();
  });
});

describe('the monitor tier (PX5.9)', () => {
  const TIER = { status: 'written' as const, width: 32, height: 18, frameCount: 30, alpha: true };

  async function withProxy(proxyPath: string | null, rotation = 0) {
    const h = await harness();
    const derive = vi.fn<NonNullable<MatteMediaInspector['deriveMonitorTier']>>(async () => TIER);
    (h.inspector as MatteMediaInspector).deriveMonitorTier = derive;
    h.setProject({
      id: 'p',
      assets: [
        {
          id: 'asset-1',
          path: h.mediaPath,
          kind: 'video',
          media: { width: 64, height: 36, rotation, ...(proxyPath === null ? {} : { proxyPath }) },
        },
      ],
      timeline: { tracks: [], revision: 4 },
    } as unknown as Project);
    return { h, derive };
  }

  it('asks for the committed artifact’s tier with its pins, proxy and frame count', async () => {
    // 180: a turn that keeps the display size the fake worker writes.
    const { h, derive } = await withProxy('demo/proxies/shot.mp4', 180);
    const outcome = await h.service.run(h.intent({ foreground: true }), h.context());
    await h.service.settleMonitorTiers();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive.mock.calls[0]![0]).toEqual({
      projectDir: h.projectDir,
      artifact: {
        key: outcome.artifact.key,
        files: outcome.artifact.files.map(({ name, sha256 }) => ({ name, sha256 })),
        width: 64,
        height: 36,
      },
      proxyPath: 'demo/proxies/shot.mp4',
      rotation: 180,
      frameCount: 30,
    });
    // A cache hit asks again (the route answers "current" when nothing changed).
    await h.service.run(h.intent({ requestId: 'again', foreground: true }), h.context());
    await h.service.settleMonitorTiers();
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('never fails or delays the job when the tier fails', async () => {
    const { h, derive } = await withProxy('demo/proxies/shot.mp4');
    derive.mockRejectedValue(
      new MatteInspectorError('tool_unavailable', 'The engine is not running.'),
    );
    const outcome = await h.service.run(h.intent({ foreground: true }), h.context());
    await h.service.settleMonitorTiers();
    expect(outcome.status).toBe('completed');
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('makes no tier without a proxy or without a foreground', async () => {
    const noProxy = await withProxy(null);
    await noProxy.h.service.run(noProxy.h.intent({ foreground: true }), noProxy.h.context());
    const noForeground = await withProxy('demo/proxies/shot.mp4');
    await noForeground.h.service.run(noForeground.h.intent(), noForeground.h.context());
    await noProxy.h.service.settleMonitorTiers();
    await noForeground.h.service.settleMonitorTiers();
    expect(noProxy.derive).not.toHaveBeenCalled();
    expect(noForeground.derive).not.toHaveBeenCalled();
  });
});
