/**
 * License service — orchestrates the {@link LicenseStore} and the Freemius client
 * to answer "can this app run?" and to activate/deactivate a key.
 *
 * Enforcement rule: the paywall is active **only when a Freemius product id is
 * configured**. In an unconfigured/dev build (no `FRAMEPILOT_FREEMIUS_PRODUCT_ID`)
 * or with `FRAMEPILOT_LICENSE_DEV_BYPASS=1`, the gate reports valid so the app
 * runs — this keeps dev + the existing test suite working and never bricks a build
 * that simply hasn't wired Freemius yet. Packaged production builds set the id.
 *
 * All I/O is injected (store + fetch), so this is unit-testable without Electron
 * or the network.
 */
import type { LicenseStatus } from '@framepilot/shared-types';
import type { LicenseStore } from './license-store.js';
import { activateLicense, validateLicense } from './freemius-client.js';

type FetchFn = typeof globalThis.fetch;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface LicenseServiceOptions {
  store: LicenseStore;
  /** Freemius product id; when absent, enforcement is disabled (dev/unconfigured). */
  productId?: string | undefined;
  fetchFn: FetchFn;
  now?: () => number;
  /** Re-verify with Freemius when the cached validation is older than this. */
  revalidateIntervalMs?: number;
  /** Force-disable the gate (dev). */
  devBypass?: boolean;
}

export class LicenseService {
  private readonly store: LicenseStore;
  private readonly productId: string | undefined;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly revalidateIntervalMs: number;
  private readonly devBypass: boolean;

  public constructor(opts: LicenseServiceOptions) {
    this.store = opts.store;
    this.productId = opts.productId;
    this.fetchFn = opts.fetchFn;
    this.now = opts.now ?? Date.now;
    this.revalidateIntervalMs = opts.revalidateIntervalMs ?? ONE_DAY_MS;
    this.devBypass = opts.devBypass ?? false;
  }

  /** Enforcement is off when Freemius isn't configured or dev-bypass is set. */
  private enforcementDisabled(): boolean {
    return this.devBypass || !this.productId;
  }

  private devValid(): LicenseStatus {
    return {
      status: 'valid',
      licensed: true,
      expiresAt: null,
      message: 'Licensing is not enforced in this build.',
    };
  }

  /**
   * Status for the gate. Revalidates against Freemius when the cached result is
   * stale; on a network error it leaves the cache intact so the offline-grace
   * window in {@link deriveStatus} applies.
   */
  public async getStatus(): Promise<LicenseStatus> {
    if (this.enforcementDisabled()) return this.devValid();
    const stored = this.store.read();
    if (this.productId && stored?.licenseKey && stored.installId) {
      const stale =
        !stored.lastValidatedAt || this.now() - stored.lastValidatedAt > this.revalidateIntervalMs;
      if (stale) {
        const res = await validateLicense(
          {
            productId: this.productId,
            installId: stored.installId,
            uid: stored.uid,
            licenseKey: stored.licenseKey,
          },
          this.fetchFn,
        );
        if (res.ok) {
          this.store.update({
            isValid: res.isValid,
            expiration: res.expiration,
            lastValidatedAt: this.now(),
          });
        } else if (!res.network) {
          // Authoritative failure (cancelled / not found) — mark invalid.
          this.store.update({ isValid: false, lastValidatedAt: this.now() });
        } else {
          // Network error → keep the cache; the offline-grace window (in
          // deriveStatus) decides validity. Flag it so the UI can say so.
          const status = this.store.status();
          return status.licensed ? { ...status, offlineGrace: true } : status;
        }
      }
    }
    return this.store.status();
  }

  /** Activate a license key on this device. */
  public async activate(licenseKey: string): Promise<LicenseStatus> {
    if (this.enforcementDisabled()) return this.devValid();
    const key = (licenseKey ?? '').trim();
    if (!key) {
      return {
        status: 'needs_activation',
        licensed: false,
        expiresAt: null,
        message: 'Please enter your license key.',
      };
    }
    const uid = this.store.ensureUid();
    const res = await activateLicense(
      { productId: this.productId as string, uid, licenseKey: key },
      this.fetchFn,
    );
    if (!res.ok) {
      return { status: 'invalid', licensed: false, expiresAt: null, message: res.error };
    }
    this.store.update({
      licenseKey: key,
      installId: res.installId,
      ...(res.installApiToken ? { installApiToken: res.installApiToken } : {}),
      isValid: res.isValid,
      expiration: res.expiration,
      lastValidatedAt: this.now(),
    });
    return this.store.status();
  }

  /** Remove the local license (keeps the device uid). */
  public async deactivate(): Promise<LicenseStatus> {
    this.store.clear();
    return this.getStatus();
  }

  /** Fast, synchronous, network-free licensed check for IPC guards. */
  public isLicensedCached(): boolean {
    if (this.enforcementDisabled()) return true;
    return this.store.status().licensed;
  }
}
