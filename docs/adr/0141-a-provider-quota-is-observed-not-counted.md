# ADR 0141 — A provider quota is observed, not counted

**Status:** accepted
**Date:** 2026-08-24
**Implements:** `plan/3rd-party-sourcing/photo-video` Phase 0
**Related:** ADR 0139 (provider media is fetched in main), ADR 0118 (missing
evidence is stated, not implied)

## Context

Pexels is the first metered provider FramePilot integrates. Openverse, the music
provider, needs no key and no account, so nothing in the product had ever had to
tell a user how much of an allowance they had left.

Pexels' free tier allows **200 requests per hour and 20,000 per month**, and
reports the monthly figures on every API response as `X-Ratelimit-Limit`,
`X-Ratelimit-Remaining` and `X-Ratelimit-Reset`.

Two facts about that shape the design, and both are easy to get wrong.

**The hourly cap is invisible.** Only the monthly window appears in the headers.
A user can be at 19,400 remaining for the month — a healthy-looking bar — and
still receive a `429` because they made 201 requests in an hour.

**The numbers are not ours.** The same API key can be used by another FramePilot
window, another machine, or a script the user wrote last month. Any figure we
hold is a last-observed value, not a live one.

## Decision

**`remaining` is only ever set from a provider response header. No code path
decrements it locally, and no state is inferred that the provider did not
report.**

That produces four snapshot states rather than one number:

| State            | Means                                                |
| ---------------- | ---------------------------------------------------- |
| `no_key`         | No key configured; there is no quota to speak of     |
| `unmeasured`     | Key configured, no request made yet                  |
| `measured`       | A real observation, with the time we saw it          |
| `hourly_limited` | A 429 arrived; the monthly figures are **preserved** |

And three rules the UI is built on:

1. **The label says "Monthly."** A bar labelled just "quota" is a lie waiting for
   the first 429.
2. **Every figure carries an "as of" time.** These are last-observed values, and
   pretending otherwise invites the user to trust a number that moved an hour ago.
3. **`hourly_limited` renders _beside_ the monthly block, never instead of it.**
   A healthy monthly figure and an hourly 429 are both true simultaneously. The
   panel holds both facts rather than picking one and contradicting itself.

`unmeasured` exists so the panel can say "not measured yet — search once to see
your quota" instead of rendering a guessed 20,000 that would be
indistinguishable from a real reading. This is ADR 0118's principle applied to a
number: missing evidence is stated, not implied.

The store lives in Electron main, in its own file (`stock-quota.json`) rather
than in `ai-config.json`, because it is observed telemetry and not configuration:
it changes on the provider's schedule, it is disposable, and a corrupt read must
degrade to "not measured" rather than take the AI provider settings down with it.
It is pushed to the renderer on every observation rather than polled — there is
no remote to poll, since the quota only moves when we ourselves make a request.

## Why not the alternatives

**Keep a local counter.** The obvious implementation, and wrong: it drifts away
from the truth silently while looking authoritative on screen. The first time a
user runs FramePilot on two machines with one key, the number becomes fiction.

**Show one combined "requests left" figure.** There is no such figure. Combining
an observed monthly count with an unobservable hourly one produces a number that
is not true in either window.

**Model the hourly window ourselves.** We would have to invent both its size and
its start, and a fabricated number in a quota readout is worse than an absent
one. `hourly_limited` records that a 429 happened and stops there.

**Poll the provider for a live figure.** A Settings panel that spends quota to
display quota is its own worst enemy.

## Consequences

- The quota display is honest at the cost of being less tidy: two blocks, an
  "as of", and a state that says it does not know. That is the trade.
- A 429 keeps colouring the UI for an hour and then stops on its own, because a
  banner that outlives its window would be a lie about the present. Any
  successful, header-bearing response clears it immediately — direct evidence
  beats a timer.
- Search results are cached in main (5 min TTL), and a cached hit deliberately
  does **not** touch the store: it spent no request, so moving the meter would
  make the readout drift from what the provider actually counted.
- The agent sees the remaining count in `search_stock`'s result when it is known,
  so a multi-step run can stop browsing and commit rather than spending a user's
  month on speculation.
- The same pattern is now available for the next metered provider. It was written
  against one and should be generalized when a second actually arrives, not
  before.
