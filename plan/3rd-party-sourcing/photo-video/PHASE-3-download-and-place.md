# Phase 3 — Download, materialize, place — `[ ]`

> **Ships:** the complete manual outcome — search → preview → Add → bin → timeline → export.
> **Depends on:** Phases 0–2.
> **This is the phase where the plan either becomes a product or becomes a demo.**

The materialization pipeline already exists (`README.md` §4). Phase 3 adds the fetch and the
wiring. **If this phase starts growing new engine routes, new timeline operations, or a new
asset model, something has gone wrong** — re-read `README.md` §4.

It also carries the one genuinely new design problem in this plan: placement under the
single-picture-layer preview constraint (`README.md` §2).

---

## P3.1 — Download service in main

**New:** `apps/desktop/electron/media/stock-download.ts`.

Copy the **shape** of `music-download.ts` — operation ids, progress events, `AbortController`
cancellation, temp-then-atomic-rename. Do not reuse Capability Packs (ADR 0114 packs are
immutable FramePilot-controlled runtimes).

Sequence:

1. **Resolve the variant.** The renderer sends `remoteId` + `variantId`; main looks the item
   up in the search cache and takes the URL from there. The renderer never had one to send.
   A cache miss re-searches rather than trusting renderer-supplied data.
2. **Check size.** `Content-Length` > `STOCK_MAX_DOWNLOAD_BYTES` (2 GB) → `too_large`, before
   a single byte is written. Enforce it again as a running total, because a lying
   `Content-Length` must not be able to fill the disk.
3. **Dedupe** against `sources.json` by `provider` + `remoteId` + `variantId`
   (`CONTRACTS.md` §6). Already present → return the existing asset, download nothing.
4. Resolve the target inside the project media dir using the **existing** `resolveWithin`
   sandbox and `safeFileName` / `dedupeName` from `projects/media-import.ts`. **The sandbox is
   not broadened** — downloaded files land where imported ones do, so `fp-media://` and the
   render engine resolve them with no change.
5. Stream to `<target>.<pid>.tmp`, emitting `StockDownloadProgressWire`.
6. On completion, **atomically rename**. On cancel or any failure, **unlink the temp file** —
   a partial file must never be reachable.
7. Append to `sources.json` atomically.

Scoped logging via `createLogger('desktop:stock-download')`; `log.action` on
start/finish/cancel. Never log the key or a variant URL.

**Failure handling, explicitly:** ENOSPC → `disk_full`, temp removed. Truncated body /
`Content-Length` mismatch → `download_failed`, temp removed. No bytes for
`STOCK_DOWNLOAD_STALL_MS` → `timeout`, temp removed. **No auto-retry.**

**Video downloads are large — hundreds of MB is normal, unlike a 4 MB music track.** Two
consequences the music service never had to handle, and which need explicit tests: progress
must be emitted at a coarse interval rather than per chunk (a 400 MB file at 64 KB chunks is
6,400 IPC messages), and a cancel must actually abort the socket rather than merely stop
reading.

**Tests:** happy path for a photo and for a video; cancel mid-stream leaves **no temp and no
final file**; ENOSPC; truncated body; `too_large` before any bytes; dedupe short-circuits
before any fetch; `sources.json` written atomically and survives a concurrent second download;
progress events are throttled, not per-chunk.

---

## P3.2 — Materialize as a project asset

**Touch:** `main.ts` download handler.

After rename, call the **existing** `importAssetViaSidecar`
(`apps/desktop/electron/media/asset-media-client.ts:41`) against `POST /asset-media`, which
already returns `durationSeconds`, `kind`, `peaks`, `thumbnailPaths` and `proxyPath` for any
on-disk path (`service.py:348`).

**Two gotchas, both already known to this repo:**

- **Classify by `ffprobe format_name`, not duration.** A downloaded JPEG can report a bogus
  fractional duration and be classified as video. The engine already does this correctly;
  the point is not to add a client-side shortcut that re-introduces the bug.
- **No browser-side probe.** The renderer's `<video>`-element probe in `editor/import.ts`
  exists because the renderer holds the bytes there. Here main does, and the sidecar answers
  better. **No new engine route; no engine change at all in this plan.**

If derivation fails, the asset is still added (`derive_failed`). A missing thumbnail is a
degraded bin tile; a missing asset is a lost download.

**Tests:** integration — download → `/asset-media` → an `Asset` with real `kind`/dimensions
for both a photo and a video; a JPEG classifies as `image`, not `video`; `derive_failed` still
yields a usable asset.

---

## P3.3 — Placement, under the compositing constraint

**Touch:** `apps/web-editor/src/editor/patch-builders-base.ts`, `StockPanel.tsx`.

**Read `README.md` §2 before writing a line of this.** It is the reason this section is not
just "call `placeAssetPatch`".

**New builder**, beside `addMusicTrackPatch` (`patch-builders-base.ts:1558`) and following its
shape exactly:

```ts
/**
 * Add a fetched stock photo/video to the bin AND place it, as ONE patch.
 *
 * Returns `null` when no picture layer has room at `atStart`. That refusal is the
 * whole point: the preview flattens picture clips from every track into one
 * PictureSegment sequence (`selectors.ts:376-393`) while the export composites
 * them (`compiler.py` _blend_layer_over). Stacking here would show the user one
 * thing and export another. Gated on SUC-P1.
 */
export function addStockClipPatch(
  timeline: Timeline,
  assetById: ReadonlyMap<string, Asset>,
  asset: Asset,
  atStart: number,
): Patch | null;
```

- One patch — `add_asset` + `add_clip` — whose inverse removes both, so **one undo** leaves
  the project as it was. Same reasoning as `addMusicTrackPatch`'s doc comment: the user did
  one thing.
- Reuse `placeAssetPatch`'s "frontmost layer of the same kind **with room**" search
  (`patch-builders-base.ts:1488`), and **return `null` instead of falling through to the
  new-front-layer branch**. That fallback is correct for user-imported media, where the user
  chose to stack; it is wrong here, where the panel offered a one-click Add.
- Photos have no duration: use `DEFAULT_CLIP_SECONDS`, the same default `placeAssetPatch`
  applies. The user trims afterwards; there is no new "still duration" setting and no new op.
- **No new timeline operation.** `add_asset` + `add_clip` express this completely.

**Panel behaviour** (`CONTRACTS.md` §5, "Placement blocked"): when the builder would return
`null`, Add is **disabled with a stated reason** — "There's already footage at the playhead —
move the playhead, or make a gap." Never a silent stack, never a toast after the fact. The
state updates live as the playhead moves.

**Tests:**

- `patch-builders.test.ts` — apply / undo / redo round-trip for photo and video; the resulting
  timeline is deep-equal to the manual drag-from-bin path
- **overlap refusal:** a timeline with a picture clip covering the playhead yields `null`
- **preview/export parity:** the placed clip produces a `PictureSegment` sequence identical to
  what the compiler composites. This is the test that would have caught the whole class of bug
  `README.md` §2 describes, and it is the most important test in this plan
- `Asset.source` is carried into the bin with `provider`, `remoteId`, `license`,
  `attributionRequired: false`, `attribution`, `creator`, `creatorUrl`, `sourceUrl`,
  `fetchedAt`

---

## P3.4 — Credits: the "Suggested" group

**Touch:** the Credits surface built in the music slice (`CreditsSection`).

Per `README.md` §D4, Pexels assets have `attributionRequired: false` and therefore do **not**
belong in the existing required list — but their credit line still exists and is worth
offering.

Add a second, quieter group: **"Suggested credits"**, listing assets that carry an
`attribution` but do not require it, with its own copy action, and a one-line explanation
("Not required, but appreciated by the creators"). The existing "Required" group and its empty
state are untouched.

**Tests:** a Pexels asset appears under Suggested and **not** under Required; a CC-BY music
asset still appears under Required; copy produces the expected text for each; both empty
states render; a project with only Pexels assets shows the positive "nothing requires credit"
confirmation the music slice already ships, **plus** the Suggested list.

---

## P3.5 — Download UI states

The download rows of `CONTRACTS.md` §5: determinate progress with bytes, Add→Cancel, per-tile
failure with Retry, cancelled returns to idle, "In this project" for duplicates. Other tiles
stay interactive — **one download must not freeze the panel.**

Because video files are large, show **bytes and a percentage**, and show the chosen variant's
size on the tile _before_ the user commits ("1920×1080 · 24 MB"). A download the user can size
up in advance is the difference between a considered click and a surprise.

`role="progressbar"` with `aria-valuenow`; announced at coarse intervals, not per chunk.

**Tests:** `StockPanel.test.tsx` for each download state, driven by stubbed progress events.

---

## P3.6 — Reopen and offline

The downloaded file is an ordinary project asset, so reopening offline must resolve it with no
provider involvement. **Test this explicitly** — it is the payoff of materializing rather than
hot-linking, and the thing that silently regresses if someone later "optimizes" by storing a
URL. (It is also, separately, what keeps the integration clear of the Pexels terms' hotlinking
concerns — see `PEXELS-API.md` §4.)

**Tests:** e2e — download, save, reload with the provider seam hard-failing; the asset
resolves, previews and renders.

---

## P3.7 — Ripple-insert placement — `[ ]` OPTIONAL, may be dropped

The natural resolution to a blocked placement is "push everything right and insert here". The
`insert` operation **already exists** in the schema and the AI tool surface — it simply has no
UI, part of the repo's standing roll/slip/slide/insert/multicam gap.

Wiring an "Insert at playhead" action in the Stock panel would close the blocked-placement
dead end. It is listed here so the option is visible, and marked optional because:

- the slice is complete and useful without it — the user can move the playhead
- building the first UI for `insert` is a timeline-editing change with its own correctness
  surface (ripple semantics across locked tracks, markers, captions), not a stock-sourcing one
- doing it badly here would be worse than not doing it

**If it is taken up, it belongs in the timeline plan, not this one**, and this panel simply
calls it.

---

## P3.8 — E2E and the real-media proof

**Touch:** `tests/e2e/specs/stock-search.spec.ts` (extend).

E2E with a stubbed provider serving local fixture files: Add a photo → progress → asset in bin
→ clip on the timeline → undo removes it → redo restores it; cancel leaves nothing behind;
Add over an occupied playhead is refused with the reason. Same for a video.

**Separately, and required by `product-discipline.mdc` §8 — the manual evidence run.** Tiny
fixtures are explicitly insufficient for a media claim:

> A real **5–15 minute screen recording** → search → preview → download **a stock video** →
> place as a cutaway → **export** → the rendered file shows the clip at the right moment
> **and the preview showed the same thing**. Repeat with **a stock photo**. Confirm the
> Settings quota moved by exactly the number of searches made, and that the reset date matches
> the provider. Undo removes it in one step. Reopen offline resolves the file and Credits
> still lists the photographer under Suggested.

State the source file, the items used, the variant chosen, and the observed result. **Without
this run, Phase 3 is not done** — every prior gate can pass on a synthetic 2-second fixture.

---

## P3.9 — Docs

- Complete `docs/guides/stock-sourcing.md`: what it does, the key, the quota readout and its
  monthly/hourly caveat, where files land, **why a clip cannot be stacked over existing
  footage yet and what will change that**, and what happens offline.
- `CHANGELOG.md` — user-facing, benefit-first.
- Update the Phase-2 ADR only if this phase changed a decision; do not author a second ADR for
  the same decision (`.agents/rules/documentation.mdc` — proportional).

---

## Definition of done

- [ ] The full manual outcome is wired end to end on desktop, for photos **and** videos
- [ ] **The real-media evidence run in P3.8 is recorded, with the export verified by eye**
- [ ] **Preview and export agree** on a placed stock clip — asserted by test, not assumed
- [ ] An overlapping placement is refused with a stated reason, never stacked (tested)
- [ ] Cancelled and failed downloads leave **no partial file and no orphan asset** (tested:
      cancel mid-stream, truncated body, ENOSPC, oversize, empty body)
- [ ] Duplicate `remoteId` + `variantId` never downloads twice; a different variant of the
      same item still can
- [ ] One undo removes asset + clip (tested through the real store, with redo)
- [ ] Credits lists Pexels assets under **Suggested**, music under **Required**, both copyable
- [ ] Offline reopen resolves the asset; nothing is streamed at playback or export
- [ ] Path sandbox unchanged; CSP unchanged and pinned by test; **no schema migration**
- [ ] `pnpm test:e2e` green; unit / typecheck / lint green across every package
- [ ] Guide + `CHANGELOG.md` landed; plan ledgers updated

**Deferred out of this phase:** the agent tool (Phase 4); overlay/PiP placement (`SUC-P1`);
ripple-insert UI (P3.7); download queue/resume across restarts; cross-project media cache;
favourites; "where did this come from?" UI over `sources.json`.

**Added after review (2026-08-25):** the tile's download state — progress, Cancel, and the
"already in flight" guard — moved into `apps/web-editor/src/editor/download-registry.ts`, a
module singleton shared with the Sounds panel, so it survives the tab slot unmounting the
panel. Search also gained a resolution-time sequence guard, so a slow query landing after a
faster later one can no longer replace the grid (or raise its error over live results).
Resume across an app **restart** remains deferred: nothing here persists to disk.
