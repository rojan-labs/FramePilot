import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CapabilityPackInstallProposalWire, FramePilotBridge } from '@framepilot/shared-types';
import { PackInstallInlineCard, packMissingProposal } from './PackInstallInlineCard.js';

const proposal: CapabilityPackInstallProposalWire = {
  proposalId: 'a'.repeat(64),
  identity: {
    id: 'framepilot.subject-intelligence',
    version: '1.0.0',
    releaseDigest: 'b'.repeat(64),
    artifactDigest: 'c'.repeat(64),
    os: 'darwin',
    arch: 'arm64',
  },
  capabilities: ['subject.detect', 'subject.segment'],
  displayName: 'Subject Intelligence',
  description: 'Face/person detection and subject segmentation.',
  downloadBytes: 42_000_000,
  installedBytes: 120_000_000,
  licenses: [{ spdx: 'Apache-2.0', name: 'Apache 2.0', noticeUrl: 'https://example.org/apache' }],
  privacy: {
    execution: 'local' as const,
    mediaLeavesDevice: false,
    disclosure: 'Media is processed entirely on this machine.',
  },
};

afterEach(() => {
  delete window.framepilot;
});

describe('packMissingProposal', () => {
  it('extracts a signed proposal only from a well-formed pack_missing payload', () => {
    const good = { code: 'pack_missing', proposal: { ok: true, proposal } };
    expect(packMissingProposal(good)).toEqual(proposal);
    expect(packMissingProposal({ code: 'pack_missing', proposal: { ok: false } })).toBeNull();
    expect(packMissingProposal({ code: 'timed_out', error: 'x' })).toBeNull();
    expect(packMissingProposal(null)).toBeNull();
  });
});

describe('PackInstallInlineCard', () => {
  function host(overrides: Partial<FramePilotBridge> = {}): FramePilotBridge {
    return {
      capabilityPackPropose: vi.fn(async () => ({ ok: true as const, proposal })),
      capabilityPackInstall: vi.fn(async () => ({ ok: true as const, operationId: 'op-1' })),
      onCapabilityPackProgress: vi.fn((listener: (m: { operationId: string; phase: string }) => void) => {
        queueMicrotask(() =>
          listener({ operationId: 'op-1', phase: 'installed' }),
        );
        return () => undefined;
      }),
      ...overrides,
    } as FramePilotBridge;
  }

  it('shows the exact signed offer and installs after approval, then asks to re-run', async () => {
    window.framepilot = host();
    render(<PackInstallInlineCard proposal={proposal} />);
    expect(screen.getByRole('dialog').textContent).toContain('Subject Intelligence');
    expect(screen.getByRole('dialog').textContent).toContain('42.0 MB');
    fireEvent.click(screen.getByRole('button', { name: /Install 42.0 MB/ }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Run the request again'),
    );
    expect(window.framepilot.capabilityPackInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: proposal.proposalId,
        approvedSizeBytes: proposal.downloadBytes,
        approvedLicenseSpdx: ['Apache-2.0'],
        approvedMediaEgress: false,
      }),
    );
  });

  it('refuses to install when the fresh proposal drifted from the displayed one', async () => {
    const drifted = { ...proposal, downloadBytes: 99_000_000 };
    window.framepilot = host({
      capabilityPackPropose: vi.fn(async () => ({ ok: true as const, proposal: drifted })),
    });
    render(<PackInstallInlineCard proposal={proposal} />);
    fireEvent.click(screen.getByRole('button', { name: /Install 42.0 MB/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/changed|did not finish/i));
    expect(window.framepilot.capabilityPackInstall).not.toHaveBeenCalled();
  });

  it('can be dismissed without any network or install side effect', () => {
    window.framepilot = host();
    render(<PackInstallInlineCard proposal={proposal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.framepilot.capabilityPackInstall).not.toHaveBeenCalled();
  });
});
