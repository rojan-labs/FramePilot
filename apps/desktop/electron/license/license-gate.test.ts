/**
 * Pure license-decision tests: expiry, offline grace, masking, and the derived
 * renderer-safe status across every state.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRACE_MS,
  deriveStatus,
  isExpired,
  maskLicenseKey,
  parseFreemiusDate,
  withinGrace,
  type StoredLicense,
} from './license-gate.js';

const NOW = Date.parse('2026-07-03T00:00:00Z');

describe('parseFreemiusDate', () => {
  it('parses Freemius "YYYY-MM-DD HH:MM:SS" UTC', () => {
    expect(parseFreemiusDate('2026-08-01 12:00:00')).toBe(Date.parse('2026-08-01T12:00:00Z'));
  });
  it('parses ISO strings and returns null for empty/invalid', () => {
    expect(parseFreemiusDate('2026-08-01T12:00:00Z')).toBe(Date.parse('2026-08-01T12:00:00Z'));
    expect(parseFreemiusDate(null)).toBeNull();
    expect(parseFreemiusDate('not-a-date')).toBeNull();
  });
});

describe('isExpired', () => {
  it('is false for lifetime (null) and future dates', () => {
    expect(isExpired(null, NOW)).toBe(false);
    expect(isExpired('2027-01-01 00:00:00', NOW)).toBe(false);
  });
  it('is true for a past date', () => {
    expect(isExpired('2026-01-01 00:00:00', NOW)).toBe(true);
  });
});

describe('maskLicenseKey', () => {
  it('shows only the last four characters', () => {
    expect(maskLicenseKey('SECRET-KEY-AB12')).toBe('••••-••••-AB12');
    expect(maskLicenseKey(undefined)).toBeUndefined();
  });
});

describe('withinGrace', () => {
  it('honours the window and rejects stale / missing timestamps', () => {
    expect(withinGrace(NOW - 1000, NOW, DEFAULT_GRACE_MS)).toBe(true);
    expect(withinGrace(NOW - DEFAULT_GRACE_MS - 1, NOW, DEFAULT_GRACE_MS)).toBe(false);
    expect(withinGrace(undefined, NOW, DEFAULT_GRACE_MS)).toBe(false);
  });
});

describe('deriveStatus', () => {
  const base: StoredLicense = { uid: 'u1', licenseKey: 'K-EY-9999' };

  it('needs activation with no stored license or no key', () => {
    expect(deriveStatus(null, NOW).status).toBe('needs_activation');
    expect(deriveStatus({ uid: 'u1' }, NOW).status).toBe('needs_activation');
  });

  it('is valid for a currently-valid license and masks the key', () => {
    const s = deriveStatus({ ...base, isValid: true, lastValidatedAt: NOW }, NOW);
    expect(s).toMatchObject({ status: 'valid', licensed: true, maskedKey: '••••-••••-9999' });
  });

  it('is invalid (expired) when the subscription lapsed', () => {
    const s = deriveStatus({ ...base, isValid: true, expiration: '2026-01-01 00:00:00' }, NOW);
    expect(s.status).toBe('invalid');
    expect(s.licensed).toBe(false);
    expect(s.message).toMatch(/expired/i);
  });

  it('treats an authoritative invalid as invalid regardless of recency (no grace)', () => {
    const s = deriveStatus({ ...base, isValid: false, lastValidatedAt: NOW - 1000 }, NOW);
    expect(s.status).toBe('invalid');
    expect(s.licensed).toBe(false);
  });

  it('keeps a lifetime (no-expiry) valid license valid even when stale', () => {
    const s = deriveStatus(
      { ...base, isValid: true, expiration: null, lastValidatedAt: NOW - 10 * DEFAULT_GRACE_MS },
      NOW,
    );
    expect(s.status).toBe('valid');
  });

  it('keeps a subscription valid within grace but invalid beyond it', () => {
    const future = '2027-01-01 00:00:00';
    expect(
      deriveStatus({ ...base, isValid: true, expiration: future, lastValidatedAt: NOW - 1000 }, NOW)
        .status,
    ).toBe('valid');
    expect(
      deriveStatus(
        { ...base, isValid: true, expiration: future, lastValidatedAt: NOW - DEFAULT_GRACE_MS - 1 },
        NOW,
      ).status,
    ).toBe('invalid');
  });
});
