import { describe, expect, it, vi } from 'vitest';
import type { CapabilityPackInstallIdentity } from '../install-contracts.js';
import type { BoundedCommandRunner } from './executable-verifier.js';
import { CapabilityPackHealthError, healthCheckCapabilityPackWorker } from './worker-health.js';

const identity: CapabilityPackInstallIdentity = {
  id: 'framepilot.subject-intelligence',
  version: '1.2.0',
  releaseDigest: 'a'.repeat(64),
  artifactDigest: 'b'.repeat(64),
  os: 'darwin',
  arch: 'arm64',
};
const capabilities = ['tracking.face', 'tracking.segmentation'];

function handshake(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'handshake',
    protocolVersion: 1,
    pack: {
      id: identity.id,
      version: identity.version,
      releaseDigest: identity.releaseDigest,
    },
    capabilities,
    hardwareBackend: 'metal',
    modelDigests: { segmenter: 'c'.repeat(64) },
    ...overrides,
  });
}

describe('healthCheckCapabilityPackWorker', () => {
  it('accepts one bounded handshake with exact identity, protocol, and capabilities', async () => {
    const runner = vi.fn<BoundedCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: handshake(),
      stderr: '',
    });

    const result = await healthCheckCapabilityPackWorker(
      '/packs/subject-worker',
      identity,
      capabilities,
      runner,
    );

    expect(result.hardwareBackend).toBe('metal');
    expect(runner).toHaveBeenCalledWith({
      executable: '/packs/subject-worker',
      args: ['--framepilot-health-check'],
      env: {
        FRAMEPILOT_CAPABILITY_PACK_HEALTH_CHECK: '1',
        FRAMEPILOT_CAPABILITY_PACK_NETWORK: 'disabled',
        FRAMEPILOT_CAPABILITY_PACK_ID: identity.id,
        FRAMEPILOT_CAPABILITY_PACK_VERSION: identity.version,
        FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST: identity.releaseDigest,
        FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES: JSON.stringify([...capabilities].sort()),
      },
    });
  });

  it.each([
    ['wrong release', handshake({ pack: { ...identity, releaseDigest: 'd'.repeat(64) } })],
    ['extra capability', handshake({ capabilities: [...capabilities, 'tracking.secret'] })],
    ['missing capability', handshake({ capabilities: ['tracking.face'] })],
  ])('rejects %s as a protocol mismatch', async (_label, stdout) => {
    const runner = vi.fn<BoundedCommandRunner>().mockResolvedValue({ exitCode: 0, stdout, stderr: '' });
    await expect(
      healthCheckCapabilityPackWorker('/packs/worker', identity, capabilities, runner),
    ).rejects.toMatchObject({ code: 'protocol_mismatch' });
  });

  it('distinguishes unsupported protocol from malformed health output', async () => {
    const wrongProtocol = vi.fn<BoundedCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: handshake({ protocolVersion: 2 }),
      stderr: '',
    });
    await expect(
      healthCheckCapabilityPackWorker('/packs/worker', identity, capabilities, wrongProtocol),
    ).rejects.toMatchObject({ code: 'protocol_mismatch' });

    const malformed = vi.fn<BoundedCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: 'worker log before json',
      stderr: '',
    });
    await expect(
      healthCheckCapabilityPackWorker('/packs/worker', identity, capabilities, malformed),
    ).rejects.toBeInstanceOf(CapabilityPackHealthError);
  });

  it('fails closed on nonzero worker exit', async () => {
    const runner = vi.fn<BoundedCommandRunner>().mockResolvedValue({
      exitCode: 5,
      stdout: '',
      stderr: 'model could not load',
    });
    await expect(
      healthCheckCapabilityPackWorker('/packs/worker', identity, capabilities, runner),
    ).rejects.toMatchObject({ code: 'health_check_failed' });
  });

  it('merges extras but never lets them override host-owned keys', async () => {
    let seenEnv: Readonly<Record<string, string>> | undefined;
    const runner = vi.fn<BoundedCommandRunner>().mockImplementation(async (request) => {
      seenEnv = request.env;
      return { exitCode: 0, stdout: handshake(), stderr: '' };
    });

    await healthCheckCapabilityPackWorker('/packs/subject-worker', identity, capabilities, runner, undefined, {
      FRAMEPILOT_CAPABILITY_PACK_ROOT: '/packs/root',
      FRAMEPILOT_CAPABILITY_PACK_NETWORK: 'enabled',
      FRAMEPILOT_CAPABILITY_PACK_ID: 'framepilot.evil',
      SECRET_TOKEN: 'nope',
    });

    expect(seenEnv?.FRAMEPILOT_CAPABILITY_PACK_ROOT).toBe('/packs/root');
    expect(seenEnv?.FRAMEPILOT_CAPABILITY_PACK_NETWORK).toBe('disabled');
    expect(seenEnv?.FRAMEPILOT_CAPABILITY_PACK_ID).toBe(identity.id);
    expect(seenEnv?.SECRET_TOKEN).toBeUndefined();
  });
});
