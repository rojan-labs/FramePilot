# Deferred: stock footage and SFX — `[ ]` not planned

> Written so a later agent reads these omissions as **decisions**, not oversights, and so the
> conditions that would reopen them are explicit rather than a matter of taste.

The maintainer asked about audio **and** stock footage sourcing. This plan builds music only.
Here is why, and what would change it.

---

## Stock video / B-roll — deferred

### Why

**1. For the stated first niche it is often the wrong edit.** The north-star benchmark
(`product-discipline.mdc` §1) is SaaS demos, screen recordings, product videos and
talking-head content. Cutting away from a screen recording to generic stock footage usually
makes that edit _worse_ than a punch-in on the user's own footage — which FramePilot already
does. The best B-roll for this niche is the user's own frame, reframed.

**2. It costs far more than music for less benefit.** Music lands on an existing, tested mix
chain that is currently idle. Stock video would need: large multi-hundred-MB downloads,
video proxy and thumbnail derivation, resolution/aspect/framerate matching against the
project, and — to make clips semantically selectable rather than keyword-guessed — indexing
through TwelveLabs, which is **billable per asset**. That is a subsystem, not a slice.

**3. The product plan already places it later.** `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md:152`
lists generative/sourced b-roll (C15) at **H3**; music sits at H2. Horizon 2 has not started.

**4. Auto B-roll already has an owner elsewhere.** `SUC-P9` in
`plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` covers auto B-roll, gated behind SUC-P1
(multi-layer picture compositing in the preview), which is itself an unstarted hard blocker.
Sourcing stock clips before the preview can composite stacked picture layers would ship
clips the user cannot see correctly.

### What would reopen it

- The niche shifts toward content where stock genuinely helps (travel, lifestyle, faceless
  narration), **or**
- `SUC-P1` lands, so multi-layer picture compositing works in the preview, **and**
- Users are observed hitting the gap in real edits — not assumed to.

**If it is reopened,** the architecture from `CONTRACTS.md` carries over almost unchanged:
the `ProviderTrack` shape generalizes to a `ProviderAsset` with resolution/aspect/framerate,
the main-process fetch and materialization path is identical, `Asset.source` (schema v20)
already carries provenance for any media kind, and `placeAssetPatch` already handles picture
layers. Pixabay would be the candidate to check first — its public API **does** cover video
(unlike music), with a no-attribution licence, though it requires 24 h response caching and
forbids permanent hotlinking and mass downloads. **The generalization should happen then, with a second concrete
consumer in hand — not now** (`product-discipline.mdc` §5).

---

## SFX — deferred

### Why

**1. It is a placement problem, not a search problem.** A whoosh on a transition needs to be
frame-aligned to the cut and gain-matched to the mix. Handing the user a search box for
"whoosh" solves the easy half and leaves the hard half — which is why PRD §6.9 lists
"whoosh sound sync" under transitions, not under media sourcing.

**2. A search API is the wrong shape for it.** SFX libraries are small and reused constantly.
Editors want _the_ whoosh they always use, instantly — not ten candidates to audition. If
this matters later, a **small bundled set** with deterministic placement beats a provider
integration, and it sidesteps licensing entirely.

**3. Confirmed absent, not half-built.** Grepped `whoosh` across `packages/`, `engine/` and
`apps/`: no prior art. Nothing is left dangling by deferring.

**3b. Freesound is the obvious SFX source, and it is gated.** Its API is _"free only for
non-commercial purposes"_; a paid product needs an agreement with MTG/UPF
([`PROVIDERS.md`](./PROVIDERS.md)). That conversation belongs to whenever SFX is reopened,
not to this plan. Epidemic Sound's catalogue also includes 250,000+ SFX, so if the Epidemic
partnership lands, SFX may arrive without a second provider at all.

**4. `auto-SFX` is already tracked, and already blocked.** `plan/PLAN.md:3284` lists advanced
sound (multiband compression, buses, **auto-SFX**) as blocked on the Phase 9.0 dependency
gate. Sourcing SFX here would fork that work.

### What would reopen it

Transition sound design becoming a real user request **and** `auto-SFX` clearing its Phase
9.0 gate — at which point the answer is likely a bundled licensed set plus deterministic
placement, **not** a provider search panel.

---

## Owned/bundled music catalog — still out of scope

Unchanged from `plan/FRAMEPILOT-AI-PRODUCT-PLAN.md:22`. This plan searches a **third party's**
catalog with the user's own key; it does not host, license, or bundle one. See
`README.md` §D1 for the distinction and why it is a deliberate delta rather than a reversal.
