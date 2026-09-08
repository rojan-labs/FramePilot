# Website & Dodo Payments licensing

How to run the marketing site (`apps/website`), how checkout works, and how the
100%-paid license gate works in the desktop app. See ADR 0036 for the original
rationale and **ADR 0177** for the move from Freemius to Dodo Payments.

> **Setting payments up from scratch?** The Dodo dashboard walkthrough — products,
> env vars, test-mode purchase, go-live — lives in the maintainer's local
> `PAYMENTS_SETUP.md`, which is gitignored because it describes the real product's
> account. This guide explains how the code behaves once that is done.

The visual system described in ADR 0036 (dark tokens ported from the editor) was replaced on
2026-09-05 by the light, timeline-shaped "ripple delete" system in **ADR 0172**: paper canvas,
orange as the only action colour, ruler/timecode furniture on every route, and a once-per-session
landing intro built on `framer-motion`. The design rules live in `apps/website/README.md`.

## Overview

```
subscribe on the website  →  Dodo Payments issues a license key (email)  →
paste it into FramePilot on first launch  →  app activates on the device  →  editor unlocks
```

- **Pricing** — FramePilot is a **subscription**: **$25/month** or **$199/year**
  (≈ $16.58/mo, ~34% off) billed annually. Both cadences unlock the whole product;
  a contact-sales **Studio** plan covers volume/agency licensing.
- **Website** (`apps/website`) — a statically-exported Next.js site: landing,
  pricing (Dodo hosted checkout with a Monthly/Annual toggle), a full docs site,
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

> The Dodo API key is **build/server-only** and must never appear in the client
> bundle. The website enforces this: only `NEXT_PUBLIC_*` values are exposed to the
> browser, and hosted checkout needs nothing but a **product id**, which is public
> by design (it is visible in the checkout URL).

### Website (`apps/website`)

| Variable                              | Scope      | Purpose                                                       |
| ------------------------------------- | ---------- | ------------------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL`                | public     | Canonical origin (metadata, sitemap, OG, and the return URL). |
| `NEXT_PUBLIC_DODO_PRODUCT_ID_MONTHLY` | public     | Dodo product id for the monthly subscription.                 |
| `NEXT_PUBLIC_DODO_PRODUCT_ID_ANNUAL`  | public     | Dodo product id for the annual subscription.                  |
| `NEXT_PUBLIC_DODO_ENVIRONMENT`        | public     | `live` (default) or `test` — picks the checkout host.         |
| `NEXT_PUBLIC_DEMO_YOUTUBE_ID`         | public     | Demo-section YouTube id (swap for the real video).            |
| `DODO_PAYMENTS_API_KEY`               | build only | Merchant API key for the build-time live price fetch.         |
| `DODO_PAYMENTS_ENVIRONMENT`           | build only | Which Dodo API the price fetch reads: `live` or `test`.       |

Each cadence is a **separate Dodo product**: a Dodo product carries exactly one
recurring price, so "FramePilot Monthly" and "FramePilot Yearly" are two products,
not one plan with two prices.

> **Deploy gotcha (checkout CTAs go dead if you skip this):** `next build` only
> inlines `NEXT_PUBLIC_*` values that are present in its environment, and Turborepo
> **prunes any env var not declared in `turbo.json`** from a task's environment. So
> every `NEXT_PUBLIC_DODO_*` name above is listed in `turbo.json` `globalEnv`,
> and each must also be set in the **deploy host** (Vercel/CI) — not just the local
> `.env`, which `next build` does not read. If they are missing at build time,
> `checkoutUrl()` throws and the CTA renders a disabled button with a visible
> "checkout unavailable" message rather than a dead click.

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
| `FRAMEPILOT_DODO_PRODUCT_ID`      | Enables the license gate. **When unset, the gate is off** (dev / unconfigured builds run freely). Packaged production builds must set it. |
| `FRAMEPILOT_DODO_ENVIRONMENT`     | `live` (default) or `test` — which Dodo environment keys are verified against.                                                            |
| `FRAMEPILOT_LICENSE_DEV_BYPASS=1` | Force-disable the gate during development.                                                                                                |

The desktop uses only Dodo's **public** activate/validate/deactivate endpoints —
they authenticate with the license key itself — so no merchant credential ships in
the app.

## How the license gate works

1. On launch, `LicenseGate` (renderer) calls `bridge.licenseStatus()`.
   - **No bridge** (browser/dev/tests) → the editor renders (gate is Electron-only).
   - **`valid`** → the editor renders.
   - **`needs_activation` / `invalid`** → an activation card: paste the key,
     activate, or follow the buy link to the pricing page.
2. Activation (`bridge.licenseActivate`) runs in the **main process**:
   `POST /licenses/activate` creates a license key instance named after this
   machine; the `instanceId` + key are stored in `license.json` (userData). Only a
   masked, secret-free `LicenseStatus` ever crosses the bridge.
3. On subsequent launches the service revalidates when the cached result is stale
   (daily), via `POST /licenses/validate` with the key + instance id.
   - Dodo says `valid: false` (revoked, cancelled, lapsed), or answers 403/404 →
     **invalid immediately** (no grace).
   - Network error → the license stays valid within a **30-day offline-grace
     window** from the last successful validation, then requires reconnecting.
4. Deactivation calls `POST /licenses/deactivate` first, so the customer's
   activation slot is freed before the local record is cleared; a failed remote
   call never blocks the local sign-out.
5. Defense-in-depth: the AI and render/export IPC handlers refuse when unlicensed.

**Why validity is grace-window based, not expiry based:** Dodo's public license API
answers one question — `valid: true | false` — and never reports an expiry date. A
subscription key's validity simply _follows the subscription_. So the app cannot
reason about dates locally; a stale record is not trusted, it is re-checked, and
the grace window is what keeps a paying customer editing on a plane.

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
**Dodo Payments the authority** on validity. Where no OS keyring exists, the store
degrades to plaintext (as before) rather than bricking the app.

## Checkout

The buy CTA is a **link** to Dodo's hosted checkout, built by `checkoutUrl()` in
`src/lib/dodo.ts`:

```
https://checkout.dodopayments.com/buy/{productId}?quantity=1&redirect_url={site}/thank-you/
```

`https://test.checkout.dodopayments.com` is used instead when
`NEXT_PUBLIC_DODO_ENVIRONMENT=test`. The pricing toggle decides which product id
goes in the URL, so buyers land on the cadence they picked.

**Why a link and not an embedded overlay:** the site is a static export
(`output: 'export'`, no server runtime), and Dodo's overlay/inline checkout needs a
server route to mint a Checkout Session — its session API must never be called from
the browser with a merchant API key. A static payment link needs no server and no
third-party script, so there is nothing for an ad blocker to break and the CTA
cannot dead-end. It also behaves like a link should: middle-click, open in a new
tab, copy the address.

Dashboard setup (products, license-key entitlement, activation limit, emails) is in
the maintainer's local `PAYMENTS_SETUP.md`.

## Downloads

The website's Download buttons resolve to the **latest GitHub Release**
(`GITHUB_URL/releases/latest`), matching the electron-builder + `electron-updater`
setup. Publish releases there and downloads/updates flow automatically.
