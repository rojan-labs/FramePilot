# ADR 0036 — Marketing website + Freemius licensing (100%-paid app)

- **Status:** Accepted
- **Date:** 2026-07-03
- **Supersedes / relates to:** ADR 0023 (IPC contract), ADR 0025 (Electron
  hardening), ADR 0028/0029 (dark design system).

## Context

FramePilot was a complete product with no way for a user to **discover, buy, or
download** it, and no runtime license enforcement (the "license gate" in
`plan/PLAN.md` was only a CI dependency-license scanner). FramePilot is a
**100%-paid** application: it needs a public marketing site that sells a
subscription, and the desktop app must require a valid subscription license to run.

### Pricing model — subscription

FramePilot is sold as a **subscription**, not a one-time purchase:

- **$25 / month**, or **$199 / year** (≈ $16.58/mo, a ~34% saving) billed annually.
- Both cadences unlock the entire product; there is no feature-gating between
  tiers. A separate **Studio** (contact-sales) plan covers volume/agency needs.
- The website pricing UI has a Monthly/Annual toggle; the "Save N%" badge is
  **computed from the real prices** (0% ⇒ hidden) so a discount is never faked.
- The Freemius Checkout overlay is opened with `billing_cycle: 'monthly' | 'annual'`.

## Decision

Two additions, both new and self-contained.

### 1. `apps/website` — a statically-exported Next.js marketing site

- **Next.js 15 App Router, `output: 'export'`.** The site is pure marketing/content
  with no server runtime, so a static export deploys anywhere and has zero attack
  surface. All "dynamic" outputs (OG image, sitemap, robots, RSS, blog) are
  generated at build time.
- **Dark design system reused from the app.** Tokens are ported verbatim from
  `DESIGN_SYSTEM.md`/`styles.css` into a Tailwind v4 `@theme` so the site and
  product read as one brand (Notion/Linear/Cursor: layered near-black surfaces,
  a single Cursor-blue accent, opacity-tier text, hairline borders).
- **No sign-in / no accounts.** Purchase = a **Freemius Checkout overlay** that
  issues a license key. The user pastes that key into the desktop app.
- **Content:** landing (announcement bar → hero → integrations → features →
  how-it-works → demo → pricing → FAQ → CTA), `/pricing`, markdown `/blog`
  (SEO-researched seed posts), `/download`, `/docs`, `/thank-you`, legal pages.
- **Pricing is never hand-faked.** A build step (`scripts/fetch-pricing.ts`)
  fetches the live **monthly + annual** plan prices from the Freemius API into
  `pricing.generated.ts`; a typed fallback (`lib/pricing.ts`, $25/mo · $199/yr)
  keeps builds green offline. Enforcement of "everything real" is thus a data
  pipeline, not a habit; the JSON-LD `AggregateOffer` is fed from the same prices.
- **Docs are first-class content, not link-outs.** `/docs` is a real
  documentation site: authored markdown in `content/docs/*.mdx` rendered at build
  time via the same remark→rehype pipeline as the blog (no runtime MDX → no
  multiple-React-copy problem), with a grouped sidebar, scroll-spy table of
  contents, and prev/next. Frontmatter (`category`/`order`) drives the nav.
- **Motion is dependency-free.** The "3D / premium" feel (an ambient aurora
  `<canvas>`, a perspective **tilt** on the product shot, pointer **spotlight**
  cards, and scroll **reveal**) is hand-built client islands — no three.js/R3F —
  so the static export stays lean and every effect honours `prefers-reduced-motion`.
- **OG/icons:** a standalone `scripts/generate-og.ts` (resvg + system fonts, fully
  offline) renders the OG card, favicons, PWA icons, and `favicon.ico` into
  `public/`. SEO is first-class: per-page `Metadata`, JSON-LD
  (SoftwareApplication/FAQ/Article), sitemap, robots, RSS.

### 2. Freemius license gate in the Electron app

Greenfield, mirroring the existing `AiConfigStore` secret-store pattern and the
injectable-`net.fetch` HTTP-client convention. **No project-schema change, no new
dependency** (built-in `crypto` + `electron.net.fetch`).

- **Main process** (`apps/desktop/electron/license/`): `license-store.ts`
  (plaintext `license.json` in `userData`, stable device `uid`),
  `freemius-client.ts` (public `activate`/`validate` endpoints, injectable fetch),
  `license-gate.ts` (pure decision incl. **offline grace**), `license-service.ts`
  (orchestration + the enforcement rule).
- **Enforcement rule:** the paywall is active **only when a Freemius product id is
  configured** (`FRAMEPILOT_FREEMIUS_PRODUCT_ID`) — an unconfigured/dev build (or
  `FRAMEPILOT_LICENSE_DEV_BYPASS=1`) runs freely. This never bricks dev or the
  test suite, yet a packaged production build (which sets the id) is fully gated.
- **IPC:** three channels (`framepilot:license:{status,activate,deactivate}`) added
  to the single-source contract (`contract.ts` + `preload.cts` +
  `shared-types/ipc.ts` `FramePilotBridge`). **The key/token never cross the
  bridge** — only a `LicenseStatus` projection (masked key + booleans) does.
- **Renderer gate:** `LicenseGate` wraps `<App/>`. No bridge (browser/dev/tests) →
  bypass; `valid` → editor; otherwise a dark activation card (paste key → activate,
  with a buy link). **Defense-in-depth:** the AI and render/export IPC handlers
  refuse when unlicensed, so a tampered renderer can't reach them.

## Alternatives considered

- **Vite SPA / Astro for the site.** Rejected: Next.js App Router gives the best
  SEO + native OG images + MDX-style content for a conversion-focused site.
- **A separate weaker "AI/license API".** Rejected: the license value crosses the
  same audited IPC contract; the key stays in main exactly like AI keys.
- **DRM-style hardening.** ~~Out of scope. The plaintext store matches the existing
  trust model (same as `ai-config.json`); this is licensing convenience, not DRM.~~
  **Superseded by ADR 0037:** the plaintext store let anyone forge `isValid: true`,
  so `license.json` is now `safeStorage`-encrypted and forged/tampered records fail
  closed. (Full DRM / anti-asar-repack is still out of scope.)
- **Freemius SDK dependency (desktop).** Rejected: the activate/validate endpoints
  are public and need only the product id, so we call them directly — same
  rationale as calling the Anthropic API without its SDK (ADR 0012).

## Consequences

- A visitor can subscribe (monthly/annual) → receive a key → activate the app on
  first launch. A lapsed/cancelled subscription surfaces a dedicated **renew**
  screen in the desktop gate (masked key + end date + renew CTA), while still
  letting a different key be entered.
- Offline users keep working within a 7-day grace window; an authoritative
  Freemius cancellation invalidates when the paid period ends (then renew).
- New env vars (documented in `docs/guides/website-and-licensing.md`). Secret keys
  never enter any client bundle (website checkout uses only the public key).
- The Freemius dashboard must configure a **monthly and an annual price** on the
  paid plan; `scripts/fetch-pricing.ts` reads both cadences.
- Test totals: desktop **161** license/etc., web-editor LicenseGate **6**
  (adds the renew-state test), website **12** (pricing now covers billing-cycle
  selection, effective-monthly, and honest annual-savings math). No schema change,
  no new dependency (site 3D + docs are hand-built, dependency-free).
