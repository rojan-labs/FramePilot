# 37. License-at-rest encryption + Freemius checkout env passthrough

Date: 2026-07-05

## Status

Accepted. Amends **ADR 0036** (partly supersedes its "DRM-style hardening — out
of scope / plaintext store" decision).

## Context

Two production defects surfaced after ADR 0036 shipped:

1. **Pricing CTAs did nothing.** `openCheckout()` opens the Freemius overlay only
   when `NEXT_PUBLIC_FREEMIUS_PRODUCT_ID` + `NEXT_PUBLIC_FREEMIUS_PUBLIC_KEY` are
   inlined at build time; otherwise it silently did `window.location.href =
'/pricing/'` — a no-op on the pricing page, so the button looked dead. Root
   cause: `turbo.json` did not declare the `NEXT_PUBLIC_FREEMIUS_*` vars, and
   Turborepo prunes undeclared env vars from a task's environment, so `next build`
   inlined empty strings and `isFreemiusConfigured()` was `false` in the deployed
   bundle.

2. **The license was trivially crackable.** ADR 0036 deliberately kept
   `license.json` as **plaintext** ("licensing convenience, not DRM"). But
   `deriveStatus()` trusts the on-disk `isValid`/`expiration`, so anyone could
   hand-write `{ isValid: true, expiration: null }` and mint a free lifetime
   license with zero effort. The chosen trust model was too weak for a 100%-paid
   product.

## Decision

**Checkout env (website).** Declare every `NEXT_PUBLIC_FREEMIUS_*` var in
`turbo.json` `globalEnv` so `next build` receives them and cache-invalidates on
change; they must also be set in the deploy host. `openCheckout()` now **throws**
when unconfigured/overlay-failed instead of silently redirecting, and `BuyButton`
renders a visible "checkout unavailable" error — a misconfigured build fails
loudly, never as a dead click.

**License at rest (desktop).** Encrypt `license.json` with Electron `safeStorage`
(OS-keychain backed) via an injectable `LicenseCrypto` adapter on `LicenseStore`
(kept off-Electron/unit-testable; defaults to plaintext identity):

- Tampered/undecryptable record → `read()` returns `null` → gate **fails closed**.
- When encryption is available, a **plaintext** record is never trusted valid —
  its `isValid`/`lastValidatedAt` are stripped, forcing an **online re-verify**.
  This blocks a forged plaintext file _and_ migrates a genuine pre-encryption
  record on the next online check (no forced re-activation).
- No OS keyring → degrade to plaintext rather than brick the app.

Freemius stays the **authority**: authoritative `is_cancelled`/expiry → invalid
immediately; the 7-day offline grace is unchanged.

## Threat model (honest scope)

This is anti-tamper, not absolute DRM. A determined attacker can repack the app's
`asar` to delete the gate — unavoidable for any JS/Electron app and explicitly out
of scope. The bar we commit to: defeat the low-effort file-editing crack and keep
validity server-authoritative.

## Consequences

- Deploying the site requires the `NEXT_PUBLIC_FREEMIUS_*` vars in both
  `turbo.json` and the host; otherwise CTAs show a loud error (by design).
- Existing activated users migrate transparently on their next online launch;
  users whose OS lacks a keyring keep the prior plaintext behavior.
- `LicenseStore` gains three tests (encrypt round-trip, plaintext-not-trusted
  migration, tamper fail-closed); all prior license tests stay green.
