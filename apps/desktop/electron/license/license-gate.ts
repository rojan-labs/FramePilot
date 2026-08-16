/**
 * Pure license-decision logic — no I/O, no Electron, no network. This is the
 * source of truth for "is this license currently valid?" and is 100%
 * unit-testable. The store and service compose it.
 *
 * The app is 100% paid: it requires a valid Freemius license to run. A license
 * may be a lifetime key (no expiration) or a subscription (expires). We also
 * support an OFFLINE GRACE window so a previously-valid license keeps working for
 * a few days without network — otherwise a flaky connection would lock users out.
 */
import type { LicenseStatus, LicenseStatusKind } from '@framepilot/shared-types';

/** The on-disk license record (secrets included — never sent to the renderer). */
export interface StoredLicense {
  /** Stable per-device identifier (Freemius `uid`), generated once. */
  uid: string;
  /** The user's license key. */
  licenseKey?: string;
  /** Freemius install id created on activation. */
  installId?: string;
  /** Freemius install API token (bearer for future install updates). */
  installApiToken?: string;
  /** Subscription expiration ("YYYY-MM-DD HH:MM:SS" UTC) or null for lifetime. */
  expiration?: string | null;
  /** Last known validity from Freemius (used for the offline-grace path). */
  isValid?: boolean;
  /** Epoch ms of the last successful validation against Freemius. */
  lastValidatedAt?: number;
}

/** Default offline grace: keep a validated license usable for 7 days offline. */
export const DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Parse a Freemius date ("YYYY-MM-DD HH:MM:SS" UTC) to epoch ms, or null. */
export function parseFreemiusDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** True when a subscription expiration is in the past. Lifetime (null) never expires. */
export function isExpired(expiration: string | null | undefined, now: number): boolean {
  const ms = parseFreemiusDate(expiration);
  return ms !== null && now > ms;
}

/** Show only the last 4 chars of a key, never the whole thing. */
export function maskLicenseKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const tail = key.slice(-4);
  return `••••-••••-${tail}`;
}

/** Whether a previously-valid license is still inside its offline grace window. */
export function withinGrace(
  lastValidatedAt: number | undefined,
  now: number,
  graceMs: number,
): boolean {
  if (!lastValidatedAt) return false;
  return now - lastValidatedAt <= graceMs;
}

/**
 * Derive the renderer-safe {@link LicenseStatus} from stored state, purely.
 * Applies the offline-grace allowance when `isValid` is stale but recent.
 */
export function deriveStatus(
  stored: StoredLicense | null,
  now: number,
  graceMs: number = DEFAULT_GRACE_MS,
): LicenseStatus {
  if (!stored || !stored.licenseKey) {
    return { status: 'needs_activation', licensed: false, expiresAt: null };
  }

  const expiresAt = stored.expiration ?? null;
  const masked = maskLicenseKey(stored.licenseKey);
  // Include maskedKey only when present (exactOptionalPropertyTypes).
  const base = { expiresAt, ...(masked ? { maskedKey: masked } : {}) };

  if (isExpired(expiresAt, now)) {
    return {
      status: 'invalid',
      licensed: false,
      ...base,
      message: 'Your subscription has expired. Renew to keep using FramePilot.',
    };
  }

  // `isValid` is the last AUTHORITATIVE result from Freemius. A `false` here means
  // the server said the license is invalid/cancelled — no grace applies.
  if (stored.isValid) {
    // A lifetime license (no expiration) stays valid; a subscription stays valid
    // while its last successful validation is inside the offline-grace window,
    // otherwise it must be re-verified online.
    if (expiresAt === null || withinGrace(stored.lastValidatedAt, now, graceMs)) {
      return { status: 'valid', licensed: true, ...base };
    }
    return {
      status: 'invalid',
      licensed: false,
      ...base,
      message: 'Please reconnect to verify your license.',
    };
  }

  return {
    status: 'invalid',
    licensed: false,
    ...base,
    message: 'This license could not be verified. Check your key or your connection.',
  };
}

export type { LicenseStatus, LicenseStatusKind };
