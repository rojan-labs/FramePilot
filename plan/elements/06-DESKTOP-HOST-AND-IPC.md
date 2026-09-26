# 06 — Desktop host, IPC, security and packaging

The pattern is the one the Stock slice proved (ADR 0139): the **main process** touches the disk
and (for the optional animated pack) the network; the renderer sends **ids, never paths**, and
receives an asset; the patch is built from that asset by the shared placement builder.

---

## 1. `ElementsLibrary` — the main-process service

**New:** `apps/desktop/electron/media/elements-library.ts` (+ `.test.ts`).

```ts
export interface ElementsLibraryOptions {
  readonly projectsRoot: string;                    // every write resolves inside it
  readonly elementsRoot: () => string;              // where bundled sticker files live (see §4)
  readonly catalog: StickerCatalog;                 // the generated catalogue, imported from ai-sdk
}

materialize(req: { projectId: string; elementId: string }): Promise<ElementMaterializeResult>
```

`materialize`:

1. **Resolve the id** against the catalogue. Unknown → `unknown_element`. The renderer cannot name
   a file; it can only name a catalogue entry.
2. **Target:** `resolveWithin(projectsRoot, mediaRelativeDir(projectId), 'elements', library,
`${itemId}.webp`)` using the existing `projects/media-import.ts` helpers. The sandbox is not
   broadened: element files land where imported media lands, so `fp-media://` and the engine
   resolve them with no change.
3. **Dedupe:** target exists and its SHA-256 matches the catalogue → return it (`deduped: true`),
   copy nothing.
4. **Read + verify** the bundled bytes against the catalogue SHA-256 (catches a damaged install:
   `integrity_failed`, or `library_missing` when absent).
5. **Write** to `<target>.<pid>.tmp`, then atomic rename; unlink the temp on any failure. ENOSPC →
   `disk_full`; anything else → `io_failed` with the path's basename (never the full path) in the
   detail.
6. **Return** the asset: `id = sourcedAssetId('element', library, itemId)`, `kind: 'image'`,
   `media: { width, height }` from the catalogue, `source` provenance (04 §1). **No** sidecar
   derive (the shape is known) and **no** brain enrolment (a sticker is not footage — G9).

Concurrency: a per-`(projectId, elementId)` single-flight, so a double-click or the agent adding
the same sticker twice in one turn copies once. Logging: `createLogger('desktop:elements')`,
`log.action('materialize', { elementId, deduped, bytes, ms })`.

Error union (`ElementErrorCode`, closed, each with one user sentence — 02 §8):
`unknown_element · library_missing · integrity_failed · disk_full · io_failed` and, with EL10,
`download_failed · offline · timeout · too_large · cancelled`.

---

## 2. IPC surface

| Channel                                 | Direction       | Payload                                                                                                                                                                                                                                                                                                                                                                           | Phase |
| --------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `framepilot:elements:materialize`       | invoke          | `{ projectId, elementId }` → `{ ok: true, asset } \| { ok: false, error, detail? }`                                                                                                                                                                                                                                                                                               | EL6a  |
| `framepilot:elements:thumbnail`         | invoke          | `{ elementIds }` (at most 96) → `{ ok: true, packaged, thumbs: [{ elementId, webp }] } \| { ok: false, error }` — tiles of **packaged** stickers as WebP bytes the renderer wraps in `blob:` (the Pexels thumbnail pattern), batched per screenful of rows rather than one call per tile; an empty list asks only whether the set is present; curated tiles are same-origin files | EL6b  |
| `framepilot:elements:download-progress` | main → renderer | `{ operationId, elementId, percent, state }`                                                                                                                                                                                                                                                                                                                                      | EL10  |
| `framepilot:elements:download-cancel`   | send            | `operationId`                                                                                                                                                                                                                                                                                                                                                                     | EL10  |

Touch: `packages/shared-types/src/ipc.ts` (wire types), `apps/desktop/electron/ipc/contract.ts`
(`IpcChannels`), `apps/desktop/electron/preload.cts` (channel map + bridge methods —
`ipc/preload-channel-parity.test.ts` and `ipc/main-channel-registration.test.ts` fail until preload,
contract and handler agree), `apps/web-editor/src/editor/bridge-base.ts` (helpers with
the desktop-only answer in the browser), `main.ts` (handlers). Main validates the request with Zod:
`projectId` through `safeProjectId`, `elementId` against `/^[a-z0-9_]{1,96}$/` **and** the
catalogue. The EL10 downloads reuse `download-registry.ts` so progress survives a tab switch, as
stock downloads do.

**No new channel for shapes.** A shape needs no file; the shape catalogue ships in the renderer
bundle (it is imported from `timeline-schema`), and the raster route already exists (05 §2.3).

**The Pexels channels are unchanged** (`framepilot:stock:*`, 08).

---

## 3. The agent host

**New:** `apps/desktop/electron/ai/sticker-host.ts` — the `stock-host.ts` shape exactly: resolve,
materialise through `ElementsLibrary`, return `{ status, summary, data: { asset, atSeconds? } }`,
edit nothing. The orchestrator turns it into the same `addStickerPatch` the panel uses (07 §3).
Wired in `main.ts` beside `createStockHost`. `add_shape` needs no host.

---

## 4. Where the sticker files live, and packaging

Two locations, because two sets ship differently (03 §3, MD-E1, MD-E2):

| Set                                 | Where                                          | How it gets there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Curated ~200** (+ all thumbnails) | `apps/web-editor/public/elements/stickers/`    | committed; Vite copies `public/` into the renderer output, which electron-builder already packages (`files: renderer/**`, `electron-builder.yml:22-24`) — inside `app.asar/renderer/elements/`, which Electron's `fs` reads transparently                                                                                                                                                                                                                                                                        |
| **The other ~1,395** (EL6b)         | `<resources>/elements/stickers/{full,thumbs}/` | fetched and encoded from the pinned upstream commit by the **desktop packaging** step (`apps/desktop` `dist` runs `build:elements` before `electron-builder`) into `extraResources`, cached by the lock hash; never part of `web-editor#build`; tiles reach the renderer through `framepilot:elements:thumbnail`. Built: 1,344 files, 32.2 MiB, with a `manifest.json` (library commit, per-file SHA-256) that main verifies copies against, because lossless WebP bytes are not identical across encoder builds |

`elementsRoot(item)` (one function, tested) resolves per catalogue item — `bundled` items from the
renderer folder, `packaged` items from `process.resourcesPath` in a packaged app — with the repo paths
in development and an injected root in tests. A `packaged` item missing from a build that should have
it is `library_missing`, and the panel hides `packaged` items in a build that has no packaged set, so
a tile never fails on click.

CI uploads the build script's size report and fails if the packaged `elements/` grows past its budget
(MD-E1: 40 MB) without the budget being changed in the same PR.

**Licence files** travel with the files they cover (03 §4), inside each folder.

---

## 5. Security review points (for `security-reviewer`, EL6a and EL10)

| Surface                       | Control                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path traversal                | ids only from the renderer and the agent; resolved against a bundled catalogue; writes via `resolveWithin`                                                                                     |
| Tampered or truncated library | SHA-256 per file, checked before every copy                                                                                                                                                    |
| CSP                           | unchanged: tiles are same-origin `img-src 'self'`; no provider origin added to `connect-src`; the renderer never receives a URL                                                                |
| Electron hardening            | unchanged (`contextIsolation`, `sandbox`, no `nodeIntegration`, IPC only via preload)                                                                                                          |
| Renderer DoS via shape params | params validated and bounded before apply (04 §2.4); rasters capped at 8192 px supersampled; the raster route validates with Pydantic `extra="forbid"`                                         |
| EL10 downloads                | https only; host allowlist (the pinned mirror, MD-E3); per-file size cap 2 MB; SHA-256 pin required _before_ rename; stall timeout; cancellation aborts the socket; temp files never reachable |
| Agent reach                   | `add_sticker` can only materialise catalogue items into the open project; `hostUiOnly` for MCP until MCP has its own materialiser (07 §7)                                                      |

---

## 6. The browser build (decided in EL11)

Desktop is product focus #1, so the browser build keeps the Elements tab **absent** until EL11 decides
each half with a test:

- **Shapes:** need an engine-free raster — a canvas `Path2D` fallback labelled "Preview approximate"
  (ADR 0180 decision 4).
- **Stickers:** the curated set only; the renderer fetches `elements/stickers/full/<id>.webp` from its
  own origin and hands the bytes to the existing import path (`editor/import.ts:128-152`,
  `importMedia`) — if the browser project cannot store it, Stickers stay absent (degrade by absence).
- **Photos / Videos:** absent, as the Stock tab is today (`elements.spec.ts`, formerly
  `stock-sourcing.spec.ts`, keeps asserting no provider host appears in the page).

---

## 7. The Pexels service

`stock-service.ts`, `stock-quota.ts`, `stock-host.ts` and the provider adapter are **unchanged** in
behaviour. EL9's additions (orientation filter, category queries) are request parameters the
adapter already models (`StockOrientationWire`). Only user-facing sentences that say "Stock" change
(08).

---

## 8. Observability

- Scoped loggers, never `console.log`: `desktop:elements` (materialise, downloads),
  `web-editor:elements` (panel actions), and `logging.getLogger(__name__)` in the new engine
  modules (raster timings at `debug`).
  `log.action` for the high-signal events only: an element added, a materialise that copied bytes,
  a download finished or failed.
- The opt-in, local-only telemetry (`electron/telemetry/telemetry.ts` — never uploads) may record
  `elements.add` with `{ kind, library }` and `elements.failed` with the error code. **Search text is
  never logged or recorded** — the same privacy line the Pexels panel draws (only the words typed
  leave the machine, and only to Pexels).
- Render-validation failures for elements (05 §6) name the element, so a support log says which
  sticker or shape went missing.

**Last updated:** 2026-09-26
