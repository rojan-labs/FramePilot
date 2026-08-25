# Contracts — stock photo & video sourcing

> Typed surfaces this plan introduces. Written before implementation so the phases agree on
> shapes. Sketches, not final code — any divergence during implementation is justified in the
> phase file, not drifted into.
>
> **Read [`../CONTRACTS.md`](../CONTRACTS.md) first.** This document deliberately mirrors it;
> where it says nothing, the music contract still applies.

---

## 1. Provider abstraction

Location: `packages/ai-sdk/src/providers/stock-types.ts` + `pexels-stock.ts`.

Modelled on `music-types.ts` / `openverse-music.ts`. **One adapter, a named union, no
registry** (`product-discipline.mdc` §5).

```ts
export const STOCK_PROVIDER_NAMES = ['pexels'] as const;
export type StockProviderName = (typeof STOCK_PROVIDER_NAMES)[number];

/** What the user is looking for. Two kinds, one provider, one panel. */
export const STOCK_MEDIA_KINDS = ['photo', 'video'] as const;
export type StockMediaKind = (typeof STOCK_MEDIA_KINDS)[number];

/** One downloadable rendition of a result. Videos have several; photos have several sizes. */
export const StockVariantSchema = z.object({
  /** Provider-local variant id where one exists, else a derived stable key. */
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Frames per second. Absent for photos. */
  fps: z.number().positive().optional(),
  /** e.g. 'video/mp4' | 'image/jpeg'. */
  contentType: z.string().min(1),
  /** Extension for the on-disk filename, e.g. 'mp4' | 'jpg'. */
  format: z.string().min(1),
  /** https-only. Main fetches it; the renderer never sees the host. */
  url: z.string().url(),
  /** Bytes, when the provider states it. Absent means "unknown until Content-Length". */
  approxBytes: z.number().int().positive().optional(),
});
export type StockVariant = z.infer<typeof StockVariantSchema>;

export const StockItemSchema = z.object({
  remoteId: z.string().min(1),
  provider: z.enum(STOCK_PROVIDER_NAMES),
  kind: z.enum(STOCK_MEDIA_KINDS),
  /** Provider `alt` where supplied, else a derived label. Rendered as TEXT, never markup. */
  title: z.string().min(1),
  /** Native dimensions of the item, for aspect-ratio-correct grid tiles before load. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Seconds. Videos only — a photo has no duration, and must not be given a fake one. */
  durationSeconds: z.number().positive().optional(),
  /** Provider-supplied average colour, used as the tile placeholder. e.g. '#6a8fbf'. */
  avgColor: z.string().optional(),
  /** Small still for the grid tile. Main fetches; renderer gets bytes → blob:. */
  thumbnailUrl: z.string().url(),
  /** Videos: a short/low-res rendition for hover preview. Photos: reuse the thumbnail. */
  previewUrl: z.string().url().optional(),
  /** Every downloadable rendition, so variant choice is a decision, not a guess. */
  variants: z.array(StockVariantSchema).min(1),

  // --- Provenance. Carried verbatim into `Asset.source` (schema v20). ---
  license: z.string().min(1), // e.g. 'pexels'
  licenseUrl: z.string().optional(),
  /**
   * FALSE for Pexels: the CONTENT licence obliges the end user to credit nobody.
   * The API guidelines' "prominent link to Pexels" binds the APP, not the video,
   * and is discharged by the panel (README §D4). Do not set this true to be safe —
   * a badge that cries wolf is what makes the CC-BY music badge get ignored.
   */
  attributionRequired: z.boolean(),
  /** Ready-to-paste courtesy credit, e.g. 'Photo by Jane Doe on Pexels'. */
  attribution: z.string().optional(),
  creator: z.string().optional(),
  creatorUrl: z.string().optional(),
  /** Landing page on the provider. */
  sourceUrl: z.string().optional(),
});
export type StockItem = z.infer<typeof StockItemSchema>;

export interface StockSearchQuery {
  readonly text: string;
  readonly kind: StockMediaKind;
  readonly limit: number;
  /** 1-based. `load more` increments it; there is no infinite scroll. */
  readonly page: number;
  readonly orientation?: 'landscape' | 'portrait' | 'square';
}

export interface StockSearchPage {
  readonly items: readonly StockItem[];
  readonly page: number;
  readonly totalResults: number;
  readonly hasMore: boolean;
  /** Observed on this very response. Undefined when the provider sent no headers. */
  readonly quota?: StockQuotaObservation;
}

export interface StockProvider {
  readonly name: StockProviderName;
  search(query: StockSearchQuery, signal?: AbortSignal): Promise<StockSearchPage>;
}

/** `fetch` is injected so the adapter unit-tests offline against recorded fixtures. */
export function createStockProvider(
  name: StockProviderName,
  config: { readonly apiKey: string },
  fetchImpl?: typeof fetch,
): StockProvider;
```

**Normalization is the adapter's whole job**, same as for music: duration units, the two
different meanings of `size` across the photo and video endpoints, and the shape of
`video_files` all die at this boundary. Nothing downstream branches on provider identity.

**All provider input is untrusted.** Zod at the boundary. `title`/`alt` renders as text, never
markup. Every URL is scheme-checked `https:` before main fetches it (reuse `isHttpsUrl` from
`music-types.ts` — it is already exported and generic). `width`/`height`/`durationSeconds` are
range-checked before anything reaches a patch builder.

### Variant selection — a stated rule, not a heuristic buried in the adapter

Exported and unit-tested separately, because it is the difference between a 6 MB and a 400 MB
download:

```ts
export function chooseVariant(
  variants: readonly StockVariant[],
  target: { readonly height: number; readonly fps?: number },
): StockVariant;
```

- Prefer the **smallest variant whose height ≥ the project's height** — enough resolution to
  survive a punch-in, no more.
- Among equal-height candidates, prefer the fps nearest the project's.
- If none reaches the project height, take the **largest available** and let the panel say
  so ("Highest available is 1280×720 — smaller than this project").
- Photos: the same rule over `src` sizes, treating `original` as the top rung.

Never "always `original`". Never "always `hd`" — `quality: 'hd'` in the Pexels response covers
everything from 720p to 4K.

---

## 2. IPC surface

Channel names follow `apps/desktop/electron/ipc/contract.ts`
(`framepilot:<domain>:<verb>`), added to `IpcChannels`, the preload bridge, and
`RendererBridge` in `packages/shared-types/src/ipc.ts`. All are **optional** on the bridge
(`?:`) so the browser build type-checks and degrades via `isDesktop()`.

```
framepilot:stock:search             → StockSearchResult
framepilot:stock:thumbnail          → StockBytesResult       (grid tile / hover preview bytes)
framepilot:stock:download           → StockDownloadStartResult
framepilot:stock:download-cancel    → void
framepilot:stock:download-progress  → StockDownloadProgressWire   (main → renderer event)
framepilot:stock:quota              → StockQuotaSnapshot     (read the last observation)
framepilot:stock:quota-changed      → StockQuotaSnapshot     (main → renderer event)
```

```ts
export type StockItemWire = Omit<StockItem, 'thumbnailUrl' | 'previewUrl' | 'variants'> & {
  /** Renderer-safe variant summary: dimensions and size, but NO url. */
  readonly variants: readonly Omit<StockVariant, 'url'>[];
};

export type StockSearchResult =
  | {
      readonly ok: true;
      readonly items: readonly StockItemWire[];
      readonly page: number;
      readonly totalResults: number;
      readonly hasMore: boolean;
    }
  | { readonly ok: false; readonly error: StockErrorCode; readonly detail?: string };

export type StockBytesResult =
  | { readonly ok: true; readonly contentType: string; readonly data: ArrayBuffer }
  | { readonly ok: false; readonly error: StockErrorCode; readonly detail?: string };

/** Mirrors MusicDownloadProgressWire (`packages/shared-types/src/ipc.ts`). */
export interface StockDownloadProgressWire {
  readonly operationId: string;
  readonly remoteId: string;
  readonly phase: 'downloading' | 'deriving' | 'installed' | 'cancelled' | 'failed';
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly errorCode?: StockErrorCode;
  readonly detail?: string;
}
```

**No provider URL crosses to the renderer.** The renderer addresses items by
`remoteId` + `variantId` and asks main to act — the same property that makes the music slice's
CSP guarantee structural rather than conventional. This is why `StockItemWire` strips `url`
from each variant while keeping its dimensions: the panel needs to _show_ "1920×1080 · 24 MB",
it never needs to _fetch_ it.

### Key custody

Stored in `apps/desktop/electron/ai/ai-config.ts` as a **write-only** field, following the
chat-key precedent (`packages/shared-types/src/ipc.ts:438`) — **not** the renderer-readable
`twelveLabs` / `asrApiKey` precedent, which is readable only because the renderer forwards
those to the sidecar. Nothing forwards this one.

- `StoredConfig` gains `pexelsApiKey?: string`.
- `resolvePexelsApiKey()` mirrors `resolveAsrApiKey()` (`ai-config.ts:310`), env fallback
  `PEXELS_API_KEY`.
- `toAiConfig()` exposes **`pexelsReady: boolean` and never the key**. There is an existing
  test in `ai-config.test.ts` asserting `toAiConfig()` never returns a chat key; extend it.
- `applyUpdate` logs a **presence check**, never the value — CodeQL alert #61 (clear-text
  logging) is already called out in that file at line 376, and the same rule applies here.
- Same change adds `PEXELS_API_KEY` to root `.env.example` **and** `turbo.json` `globalEnv`.
  A var in one but not the other is a bug (CLAUDE.md §2).

---

## 3. Quota contract

**The novel surface in this plan.** Everything else has a music precedent; this does not.

```ts
/** What one provider response told us. Facts only — no interpretation. */
export interface StockQuotaObservation {
  /** `X-Ratelimit-Limit`. The MONTHLY allowance. */
  readonly limit: number;
  /** `X-Ratelimit-Remaining`. */
  readonly remaining: number;
  /** `X-Ratelimit-Reset`, as ISO-8601. When the monthly period rolls over. */
  readonly resetAt: string;
  /** ISO-8601. When WE saw it. Every displayed number is "as of" this. */
  readonly observedAt: string;
}

/** What the renderer receives. The `kind` field is the honesty. */
export type StockQuotaSnapshot =
  /** No key configured — there is no quota to speak of. */
  | { readonly kind: 'no_key' }
  /** Key configured, no request made yet. NOT a guessed 20,000. */
  | { readonly kind: 'unmeasured' }
  /** A real observation. */
  | { readonly kind: 'measured'; readonly monthly: StockQuotaObservation }
  /**
   * A 429 was seen. `monthly` is whatever we last observed and may look healthy —
   * because the hourly cap is NOT in the headers (`PEXELS-API.md` §3). This arm
   * exists so the UI can say "hourly limit" instead of contradicting its own bar.
   */
  | {
      readonly kind: 'hourly_limited';
      readonly monthly?: StockQuotaObservation;
      readonly since: string;
      /** From `Retry-After` when the provider sends one. Never invented. */
      readonly retryAfterSeconds?: number;
    };
```

**Ownership.** Main. One `StockQuotaStore`
(`apps/desktop/electron/media/stock-quota.ts`), persisted atomically to
`<userData>/stock-quota.json` so reopening the app does not blank the readout until the user
searches. It is **observed telemetry, not configuration** — hence its own file rather than a
field in `ai-config.json`.

**Rules, each of which is a test:**

1. Every provider response passes through the store — search **and** any metered download.
   One choke point; a request that bypasses it makes the readout lie.
2. The store **only ever moves forward in observation time**. A late-arriving response from a
   slower request must not overwrite a newer observation with staler numbers.
3. `remaining` is never decremented locally as a guess. It is only ever set from a header. A
   client-side counter and a server-side counter will disagree, and the wrong one will be on
   screen.
4. A `429` sets `hourly_limited` and **preserves** the last `monthly` observation rather than
   discarding it.
5. Clearing the key resets to `no_key` and **deletes the persisted file** — a stale quota for
   a key you no longer have is noise at best.
6. `resetAt` is stored as ISO-8601, converted from the provider's UNIX timestamp exactly once,
   at the adapter boundary. Timezone rendering is the renderer's problem, not the store's.

---

## 4. Error taxonomy

One closed union. Every arm maps to a specific user-facing sentence — no generic "something
went wrong" (AGENTS.md §7).

```ts
export const STOCK_ERROR_CODES = [
  'no_key',
  'unauthorized',
  'rate_limited',
  'quota_exhausted',
  'provider_unavailable',
  'offline',
  'timeout',
  'cancelled',
  'too_large',
  'disk_full',
  'download_failed',
  'derive_failed',
] as const;
```

| Code                   | Cause                                 | User sees                                                                                                     |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `no_key`               | No Pexels key configured              | "Add your Pexels API key in Settings to search." + link                                                       |
| `unauthorized`         | 401/403                               | "Pexels rejected this key. Check it in Settings."                                                             |
| `rate_limited`         | 429                                   | "You've hit the hourly limit of about 200 requests. It clears within the hour." (+ retry-after when supplied) |
| `quota_exhausted`      | 429 **and** observed `remaining` is 0 | "You've used this month's 20,000 requests. Resets <date>."                                                    |
| `provider_unavailable` | 5xx                                   | "Pexels is not responding. Try again shortly."                                                                |
| `offline`              | Transport failure                     | "No network connection."                                                                                      |
| `timeout`              | Hard request timeout                  | "Pexels took too long to answer."                                                                             |
| `cancelled`            | User cancelled                        | No error UI — return to idle                                                                                  |
| `too_large`            | Chosen variant exceeds the size cap   | "That file is <n> GB — larger than the 2 GB limit. Pick a smaller size."                                      |
| `disk_full`            | ENOSPC during write                   | "Not enough disk space to save this file."                                                                    |
| `download_failed`      | Truncated / `Content-Length` mismatch | "The download didn't finish. Nothing was added."                                                              |
| `derive_failed`        | `/asset-media` failed                 | "Saved the file, but couldn't read its thumbnails." (asset still added)                                       |

`rate_limited` and `quota_exhausted` are **two arms, not one**, for the reason in §3: they
need different sentences and different remedies (wait an hour vs wait until next month), and
collapsing them is the specific failure mode this plan is trying to avoid.

**Shared arms with music.** Nine of these twelve are identical to `MusicErrorCode`. That is a
second concrete consumer, so the `product-discipline.mdc` §5 test for generalizing is now
**met**: extract the shared arms and their sentences into
`packages/ai-sdk/src/providers/provider-errors.ts`, and define `MusicErrorCode` and
`StockErrorCode` as narrowed unions over it. The music suite is the regression net.
**If that refactor turns out to be more than a mechanical move, stop and duplicate the union
instead** — a shared abstraction is not worth destabilizing a shipped feature, and this note
exists so the fallback is a decision rather than a retreat.

**Retry/backoff.** Search retries **once** on `provider_unavailable`/`timeout` with jittered
backoff; never on `unauthorized`/`rate_limited`/`quota_exhausted`. Downloads never auto-retry
— a silent retry on a metered API spends the user's quota without consent.

**Timeouts.** Search 10 s. Thumbnail 15 s. Download has no wall-clock cap but must show
progress; no bytes for 30 s fails as `timeout`.

**Size cap.** `STOCK_MAX_DOWNLOAD_BYTES = 2 GB`, checked against `Content-Length` **before**
the first byte is written, and again as a running total (a lying `Content-Length` must not be
able to fill the disk).

---

## 5. UI state matrix

Every state is a real render path with a test. "Unbuilt" states are how this ships as a demo
instead of a feature (`product-discipline.mdc` §4).

### Stock panel

| State                       | Behaviour                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No key configured           | Panel explains it and links to Settings. **Not an error toast** — it is the expected first-run state.                                                                                                                                              |
| Default / empty             | Browses the provider's own feed (`/v1/curated`, `/videos/popular`). Labelled by the grid's accessible name, **not** by a line of prose above it: search, kind and the Pexels credit share one control row, and everything below that row is tiles. |
| Photos / Videos             | A select in the control row, not a segmented pair — the sidebar has room for one control, not two. Switching kinds re-searches; it does not clear the query.                                                                                       |
| Typing                      | Debounced 300 ms. Previous results stay visible and dimmed — never cleared on keystroke.                                                                                                                                                           |
| Loading (first search)      | Skeleton tiles **at the aspect ratio of a real tile**, so nothing shifts when results land.                                                                                                                                                        |
| Tile placeholder            | `avg_color` fill until the thumbnail blob resolves. The provider sent it; use it.                                                                                                                                                                  |
| No results                  | "No <photos/videos> matched <query>." + a suggestion to broaden.                                                                                                                                                                                   |
| Results                     | Grid. Photo tile: dimensions + photographer. Video tile: duration + best available resolution + photographer.                                                                                                                                      |
| Hover preview (video)       | Plays the low-res preview rendition muted, on hover/focus, **one at a time**. Honours `prefers-reduced-motion`: no autoplay, a play control instead.                                                                                               |
| Preview failed              | Inline on the tile; the rest of the grid stays usable.                                                                                                                                                                                             |
| Load more                   | Explicit button, never infinite scroll — every page is a request the user asked for (`PEXELS-API.md` §3).                                                                                                                                          |
| Quota low (< 10% remaining) | Inline warning strip above the grid, with the reset date and a link to Settings.                                                                                                                                                                   |
| Hourly limited (429)        | Grid stays, search disabled, sentence names the **hourly** cap — not the monthly bar.                                                                                                                                                              |
| Quota exhausted             | Search disabled, sentence names the month and the reset date.                                                                                                                                                                                      |
| Placement blocked           | **The `SUC-P1` state (README §2).** Add is disabled with a stated reason: "There's already footage at the playhead." Never a silent stack.                                                                                                         |
| Downloading                 | Determinate bar + bytes on the tile; Add becomes Cancel. Other tiles stay interactive.                                                                                                                                                             |
| Download failed             | Tile shows the reason + Retry. No partial file, no orphan asset.                                                                                                                                                                                   |
| Download cancelled          | Tile returns to idle. No trace on disk.                                                                                                                                                                                                            |
| Already in project          | Tile shows "In this project"; Add is disabled (dedupe by `remoteId` via `sources.json`).                                                                                                                                                           |
| Offline                     | Search shows `offline`; already-downloaded assets are unaffected.                                                                                                                                                                                  |
| Browser build               | Tab is absent, not present-and-broken (`isDesktop()`).                                                                                                                                                                                             |

### Settings — Stock media section

| State            | Behaviour                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| No key           | Key field, empty. Hint naming what the key is for and that searching sends the query text to Pexels. No quota block. |
| Key saved        | Field shows **"Configured"** with Replace / Clear — the key is write-only, so there is no value to bind (§2).        |
| Quota unmeasured | "Not measured yet — search once to see your quota." Not a zero, not a guessed maximum.                               |
| Quota measured   | `remaining / limit`, a `role="progressbar"` bar, "Resets <absolute local date> · in <relative>", and "as of <time>". |
| Quota low        | Same block, `ai-tone` set to `warning`.                                                                              |
| Hourly limited   | The monthly block **plus** a separate line naming the hourly cap and when it clears.                                 |
| Key rejected     | `unauthorized` sentence next to the field; the quota block reverts to `unmeasured`.                                  |

**Keyboard and assistive technology.** The results grid is **one tab stop with a roving
tabindex**, matching the existing bin grid (`apps/web-editor/src/components/MediaBin.tsx:307`)
and the Sounds panel. Arrows move between tiles, Enter adds, Space previews. The search input
is labelled. Result count and quota-state changes are announced via a **polite** live region
(quota is not an alert; a blocked placement is). Download progress uses `role="progressbar"`
with `aria-valuenow`, announced at coarse intervals. Every icon-only control has an accessible
name. Tiles use the provider's `alt` text as their accessible name.

> **Cross-runtime naming trap** (from `plan/PLAN.md`, learned the hard way): Playwright's
> `getByRole(name)` substring-matches by default while RTL matches exactly. New `aria-label`s
> here must be checked against **both** suites, or a green vitest run will break e2e.

**Styling** uses the existing token-driven `styles.css`, `Button` `[data-variant]`, `ai-tone`
and `ai-progress-track` (ADR 0028). **No new component language, no parallel design system.**

---

## 6. `sources.json` — the download ledger, extended

The music slice already writes `<projectsRoot>/<projectId>/media/sources.json`
(`../CONTRACTS.md` §3). Stock downloads append to the **same file**, with the same purpose:
**dedupe by `provider` + `remoteId` before spending a request.** It is not a second source of
truth for provenance — `Asset.source` is.

Entries gain two optional fields, additively, with `version` staying `1` because readers
tolerate unknown keys and nothing is being reinterpreted:

```json
{
  "fileName": "city-skyline-3129671.mp4",
  "provider": "pexels",
  "remoteId": "3129671",
  "variantId": "1440938",
  "kind": "video",
  "license": "pexels",
  "attributionRequired": false,
  "downloadedAt": "2026-08-24T12:00:00.000Z"
}
```

**Dedupe is by `remoteId` + `variantId`**, not `remoteId` alone: the same clip at 720p and at
1080p are different files and the user may legitimately want the larger one later. Written
atomically (temp + rename), same as media import.

---

## 7. Caching

- **Search results:** in-memory in main, keyed by `normalize(text) + kind + page + orientation`,
  TTL 5 min, bounded to 50 entries. Survives panel remounts so re-opening the tab does not
  spend a request. Not persisted — stale stock results have no value across sessions.
- **Thumbnails:** in-memory LRU, ~40 MB (double the music preview budget; a grid holds many
  more images than a track list holds previews). Re-searching the same query costs zero
  network.
- **Downloads:** deduped against `sources.json` before any bytes are fetched.
- **Quota:** persisted (§3) — the one thing here that _does_ survive a restart, because a
  number the user checks between sessions is exactly the thing that should.

This follows the footage-map cache precedent: **serve the cache first, stay independent of
the remote index.**
