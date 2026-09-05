# Website & Freemius licensing

How to run the marketing site (`apps/website`), configure Freemius, and how the
100%-paid license gate works in the desktop app. See ADR 0036 for the rationale.

The visual system described in ADR 0036 (dark tokens ported from the editor) was replaced on
2026-09-05 by the light, timeline-shaped "ripple delete" system in **ADR 0172**: paper canvas,
orange as the only action colour, ruler/timecode furniture on every route, and a once-per-session
landing intro built on `framer-motion`. The design rules live in `apps/website/README.md`.

## Overview

```
subscribe on the website  →  Freemius issues a license key (email)  →
paste it into FramePilot on first launch  →  app activates on the device  →  editor unlocks
```

- **Pricing** — FramePilot is a **subscription**: **$25/month** or **$199/year**
  (≈ $16.58/mo, ~34% off) billed annually. Both cadences unlock the whole product;
  a contact-sales **Studio** plan covers volume/agency licensing.
- **Website** (`apps/website`) — a statically-exported Next.js site: landing,
  pricing (Freemius checkout with a Monthly/Annual toggle), a full docs site,
  markdown blog, downloads, legal.
- **License gate** (`apps/desktop/electron/license/`) — the app requires a valid
  subscription to run; a lapsed subscription shows a renew screen.

## Running the website

```bash
pnpm --filter @framepilot/website dev        # dev server on http://localhost:4321
pnpm --filter @framepilot/website build      # static export → apps/website/out
pnpm --filter @framepilot/website generate:og  # regenerate OG image + icons/favicons
pnpm --filter @framepilot/website test       # unit tests (pricing/seo/blog)
```

The static export in `apps/website/out/` can be hosted anywhere (Vercel static,
GitHub Pages, S3/CloudFront).

## Environment variables

> Secret keys are **build/server-only** and must never appear in the client
> bundle. The website enforces this: only `NEXT_PUBLIC_*` values are exposed to the
> browser (the Freemius checkout needs only the **public** key + product id).

### Website (`apps/website`)

| Variable                               | Scope      | Purpose                                              |
| -------------------------------------- | ---------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL`                 | public     | Canonical origin (metadata, sitemap, OG, JSON-LD).   |
| `NEXT_PUBLIC_FREEMIUS_PRODUCT_ID`      | public     | Freemius product id for the checkout overlay.        |
| `NEXT_PUBLIC_FREEMIUS_PUBLIC_KEY`      | public     | Freemius public key (`pk_…`) for the overlay.        |
| `NEXT_PUBLIC_FREEMIUS_PLAN_ID_MONTHLY` | public     | Monthly plan id pre-selected in the overlay.         |
| `NEXT_PUBLIC_FREEMIUS_PLAN_ID_ANNUAL`  | public     | Annual plan id pre-selected in the overlay.          |
| `NEXT_PUBLIC_FREEMIUS_PLAN_ID`         | public     | Legacy single plan-id fallback (optional).           |
| `NEXT_PUBLIC_DEMO_YOUTUBE_ID`          | public     | Demo-section YouTube id (swap for the real video).   |
| `FREEMIUS_PRODUCT_ID`                  | build only | Product id for the build-time live price fetch.      |
| `FREEMIUS_PUBLIC_KEY`                  | build only | Public key used to sign the price-fetch request.     |
| `FREEMIUS_SECRET_KEY`                  | build only | **Secret** key (`sk_…`) for the price-fetch request. |

> **Deploy gotcha (checkout CTAs go dead if you skip this):** `next build` only
> inlines `NEXT_PUBLIC_*` values that are present in its environment, and Turborepo
> **prunes any env var not declared in `turbo.json`** from a task's environment. So
> every `NEXT_PUBLIC_FREEMIUS_*` name above is listed in `turbo.json` `globalEnv`,
> and each must also be set in the **deploy host** (Vercel/CI) — not just the local
> `.env`, which `next build` does not read. If they are missing at build time,
> `isFreemiusConfigured()` is false and the CTA surfaces a visible "checkout
> unavailable" error (it no longer silently reloads `/pricing`).

If the price-fetch env is absent, the build logs a warning and uses the typed
fallback prices in `apps/website/src/lib/pricing.ts` — `{ monthly: 25, annual: 199 }`
(edit those to change the offline defaults). Nothing breaks offline. The
Monthly/Annual toggle's "Save N%" badge is computed from these numbers, so it is
never a hand-typed discount.

### Documentation site

`/docs` is a real docs site (not link-outs): authored markdown lives in
`apps/website/content/docs/*.mdx` and is rendered at build time by the same
`lib/markdown.ts` pipeline as the blog. Add a page by dropping in a `.mdx` file
with frontmatter — the sidebar/order come from it:

```yaml
---
title: My page
description: One-line summary (also the meta description).
category: Getting started # | Guides | Reference
order: 4 # sort within the category
---
```

`lib/docs.ts` builds the grouped sidebar + prev/next; `lib/markdown.ts#extractToc`
builds the on-page (scroll-spy) table of contents.

### Desktop (`apps/desktop`)

| Variable                          | Purpose                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `FRAMEPILOT_FREEMIUS_PRODUCT_ID`  | Enables the license gate. **When unset, the gate is off** (dev / unconfigured builds run freely). Packaged production builds must set it. |
| `FRAMEPILOT_LICENSE_DEV_BYPASS=1` | Force-disable the gate during development.                                                                                                |

The desktop uses only the **public** activate/validate endpoints, so no secret key
ships in the app.

## How the license gate works

1. On launch, `LicenseGate` (renderer) calls `bridge.licenseStatus()`.
   - **No bridge** (browser/dev/tests) → the editor renders (gate is Electron-only).
   - **`valid`** → the editor renders.
   - **`needs_activation` / `invalid`** → an activation card: paste the key,
     activate, or follow the buy link to the pricing page.
2. Activation (`bridge.licenseActivate`) runs in the **main process**:
   `POST /v1/products/{id}/licenses/activate.json` creates a Freemius install; the
   `install_id` + token + key are stored in `license.json` (userData). Only a
   masked, secret-free `LicenseStatus` ever crosses the bridge.
3. On subsequent launches the service revalidates against Freemius when the cached
   result is stale (daily), via `GET …/installs/{installId}/license.json`.
   - Freemius says cancelled/expired → **invalid immediately** (no grace).
   - Network error → the license stays valid within a **7-day offline-grace
     window** from the last successful validation, then requires reconnecting.
4. Defense-in-depth: the AI and render/export IPC handlers refuse when unlicensed.

### License at rest — encryption & anti-crack

`license.json` is **encrypted with Electron `safeStorage`** (Keychain on macOS,
DPAPI on Windows, libsecret on Linux) — see `LicenseStore` + the `LicenseCrypto`
adapter wired in `main.ts`. This defeats the trivial crack of hand-writing
`{ isValid: true, expiration: null }` to mint a free lifetime license. Two rules
make it robust:

- A **tampered/undecryptable** record (edited bytes, or a `license.json` copied
  from another machine/OS user) reads as `null` → the gate **fails closed**.
- When encryption is available, a **plaintext** record is never trusted as valid:
  its `isValid`/`lastValidatedAt` are stripped so the app must **re-verify online**
  before unlocking. This both blocks a forged plaintext file and seamlessly
  migrates a genuine pre-encryption record on the next online check.

**Threat model (be honest):** this is anti-tamper, not absolute DRM. A determined
attacker can still repack the app's `asar` to remove the gate — unavoidable for any
JS/Electron app. The goal is to defeat the realistic, low-effort attack and keep
**Freemius the authority** on validity. Where no OS keyring exists, the store
degrades to plaintext (as before) rather than bricking the app.

## Freemius dashboard setup

1. Create a Freemius product; note the **product id**, **public key** (`pk_…`), and
   **secret key** (`sk_…`).
2. Create the paid **subscription** plan with **both** a monthly ($25) and an
   annual ($199) price. Set the internal plan id mapping in
   `scripts/fetch-pricing.ts` (`PLAN_NAME_BY_ID`) if your plan `name` differs from
   `pro`. The fetch reads both cadences.
3. Set the env vars above (website + desktop).
4. Configure the checkout success redirect / email so subscribers receive their key.

The checkout overlay is opened with `billing_cycle: 'monthly' | 'annual'`
(from the pricing toggle), so buyers land on the cadence they picked. If the
in-page overlay can't run (script blocked by an ad/privacy blocker, CDN failure,
or `window.FS.Checkout` missing), `openCheckout()` falls back to Freemius' **hosted
full-page checkout** — `https://checkout.freemius.com/product/{productId}/plan/{planId}/`
(see `hostedCheckoutUrl()` in `src/lib/freemius.ts`) — so the CTA never dead-ends.

## Downloads

The website's Download buttons resolve to the **latest GitHub Release**
(`GITHUB_URL/releases/latest`), matching the electron-builder + `electron-updater`
setup. Publish releases there and downloads/updates flow automatically.
