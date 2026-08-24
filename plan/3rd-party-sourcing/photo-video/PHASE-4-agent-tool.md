# Phase 4 — Agent tool — `[ ]`

> **Ships:** "drop in a shot of a city skyline here" completes in Agent mode and over MCP.
> **Depends on:** Phase 3 shipped **and** a human having confirmed through the Phase 2 UI that
> the provider returns footage worth using for this niche.

---

## Why this is last, and why the bar for starting it is higher than it was for music

Three reasons, two of them measured:

1. **Known token cost.** After `search_music`/`add_music` the registry's descriptor section
   measures **16,132 tokens per request** (`+370` was the measured delta for those two). Two
   more descriptors are paid on **every turn of every run**, forever, including runs that have
   nothing to do with stock.
2. **Backend-first is a known failure mode here.** This repo already carries AI-only
   capabilities with no UI (roll / slip / slide / insert / multicam). Phases 2–3 guarantee the
   human entry point exists first.
3. **`../DEFERRED-stock-footage-and-sfx.md` reason #1 is still true** (`README.md` §D1): for
   SaaS demos and screen recordings, cutting to generic stock is often a _worse_ edit than a
   punch-in on the user's own frame. Giving the agent a stock search it will reach for
   reflexively would make the product's default output worse.

That third reason is a **gate, not a caveat.** Do not start Phase 4 until the Phase 2/3
evidence runs have shown a human that the results are good enough to be worth an agent
reaching for. If they are not, the honest outcome is that Phases 0–3 ship and Phase 4 never
does — and the plan is still complete.

---

## P4.1 — Tool specs

**Touch:** `packages/ai-sdk/src/domain-tools/media.ts` (both tools live here — the registry is
organized by what a tool is _about_, and both of these are about media acquisition).

```
search_stock(query, kind, limit?, orientation?)
    → read/analysis. Returns normalized items. Never downloads. Never mutates.

add_stock(remoteId, kind, atSeconds?)
    → host action → downloads the variant matching the project's resolution, then
      returns the SAME add_asset + add_clip operations the manual path builds.
      Includes Asset.source. FAILS with a stated reason when the playhead position
      already holds picture media (README §2) — it does not stack.
```

**`add_stock` returns operations, not a mutation** (AGENTS.md invariant 5). The download is a
host side effect; the timeline change is a typed, validated, reversible patch — identical to
what P3.3 builds. **Prove it with a test asserting the agent path and the manual path produce
deep-equal timelines**, with the manual ops spelled out independently so a change to the
shared builder cannot make both sides wrong the same way.

**The descriptions carry the editorial judgement, and this is the highest-leverage prompt work
in the plan.** Route the wording through the `lead-prompt-engineer` conventions: video-editor
language, not API language, and short — every word is billed on every request. The description
must say **when not to reach for it**: for screen recordings and product demos, a punch-in or
a reframe of the user's own footage is usually the better cut, and stock is for when the
script genuinely calls for a shot the user does not have. Without that sentence, reason #3
above becomes a shipped defect.

`hostUiOnly` **is** set (reversing this plan's original intent, as the music slice did). These tools execute in the
Electron main process — the provider network and the download path live there and the sidecar
has no route for them — so the standalone MCP server neither advertises nor accepts them.
Desktop Agent mode is unaffected: the flag gates the MCP surface only, exactly as
`professional_*` already relies on. The alternative would have been an MCP tool that is
advertised and then always fails.

Also check `wipe-guard` (`packages/ai-sdk/src/wipe-guard.ts`): confirm `add_stock` is neither
caught by an existing trigger nor in need of a new one, and check its documented non-trigger
list before touching anything there.

---

## P4.2 — Host execution

**Touch:** `packages/ai-sdk/src/sidecar-executor.ts`, `apps/desktop/electron/main.ts`.

Add `hostStockSearch` / `hostAddStock` to `SidecarExecutorOptions`, **mirroring
`hostTranscribe`** (`sidecar-executor.ts:175`, implemented `main.ts:1564`) and the
`hostMusicSearch`/`hostAddMusic` pair beside it. The key and the network I/O stay in main; the
sidecar is not involved and gets no key.

Absent (browser surface, tests) ⇒ the tools fail honestly rather than silently no-op.

---

## P4.3 — Honest degradation

`available` is static in the registry, so a config-gated tool must degrade **at execution
time**, following the ASR/TwelveLabs `no-key` precedent and ADR 0118.

- No key configured → `failed` with "No Pexels API key is configured." Never a fabricated
  result, never `completed_no_changes`.
- Provider error → the `StockErrorCode` sentence from `CONTRACTS.md` §4, surfaced verbatim —
  including the **hourly vs monthly** distinction, so the model reports the right remedy.
- **Quota state reaches the model.** When `remaining` is low, `search_stock`'s result says so,
  so a multi-step run does not burn the user's month on speculative searches. This is the one
  place the quota surface pays off inside the agent loop rather than only in Settings.
- **Blocked placement is a stated failure, not a silent stack** — `add_stock` at an occupied
  playhead fails with the reason and the model can then move on, ask, or pick a different
  time. It must not fall back to a new front layer (`README.md` §2).
- Per ADR 0083, an `add_stock` that produced no operations **fails closed** — it must not
  report success on an unchanged timeline.

**Tests:** a honesty regression test per arm. This is the arm most likely to rot.

---

## P4.4 — Cross-runtime parity

Adding a tool touches several surfaces. Missing one is the standard drift bug — the music
slice's own ledger records that `test_ai_tools.py`'s contract table was the surface the plan
had not listed and the one that caught the omission. Check all of them:

- [ ] TS `TOOL_REGISTRY` — both tools in `domain-tools/media.ts`
- [ ] `registry.py` mirror — `SearchStockArgs` / `AddStockArgs`. **No `handlers.py` arm**:
      these are host tools and the sidecar never sees them
- [ ] Parity fixture regenerated (82 → 84 tools); both guard tests green
- [ ] MCP flows automatically via `buildMcpTools` — verify, do not assume
- [ ] `tool-classification.ts` — `search_stock` revision_independent; `add_stock`
      **timeline_dependent** (a memoized "already added" replayed past an undo would report a
      clip the timeline does not have)
- [ ] `test_ai_tools.py`'s available/mutating contract table
- [ ] **Rebuild the ai-sdk dist** — web-editor and desktop import from built `dist`

---

## P4.5 — Skill

Extend an existing B-roll/media skill in `packages/ai-sdk/skills/*.md` rather than adding a
new one. Ground every recipe in what the tools actually do (`editing-skills-expert`
conventions), and make the skill carry the editorial restraint explicitly: **stock is for a
shot the user genuinely does not have.** A skill that reads as "here is how to add stock"
without saying when not to will undo the work done in the tool description.

---

## P4.6 — Evidence

Per `product-discipline.mdc` §8, judged by the resulting timeline and render, not by tool
calls:

> On the same real 5–15 minute recording used in P3.8: **"add a shot of a city skyline over
> the intro"** → the agent searches, picks, downloads, places → export → the clip is there,
> at the right moment, **and the preview showed the same thing**. Undo removes the run's
> changes.
> With no key configured, the same prompt **fails honestly with a stated reason**.
> With the playhead over existing footage, `add_stock` **fails with the placement reason** and
> the agent says so rather than stacking.

Record the prompt, the resulting operations, the observed render — **and the measured registry
token delta**, read off the frozen golden manifests the same way the music slice's `+370` was.

---

## Definition of done

- [ ] Both tools registered; TS ↔ Python ↔ MCP parity green; dist rebuilt
- [ ] `add_stock` returns operations; the agent path yields a timeline **deep-equal** to the
      manual path (with the manual ops spelled out independently)
- [ ] Every degradation arm stated honestly, never fabricated (tested per arm: absent host,
      provider failure surfaced verbatim, quota exhausted, blocked placement, empty results as
      `warning` not `completed`)
- [ ] Empty/unusable planned mutation fails closed (ADR 0083)
- [ ] The tool description and the skill both say **when not to reach for stock**
- [ ] Registry token delta measured and recorded
- [ ] The three P4.6 evidence runs recorded, including the no-key and blocked-placement runs
- [ ] Unit / typecheck / lint green across every package; `test:e2e` green
- [ ] `docs/guides/stock-sourcing.md` has an Agent-mode section; `CHANGELOG.md` landed

**Deferred:** the agent choosing stock by _mood or content inferred from the footage_ (that is
footage understanding driving a provider query — a different subsystem, `README.md` §D6);
automatic multi-clip B-roll sequences; matching stock colour grade to the project.
