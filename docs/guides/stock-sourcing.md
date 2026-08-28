# Stock photos and video

Search Pexels for a shot you don't have and drop it straight onto the timeline —
without leaving FramePilot, and without a browser round-trip.

Desktop only. Reaching a provider needs the app's main process; in the browser
build the **Stock** tab is not shown at all.

## Before you start: is stock the right answer?

Often it isn't. If you're cutting a screen recording, a product demo, or a
talking head, a punch-in or a reframe of your own footage is usually a better cut
than a generic stock shot — it keeps the edit specific to your material. Stock
earns its place when the script names something you never filmed: a city
exterior, an establishing shot, a texture.

The AI agent is told the same thing, so it won't reach for stock reflexively.

## Getting a key

1. Sign in at [pexels.com/api](https://www.pexels.com/api/new/) and request a
   key. It's free, and you get it instantly.
2. Paste it into **Settings → AI → Stock media**.

What leaves your machine is the words you type in the search box. Nothing about
your project, your footage or your timeline is sent. Files you download are
stored in the project's own media folder, so a project keeps working offline
after the download — nothing is streamed at playback or export.

The key is held by the app itself and is never handed to the editor window. Once
saved, Settings shows **Configured** rather than the value; use **Replace** to
change it or **Clear** to remove it.

## Your quota, and the part of it you can't see

Pexels' free tier allows **200 requests an hour and 20,000 a month**.

Settings shows the monthly figures — remaining, total, when the window resets,
and when FramePilot last saw those numbers:

```
Monthly API quota
18,431 of 20,000 requests left      [████████████████░░]
Resets 1 Sep 2026, 00:00 · in 8 days
As of 2 minutes ago
```

Two things to know about that readout:

**It's the monthly window only.** Pexels doesn't report the hourly one, so
FramePilot can't show it. If you search rapidly you can hit the hourly limit
while the monthly bar still looks healthy — that's not a contradiction, it's two
different limits. When it happens you'll see a separate "Hourly limit" line, and
it clears within the hour.

**It's the last number we saw, not a live one.** If you use the same key
elsewhere, these figures move without FramePilot hearing about it. That's what
the "As of" line is for. Before your first search it says _not measured yet_
rather than showing a guess.

FramePilot is careful with your requests: searches are debounced, results are
cached for five minutes, there's no search-on-open, and "Load more" is a button
rather than infinite scroll. Downloads don't count against the search quota.

## Finding and previewing

Open the **Stock** tab in the left rail and pick **Video** or **Photos** from the
dropdown beside the search box. With the box empty you get Pexels' own feed —
hand-picked photos, most-watched video. Type to search by subject — "city skyline
at dusk", "hands typing" — rather than by mood.

**Hover a video tile to preview it.** Then move your cursor across the tile and
the clip follows: left edge is the start, right edge is the end, with a hairline
marking where you are. It's a scrub, so you can reach a specific moment
immediately instead of waiting for a loop to come round.

If you've asked your system for reduced motion, previews don't play on their own
— but scrubbing still works, because that's motion you're driving.

Each tile shows the length, the exact rendition that will be downloaded, its
size, and the photographer's name (linked to their Pexels page).

## Adding a clip

Put the playhead where you want the shot, then press **Add** on a tile. The file
downloads into your project and lands on the timeline. One undo removes both the
clip and the bin entry.

FramePilot downloads the smallest rendition that still covers your project's
resolution — a 1080p project gets the 1080p version, not the 4K one. That's
usually the difference between a 24 MB download and a 400 MB one.

### What gets built alongside the download

Every downloaded clip is also given a **preview proxy** — a small 540p copy — plus a
filmstrip and, for anything with sound, a waveform. The proxy is what the editor
scrubs and plays; exports always render from the original file, so nothing you ship
loses quality. The difference is large: a 55-clip montage sourced at 4K is about
1.5 GB of originals against roughly 63 MB of proxies, and it is the proxies that
decide whether scrubbing stays smooth or the app runs out of memory.

This is automatic and there is nothing to turn on. If a proxy can't be built (a very
long source, or the engine isn't running), the clip still lands and previews from the
original — slower, but never blocked.

### "There's already footage at the playhead"

Stock media can't yet sit **on top of** existing footage, so **Add** is disabled
whenever the playhead is over a picture clip, and the panel says so.

The reason is worth knowing: FramePilot's preview currently shows one picture
layer at a time, while the export composites stacked layers properly. A clip
placed over your footage would look one way while you edited and different when
you exported. Rather than let that happen, the feature declines.

To place a clip, move the playhead to an empty stretch — after the last clip, or
into a gap you've cut. Picture-in-picture and split-screen with stock will arrive
when the preview can composite stacked layers.

## Credits

Pexels' licence lets you use this media commercially and doesn't require you to
credit anyone. The photographers appreciate it anyway, so the export dialog's
**Credits** section lists them under **Suggested credits**, with a one-click
copy — separate from the **Required** list, which is where genuinely obligatory
credits (such as a CC-BY music track) appear.

FramePilot itself links to Pexels from the Stock panel, which is what their API
terms ask of an app that uses it.

## Agent mode

The AI agent can do this too:

- **`search_stock`** — finds candidates. Downloads nothing.
- **`add_stock`** — downloads one and places it as a cutaway.

Try: _"add an establishing shot of a city skyline before the intro"_.

The agent honours the same rules you do: it can't stack over existing footage and
will say so rather than working around it, and it sees how many requests you have
left so it doesn't spend your month browsing.

With no key configured, both tools fail with a stated reason. They never invent a
result.

## When something goes wrong

Each failure has its own message and its own remedy:

| What you see                          | What to do                                          |
| ------------------------------------- | --------------------------------------------------- |
| "Add your Pexels API key in Settings" | Get a free key (above)                              |
| "Pexels rejected this key"            | Check it in Settings — Replace to paste a fresh one |
| "You've hit the hourly limit…"        | Wait — it clears within the hour                    |
| "You've used this month's allowance"  | Wait for the reset date shown in Settings           |
| "Pexels is not responding"            | Try again shortly                                   |
| "No network connection"               | Downloads you already made are unaffected           |
| "That file is larger than the 2 GB…"  | Pick a smaller size                                 |
| "The download didn't finish"          | Nothing was added; press Retry                      |

A cancelled or failed download leaves nothing behind — no partial file, no orphan
entry in your bin.

You can leave the **Stock** tab while a clip downloads. The progress bar, the
Cancel button and the guard against starting the same download twice are all
still there when you come back, and a failure that happened while you were away
is reported then rather than lost. Downloads do **not** survive quitting the app.

## What this doesn't do

Recorded so their absence reads as a decision:

- **No overlays.** See "There's already footage at the playhead" above.
- **No browsing without a query.** No curated or popular feeds — this is a way to
  find a specific shot for an edit, not a place to browse a catalogue.
- **No colour, orientation or locale filters** in the UI yet.
- **No favourites or collections.**
- **Downloaded stock isn't semantically indexed**, so `search_visual` won't find
  it by content the way it finds your own footage.
- **One provider.** Pexels covers photos and video under one free key; a second
  would be added only if it earned its place.

## See also

- [`music-sourcing.md`](./music-sourcing.md) — the same idea for background music
- ADR 0140 — why stock is placed as a cutaway
- ADR 0141 — why the quota is observed rather than counted
- ADR 0139 — why provider media is fetched in the main process
