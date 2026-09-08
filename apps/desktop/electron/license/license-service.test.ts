/**
 * LicenseService tests: the unconfigured/dev-bypass rule, activation success and
 * failure, stale revalidation (authoritative-invalid vs. network→offline-grace),
 * deactivation releasing the Dodo activation slot, and the synchronous cached guard.
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
      () => 'dev-1',
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
      productId: 'pdt_1',
      devBypass: true,
      fetchFn: vi.fn(),
      now: () => NOW,
    });
    expect((await svc.getStatus()).licensed).toBe(true);
  });

  it('activates a valid key, names the device, and unlocks', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ id: 'lki_5' }, 201));
    const svc = new LicenseService({
      store: makeStore(),
      productId: 'pdt_1',
      deviceName: 'FramePilot — studio',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => NOW,
    });
    const status = await svc.activate('MY-KEY-1234');
    expect(status).toMatchObject({ status: 'valid', licensed: true, maskedKey: '••••-••••-1234' });
    expect(svc.isLicensedCached()).toBe(true);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).name).toBe('FramePilot — studio (dev-1)');
  });

  it('rejects an empty key and surfaces a bad key', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, 404));
    const svc = new LicenseService({
      store: makeStore(),
      productId: 'pdt_1',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => NOW,
    });
    expect((await svc.activate('   ')).status).toBe('needs_activation');
    const bad = await svc.activate('WRONG');
    expect(bad.status).toBe('invalid');
    expect(bad.message).toMatch(/could not find/i);
  });

  it('revalidates a stale license and marks an authoritative revocation invalid', async () => {
    const store = makeStore();
    store.update({
      licenseKey: 'K-1',
      instanceId: 'lki_5',
      isValid: true,
      lastValidatedAt: NOW - 10 * DEFAULT_GRACE_MS, // very stale
    });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ valid: false }));
    const svc = new LicenseService({
      store,
      productId: 'pdt_1',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => NOW,
    });
    const status = await svc.getStatus();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(status.licensed).toBe(false);
  });

  it('keeps a stale-but-recent license valid via offline grace on network failure', async () => {
    const store = makeStore();
    store.update({
      licenseKey: 'K-1',
      instanceId: 'lki_5',
      isValid: true,
      lastValidatedAt: NOW - 2 * 24 * 60 * 60 * 1000,
    });
    const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
    const svc = new LicenseService({
      store,
      productId: 'pdt_1',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => NOW,
      revalidateIntervalMs: 60 * 60 * 1000, // 1h → stale
    });
    const status = await svc.getStatus();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(status.licensed).toBe(true);
    expect(status.offlineGrace).toBe(true);
  });

  it('deactivate releases the Dodo activation slot and clears the license', async () => {
    const store = makeStore();
    store.update({ licenseKey: 'K-1', instanceId: 'lki_5', isValid: true, lastValidatedAt: NOW });
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const svc = new LicenseService({
      store,
      productId: 'pdt_1',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => NOW,
    });
    await svc.deactivate();
    expect(fetchFn.mock.calls[0][0]).toContain('/licenses/deactivate');
    expect(store.read()?.licenseKey).toBeUndefined();
  });

  it('still clears locally when the remote deactivation fails', async () => {
    const store = makeStore();
    store.update({ licenseKey: 'K-1', instanceId: 'lki_5', isValid: true, lastValidatedAt: NOW });
    const svc = new LicenseService({
      store,
      productId: 'pdt_1',
      fetchFn: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      now: () => NOW,
    });
    await svc.deactivate();
    expect(store.read()?.licenseKey).toBeUndefined();
  });
});
