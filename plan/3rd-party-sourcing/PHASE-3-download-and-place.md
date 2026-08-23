# Phase 3 — Download, materialize, place — `[~]` code complete · real-media run outstanding

> **Ships:** the complete manual outcome — search → audition → Add → bin → timeline → export.
> **Depends on:** Phases 1 and 2.
> **This is the phase where the plan either becomes a product or becomes a demo.**

The whole materialization pipeline already exists (`README.md` §3). Phase 3 adds the fetch
and the wiring between existing pieces. If this phase starts growing new engine routes, new
ops, or a new asset model, something has gone wrong — re-read `README.md` §3.

---

## P3.1 — Download service in main — `[x]`

**New:** `apps/desktop/electron/media/music-download.ts`.

Copy the **shape** of `capability-packs/service.ts` — operation ids, progress events,
`AbortController` cancellation, temp-then-atomic-rename. **Do not reuse Capability Packs**
(README §3): packs are immutable FramePilot-controlled runtimes; this is mutable per-project
licensed third-party media with retention obligations.

Sequence:

1. **Refuse non-commercial-only tracks** with `non_commercial_only` (D2). Attribution-required
   tracks are allowed — this gate is about monetization rights, which no badge can make safe.
2. **Dedupe** against `sources.json` by `remoteId`. Already present → return the existing
   asset, download nothing, bill nothing.
3. Resolve the target inside the project media dir using the **existing**
   `resolveWithin` sandbox and `safeFileName`/`dedupeName` helpers in
   `projects/media-import.ts`. **The sandbox is not broadened** — downloaded files land in
   the same directory imported ones do, so `fp-media://` and the render engine resolve them
   with no change.
4. Stream to `<target>.<pid>.tmp`, emitting `MusicDownloadProgressWire`.
5. On completion, **atomically rename**. On cancel or any failure, **unlink the temp file** —
   a partial file must never be reachable.
6. Append to `sources.json` atomically (`CONTRACTS.md` §3).

Scoped logging via `createLogger('desktop:music-download')`; `log.action` on start/finish/
cancel. Never log the key or the signed URL.

**Failure handling, explicitly:** disk full (ENOSPC) → `disk_full`, temp removed. Truncated
body / `Content-Length` mismatch → `download_failed`, temp removed. Stalled >30 s →
`timeout`, temp removed. **No auto-retry** — a silent retry on a metered API spends the
user's quota without consent.

**Tests:** happy path; cancel mid-stream leaves **no temp and no final file**; ENOSPC;
truncated body; dedupe short-circuits before any fetch; a non-commercial track refused before any fetch;
an attribution-required track downloaded **with its credit persisted**;
`sources.json` written atomically and survives a concurrent second download.

---

## P3.2 — Materialize as a project asset — `[x]`

**Touch:** `main.ts` download handler.

After rename, call the **existing** `importAssetViaSidecar`
(`apps/desktop/electron/media/asset-media-client.ts:41`) against `POST /asset-media`, which
already returns `durationSeconds`, `kind`, `peaks`, `peaksPerSecond`, `thumbnailPaths` and
`proxyPath` for any on-disk path (`service.py:348`).

**No browser-side duration probe.** The renderer's `<video>`-element probe in
`editor/import.ts` exists because the renderer holds the bytes there; here main does, and the
sidecar answers better. **No new engine route, no engine change at all in this plan.**

If derivation fails, the asset is still added (`derive_failed` — "saved, but couldn't read
its waveform"). A missing waveform is a degraded timeline row; a missing asset is a lost
download.

**Tests:** integration — download → `/asset-media` → `Asset` shape with real duration/kind;
`derive_failed` still yields a usable asset.

---

## P3.3 — Add to bin and timeline — `[x]`

**Touch:** `apps/web-editor/src/components/SoundsPanel.tsx`, patch builders.

- `add_asset` (`packages/editor-core/src/project-operations.ts:17`) puts it in the bin,
  **carrying `Asset.source`** (schema v20, Phase 1) — provider, remote id, licence, licence
  URL, `attributionRequired`, the credit line, creator, and `fetchedAt`. This is the moment
  the D2 obligation becomes durable; if the field is not written here, the Credits view is
  empty and the feature is unsafe.
- Placement reuses `placeAssetPatch`
  (`apps/web-editor/src/editor/patch-builders-base.ts:1477`) — `add_layer` + `add_clip`,
  which **invert together**, onto a `music`-role track.
- **No new timeline operation.** If one seems necessary, the design is wrong: `add_asset` +
  `placeAssetPatch` + `adjust_audio` already express "music bed, ducked under dialogue"
  completely.
- Set the track's `role: 'music'` (`timeline-schema/src/index.ts:52`) so `adjust_audio`'s
  `duckUnderTrackId` and the beat grid can reason about it.

**Undo is one step.** Adding a downloaded track from the panel produces **one patch** whose
inverse removes asset, layer and clip together. The file stays on disk — non-destructive
invariant 1; the user can re-place it from the bin.

**Tests:** `patch-builders.test.ts` — apply/undo/redo round-trip for the full add-and-place
patch; the resulting timeline is deep-equal to the manual drag-from-bin path.

---

## P3.4 — Download UI states — `[x]`

The download rows of `CONTRACTS.md` §5: determinate progress with bytes, Add→Cancel, per-row
failure with Retry, cancelled returns to idle, "In this project" for duplicates. Other rows
stay interactive throughout — **one download must not freeze the panel**.

`role="progressbar"` with `aria-valuenow`; progress announced at coarse intervals, not on
every chunk.

**Tests:** `SoundsPanel.test.tsx` for each download state, driven by stubbed progress events.

---

## P3.5 — Reopen and offline — `[x]`

The downloaded file is an ordinary project asset, so reopening offline must resolve it with
no provider involvement. **Test this explicitly** — it is the payoff of materializing rather
than hot-linking, and the thing that silently regresses if someone later "optimizes" by
storing a URL.

**Tests:** e2e — download, save, reload with the provider seam hard-failing, confirm the
asset resolves, previews and renders.

---

## P3.6 — E2E and the real-media proof — `[~]` e2e done · manual run OUTSTANDING

> **Status 2026-08-23.** The automated half is done: `tests/e2e/specs/music-sourcing.spec.ts`
> plus 25 main-process service tests, 32 adapter tests and 29 panel tests, all offline.
>
> **The manual real-media evidence run has NOT been performed, and this phase is
> therefore not `[x]`.** It needs a human at a desktop build with a real 5–15 minute
> recording: search → audition → download an attribution-required track → place →
> `adjust_audio` duck under dialogue → export → **listen to the result** → check
> Credits after save + reopen. `product-discipline.mdc` §8 is explicit that tiny
> fixtures cannot stand in for a media claim, and no amount of green unit tests
> substitutes for hearing the bed under the voice.
>
> Everything the run would exercise is covered by tests individually; what is
> unproven is the whole chain against real footage on a real machine.

**Touch:** `tests/e2e/specs/music-search.spec.ts` (extend).

E2E with a stubbed provider serving a local fixture file: Add → progress → asset in bin →
drag to timeline → undo removes it → redo restores it; cancel leaves nothing behind.

**Separately, and required by `product-discipline.mdc` §8 — the manual evidence run.** Tiny
fixtures are explicitly insufficient for a media claim. Record in the plan snapshot:

> A real **5–15 minute screen recording** → search → audition → download **an
> attribution-required track** → place on a `music` track → `adjust_audio` ducks it under
> dialogue → **export** → the rendered file has the bed audible and ducked, **and the Credits
> view names the creator and copies the credit line**. Undo removes it in one step. Reopen
> offline resolves the file and still shows the credit.

State the source file, the track used, and the observed result. **Without this run, Phase 3
is not done** — every prior gate can pass on a synthetic 2-second fixture.

---

## P3.7 — Docs — `[x]`

- New `docs/guides/music-sourcing.md`: what it does, the key, licence limits, where files
  land, and what happens offline.
- `CHANGELOG.md` — user-facing, benefit-first.
- Update the Phase-2 ADR only if this phase changed a decision; do not author a second ADR
  for the same decision (`.agents/rules/documentation.mdc` — proportional).

---

## Definition of done

- [x] The full manual outcome is wired end to end on desktop
- [ ] **The real-media evidence run in P3.6 is recorded, with the export verified by ear**
      — OUTSTANDING, needs a human at a desktop build (see the P3.6 note)
- [x] Cancelled and failed downloads leave **no partial file and no orphan asset** (tested:
      cancel mid-stream, truncated body, ENOSPC, empty body)
- [x] Duplicate `remoteId` never downloads twice (tested, including the case where the
      ledger row survived a file the user deleted)
- [x] **Attribution-required tracks download and persist their credit** (tested at every
      hop: adapter keeps it, main writes it into `Asset.source`, the patch carries it into
      the bin, Credits renders and copies it). This is D2's obligation
- [x] Non-commercial-only tracks are refused before any fetch, with a stated reason (tested
      at the adapter AND again at the download, and asserted to fetch zero bytes)
- [x] One undo removes asset + layer + clip (tested through the real store, with redo)
- [x] Offline reopen resolves the asset — it is an ordinary project file in the ordinary
      media folder; nothing is streamed at playback or export
- [x] Path sandbox unchanged (the existing `resolveWithin`/`safeFileName`/`dedupeName` are
      reused, now exported rather than reimplemented); CSP unchanged and pinned by test;
      no further migration
- [x] `pnpm test:e2e` green (80); unit/typecheck/lint green across every package
- [x] Guide + `CHANGELOG.md` landed; plan ledgers updated

**Deferred out of this phase:** the agent tool (Phase 4), download queue/resume across restarts,
cross-project media cache, favourites, "where did this come from?" UI over `sources.json`.
