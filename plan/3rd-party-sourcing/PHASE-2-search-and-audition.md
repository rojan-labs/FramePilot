# Phase 2 — Search and audition — `[ ]`

> **Ships:** the user can find music and hear it inside FramePilot.
> **Does not ship:** downloading. Nothing touches the timeline in this phase.
> **Depends on:** Phase 1 (provenance schema), so an added track can record its licence.
> **Not blocked by Phase 0** — Openverse needs no agreement (D4).

Phase 2 is deliberately a complete, useful, _stoppable_ unit: an editor can audition tracks
and decide what they want even before Add exists. It also de-risks the expensive part —
nobody pays Phase 4's per-request token cost before a human has confirmed this provider
returns tracks worth using.

---

## P2.1 — Provider adapter — `[ ]`

**New:** `packages/ai-sdk/src/providers/music-types.ts`, one adapter file, and a
`createMusicProvider` factory. Shapes in `CONTRACTS.md` §1.

Copy the structure of `packages/ai-sdk/src/providers/asr-types.ts` — named-union roster,
typed interface, injectable `fetch`. **One adapter. No registry, no plugin layer, no
`@framepilot/media-providers` package** (`product-discipline.mdc` §5).

- Zod-parse the provider response at the boundary; all provider input is untrusted.
- Normalize duration to seconds, licence to a single identifier, and set both
  `attributionRequired` and `commercialUse` — the adapter is where provider vocabulary dies.
- **Filter out non-commercial-only results server-side** where the provider supports it
  (Openverse does), and defensively at the boundary regardless. An NC track must never reach
  the UI to be mishandled (D2).
- Carry `attribution`, `creator`, `creatorUrl`, `licenseUrl`, `sourceUrl` through verbatim —
  these become `Asset.source` in Phase 3 and the Credits line the user copies.
- Reject any `downloadUrl`/`previewUrl` that is not `https:`.
- Map transport and status failures onto `MusicErrorCode` (`CONTRACTS.md` §4).
- Scoped logging via `createLogger('ai-sdk:music-provider')`; **never log the key or a
  signed URL** (AGENTS.md §7).

**Tests:** recorded fixture responses + injected `fetch`, **no live network in CI**.
Cover: normal results, empty results, 401, 429, 5xx, timeout, malformed JSON, a result
missing duration, an attribution-required result (**kept**, with its credit line intact), a
non-commercial result (**dropped**), and a non-https URL being rejected.

---

## P2.2 — Key storage — `[ ]`

**Touch:** `apps/desktop/electron/ai/ai-config.ts`, `packages/shared-types/src/ipc.ts`.

- Add a **write-only** `musicApiKey` following the chat-key precedent — **not** the
  renderer-readable `twelveLabs`/`asrApiKey` precedent (`CONTRACTS.md` §2 explains why).
- `resolveMusicApiKey()` mirroring `resolveAsrApiKey()` (`ai-config.ts:311`), env fallback
  `FRAMEPILOT_MUSIC_API_KEY`.
- `AiConfig` gains `musicProviderReady: boolean` only.
- **Same change:** root `.env.example` (near `TWELVELABS_API_KEY`, ~line 98) **and**
  `turbo.json` `globalEnv` (CLAUDE.md §2 — a var in one but not the other is a bug).

**Tests:** extend `ai-config.test.ts` — file value wins over env, key round-trips, clearing
works, and **`toAiConfig()` never returns the key**.

---

## P2.3 — IPC: search and preview — `[ ]`

**Touch:** `apps/desktop/electron/ipc/contract.ts`, `preload.cts`, `main.ts`,
`packages/shared-types/src/ipc.ts`.

- `framepilot:music:search` and `framepilot:music:preview` (`CONTRACTS.md` §2).
- Main holds the key and does the fetching. **The renderer never receives a provider URL** —
  it addresses tracks by `remoteId`. This makes the CSP guarantee structural.
- Preview returns bytes; the renderer wraps them in a `blob:` URL, which
  `media-src ... blob:` already permits. **No CSP change.** A proposal to add a provider host
  to `connect-src` means the slice is wrong — stop and re-read `README.md` §3.
- Search cache in main per `CONTRACTS.md` §6 (5 min TTL, 50 entries). Preview LRU ~20 MB.
- Both honour an `AbortSignal`; a superseded search is cancelled, not just ignored.
- Bridge methods are optional (`?:`) so the browser build type-checks.

**Tests:** handler unit tests with a stubbed provider — cache hit avoids a second provider
call; abort cancels in flight; every `MusicErrorCode` arm maps to its wire error; **an
explicit assertion that no wire payload contains `previewUrl`/`downloadUrl` or the key.**

---

## P2.4 — Settings — `[ ]`

**Touch:** `apps/web-editor/src/components/SettingsDialog.tsx`.

Reuse the existing `SettingsSection` (`title`/`description`/`hint`) at line 590. One
password-type key field, a ready indicator, and a hint naming what the key is used for and
that searching sends the query text to the provider. **No new settings framework.**

**Tests:** `SettingsDialog.test.tsx` — field renders, saves, clears, shows ready state.

---

## P2.5 — Sounds panel — `[ ]`

**New:** `apps/web-editor/src/components/SoundsPanel.tsx`.
**Touch:** `apps/web-editor/src/components/Editor.tsx:105` (`LEFT_TABS`).

Sixth left-rail tab beside Assets/Effects/Transitions/Text/Captions, gated on `isDesktop()`
— **absent in the browser build, not present-and-broken**.

Implement **every state in `CONTRACTS.md` §5**, including the ones that are easy to skip:
attribution-required rows shown-and-disabled with the reason rather than filtered away;
skeletons at real row height so nothing shifts; per-row preview spinners that do not put the
whole list into a loading state; results dimmed rather than cleared while re-searching.

Audition: one track at a time, play/pause per row, blob URL revoked on stop and unmount.

Keyboard/AT per `CONTRACTS.md` §5 — one roving-tabindex tab stop matching the existing bin
grid pattern (`MediaBin.tsx:307`), labelled input, polite live region for result count,
accessible names on icon-only controls. Styling via existing tokens and `Button`
`[data-variant]` (ADR 0028) — **no parallel component language**.

**Licence legibility is the point of this phase's UI, per D2.** Every row is labelled —
"Credit required · <creator>" linked to the licence text, or "No credit needed". Neither
state is silent, because an unlabelled row reads as "unknown", which is the one thing a
licence badge must never mean.

**Tests:** `SoundsPanel.test.tsx` covering **each row of the §5 matrix**, plus keyboard
navigation and the live-region announcement. Watch the Playwright-vs-RTL name-matching trap
noted in `CONTRACTS.md` §5.

---

## P2.6 — E2E — `[ ]`

**New:** `tests/e2e/specs/music-search.spec.ts`, modelled on
`visual-embeddings-settings.spec.ts` (provider-key settings) and
`brain-absent-degradation.spec.ts` (honest degradation).

Cover: no key → explanatory panel + Settings link; key set → results render; audition plays;
provider error → specific message; offline → `offline` message. Provider is stubbed at the
main-process seam — **no live network**.

---

## P2.7 — Docs — `[ ]`

- **ADR** (next free number after Phase 1's): _"Provider media is fetched in the main process."_
  Record the three decisions with their WHY: key stays in main (write-only, unlike the
  sidecar-forwarded keys); **CSP is untouched because previews ride `blob:`**; Capability
  Packs are deliberately not reused (ADR 0114 packs are immutable FramePilot-controlled
  runtimes, not per-project licensed media). Keep it proportional — one decision, one page.
- `docs/guides/configuration.md` + `settings.md`: the new key.
- `apps/website/src/app/legal/privacy/page.tsx`: it currently promises _"your media stays on
  your machine."_ Still true — outbound is a text query only — but the page should say so
  rather than leave a reader to infer it.
- `CHANGELOG.md`.

---

## Definition of done

- [ ] Search returns normalized results from the real provider, in the app, on desktop
- [ ] Audition plays without a CSP change and without a provider URL reaching the renderer
- [ ] **Every** `CONTRACTS.md` §5 state renders correctly — no unexplained spinner, no layout
      shift as results land, no state that only exists in the happy path
- [ ] Keyboard-only operation works end to end; result count is announced
- [ ] Key never crosses the preload bridge (asserted by test)
- [ ] Provider host absent from renderer `connect-src` (asserted by test)
- [ ] `pnpm verify` green; `pnpm test:e2e` green
- [ ] ADR + guides + privacy line + `.env.example` + `turbo.json` + `CHANGELOG.md` landed

**Deferred out of this phase:** downloading, timeline placement, the agent tool, pagination,
favourites, waveform scrubbing, multi-provider anything.
