# Payments setup — Dodo Payments

Everything needed to take FramePilot from "no payments configured" to "a customer
can buy it and activate the app." Dodo Payments is the **merchant of record**: it
runs checkout, collects tax, issues the license key, and answers the app when it
asks whether that key is still valid.

FramePilot has no payments backend of its own. There is nothing to deploy and no
webhook to receive — the whole flow is:

```
buy on the website  →  Dodo emails a license key  →  paste it into the desktop app
      →  the app activates the key against Dodo  →  the editor unlocks
```

Design rationale lives in [ADR 0177](docs/adr/0177-payments-move-to-dodo-payments.md);
how the code behaves once configured is in
[docs/guides/website-and-licensing.md](docs/guides/website-and-licensing.md).

---

## 1. Create the two products

A Dodo product carries exactly **one** recurring price, so each billing cadence is
its own product. In the Dodo dashboard (start in **Test mode**), create:

| Product            | Pricing type | Price | Billing interval |
| ------------------ | ------------ | ----- | ---------------- |
| FramePilot Monthly | Recurring    | $25   | 1 month          |
| FramePilot Yearly  | Recurring    | $199  | 1 year           |

For **each** product, fill in the required fields (name, description, image, tax
category — pick the software/digital-products category), then under **Advanced
settings**:

- Turn on **Generate license keys**.
- Set an **activation limit**. FramePilot registers one activation per machine, so
  this is the number of computers one subscription may run on. Leave it blank for
  unlimited. `3` is a reasonable default for a desktop editor (laptop, desktop,
  and one spare so a dead machine isn't a support ticket).
- Leave **license key duration** empty. Subscription keys have no independent
  expiry — Dodo keeps them valid while the subscription is, which is exactly what
  the app relies on.
- Optionally set the **license key activation message** shown after purchase, e.g.
  "Paste this key into FramePilot on first launch."

Copy each product id (`pdt_…`) — you need both.

## 2. Get an API key

**Developer → API keys → Create.** This key is used for exactly one thing in this
repo: reading the live product prices at website build time so the pricing page
can never drift from what customers are actually charged.

It is **build/server-only**. It must never appear in a `NEXT_PUBLIC_*` variable, a
client component, the static export, a screenshot, or a PR description.

## 3. Set the environment variables

All of these are documented in [`.env.example`](.env.example) and declared in
`turbo.json` `globalEnv` (Turborepo prunes anything not declared, so a variable
missing there silently never reaches the build).

### Website — browser-visible

Product ids are public by design; they appear in the checkout URL.

| Variable                              | Value                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `NEXT_PUBLIC_DODO_PRODUCT_ID_MONTHLY` | `pdt_…` for FramePilot Monthly                                               |
| `NEXT_PUBLIC_DODO_PRODUCT_ID_ANNUAL`  | `pdt_…` for FramePilot Yearly                                                |
| `NEXT_PUBLIC_DODO_ENVIRONMENT`        | `test` while testing, `live` in production                                   |
| `NEXT_PUBLIC_SITE_URL`                | e.g. `https://framepilot.app` — also the base of the post-payment return URL |

### Website — build-only

| Variable                    | Value                                       |
| --------------------------- | ------------------------------------------- |
| `DODO_PAYMENTS_API_KEY`     | the key from step 2                         |
| `DODO_PAYMENTS_ENVIRONMENT` | `test` or `live`, matching the key you used |

### Desktop app

| Variable                        | Value                                                       |
| ------------------------------- | ----------------------------------------------------------- |
| `FRAMEPILOT_DODO_PRODUCT_ID`    | either product id — **setting this turns the paywall on**   |
| `FRAMEPILOT_DODO_ENVIRONMENT`   | `test` or `live`                                            |
| `FRAMEPILOT_LICENSE_DEV_BYPASS` | `1` to run unlocked in local development. Never in a build. |

The desktop app needs **no API key**. Dodo's activate / validate / deactivate
endpoints are public — they authenticate with the license key itself — which is
why no merchant credential ships inside the app.

> **Deploy gotcha:** `next build` only inlines `NEXT_PUBLIC_*` values present in
> _its_ environment, and it does not read your local `.env`. Set every public
> variable in the deploy host (Vercel/CI) as well, or the buy button ships
> disabled with a "checkout unavailable" message.

## 4. Test the whole flow in test mode

1. Build and serve the site with the test-mode variables set:
   ```bash
   pnpm --filter @framepilot/website build   # prebuild fetches live prices
   ```
   The build logs `[fetch-pricing] Wrote live Dodo Payments pricing.` when the API
   key works, and a warning plus the typed fallback ($25 / $199) when it does not.
   Both are fine; only the first proves the key.
2. Open `/pricing`, toggle Monthly/Annual, and click the CTA. You should land on
   `test.checkout.dodopayments.com/buy/<your product id>`.
3. Pay with a [Dodo test card](https://docs.dodopayments.com/miscellaneous/testing-process).
   You should be returned to `/thank-you/` and receive the license key by email.
4. Run the desktop app with `FRAMEPILOT_DODO_PRODUCT_ID` set and
   `FRAMEPILOT_DODO_ENVIRONMENT=test`, then paste the key into the activation card.
   The editor should unlock, and the activation should appear in the Dodo dashboard
   named after your machine.
5. Check the failure paths, because they are what customers actually hit:
   - **Wrong key** → "We could not find that license key."
   - **Activation limit** → activate on more machines than the limit; the message
     should tell you to deactivate another device.
   - **Deactivate** from the license screen, then confirm the activation slot is
     freed in the dashboard and the key activates elsewhere.
   - **Offline** → disconnect and relaunch. The app keeps working inside its
     30-day offline grace window.
   - **Cancelled subscription** → cancel it in the dashboard; the next validation
     (daily, or on relaunch) closes the gate and shows the renew screen.

## 5. Go live

1. Recreate both products in **Live mode** and copy the new `pdt_…` ids — test and
   live products are separate objects with separate ids.
2. Create a live API key.
3. Switch every environment to `live`: `NEXT_PUBLIC_DODO_ENVIRONMENT`,
   `DODO_PAYMENTS_ENVIRONMENT`, `FRAMEPILOT_DODO_ENVIRONMENT`.
4. Point the website env at the live product ids and rebuild/redeploy.
5. Set `FRAMEPILOT_DODO_PRODUCT_ID` (live id) in the desktop build environment for
   packaged releases, and make sure `FRAMEPILOT_LICENSE_DEV_BYPASS` is **not** set
   anywhere in the release pipeline. An unconfigured product id means the app ships
   unlocked — see `license-service.ts`.
6. Buy the product once for real, then refund yourself. It is the only way to know
   the live keys, the email, and the activation path all work together.

## What lives where

| Concern                     | File                                               |
| --------------------------- | -------------------------------------------------- |
| Checkout URL building       | `apps/website/src/lib/dodo.ts`                     |
| Buy CTA                     | `apps/website/src/components/BuyButton.tsx`        |
| Build-time price fetch      | `apps/website/scripts/fetch-pricing.ts`            |
| Plan copy + fallback prices | `apps/website/src/lib/pricing.ts`                  |
| Dodo license API client     | `apps/desktop/electron/license/dodo-client.ts`     |
| Activation/validation logic | `apps/desktop/electron/license/license-service.ts` |
| "Is this license valid?"    | `apps/desktop/electron/license/license-gate.ts`    |
| Encrypted license storage   | `apps/desktop/electron/license/license-store.ts`   |
| Activation UI               | `apps/web-editor/src/license/LicenseGate.tsx`      |

## Notes and gotchas

- **Test and live are separate worlds.** Products, keys, customers, and API keys do
  not cross over. A test key will never validate against the live API.
- **Pricing has two sources and one winner.** `pricing.ts` holds typed fallback
  prices; the build-time fetch overrides them with the real Dodo price. Change the
  price in the Dodo dashboard, then rebuild the site — don't hand-edit a number in
  two places.
- **Webhooks are not used.** Dodo issues and emails the key, and the app verifies
  it directly, so nothing here needs a receiver. If you later add one (for example
  to keep your own record of purchases), verify the signature with
  `DODO_PAYMENTS_WEBHOOK_KEY` — the variable is already reserved in `.env.example`.
- **The paywall is off until it is configured.** No `FRAMEPILOT_DODO_PRODUCT_ID`
  means the gate reports valid, so dev builds, CI, and the browser build all run.
  This is deliberate, and it is why step 5.5 matters.
