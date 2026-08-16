/**
 * LicenseService tests: the unconfigured/dev-bypass rule, activation success and
 * failure, stale revalidation (authoritative-invalid vs. network→offline-grace),
 * and the synchronous cached guard.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LicenseStore } from './license-store.js';
import { LicenseService } from './license-service.js';
import { DEFAULT_GRACE_MS } from './license-gate.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('LicenseService', () => {
  let dir: string;
  let file: string;
  const NOW = 1_000_000_000_000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fp-licsvc-'));
    file = join(dir, 'license.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const makeStore = () =>
    new LicenseStore(
      file,
      DEFAULT_GRACE_MS,
      () => 'uid-1',
      () => NOW,
    );

  it('disables enforcement when no product id is configured', async () => {
    const svc = new LicenseService({ store: makeStore(), fetchFn: vi.fn(), now: () => NOW });
    expect((await svc.getStatus()).licensed).toBe(true);
    expect(svc.isLicensedCached()).toBe(true);
  });

  it('disables enforcement under dev bypass even with a product id', async () => {
    const svc = new LicenseService({
      store: makeStore(),
      productId: '123',
      devBypass: true,
      fetchFn: vi.fn(),
      now: () => NOW,
    });
    expect((await svc.getStatus()).licensed).toBe(true);
  });

  it('activates a valid key and unlocks', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ install_id: 5, is_cancelled: false, expiration: null }));
    const svc = new LicenseService({
      store: makeStore(),
      productId: '123',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => NOW,
    });
    const status = await svc.activate('MY-KEY-1234');
    expect(status).toMatchObject({ status: 'valid', licensed: true, maskedKey: '••••-••••-1234' });
    expect(svc.isLicensedCached()).toBe(true);
  });

  it('rejects an empty key and a bad key', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'No such license' } }, 404));
    const svc = new LicenseService({
      store: makeStore(),
      productId: '123',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => NOW,
    });
    expect((await svc.activate('   ')).status).toBe('needs_activation');
    const bad = await svc.activate('WRONG');
    expect(bad.status).toBe('invalid');
    expect(bad.message).toBe('No such license');
  });

  it('revalidates a stale license and marks an authoritative cancellation invalid', async () => {
    const store = makeStore();
    store.update({
      licenseKey: 'K-1',
      installId: '5',
      isValid: true,
      lastValidatedAt: NOW - 10 * DEFAULT_GRACE_MS, // very stale
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ is_cancelled: true, expiration: null }));
    const svc = new LicenseService({
      store,
      productId: '123',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => NOW,
    });
    const status = await svc.getStatus();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(status.licensed).toBe(false);
  });

  it('keeps a stale-but-recent license valid via offline grace on network failure', async () => {
    const store = makeStore();
    // A subscription (future expiry), stale enough to trigger revalidation but
    // last validated within the offline-grace window.
    store.update({
      licenseKey: 'K-1',
      installId: '5',
      isValid: true,
      expiration: '2027-01-01 00:00:00',
      lastValidatedAt: NOW - 2 * 24 * 60 * 60 * 1000,
    });
    const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
    const svc = new LicenseService({
      store,
      productId: '123',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => NOW,
      revalidateIntervalMs: 60 * 60 * 1000, // 1h → stale
    });
    const status = await svc.getStatus();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(status.licensed).toBe(true);
    expect(status.offlineGrace).toBe(true);
  });

  it('deactivate clears the license', async () => {
    const store = makeStore();
    store.update({ licenseKey: 'K-1', installId: '5', isValid: true, lastValidatedAt: NOW });
    const svc = new LicenseService({
      store,
      productId: '123',
      fetchFn: vi.fn() as unknown as typeof fetch,
      now: () => NOW,
    });
    await svc.deactivate();
    expect(store.read()?.licenseKey).toBeUndefined();
  });
});
