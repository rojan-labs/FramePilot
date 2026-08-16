/**
 * License store — `license.json` in the app data dir, **encrypted at rest** with
 * the injected {@link LicenseCrypto} (Electron `safeStorage`, OS-keychain backed)
 * when it is available.
 *
 * Mirrors {@link AiConfigStore}: no `electron` import (takes a file path + a
 * crypto adapter, so it is unit-testable off a temp file), tolerant of a
 * missing/corrupt file, and it exposes **only** a renderer-safe
 * {@link LicenseStatus} to callers — the license key and install token never
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

/**
 * Freemius rejects any activation `uid` longer than 32 characters
 * (`uid_too_long`, HTTP 400). Node's `randomUUID()` is 36 chars (it includes
 * four hyphens), so the raw value must be normalized before it ever reaches the
 * API — hence the default generator strips the hyphens to a 32-char hex id, as
 * the Freemius docs prescribe (`randomUUID().replace(/-/g, '')`).
 */
const FREEMIUS_UID_MAX_LEN = 32;

/** Freemius-safe device uid: 32-char hex (randomUUID with its hyphens removed). */
function freemiusUid(): string {
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
    /** Injectable for tests. Defaults to a Freemius-safe 32-char hex uid. */
    private readonly genUid: () => string = freemiusUid,
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
        if (typeof inner.uid !== 'string' || inner.uid.length === 0) return null;
        return inner as StoredLicense;
      } catch {
        return null;
      }
    }

    // Plaintext record.
    const record = parsed as Partial<StoredLicense>;
    if (typeof record.uid !== 'string' || record.uid.length === 0) return null;
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
   * The stable device uid used for Freemius activation. Generated + persisted on
   * first read so the same device keeps its identity across activations.
   */
  public ensureUid(): string {
    const existing = this.read();
    // Reuse a persisted uid, but only if it's within Freemius's 32-char limit.
    // A build predating that fix may have written a 36-char `randomUUID()` that
    // Freemius rejects (`uid_too_long`); regenerate so activation can succeed.
    if (existing?.uid && existing.uid.length <= FREEMIUS_UID_MAX_LEN) return existing.uid;
    const uid = this.genUid();
    this.write({ ...(existing ?? {}), uid });
    return uid;
  }

  /** Merge a partial update into the stored record (creating uid if needed). */
  public update(patch: Partial<StoredLicense>): StoredLicense {
    const current: StoredLicense = this.read() ?? { uid: this.ensureUid() };
    const next: StoredLicense = { ...current, ...patch, uid: current.uid };
    this.write(next);
    return next;
  }

  /** Clear the license (deactivation) but keep the device uid. */
  public clear(): void {
    this.write({ uid: this.ensureUid() });
  }

  /** The renderer-safe status derived from the current stored state. */
  public status(): LicenseStatus {
    return deriveStatus(this.read(), this.now(), this.graceMs);
  }
}
