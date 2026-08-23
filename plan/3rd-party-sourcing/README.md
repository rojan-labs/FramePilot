# Third-party media sourcing — `[ ]` not started

> **Sub-plan index.** Created 2026-08-23. Owner: maintainer.
> Parent entry: `plan/PLAN.md` → "Third-party media sourcing".

FramePilot can only edit media the user already put on disk. This plan gives it one
outward reach: **background music from a third-party provider, fetched in the Electron
main process and materialized as an ordinary project asset.**

Stock video and SFX are explicitly **deferred** — see
[`DEFERRED-stock-footage-and-sfx.md`](./DEFERRED-stock-footage-and-sfx.md) for why, so a
later agent does not read the omission as an oversight.

## Files

| File                                                                       | What it holds                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `README.md` (this)                                                         | Decision record, scope gate, current state, sequencing                         |
| [`PROVIDERS.md`](./PROVIDERS.md)                                           | Provider research with sources, and the recommendation                         |
| [`CONTRACTS.md`](./CONTRACTS.md)                                           | Typed contracts: provider interface, IPC wire, error taxonomy, UI state matrix |
| [`PHASE-0-provider-agreement.md`](./PHASE-0-provider-agreement.md)         | Commercial-use gate — the one thing that must clear before shipping            |
| [`PHASE-1-provenance-schema.md`](./PHASE-1-provenance-schema.md)           | Asset provenance, schema v20, credits surface                                  |
| [`PHASE-2-search-and-audition.md`](./PHASE-2-search-and-audition.md)       | Search + preview, no download                                                  |
| [`PHASE-3-download-and-place.md`](./PHASE-3-download-and-place.md)         | Download → asset → timeline → export                                           |
| [`PHASE-4-agent-tool.md`](./PHASE-4-agent-tool.md)                         | `search_music` / `add_music` for Agent mode + MCP                              |
| [`DEFERRED-stock-footage-and-sfx.md`](./DEFERRED-stock-footage-and-sfx.md) | What is out of scope and the conditions that would change that                 |

---

## 1. Decision record

Three decisions were taken before this plan was written. Recorded here so later agents do
not silently reverse them (`.agents/rules/product-discipline.mdc` §10).

### D1 — Third-party provider search is a deliberate delta from the "no owned music catalog" decision

`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md:22` states: _"Out of scope for now (explicit): an
owned/bundled music catalog (users import their own audio; beat-sync/duck still work)"_,
restated at lines 169 and 632, with line 580 scoping beat-sync to _imported_ audio.

That decision dropped an **owned** catalog — FramePilot hosting and licensing a library.
It did not rule on **searching a third party's** catalog. The maintainer chose on
2026-08-23 to build the latter. **The earlier decision still stands for an owned catalog.**

> **Action:** when Phase 1 lands, add a one-line delta note at
> `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md:22` pointing here.

### D2 — Attribution-required tracks are supported, and provenance is persisted

**Supersedes the original D2, by maintainer decision 2026-08-23.** The first draft restricted
slice 1 to attribution-free (CC0-equivalent) content specifically to avoid a schema
migration. The maintainer chose the wider scope: **show the licence in the UI and let the
user use any track the provider offers.**

That decision carries a consequence, accepted with it: **a licence badge at search time
cannot discharge an obligation that lands at publish time.** If the only record of "this
track needs crediting, to this person" is a chip in a panel the user closed, the product has
walked them into a violation quietly. So attribution must be **durable** — persisted with the
project and retrievable at export.

Therefore `Asset` gains an optional `source` and `SCHEMA_VERSION` goes 19 → 20 with a
migration — **maintainer-approved as part of this decision** (CLAUDE.md §5). See
[`PHASE-1-provenance-schema.md`](./PHASE-1-provenance-schema.md).

Two things stay refused regardless of provider, because no badge can make them safe:

- **Non-commercial-only licences** (e.g. Freesound `Attribution NonCommercial`) are filtered
  out. FramePilot users monetize; surfacing NC content invites a violation the UI cannot
  prevent.
- **Content whose licence forbids redistributing it** in the form we would store.

### D3 — Stock video and SFX are deferred, not planned-and-postponed

No phase, no schema, no tool. See `DEFERRED-stock-footage-and-sfx.md`.

### D4 — Build on Openverse, ship on Epidemic Sound

Established by research 2026-08-23 ([`PROVIDERS.md`](./PROVIDERS.md), fully sourced).

**Every candidate gates commercial use.** There is no provider where a paid product drops in
a free key and ships. Freesound's API is non-commercial-only without an agreement; Jamendo's
requires a quote; **Pixabay has no music endpoint in its public API at all**.

- **Openverse** — no API key, no agreement, 1M+ CC audio records, commercial-use filtering,
  and a **pre-formatted `attribution` string** per result: exactly what D2 needs to persist.
  Build the whole pipeline here.
- **Epidemic Sound (ES Connect)** — purpose-built for embedding a licensed catalogue into
  third-party editors, no attribution required, and the end user's own subscription confers
  commercial rights. Self-serve free tier to prototype today; partnership to go live.

The second provider is therefore **earned, not speculative**: the adapter generalizes when
Epidemic actually lands, not in anticipation of it (`product-discipline.mdc` §5).

**Settled 2026-08-23 — do not reopen without maintainer sign-off:**

- **Openverse SHIPS** as the free tier, not a build-time scaffold. Accepted knowingly against
  its uneven aggregate catalogue quality.
- **Epidemic's free tier cannot go live** — _"only licensed for paid tiers"_, prototyping and
  evaluation only. Account registered (50 downloads · 100 streams · 50 create versions),
  enough for Phases 1–3. Going live needs Scale or Enterprise, both sales-priced.
- **Bring-your-own-Epidemic-subscription** is the confirmed shape, mirroring
  bring-your-own-AI-key. FramePilot never resells music.
- **The provider set is closed at Epidemic + Openverse.** Storyblocks, Soundstripe,
  Shutterstock, Artlist and Pond5 were evaluated and **parked** — the comparison and the
  cost-model trade-off are recorded in `PROVIDERS.md` so the work is not repeated.
- **AI-generated music** (Mubert, Loudly, Beatoven) is parked, not declined.

---

## 2. Scope gate (`.agents/rules/product-discipline.mdc` §3)

**User outcome.** A creator finishing a 30–90s short gets a licensed music bed onto the
timeline without leaving FramePilot, and the agent can complete "add background music"
instead of dead-ending.

**Current gap.** Honestly stated: **friction, not impossibility.** Dragging in an MP3 works
today. What is genuinely blocked is (a) a large, tested, currently-idle mix chain has no
file to operate on, and (b) the agent cannot satisfy a common instruction at all — every
other creative instruction in the north-star benchmark resolves to a tool; this one does not.

This places the work at priority-order item **3–4** (UX for an existing workflow /
integration), not item 1. It is sequenced accordingly — see §6.

**Minimum vertical slice.** Background music · one provider · manual media-bin search ·
main-process fetch · persisted provenance · no agent tool. Phases 0–3.

**Reuse.** Nearly everything — see §3. Net new code is one provider adapter, three IPC
handlers, one search panel, one download-progress state.

**Deferred scope.** Stock video, SFX, the agent tool (to Phase 4), multi-provider
abstraction, provider registry UI beyond one key field, download queue/resume,
cross-project media cache, favourites/collections, waveform-scrubbing preview, pagination
beyond one page.

**Evidence.** §5.

---

## 3. Grounded current state

Verified 2026-08-23 by direct inspection. **The premise "FramePilot cannot source media" is
correct; the diagnosis "therefore the editing loop is broken downstream" is not.** Only the
_acquisition_ step is missing. Everything after the file exists is built and tested:

| Capability                                                         | Location                                                                                                                                                     | State         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Reversible asset add                                               | `packages/editor-core/src/project-operations.ts:17` — `add_asset` + invert                                                                                   | ✅            |
| Auto-layered placement                                             | `apps/web-editor/src/editor/patch-builders-base.ts:1477` — `placeAssetPatch` (`add_layer`+`add_clip`, invert together)                                       | ✅            |
| Music mixing                                                       | `packages/editor-core/src/operations.ts:242` — `gainDb`, `fadeIn/OutSeconds`, `fadeCurve`, `normalize`, **`duckUnderTrackId`**, `duckAmountDb`               | ✅            |
| Audio roles                                                        | `packages/timeline-schema/src/index.ts:52` — `['dialogue','music','sfx']`                                                                                    | ✅            |
| Beat grid                                                          | `detect_beats`, ADR 0132                                                                                                                                     | ✅            |
| Duration + kind + peaks + proxy + thumbnails from any on-disk path | `POST /asset-media` → `AssetMediaResponse` (`engine/python/framepilot_engine/service.py:348`); client `apps/desktop/electron/media/asset-media-client.ts:41` | ✅            |
| Media written into project sandbox                                 | `apps/desktop/electron/projects/media-import.ts` → `<projectsRoot>/<projectId>/media/`                                                                       | ✅            |
| **Anything that fetches external media**                           | —                                                                                                                                                            | ❌ **absent** |

Grepped `freesound|pixabay|pexels|artlist|epidemic|storyblocks|jamendo|unsplash|royalty-free`
across TS/Py/MD/JSON: **zero hits.** No prior art, no half-built branch.

### Constraints discovered

**CSP forbids the renderer from reaching any provider host.**
`apps/desktop/electron/security/media-protocol.ts:139` sets
`connect-src 'self' fp-media: <engineBaseUrl>`. But `media-src fp-media: blob: data:` and
`img-src 'self' fp-media: blob: data:` — so preview audio and cover art stream over IPC
into `blob:` URLs. **No CSP change is required by this plan, and proposing one is a signal
the slice is wrong.**

**No provenance anywhere.** `AssetSchema` (`packages/timeline-schema/src/index.ts:919`) is
`{id, path, kind, durationSeconds?, media?, folderId?}`. `ProjectSchema` (line 1064) is
strict — no metadata bag. `SCHEMA_VERSION = 19`. No `license` or `attribution` concept
exists in the schema or in `editor-core`.

**No new dependency is needed.** Node `fetch` in Electron main; `httpx` is already an
engine dependency. Any candidate provider that requires an SDK instead of plain HTTP
returns to the maintainer for approval + `pnpm license:scan` (AGENTS.md §8).

### Patterns this plan reuses instead of inventing

| Need                                                   | Established pattern to copy                                                                                                                                                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider abstraction shape                             | `packages/ai-sdk/src/providers/asr-types.ts` — named-union roster + typed interface + one adapter file + injectable `fetch`. **Not a plugin system.**                                                                                                     |
| Key custody                                            | Chat keys are write-only across IPC (`packages/shared-types/src/ipc.ts:438`). `twelveLabs`/`asrApiKey` are deliberately renderer-readable _because the renderer forwards them to the sidecar_. A music key has no such need → **write-only, main-owned.** |
| Host-owned agent tool                                  | `hostTranscribe` — `packages/ai-sdk/src/sidecar-executor.ts:175`, implemented `apps/desktop/electron/main.ts:1564`                                                                                                                                        |
| Streaming download w/ progress, cancel, atomic install | `apps/desktop/electron/capability-packs/service.ts` — copy the **shape**. **Do not reuse Capability Packs themselves:** ADR 0114 packs are immutable FramePilot-controlled ML runtimes, not per-project licensed third-party media.                       |
| Progress wire                                          | `CapabilityPackProgressWire` (`packages/shared-types/src/ipc.ts:1036`)                                                                                                                                                                                    |
| Honest degradation e2e                                 | `tests/e2e/specs/brain-absent-degradation.spec.ts`                                                                                                                                                                                                        |
| Provider-key settings e2e                              | `tests/e2e/specs/visual-embeddings-settings.spec.ts`                                                                                                                                                                                                      |
| Settings section UI                                    | `apps/web-editor/src/components/SettingsDialog.tsx:590` — `SettingsSection` w/ `title`/`description`/`hint`                                                                                                                                               |
| Cache-first, re-billing avoidance                      | the footage-map cache precedent (serve cache first, independent of the remote index)                                                                                                                                                                      |

---

## 4. Provenance is persisted (schema v20)

The first draft avoided the schema change by restricting slice 1 to attribution-free content.
D2 reversed that, so the migration is in scope and approved.

`AssetSchema` (`packages/timeline-schema/src/index.ts:919`) has no provenance field and
`ProjectSchema` (line 1064) has no metadata bag, so there is nowhere to put this except a
versioned field. `Asset.source` is added as **optional** — mirroring how `capabilityPacks`
landed in v19 — so absent stays the correct reading of every pre-v20 project and of every
file the user dragged in themselves.

The migration is a no-op carry-over: nothing to backfill, because no pre-v20 asset has a
source. It is still written and tested, because the migration list is the contract.

**The field is only half of it.** A persisted licence nobody can read is the "backend-only
completion" failure `product-discipline.mdc` §4 names. Phase 1 therefore also ships the
**Credits surface**: every attribution-required asset in the project, its credit line, and a
one-click _copy all credits_. That is the user action the schema exists to serve.

`sources.json` in the project media folder remains as a main-process-owned download ledger —
it is what dedupe reads before fetching. It is **not** a second source of truth for
provenance; the project file is (`product-discipline.mdc` §5).

## 5. Evidence required to call this done

Not "the search returns results." The completion bar (`product-discipline.mdc` §4, §8):

- **End-to-end on desktop, against a real 5–15 min screen recording** — not a tiny fixture
  (§8 forbids that for a media claim): search → audition → download → asset appears with a
  real waveform and proxy → placed on a `music`-role track → `adjust_audio` ducks it under
  dialogue → **the exported render has the music audible and ducked** → one undo removes
  asset + layer + clip → reopening the project offline still resolves the file.
- **Failure states are real, not silent** (AGENTS.md §7 — no silent catch): no key, 401,
  429, provider down, timeout, network drop mid-download, disk full. Each produces a
  specific message naming what failed and why.
- **A cancelled or failed download leaves no partial file and no orphan asset.**
- **Attribution survives the round trip:** download an attribution-required track, save,
  reopen — the Credits view still names the creator and the licence, and copies the credit
  line. This is the D2 obligation; if it does not hold, the feature is unsafe, not incomplete.
- **Non-commercial licences never reach the user.** Asserted by test, not by filter config.
- **Security:** a test asserting the provider host never appears in the renderer's
  `connect-src`, and the API key never crosses the preload bridge.
- **No live network in CI.** Adapter tests run against recorded fixture responses with an
  injected `fetch`.

---

## 6. Sequencing

`product-discipline.mdc` §2 ranks integrations below finished-edit quality, and `plan/PLAN.md`
snapshots for 2026-08-21/22 show consecutive captured agent runs each surfacing new
priority-1 editorial defects (letterboxed reframes passing the gate, crop preview/render
divergence, colour grade delivered on 1 of 47 clips, the beat grid vetoing valid montages).
Those specific defects are marked `[x]`, but the loop is still actively generating
priority-1 work.

**Therefore:** this plan is picked up when the current captured-run defect batch closes, and
is not interleaved with it. Each phase is independently shippable; stopping after Phase 3
leaves a complete, useful product with no dangling scaffolding.

**P0 does not block the build.** Openverse requires no agreement, so P1–P3 proceed while the
Epidemic Sound conversation runs in parallel. P0 gates _shipping on a paid catalogue_, not
writing the code.

**Known cost of Phase 4, decided in advance:** the tool registry is already 78 descriptors
≈ **15,710 tokens per request** (`plan/PLAN.md:118`). Two more descriptors are paid on every
turn of every run. That is why Phase 4 comes after a human has confirmed, through Phase 2's
UI, that the provider actually returns usable tracks.

---

## 7. Task ledger

- [ ] **P0** Provider commercial-use agreement → `PHASE-0-provider-agreement.md`
      _(Openverse needs none — P0 does not block P1–P3 on the Openverse path)_
- [x] **P1** Asset provenance, schema v20, credits surface → `PHASE-1-provenance-schema.md`
- [ ] **P2** Search + audition, no download → `PHASE-2-search-and-audition.md`
- [ ] **P3** Download → asset → timeline → export → `PHASE-3-download-and-place.md`
- [ ] **P4** Agent tool + MCP parity → `PHASE-4-agent-tool.md`
- [ ] **P5** Docs closure: ADRs, guides, `.env.example` + `turbo.json`, privacy page, delta
      note at `FRAMEPILOT-AI-PRODUCT-PLAN.md:22`, `CHANGELOG.md` (obligations listed per phase)

**Last updated:** 2026-08-23
