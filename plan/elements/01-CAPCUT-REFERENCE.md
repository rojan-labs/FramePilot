# 01 — The CapCut reference

The maintainer asked for Elements to follow CapCut. This file states what CapCut does (with
sources), then what FramePilot copies, adapts, and deliberately skips. Where a detail could not be
confirmed from a source it is marked _unverified_ and the plan does not depend on it.

---

## 1. What CapCut does

### 1.1 Where elements live

- **CapCut Online** keeps a left "material panel" for media, elements, effects and more; its
  Elements include **stock photos and videos** alongside stickers and shapes
  ([capcut.com — How to use CapCut](https://www.capcut.com/resource/how-to-use-capcut),
  [online video editor](https://www.capcut.com/tools/online-video-editor)).
- **CapCut desktop** puts stickers in a **Stickers** tab; basic **shapes** (squares, circles,
  triangles, lines) are reached from the same area and can be resized, recoloured, and have their
  opacity set ([YouTube: How to add shapes in CapCut](https://www.youtube.com/watch?v=VNf__0OKDvA);
  [capcut.com — photo shape editor](https://www.capcut.com/resource/photo-shape-editor)).

### 1.2 The sticker browser

From [Envato Tuts+ — How to add stickers in CapCut](https://photography.tutsplus.com/tutorials/how-to-add-stickers-to-videos-in-capcut--cms-108820)
and [capcut.com — CapCut stickers](https://www.capcut.com/resource/capcut-stickers):

- **Search box above the categories.** Typing a keyword ("checkmark") returns matching stickers.
- **Category buttons across the top**: AI stickers, **Emoji**, **HOT** (trending), then themed sets
  ("fun", "cute", "memes", seasonal), animated icons, logos and graphics further along.
- **Static and animated stickers** in the same grid.
- **Favourites**: a star bookmarks a sticker for later.
- **Adding**: tap or click a tile to add it at the playhead, or drag it onto the timeline; then
  move, resize (corner handles) and rotate it on the preview.
- On the timeline, **stickers are their own coloured bars** (yellow on mobile).

### 1.3 The selected sticker

From [CapCut PC sticker-animation tutorials](https://www.youtube.com/watch?v=B9KJ5VdRjk8) and
[tracking with stickers](https://youtubevideoeditingservices.com/track-objects-stickers-capcut/):

- The right-hand panel for a selected sticker has transform controls, an **Animation** section
  with three groups — **In**, **Out**, **Loop** (fades, slides, bounces, zooms…) with a duration —
  and **Tracking**, which makes the sticker follow a moving object.

### 1.4 Unverified, not relied on

Exact category list and ordering on desktop; the default sticker duration (believed 3 s); whether
stickers download on first use in the desktop app (the web app shows loading spinners on tiles).

---

## 2. What FramePilot copies

| CapCut pattern                                          | FramePilot Elements                                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Elements groups stock media with graphics               | **Elements** tab with **Photos · Videos · Stickers · Shapes** sub-tabs                                                                        |
| Search above category chips                             | One search field per sub-tab, category chips below it, results filter live                                                                    |
| Click a tile → at the playhead; or drag to the timeline | Both. Click places on the front graphics lane at the playhead; drag lands where dropped (EL4, EL6); drop on the monitor at a position is EL11 |
| Animated tiles play on hover                            | Animated stickers play on hover; video tiles keep the existing hover-scrub; both respect `prefers-reduced-motion`                             |
| Favourites                                              | Star on a tile; a **Favourites** chip; plus **Recents** (EL11)                                                                                |
| Stickers are their own coloured bars                    | Element clips get their own clip style on the timeline (sticker thumbnail / shape glyph)                                                      |
| Move, resize, rotate on the preview                     | Existing on-canvas transform handles for stickers; shapes add width/height handles (non-uniform resize)                                       |
| Animation: In / Out / Loop                              | Inspector **Animation** section: In and Out are layer transitions (existing), Loop is a new declarative loop motion (EL7)                     |
| Tracking                                                | "Follow subject" for stickers via `track-follow.ts` (EL11)                                                                                    |
| Shapes recolour, opacity                                | Shape section: fill, stroke, stroke width, dash, corner radius, per-shape knobs; opacity through the existing transform                       |

## 3. What FramePilot adapts

- **A sticker is a file in the project.** CapCut stickers are app resources; a FramePilot project
  must be self-contained and render deterministically in the Python engine, so a sticker is copied
  into the project's media folder on first use and becomes an ordinary `image` asset. It sits in an
  auto-created **Elements** bin folder so it does not clutter the footage view.
- **Shapes are drawn by the export engine.** They are not bitmaps: the engine rasterises them from
  their parameters at the output resolution, so a shape is crisp at any size and recolouring is a
  parameter change, not a new file.
- **Provenance is kept.** Every sticker records its library, licence and credit line (schema v20
  `Asset.source`) so the Credits view can answer "what do I need to credit" at export time.
- **The agent can do all of it** through typed tools that return patches — the part CapCut does
  not have.

## 4. What FramePilot skips (and why)

| CapCut feature                             | Why not                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| AI-generated stickers                      | A generative-image provider is a new subsystem with its own cost, safety and licence surface; not needed for the requested outcome  |
| **HOT** trending GIFs (GIPHY/Tenor-style)  | Rights to user-uploaded GIFs in monetised video are unclear; the product must not walk users into a takedown                        |
| Brand and social logos ("follow us on…")   | Trademarks; the licence of an SVG does not grant the mark                                                                           |
| Templates / compound designs               | A separate product surface (text + shapes + animation groups). Only numbered step badges (one shape + one label) are in scope (EL5) |
| "AI characters" in Elements                | Out of scope for this product niche                                                                                                 |
| Effects, filters and audio inside Elements | FramePilot keeps Effects, Transitions and Sounds as their own tabs, as CapCut desktop does                                          |

**Last updated:** 2026-09-26
