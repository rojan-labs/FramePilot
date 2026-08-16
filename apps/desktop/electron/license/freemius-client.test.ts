/**
 * Freemius client tests with an injected fetch: successful activate/validate,
 * error bodies, and network-failure classification (drives offline grace).
 */
import { describe, expect, it, vi } from 'vitest';
import { activateLicense, validateLicense } from './freemius-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const OPTS = { productId: '123', uid: 'uid-1', licenseKey: 'KEY-1' };

describe('activateLicense', () => {
  it('returns install id + token + validity on success', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        install_id: 999,
        install_api_token: 'tok-abc',
        is_cancelled: false,
        expiration: '2027-01-01 00:00:00',
      }),
    );
    const res = await activateLicense(OPTS, fetchFn as unknown as typeof fetch);
    expect(res).toEqual({
      ok: true,
      installId: '999',
      installApiToken: 'tok-abc',
      isValid: true,
      expiration: '2027-01-01 00:00:00',
    });
    // POST to the activate endpoint with uid + license_key in the query.
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/v1/products/123/licenses/activate.json');
    expect(url).toContain('uid=uid-1');
    expect(url).toContain('license_key=KEY-1');
    expect(init.method).toBe('POST');
  });

  it('surfaces a Freemius error message on non-2xx', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'Invalid license key' } }, 404));
    const res = await activateLicense(OPTS, fetchFn as unknown as typeof fetch);
    expect(res).toEqual({ ok: false, error: 'Invalid license key' });
  });

  it('classifies a thrown fetch as a network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const res = await activateLicense(OPTS, fetchFn as unknown as typeof fetch);
    expect(res).toMatchObject({ ok: false, network: true });
  });
});

describe('validateLicense', () => {
  it('reads cancellation + expiration', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ is_cancelled: true, expiration: null }));
    const res = await validateLicense(
      { ...OPTS, installId: '999' },
      fetchFn as unknown as typeof fetch,
    );
    expect(res).toEqual({ ok: true, isValid: false, expiration: null });
    expect(fetchFn.mock.calls[0][0]).toContain('/v1/products/123/installs/999/license.json');
  });

  it('classifies network failure', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
    const res = await validateLicense(
      { ...OPTS, installId: '999' },
      fetchFn as unknown as typeof fetch,
    );
    expect(res).toMatchObject({ ok: false, network: true });
  });
});
