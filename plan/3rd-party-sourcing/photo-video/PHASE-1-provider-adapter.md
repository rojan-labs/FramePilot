# Phase 1 — The Pexels adapter — `[ ]`

> **Ships:** normalized photo and video search results, proven against the real API.
> **Does not ship:** any UI. Nothing user-visible in this phase.
> **Depends on:** Phase 0 (the key, and the quota store this feeds).

---

## P1.1 — Shared error union (do this first, or decide not to)

**New:** `packages/ai-sdk/src/providers/provider-errors.ts`.
**Touch:** `packages/ai-sdk/src/providers/music-types.ts`.

Nine of the twelve stock error arms are byte-identical to `MusicErrorCode`, including their
user-facing sentences (`music-types.ts:40-91`). A second concrete consumer now exists, so the
`product-discipline.mdc` §5 bar for generalizing is **met** — this is the earned abstraction,
not the speculative one.

Extract the shared codes and `providerErrorSentence()` into `provider-errors.ts`; redefine
`MusicErrorCode` and `StockErrorCode` as narrowed unions over it; keep
`musicErrorMessage()`/`MusicProviderError` exported at their current paths so no call site
moves. The 32 adapter tests and 25 service tests from the music slice are the regression net.

> **Stop condition.** If this stops being a mechanical move — if sentences need to diverge per
> provider, or the narrowing fights the existing `switch` exhaustiveness — **abandon it and
> duplicate the union in `stock-types.ts` instead.** A shared abstraction is not worth
> destabilizing a shipped feature. This note exists so the fallback is a decision rather than
> a retreat, and whichever way it goes gets one line in the ADR.

---

## P1.2 — Types

**New:** `packages/ai-sdk/src/providers/stock-types.ts`.

Everything in `CONTRACTS.md` §1: `STOCK_PROVIDER_NAMES`, `STOCK_MEDIA_KINDS`,
`StockVariantSchema`, `StockItemSchema`, `StockSearchQuery`, `StockSearchPage`,
`StockProvider`, `createStockProvider`, plus the constants:

```ts
export const STOCK_SEARCH_MAX_LIMIT = 80; // the provider's own per_page ceiling
export const STOCK_SEARCH_TIMEOUT_MS = 10_000;
export const STOCK_THUMBNAIL_TIMEOUT_MS = 15_000;
export const STOCK_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const STOCK_DOWNLOAD_STALL_MS = 30_000;
```

Reuse `isHttpsUrl` from `music-types.ts` — already exported, already generic, already tested.
Do not write a second one.

---

## P1.3 — `chooseVariant`

**New:** exported from `stock-types.ts`, per `CONTRACTS.md` §1.

Its own function with its own tests because it is the difference between a 6 MB and a 400 MB
download, and because "always take the biggest" is the mistake it exists to prevent.

**Tests:** exact-height match wins; the smallest variant ≥ target wins over larger ones; fps
tie-break; nothing ≥ target falls back to the largest and is reported as such; a single-variant
list; photos over `src` sizes with `original` as the top rung; an empty list is a type error,
not a runtime one (`.min(1)` on the schema).

---

## P1.4 — The adapter

**New:** `packages/ai-sdk/src/providers/pexels-stock.ts`.

Copy the structure of `openverse-music.ts`: a documented header explaining what the adapter
refuses and why, Zod at the boundary, injectable `fetch`, scoped logging via
`createLogger('ai-sdk:stock-provider')`.

**Two endpoints, one adapter, two response parsers** — the photo and video shapes are
genuinely different (`PEXELS-API.md` §2) and pretending otherwise with a union parser makes
both harder to read. One `search()` that dispatches on `query.kind`.

Requirements:

- `Authorization: <API_KEY>` — **no `Bearer` prefix.** Pin the exact header shape in a test;
  getting this wrong yields a 401 that looks like a bad key.
- Zod-parse the response. Unknown fields are ignored; **a result missing a required field is
  dropped, not defaulted** — a photo with no `src.large2x` is one fewer result, whereas a
  faked URL is a broken download later.
- Normalize into `StockItem`: `alt` → `title` (falling back to a derived label, since Pexels
  `alt` is sometimes empty), `duration` (already seconds) → `durationSeconds` for videos and
  **undefined for photos**, `video_files[]` / `src{}` → `variants[]`, `avg_color` → `avgColor`,
  `photographer`/`user.name` → `creator`.
- Build `attribution` as `Photo by <name> on Pexels` / `Video by <name> on Pexels`, and set
  **`attributionRequired: false`** — README §D4 explains why that is the honest value and not
  the lazy one. Put a comment saying so at the assignment; this is the field a future agent
  will be tempted to "fix".
- Reject any non-`https:` URL — thumbnail, preview, or variant. Main fetches these, so an
  `http:` or `file:` URL is a real problem, not a cosmetic one.
- Cap `limit` at `STOCK_SEARCH_MAX_LIMIT`; the provider's own max is 80.
- Do **not** follow `next_page` verbatim. Report `hasMore` and let the caller pass `page + 1`
  — a provider-supplied URL is untrusted input like everything else.
- **Return the quota observation with the page** (`StockSearchPage.quota`), parsed by
  `parseQuotaHeaders` from Phase 0. The adapter observes; the store decides.
- Map transport and status failures onto `StockErrorCode` per `CONTRACTS.md` §4 — including
  the `rate_limited` vs `quota_exhausted` split, which is decided by whether the observed
  `remaining` is 0.
- **Never log the key, and never log a variant URL** (AGENTS.md §7). Pexels CDN links can
  carry signing parameters.

**Tests** — recorded fixture responses + injected `fetch`, **no live network in CI**:

normal photo results · normal video results · empty results · 401 · 429 with `Retry-After` ·
429 without · 429 with `remaining: 0` → `quota_exhausted` · 5xx · timeout · malformed JSON ·
a photo missing `src` sizes (dropped) · a video with one variant · a video with six variants
at mixed fps · a non-https URL rejected · `alt` empty → derived title · quota headers parsed
onto the page · **quota headers absent → `quota` undefined, and the search still succeeds** ·
the `Authorization` header has no `Bearer` prefix.

**The fixtures must be verbatim live responses**, captured with a real key and the key
scrubbed — the same discipline `openverse-music.ts` used, and the reason its adapter was
right the first time. Record the answers to `PEXELS-API.md` §5's five open questions while
capturing them, and update that file in the same PR.

---

## P1.5 — Search handler and cache in main

**New:** `apps/desktop/electron/media/stock-search.ts`.
**Touch:** `main.ts`, `ipc/contract.ts`, `preload.cts`.

- `framepilot:stock:search` and `framepilot:stock:thumbnail` (`CONTRACTS.md` §2).
- Main holds the key and does the fetching. **The renderer never receives a provider URL** —
  `StockItemWire` strips `url` from every variant while keeping dimensions and bytes, so the
  panel can show "1920×1080 · 24 MB" without being able to fetch it.
- Thumbnails return bytes; the renderer wraps them in `blob:`, which `img-src`/`media-src`
  already permit. **No CSP change.** A proposal to add `api.pexels.com` or `images.pexels.com`
  to `connect-src` means the slice is wrong — stop and re-read `README.md` §4.
- Search cache per `CONTRACTS.md` §7 (5 min TTL, 50 entries, keyed on
  `text + kind + page + orientation`). Thumbnail LRU ~40 MB.
- **Every response's headers go to the `StockQuotaStore`**, including error responses. One
  choke point — a request that bypasses it makes the Settings readout lie.
- Both honour an `AbortSignal`; a superseded search is cancelled, not merely ignored.
- `no_key` is returned **without a network call** when `resolvePexelsApiKey()` is undefined.

**Tests:** cache hit avoids a second provider call **and does not touch the quota store** (a
cached result spent no request, so it must not move the meter); abort cancels in flight; every
`StockErrorCode` arm maps to its wire error; a 429 sets `hourly_limited`; **explicit assertions
that no wire payload contains a variant `url`, a thumbnail URL, or the key.**

---

## Definition of done

- [ ] Search returns normalized photo and video results from the **real** API, and the
      committed fixtures are those responses verbatim
- [ ] `chooseVariant` picks the right rendition for 1080p and 4K projects, tested
- [ ] `PEXELS-API.md` §5's five open questions are answered in that file
- [ ] Quota observations flow from every response into the Phase 0 store; cached hits do not
- [ ] No provider URL and no key crosses the preload bridge (asserted)
- [ ] `api.pexels.com` absent from the renderer's `connect-src` — asserted by
      `media-protocol.test.ts`, which already pins the exact directive contents
- [ ] The `provider-errors.ts` extraction either landed cleanly with the music suite green, or
      was abandoned for the duplicated union — **and the ADR says which**
- [ ] Rebuild the ai-sdk dist: web-editor and desktop import from built `dist`, so an
      un-rebuilt package means testing stale code
- [ ] typecheck / lint / unit green across ai-sdk, shared-types, desktop
