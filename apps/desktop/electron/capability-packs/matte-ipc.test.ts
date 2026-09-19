import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { InstalledCapabilityPack } from '@framepilot/capability-packs';
import type { CapabilityPackProposalResultWire } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import { IpcChannels } from '../ipc/contract.js';
import { constantRateTiming, fakeMatteInspector, fakeMatteWorker } from './__fixtures__/fake-matte-worker.js';
import { resolveCapabilityPackStatus } from './capability-status.js';
import { CapabilityPackMatteService, SMART_MASK_PACK_ID } from './matte.js';
import { registerMatteIpc, type MatteIpcEvent } from './matte-ipc.js';
import { encodeGrayPng } from './matte-png.js';
import { matteStagingRoot } from './matte-staging.js';

const TIMING = constantRateTiming(60);

function record(overrides: Partial<InstalledCapabilityPack> = {}): InstalledCapabilityPack {
  return {
    identity: { id: SMART_MASK_PACK_ID, version: '1.0.0', releaseDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64), os: 'darwin', arch: 'arm64' },
    state: 'installed',
    installRelativePath: `${SMART_MASK_PACK_ID}/1.0.0/darwin-arm64`,
    installedBytes: 1,
    installedAt: '2026-09-17T00:00:00.000Z',
    lastUsedAt: '2026-09-17T00:00:00.000Z',
    pinnedProjectIds: [],
    activeLeaseCount: 0,
    health: { checkedAt: '2026-09-17T00:00:00.000Z', workerProtocolVersion: 1, status: 'healthy' },
    acquisition: { catalogDigest: 'c'.repeat(64), approvedAt: '2026-09-17T00:00:00.000Z', licenseSpdx: ['MIT'], mediaEgressApproved: false },
    ...overrides,
  };
}

async function setup(options: { project?: boolean; licensed?: boolean } = {}) {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'framepilot-matte-ipc-'));
  const projectPath = path.join(projectDir, 'edit.fp.json');
  const mediaPath = path.join(projectDir, 'shot.mp4');
  await writeFile(mediaPath, 'bytes');
  const project = {
    id: 'p',
    assets: [{ id: 'asset-1', path: mediaPath, kind: 'video', media: { width: 64, height: 36 } }],
    timeline: { tracks: [], revision: 2 },
  } as unknown as Project;
  const service = new CapabilityPackMatteService({
    storageRoot: '/packs',
    store: { list: async () => [record()], acquireLease: async () => ({ release: async () => undefined }) as never },
    platform: { os: 'darwin', arch: 'arm64' },
    propose: async () => ({ ok: false, code: 'catalog_unconfigured', error: 'x' }) as CapabilityPackProposalResultWire,
    inspector: fakeMatteInspector(new Map([[mediaPath, { timing: TIMING }]])),
    runWorker: fakeMatteWorker({ timing: TIMING }),
    isFile: async () => true,
  });
  const handlers = new Map<string, (event: MatteIpcEvent, ...args: unknown[]) => unknown>();
  const sent: { channel: string; payload: unknown }[] = [];
  const event: MatteIpcEvent = { sender: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) } };
  registerMatteIpc({
    ipcMain: {
      handle: (channel, listener) => void handlers.set(channel, listener),
      on: (channel, listener) => void handlers.set(channel, listener),
    },
    requireLicense: () => {
      if (options.licensed === false) throw new Error('A valid FramePilot license is required.');
    },
    capabilityStatus: (capability) =>
      resolveCapabilityPackStatus(capability, { records: [record()], platform: { os: 'darwin', arch: 'arm64' }, propose: vi.fn() }),
    matte: async () => service,
    activeProjectPath: async () => (options.project === false ? null : projectPath),
    readProject: async () => project,
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  return { projectDir, service, handlers, sent, call };
}

const intent = {
  requestId: 'job1',
  assetId: 'asset-1',
  sourceStart: 0,
  sourceEnd: 1,
  prompts: [{ kind: 'box', sourceTime: 0, box: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } }],
  foreground: false,
  timelineRevision: 2,
};

describe('matte IPC channels', () => {
  it('registers exactly the named channels', async () => {
    const { handlers } = await setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        IpcChannels.capabilityPackStatus,
        IpcChannels.capabilityPackMatte,
        IpcChannels.capabilityPackCancelMatte,
        IpcChannels.matteSaveCorrection,
        // BR6.11: hover highlight, read-only.
        IpcChannels.matteSegmentFrame,
      ].sort(),
    );
  });

  it('answers status for a valid capability id and refuses anything else without touching storage', async () => {
    const { call } = await setup();
    expect(await call(IpcChannels.capabilityPackStatus, 'subject.matte')).toMatchObject({ state: 'ready', capability: 'subject.matte' });
    for (const bad of ['../../etc', { id: 'x' }, 'A'.repeat(200), '']) {
      expect(await call(IpcChannels.capabilityPackStatus, bad)).toMatchObject({ state: 'invalid' });
    }
  });

  it('runs a matte job over IPC, streams progress, and returns the wire result', async () => {
    const { call, sent } = await setup();
    const result = (await call(IpcChannels.capabilityPackMatte, intent)) as { ok: boolean; artifact?: { key: string } };
    expect(result).toMatchObject({ ok: true, cacheHit: false, projectRevision: 2 });
    expect(sent.every((message) => message.channel === IpcChannels.capabilityPackMatteProgress)).toBe(true);
    expect(sent.length).toBeGreaterThan(0);
    expect(await call(IpcChannels.capabilityPackMatte, { ...intent, requestId: 'job2' })).toMatchObject({ ok: true, cacheHit: true });
  });

  it('refuses malformed intents, a missing project and an unlicensed caller', async () => {
    const { call } = await setup();
    expect(await call(IpcChannels.capabilityPackMatte, { ...intent, assetPath: '/etc/passwd' })).toMatchObject({ ok: false, code: 'invalid_intent' });
    expect(await call(IpcChannels.capabilityPackMatte, 'nope')).toMatchObject({ ok: false, code: 'invalid_intent' });
    expect(await (await setup({ project: false })).call(IpcChannels.capabilityPackMatte, intent)).toMatchObject({ code: 'no_project' });
    await expect((await setup({ licensed: false })).call(IpcChannels.capabilityPackMatte, intent)).rejects.toThrow(/license/);
  });

  it('sweeps orphaned staging directories the first time a project is used', async () => {
    const { call, projectDir } = await setup();
    const orphan = path.join(matteStagingRoot(projectDir), 'orphan');
    await mkdir(orphan, { recursive: true });
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    await utimes(orphan, old, old);
    await call(IpcChannels.capabilityPackMatte, intent);
    expect(await readdir(matteStagingRoot(projectDir))).toEqual([]);
  });

  it('saves a correction against a known artifact and validates every field', async () => {
    const { call } = await setup();
    const run = (await call(IpcChannels.capabilityPackMatte, intent)) as { artifact: { key: string } };
    const key = run.artifact.key;
    const png = encodeGrayPng(64, 36, new Uint8Array(64 * 36).fill(128));
    const saved = await call(IpcChannels.matteSaveCorrection, { artifactKey: key, sourceTime: 0.5, kind: 'brush', png });
    expect(saved).toMatchObject({ ok: true, reference: { kind: 'brush', sourceTime: 0.5 } });
    expect(await call(IpcChannels.matteSaveCorrection, { artifactKey: key, sourceTime: 0.5, kind: 'lock', png: encodeGrayPng(10, 10, new Uint8Array(100)) })).toMatchObject({
      ok: false,
      code: 'wrong_size',
    });
    expect(await call(IpcChannels.matteSaveCorrection, { artifactKey: key, sourceTime: 9, kind: 'lock', png })).toMatchObject({ code: 'out_of_coverage' });
    expect(await call(IpcChannels.matteSaveCorrection, { artifactKey: 'f'.repeat(64), sourceTime: 0.5, kind: 'lock', png })).toMatchObject({
      code: 'artifact_missing',
    });
    for (const bad of [
      { artifactKey: '../x', sourceTime: 0, kind: 'lock', png },
      { artifactKey: key, sourceTime: 0, kind: 'erase', png },
      { artifactKey: key, sourceTime: 0, kind: 'lock', png: 'base64' },
      { artifactKey: key, sourceTime: 0, kind: 'lock', png, path: '/tmp/x.png' },
    ]) {
      expect(await call(IpcChannels.matteSaveCorrection, bad)).toMatchObject({ ok: false, code: 'invalid_correction' });
    }
  });

  it('ignores a cancel with a non-string id and cancels a running job by id', async () => {
    const { call, service } = await setup();
    const cancel = vi.spyOn(service, 'cancel');
    call(IpcChannels.capabilityPackCancelMatte, { id: 1 });
    call(IpcChannels.capabilityPackCancelMatte, 'job1');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('job1'));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('matte jobs through the scheduler', () => {
  it('runs an IPC matte job as a scheduled job and lists it for the jobs panel', async () => {
    const { CapabilityPackJobScheduler } = await import('./job-scheduler.js');
    const { registerJobIpc, scheduleMatteJob } = await import('./matte-ipc.js');
    const h = await setup();
    const scheduler = new CapabilityPackJobScheduler();
    const handlers = new Map<string, (event: MatteIpcEvent, ...args: unknown[]) => unknown>();
    const cancelMatte = vi.fn();
    registerJobIpc({
      ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener), on: () => undefined },
      scheduler,
      cancelMatte,
    });
    const event = { sender: { isDestroyed: () => false, send: () => undefined } };
    const deps = {
      matte: async () => h.service,
      readProject: async () =>
        ({
          assets: [{ id: 'asset-1', path: path.join(h.projectDir, 'shot.mp4'), kind: 'video', media: { width: 64, height: 36 } }],
          timeline: { tracks: [], revision: 2 },
        }) as unknown as Project,
      scheduler,
    };
    const outcome = await scheduleMatteJob(deps, path.join(h.projectDir, 'edit.fp.json'), { ...intent, clipId: 'clip-9' }, 'focused', false);
    expect(outcome.status).toBe('completed');
    const jobs = (await handlers.get(IpcChannels.capabilityPackJobs)!(event)) as { id: string; clipId: string; state: string; progress?: unknown }[];
    expect(jobs).toEqual([expect.objectContaining({ id: 'job1', clipId: 'clip-9', state: 'completed', kind: 'matte', label: 'Remove background' })]);
    expect(await handlers.get(IpcChannels.capabilityPackJobAction)!(event, { jobId: 'job1', action: 'cancel' })).toBe(false);
    expect(await handlers.get(IpcChannels.capabilityPackJobAction)!(event, { jobId: '../x', action: 'cancel' })).toBe(false);
    expect(await handlers.get(IpcChannels.capabilityPackJobAction)!(event, { jobId: 'job1', action: 'delete' })).toBe(false);
    // A duplicate id while the first is live is refused, never run twice.
    scheduler.beginExport();
    const queued = scheduleMatteJob(deps, path.join(h.projectDir, 'edit.fp.json'), { ...intent, requestId: 'job2' }, 'focused', false);
    await vi.waitFor(() => expect(scheduler.snapshot().some((job) => job.id === 'job2' && job.state === 'queued')).toBe(true));
    expect(await handlers.get(IpcChannels.capabilityPackJobAction)!(event, { jobId: 'job2', action: 'cancel' })).toBe(true);
    expect(cancelMatte).toHaveBeenCalledWith('job2');
    expect(await queued).toMatchObject({ status: 'failed', code: 'cancelled' });
  });
});

describe('resuming journaled matte jobs (BR4.9, E2E.6)', () => {
  it('wakes the opened project’s jobs only, drops one whose asset is gone, and re-checks the project', async () => {
    const { CapabilityPackJobScheduler } = await import('./job-scheduler.js');
    const { resumeMatteJobs } = await import('./matte-ipc.js');
    const h = await setup();
    const opened = path.join(h.projectDir, 'edit.fp.json');
    const journaled = (id: string, projectPath: string, assetId = 'asset-1') => ({
      id,
      kind: 'matte' as const,
      label: 'Remove background',
      clipId: 'clip-1',
      projectPath,
      payload: { ...intent, requestId: id, assetId, timelineRevision: 1 },
      finishedWindows: [1],
    });
    const scheduler = new CapabilityPackJobScheduler({
      journal: {
        load: async () => [journaled('mine', opened), journaled('other', '/elsewhere/p.fp.json'), journaled('gone', opened, 'deleted')],
        save: async () => undefined,
      },
    });
    await scheduler.loadDormant();
    let open: string | null = opened;
    const deps = {
      matte: async () => h.service,
      readProject: async () =>
        ({
          assets: [{ id: 'asset-1', path: path.join(h.projectDir, 'shot.mp4'), kind: 'video', media: { width: 64, height: 36 } }],
          timeline: { tracks: [], revision: 2 },
        }) as unknown as Project,
      requireLicense: () => undefined,
      activeProjectPath: async () => open,
      scheduler,
    };
    expect(await resumeMatteJobs(deps, opened)).toBe(1);
    // Re-stamped to the revision on disk, so the job is not refused as stale.
    await vi.waitFor(() => expect(scheduler.snapshot()).toEqual([expect.objectContaining({ id: 'mine', resumed: true, state: 'completed' })]));
    // The other project's job stayed dormant until that project was named; when it runs, the
    // project it belongs to must still be the open one, or it fails instead of writing there.
    open = null;
    expect(await resumeMatteJobs(deps, '/elsewhere/p.fp.json')).toBe(1);
    await vi.waitFor(() =>
      expect(scheduler.snapshot().find((job) => job.id === 'other')).toMatchObject({ state: 'failed', resumed: true }),
    );
    expect(await resumeMatteJobs(deps, opened)).toBe(0);
  });
});

describe('matte storage IPC', () => {
  it('summarises and cleans the open project, protecting keys a running re-run reads', async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), 'framepilot-matte-storage-ipc-'));
    const mattes = path.join(projectDir, '.framepilot-derived', 'mattes');
    for (const key of ['a'.repeat(64), 'b'.repeat(64)]) {
      await mkdir(path.join(mattes, key), { recursive: true });
      await writeFile(path.join(mattes, key, 'matte.mkv'), Buffer.alloc(8));
    }
    const handlers = new Map<string, (event: MatteIpcEvent, ...args: unknown[]) => unknown>();
    const busy = new Set(['b'.repeat(64)]);
    const { registerMatteStorageIpc } = await import('./matte-ipc.js');
    registerMatteStorageIpc({
      ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener), on: () => undefined },
      requireLicense: () => undefined,
      capabilityStatus: vi.fn(),
      matte: async () => ({ busyArtifactKeys: () => busy }) as unknown as CapabilityPackMatteService,
      activeProjectPath: async () => path.join(projectDir, 'edit.fp.json'),
      readProject: async () => ({ timeline: { tracks: [] } }) as unknown as Project,
    });
    const event = { sender: { isDestroyed: () => false, send: () => undefined } };
    expect([...handlers.keys()].sort()).toEqual([IpcChannels.matteCleanUnused, IpcChannels.matteStorage].sort());
    expect(await handlers.get(IpcChannels.matteStorage)!(event, {})).toMatchObject({ ok: true, unusedBytes: 8 });
    expect(await handlers.get(IpcChannels.matteStorage)!(event, { protectedKeys: ['nope'] })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await handlers.get(IpcChannels.matteCleanUnused)!(event, { approvedKeys: ['a'.repeat(64), 'b'.repeat(64)] })).toMatchObject({
      ok: true,
      removedKeys: ['a'.repeat(64)],
      keptKeys: ['b'.repeat(64)],
    });
    expect(await handlers.get(IpcChannels.matteCleanUnused)!(event, { approvedKeys: 'all' })).toMatchObject({ ok: false, code: 'invalid_request' });
  });
});

describe('generic capability status', () => {
  const propose = (result: CapabilityPackProposalResultWire) => vi.fn(async () => result);
  const proposal = { ok: true, proposal: { proposalId: 'p' } } as unknown as CapabilityPackProposalResultWire;
  const platform = { os: 'darwin', arch: 'arm64' };

  it('reports ready, missing with a proposal, unhealthy with a reason, and unsupported platforms', async () => {
    expect(await resolveCapabilityPackStatus('tracking.point', { records: [], platform, propose: propose(proposal) })).toMatchObject({
      state: 'missing',
      proposal,
    });
    const unhealthy = record({ health: { checkedAt: '2026-09-17T00:00:00.000Z', workerProtocolVersion: 1, status: 'unhealthy', detail: 'checksum failed' } });
    expect(await resolveCapabilityPackStatus('subject.matte', { records: [unhealthy], platform, propose: propose(proposal) })).toMatchObject({
      state: 'unhealthy',
      reason: 'checksum failed',
      proposal,
    });
    expect(await resolveCapabilityPackStatus('subject.matte', { records: [record()], platform: { os: 'linux', arch: 'x64' }, propose: propose(proposal) })).toMatchObject({
      state: 'unsupported_platform',
      capability: 'subject.matte',
    });
    const noArtifact = propose({ ok: false, code: 'platform_unsupported', error: 'none' });
    expect(await resolveCapabilityPackStatus('subject.matte', { records: [], platform, propose: noArtifact })).toMatchObject({
      state: 'missing',
      proposal: { ok: false, code: 'platform_unsupported' },
    });
    // An unknown capability is not an error: the catalog decides whether anything provides it.
    expect(await resolveCapabilityPackStatus('audio.stems', { records: [record()], platform, propose: propose(proposal) })).toMatchObject({ state: 'missing' });
  });

  it('says when this build has no pack catalog, and names the hardware minimum before any download', async () => {
    const unconfigured = propose({ ok: false, code: 'catalog_unconfigured', error: 'Capability Pack catalog is not configured in this build.' });
    const GIB = 1024 ** 3;
    expect(await resolveCapabilityPackStatus('subject.matte', { records: [], platform, propose: unconfigured, totalMemoryBytes: 8 * GIB })).toEqual({
      state: 'catalog_unconfigured',
      capability: 'subject.matte',
      hardware: {
        requirement: 'Apple Silicon Mac or Windows x64 PC with 16 GB of memory',
        platformSupported: true,
        minMemoryBytes: 16 * GIB,
        memoryBytes: 8 * GIB,
        meets: false,
      },
    });
    // Intel Macs publish no Smart Mask artifact: unsupported, with the requirement named.
    expect(
      await resolveCapabilityPackStatus('subject.matte', { records: [], platform: { os: 'darwin', arch: 'x64' }, propose: unconfigured, totalMemoryBytes: 64 * GIB }),
    ).toMatchObject({ state: 'unsupported_platform', hardware: { platformSupported: false, meets: false } });
    expect(await resolveCapabilityPackStatus('subject.matte', { records: [record()], platform, propose: unconfigured, totalMemoryBytes: 32 * GIB })).toMatchObject({
      state: 'ready',
      hardware: { meets: true },
    });
    // Packs without a published minimum carry no hardware block, and still work on Intel Macs.
    const tracking = await resolveCapabilityPackStatus('tracking.point', { records: [], platform: { os: 'darwin', arch: 'x64' }, propose: unconfigured });
    expect(tracking).toEqual({ state: 'catalog_unconfigured', capability: 'tracking.point' });
  });

  it('never proposes a download when a healthy pack is installed', async () => {
    const spy = propose(proposal);
    expect(await resolveCapabilityPackStatus('subject.segment_frame', { records: [record()], platform, propose: spy })).toMatchObject({ state: 'ready' });
    expect(spy).not.toHaveBeenCalled();
  });
});
