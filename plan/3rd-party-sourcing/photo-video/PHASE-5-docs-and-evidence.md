# Phase 5 — Docs closure and evidence — `[ ]`

> **Ships:** the record. Nothing here is optional, and two items here are the reason the
> earlier phases can be marked `[x]` at all.

The music slice's ledger shows what happens when this phase is skipped: two phases sat at
`[~]` for want of a human at a desktop build with real footage, while every unit test was
green. Plan for it rather than discovering it.

---

## P5.1 — Reverse the deferral, in writing

**Touch:** [`../DEFERRED-stock-footage-and-sfx.md`](../DEFERRED-stock-footage-and-sfx.md).

That file currently reads as a standing decision that stock video is **not planned**. Once
this plan lands, a later agent reading it would find a direct contradiction with shipped code
— exactly the failure the file was written to prevent, pointed the other way.

Add a status banner at the top of its "Stock video / B-roll" section:

> **REOPENED 2026-08-24 by maintainer decision.** See
> [`photo-video/README.md`](./photo-video/README.md) §D1, which records which of the four
> reasons below still hold. Reason #4 (`SUC-P1`) **still holds** and shapes the placement
> design. The **SFX** deferral below is unchanged.

Do not delete the four reasons — they are the record of why it was deferred, and three of them
still constrain the work.

**Also touch:** [`../README.md`](../README.md) — its file table and §2 describe stock as
deferred. Add a pointer to this sub-plan so the two files agree.

---

## P5.2 — ADRs

Proportional — one decision, one page (`.agents/rules/documentation.mdc`). Expect **two**,
possibly three:

1. **"Stock media is fetched in the main process; the provider quota is surfaced."**
   (Authored in Phase 2.) The WHY for: write-only main-owned key; CSP untouched because
   thumbnails ride `blob:`; the monthly/hourly quota split displayed as two facts because the
   provider reports only one.
2. **"Stock picture media is placed as a cutaway, not an overlay."** The WHY: the preview is a
   single-picture-layer engine and the export is not, so stacking would diverge; gated on
   `SUC-P1`; the placement builder refuses rather than falls back. **This is the ADR a future
   agent will look for when they wonder why they cannot stack a clip**, so write it for that
   reader.
3. **Only if the `provider-errors.ts` extraction happened** (P1.1): one paragraph recording
   that the second consumer earned the shared union — or, if it was abandoned, why the
   duplicate was the better trade.

Do not author an ADR for "we chose Pexels" — that is provider research and it lives in
[`PEXELS-API.md`](./PEXELS-API.md).

---

## P5.3 — Guides and changelog

- `docs/guides/stock-sourcing.md` — complete (drafted P2.4, finished P3.9): what it does, how
  to get a key, **what the quota numbers mean and why the hourly cap is not shown**, where
  files land, why a clip cannot be stacked over existing footage yet and what will change
  that, what happens offline, and the Agent-mode section if Phase 4 shipped.
- `docs/guides/configuration.md` + `settings.md` — the key and the quota block.
- `docs/api/` — no change expected. **If one is needed, the schema changed, and this plan said
  it would not.** Treat that as a signal to re-read `README.md` §4 rather than as a docs task.
- `apps/website/src/app/legal/privacy/page.tsx` — the outbound-query sentence.
- `CHANGELOG.md` — user-facing, benefit-first, plain language. Not "added a Pexels adapter".

---

## P5.4 — Environment obligations

The one thing in this plan most likely to be forgotten, so it gets its own checklist item
rather than a mention inside Phase 0:

- [ ] `PEXELS_API_KEY` in root `.env.example`
- [ ] `PEXELS_API_KEY` in `turbo.json` `globalEnv`

A var in one but not the other is a bug (CLAUDE.md §2). The music slice discharged this
**vacuously** — it added no env var. This plan does not have that luxury, and copying the
music slice's "no `.env.example` entry needed" line would be exactly wrong.

---

## P5.5 — The evidence runs

**Neither can be produced from inside the repository, and no volume of green unit tests
substitutes for either** (`product-discipline.mdc` §8). Both need a human, a desktop build,
and real footage.

**Run A — manual (P3.8).** A real 5–15 minute screen recording:

1. Configure a key; confirm Settings shows `unmeasured`.
2. Search photos; confirm the quota block populates and the remaining count drops by exactly
   the number of requests made.
3. Search videos; preview on hover; download one; place as a cutaway.
4. Download a photo; place it.
5. **Export. Watch it.** Both items appear, at the right moments, matching what the preview
   showed.
6. Undo each in one step; redo.
7. Save, close, reopen **offline**: both assets resolve; Credits lists the photographers under
   **Suggested**.
8. Move the playhead over existing footage; confirm Add is disabled **with the reason shown**.

Record: source file, items used, variants chosen, file sizes, quota before/after, and what the
export looked like.

**Run B — agent (P4.6).** Same footage. The three prompts in
[`PHASE-4`](./PHASE-4-agent-tool.md) §P4.6: the working run, the no-key run, and the
blocked-placement run. Record the prompt, the operations produced, and the render.

**Run B only happens if Phase 4 happens** — and Phase 4 is gated on Run A having shown a human
that the results are good enough for an agent to reach for (`PHASE-4` §"Why this is last").

---

## Definition of done

- [ ] `../DEFERRED-stock-footage-and-sfx.md` and `../README.md` no longer contradict shipped
      behaviour
- [ ] ADRs authored (2, or 3 with the error-union decision)
- [ ] `docs/guides/stock-sourcing.md` complete; configuration/settings guides updated; privacy
      line added; `CHANGELOG.md` landed
- [ ] `PEXELS_API_KEY` in **both** `.env.example` and `turbo.json`
- [ ] Run A recorded in the plan snapshot
- [ ] Run B recorded, or Phase 4 explicitly marked not-taken-up with the reason
- [ ] `plan/PLAN.md` updated: the sub-plan entry, the snapshot date, and the registry token
      count if Phase 4 shipped
- [ ] This plan's own ledger (`README.md` §7) reflects reality, including anything still `[~]`
