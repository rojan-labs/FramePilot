/**
 * The one reader of capability readiness (BR6.1, BR6.2).
 *
 * The race is the point: an install fires `onCapabilityPackInstalled`, which starts a second
 * check, and if the first (slower) answer is allowed to land afterwards the pack reads as missing
 * forever. The hook therefore lets only the newest check write.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { CapabilityPackInstalledEventWire } from '@framepilot/shared-types';
import { usePackStatus } from './usePackStatus.js';

const bridge = vi.hoisted(() => ({
  capabilityPackStatus: vi.fn(),
  onCapabilityPackInstalled: vi.fn(() => () => {}),
})) as {
  capabilityPackStatus: ReturnType<typeof vi.fn> | undefined;
  onCapabilityPackInstalled: ReturnType<typeof vi.fn>;
};

vi.mock('../../../editor/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../editor/bridge.js')>()),
  getBridge: () => bridge,
}));

const PACK = {
  id: 'smart-mask',
  version: '1',
  releaseDigest: 'a'.repeat(64),
  artifactDigest: 'b'.repeat(64),
  os: 'darwin' as const,
  arch: 'arm64' as const,
};

function Probe(): JSX.Element {
  const { status } = usePackStatus('subject.matte');
  return <span data-testid="kind">{status.kind}</span>;
}

describe('usePackStatus', () => {
  it('says the capability is unavailable, not missing, without a desktop bridge', async () => {
    const saved = bridge.capabilityPackStatus;
    bridge.capabilityPackStatus = undefined;
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('kind').textContent).toBe('unavailable'));
    bridge.capabilityPackStatus = saved;
  });

  it('re-checks when any surface installs a pack', async () => {
    bridge
      .capabilityPackStatus!.mockResolvedValueOnce({
        state: 'missing',
        capability: 'subject.matte',
        proposal: { ok: false, code: 'offline', error: 'no catalog' },
      })
      .mockResolvedValue({ state: 'ready', capability: 'subject.matte', pack: PACK });
    let installed: ((event: CapabilityPackInstalledEventWire) => void) | null = null;
    bridge.onCapabilityPackInstalled.mockImplementation(((
      handler: (event: CapabilityPackInstalledEventWire) => void,
    ) => {
      installed = handler;
      return () => {};
    }) as never);

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('kind').textContent).toBe('missing'));
    act(() => installed!({ kind: 'installed', identity: PACK }));
    await waitFor(() => expect(screen.getByTestId('kind').textContent).toBe('ready'));
  });

  it('ignores a slow first answer that lands after a newer one', async () => {
    let releaseFirst: (() => void) | null = null;
    bridge
      .capabilityPackStatus!.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () =>
              resolve({
                state: 'missing',
                capability: 'subject.matte',
                proposal: { ok: false, code: 'offline', error: 'no catalog' },
              });
          }),
      )
      .mockResolvedValue({ state: 'ready', capability: 'subject.matte', pack: PACK });
    let installed: ((event: CapabilityPackInstalledEventWire) => void) | null = null;
    bridge.onCapabilityPackInstalled.mockImplementation(((
      handler: (event: CapabilityPackInstalledEventWire) => void,
    ) => {
      installed = handler;
      return () => {};
    }) as never);

    render(<Probe />);
    act(() => installed!({ kind: 'installed', identity: PACK }));
    await waitFor(() => expect(screen.getByTestId('kind').textContent).toBe('ready'));

    await act(async () => {
      releaseFirst!();
      await Promise.resolve();
    });
    expect(screen.getByTestId('kind').textContent).toBe('ready');
  });
});
