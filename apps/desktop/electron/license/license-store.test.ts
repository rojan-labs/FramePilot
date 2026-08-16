/**
 * LicenseStore tests: uid generation/persistence, update/clear round-trips, the
 * secret-free status projection, and corrupt-file tolerance.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LicenseStore, type LicenseCrypto } from './license-store.js';
import { DEFAULT_GRACE_MS } from './license-gate.js';

/**
 * A reversible stand-in for Electron `safeStorage`: `available()` is true and
 * only tokens it produced (prefixed `ENC:`) decrypt — anything else throws, like
 * real ciphertext tampered with or copied from another OS user.
 */
const fakeCrypto: LicenseCrypto = {
  available: () => true,
  encrypt: (plain) => `ENC:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (token) => {
    if (!token.startsWith('ENC:')) throw new Error('not our ciphertext');
    return Buffer.from(token.slice(4), 'base64').toString('utf8');
  },
};

describe('LicenseStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fp-lic-'));
    file = join(dir, 'license.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null status (needs activation) when absent', () => {
    const store = new LicenseStore(file);
    expect(store.status().status).toBe('needs_activation');
  });

  it('generates and persists a stable uid', () => {
    let n = 0;
    const store = new LicenseStore(file, DEFAULT_GRACE_MS, () => `uid-${++n}`);
    const uid = store.ensureUid();
    expect(uid).toBe('uid-1');
    // Second call reuses the persisted uid, never regenerates.
    expect(store.ensureUid()).toBe('uid-1');
    expect(JSON.parse(readFileSync(file, 'utf8')).uid).toBe('uid-1');
  });

  it('generates a Freemius-safe uid (<=32 chars, no hyphens) by default', () => {
    // Freemius rejects any activation uid longer than 32 chars (uid_too_long);
    // the default generator must not emit a raw 36-char randomUUID.
    const uid = new LicenseStore(file).ensureUid();
    expect(uid.length).toBeLessThanOrEqual(32);
    expect(uid).not.toContain('-');
  });

  it('regenerates a persisted over-long uid so activation can succeed', () => {
    // A pre-fix build wrote a 36-char randomUUID that Freemius would reject.
    writeFileSync(file, JSON.stringify({ uid: '123e4567-e89b-12d3-a456-426614174000' }), 'utf8');
    const store = new LicenseStore(file, DEFAULT_GRACE_MS, () => 'shortuid');
    expect(store.ensureUid()).toBe('shortuid');
    expect(JSON.parse(readFileSync(file, 'utf8')).uid).toBe('shortuid');
  });

  it('updates and derives a valid, key-masked status without leaking the key', () => {
    const store = new LicenseStore(
      file,
      DEFAULT_GRACE_MS,
      () => 'uid-x',
      () => 1000,
    );
    store.update({ licenseKey: 'ABC-DEF-7788', isValid: true, lastValidatedAt: 1000 });
    const status = store.status();
    expect(status).toMatchObject({ status: 'valid', licensed: true, maskedKey: '••••-••••-7788' });
    // The safe projection must not contain the full key or the token.
    expect(JSON.stringify(status)).not.toContain('ABC-DEF-7788');
  });

  it('clear() removes the license but keeps the uid', () => {
    const store = new LicenseStore(file, DEFAULT_GRACE_MS, () => 'uid-keep');
    store.update({ licenseKey: 'K-1', isValid: true });
    store.clear();
    expect(store.read()?.uid).toBe('uid-keep');
    expect(store.read()?.licenseKey).toBeUndefined();
    expect(store.status().status).toBe('needs_activation');
  });

  it('tolerates a corrupt file', () => {
    writeFileSync(file, '{ not json', 'utf8');
    const store = new LicenseStore(file);
    expect(store.read()).toBeNull();
    expect(store.status().status).toBe('needs_activation');
  });

  describe('with OS-backed encryption', () => {
    const make = () =>
      new LicenseStore(
        file,
        DEFAULT_GRACE_MS,
        () => 'uid-e',
        () => 1000,
        fakeCrypto,
      );

    it('persists an encrypted envelope and round-trips the record', () => {
      make().update({ licenseKey: 'ABC-DEF-7788', isValid: true, lastValidatedAt: 1000 });

      // On disk it is ciphertext — never the raw key, and wrapped as an envelope.
      const onDisk = readFileSync(file, 'utf8');
      expect(onDisk).toContain('"enc"');
      expect(onDisk).not.toContain('ABC-DEF-7788');

      // A fresh instance decrypts it back to a valid, trusted record.
      const status = make().status();
      expect(status).toMatchObject({ status: 'valid', licensed: true });
      expect(make().read()?.licenseKey).toBe('ABC-DEF-7788');
    });

    it('does NOT trust a hand-written plaintext record (anti-forgery + migration)', () => {
      // A cracker (or a genuine pre-encryption install) writes plaintext claiming validity.
      writeFileSync(
        file,
        JSON.stringify({
          uid: 'uid-e',
          licenseKey: 'FAKE-KEY-9999',
          installId: 'inst-1',
          isValid: true,
          expiration: null,
          lastValidatedAt: 1000,
        }),
        'utf8',
      );
      const store = make();
      const read = store.read();
      // Identity (key/install) is kept so the service can re-verify online…
      expect(read?.licenseKey).toBe('FAKE-KEY-9999');
      expect(read?.installId).toBe('inst-1');
      // …but the forged trust fields are stripped, so the gate stays closed.
      expect(read?.isValid).toBeUndefined();
      expect(read?.lastValidatedAt).toBeUndefined();
      expect(store.status().licensed).toBe(false);
    });

    it('fails closed on a tampered/undecryptable envelope', () => {
      writeFileSync(file, JSON.stringify({ v: 1, enc: 'not-our-ciphertext' }), 'utf8');
      const store = make();
      expect(store.read()).toBeNull();
      expect(store.status().status).toBe('needs_activation');
    });
  });
});
