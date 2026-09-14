import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstalledCapabilityPack } from '@framepilot/capability-packs';
import {
  VISUAL_DESCRIBE_PACK_ID,
  VISUAL_EMBED_PACK_ID,
  autoEnrolmentTiers,
  resolveVisualPackHandles,
  resolveVisualPackIdentities,
} from './visual-packs.js';

const roots: string[] = [];
const timestamp = '2026-09-13T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'framepilot-visual-packs-'));
  roots.push(root);
  return root;
}

function record(
  id: string,
  version: string,
  overrides: Partial<Pick<InstalledCapabilityPack, 'state' | 'health'>> = {},
): InstalledCapabilityPack {
  return {
    identity: {
      id,
      version,
      releaseDigest: 'b'.repeat(64),
      artifactDigest: 'a'.repeat(64),
      os: 'darwin',
      arch: 'arm64',
    },
    state: 'installed',
    installRelativePath: `packs/${id}/${version}/darwin-arm64/${'a'.repeat(64)}`,
    installedBytes: 1,
    installedAt: timestamp,
    lastUsedAt: timestamp,
    pinnedProjectIds: [],
    activeLeaseCount: 0,
    health: { checkedAt: timestamp, workerProtocolVersion: 1, status: 'healthy' },
    acquisition: {
      catalogDigest: 'c'.repeat(64),
      approvedAt: timestamp,
      licenseSpdx: ['Apache-2.0'],
      mediaEgressApproved: false,
    },
    ...overrides,
  };
}

async function install(root: string, pack: InstalledCapabilityPack, executable: string) {
  const bin = path.join(root, pack.installRelativePath, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, executable), '#!/bin/sh\n', 'utf8');
}

describe('resolveVisualPackHandles', () => {
  it('builds the handle the engine parses for each installed, healthy pack', async () => {
    const root = await createRoot();
    const embed = record(VISUAL_EMBED_PACK_ID, '1.0.0');
    const describePack = record(VISUAL_DESCRIBE_PACK_ID, '1.0.0');
    await install(root, embed, 'framepilot-visual-embed');
    await install(root, describePack, 'framepilot-visual-describe');
    const cacheRoot = path.join(root, 'cache');

    const handles = await resolveVisualPackHandles({
      records: [embed, describePack],
      storageRoot: root,
      cacheRoot,
      os: 'darwin',
    });

    const installRoot = path.join(root, embed.installRelativePath);
    expect(JSON.parse(handles.visualEmbedPack ?? '{}')).toEqual({
      packId: VISUAL_EMBED_PACK_ID,
      version: '1.0.0',
      releaseDigest: 'b'.repeat(64),
      entrypoint: path.join(installRoot, 'bin/framepilot-visual-embed'),
      capabilities: ['visual.embed', 'visual.text'],
      root: installRoot,
      cache: path.join(cacheRoot, VISUAL_EMBED_PACK_ID, '1.0.0'),
    });
    expect(JSON.parse(handles.visualDescribePack ?? '{}')).toMatchObject({
      packId: VISUAL_DESCRIBE_PACK_ID,
      capabilities: ['visual.describe'],
    });
  });

  it('prefers the newest healthy release and never runs a quarantined one', async () => {
    const root = await createRoot();
    const older = record(VISUAL_EMBED_PACK_ID, '1.0.0');
    const newer = record(VISUAL_EMBED_PACK_ID, '1.2.0');
    const quarantined = record(VISUAL_EMBED_PACK_ID, '2.0.0', { state: 'quarantined' });
    for (const pack of [older, newer, quarantined]) {
      await install(root, pack, 'framepilot-visual-embed');
    }

    const handles = await resolveVisualPackHandles({
      records: [older, quarantined, newer],
      storageRoot: root,
      cacheRoot: path.join(root, 'cache'),
      os: 'darwin',
    });

    expect(JSON.parse(handles.visualEmbedPack ?? '{}').version).toBe('1.2.0');
  });

  it('sends no handle for an unhealthy pack or one missing its executable', async () => {
    const root = await createRoot();
    const unhealthy = record(VISUAL_EMBED_PACK_ID, '1.0.0', {
      health: { checkedAt: timestamp, workerProtocolVersion: 1, status: 'unhealthy' },
    });
    await install(root, unhealthy, 'framepilot-visual-embed');
    const incomplete = record(VISUAL_DESCRIBE_PACK_ID, '1.0.0');

    const handles = await resolveVisualPackHandles({
      records: [unhealthy, incomplete],
      storageRoot: root,
      cacheRoot: path.join(root, 'cache'),
      os: 'darwin',
    });

    expect(handles).toEqual({});
  });
});

describe('resolveVisualPackIdentities', () => {
  it('names the identity behind each field resolveVisualPackHandles would resolve', () => {
    const embed = record(VISUAL_EMBED_PACK_ID, '1.0.0');
    const describePack = record(VISUAL_DESCRIBE_PACK_ID, '1.0.0');

    const identities = resolveVisualPackIdentities([embed, describePack]);

    expect(identities.visualEmbedPack).toEqual(embed.identity);
    expect(identities.visualDescribePack).toEqual(describePack.identity);
  });

  it('agrees with resolveVisualPackHandles on the newest healthy release', async () => {
    const root = await createRoot();
    const older = record(VISUAL_EMBED_PACK_ID, '1.0.0');
    const newer = record(VISUAL_EMBED_PACK_ID, '1.2.0');
    const quarantined = record(VISUAL_EMBED_PACK_ID, '2.0.0', { state: 'quarantined' });
    for (const pack of [older, newer, quarantined]) {
      await install(root, pack, 'framepilot-visual-embed');
    }
    const records = [older, quarantined, newer];

    const handles = await resolveVisualPackHandles({
      records,
      storageRoot: root,
      cacheRoot: path.join(root, 'cache'),
      os: 'darwin',
    });
    const identities = resolveVisualPackIdentities(records);

    expect(JSON.parse(handles.visualEmbedPack ?? '{}').version).toBe(
      identities.visualEmbedPack?.version,
    );
    expect(identities.visualEmbedPack?.version).toBe('1.2.0');
  });

  it('names no identity for an unhealthy pack', () => {
    const unhealthy = record(VISUAL_EMBED_PACK_ID, '1.0.0', {
      health: { checkedAt: timestamp, workerProtocolVersion: 1, status: 'unhealthy' },
    });

    expect(resolveVisualPackIdentities([unhealthy])).toEqual({});
  });
});

describe('autoEnrolmentTiers', () => {
  it('keeps an import to the keyless floor when nothing else is consented', () => {
    expect(autoEnrolmentTiers({ hostedLabelsConfigured: false, handles: {} })).toEqual([
      'measured',
    ]);
  });

  it('labels on a hosted key but never describes hosted from an import', () => {
    expect(autoEnrolmentTiers({ hostedLabelsConfigured: true, handles: {} })).toEqual([
      'measured',
      'labelled',
    ]);
  });

  it('fills the tiers an installed local pack provides', () => {
    expect(
      autoEnrolmentTiers({
        hostedLabelsConfigured: false,
        handles: { visualEmbedPack: '{}', visualDescribePack: '{}' },
      }),
    ).toEqual(['measured', 'labelled', 'described']);
  });
});
