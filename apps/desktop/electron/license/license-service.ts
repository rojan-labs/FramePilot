/**
 * License service — orchestrates the {@link LicenseStore} and the Dodo Payments
 * client to answer "can this app run?" and to activate/deactivate a key.
 *
 * Enforcement rule: the paywall is active **only when a Dodo product id is
 * configured**. In an unconfigured/dev build (no `FRAMEPILOT_DODO_PRODUCT_ID`)
 * or with `FRAMEPILOT_LICENSE_DEV_BYPASS=1`, the gate reports valid so the app
 * runs — this keeps dev + the existing test suite working and never bricks a
 * build that simply hasn't wired payments yet. Packaged production builds set
 * the id. (Dodo's license endpoints don't need the product id themselves; it is
 * the one setting that says "this build is a paid build", and the website uses
 * the same id for checkout.)
 *
 * All I/O is injected (store + fetch), so this is unit-testable without Electron
 * or the network.
 */
import type { LicenseStatus } from '@framepilot/shared-types';
import type { LicenseStore } from './license-store.js';
import {
  activateLicense,
  deactivateLicense,
  validateLicense,
  type DodoEnvironment,
} from './dodo-client.js';

type FetchFn = typeof globalThis.fetch;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface LicenseServiceOptions {
  store: LicenseStore;
  /** Dodo product id this build sells; when absent, enforcement is disabled. */
  productId?: string | undefined;
  /** Which Dodo environment to verify against. Defaults to `live`. */
  environment?: DodoEnvironment;
  /** Shown in the customer's Dodo activation list, e.g. "FramePilot — studio-mbp". */
  deviceName?: string;
  fetchFn: FetchFn;
  now?: () => number;
  /** Re-verify with Dodo when the cached validation is older than this. */
  revalidateIntervalMs?: number;
  /** Force-disable the gate (dev). */
  devBypass?: boolean;
}

export class LicenseService {
  private readonly store: LicenseStore;
  private readonly productId: string | undefined;
  private readonly environment: DodoEnvironment;
  private readonly deviceName: string;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly revalidateIntervalMs: number;
  private readonly devBypass: boolean;

  public constructor(opts: LicenseServiceOptions) {
    this.store = opts.store;
    this.productId = opts.productId;
    this.environment = opts.environment ?? 'live';
    this.deviceName = opts.deviceName ?? 'FramePilot';
    this.fetchFn = opts.fetchFn;
    this.now = opts.now ?? Date.now;
    this.revalidateIntervalMs = opts.revalidateIntervalMs ?? ONE_DAY_MS;
    this.devBypass = opts.devBypass ?? false;
  }

  /** Enforcement is off when payments aren't configured or dev-bypass is set. */
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
   * Status for the gate. Revalidates against Dodo when the cached result is
   * stale; on a network error it leaves the cache intact so the offline-grace
   * window in `deriveStatus` applies.
   */
  public async getStatus(): Promise<LicenseStatus> {
    if (this.enforcementDisabled()) return this.devValid();
    const stored = this.store.read();
    if (stored?.licenseKey) {
      const stale =
        !stored.lastValidatedAt || this.now() - stored.lastValidatedAt > this.revalidateIntervalMs;
      if (stale) {
        const res = await validateLicense(
          {
            environment: this.environment,
            licenseKey: stored.licenseKey,
            instanceId: stored.instanceId,
          },
          this.fetchFn,
        );
        if (res.ok) {
          this.store.update({ isValid: res.valid, lastValidatedAt: this.now() });
        } else if (!res.network) {
          // Authoritative failure from the API — mark invalid.
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
    const deviceId = this.store.ensureDeviceId();
    const res = await activateLicense(
      {
        environment: this.environment,
        licenseKey: key,
        deviceName: `${this.deviceName} (${deviceId.slice(0, 8)})`,
      },
      this.fetchFn,
    );
    if (!res.ok) {
      return { status: 'invalid', licensed: false, expiresAt: null, message: res.error };
    }
    this.store.update({
      licenseKey: key,
      instanceId: res.instanceId,
      isValid: true,
      lastValidatedAt: this.now(),
    });
    return this.store.status();
  }

  /**
   * Remove the local license (keeps the device id) and, best effort, release the
   * activation slot at Dodo so the customer can activate another machine. A
   * failed remote release must never block the local one — the user asked to
   * sign this machine out.
   */
  public async deactivate(): Promise<LicenseStatus> {
    const stored = this.store.read();
    if (!this.enforcementDisabled() && stored?.licenseKey && stored.instanceId) {
      await deactivateLicense(
        {
          environment: this.environment,
          licenseKey: stored.licenseKey,
          instanceId: stored.instanceId,
        },
        this.fetchFn,
      );
    }
    this.store.clear();
    return this.getStatus();
  }

  /** Fast, synchronous, network-free licensed check for IPC guards. */
  public isLicensedCached(): boolean {
    if (this.enforcementDisabled()) return true;
    return this.store.status().licensed;
  }
}
