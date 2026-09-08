# ADR 0177 — Payments and licensing move to Dodo Payments

- **Status:** Accepted
- **Date:** 2026-09-08
- **Supersedes:** the payment-provider half of ADR 0036 (marketing website and
  Freemius licensing) and the checkout-env half of ADR 0037 (license encryption
  and checkout env). The encryption-at-rest decision in ADR 0037 stands unchanged.

## Context

FramePilot is a 100%-paid desktop app. Since ADR 0036 the buy flow was:
pay on the website through the Freemius checkout overlay → Freemius emails a
license key → the user pastes it into the desktop app → the app activates the key
against Freemius' public endpoints and re-checks it periodically.

We are moving the merchant of record to **Dodo Payments** before launch. The
product has not shipped, so there are no issued keys, installs, or subscriptions
to migrate — this is a replacement, not a migration, and nothing needs a
compatibility path.

The shape of the problem is unchanged, and it constrains the answer:

1. The **website is a static export** (`output: 'export'`) with no server runtime.
   Whatever we use for checkout must work with zero server-side code.
2. The **desktop app must not ship a merchant secret.** Anything in an Electron
   asar is readable.
3. Licensing must **tolerate being offline.** An editor that locks a paying
   customer out of their own footage on a flaky connection is a broken editor.

## Decision

**Checkout is a static payment link.** The buy CTA links to Dodo's hosted
checkout, `https://checkout.dodopayments.com/buy/{productId}`, with the product id
for the cadence the visitor picked and a `redirect_url` back to `/thank-you/`.

We deliberately did **not** use Dodo's overlay or inline checkout. Both require a
server route to mint a Checkout Session — the session API takes a merchant API key
and must never be called from a browser — and the site has no server. A static
link also removes a third-party script from the critical path: nothing for an ad
blocker to break, and the CTA behaves like a real link (middle-click, new tab,
copy address). The one remaining failure — a build with no product id — is
surfaced as a visible message instead of a dead click.

Because a Dodo product carries exactly one recurring price, the monthly and annual
plans are **two products**, not one plan with two prices. The pricing toggle picks
the product id; the build-time price fetch reads both.

**Verification uses Dodo's public license endpoints.** `POST /licenses/activate`,
`/validate`, and `/deactivate` authenticate with the license key itself, so the
desktop app carries no merchant credential — the same property the Freemius
integration had, and the reason we keep verification in the main process.

**Validity is grace-window based, not expiry based.** This is the one real change
in behaviour. Freemius returned an `expiration`, so a lifetime key could be
trusted indefinitely offline while a subscription was checked against its date.
Dodo answers one question — `valid: true | false` — and reports no expiry:
a subscription key's validity _follows the subscription_, and Dodo flips it when
the subscription is put on hold, cancelled, or reaches the end of its term.

So the app cannot reason about dates locally. A cached "valid" is trusted only
inside a **30-day offline grace window** from the last successful validation, with
re-validation attempted daily whenever the app is online. Beyond the window the
gate asks the user to reconnect. An authoritative `valid: false` (or a 403/404)
closes the gate immediately, with no grace.

Deactivation now calls Dodo first, so the customer's activation slot is released
before the local record is cleared. A failed remote call never blocks the local
sign-out — the user asked to sign this machine out, and Dodo's activation limit is
a support problem, not a reason to refuse.

## Consequences

- A genuinely disconnected machine stops at 30 days rather than running forever on
  a lifetime key. That is strictly more correct: under Dodo there is no such thing
  as a key we can verify once and trust forever, and the alternative is that a
  cancelled subscription keeps working offline indefinitely.
- Enforcement is still switched on by configuration: `FRAMEPILOT_DODO_PRODUCT_ID`
  replaces `FRAMEPILOT_FREEMIUS_PRODUCT_ID`. An unconfigured build (dev, CI, the
  browser build) runs unlocked, unchanged.
- Activation limits are now a user-visible failure mode. The client maps Dodo's
  `422` to a message that says what to do ("deactivate another device first"), and
  the activation instance is named after the machine so the customer can tell their
  devices apart.
- The license record on disk changed shape (`deviceId` + `instanceId` replace the
  Freemius `uid` + install id/token). It stays encrypted with Electron
  `safeStorage` exactly as ADR 0037 specified; a record that cannot be decrypted
  still fails closed.
- Webhooks are **not** part of this decision. Dodo issues and emails the key
  itself, and the desktop app verifies it directly, so there is no server in the
  loop to receive events. Adding one would mean adding a service to run, monitor,
  and secure for no capability we currently need.

## Alternatives considered

- **Overlay/inline checkout with a serverless session route.** Better-branded
  checkout, but it means giving the marketing site a server runtime and an API key
  to protect, to remove one navigation. Rejected as an unfavourable trade for a
  static content site.
- **A licensing server of our own** in front of Dodo, so the app talks to us and we
  talk to Dodo. It would let us cache, add our own expiry, and revoke instantly —
  and it adds a service that must be up for anyone to open the editor. Rejected:
  a local-first editor should not need our uptime to start.
