import { describe, expect, it } from 'vitest';
import type { CapabilityPackRelease } from './contracts.js';
import { artifactForPlatform } from './selection.js';

const base = {
  url: 'https://packs.framepilot.ai/worker',
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  unpackedSizeBytes: 100,
  format: 'raw' as const,
  entrypoint: 'worker',
  maxFileCount: 1,
  files: ['worker'],
  executableTrust: { kind: 'macos_codesign' as const, teamIdentifier: 'ABCDE12345' },
};

const release = {
  id: 'framepilot.tracking-lite',
  version: '1.0.0',
  releaseDigest: 'b'.repeat(64),
  displayName: 'Tracking Lite',
  description: 'Tracker',
  channel: 'stable',
  capabilities: ['tracking.point'],
  licenses: [],
  privacy: { execution: 'local', mediaLeavesDevice: false, disclosure: 'Local.' },
  compatibility: { minAppVersion: '1.0.0', workerProtocolVersion: 1 },
  artifacts: [
    { ...base, os: 'darwin', arch: 'arm64' },
    { ...base, os: 'win32', arch: 'x64' },
  ],
  dependencies: [],
  conflicts: [],
} as unknown as CapabilityPackRelease;

describe('artifactForPlatform', () => {
  it('selects only the exact operating system and architecture', () => {
    expect(artifactForPlatform(release, { os: 'darwin', arch: 'arm64' })?.os).toBe('darwin');
    expect(artifactForPlatform(release, { os: 'win32', arch: 'x64' })?.os).toBe('win32');
    expect(artifactForPlatform(release, { os: 'darwin', arch: 'x64' })).toBeUndefined();
  });
});
