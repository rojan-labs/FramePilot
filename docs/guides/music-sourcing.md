# Music sourcing

Search a third-party catalogue for a background track, hear it, and drop it on
the timeline without leaving FramePilot.

**Desktop only.** Reaching a music provider needs the Electron main process —
the browser build's security policy forbids the renderer from contacting an
outside host, deliberately. In the browser the **Sounds** tab is simply absent
rather than present and broken.

---

## Using it

1. Open the **Sounds** tab in the left rail (below Captions). It opens on a list
   of openly-licensed tracks you can play straight away, rather than an empty
   panel waiting on a search.
2. Search by **mood or instrument** — "calm piano", "driving synth", "warm
   acoustic". This is a catalogue of openly-licensed production music, so a song
   title returns nothing useful.
3. Press play on a row to hear it. One track plays at a time; starting another
   stops the first.
4. **Add** downloads the track into your project and puts it on its own music
   track at the start of the timeline.

Undo removes the track, its layer and the bin entry in one press. The
downloaded file stays on disk — you can place it again from the media bin.

## Licences, and what they ask of you

Every row is labelled. There is no unlabelled state, because "unknown" is the
one thing a licence badge must never mean.

| Label                             | What it means                                                            |
| --------------------------------- | ------------------------------------------------------------------------ |
| **No credit needed**              | Public-domain or CC0. Use it however you like.                           |
| **Credit required · \<creator\>** | Usable, including in monetized video, as long as you credit the creator. |

Both are safe for sponsored and monetized video: **non-commercial tracks are
never shown**. They are filtered out before results reach you, because no badge
in a panel you closed can stop a track ending up under a sponsored edit.

Tap the licence label on any row to read the actual terms.

### Where your credits live

When you add a track that requires a credit, FramePilot **saves the credit line
with the project** — not just in the search panel. Open **Export** and there is
a **Credits** section listing every track that needs one, with a **Copy all
credits** button that puts them on your clipboard ready to paste into a video
description.

This is the point of the whole feature. A badge helps you _choose_ a track; the
obligation lands weeks later when you publish, and by then the panel is long
closed. If nothing in your project needs crediting, the section says so, so you
do not have to go and check.

## Where files land

Downloaded tracks go in the same folder as media you import yourself:

```
<projects folder>/media/<project>/
```

They are ordinary project assets from that point on. **Reopening the project
offline resolves them normally** — nothing is streamed from the provider at
playback or export time. A `sources.json` alongside them records what has been
downloaded, so adding the same track twice never re-downloads it.

## In Agent mode

Ask for it in words:

> add calm background music under the voice

The agent searches, picks a track, downloads it, places it on a music track, and
ducks it under your dialogue. If the track it chose requires a credit, it says
so and tells you where to find it.

Two tools do this: `search_music` finds candidates and changes nothing;
`add_music` downloads one and places it. They are also available over MCP, so an
external agent driving a desktop session can use them.

## The provider

FramePilot ships with **Openverse**, which aggregates over a million openly
licensed audio records. It needs **no API key and no account** — search works
out of the box.

Openverse serves anonymous callers a limited number of searches per minute, so
results are cached for five minutes. If you search quickly enough to hit that
limit, you will see "Too many searches in a row" rather than a silent failure.

Because Openverse aggregates many upstream sources, catalogue quality is uneven.
That is a known and accepted trade-off for a free tier that costs you nothing
and requires no second subscription.

## When something goes wrong

Every failure names what actually happened rather than saying "something went
wrong":

| You see                                          | What happened                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| No network connection.                           | The machine is offline.                                            |
| The music provider is not responding.            | The provider is down or erroring.                                  |
| Too many searches in a row.                      | Rate limit. Wait a moment.                                         |
| The music provider took too long to answer.      | Request timed out.                                                 |
| Not enough disk space to save this track.        | The download could not be written.                                 |
| The download didn't finish. Nothing was added.   | The file arrived truncated.                                        |
| Saved the track, but couldn't read its waveform. | The file is fine and usable; only the waveform drawing is missing. |

A cancelled or failed download **leaves nothing behind** — no partial file and
no half-added asset. Downloads never retry themselves: a silent retry on a
metered service would spend your quota without asking.

You can leave the **Sounds** tab while a track downloads. The progress bar, the
Cancel button and the guard against starting the same download twice are all
still there when you come back, and a failure that happened while you were away
is reported then rather than lost. Downloads do **not** survive quitting the app.

## Which licences you will see

Every result is cleared for **commercial, monetized** video, and cleared for the kind of
editing FramePilot does to it. Only four licence families appear: **CC0**, **Public Domain
Mark**, **CC BY** and **CC BY-SA**. The first two need no credit; the last two do, and the
result says which.

Two exclusions are deliberate and stricter than the provider's own filter:

- **Non-commercial (`CC BY-NC*`) tracks never appear.** No badge makes one safe in a
  sponsored video.
- **No-derivatives (`CC BY-ND`) tracks never appear either**, even though Openverse
  classifies them as commercial. ND restricts _derivative works_, and ducking a bed under
  your narration and automating its level is arguably one. Rather than ship that question
  as a caveat you would have to read, those tracks are simply not offered.

## What is not here

- **Sound effects.** Deferred by decision, not oversight — see
  `plan/3rd-party-sourcing/DEFERRED-stock-footage-and-sfx.md`.
  (**Stock photo and video are no longer deferred** — they ship in this release;
  see [Stock photos and video](./stock-sourcing.md).)
- **Burned-in on-screen credits.** Credits are copyable text for a description;
  compositing them into the video is a separate design problem.
- **Favourites, collections, pagination, waveform scrubbing.** Not built.

## Related

- [`docs/adr/0138-asset-provenance-is-persisted.md`](../adr/0138-asset-provenance-is-persisted.md)
  — why the licence is stored in the project rather than shown once.
- [`docs/api/timeline-schema.md`](../api/timeline-schema.md) — the `Asset.source`
  field.
- [`docs/guides/ai-sidebar.md`](./ai-sidebar.md) — Agent mode.
