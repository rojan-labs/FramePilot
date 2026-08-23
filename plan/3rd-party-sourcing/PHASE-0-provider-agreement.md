# Phase 0 — Provider commercial-use agreement — `[~]` Openverse closed · Epidemic outstanding

> **Gates shipping on a paid catalogue. Does not gate writing the code.**
> Provider research is **done** and the provider set is **closed at Epidemic + Openverse** —
> see [`PROVIDERS.md`](./PROVIDERS.md), fully sourced, 2026-08-23. What remains is one
> commercial conversation, not an investigation.

---

## What the research established

**Every candidate gates commercial use of the API**, separately from whether the content
licence permits commercial output. FramePilot is a paid product, so any integration is a
commercial API use.

| Provider           | API commercial use                                                                     | Verdict                                           |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Openverse**      | Free; fees _reserved_ for commercial/heavy use, not currently levied                   | ✅ **Build here now.** No agreement, no key       |
| **Epidemic Sound** | Free tier self-serve for prototyping; **paid tier required to go live**                | ✅ **Ship here.** Partnership conversation needed |
| Freesound          | _"free only for non-commercial purposes"_ — commercial needs an agreement with MTG/UPF | ⏸ Revisit for SFX                                 |
| Jamendo            | Non-commercial free; commercial needs a quote                                          | ❌ Superseded — Openverse aggregates it           |
| Pixabay            | —                                                                                      | ❌ **No music endpoint in the public API**        |

---

## P0.1 — Epidemic Sound — `[x]` registered · `[ ]` paid-tier conversation

**Free-tier account registered 2026-08-23.** Observed quotas: **50 downloads · 100 streams ·
50 create versions** — ample for Phases 1–3.

**The free tier cannot go live.** Epidemic: _"You can't sublicense or go live with anything on
the Epidemic Sound API Free tier, as the music and sound effects are only licensed for paid
tiers."_ Prototyping and evaluation only; launching needs **Scale** or **Enterprise**, both
sales-priced. Prototype work carries over on upgrade — no rebuild.

**Openverse therefore ships (D4/decision 3), and this phase gates only the paid upgrade.**

Confirm before committing to a paid tier:

- [x] **Bring-your-own-subscription confirmed as the product shape** (maintainer,
      2026-08-23) — mirrors bring-your-own-AI-key. Still verify with Epidemic that a user's
      own active subscription connected through ES Connect is what confers the **commercial**
      licence, and that free-tier music is only a _personal_ licence.
- [ ] **The cost-stack question.** On Scale, does FramePilot pay per download/stream or a flat
      platform fee — and does the user's own subscription offset it? If it is per-unit _on top
      of_ requiring the user to subscribe, FramePilot pays for access to a catalogue the user
      is also paying for. Pin this down before signing.
- [ ] Auth model for connecting a user's subscription (OAuth flow shape, token storage).
- [ ] Pricing / revenue model for the partner tier.
- [ ] Whether downloaded files may persist in the user's project **after** their subscription
      lapses. If not, that contradicts "the project keeps working offline" and needs a
      designed answer, not a surprise.
- [ ] Rate limits, as numbers.
- [ ] Whether FramePilot must display Epidemic branding or attribution _to Epidemic_ (as
      distinct from to an artist).

**Product question for the maintainer, not the vendor:** "bring your own music subscription"
parallels today's "bring your own AI key" and is consistent with how FramePilot already
works — but it is a real friction step. Confirm it fits before signing.

---

## P0.2 — Openverse — `[x]`

**Decided: Openverse SHIPS as the free tier** (maintainer, 2026-08-23), not a build-time
scaffold. Accepted knowingly against its uneven aggregate catalogue quality — every user gets
working music search with no key, no second subscription, and no cost to FramePilot.

- [x] **No key registered, and none is used.** Anonymous limits (20/min, 200/day) are lived
      within by the in-main search cache instead. Openverse's optional auth is an OAuth2
      client-credentials exchange, not a bearer key — so the planned key field was not built.
      See the divergence note in `PHASE-2-search-and-audition.md` and ADR 0139.
- [x] **Endpoint confirmed against the live API, 2026-08-23.** `GET /v1/audio/` returns
      `id`, `title`, `duration`, `url`, `filetype`, `license`, `license_url`, `attribution`,
      `creator`, `creator_url`, `foreign_landing_url`. Two findings the research did not
      have: **`duration` is in MILLISECONDS**, and Jamendo-sourced records report
      `filetype: "mp32"` (Jamendo's 96 kbps quality code, not a container) — both normalized
      at the adapter, both covered by tests against the recorded response.
- [x] **Server-side commercial filtering confirmed empirically.** An unfiltered `piano`
      page returned `by-nc-sa` and `by-nc-nd`; the same query with
      `license_type=commercial` returned none. The adapter filters again on the way in
      anyway — a query-string parameter is not a guarantee.
- [x] Openverse's fee reservation has **not** become an actual charge as of 2026-08-23.
      It remains a stated risk, now carried by every user, and is worth re-checking
      periodically rather than assumed settled.

---

## P0.3 — Confirm the zero-dependency assumption — `[x]` for Openverse

Both providers must be reachable with Node's built-in `fetch` from Electron main. If an SDK
is required, stop: that is a dependency addition needing maintainer approval and
`pnpm license:scan` (AGENTS.md §8, CLAUDE.md §5).

**Confirmed for Openverse, 2026-08-23.** Plain REST over Node's built-in `fetch` from
Electron main; no SDK, no dependency added anywhere in this work. Still to verify for
Epidemic when its docs are accessible.

---

## P0.4 — Record the plan delta — `[x]`

**Done.** The note is in place beside the "no owned music catalog" decision in
`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md`, pointing at `README.md` §D1 and ADR 0139, and states
plainly that the earlier decision still stands for an _owned_ catalog.

---

## Exit criteria

- [x] Provider set closed at Epidemic + Openverse; alternatives evaluated and parked
- [x] Openverse confirmed as the build **and shipping** provider; P1–P3 unblocked
- [x] "Bring your own music subscription" confirmed as acceptable product shape
- [x] Epidemic free-tier account registered; go-live restriction understood
- [ ] Epidemic paid-tier conversation opened; the P0.1 questions answered
      — **MAINTAINER-BLOCKED.** This is a commercial conversation with a vendor; it
      cannot be closed from inside the codebase. It gates only shipping on a _paid_
      catalogue, and P1–P4 shipped on Openverse without it, exactly as planned.
- [ ] Cost-stack question answered before signing — same, blocked on the above
- [x] Zero-dependency assumption confirmed for the provider that ships (Openverse):
      plain REST, Node `fetch`, no SDK, no new dependency
- [x] Delta note added to `FRAMEPILOT-AI-PRODUCT-PLAN.md`

---

## Decision note

**2026-08-23 — provider set closed.** Build and ship on **Openverse**; **Epidemic Sound** is
the premium upgrade, evaluated now on the free tier and gated on a paid agreement.
Alternatives (Storyblocks, Soundstripe, Shutterstock, Artlist, Pond5) were researched and
**parked** — see `PROVIDERS.md`. Reopening the provider set is a maintainer decision.

> _(Paid-tier terms to be recorded here when the Epidemic conversation concludes. **P1–P3 do
> not wait for this** — they proceed on Openverse.)_
