/**
 * Dodo license client tests with an injected fetch: activate/validate/deactivate
 * success, the documented error statuses (403/404/422), the authoritative
 * "not valid" mapping, and network-failure classification (drives offline grace).
 */
import { describe, expect, it, vi } from 'vitest';
import { activateLicense, deactivateLicense, validateLicense } from './dodo-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ACTIVATE = {
  environment: 'live' as const,
  licenseKey: 'KEY-1',
  deviceName: 'FramePilot (abcd1234)',
};

describe('activateLicense', () => {
  it('returns the instance id and posts the documented body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ id: 'lki_123' }, 201));
    const res = await activateLicense(ACTIVATE, fetchFn as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, instanceId: 'lki_123' });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://live.dodopayments.com/licenses/activate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      license_key: 'KEY-1',
      name: 'FramePilot (abcd1234)',
    });
  });

  it('uses the test host in test mode', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ id: 'lki_1' }, 201));
    await activateLicense(
      { ...ACTIVATE, environment: 'test' },
      fetchFn as unknown as typeof fetch,
    );
    expect(fetchFn.mock.calls[0][0]).toBe('https://test.dodopayments.com/licenses/activate');
  });

  it('explains the activation limit (422) and an unknown key (404)', async () => {
    const limited = await activateLicense(
      ACTIVATE,
      vi.fn().mockResolvedValue(jsonResponse({}, 422)) as unknown as typeof fetch,
    );
    expect(limited).toMatchObject({ ok: false, status: 422 });
    expect((limited as { error: string }).error).toMatch(/activation limit/i);

    const missing = await activateLicense(
      ACTIVATE,
      vi.fn().mockResolvedValue(jsonResponse({}, 404)) as unknown as typeof fetch,
    );
    expect((missing as { error: string }).error).toMatch(/could not find/i);
  });

  it('fails when the response carries no instance id', async () => {
    const res = await activateLicense(
      ACTIVATE,
      vi.fn().mockResolvedValue(jsonResponse({}, 201)) as unknown as typeof fetch,
    );
    expect(res).toMatchObject({ ok: false });
  });

  it('classifies a thrown fetch as a network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const res = await activateLicense(ACTIVATE, fetchFn as unknown as typeof fetch);
    expect(res).toMatchObject({ ok: false, network: true });
  });
});

describe('validateLicense', () => {
  const OPTS = { environment: 'live' as const, licenseKey: 'KEY-1', instanceId: 'lki_123' };

  it('reads the valid flag and scopes to the instance', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ valid: true }));
    expect(await validateLicense(OPTS, fetchFn as unknown as typeof fetch)).toEqual({
      ok: true,
      valid: true,
    });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      license_key: 'KEY-1',
      license_key_instance_id: 'lki_123',
    });
  });

  it('omits the instance id when the device has none', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ valid: false }));
    const res = await validateLicense(
      { ...OPTS, instanceId: undefined },
      fetchFn as unknown as typeof fetch,
    );
    expect(res).toEqual({ ok: true, valid: false });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ license_key: 'KEY-1' });
  });

  it('treats a revoked (403) or unknown (404) key as an authoritative "not valid"', async () => {
    for (const status of [403, 404]) {
      const res = await validateLicense(
        OPTS,
        vi.fn().mockResolvedValue(jsonResponse({}, status)) as unknown as typeof fetch,
      );
      expect(res).toEqual({ ok: true, valid: false });
    }
  });

  it('reports a server error as an error, not as invalid', async () => {
    const res = await validateLicense(
      OPTS,
      vi.fn().mockResolvedValue(jsonResponse({}, 500)) as unknown as typeof fetch,
    );
    expect(res).toMatchObject({ ok: false, status: 500 });
  });

  it('classifies network failure', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await validateLicense(OPTS, fetchFn as unknown as typeof fetch)).toMatchObject({
      ok: false,
      network: true,
    });
  });
});

describe('deactivateLicense', () => {
  it('posts key + instance to the deactivate endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const res = await deactivateLicense(
      { environment: 'live', licenseKey: 'KEY-1', instanceId: 'lki_123' },
      fetchFn as unknown as typeof fetch,
    );
    expect(res).toEqual({ ok: true });
    expect(fetchFn.mock.calls[0][0]).toBe('https://live.dodopayments.com/licenses/deactivate');
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      license_key: 'KEY-1',
      license_key_instance_id: 'lki_123',
    });
  });
});
