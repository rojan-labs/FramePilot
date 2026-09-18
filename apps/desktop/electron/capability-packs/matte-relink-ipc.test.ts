import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { InstalledCapabilityPack } from '@framepilot/capability-packs';
import type { Project } from '@framepilot/timeline-schema';
import { IpcChannels } from '../ipc/contract.js';
import { constantRateTiming, fakeMatteInspector, fakeMatteWorker, syntheticFrameHash, type FakeSourceMedia } from './__fixtures__/fake-matte-worker.js';
import { CapabilityPackMatteService, SMART_MASK_PACK_ID } from './matte.js';
import type { MatteIpcEvent } from './matte-ipc.js';
import { registerRelinkIpc } from './matte-relink-ipc.js';

const TIMING = constantRateTiming(30);

async function setup(options: { chosen?: string | undefined; licensed?: boolean } = {}) {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'framepilot-relink-'));
  const projectPath = path.join(projectDir, 'edit.fp.json');
  const original = path.join(projectDir, 'take1.mov');
  const replacement = path.join(projectDir, 'take2.mov');
  await writeFile(original, 'take one');
  await writeFile(replacement, 'take two, different pictures');
  const sources = new Map<string, FakeSourceMedia>([
    [original, { timing: TIMING }],
    [replacement, { timing: TIMING, frameHash: (pts) => syntheticFrameHash(pts, 'other take') }],
  ]);
  const inspector = fakeMatteInspector(sources);
  const record = {
    identity: { id: SMART_MASK_PACK_ID, version: '1.0.0', releaseDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64), os: 'darwin', arch: 'arm64' },
    state: 'installed',
    installRelativePath: 'x',
    installedBytes: 1,
    installedAt: '2026-09-17T00:00:00.000Z',
    lastUsedAt: '2026-09-17T00:00:00.000Z',
    pinnedProjectIds: [],
    activeLeaseCount: 0,
    health: { checkedAt: '2026-09-17T00:00:00.000Z', workerProtocolVersion: 1, status: 'healthy' },
    acquisition: { catalogDigest: 'c'.repeat(64), approvedAt: '2026-09-17T00:00:00.000Z', licenseSpdx: ['MIT'], mediaEgressApproved: false },
  } as InstalledCapabilityPack;
  const matte = new CapabilityPackMatteService({
    storageRoot: '/packs',
    store: { list: async () => [record], acquireLease: async () => ({ release: async () => undefined }) as never },
    platform: { os: 'darwin', arch: 'arm64' },
    propose: async () => ({ ok: false, code: 'x', error: 'x' }),
    inspector,
    runWorker: fakeMatteWorker({ timing: TIMING }),
    isFile: async () => true,
    freeDiskBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const asset = { id: 'asset-1', path: original, kind: 'video', media: { width: 64, height: 36 } };
  const base = { assets: [asset], timeline: { tracks: [], revision: 0 } } as unknown as Project;
  const made = await matte.run(
    {
      requestId: 'job',
      assetId: 'asset-1',
      sourceStart: 0,
      sourceEnd: 0.5,
      prompts: [{ kind: 'box', sourceTime: 0, box: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }],
      foreground: false,
      timelineRevision: 0,
    },
    { projectDir, project: base, projectRevision: 0, readCurrent: async () => ({ revision: 0, project: base }) },
  );
  if (made.status !== 'completed') throw new Error('expected a matte');
  let saved = {
    ...base,
    timeline: { tracks: [{ clips: [{ id: 'clip-1', masks: [{ id: 'm1', kind: 'matte', artifact: made.artifact }] }] }] },
  } as unknown as Project;
  const handlers = new Map<string, (event: MatteIpcEvent, ...args: unknown[]) => unknown>();
  const chooseFile = vi.fn(async () => ('chosen' in options ? options.chosen : replacement));
  registerRelinkIpc({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener), on: () => undefined },
    requireLicense: () => {
      if (options.licensed === false) throw new Error('A valid FramePilot license is required.');
    },
    activeProjectPath: async () => projectPath,
    readProject: async () => saved,
    chooseFile,
    inspector: async () => inspector,
  });
  const event = { sender: { isDestroyed: () => false, send: () => undefined } };
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  return {
    projectDir,
    artifact: made.artifact,
    // The mask as the editor stores it: on a clip of the asset (the artifact has no foreground).
    placeOnAsset: () => {
      saved = {
        ...saved,
        timeline: { tracks: [{ clips: [{ id: 'clip-1', assetId: 'asset-1', masks: [{ id: 'm1', kind: 'matte', decontaminate: false, artifact: made.artifact }] }] }] },
      } as unknown as Project;
    },
    original,
    replacement,
    call,
    chooseFile,
    commit: (path: string) => {
      saved = { ...saved, assets: [{ ...asset, path }] } as unknown as Project;
    },
  };
}

describe('relink and matte re-check IPC', () => {
  it('chooses a file in main and reports mattes on different footage as STALE', async () => {
    const h = await setup();
    expect(await h.call(IpcChannels.projectChooseRelinkFile, 'asset-1')).toEqual({ ok: true, assetId: 'asset-1', path: h.replacement });
    expect(h.chooseFile).toHaveBeenCalledWith('take1.mov');
    // The renderer's relink_asset commit has not reached disk yet: main uses the file it chose.
    expect(await h.call(IpcChannels.matteRecheckMedia, { assetIds: ['asset-1'] })).toEqual({
      ok: true,
      issues: [
        {
          clipId: 'clip-1',
          maskId: 'm1',
          artifactKey: expect.any(String),
          code: 'matte_media_changed',
          status: 'stale',
          remedy: 'Media changed since background removal ran — run Remove background again.',
        },
      ],
    });
    // The choice covered that one re-check; an undo back to the original file is clean again.
    expect(await h.call(IpcChannels.matteRecheckMedia, { assetIds: ['asset-1'] })).toEqual({ ok: true, issues: [] });
  });

  it('treats an unreadable relink target as STALE and relinking back as clean', async () => {
    const h = await setup();
    const copy = path.join(h.projectDir, 'copy.mov');
    await writeFile(copy, 'same pictures, other container');
    h.commit(copy);
    // The fake inspector knows no timing for `copy`: an unreadable relink target cannot vouch.
    expect(((await h.call(IpcChannels.matteRecheckMedia, { assetIds: ['asset-1'] })) as { issues: unknown[] }).issues).toHaveLength(1);
    h.commit(h.original);
    expect(await h.call(IpcChannels.matteRecheckMedia, { assetIds: ['asset-1'] })).toEqual({ ok: true, issues: [] });
  });

  it('reports a deleted artifact as BROKEN with the missing remedy, not as changed media', async () => {
    const h = await setup();
    h.placeOnAsset();
    expect(await h.call(IpcChannels.matteRecheckMedia, { assetIds: ['asset-1'] })).toEqual({ ok: true, issues: [] });
    await rm(path.join(h.projectDir, '.framepilot-derived', 'mattes', h.artifact.key, h.artifact.files[0]!.name));
    expect(await h.call(IpcChannels.matteRecheckMedia, { assetIds: ['asset-1'] })).toEqual({
      ok: true,
      issues: [
        {
          clipId: 'clip-1',
          maskId: 'm1',
          artifactKey: h.artifact.key,
          code: 'matte_missing',
          status: 'broken',
          remedy: 'Background removal data is missing — run Remove background again.',
        },
      ],
    });
    // Scoped to the assets asked about.
    expect(await h.call(IpcChannels.matteRecheckMedia, { assetIds: ['other'] })).toEqual({ ok: true, issues: [] });
  });

  it('refuses unknown assets, cancelled dialogs, folders and links, bad requests and unlicensed callers', async () => {
    const h = await setup();
    expect(await h.call(IpcChannels.projectChooseRelinkFile, 'nope')).toMatchObject({ ok: false, code: 'missing_asset' });
    expect(await h.call(IpcChannels.projectChooseRelinkFile, { id: 'asset-1' })).toMatchObject({ ok: false, code: 'missing_asset' });
    expect(await (await setup({ chosen: undefined })).call(IpcChannels.projectChooseRelinkFile, 'asset-1')).toMatchObject({ code: 'cancelled' });
    const folder = path.join(h.projectDir, 'folder');
    await mkdir(folder);
    expect(await (await setup({ chosen: folder })).call(IpcChannels.projectChooseRelinkFile, 'asset-1')).toMatchObject({ code: 'not_a_file' });
    const link = path.join(h.projectDir, 'link.mov');
    await symlink(h.replacement, link);
    expect(await (await setup({ chosen: link })).call(IpcChannels.projectChooseRelinkFile, 'asset-1')).toMatchObject({ code: 'not_a_file' });
    for (const bad of [{}, { assetIds: [] }, { assetIds: ['a'], path: '/etc/passwd' }, 'asset-1']) {
      expect(await h.call(IpcChannels.matteRecheckMedia, bad)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    await expect((await setup({ licensed: false })).call(IpcChannels.projectChooseRelinkFile, 'asset-1')).rejects.toThrow(/license/);
  });
});
