import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InstalledCapabilityPack } from '@framepilot/capability-packs';
import type { Project } from '@framepilot/timeline-schema';
import { constantRateTiming, fakeMatteInspector, fakeMatteWorker } from './__fixtures__/fake-matte-worker.js';
import { CapabilityPackMatteService, SMART_MASK_PACK_ID } from './matte.js';
import type { MatteMediaInspector } from './matte-media-inspector.js';
import { matteArtifactDirectory } from './matte-staging.js';
import { MATTE_REMEDIES, validateProjectMattes, type MatteRefusalCode } from './matte-validation.js';

const TIMING = constantRateTiming(30);

async function projectWithMatte() {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'framepilot-matte-validation-'));
  const mediaPath = path.join(projectDir, 'shot.mp4');
  await writeFile(mediaPath, 'bytes');
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
  const inspector = fakeMatteInspector(new Map([[mediaPath, { timing: TIMING }]]));
  const service = new CapabilityPackMatteService({
    storageRoot: '/packs',
    store: { list: async () => [record], acquireLease: async () => ({ release: async () => undefined }) as never },
    platform: { os: 'darwin', arch: 'arm64' },
    propose: async () => ({ ok: false, code: 'x', error: 'x' }),
    inspector,
    runWorker: fakeMatteWorker({ timing: TIMING }),
    isFile: async () => true,
  });
  const asset = { id: 'asset-1', path: mediaPath, kind: 'video', media: { width: 64, height: 36 } };
  const baseProject = { assets: [asset], timeline: { tracks: [], revision: 0 } } as unknown as Project;
  const outcome = await service.run(
    {
      requestId: 'job',
      assetId: 'asset-1',
      sourceStart: 0,
      sourceEnd: 0.5,
      prompts: [{ kind: 'box', sourceTime: 0, box: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }],
      foreground: false,
      timelineRevision: 0,
    },
    { projectDir, project: baseProject, projectRevision: 0, readCurrent: async () => ({ revision: 0, project: baseProject }) },
  );
  if (outcome.status !== 'completed') throw new Error(`expected a matte, got ${JSON.stringify(outcome)}`);
  const mask = { id: 'mask-1', kind: 'matte', enabled: true, decontaminate: false, artifact: outcome.artifact };
  const project = {
    assets: [asset],
    timeline: {
      tracks: [
        { id: 't1', clips: [{ id: 'clip-1', masks: [mask] }, { id: 'clip-2', masks: [mask] }] },
        { id: 't2', clips: [], effectLayers: [{ id: 'fx-1', masks: [{ ...mask, id: 'mask-2' }] }] },
      ],
    },
  };
  return { projectDir, project, directory: matteArtifactDirectory(projectDir, outcome.artifact.key)!, inspector };
}

const codes = (issues: { code: string; clipId: string }[]) => issues.map((issue) => `${issue.clipId}:${issue.code}`);

describe('project matte validation', () => {
  it('passes a verified artifact in quick and full mode', async () => {
    const { projectDir, project, inspector } = await projectWithMatte();
    expect(await validateProjectMattes(projectDir, project, { mode: 'quick' })).toEqual([]);
    expect(await validateProjectMattes(projectDir, project, { mode: 'full', inspector })).toEqual([]);
  });

  it('reports a missing artifact as BROKEN with the engine remedy, on every clip that uses it', async () => {
    const { projectDir, project, directory } = await projectWithMatte();
    await rm(directory, { recursive: true });
    const issues = await validateProjectMattes(projectDir, project, { mode: 'quick' });
    expect(codes(issues)).toEqual(['clip-1:matte_missing', 'clip-2:matte_missing', 'fx-1:matte_missing']);
    expect(issues[0]).toMatchObject({ status: 'broken', remedy: 'Background removal data is missing — run Remove background again.' });
  });

  it('catches a resized file quickly and a same-size edit only with full hashing', async () => {
    const { projectDir, project, directory } = await projectWithMatte();
    const matte = path.join(directory, 'matte.mkv');
    const original = await readFile(matte);
    await writeFile(matte, Buffer.concat([original, Buffer.from('x')]));
    expect(codes(await validateProjectMattes(projectDir, project, { mode: 'quick' }))[0]).toBe('clip-1:matte_digest_mismatch');
    const sameSize = Buffer.from(original);
    sameSize[5] = sameSize[5] === 0x41 ? 0x42 : 0x41;
    await writeFile(matte, sameSize);
    expect(await validateProjectMattes(projectDir, project, { mode: 'quick' })).toEqual([]);
    expect(codes(await validateProjectMattes(projectDir, project, { mode: 'full' }))[0]).toBe('clip-1:matte_digest_mismatch');
  });

  it('reports unreadable frames.json, and probe disagreements as STALE or BROKEN', async () => {
    const { projectDir, project, directory, inspector } = await projectWithMatte();
    const probe = (overrides: object): MatteMediaInspector => ({
      ...inspector,
      probeVideo: async (file) => ({ ...(await inspector.probeVideo(file)), ...overrides }),
    });
    expect(codes(await validateProjectMattes(projectDir, project, { mode: 'full', inspector: probe({ pixelFormat: 'yuv420p' }) }))[0]).toBe(
      'clip-1:matte_unsupported_pixel_format',
    );
    const misaligned = await validateProjectMattes(projectDir, project, { mode: 'full', inspector: probe({ frameCount: 3 }) });
    expect(misaligned[0]).toMatchObject({ code: 'matte_frame_misaligned', status: 'stale' });
    expect(codes(await validateProjectMattes(projectDir, project, { mode: 'full', inspector: probe({ width: 32 }) }))[0]).toBe('clip-1:matte_size_mismatch');
    await rm(path.join(directory, '..', '.results'), { recursive: true });
    await writeFile(path.join(directory, 'frames.json'), '{"version": 9}');
    expect(codes(await validateProjectMattes(projectDir, project, { mode: 'quick' }))[0]).toBe('clip-1:matte_unreadable');
  });

  it('uses exactly the engine refusal codes, statuses and remedy sentences', () => {
    const candidates = [
      path.resolve(process.cwd(), '../../engine/python/framepilot_engine/render/mattes.py'),
      path.resolve(process.cwd(), 'engine/python/framepilot_engine/render/mattes.py'),
    ];
    const file = candidates.find((candidate) => existsSync(candidate));
    expect(file).toBeDefined();
    const source = readFileSync(file!, 'utf8');
    // Join Python's implicitly concatenated string literals across lines.
    const joined = source.replace(/"\s*\n\s*"/gu, '');
    const enumBlock = source.slice(source.indexOf('class MatteRefusalCode'), source.indexOf('#: The one sentence'));
    const engineCodes = [...enumBlock.matchAll(/= "(matte_[a-z_]+)"/gu)].map((match) => match[1]!).sort();
    expect(Object.keys(MATTE_REMEDIES).sort()).toEqual(engineCodes);
    const enumNames = new Map([...enumBlock.matchAll(/([A-Z_]+) = "(matte_[a-z_]+)"/gu)].map((match) => [match[2]!, match[1]!]));
    for (const [code, { status, remedy }] of Object.entries(MATTE_REMEDIES) as [MatteRefusalCode, (typeof MATTE_REMEDIES)[MatteRefusalCode]][]) {
      const entry = new RegExp(
        `MatteRefusalCode\\.${enumNames.get(code)}: \\(\\s*MatteStatus\\.${status.toUpperCase()},\\s*"${escapeRegExp(remedy)}",`,
        'u',
      );
      expect(joined, code).toMatch(entry);
    }
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
