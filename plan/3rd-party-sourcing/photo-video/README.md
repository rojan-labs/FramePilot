# Stock photo & video sourcing (Pexels) — `[~]` shipped · one evidence run outstanding

> **Sub-plan index.** Created 2026-08-24. Owner: maintainer.
> Parent: [`plan/3rd-party-sourcing/README.md`](../README.md) → third-party media sourcing.
> Sibling: the shipped **music** slice (Openverse), whose machinery this plan extends rather
> than duplicates.

Music sourcing shipped. This plan gives FramePilot the second outward reach: **stock photos
and stock video from Pexels, fetched in the Electron main process and materialized as
ordinary project assets** — with the user's own API key, and with their live quota
(limit / remaining / reset) shown in Settings.

## Files

| File                                                               | What it holds                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `README.md` (this)                                                 | Decision record, the compositing constraint, scope gate, current state, sequencing, ledger |
| [`PEXELS-API.md`](./PEXELS-API.md)                                 | Provider research with sources: endpoints, response shapes, quota headers, licence, terms  |
| [`CONTRACTS.md`](./CONTRACTS.md)                                   | Typed contracts: provider interface, IPC wire, **quota contract**, errors, UI state matrix |
| [`PHASE-0-key-and-quota.md`](./PHASE-0-key-and-quota.md)           | API key custody + the live rate-limit surface in Settings                                  |
| [`PHASE-1-provider-adapter.md`](./PHASE-1-provider-adapter.md)     | The Pexels adapter — photos and videos, normalization, variant selection                   |
| [`PHASE-2-search-and-preview.md`](./PHASE-2-search-and-preview.md) | Stock panel: search, grid, hover preview. No download.                                     |
| [`PHASE-3-download-and-place.md`](./PHASE-3-download-and-place.md) | Download → asset → timeline → export, under the single-picture-layer constraint            |
| [`PHASE-4-agent-tool.md`](./PHASE-4-agent-tool.md)                 | `search_stock` / `add_stock` for Agent mode + MCP                                          |
| [`PHASE-5-docs-and-evidence.md`](./PHASE-5-docs-and-evidence.md)   | ADRs, guides, the deferred-file reversal note, and the real-media evidence runs            |

---

## 1. Decision record

Recorded here so a later agent does not silently reverse them
(`.agents/rules/product-discipline.mdc` §10).

### D1 — This deliberately reopens the stock-footage deferral

[`../DEFERRED-stock-footage-and-sfx.md`](../DEFERRED-stock-footage-and-sfx.md) deferred stock
video on 2026-08-23 with four reasons. **The maintainer reopened it on 2026-08-24.** Being
honest about which reasons still hold:

| Original reason                                                            | Status now                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Often the wrong edit for the SaaS/screen-recording niche                | **Still true, and unchanged.** This ships a tool, not an instruction to use it. The agent must not reach for stock when a punch-in is the better cut — see Phase 4.                                                   |
| 2. Costs far more than music for less benefit                              | **Materially reduced.** The download/materialize/place pipeline now exists and is tested — the music slice built it. TwelveLabs indexing of stock clips is **not** in scope; search is keyword, done by the provider. |
| 3. The product plan places it at H3                                        | **Overridden by maintainer decision**, which is the plan's own escalation path.                                                                                                                                       |
| 4. `SUC-P1` (multi-layer picture compositing in preview) is a hard blocker | **STILL TRUE, and it is the single most important constraint in this plan.** See §2.                                                                                                                                  |

That file's carry-over prediction was correct and is honoured: `ProviderTrack` generalizes,
the main-process fetch path is identical, and `Asset.source` (schema v20) already carries
provenance for **any** media kind. This plan adds **no schema migration**.

### D2 — Pexels, and Pexels alone

Established by [`PEXELS-API.md`](./PEXELS-API.md), verified against the live documentation on
2026-08-24.

Pexels is the only candidate that is **photos and videos in one free, self-serve, instantly
keyed API**, with a content licence permitting commercial use and no per-video attribution
obligation. Pixabay was disqualified for _music_ in the sibling plan (`../PROVIDERS.md`); for
pictures it is qualified, and it is the obvious second provider **if a second is ever
earned**. It is not earned today.

**One adapter, a named union, no registry.** Same rule as the music slice: generalize when a
second provider actually lands (`product-discipline.mdc` §5).

### D3 — The user brings their own Pexels key, and their quota is visible

Unlike Openverse, Pexels requires a key. This is the first provider in the repo where the
`../CONTRACTS.md` §2 custody design the music slice never got to use becomes live:
**write-only, main-owned**, `PEXELS_API_KEY` env fallback, root `.env.example` **and**
`turbo.json` `globalEnv` (CLAUDE.md §2 — this obligation is _not_ vacuous here, unlike in the
music slice).

And because the key is metered, **the quota is part of the product, not a diagnostic**: the
Settings section shows limit, remaining, percentage, and when the window resets, read from
the provider's own response headers. See [`PHASE-0`](./PHASE-0-key-and-quota.md).

### D4 — Attribution is _requested_, not _required_ — and the distinction is preserved, not flattened

The Pexels **content licence** does not oblige the end user to credit anyone in their video.
The Pexels **API guidelines** oblige _the integrating application_ to show a prominent link
to Pexels, and to credit photographers "when possible".

Two different obligations landing on two different parties. Flattening them either way is
wrong:

- Setting `attributionRequired: true` would tell the user their video needs a credit line
  that it legally does not — training them to ignore the badge, which then fails them on the
  CC-BY music track where the obligation is real.
- Dropping the credit entirely would discard the photographer's name the provider took care
  to send, and lose the "when possible" courtesy the API terms ask for.

**Therefore:** `attributionRequired: false`, while `attribution` / `creator` / `creatorUrl`
are still persisted verbatim into `Asset.source`. The Credits view gains a second, quieter
group — **"Suggested credits"** — separate from the existing required list. The app-level
Pexels link is discharged by the panel itself (Phase 2), not by anything per-asset.

### D5 — Stock picture media ships as a **cutaway**, not an overlay

This follows from §2 and is the scope decision that keeps the slice honest. PiP, split-screen
and B-roll-over-A-roll are **not** in this plan; they are gated on `SUC-P1`.

### D6 — No footage-understanding-driven selection

The agent gets keyword search, not "pick B-roll matching what the speaker is saying". That is
footage understanding driving a provider query — a different subsystem, and the sibling plan
already parked it. Recorded so the omission reads as a decision.

---

## 2. The constraint that shapes the whole plan

**The preview is a single-picture-layer engine. The export is not.**

`apps/web-editor/src/editor/selectors.ts:376-393` flattens picture clips from **every** track
into one time-ordered `PictureSegment[]`, sorted by `start`, with gaps filled. Two
overlapping picture clips on two layers cannot both be shown — the later one simply
overwrites time. Meanwhile `engine/python/framepilot_engine/render/compiler.py`
(`_blend_layer_over`, schema v8 / ADR 0048) composites them properly, with blend modes.

This is documented as blocker #1 in
[`plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md`](../../SCENE-UNDERSTANDING-AND-COMPOSITING.md)
§0.2, and `SUC-P1` exists only to fix it. **It has not started.**

For music this was irrelevant — audio does not composite through the picture path. For stock
photo and video it is decisive:

> If this plan let a user drop a stock clip onto a new front layer over their screen
> recording, the preview would show one thing and the export another. That is the
> preview-vs-render divergence the repo treats as a defect class, and it is precisely the
> "UI tells a lie" failure `SUC-P1` was written to close.

**So the placement rule for stock picture media is: it must not overlap another picture clip
in time.**

The good news is that `placeAssetPatch`
(`apps/web-editor/src/editor/patch-builders-base.ts:1476`) already prefers "the frontmost
existing layer of the same kind that **has room** at the drop point", and only creates a new
front layer when there is none. This plan therefore does not fight the builder — it **removes
the fallback** for stock media and states the reason to the user instead:

- Room at the playhead on a picture layer → place there. Preview == export. Ships.
- No room → the panel says so plainly ("There's already footage at the playhead — move the
  playhead, or make a gap"). It does **not** silently stack.

Ripple-insert ("push everything right and drop it in") is the natural resolution, and the
`insert` operation already exists — but it is **AI-only with no UI** today (the repo's
standing roll/slip/slide/insert/multicam gap). Building that UI is real, separable work; it
is listed as **P3.7, explicitly optional**, and the slice is complete and useful without it.

**When `SUC-P1` lands**, overlay/PiP stock becomes a change to the placement rule plus its own
UI. Nothing in this plan needs redesigning for that.

---

## 3. Scope gate (`.agents/rules/product-discipline.mdc` §3)

**User outcome.** A creator cutting a 30–90s short drops in a stock photo or a stock B-roll
cutaway without leaving FramePilot, sees exactly what will export, and can tell at a glance
how much of their free API quota is left.

**Current gap.** Honestly stated: **friction, not impossibility**, exactly as with music.
Downloading a clip from pexels.com and dragging it in works today. What is genuinely blocked
is (a) the round trip out of the app and back mid-edit, and (b) the agent cannot satisfy "put
a shot of a city skyline here" at all.

Priority-order item **3–4** (integration / UX for an existing workflow), not item 1.
Sequenced accordingly — §5.

**Minimum vertical slice.** One provider · photos **and** videos · key + live quota in
Settings · manual panel search · main-process fetch · non-overlapping placement · persisted
provenance · no agent tool. **Phases 0–3.**

**Reuse.** Nearly everything — §4. Net new code is one adapter, one quota store, six IPC
handlers, one panel, and a Credits grouping.

**Deferred scope, explicitly.** Overlay/PiP placement (gated on `SUC-P1`); ripple-insert UI
(optional P3.7); a second provider; collections / curated / popular browsing; colour and
locale filters; TwelveLabs indexing of downloaded stock; footage-matched B-roll selection;
download queue/resume across restarts; cross-project media cache; favourites; burned-in
on-screen credits.

**Evidence.** §6, and [`PHASE-5`](./PHASE-5-docs-and-evidence.md).

---

## 4. Grounded current state

Verified 2026-08-24 by direct inspection. **The acquisition step is the only missing one.**

| Capability                                                             | Location                                                                                                                              | State                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Provider adapter pattern, injectable `fetch`, Zod at the boundary      | `packages/ai-sdk/src/providers/music-types.ts`, `openverse-music.ts`                                                                  | ✅                          |
| Streaming download w/ progress, cancel, temp→atomic rename             | `apps/desktop/electron/media/music-download.ts`                                                                                       | ✅                          |
| Project media sandbox (`resolveWithin`, `safeFileName`, `dedupeName`)  | `apps/desktop/electron/projects/media-import.ts` (exported since the music slice)                                                     | ✅                          |
| Duration + kind + peaks + proxy + **thumbnails** from any on-disk path | `POST /asset-media` → `engine/python/framepilot_engine/service.py:348`; client `apps/desktop/electron/media/asset-media-client.ts:41` | ✅                          |
| `kind: 'image'` is a first-class asset kind                            | `packages/timeline-schema/src/index.ts:973`                                                                                           | ✅                          |
| Provenance for **any** media kind                                      | `AssetSourceSchema`, `index.ts:940` — schema v20, kind-agnostic                                                                       | ✅                          |
| Auto-layered placement incl. images                                    | `placeAssetPatch`, `patch-builders-base.ts:1476` (`assetKind` / `layerTypeForKind`)                                                   | ✅                          |
| Reversible bin add                                                     | `add_asset`, `packages/editor-core/src/project-operations.ts:17`                                                                      | ✅                          |
| Music IPC precedent                                                    | `IpcChannels.musicSearch`…`musicDownloadProgress`, `apps/desktop/electron/ipc/contract.ts:65-69`                                      | ✅                          |
| Write-only key custody + env fallback pattern                          | `apps/desktop/electron/ai/ai-config.ts:303-327` (`resolveTwelveLabsKey`, `resolveAsrApiKey`)                                          | ✅                          |
| Settings section with key field, status tone, progress bar             | `apps/web-editor/src/components/SettingsDialog.tsx:588-740` — `SettingGroup`, `Segmented`, `ai-tone`, `ai-progress-track`             | ✅                          |
| **Anything that observes or displays a provider quota**                | —                                                                                                                                     | ❌ **absent**               |
| **Anything that fetches external picture media**                       | —                                                                                                                                     | ❌ **absent**               |
| **Multi-picture-layer preview**                                        | `SUC-P1`                                                                                                                              | ❌ **not started** — see §2 |

### Constraints carried over from the music slice, unchanged

**CSP is not touched.** `apps/desktop/electron/security/media-protocol.ts:139` sets
`connect-src 'self' fp-media: <engineBaseUrl>`; `img-src` and `media-src` already allow
`blob:` and `data:`. Thumbnails and hover previews stream over IPC into `blob:` URLs exactly
as music previews do. **A proposal to add `api.pexels.com` or `images.pexels.com` to
`connect-src` means the slice is wrong** — stop and re-read this section.

**No new dependency.** Node `fetch` in Electron main. An SDK requirement returns to the
maintainer plus `pnpm license:scan` (AGENTS.md §8).

**No schema change.** `Asset.source` is already kind-agnostic. If this plan starts proposing
`SCHEMA_VERSION` 20 → 21, something has gone wrong — re-read §4.

---

## 5. Sequencing

Phases are independently shippable, ordered so stopping early still leaves a coherent
product:

- **P0** is first and alone, because a key field with a live quota readout is
  **independently useful and independently verifiable** — and because everything after it
  spends quota.
- **P1** proves the provider returns usable results before any UI is built.
- **P2** is stoppable: a user can search and preview stock without downloading.
- **P3** is where it becomes a product rather than a demo.
- **P4** is last for the reason the music slice measured: the registry already costs
  ≈16,132 tokens/request after `search_music`/`add_music` (`+370` measured for two
  descriptors). Two more are paid on **every turn of every run**, forever. Pay it for a
  capability a human has confirmed through P2's UI.

**Do not interleave with an open priority-1 editorial defect batch** — same rule as the
sibling plan (`../README.md` §6).

---

## 6. Evidence required to call this done

Not "the search returns results." The bar (`product-discipline.mdc` §4, §8):

- **End-to-end on desktop against a real 5–15 minute screen recording** — not a fixture:
  search → preview → download a stock **video** → place as a cutaway → **export** → the
  rendered file shows the clip, at the right moment, **and the preview showed the same
  thing**. Repeat for a **photo**. Undo removes asset + clip in one step. Reopening the
  project offline still resolves the file.
- **Preview/export parity is asserted, not assumed.** A test that a placed stock clip
  produces a `PictureSegment` sequence identical to what the compiler composites, and a panel
  test that an overlapping placement is **refused with a reason** rather than stacked.
- **The quota readout is real.** Search, then confirm the Settings numbers moved by exactly
  the number of requests made, and that the reset time matches the provider's header.
- **The quota readout is honest when it cannot know.** Before any request: "not measured
  yet". After a 429 the monthly headers do not explain: the hourly-cap state, not a
  contradiction.
- **Failure states are real, not silent** (AGENTS.md §7): no key, 401, 429, quota exhausted,
  provider down, timeout, network drop mid-download, oversized file, disk full. Each produces
  a specific sentence naming what failed.
- **A cancelled or failed download leaves no partial file and no orphan asset.**
- **Security:** a test that `api.pexels.com` never appears in the renderer's `connect-src`,
  and that the API key never crosses the preload bridge.
- **No live network in CI.** Adapter tests run against recorded fixture responses — the
  fixture being a **verbatim live response**, as the Openverse adapter's is.

---

## 7. Task ledger

- [x] **P0** API key custody + live quota surface in Settings. Write-only key
      (`pexelsReady` only crosses the bridge), `StockQuotaStore` with the four honest
      states, `PEXELS_API_KEY` in **both** `.env.example` and `turbo.json`. ADR 0141.
- [x] **P1** Pexels adapter — one file, two endpoints, `chooseVariant`, quota observed
      per response. **One divergence:** the shared `provider-errors.ts` extraction was
      **abandoned** at its own stop condition — the sentences diverge per provider, so
      two small closed unions beat one leaky shared one. Recorded in `stock-types.ts`.
      **Fixtures are documentation-shaped, not live** — see the caveat below.
- [x] **P2** Stock panel — search, grid, hover preview **with cursor scrubbing**, the
      Pexels link in every state.
- [x] **P3** Download → asset → cutaway placement → export. Credits gains a
      **Suggested** group. ADR 0140.
- [x] **P4** `search_stock` / `add_stock`, parity green across TS ↔ Python ↔ MCP,
      digests written, b-roll skill extended. **Token delta measured: 16,626 → 17,041
      = +415 per request**, recorded in the frozen golden manifests.
- [x] **P5** Docs closure: ADR 0140 + ADR 0141, `docs/guides/stock-sourcing.md`,
      configuration + settings guides, privacy page, the reversal note in
      `../DEFERRED-stock-footage-and-sfx.md`, `CHANGELOG.md`.
- [ ] **P5.5** **The real-media evidence runs.** OUTSTANDING — see below.

## What is left, precisely

Two things, and they are the same kind of thing — **a human, a desktop build, a
Pexels key, and real footage**. Neither can be produced from inside the
repository, and no volume of green unit tests substitutes for either
(`product-discipline.mdc` §8).

1. **Run A (P3.8)** — a real 5–15 minute recording: search → hover-scrub → download
   a clip → place as a cutaway → export → **watch it**; repeat with a photo; confirm
   the Settings quota moved by exactly the number of searches made and that the reset
   date matches the provider; confirm Add is refused with its reason over occupied
   time; reopen offline.
2. **Run B (P4.6)** — the same footage, driven by _"add an establishing shot of a city
   skyline before the intro"_, plus the no-key run and the blocked-placement run,
   both of which must fail honestly.

**Plus one correction that needs the same key: the adapter fixtures.** They were
written from the published API documentation because CI has no Pexels key. Every
asserted field is one the docs name explicitly, but the plan's own bar was a
**verbatim live response**, as the Openverse adapter used. Capture one during Run A,
replace the fixtures, and answer `PEXELS-API.md` §5's five open questions in that
file. Until then, treat the response shape as documented-not-observed.

**Last updated:** 2026-08-24
