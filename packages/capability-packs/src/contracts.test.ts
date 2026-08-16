import { describe, expect, it } from 'vitest';
import {
  CapabilityPackArtifactSchema,
  CapabilityPackReleaseCoreSchema,
  CapabilityPackWorkerHandshakeSchema,
} from './contracts.js';

const artifact = {
  os: 'darwin' as const,
  arch: 'arm64' as const,
  url: 'https://packs.framepilot.ai/tracking-lite/1.0.0/darwin-arm64.zip',
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  unpackedSizeBytes: 200,
  format: 'zip' as const,
  entrypoint: 'bin/tracking-worker',
  maxFileCount: 10,
  files: ['bin/tracking-worker', 'NOTICE.txt'],
  executableTrust: { kind: 'macos_codesign' as const, teamIdentifier: 'ABCDE12345' },
};

describe('Capability Pack contracts', () => {
  it('accepts a bounded platform artifact with an allowlisted entrypoint', () => {
    expect(CapabilityPackArtifactSchema.parse(artifact)).toEqual(artifact);
  });

  it.each([
    ['insecure transport', { ...artifact, url: 'http://packs.framepilot.ai/worker.zip' }],
    ['absolute entrypoint', { ...artifact, entrypoint: '/bin/worker' }],
    ['traversal entrypoint', { ...artifact, entrypoint: '../worker' }],
    ['entrypoint outside allowlist', { ...artifact, entrypoint: 'bin/other' }],
    ['duplicate files', { ...artifact, files: ['bin/tracking-worker', 'bin/tracking-worker'] }],
    ['multiple files in raw artifact', { ...artifact, format: 'raw' }],
    [
      'wrong platform trust policy',
      {
        ...artifact,
        executableTrust: { kind: 'windows_authenticode', certificateSha256: 'b'.repeat(64) },
      },
    ],
  ])('rejects %s', (_label, input) => {
    expect(CapabilityPackArtifactSchema.safeParse(input).success).toBe(false);
  });

  it('rejects duplicate platform artifacts and capability ids', () => {
    const release = {
      id: 'framepilot.tracking-lite',
      version: '1.0.0',
      displayName: 'Tracking Lite',
      description: 'Point, region, and planar tracking.',
      channel: 'stable',
      capabilities: ['tracking.point', 'tracking.point'],
      licenses: [
        {
          spdx: 'MIT',
          name: 'MIT License',
          noticeUrl: 'https://framepilot.ai/licenses/tracking-lite',
          redistribution: 'allowed',
        },
      ],
      privacy: { execution: 'local', mediaLeavesDevice: false, disclosure: 'Runs locally.' },
      compatibility: { minAppVersion: '1.0.0', workerProtocolVersion: 1 },
      artifacts: [artifact, artifact],
      dependencies: [],
      conflicts: [],
    };
    const result = CapabilityPackReleaseCoreSchema.safeParse(release);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          'release capabilities contain duplicates',
          'a release may publish only one artifact per platform and architecture',
        ]),
      );
    }
  });

  it('requires workers to prove pack identity and protocol during handshake', () => {
    const handshake = CapabilityPackWorkerHandshakeSchema.parse({
      type: 'handshake',
      protocolVersion: 1,
      pack: {
        id: 'framepilot.tracking-lite',
        version: '1.0.0',
        releaseDigest: 'b'.repeat(64),
      },
      capabilities: ['tracking.point'],
      hardwareBackend: 'metal',
      modelDigests: {},
    });
    expect(handshake.pack.releaseDigest).toHaveLength(64);
  });
});
