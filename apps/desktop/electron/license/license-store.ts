/**
 * License store — `license.json` in the app data dir, **encrypted at rest** with
 * the injected {@link LicenseCrypto} (Electron `safeStorage`, OS-keychain backed)
 * when it is available.
 *
 * Mirrors {@link AiConfigStore}: no `electron` import (takes a file path + a
 * crypto adapter, so it is unit-testable off a temp file), tolerant of a
 * missing/corrupt file, and it exposes **only** a renderer-safe
 * {@link LicenseStatus} to callers — the license key and instance id never
 * leave the main process.
 *
 * WHY encryption (anti-crack, security hardening): the record used to be
 * plaintext, so anyone could hand-write `{ isValid: true, expiration: null }`
 * and mint a free lifetime license. With `safeStorage` the file is ciphertext
 * bound to the OS user, so it can't be edited by hand. Two rules make this
 * robust against forgery while staying seamless for real users:
 *   1. When encryption is available, a **plaintext** record is never trusted as
 *      valid — its `isValid`/`lastValidatedAt` are dropped so the service must
 *      re-verify online before the gate opens (defeats a forged plaintext file
 *      *and* migrates a genuine pre-encryption record on the next online check).
 *   2. An envelope that fails to decrypt (tampered, or copied from another OS
 *      user) reads as `null` → the gate fails closed.
 *
 * This is not absolute DRM — a determined attacker can still repack the app's
 * asar to remove the gate entirely (unavoidable for a JS/Electron app). It
 * defeats the realistic, low-effort attack and keeps the server authoritative.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LicenseStatus } from '@framepilot/shared-types';
import { deriveStatus, DEFAULT_GRACE_MS, type StoredLicense } from './license-gate.js';

/**
 * OS-backed encryption adapter. In the packaged app this wraps Electron
 * `safeStorage`; in tests/off-Electron it is the {@link PLAINTEXT_CRYPTO}
 * identity (encryption disabled), which preserves the legacy plaintext behavior.
 */
export interface LicenseCrypto {
  /** Whether OS-backed encryption is actually usable on this machine. */
  available(): boolean;
  /** Encrypt a UTF-8 string to a storable token (base64). */
  encrypt(plain: string): string;
  /** Decrypt a token from {@link encrypt}; throws if it isn't valid ciphertext. */
  decrypt(token: string): string;
}

/** Identity adapter: encryption disabled (legacy plaintext). */
export const PLAINTEXT_CRYPTO: LicenseCrypto = {
  available: () => false,
  encrypt: (plain) => plain,
  decrypt: (token) => token,
};

/** On-disk envelope for an encrypted record. `enc` is the ciphertext of the JSON. */
interface EncryptedEnvelope {
  v: 1;
  enc: string;
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  return typeof (value as EncryptedEnvelope | null)?.enc === 'string';
}

/** Stable device identifier: 32-char hex (randomUUID with its hyphens removed). */
function deviceId(): string {
  return randomUUID().replace(/-/g, '');
}

/** Drop trust-bearing fields so a record must be re-verified online before use. */
function untrusted(record: StoredLicense): StoredLicense {
  const { isValid: _isValid, lastValidatedAt: _lastValidatedAt, ...rest } = record;
  return rest;
}

export class LicenseStore {
  public constructor(
    private readonly filePath: string,
    private readonly graceMs: number = DEFAULT_GRACE_MS,
    /** Injectable for tests. Defaults to a 32-char hex device id. */
    private readonly genDeviceId: () => string = deviceId,
    private readonly now: () => number = Date.now,
    /** OS-backed encryption; defaults to disabled (plaintext) for tests/off-Electron. */
    private readonly crypto: LicenseCrypto = PLAINTEXT_CRYPTO,
  ) {}

  /**
   * Read the stored license, tolerating an absent or corrupt file.
   *
   * Fails closed: a tampered/undecryptable envelope reads as `null` rather than a
   * partially-trusted record. When encryption is available, a legacy *plaintext*
   * record is returned with its trust fields stripped so it can't grant access
   * without an online re-check (this both blocks a forged plaintext file and
   * migrates a genuine pre-encryption record).
   */
  public read(): StoredLicense | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (isEnvelope(parsed)) {
      // Ciphertext: decrypt then parse. Any failure (tampered bytes, wrong OS
      // user, disabled crypto) fails closed.
      try {
        const inner = JSON.parse(this.crypto.decrypt(parsed.enc)) as Partial<StoredLicense>;
        if (typeof inner.deviceId !== 'string' || inner.deviceId.length === 0) return null;
        return inner as StoredLicense;
      } catch {
        return null;
      }
    }

    // Plaintext record.
    const record = parsed as Partial<StoredLicense>;
    if (typeof record.deviceId !== 'string' || record.deviceId.length === 0) return null;
    // When encryption is available, never trust a plaintext record's validity —
    // strip it so the service re-verifies online (anti-forgery + migration).
    return this.crypto.available() ? untrusted(record as StoredLicense) : (record as StoredLicense);
  }

  private write(state: StoredLicense): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(state, null, 2);
    const body = this.crypto.available()
      ? JSON.stringify(
          { v: 1, enc: this.crypto.encrypt(json) } satisfies EncryptedEnvelope,
          null,
          2,
        )
      : json;
    writeFileSync(this.filePath, body, 'utf8');
  }

  /**
   * The stable device id that names this machine's Dodo activation. Generated +
   * persisted on first read so the device keeps its identity across activations.
   */
  public ensureDeviceId(): string {
    const existing = this.read();
    if (existing?.deviceId) return existing.deviceId;
    const id = this.genDeviceId();
    this.write({ ...(existing ?? {}), deviceId: id });
    return id;
  }

  /** Merge a partial update into the stored record (creating the id if needed). */
  public update(patch: Partial<StoredLicense>): StoredLicense {
    const current: StoredLicense = this.read() ?? { deviceId: this.ensureDeviceId() };
    const next: StoredLicense = { ...current, ...patch, deviceId: current.deviceId };
    this.write(next);
    return next;
  }

  /** Clear the license (deactivation) but keep the device id. */
  public clear(): void {
    this.write({ deviceId: this.ensureDeviceId() });
  }

  /** The renderer-safe status derived from the current stored state. */
  public status(): LicenseStatus {
    return deriveStatus(this.read(), this.now(), this.graceMs);
  }
}
