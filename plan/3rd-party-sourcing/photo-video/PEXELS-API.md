# Pexels API — provider research

> Researched 2026-08-24 against Pexels' own documentation. **Re-verify before implementing**
> — terms and quotas change, and this file will age. Where this file and the live API
> disagree, the live API wins and this file gets corrected in the same PR.

---

## 1. Why Pexels, and why only Pexels

The sibling music plan's headline finding was that **every music provider gates commercial
use**. For pictures the situation is materially better, and Pexels is the clearest case:

| Property                         | Pexels                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Photos **and** videos in one API | **Yes** — the only self-serve candidate where one key covers both                                                   |
| Key acquisition                  | Free, instant, self-serve: "Anyone with a Pexels account can request an API key, which you will receive instantly"  |
| Cost                             | Free. "All content is available free of charge."                                                                    |
| Content licence                  | Commercial use permitted; **no attribution legally required** of the end user                                       |
| API obligation                   | Show "a prominent link to Pexels"; credit photographers "when possible"                                             |
| Quota                            | 200 requests/hour and 20,000/month by default; "If you meet our API terms, you can get unlimited requests for free" |
| Quota observability              | **Response headers on every API call** — this is what makes the Settings readout possible                           |

The decisive property for this plan is the last one. A metered key whose meter is invisible
is a support burden; Pexels exposes it, so FramePilot can show it.

### Alternatives, and why they are not in this plan

- **Pixabay** — qualified for pictures (its public API covers images _and_ videos, unlike
  music). It requires 24 h response caching, forbids permanent hotlinking, and forbids
  systematic mass downloads. **The obvious second provider if a second is ever earned**
  (`product-discipline.mdc` §5). Not built now.
- **Unsplash** — photos only, and its API terms are stricter about hotlinking and require
  triggering a download endpoint per use. A second integration for half the coverage.
- **Storyblocks / Shutterstock / Pond5** — evaluated in `../PROVIDERS.md` for music and
  **parked**. All are sales-gated for production and become a COGS line. Their coverage of
  video + images was noted there as a reason to look at Storyblocks first _if_ the cost model
  is ever revisited. Still parked.

**Decision: the provider set for pictures is closed at Pexels.** Do not add a second without
a maintainer decision.

---

## 2. Surface the adapter is written against

**Auth.** `Authorization: <API_KEY>` — a raw header value, **no `Bearer` prefix**. Getting
this wrong produces a 401 that looks like a bad key; the adapter test suite must pin the
exact header shape.

**Endpoints.**

| Purpose      | Method + URL                                   |
| ------------ | ---------------------------------------------- |
| Photo search | `GET https://api.pexels.com/v1/search`         |
| Photo by id  | `GET https://api.pexels.com/v1/photos/:id`     |
| Video search | `GET https://api.pexels.com/videos/search`     |
| Video by id  | `GET https://api.pexels.com/videos/videos/:id` |

Note the video base path is `/videos`, not `/v1/videos`. Curated photos (`/v1/curated`) and
popular videos (`/videos/popular`) exist and are **deliberately not used** — browsing without
a query is a second product surface, deferred (README §3).

**Parameters used by this plan.** `query` (required), `orientation`
(`landscape` | `portrait` | `square`), `size` (`large` | `medium` | `small`), `page`,
`per_page` (default 15, **max 80**). `color` and `locale` exist and are deferred.

`size` means different things on the two endpoints — photos: `large` ≈ 24MP, `medium` ≈ 12MP,
`small` ≈ 4MP; videos: `large` ≈ 4K, `medium` ≈ Full HD, `small` ≈ HD. The adapter must not
share one constant across both.

**Photo response.** `id`, `width`, `height`, `url` (landing page), `photographer`,
`photographer_url`, `photographer_id`, `avg_color`, `alt`, and `src` with sizes
`original`, `large2x`, `large`, `medium`, `small`, `portrait`, `landscape`, `tiny`.

`avg_color` is worth carrying: it is the correct placeholder colour while a grid thumbnail
loads, supplied by the provider rather than computed. `alt` is the accessible name for the
grid tile — the provider supplying real alt text is a gift the panel should not throw away.

**Video response.** `id`, `width`, `height`, `url`, `image` (poster frame), `duration`
(**seconds**, integer), `user` (`{id, name, url}`), plus:

- `video_files[]` — `{id, quality: 'hd' | 'sd', file_type: 'video/mp4' | …, width, height, fps, link}`
- `video_pictures[]` — `{id, picture, nr}`, ordered preview frames

**`video_files` is the whole reason video needs a variant-selection rule** (Phase 1): one
result carries several renditions at different resolutions and frame rates, and picking
`original`-equivalent blindly downloads a 4K file into a 1080p project.

**Pagination.** `page`, `per_page`, `total_results`, and `next_page` / `prev_page` as **full
URLs**. The adapter must not follow `next_page` verbatim without re-checking scheme and host
— it is provider-supplied input like any other.

---

## 3. Rate limits — the contract behind the Settings readout

**Headers, present on API responses:**

| Header                  | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `X-Ratelimit-Limit`     | Total **monthly** request limit                                  |
| `X-Ratelimit-Remaining` | Requests available in the current period                         |
| `X-Ratelimit-Reset`     | **UNIX timestamp** of when the current monthly period rolls over |

**Default quota: 200 requests/hour _and_ 20,000 requests/month.**

### The trap, stated plainly

**Only the monthly quota is in the headers. The hourly cap is invisible.**

A user can be at 19,400 remaining for the month — a healthy-looking bar — and still get a
`429` because they made 201 requests in an hour. If the UI treats the monthly headers as _the_
quota, it will contradict itself at exactly the moment the user needs it to make sense.

So the design obligation, carried into `CONTRACTS.md` §3 and `PHASE-0`:

1. The readout is labelled as the **monthly** quota, explicitly.
2. A `429` is its own state with its own sentence ("You've hit the hourly limit of about 200
   requests. It clears within the hour."), rendered **beside** the monthly bar, never as a
   correction to it.
3. Headers are **observed**, never assumed. Before the first request the state is
   "not measured yet", not a guessed 20,000.
4. Every displayed number carries an "as of" time, because it is a last-observed value and
   goes stale the moment another client uses the same key.

### Consequences for request economics

200/hour is not generous for a typing user. The mitigations, all of which already have
precedent in the repo:

- **Debounce** the search input (300 ms), as the Sounds panel does.
- **Cache in main** keyed by `normalize(query) + kind + page`, TTL 5 min, bounded — the same
  cache that keeps Openverse inside its 20/min anonymous budget.
- **Never auto-search.** No search-as-you-open, no background prefetch, no speculative
  next-page fetch. Every request is one the user asked for.
- Downloads hit `images.pexels.com` / `player.vimeo.com`-style CDN hosts, **not** the API —
  so downloading does not spend search quota. Confirm this during P1 against real responses
  and record the answer; if it turns out downloads _are_ metered, the download flow needs a
  quota check it does not otherwise need.

---

## 4. Licence and API terms

**Content licence.** Free for commercial and non-commercial use; no permission needed;
attribution not required but appreciated. Photographers should be credited "when possible" —
`Photo by <name> on Pexels`.

**API guidelines, which bind FramePilot rather than the user:**

- "Whenever you are doing an API request make sure to show a prominent link to Pexels" —
  either the text "Photos provided by Pexels" or the supplied logo.
- "Always credit our photographers when possible."
- **"You may not copy or replicate core functionality of Pexels"**, explicitly including
  making Pexels content available as a wallpaper app.

That last clause deserves an explicit compliance note rather than a shrug: FramePilot's Stock
panel is a search-and-import surface **inside a video editor**, where the fetched asset is
materialized into an edit. It is not a browsing destination and does not reproduce Pexels'
product. This plan does **not** build curated/popular browsing, collections, or infinite
scrolling of the catalogue — decisions taken for scope reasons in README §3, and which also
keep the integration comfortably on the right side of this clause.

**How the obligations are discharged, concretely:**

| Obligation               | Where it is satisfied                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Prominent link to Pexels | A persistent "Photos and videos provided by **Pexels**" link in the Stock panel footer (Phase 2), plus the Settings section                |
| Credit photographers     | `attribution` / `creator` / `creatorUrl` persisted into `Asset.source`, surfaced in Credits as **Suggested credits** (README §D4, Phase 3) |
| Not replicating Pexels   | No browse-without-query surface; the panel exists to place media on a timeline                                                             |

---

## 5. Open questions to close during P1

These are cheap to answer with one live request each, and each one changes code:

1. **Are CDN download hosts metered?** Do `images.pexels.com` / video file `link` responses
   carry `X-Ratelimit-*`? (§3.)
2. **Does a `429` carry `Retry-After`?** If yes, surface it in the error detail; if no, say
   "within the hour" rather than inventing a number.
3. **Are the rate-limit headers present on error responses (401/429)?** A 429 that still
   reports remaining is a better signal than one that does not.
4. **Exact `video_files` variety for a typical result** — how many renditions, which
   `fps` values, whether `quality` is reliable enough to sort by or whether `height` must be.
5. **Response on an empty query result** — `{photos: [], total_results: 0}` vs an error.
6. **Do the browse endpoints answer in the same envelope?** The panel sends an empty search box
   to `/v1/curated` (photos) and `/videos/popular` (video), and the adapter parses the reply with
   the _search_ envelope schema. The documentation says they match, and the offline tests assume
   it; one live request per endpoint is what turns that into a fact. Also confirm they carry the
   same `X-Ratelimit-*` headers, since a browse now happens on every panel open.

Record the answers in this file, and commit the live responses verbatim as the adapter
fixtures — the same discipline the Openverse adapter used (`openverse-music.ts`).

---

## Sources

- [Pexels API documentation](https://www.pexels.com/api/documentation/)
- [Pexels API — new (key request)](https://www.pexels.com/api/new/)
- [Pexels licence](https://www.pexels.com/license/)
- [Pexels terms of service](https://www.pexels.com/terms-of-service/)
- Sibling research for the parked alternatives: [`../PROVIDERS.md`](../PROVIDERS.md)
