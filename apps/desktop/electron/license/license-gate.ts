/**
 * Pure license-decision logic — no I/O, no Electron, no network. This is the
 * source of truth for "is this license currently valid?" and is 100%
 * unit-testable. The store and service compose it.
 *
 * The app is 100% paid: it requires a valid Dodo Payments license key to run.
 *
 * WHY validity is grace-window based (and not expiry based): Dodo's public
 * license endpoints answer one question — `valid: true | false` — and never
 * report an expiry date. A subscription key's validity simply *follows the
 * subscription*: Dodo flips it to invalid when the subscription goes on hold,
 * is cancelled, or its term ends. So the app cannot reason about dates locally;
 * it must re-ask Dodo periodically. Between checks, a previously-valid license
 * keeps working for the OFFLINE GRACE window, otherwise a flaky connection (or
 * a week on a plane) would lock a paying customer out of their own footage.
 *
 * `expiration` is kept in the record for the rare imported/merchant-issued key
 * whose expiry we do know; when present it is enforced on top of the grace rule.
 */
import type { LicenseStatus, LicenseStatusKind } from '@framepilot/shared-types';

/** The on-disk license record (secrets included — never sent to the renderer). */
export interface StoredLicense {
  /** Stable per-device identifier, generated once. Names the Dodo activation. */
  deviceId: string;
  /** The user's license key. */
  licenseKey?: string;
  /** Dodo license key instance id created on activation (needed to deactivate). */
  instanceId?: string;
  /** Known expiry (ISO) when one is available, else null/absent. */
  expiration?: string | null;
  /** Last known validity from Dodo (used for the offline-grace path). */
  isValid?: boolean;
  /** Epoch ms of the last successful validation against Dodo. */
  lastValidatedAt?: number;
}

/**
 * Default offline grace: keep a validated license usable for 30 days offline.
 * Dodo's own desktop guidance uses the same window, and since validity here is
 * re-checked daily when online, 30 days only ever matters to a genuinely
 * disconnected machine.
 */
export const DEFAULT_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** Parse an ISO (or "YYYY-MM-DD HH:MM:SS" UTC) date to epoch ms, or null. */
export function parseLicenseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** True when a known expiration is in the past. An absent expiry never expires. */
export function isExpired(expiration: string | null | undefined, now: number): boolean {
  const ms = parseLicenseDate(expiration);
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

  // `isValid` is the last AUTHORITATIVE result from Dodo. A `false` here means
  // the server said the license is invalid/revoked — no grace applies.
  if (stored.isValid) {
    if (withinGrace(stored.lastValidatedAt, now, graceMs)) {
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
