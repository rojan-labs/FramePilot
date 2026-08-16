/**
 * LicenseGate tests: browser bypass (no bridge), licensed pass-through, the
 * activation flow (success unlocks, failure shows the error), and fail-closed on
 * a status-check error.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LicenseStatus } from '@framepilot/shared-types';
import type { RendererBridge } from '../editor/bridge.js';
import { LicenseGate } from './LicenseGate.js';

const CHILD = <div data-testid="editor">Editor</div>;

/** Minimal bridge stub exposing only the license methods the gate uses. */
function bridgeWith(over: Partial<RendererBridge>): RendererBridge {
  return over as RendererBridge;
}

const valid: LicenseStatus = { status: 'valid', licensed: true, expiresAt: null };
const needsActivation: LicenseStatus = {
  status: 'needs_activation',
  licensed: false,
  expiresAt: null,
};

describe('LicenseGate', () => {
  it('renders children in the browser (no bridge)', () => {
    render(<LicenseGate bridge={null}>{CHILD}</LicenseGate>);
    expect(screen.getByTestId('editor')).toBeTruthy();
  });

  it('renders children when the license is valid', async () => {
    const bridge = bridgeWith({ licenseStatus: vi.fn().mockResolvedValue(valid) });
    render(<LicenseGate bridge={bridge}>{CHILD}</LicenseGate>);
    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy());
  });

  it('shows the activation card when unlicensed and unlocks on success', async () => {
    const licenseActivate = vi.fn().mockResolvedValue(valid);
    const bridge = bridgeWith({
      licenseStatus: vi.fn().mockResolvedValue(needsActivation),
      licenseActivate,
    });
    render(<LicenseGate bridge={bridge}>{CHILD}</LicenseGate>);

    const input = await screen.findByLabelText('License key');
    fireEvent.change(input, { target: { value: 'ABCD-1234' } });
    fireEvent.click(screen.getByRole('button', { name: /activate license/i }));

    await waitFor(() => expect(screen.getByTestId('editor')).toBeTruthy());
    expect(licenseActivate).toHaveBeenCalledWith({ licenseKey: 'ABCD-1234' });
  });

  it('shows an error when activation is rejected', async () => {
    const bridge = bridgeWith({
      licenseStatus: vi.fn().mockResolvedValue(needsActivation),
      licenseActivate: vi.fn().mockResolvedValue({
        status: 'invalid',
        licensed: false,
        expiresAt: null,
        message: 'Invalid license key',
      } satisfies LicenseStatus),
    });
    render(<LicenseGate bridge={bridge}>{CHILD}</LicenseGate>);

    fireEvent.change(await screen.findByLabelText('License key'), {
      target: { value: 'WRONG' },
    });
    fireEvent.click(screen.getByRole('button', { name: /activate license/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Invalid license key');
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('shows the renew variant when a stored subscription has lapsed', async () => {
    const expired: LicenseStatus = {
      status: 'invalid',
      licensed: false,
      expiresAt: '2026-01-01 00:00:00',
      maskedKey: '••••-••••-AB12',
      message: 'Your subscription has expired. Renew to keep using FramePilot.',
    };
    const bridge = bridgeWith({ licenseStatus: vi.fn().mockResolvedValue(expired) });
    render(<LicenseGate bridge={bridge}>{CHILD}</LicenseGate>);

    expect(await screen.findByText(/subscription has lapsed/i)).toBeTruthy();
    // The masked key and a Renew CTA are shown; the editor is not.
    expect(screen.getByText('••••-••••-AB12')).toBeTruthy();
    const renew = screen.getByRole('link', { name: /renew subscription/i });
    expect(renew.getAttribute('href')).toContain('/pricing');
    expect(screen.getByRole('button', { name: /use a different key/i })).toBeTruthy();
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('fails closed to the activation card when the status check throws', async () => {
    const bridge = bridgeWith({ licenseStatus: vi.fn().mockRejectedValue(new Error('boom')) });
    render(<LicenseGate bridge={bridge}>{CHILD}</LicenseGate>);
    expect(await screen.findByLabelText('License key')).toBeTruthy();
  });
});
