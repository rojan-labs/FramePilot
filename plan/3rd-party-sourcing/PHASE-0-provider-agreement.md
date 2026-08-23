# Phase 0 — Provider commercial-use agreement — `[ ]`

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

## P0.2 — Openverse — `[ ]`

**Decided: Openverse SHIPS as the free tier** (maintainer, 2026-08-23), not a build-time
scaffold. Accepted knowingly against its uneven aggregate catalogue quality — every user gets
working music search with no key, no second subscription, and no cost to FramePilot.

- [ ] Register an Openverse API key to lift anonymous limits (20/min, 200/day → higher).
      Not required to start.
- [ ] Confirm the audio search endpoint returns what `ProviderTrack` needs:
      `duration`, `license`, `license_url`, `attribution`, `creator`, `creator_url`, `url`,
      `waveform`, `filetype`. (Research says yes.)
- [ ] Confirm commercial-use filtering excludes NC content **server-side**, so an NC track
      never arrives to be mishandled.
- [ ] Confirm Openverse's _"reserves the right to charge fees for commercial uses of the API
      and/or for heavy usage"_ has not become an actual charge. It is a stated risk, and
      Openverse now ships to every user.

---

## P0.3 — Confirm the zero-dependency assumption — `[ ]`

Both providers must be reachable with Node's built-in `fetch` from Electron main. If an SDK
is required, stop: that is a dependency addition needing maintainer approval and
`pnpm license:scan` (AGENTS.md §8, CLAUDE.md §5).

Openverse is plain REST — expected to hold. Verify for Epidemic when its docs are accessible.

---

## P0.4 — Record the plan delta — `[ ]`

One-line note at `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md:22`, beside the "no owned music catalog"
decision, pointing at `README.md` §D1 — so a later agent reads the difference as deliberate
rather than as an accidental reversal (`product-discipline.mdc` §10).

---

## Exit criteria

- [x] Provider set closed at Epidemic + Openverse; alternatives evaluated and parked
- [x] Openverse confirmed as the build **and shipping** provider; P1–P3 unblocked
- [x] "Bring your own music subscription" confirmed as acceptable product shape
- [x] Epidemic free-tier account registered; go-live restriction understood
- [ ] Epidemic paid-tier conversation opened; the P0.1 questions answered
- [ ] Cost-stack question answered before signing
- [ ] Zero-dependency assumption confirmed for whichever provider ships
- [ ] Delta note added to `FRAMEPILOT-AI-PRODUCT-PLAN.md`

---

## Decision note

**2026-08-23 — provider set closed.** Build and ship on **Openverse**; **Epidemic Sound** is
the premium upgrade, evaluated now on the free tier and gated on a paid agreement.
Alternatives (Storyblocks, Soundstripe, Shutterstock, Artlist, Pond5) were researched and
**parked** — see `PROVIDERS.md`. Reopening the provider set is a maintainer decision.

> _(Paid-tier terms to be recorded here when the Epidemic conversation concludes. **P1–P3 do
> not wait for this** — they proceed on Openverse.)_
