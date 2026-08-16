import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FramePilotBridge } from '@framepilot/shared-types';
import { CapabilityPackStorageSettings } from './CapabilityPackStorageSettings.js';

const identity = {
  id: 'framepilot.subject-intelligence',
  version: '1.2.0',
  releaseDigest: 'a'.repeat(64),
  artifactDigest: 'b'.repeat(64),
  os: 'darwin' as const,
  arch: 'arm64' as const,
};

const storage = {
  rootPath: '/Users/editor/Library/Application Support/FramePilot/capability-packs',
  totalBytes: 1_500,
  installedBytes: 1_000,
  quarantinedBytes: 500,
  pendingRemovalBytes: 0,
  reclaimableBytes: 500,
  projectUsage: { documentary: 1_000 },
  items: [
    {
      identity,
      state: 'installed' as const,
      installedBytes: 1_000,
      lastUsedAt: '2026-08-13T00:00:00.000Z',
      pinnedProjectIds: ['documentary'],
      activeLeaseCount: 1,
      health: 'healthy' as const,
    },
  ],
};

function bridge(): FramePilotBridge {
  return {
    capabilityPackStorage: vi.fn(async () => storage),
    capabilityPackPlanEviction: vi.fn(async () => ({
      ok: true as const,
      plan: {
        planId: 'plan-1',
        requestedBytes: 1_073_741_824,
        reclaimableBytes: 500,
        sufficient: false,
        candidates: [
          {
            identity: { ...identity, id: 'framepilot.bad-pack' },
            installedBytes: 500,
            affectedProjectIds: [],
            activeLeaseCount: 0,
          },
        ],
      },
    })),
    capabilityPackExecuteEviction: vi.fn(async () => ({
      ok: true as const,
      storage: { ...storage, totalBytes: 1_000, reclaimableBytes: 0 },
    })),
    capabilityPackRelocate: vi.fn(async () => ({
      ok: true as const,
      storage: { ...storage, rootPath: '/Volumes/Fast/FramePilot Packs' },
      previousRoot: storage.rootPath,
    })),
    onCapabilityPackProgress: vi.fn(() => () => undefined),
    onCapabilityPackRelocationProgress: vi.fn(() => () => undefined),
  } as unknown as FramePilotBridge;
}

afterEach(() => {
  delete window.framepilot;
});

describe('CapabilityPackStorageSettings', () => {
  it('shows authoritative storage, project pins, leases, and external pack location', async () => {
    window.framepilot = bridge();
    render(<CapabilityPackStorageSettings />);

    expect(await screen.findByText('framepilot.subject-intelligence')).toBeTruthy();
    expect(screen.getByText(/pinned by 1 project/)).toBeTruthy();
    expect(screen.getByText(/1 active worker/)).toBeTruthy();
    expect(screen.getByText(storage.rootPath)).toBeTruthy();
  });

  it('reviews cleanup without mutation and sends only the exact displayed identity on confirm', async () => {
    const host = bridge();
    window.framepilot = host;
    render(<CapabilityPackStorageSettings />);
    await screen.findByText('framepilot.subject-intelligence');

    fireEvent.click(screen.getByRole('button', { name: 'Review cleanup' }));
    expect(await screen.findByRole('region', { name: 'Cleanup confirmation' })).toBeTruthy();
    expect(host.capabilityPackExecuteEviction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove exactly these packs' }));
    await waitFor(() =>
      expect(host.capabilityPackExecuteEviction).toHaveBeenCalledWith({
        planId: 'plan-1',
        approvedIdentityKeys: [
          `framepilot.bad-pack/1.2.0/darwin/arm64/${'b'.repeat(64)}`,
        ],
      }),
    );
  });

  it('does not offer native pack operations in browser mode', () => {
    render(<CapabilityPackStorageSettings />);
    expect(screen.getByText('On-demand packs are managed by the desktop app')).toBeTruthy();
  });

  it('moves storage only through the native host flow and reports the retained source', async () => {
    const host = bridge();
    window.framepilot = host;
    render(<CapabilityPackStorageSettings />);
    await screen.findByText(storage.rootPath);

    fireEvent.click(screen.getByRole('button', { name: 'Move storage…' }));

    await waitFor(() => expect(host.capabilityPackRelocate).toHaveBeenCalledOnce());
    expect(await screen.findByText('/Volumes/Fast/FramePilot Packs')).toBeTruthy();
    expect(screen.getByText(/previous copy remains/)).toBeTruthy();
  });
});
