/**
 * Tests for the analysis-engine reachability chip (plan P5.3): its three states
 * (unknown while probing, reachable, unreachable), driven by a stubbed `fetch`
 * against the explicit `baseUrl` prop (never the real network).
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineStatusChip } from './EngineStatusChip.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EngineStatusChip', () => {
  it('shows a checking state before the probe settles', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})), // never settles within the test
    );
    render(<EngineStatusChip baseUrl="http://engine.local" />);
    expect(screen.getByText(/Checking analysis engine/)).toBeTruthy();
  });

  it('shows reachable once the health probe succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe('http://engine.local/health');
        return { ok: true };
      }),
    );
    render(<EngineStatusChip baseUrl="http://engine.local" />);
    await waitFor(() => expect(screen.getByText(/Analysis engine connected/)).toBeTruthy());
  });

  it('shows unreachable when the health probe fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    render(<EngineStatusChip baseUrl="http://engine.local" />);
    await waitFor(() => expect(screen.getByText(/Analysis engine unreachable/)).toBeTruthy());
  });

  it('re-probes when the window regains focus', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchImpl);
    render(<EngineStatusChip baseUrl="http://engine.local" />);
    await waitFor(() => expect(screen.getByText(/Analysis engine unreachable/)).toBeTruthy());

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByText(/Analysis engine connected/)).toBeTruthy());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
