# Contracts — third-party media sourcing

> Typed surfaces this plan introduces. Written before implementation so Phase 1 and Phase 2
> agree on shapes and Phase 3 adds nothing new. Sketches, not final code — but any
> divergence during implementation should be justified in the phase file, not drifted into.

---

## 1. Provider abstraction

Modelled on `packages/ai-sdk/src/providers/asr-types.ts`. **One adapter. A named union, not
a plugin registry.** Generalize only when a second provider actually exists
(`product-discipline.mdc` §5).

Location: `packages/ai-sdk/src/providers/music-types.ts` + one adapter file.

```ts
/** User-facing roster. Settings and new requests derive from this tuple. */
export const MUSIC_PROVIDER_NAMES = ['openverse'] as const;
export type MusicProviderName = (typeof MUSIC_PROVIDER_NAMES)[number];

/** One search result, normalized across providers. */
export interface ProviderTrack {
  /** Provider-local id. Stable — used for download dedupe and `sources.json`. */
  readonly remoteId: string;
  readonly provider: MusicProviderName;
  readonly title: string;
  readonly durationSeconds: number;
  /** Streamable audition URL (main fetches it; the renderer never sees the host). */
  readonly previewUrl: string;
  /** Full-quality download URL. */
  readonly downloadUrl: string;
  /** Container/codec hint for the on-disk filename, e.g. 'mp3' | 'wav' | 'ogg'. */
  readonly format: string;
  /** Licence identifier verbatim from the provider, e.g. 'cc0' | 'cc-by'. */
  readonly license: string;
  /** Canonical licence text URL, so the user can read the actual terms. */
  readonly licenseUrl?: string;
  /**
   * TRUE when the licence obliges the end user to credit someone (D2).
   * These ARE usable — the UI badges them and the project persists the credit
   * (`Asset.source`, schema v20). What is refused is non-commercial-only content.
   */
  readonly attributionRequired: boolean;
  /**
   * TRUE when the licence permits commercial/monetized use. FALSE results are
   * REFUSED, not badged — FramePilot users monetize, and no badge makes an
   * NC track safe in a sponsored video.
   */
  readonly commercialUse: boolean;
  /**
   * Ready-to-paste credit line. Openverse supplies this directly; other adapters
   * assemble it. Persisted verbatim into `Asset.source.attribution`.
   */
  readonly attribution?: string;
  readonly creator?: string;
  readonly creatorUrl?: string;
  /** Landing page for the item on the provider. */
  readonly sourceUrl?: string;
  /** Optional artwork; main streams it to the renderer as a blob. */
  readonly artworkUrl?: string;
}

export interface MusicSearchQuery {
  readonly text: string;
  /** Slice 1: one page only. Pagination is deferred (README §2). */
  readonly limit: number;
}

export interface MusicProvider {
  readonly name: MusicProviderName;
  search(query: MusicSearchQuery, signal?: AbortSignal): Promise<readonly ProviderTrack[]>;
}

/** `fetch` is injected so adapters unit-test offline against recorded fixtures. */
export function createMusicProvider(
  name: MusicProviderName,
  config: { readonly apiKey?: string },
  fetchImpl?: typeof fetch,
): MusicProvider;
```

**Normalization is the adapter's whole job.** Providers differ in duration units (ms vs s),
licence vocabulary, and preview availability. Every field above is normalized at the adapter
boundary so nothing downstream branches on provider identity.

**All provider input is untrusted.** Parse responses through Zod at the adapter boundary,
exactly as tool inputs are (AGENTS.md §6). A title is rendered as text, never as markup; a
`downloadUrl` is scheme-checked (`https:` only) before main fetches it; `durationSeconds` is
range-checked before it reaches `placeAssetPatch`.

---

## 2. IPC surface

Channel names follow `apps/desktop/electron/ipc/contract.ts` (`framepilot:<domain>:<verb>`).
Add to `IpcChannels`, the preload bridge, and `RendererBridge` in
`packages/shared-types/src/ipc.ts`. All four are **optional** on the bridge (`?:`) so the
browser build type-checks and degrades via `isDesktop()`.

```
framepilot:music:search            → MusicSearchResult
framepilot:music:preview           → MusicPreviewResult     (bytes for a blob: URL)
framepilot:music:download          → MusicDownloadStartResult
framepilot:music:download-cancel   → void
framepilot:music:download-progress → MusicDownloadProgressWire  (main → renderer event)
```

```ts
export type MusicSearchResult =
  | { readonly ok: true; readonly tracks: readonly ProviderTrackWire[] }
  | { readonly ok: false; readonly error: MusicErrorCode; readonly detail?: string };

/** Audition bytes. Main fetches; the renderer wraps in a blob: URL (CSP-safe). */
export type MusicPreviewResult =
  | { readonly ok: true; readonly contentType: string; readonly data: ArrayBuffer }
  | { readonly ok: false; readonly error: MusicErrorCode; readonly detail?: string };

/** Mirrors CapabilityPackProgressWire's shape (ipc.ts:1036). */
export interface MusicDownloadProgressWire {
  readonly operationId: string;
  readonly remoteId: string;
  readonly phase: 'downloading' | 'deriving' | 'installed' | 'cancelled' | 'failed';
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly errorCode?: MusicErrorCode;
  readonly detail?: string;
}
```

`ProviderTrackWire` is `ProviderTrack` **minus `previewUrl` and `downloadUrl`**. The renderer
never receives a provider URL — it addresses tracks by `remoteId` and asks main to act. This
is what makes the CSP guarantee structural rather than a convention.

### Key custody

The provider key is stored in `apps/desktop/electron/ai/ai-config.ts` as a **write-only**
field, following the chat-key precedent (`packages/shared-types/src/ipc.ts:438`), **not** the
`twelveLabs`/`asrApiKey` renderer-readable precedent — those are readable only because the
renderer forwards them to the sidecar, which is not the case here. `AiConfig` exposes
`musicProviderReady: boolean`, never the key.

Env fallback `FRAMEPILOT_MUSIC_API_KEY`, resolved by a `resolveMusicApiKey()` method
mirroring `resolveAsrApiKey()` (`ai-config.ts:311`). Same change must add it to root
`.env.example` **and** `turbo.json` `globalEnv` (CLAUDE.md §2).

---

## 3. `sources.json` — download ledger

Written by main into `<projectsRoot>/<projectId>/media/sources.json`. Main-process-owned.

**This is a download ledger, not the provenance record.** Since D2, provenance lives in the
project file as `Asset.source` (schema v20) — that is the single source of truth, and the
Credits view reads it. `sources.json` exists for one narrow job main can do without loading
the project: **dedupe by `remoteId` before spending a request.** Nothing reads it to decide
what renders or what to credit (`product-discipline.mdc` §5).

<!-- prettier-ignore -->
```json
{
  "version": 1,
  "entries": [
    {
      "fileName": "calm_lofi_bed.mp3",
      "provider": "openverse",
      "remoteId": "12345",
      "license": "cc-by",
      "attributionRequired": true,
      "downloadedAt": "2026-08-23T12:00:00.000Z"
    }
  ]
}
```

Written atomically (temp + rename), same as media import.

Deliberately minimal: **just enough to answer "have I already downloaded this?"** without
loading the project. The credit line, licence URL, creator and landing page live in
`Asset.source` and are read by the Credits view. Duplicating them here would create the
second source of truth this file exists to avoid.

---

## 4. Error taxonomy

One closed union. Every arm maps to a specific user-facing sentence — no generic "something
went wrong" (AGENTS.md §7: typed errors with context).

| Code                   | Cause                         | User sees                                                                   |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `no_key`               | No provider key configured    | "Add a music provider key in Settings → AI to search." + link               |
| `unauthorized`         | 401/403                       | "The music provider rejected the key. Check it in Settings."                |
| `rate_limited`         | 429                           | "Too many searches. Try again in a moment." + retry-after when supplied     |
| `provider_unavailable` | 5xx                           | "The music provider is not responding. Try again shortly."                  |
| `offline`              | Transport failure             | "No network connection."                                                    |
| `timeout`              | Hard request timeout          | "The music provider took too long to answer."                               |
| `cancelled`            | User cancelled                | No error UI — return to idle                                                |
| `non_commercial_only`  | Licence forbids monetized use | "This track can't be used in monetized videos." (refused, never downloaded) |
| `disk_full`            | ENOSPC during write           | "Not enough disk space to save this track."                                 |
| `download_failed`      | Truncated/corrupt             | "The download didn't finish. Nothing was added."                            |
| `derive_failed`        | `/asset-media` failed         | "Saved the file, but couldn't read its waveform." (asset still added)       |

**Retry/backoff:** search retries **once** on `provider_unavailable`/`timeout` with jittered
backoff, never on `unauthorized`/`rate_limited`/`non_commercial_only`. Downloads never
auto-retry — the user retries explicitly, because a silent retry on a metered API spends
their quota without consent.

**Timeouts:** search 10 s; preview 15 s; download has no wall-clock cap but must show
progress — a stalled download (no bytes for 30 s) fails as `timeout`.

---

## 5. UI state matrix

Every state below is a real render path with a test. "Unbuilt" states are how this ships as
a demo instead of a feature (`product-discipline.mdc` §4).

| State                       | Behaviour                                                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No key configured           | Panel explains it and links to Settings. **Not an error toast** — it is the expected first-run state.                                                                                  |
| Default / empty             | Short prompt describing what to search for. No spinner.                                                                                                                                |
| Typing                      | Debounced 300 ms. Previous results stay visible and dimmed — they do not clear on keystroke.                                                                                           |
| Loading (first search)      | Skeleton rows **at the height of a real row**, so nothing shifts when results land.                                                                                                    |
| No results                  | "No tracks matched <query>." + a suggestion to broaden.                                                                                                                                |
| Results                     | Title · duration · licence · play/pause · Add. Fixed-height rows.                                                                                                                      |
| Attribution-required result | **Usable.** Row carries a "Credit required" badge naming the creator, linked to the licence text. Adding it records the credit in the project (schema v20) and surfaces it in Credits. |
| CC0 / no-credit result      | Row carries a quieter "No credit needed" badge. Both states are labelled — an unlabelled row would read as "unknown", which is the one thing a licence badge must never be.            |
| Non-commercial-only result  | Filtered out at the adapter, server-side where the provider supports it. Not badged, not shown — see D2.                                                                               |
| Auditioning                 | One track plays at a time; starting another stops the first. Play button becomes pause.                                                                                                |
| Preview loading             | Spinner **on that row's play button only** — the list does not enter a loading state.                                                                                                  |
| Preview failed              | Inline on the row; the rest of the list stays usable.                                                                                                                                  |
| Downloading                 | Determinate bar + bytes on the row; Add becomes Cancel. Other rows stay interactive.                                                                                                   |
| Download failed             | Row shows the reason + Retry. No partial file, no orphan asset.                                                                                                                        |
| Download cancelled          | Row returns to idle. No trace on disk.                                                                                                                                                 |
| Already in project          | Row shows "In this project" and Add is disabled (dedupe by `remoteId` via `sources.json`).                                                                                             |
| Offline                     | Search shows `offline`; already-downloaded assets are unaffected.                                                                                                                      |
| Browser build               | Tab is absent, not present-and-broken (`isDesktop()`).                                                                                                                                 |

**Keyboard and assistive technology.** The results list is **one tab stop with a roving
tabindex**, matching the existing bin grid (`apps/web-editor/src/components/MediaBin.tsx:307`
and its documented pattern) — arrows move between rows, Enter adds, Space auditions. Search
input is labelled. Result count is announced via a polite live region. Download progress
uses `role="progressbar"` with `aria-valuenow`. Every icon-only control has an accessible
name.

> **Cross-runtime naming trap** (learned the hard way, `plan/PLAN.md`): Playwright's
> `getByRole(name)` substring-matches by default while RTL matches exactly. New `aria-label`s
> here must be checked against both suites or a green vitest run will break e2e.

**Styling** uses the existing token-driven `styles.css` and `Button` `[data-variant]`
system (ADR 0028). **No new component language, no parallel design system.**

---

## 6. Caching

- **Search results:** in-memory in main, keyed by `normalize(query) + provider`, TTL 5 min,
  bounded to 50 entries. Survives panel remounts so re-opening the tab does not re-bill.
  Not persisted to disk — stale music results have no value across sessions.
- **Downloads:** deduped by `remoteId` against `sources.json` before any bytes are fetched.
  A track already in the project is never downloaded twice.
- **Preview bytes:** in-memory, bounded to ~20 MB, evicted LRU. Re-auditioning a track the
  user already heard costs nothing.

This follows the footage-map cache precedent (`plan/PLAN.md`): **serve the cache first and
stay independent of the remote index**, which is what stopped re-billing on project reopen.
