# Provider evaluation

> Researched 2026-08-23 against each provider's own documentation. Every claim below carries
> its source. **Re-verify before signing anything** — terms change and this file will age.

---

## The headline finding

**Every candidate gates commercial use.** There is no provider where a paid product can drop
in a free API key and ship. FramePilot is a paid product ($25/mo · $199/yr), so _any_
integration is a commercial use of the API — a separate question from whether the _content_
licence permits commercial output.

Two distinct gates, repeatedly conflated:

| Gate                   | Question                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| **API commercial-use** | May a paid product call this API at all?                         |
| **Content licence**    | May the end user publish/monetize a video containing this track? |

A provider can be permissive on one and restrictive on the other. Freesound is the sharpest
example: CC0 content is maximally free, but the _API_ is non-commercial-only without an
agreement.

---

## Findings

### Epidemic Sound — "ES Connect" Partner API — **recommended primary**

- Purpose-built for exactly this: embedding a licensed catalogue into third-party editing
  platforms. 55,000+ tracks, 250,000+ SFX. Discovery, semantic search, AI soundtracking.
- **Self-serve free tier**, instant API key, full catalogue, no contract or card — _"to
  prototype and evaluate"_. **A paid tier is required to go live.**
- **Licence model is the standout.** Free-tier music grants the end user a _personal_ licence
  (post anywhere, not monetize). A user with their **own active Epidemic Sound subscription**,
  connected through ES Connect, receives a **commercial** licence and can monetize.
- **No attribution required.** Covers mechanical, sync and public-performance rights — the
  rights that actually cause takedowns and copyright strikes.
- Going live is partnership-gated with a custom commercial agreement.

**Why this is the right primary.** It moves the licensing burden to a party whose entire
business is licensing, it is the only candidate with no attribution obligation _and_ real
monetization coverage, and the "user brings their own subscription" model means FramePilot
never resells music. The cost is a business conversation, not an engineering one — and the
free tier means Phases 1–3 can be built and demoed **today**, before that conversation
concludes.

### Openverse — **recommended for build-out, and viable to ship**

- WordPress Foundation's open CC media search. **1M+ CC-licensed audio records.**
- **No API key needed** for basic use (anonymous: 20 req/min burst, 200/day sustained;
  register for higher).
- The audio result shape is unusually well suited to this plan — it already returns
  `duration`, `license`, `license_version`, `license_url`, `creator`, `creator_url`,
  `waveform`, `thumbnail`, `filetype`, and — critically — a **pre-formatted `attribution`
  string**. That is exactly the durable credit the provenance schema needs, supplied by the
  provider instead of assembled by us.
- License filtering supports commercial-use filtering.
- Openverse _"reserves the right to charge fees for commercial uses of the API and/or for
  heavy usage."_ Reserved, not currently levied — but it is a stated risk, not a guarantee.

**Caveat that matters:** it is an **aggregator** (indexing Jamendo, ccMixter, Wikimedia and
others), so quality is wildly uneven and the _underlying source's_ terms still apply to each
item. It is not a curated bed library. Excellent for building and testing the whole pipeline
without any commercial agreement; acceptable to ship for a free tier; not a premium music
experience.

### Freesound — good for SFX later, blocked for music now

- Licences: `Creative Commons 0`, `Attribution`, `Attribution NonCommercial`, filterable via
  `filter=license:…`.
- **Previews (mp3/ogg) need only token auth; full-quality download requires OAuth2** — a
  browser round-trip and token storage, materially more work.
- Limits: 60 req/min, 2,000/day.
- **The blocker:** _"You can use the Freesound API for free only for non-commercial purposes.
  To use the Freesound API for commercial purposes, please contact mtg at upf.edu."_
- `Attribution NonCommercial` must be excluded regardless — FramePilot users monetize.

Catalogue is SFX-dominant, not music beds. **Revisit when SFX is reopened**, not now.

### Jamendo — superseded

- CC-licensed catalogue; `license_ccurl` per track; documented `/v3.0/tracks/` endpoint.
- _"The API may be used freely for non-commercial uses. For any other type of use including
  but not limited to commercial uses, you need to contact Jamendo for a quote."_
- Openverse already aggregates Jamendo, so going direct buys little while adding a second
  commercial negotiation.

### Pixabay — **disqualified for music**

- Its **public API documents images and videos only. There is no music/audio endpoint.**
  Pixabay hosts music on the website, but it is not exposed through the documented API.
- (Its content licence is otherwise attractive — no attribution, commercial use permitted —
  and its rules are worth remembering if stock _video_ is ever reopened: responses must be
  cached 24 h, permanent hotlinking is forbidden, systematic mass downloads are not allowed.)

I would have recommended Pixabay from memory. Checking the docs disproved it — which is why
this file exists.

### AI generation APIs (Mubert, Loudly, AIVA, Soundraw) — noted, not recommended now

Clean commercial terms and no attribution, because the audio is generated rather than
licensed. But generated background music is a **different product decision** — it raises
disclosure/labelling questions the AI product plan already flags as needing sign-off, and
per-generation billing is a different cost model. Out of scope for this plan; worth its own
conversation later.

---

## Recommendation

**Build against Openverse. Ship on Epidemic Sound.**

1. **Now — Openverse.** No key, no agreement, no blocking. It exercises every hard part of
   the pipeline: normalization across a messy aggregate catalogue, licence variety including
   attribution-required items, a real `attribution` string to persist, commercial-use
   filtering, preview URLs. Building here means the adapter, IPC, download, provenance schema
   and UI are all proven before any contract exists.
2. **In parallel — open the Epidemic Sound conversation.** Free-tier key immediately for
   evaluation; start the partnership discussion for going live. Their per-user subscription
   model fits FramePilot's own subscription product cleanly.
3. **When Epidemic lands**, it becomes the default and Openverse remains as the
   no-account/free-tier option. **That is the moment a second provider genuinely exists**,
   and therefore the moment to generalize the adapter — not before
   (`product-discipline.mdc` §5).

This sequencing is what makes the two-provider outcome _earned_ rather than speculative: the
first adapter ships alone, and the abstraction appears only when a real second consumer does.

---

## Decisions — settled 2026-08-23

All four questions this file opened are answered. **Do not reopen without maintainer
sign-off** (`product-discipline.mdc` §10).

1. **Epidemic Sound — yes, evaluate now on the free tier.** The maintainer registered for it
   the same day. Quotas observed on the dashboard: **50 downloads · 100 streams · 50 create
   versions**. Ample for Phases 1–3, which need roughly a dozen downloads to prove the path.
2. **Bring-your-own-Epidemic-subscription — confirmed as the right shape.** It mirrors
   today's bring-your-own-AI-key, the user pays Epidemic directly, and FramePilot never
   resells music or carries a per-track cost.
3. **Openverse SHIPS as the free tier.** Not a scaffold. Every user gets working music search
   with no key, no second subscription, and no cost to FramePilot — accepted knowingly against
   its uneven aggregate catalogue quality.
4. **AI-generated music — later, not now.** Parked, not declined. See the section above.
5. **The provider set is closed at Epidemic + Openverse.** Alternatives were evaluated and
   parked — see below. Do not add a third provider without a decision.

### The constraint that decides the shipping story

**Epidemic's free tier cannot go live.** In their words: _"You can't sublicense or go live
with anything on the Epidemic Sound API Free tier, as the music and sound effects are only
licensed for paid tiers."_ It is licensed for **prototyping and evaluation only**; launching
needs the **Scale** or **Enterprise** tier, both priced by sales with no public rate.

This is why decision 3 matters and is not merely a nicety: **Openverse is what actually ships
to users** until a paid Epidemic tier is signed. One useful detail — _"You don't have to
rebuild any of your prototyping once you upgrade"_, so free-tier work carries over intact.

---

## Alternatives evaluated and parked (2026-08-23)

Researched when the free-tier restriction surfaced, then **parked by decision** — the provider
set is closed at Epidemic + Openverse. Recorded so the work is not repeated if pricing,
quality, or the cost model is ever revisited.

| Provider         | Access                                                                         | Who is licensed                                                     | Cost model                                                                      | Note                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storyblocks**  | Free trial key (unlimited search, 5 downloads/type); production via sales      | **Platform licence covers end users**                               | **Fixed price, unlimited use**                                                  | Strongest category fit — its published API partners are Descript, WeVideo, Magix, Lumen5, Pictory.ai, Biteable, Powtoon, Prezi, LumaTouch. $20,000 indemnification. Covers video + images too, so a future stock-footage reopen needs no second deal |
| **Soundstripe**  | **Self-serve 30-day trial key**, email only, watermarked; production via sales | Platform licence covers end users                                   | Sales-set; reseller agreements available                                        | 116k tracks, positioned "real artists, not stock". REST/JSON:API, token auth, 25 req/s                                                                                                                                                               |
| **Shutterstock** | Self-serve free test account (**no music on free tier**)                       | Platform Licence permits delivering **and reselling** to your users | Publishes structure: Unlimited (flat, 100k tracks) or Pay Per Use (106k tracks) | Most mature API — 118 endpoints, OAuth, strong docs                                                                                                                                                                                                  |
| **Artlist**      | **Account-manager gated, no self-serve**                                       | Not established                                                     | Not published                                                                   | Excellent catalogue; harder to even evaluate than Epidemic                                                                                                                                                                                           |
| **Pond5**        | Sales-gated                                                                    | Custom per partner                                                  | Subscription or pay-as-you-go                                                   | Largest RF catalogue; powers Filmora, ByteDance, Vidmob, Frame.io                                                                                                                                                                                    |
| Uppbeat          | No public API found                                                            | —                                                                   | —                                                                               | —                                                                                                                                                                                                                                                    |

**The trade-off this set represents, if it is ever reopened.** Epidemic's model costs
FramePilot nothing because the user brings their own subscription. Storyblocks, Soundstripe
and Shutterstock license the _platform_, so the user needs no second subscription — better UX,
but the cost becomes a FramePilot COGS line against the $25/mo plan. Storyblocks' fixed-price
model makes that predictable rather than scaling with success, which is what would make it the
first place to look.

---

## Sources

- [Freesound APIv2 overview](https://freesound.org/docs/api/overview.html) · [resources](https://freesound.org/docs/api/resources_apiv2.html) · [terms of use](https://freesound.org/docs/api/terms_of_use.html) · [FAQ](https://freesound.org/help/faq/)
- [Pixabay API docs](https://pixabay.com/api/docs/) · [Pixabay content licence summary](https://pixabay.com/service/license-summary/)
- [Jamendo tracks endpoint](https://developer.jamendo.com/v3.0/tracks) · [Jamendo API licensing](https://help-licensing.jamendo.com/hc/en-us/articles/20699346005661-Jamendo-API)
- [Openverse API terms of service](https://wordpress.github.io/openverse-api/terms_of_service.html) · [Openverse audio API](https://api.openverse.org/v1/audio/) · [Openverse audio milestone](https://make.wordpress.org/openverse/2022/11/16/openverse-now-includes-over-1-million-audio-records/)
- [Epidemic Sound for developers](https://www.epidemicsound.com/business/developers/) · [ES Connect developer portal](https://developers.epidemicsound.com/) · [Epidemic Sound free API tier](https://www.epidemicsound.com/blog/free-api/)
- Parked alternatives: [Storyblocks API](https://www.storyblocks.com/resources/business-solutions/api) · [Storyblocks API partners](https://www.prnewswire.com/news-releases/storyblocks-renews-collaboration-with-innovative-video-editing-platforms-api-partners-302346468.html) · [Soundstripe API](https://www.soundstripe.com/api) · [Shutterstock API pricing](https://www.shutterstock.com/api/pricing) · [Shutterstock licensing docs](https://www.shutterstock.com/developers/documentation/licensing-and-downloading) · [Artlist Enterprise API](https://developer.artlist.io/welcome) · [Pond5 API](https://www.pond5.com/api)
