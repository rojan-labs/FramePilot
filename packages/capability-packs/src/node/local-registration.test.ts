import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEV_PACK_REGISTRATION_ENV,
  LocalRegistrationDisabledError,
  registerLocalCapabilityPack,
} from './local-registration.js';
import { CapabilityPackHealthError } from './worker-health.js';
import { FileCapabilityPackStore } from './storage.js';

let storeRoot = '';
let payloadRoot = '';

beforeEach(async () => {
  storeRoot = await mkdtemp(path.join(tmpdir(), 'fp-pack-store-'));
  payloadRoot = await mkdtemp(path.join(tmpdir(), 'fp-pack-payload-'));
  await mkdir(path.join(payloadRoot, 'bin'), { recursive: true });
  await writeFile(path.join(payloadRoot, 'bin', 'framepilot-tracking-lite'), '#!/bin/sh\n');
});

afterEach(async () => {
  await rm(storeRoot, { recursive: true, force: true });
  await rm(payloadRoot, { recursive: true, force: true });
});

const input = () => ({
  packId: 'framepilot.tracking-lite',
  version: '1.0.0-dev.local',
  payloadRoot,
  entrypoint: 'bin/framepilot-tracking-lite',
  capabilities: ['tracking.point', 'tracking.region', 'tracking.planar'],
  licenses: ['Apache-2.0'],
  os: 'darwin' as const,
  arch: 'arm64' as const,
});

const handshakeFor = (requestIdentity: {
  id: string;
  version: string;
  releaseDigest: string;
}): string =>
  JSON.stringify({
    type: 'handshake',
    protocolVersion: 1,
    pack: requestIdentity,
    capabilities: ['tracking.planar', 'tracking.point', 'tracking.region'],
    hardwareBackend: 'opencv',
    modelDigests: {},
  });

describe('registerLocalCapabilityPack', () => {
  it('refuses to run without the dev registration flag', async () => {
    await expect(registerLocalCapabilityPack({}, input(), { storeRoot })).rejects.toBeInstanceOf(
      LocalRegistrationDisabledError,
    );
    await expect(
      registerLocalCapabilityPack({ [DEV_PACK_REGISTRATION_ENV]: '0' }, input(), { storeRoot }),
    ).rejects.toBeInstanceOf(LocalRegistrationDisabledError);
  });

  it('health-checks the staged worker and records a healthy installed pack', async () => {
    const seenEnvs: Readonly<Record<string, string | undefined>>[] = [];
    let stagedExecutable = '';
    const result = await registerLocalCapabilityPack(
      { [DEV_PACK_REGISTRATION_ENV]: '1' },
      input(),
      {
        storeRoot,
        now: () => new Date('2026-08-20T00:00:00.000Z'),
        runHealthCommand: async (request) => {
          stagedExecutable = request.executable;
          seenEnvs.push(request.env ?? {});
          return {
            exitCode: 0,
            stdout: handshakeFor({
              id: 'framepilot.tracking-lite',
              version: '1.0.0-dev.local',
              // The digest is content-derived; echo whatever the check approved.
              releaseDigest: seenEnvs[0]?.FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST ?? '',
            }),
            stderr: '',
          };
        },
      },
    );

    expect(seenEnvs[0]?.FRAMEPILOT_CAPABILITY_PACK_ID).toBe('framepilot.tracking-lite');
    expect(seenEnvs[0]?.FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES).toBe(
      JSON.stringify(['tracking.planar', 'tracking.point', 'tracking.region']),
    );
    expect(result.record.state).toBe('installed');
    expect(result.record.health.status).toBe('healthy');
    expect(result.record.health.detail).toContain('opencv');
    expect(result.record.identity.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.record.installedBytes).toBeGreaterThan(0);
    expect(result.record.acquisition.licenseSpdx).toEqual(['Apache-2.0']);
    expect(result.record.acquisition.mediaEgressApproved).toBe(false);
    // The staged copy — not the build tree — is what the store resolves.
    expect(await readFile(`${result.entrypointPath}`, 'utf8')).toBe('#!/bin/sh\n');
    expect(stagedExecutable).toBe(result.entrypointPath);
    expect(result.record.installRelativePath.split('/')).toEqual([
      'packs',
      'framepilot.tracking-lite',
      '1.0.0-dev.local',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      'darwin-arm64',
      result.record.identity.artifactDigest,
    ]);

    const records = await new FileCapabilityPackStore(storeRoot).list();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(result.record);
  });

  it('replaces the record when the same bytes are registered again', async () => {
    const runOnce = () =>
      registerLocalCapabilityPack({ [DEV_PACK_REGISTRATION_ENV]: '1' }, input(), {
        storeRoot,
        runHealthCommand: async (request) => ({
          exitCode: 0,
          stdout: handshakeFor({
            id: 'framepilot.tracking-lite',
            version: '1.0.0-dev.local',
            releaseDigest: request.env?.FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST ?? '',
          }),
          stderr: '',
        }),
      });
    const first = await runOnce();
    const second = await runOnce();
    expect(second.identityKey).toBe(first.identityKey);
    const records = await new FileCapabilityPackStore(storeRoot).list();
    expect(records).toHaveLength(1);
  });

  it('registers changed payloads under a distinct identity instead of shadowing', async () => {
    const runWith = (entrypointBody: string) =>
      registerLocalCapabilityPack({ [DEV_PACK_REGISTRATION_ENV]: '1' }, input(), {
        storeRoot,
        runHealthCommand: async (request) => ({
          exitCode: 0,
          stdout: handshakeFor({
            id: 'framepilot.tracking-lite',
            version: '1.0.0-dev.local',
            releaseDigest: request.env?.FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST ?? '',
          }),
          stderr: '',
        }),
      }).then(async () => {
        await writeFile(path.join(payloadRoot, 'bin', 'framepilot-tracking-lite'), entrypointBody);
      });

    await runWith('#!/bin/sh\n# v1\n');
    const firstRecords = await new FileCapabilityPackStore(storeRoot).list();
    await runWith('#!/bin/sh\n# v2\n');
    const bothRecords = await new FileCapabilityPackStore(storeRoot).list();

    expect(firstRecords).toHaveLength(1);
    expect(bothRecords).toHaveLength(2);
    expect(bothRecords[0]!.identity.artifactDigest).not.toBe(
      bothRecords[1]!.identity.artifactDigest,
    );
  });

  it('registers nothing and cleans the staging copy when the health check fails', async () => {
    await mkdir(storeRoot, { recursive: true });
    const error = await registerLocalCapabilityPack(
      { [DEV_PACK_REGISTRATION_ENV]: '1' },
      input(),
      { storeRoot, runHealthCommand: async () => ({ exitCode: 3, stdout: '', stderr: 'boom' }) },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CapabilityPackHealthError);
    const records = await new FileCapabilityPackStore(storeRoot).list();
    expect(records).toHaveLength(0);
    // The staging tree must not keep an unchecked copy of the payload behind.
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      const { readdir } = await import('node:fs/promises');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else files.push(absolute);
      }
    };
    await walk(path.join(storeRoot, 'packs'));
    expect(files).toEqual([]);
  });

  it('rejects an entrypoint that escapes the payload root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), `fp-outside-${randomUUID()}-`));
    try {
      await expect(
        registerLocalCapabilityPack(
          { [DEV_PACK_REGISTRATION_ENV]: '1' },
          { ...input(), entrypoint: '../outside/framepilot-tracking-lite' },
          { storeRoot, runHealthCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
        ),
      ).rejects.toThrow('path traversal is forbidden');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
