# Phase 2 — Stock panel: search and preview — `[ ]`

> **Ships:** the user can find stock photos and video, and see them, inside FramePilot.
> **Does not ship:** downloading. Nothing touches the timeline in this phase.
> **Depends on:** Phases 0 and 1.

Phase 2 is deliberately a complete, useful, _stoppable_ unit: an editor can find the shot they
want before Add exists. It also de-risks the expensive part — nobody pays Phase 4's
per-request token cost before a human has confirmed the provider returns usable footage for
this niche, which `../DEFERRED-stock-footage-and-sfx.md` reason #1 says is genuinely in doubt.

---

## P2.1 — The panel

**New:** `apps/web-editor/src/components/StockPanel.tsx`.
**Touch:** `apps/web-editor/src/components/Editor.tsx:105` (`LEFT_TABS`).

Seventh left-rail tab beside Assets / Effects / Transitions / Text / Captions / Sounds, gated
on `isDesktop()` — **absent in the browser build, not present-and-broken**.

Mirror `SoundsPanel.tsx` structurally. It already solved debounced search, stale-dimming,
per-row spinners, roving tabindex, blob lifecycle, and the live region; this is the same
problem in a grid instead of a list. **Read it before writing this.**

Implement **every state in `CONTRACTS.md` §5**, including the ones that are easy to skip:

- **Photos / Videos** as a `Segmented` control — the same component Settings uses at
  `SettingsDialog.tsx:597`. Switching kind re-searches and keeps the query text.
- **Skeleton tiles at real aspect ratio**, derived from nothing (a fixed 3:2) before results,
  then from `width`/`height` once known, so the grid does not reflow when thumbnails land.
- **`avgColor` as the tile placeholder** until the thumbnail blob resolves. The provider sent
  it precisely for this; computing our own would be slower and worse.
- **Results dimmed, not cleared**, while re-searching.
- **Per-tile spinners**, never a whole-grid loading state on a single thumbnail fetch.
- **Load more is a button.** No infinite scroll — every page is a request the user asked for
  (`PEXELS-API.md` §3, and the reason the 200/hour cap is survivable at all).
- **No auto-search on open.** The empty state is a prompt, not a query.

**Tile content.** Photo: dimensions and photographer. Video: duration, the best available
resolution, and photographer. The photographer's name is a link to `creatorUrl` — this is the
"credit our photographers when possible" obligation from `PEXELS-API.md` §4 being discharged
at the cheapest possible moment.

**Hover preview (video).** Plays the low-res preview rendition, muted, on hover **or keyboard
focus**, one at a time, blob revoked on stop and unmount. Honours `prefers-reduced-motion`:
no autoplay, an explicit play control instead. A grid of autoplaying video is the single most
likely thing in this panel to feel cheap — one at a time is not a performance nicety, it is
the difference between a tool and a wall of noise.

**The Pexels attribution link is a permanent element of the panel footer**, not a tooltip and
not a one-time notice: "Photos and videos provided by **Pexels**", linking to pexels.com. This
is what discharges the API guidelines' "prominent link" obligation (`PEXELS-API.md` §4). It is
a compliance requirement, so it gets a test asserting it renders in **every** panel state —
including the no-key and error states, which is exactly when a lazier implementation would
drop it.

**Quota states in the panel.** The low-quota strip, the hourly-limited state, and the
exhausted state per `CONTRACTS.md` §5. These read the same `StockQuotaSnapshot` Settings does,
via the `quota-changed` event — **one source, two surfaces**. A second, panel-local counter
would drift and is exactly the "never decrement locally" rule from `CONTRACTS.md` §3.

**Keyboard and AT** per `CONTRACTS.md` §5: one roving-tabindex tab stop matching
`MediaBin.tsx:307`, labelled input, polite live region for result count and quota changes,
accessible names on icon-only controls, provider `alt` as each tile's accessible name.

**Styling** via existing tokens and `Button` `[data-variant]` (ADR 0028). **No parallel
component language.**

> Watch the Playwright-vs-RTL name-matching trap (`CONTRACTS.md` §5): new `aria-label`s must be
> checked against both suites or a green vitest run will break e2e.

**Tests:** `StockPanel.test.tsx` covering **each row** of the §5 panel matrix, plus keyboard
navigation, the live-region announcement, the reduced-motion branch, and the attribution link
in every state.

---

## P2.2 — Settings link-up

**Touch:** `SettingsDialog.tsx`, `StockPanel.tsx`.

The no-key panel state links to Settings → Stock media, and the Settings section links back to
the panel once a key is configured. Small, and the difference between a first run that
resolves itself and one that dead-ends.

---

## P2.3 — E2E

**New:** `tests/e2e/specs/stock-search.spec.ts`, modelled on
`tests/e2e/specs/music-search.spec.ts` and `visual-embeddings-settings.spec.ts`.

Cover: no key → explanatory panel + Settings link; key set → photo results render; switching
to Videos re-searches; hover preview plays; provider error → the specific sentence; 429 →
the **hourly** sentence while the monthly bar stays healthy; offline → `offline`. Provider is
stubbed at the main-process seam — **no live network.**

---

## P2.4 — Docs

- **ADR:** _"Stock media is fetched in the main process; the provider quota is surfaced."_
  Record the WHY for three decisions: the key is write-only and main-owned (unlike the
  sidecar-forwarded keys); **CSP is untouched because thumbnails ride `blob:`**; and the
  monthly/hourly quota split is displayed as two facts because the provider only reports one
  of them. Keep it proportional — one decision, one page.
- `docs/guides/stock-sourcing.md` — first draft; Phase 3 completes it.
- `CHANGELOG.md`.

---

## Definition of done

- [ ] Photo and video search return results from the real provider through the real adapter
- [ ] **Every** `CONTRACTS.md` §5 panel state renders correctly, one test per row
- [ ] Hover preview plays without a CSP change and without a provider URL reaching the renderer
- [ ] `prefers-reduced-motion` disables autoplay (tested)
- [ ] The Pexels attribution link renders in every panel state (tested — this is a compliance
      requirement, not a styling detail)
- [ ] Quota strip reflects the same snapshot Settings shows, driven by the push event
- [ ] Keyboard-only operation works end to end; result count is announced
- [ ] `pnpm test:e2e` green; typecheck / lint / unit green across ai-sdk, desktop, web-editor
- [ ] ADR + guide draft + `CHANGELOG.md` landed

**Deferred out of this phase:** downloading, timeline placement, the agent tool, curated /
popular browsing, colour and locale filters, favourites, collections.
