import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityPackProgressWire, FramePilotBridge } from '@framepilot/shared-types';
import { CapabilityPackDependencyDialog } from './CapabilityPackDependencyDialog.js';

const releaseDigest = 'a'.repeat(64);
const artifactDigest = 'b'.repeat(64);
const pin = {
  id: 'framepilot.subject-intelligence',
  version: '1.2.0',
  releaseDigest,
  capabilities: ['tracking.face'],
  requiredFor: 'analysis' as const,
};
const identity = {
  id: pin.id,
  version: pin.version,
  releaseDigest,
  artifactDigest,
  os: 'darwin' as const,
  arch: 'arm64' as const,
};

afterEach(() => {
  delete window.framepilot;
});

describe('CapabilityPackDependencyDialog', () => {
  it('shows verified facts and installs only after exact explicit approval', async () => {
    let listener: ((message: CapabilityPackProgressWire) => void) | undefined;
    const host = {
      capabilityPackProposeProjectDependency: vi.fn(async () => ({
        ok: true as const,
        proposal: {
          proposalId: 'proposal-1',
          identity,
          capabilities: ['tracking.face'],
          displayName: 'Subject Intelligence',
          description: 'Tracks subjects locally.',
          downloadBytes: 100,
          installedBytes: 250,
          licenses: [{ spdx: 'MIT', name: 'MIT', noticeUrl: 'https://example.com/mit' }],
          privacy: { execution: 'local' as const, mediaLeavesDevice: false, disclosure: 'Runs locally.' },
        },
      })),
      capabilityPackInstall: vi.fn(async () => ({ ok: true as const, operationId: 'operation-1' })),
      capabilityPackProjectStatus: vi.fn(async () => ({
        dependencies: [{ pin, status: 'ready' as const, identity }],
        renderBlocked: false,
        editBlocked: false,
      })),
      onCapabilityPackProgress: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    } as unknown as FramePilotBridge;
    window.framepilot = host;
    const onResolutionChange = vi.fn();
    render(
      <CapabilityPackDependencyDialog
        projectId="project-1"
        resolution={{ dependencies: [{ pin, status: 'missing' }], renderBlocked: false, editBlocked: false }}
        onResolutionChange={onResolutionChange}
        onOpenDegraded={vi.fn()}
      />,
    );

    expect(host.capabilityPackInstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review download' }));
    expect(await screen.findByText(/100 B download/)).toBeTruthy();
    expect(screen.getByText('Media stays on this device.')).toBeTruthy();
    expect(host.capabilityPackInstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Approve exact version and download' }));
    await waitFor(() => expect(host.capabilityPackInstall).toHaveBeenCalledWith({
      proposalId: 'proposal-1',
      identity,
      approvedSizeBytes: 100,
      approvedLicenseSpdx: ['MIT'],
      approvedMediaEgress: false,
      approvedAt: expect.any(String),
    }));

    await act(async () => {
      listener?.({
        operationId: 'operation-1',
        identity,
        phase: 'installed',
        completedBytes: 100,
        totalBytes: 100,
      });
    });
    await waitFor(() => expect(onResolutionChange).toHaveBeenCalledWith({
      dependencies: [{ pin, status: 'ready', identity }],
      renderBlocked: false,
      editBlocked: false,
    }));
  });

  it('names its progress region (`role="status"` alone already matches six elements)', async () => {
    let listener: ((message: CapabilityPackProgressWire) => void) | undefined;
    window.framepilot = {
      onCapabilityPackProgress: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    } as unknown as FramePilotBridge;
    render(
      <CapabilityPackDependencyDialog
        projectId="project-1"
        resolution={{ dependencies: [{ pin, status: 'missing' }], renderBlocked: false, editBlocked: false }}
        onResolutionChange={vi.fn()}
        onOpenDegraded={vi.fn()}
      />,
    );
    await act(async () => {
      listener?.({
        operationId: 'operation-1',
        identity,
        phase: 'downloading',
        completedBytes: 10,
        totalBytes: 100,
      });
    });
    expect(screen.getByRole('status', { name: 'Download progress' })).toBeTruthy();
  });

  it('requires an explicit degraded-open decision when no pack is installed', () => {
    window.framepilot = {} as FramePilotBridge;
    const onOpenDegraded = vi.fn();
    render(
      <CapabilityPackDependencyDialog
        projectId="project-1"
        resolution={{ dependencies: [{ pin: { ...pin, requiredFor: 'render' }, status: 'missing' }], renderBlocked: true, editBlocked: false }}
        onResolutionChange={vi.fn()}
        onOpenDegraded={onOpenDegraded}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open degraded' }));
    expect(onOpenDegraded).toHaveBeenCalledOnce();
  });
});
