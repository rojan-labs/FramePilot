import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { InstalledCapabilityPack } from '@framepilot/capability-packs';
import type { Project } from '@framepilot/timeline-schema';
import { constantRateTiming, fakeMatteInspector, fakeMatteWorker, syntheticFrameHash, type FakeSourceMedia } from './__fixtures__/fake-matte-worker.js';
import { CapabilityPackMatteService, SMART_MASK_PACK_ID } from './matte.js';
import { MATTE_MEDIA_CHANGED, recheckProjectMatteMedia } from './matte-media-recheck.js';
import { readMatteRecord } from './matte-store.js';
import { MATTE_REMEDIES } from './matte-validation.js';

const TIMING = constantRateTiming(60);

async function setup() {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'framepilot-matte-recheck-'));
  const mediaPath = path.join(projectDir, 'shot.mp4');
  await writeFile(mediaPath, 'original camera bytes');
  const source: { current: FakeSourceMedia } = { current: { timing: TIMING } };
  const sources = new Map<string, FakeSourceMedia>();
  const inspector = fakeMatteInspector(sources);
  sources.set(mediaPath, source.current);
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
  const service = new CapabilityPackMatteService({
    storageRoot: '/packs',
    store: { list: async () => [record], acquireLease: async () => ({ release: async () => undefined }) as never },
    platform: { os: 'darwin', arch: 'arm64' },
    propose: async () => ({ ok: false, code: 'x', error: 'x' }),
    inspector,
    runWorker: fakeMatteWorker({ timing: TIMING }),
    isFile: async () => true,
    freeDiskBytes: async () => Number.MAX_SAFE_INTEGER,
  });
  const asset = { id: 'asset-1', path: mediaPath, kind: 'video', media: { width: 64, height: 36 } };
  const base = { assets: [asset], timeline: { tracks: [], revision: 0 } } as unknown as Project;
  const outcome = await service.run(
    {
      requestId: 'job',
      assetId: 'asset-1',
      sourceStart: 0,
      sourceEnd: 1,
      prompts: [{ kind: 'box', sourceTime: 0, box: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }],
      foreground: false,
      timelineRevision: 0,
    },
    { projectDir, project: base, projectRevision: 0, readCurrent: async () => ({ revision: 0, project: base }) },
  );
  if (outcome.status !== 'completed') throw new Error('expected a matte');
  const project = {
    assets: [asset],
    timeline: { tracks: [{ clips: [{ id: 'clip-1', masks: [{ id: 'm1', kind: 'matte', artifact: outcome.artifact }] }] }] },
  };
  return { projectDir, mediaPath, project, inspector, sources, key: outcome.artifact.key };
}

describe('matte media re-check after relink or replace', () => {
  it('records the exact first and last frame plus 16 samples at commit', async () => {
    const { projectDir, key } = await setup();
    const record = await readMatteRecord(projectDir, key);
    expect(record?.sourceSamples).toHaveLength(18);
    expect(record?.sourceSamples[0]).toEqual({ pts: TIMING.pts[0], sha256: syntheticFrameHash(TIMING.pts[0]!, 'source') });
    expect(record?.sourceSamples.at(-1)?.pts).toBe(TIMING.pts[29]);
  });

  it('keeps mattes when nothing changed, without decoding a frame', async () => {
    const { projectDir, project, inspector } = await setup();
    const spy = vi.spyOn(inspector, 'frameHashesByPts');
    expect(await recheckProjectMatteMedia(projectDir, project, inspector)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps mattes when the file changed but every sampled frame decodes identically (a remux)', async () => {
    const { projectDir, project, inspector, mediaPath } = await setup();
    await writeFile(mediaPath, 'remuxed container, same pictures');
    expect(await recheckProjectMatteMedia(projectDir, project, inspector)).toEqual([]);
  });

  it('marks mattes STALE with the media-changed remedy when a sampled frame differs', async () => {
    const { projectDir, project, inspector, mediaPath, sources } = await setup();
    await writeFile(mediaPath, 'a different take');
    sources.set(mediaPath, { timing: TIMING, frameHash: (pts) => (pts === TIMING.pts[29] ? 'f'.repeat(64) : syntheticFrameHash(pts, 'source')) });
    expect(await recheckProjectMatteMedia(projectDir, project, inspector)).toEqual([
      {
        clipId: 'clip-1',
        maskId: 'm1',
        artifactKey: expect.any(String),
        code: MATTE_MEDIA_CHANGED,
        status: 'stale',
        remedy: MATTE_REMEDIES.matte_size_mismatch.remedy,
      },
    ]);
    // Scoped to the relinked assets only.
    expect(await recheckProjectMatteMedia(projectDir, project, inspector, { assetIds: ['other'] })).toEqual([]);
  });

  it('treats undecodable or unreadable media as changed', async () => {
    const { projectDir, project, inspector, mediaPath, sources } = await setup();
    await writeFile(mediaPath, 'truncated');
    sources.set(mediaPath, { timing: TIMING, frameHash: () => undefined });
    expect(await recheckProjectMatteMedia(projectDir, project, inspector)).toHaveLength(1);
    const missing = { ...project, assets: [{ id: 'asset-1', path: path.join(projectDir, 'gone.mp4') }] };
    expect(await recheckProjectMatteMedia(projectDir, missing, inspector)).toHaveLength(1);
  });
});
