/**
 * The warning every pack-backed tool shares (BR6.2).
 *
 * These assertions are about honesty, not phrasing: a state with nothing to offer must not offer
 * an action, the browser build must say it needs the desktop app rather than pretend a download
 * would help, and a build without a catalog must not show an Install button that cannot work.
 */
import { describe, expect, it } from 'vitest';
import { hardwareNotice, packToolCopy, SMART_MASK_PACK } from './packToolCopy.js';
import type { PackStatus } from './usePackStatus.js';

const options = { pack: SMART_MASK_PACK, tool: 'Background removal' };

const proposal = {
  proposalId: 'p',
  identity: {
    id: 'smart-mask',
    version: '1',
    releaseDigest: 'a'.repeat(64),
    artifactDigest: 'b'.repeat(64),
    os: 'darwin' as const,
    arch: 'arm64' as const,
  },
  capabilities: ['subject.matte'],
  displayName: 'Smart Mask',
  description: '',
  downloadBytes: 1_050_000_000,
  installedBytes: 2_000_000_000,
  licenses: [{ spdx: 'Apache-2.0', name: 'Apache', noticeUrl: 'https://example.invalid' }],
  privacy: { execution: 'local' as const, mediaLeavesDevice: false, disclosure: '' },
};

describe('packToolCopy', () => {
  it('lets the tool run when the pack is ready', () => {
    const status: PackStatus = {
      kind: 'ready',
      pack: proposal.identity,
      hardware: null,
    };
    expect(packToolCopy(status, options).blocked).toBe(false);
  });

  it('offers the install with its size and licences when the pack is missing', () => {
    const copy = packToolCopy(
      { kind: 'missing', proposal, proposalError: null, hardware: null },
      options,
    );
    expect(copy.blocked).toBe(true);
    expect(copy.action).toBe('install');
    expect(copy.actionLabel).toBe('Install 1.1 GB');
    expect(copy.detail).toContain('Apache-2.0');
    expect(copy.detail).toContain('nothing is uploaded');
    expect(copy.tooltip).toBe('Install the Smart Mask pack first');
  });

  it('points at Settings, with no install button, when the catalog cannot be reached', () => {
    const copy = packToolCopy(
      { kind: 'missing', proposal: null, proposalError: 'offline', hardware: null },
      options,
    );
    expect(copy.action).toBeNull();
    expect(copy.detail).toContain('Settings → Storage');
  });

  it('offers Reinstall for an unhealthy pack and says what failed', () => {
    const copy = packToolCopy(
      { kind: 'unhealthy', reason: 'the entry point did not answer', proposal, hardware: null },
      options,
    );
    expect(copy.action).toBe('reinstall');
    expect(copy.actionLabel).toBe('Reinstall');
    expect(copy.detail).toBe('the entry point did not answer');
  });

  it('names the hardware it needs, and offers nothing, on an unsupported computer', () => {
    const copy = packToolCopy(
      {
        kind: 'unsupported_platform',
        hardware: {
          requirement: 'an Apple Silicon Mac or a Windows x64 PC',
          platformSupported: false,
          minMemoryBytes: 16e9,
          memoryBytes: 8e9,
          meets: false,
        },
      },
      options,
    );
    expect(copy.action).toBeNull();
    expect(copy.detail).toContain('Apple Silicon');
  });

  it('says the browser build cannot run it at all', () => {
    const copy = packToolCopy({ kind: 'unavailable' }, options);
    expect(copy.action).toBeNull();
    expect(copy.headline).toContain('desktop app');
  });

  it('never offers a download from a build with no catalog', () => {
    expect(packToolCopy({ kind: 'catalog_unconfigured', hardware: null }, options)).toMatchObject({
      action: null,
      headline: "Smart Mask can't be installed from this build.",
      detail: null,
    });
    // A development build may register one from disk; a release never shows that sentence.
    expect(
      packToolCopy(
        { kind: 'catalog_unconfigured', hardware: null },
        { ...options, developmentBuild: true },
      ).detail,
    ).toContain('locally registered');
  });

  it('blocks while the answer is still unknown rather than guessing it is ready', () => {
    expect(packToolCopy({ kind: 'checking' }, options).blocked).toBe(true);
  });
});

describe('hardwareNotice', () => {
  it('says nothing to a computer that meets the minimum', () => {
    expect(
      hardwareNotice({
        requirement: 'x',
        platformSupported: true,
        minMemoryBytes: 16e9,
        memoryBytes: 32e9,
        meets: true,
      }),
    ).toBeNull();
  });

  it('warns before any download when there is less memory than the minimum', () => {
    expect(
      hardwareNotice({
        requirement: 'x',
        platformSupported: true,
        minMemoryBytes: 16e9,
        memoryBytes: 8e9,
        meets: false,
      }),
    ).toBe('Needs 16 GB of memory; this computer has 8 GB, so it will run slower.');
  });
});
