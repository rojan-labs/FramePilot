# 02 — UX specification

Desktop first (CLAUDE.md product focus). Styling follows the token-driven `styles.css` and the
`[data-variant]` Button conventions (ADR 0028); no new visual language. Copy is plain and short,
written for editors, not engineers.

---

## 1. The left rail

- **Tab:** `Elements`, icon `Shapes` (lucide), tooltip "Elements — photos, videos, stickers,
  shapes". Replaces `Stock`.
- **Position:** second, directly after **Assets** (MD-E7; CapCut's Media → Elements order). The
  others keep their relative order: Assets · **Elements** · Effects · Transitions · Text · Captions ·
  Sounds.
- **Persistence:** the saved `leftTab` value `'stock'` opens Elements (alias in `coerceLeftTab`),
  and the last sub-tab is remembered separately (`framepilot.view.elementsTab`).
- **Browser build:** desktop first. Photos and Videos need the main process and stay **absent** in
  the browser, as the Stock tab is today — absence, never a disabled panel. Stickers and Shapes are
  local and _could_ work there, but shapes need an engine-free raster fallback and stickers the
  browser import path; both are decided in EL11 (06 §6). Until then the Elements tab is absent in
  the browser.

---

## 2. Panel anatomy

```
┌ Elements ────────────────────────────────┐
│ ▔▔▔▔▔▔▔▔                                  │
│ Photos  Videos  Stickers  Shapes          │  segmented tabs (role="tablist")
│ ┌──────────────────────────────┐ ┌──┐     │
│ │ 🔍 Search stickers…          │ │☆ │     │  search · favourites toggle
│ └──────────────────────────────┘ └──┘     │
│ (All)(Recent)(Smileys)(People)(Animals)›  │  category chips, horizontal scroll
│ ┌────┐┌────┐┌────┐┌────┐                  │
│ │ 😀 ││ 🔥 ││ 👍 ││ 🚀 │                  │  virtualised grid
│ └────┘└────┘└────┘└────┘                  │
│ …                                         │
│ Fluent Emoji · Microsoft · MIT            │  library credit, one line
└───────────────────────────────────────────┘
```

- **Sub-tab order** is the maintainer's: Photos · Videos · Stickers · Shapes.
- **Which sub-tab opens first:** the remembered one; on first use, **Photos** when a Pexels key is
  configured, otherwise **Stickers** (works offline with no setup — a first open should show
  something useful, not a key form).
- Each sub-tab owns its own query, category, scroll position and focus, kept while switching
  sub-tabs within a session (the Photos/Videos download registry already survives unmounts).

### 2.1 Photos and Videos (EL1, extended in EL9)

The existing Stock panel, split in two. Everything in `StockPanel.tsx` behaves as it does today
(quota strip, no-key state, masonry, hover-scrub for video, Add/Retry/Cancel/progress, "In this
project", load-more button, Pexels credit link) **except**:

- the Video/Photos `<select>` is removed — the sub-tab is the kind;
- placeholders become "Search photos" / "Search videos";
- the browse labels stay ("Curated on Pexels", "Popular on Pexels").

EL9 adds: category chips (curated queries — Business, Technology, People, Nature, City, Abstract,
Backgrounds, Food, Travel, Textures), an orientation filter (the provider supports it; `StockOrientationWire`
exists) defaulting to the project's orientation, drag to the timeline, and an **Add as overlay**
choice alongside Add (MD-E5).

### 2.2 Stickers (EL6a the curated ~200; EL6b the full library)

- **EL6a:** the curated ~200 in a plain grid with search, click-to-add, keyboard and tile states.
  **EL6b** adds the virtualised grid for all 1,595, the chips and the favourite star.
- **Grid:** square tiles, ~72 px at the default rail width (`columns = floor(width / 80)`),
  virtualised with `@tanstack/react-virtual` (EL6b); thumbnails are 144 px WebP (2× for HiDPI) loaded as rows
  scroll in.
- **Chips (EL6b):** All · Recent · Favourites (when any) · the curated collections from
  [`03-CONTENT-LIBRARY.md`](./03-CONTENT-LIBRARY.md) §2.3 (Reactions, Celebrate, Hands & gestures,
  Hearts, Tech & work, Arrows & pointers, Symbols & signs, Food, Nature, Animals, Travel, Objects,
  Flags) · then the nine upstream groups.
- **Search:** matches CLDR name and keywords (`metadata.json`), prefix-first then substring,
  ranked by collection popularity. Instant (no debounce needed; it is local).
- **Tile states:** idle · adding (spinner, the file is being copied into the project) · failed
  (reason on the tile, Retry) · in project (a small dot; click still adds another instance — a
  sticker is reusable, unlike a stock download).
- **Hover:** name tooltip; the favourite star appears (EL6b). Animated stickers (EL10) play on hover
  unless `prefers-reduced-motion`.
- **Skin tones (EL11):** tiles for emoji with tones show a tone dot; long-press or right-click picks
  the tone; the panel remembers the last chosen tone.

### 2.3 Shapes (EL4a six tiles; the catalogue in EL5)

- **EL4a** shows six tiles — highlight box, filled box, ellipse, marker, arrow, underline — with
  click-to-add and keyboard. No chips, search or colour row: six tiles do not need them.
- **Tiles** draw the shape as inline SVG from a UI-only path helper in its preset's colours on the
  panel background — no raster needed to browse, and every tile is sharp at any zoom.
- **EL5** adds the rest below, for ~200 tiles:
- **Chips:** All · Basic · Arrows · Lines · Callouts · Highlights · Stars & badges · Frames ·
  Symbols · Numbers (EL5) · Icons (EL5).
- **Colour row** above the grid: the six most recent colours plus the project accent. Clicking one
  recolours every tile's preview and becomes the fill/stroke the next added shape gets. It is a
  panel preference, not project state.
- **Search:** name and tags ("box", "circle", "underline", "callout", "speech", "badge").

---

## 3. Adding an element

| Gesture                                                                         | Result                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Click a tile (or Enter on a focused tile)                                       | Added at the **playhead**                                                                |
| Drag a tile onto a timeline lane (EL5 shapes, EL6b stickers, EL9 photos/videos) | Added at the drop time; on that lane if it has room, else the nearest free graphics lane |
| Drag a tile onto the program monitor (EL11)                                     | Added at the playhead, **centred where it was dropped**                                  |

**Duration:** `settings.defaultOverlaySeconds` — the existing default in Settings' "New elements"
group, whose hint becomes "On-screen seconds for a new title, sticker or shape." An element may run
past the last footage clip; the timeline grows, as it does for titles.

**Lane:** stickers and shapes go on **overlay** lanes (graphics), never on a footage lane. The
choice, in order: the frontmost overlay lane whose clips are mostly the same element kind and has
room; any overlay lane at the front with room; a **new overlay lane at the front**. All through
`createLaneAllocator`, the rule the agent's placement tools already use, so a click and a prompt put
the same thing in the same place.

**Default geometry:**

- Sticker — centred, height = **30% of the frame height**, no rotation.
- Shape — centred; box shapes take the preset's aspect with the longer side = 30% of frame height;
  line and arrow shapes run from 35% to 65% of the frame width at mid-height.

**After adding:** the new clip is selected, its on-canvas handles show, and the Inspector opens on
its section if "Open the Inspector when I click something" is on (Settings → Editing). A polite live
region says "Added Grinning face at 0:12".

**Undo:** one step removes the clip, and — if this add created them — the lane, the bin folder and
the asset. The file copied into the project media folder stays on disk (originals are never
deleted, AGENTS.md invariant 1); an unreferenced element file is harmless and small.

---

## 4. The Inspector

Built from the existing section registry (`components/inspector/registry.ts`); two new sections and
one shared one.

### 4.1 Sticker selected

| Section                          | Controls                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Position & size (existing)       | x, y, scale, rotation, opacity — keyframeable                                                                                                                                                                                                                                  |
| **Sticker** (new)                | Thumbnail + **Replace…** (opens the Stickers sub-tab in replace mode: keeps timing, transform and animation, swaps the asset); **Outline** (on/off, colour, width — the existing `edge_style` stroke, which EL2b makes apply to stills — EL6b); **Shadow** (edge-style shadow) |
| **Animation** (new, shared, EL7) | In · Out · Loop, each a preset picker + duration                                                                                                                                                                                                                               |
| Blend, Mask (existing)           | unchanged                                                                                                                                                                                                                                                                      |
| Follow subject (EL11)            | reuse of `track-follow.ts`                                                                                                                                                                                                                                                     |

### 4.2 Shape selected

| Section                    | Controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shape** (new)            | Shape picker (swap geometry, keep style) · **Fill** (colour with alpha, or none) · **Stroke** (colour, width, style: solid / dashed / dotted, or none) · **Corners** (when the shape has them) · shape knobs from the catalogue (points, inner radius, arrow-head size, tail position…) · **Size** W × H in project pixels with an aspect lock (on by default for circles and stars) · **Shadow / Glow** — the existing edge styles, which read the shape's own alpha once EL2b lands (no shape-specific shadow code; EL5) |
| Position & size (existing) | position offset, rotation, opacity, scale animation                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Animation (EL7)            | In · Out · Loop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Blend, Mask (existing)     | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Validation errors are shown inline in words ("A shape needs a fill or a stroke — both are off"),
never as a dead control.

### 4.3 The Text tab

`OverlaysPanel.tsx`'s disabled "Shape" and "Image" types are removed (EL4a) and replaced by one line:
"Stickers and shapes are in **Elements**" linking to the tab.

---

## 5. On-canvas editing

- **Stickers:** the existing `PreviewTransform` (move, uniform corner scale, rotate, snapping,
  Shift/Alt modifiers, one patch per gesture) — unchanged, it already works for any picture clip.
- **Box shapes:** eight handles edit the shape's own box (`x, y, width, height` params), the way
  `PreviewTextEditor` edits a title's box. Shift keeps the aspect, Alt resizes from the centre,
  snapping reuses `preview/snapping.ts` (centre lines, thirds, safe areas). The rotation handle
  writes the clip's `rotation` keyframe, as for every clip.
- **Line and arrow shapes:** two **endpoint handles** instead of a box — drag the arrow's tip onto
  the button it points at. This is the interaction that makes arrows useful over a screen recording.
- Every gesture commits **one** validated patch on release; the live drag is a preview-only
  override, as `PreviewTransform` does today.

---

## 6. The timeline

- Until EL5, element clips use the existing clip style for their kind (a sticker looks like a
  photo clip; a shape like a title). From EL5, element clips get their own clip style: a sticker shows its image repeated along the clip (the
  filmstrip path images already use); a shape shows a small glyph of itself in its colours and its
  name ("Highlight box").
- A graphics colour token (`--clip-graphic`) distinguishes element clips from footage and titles in
  both themes.
- Everything else — trim, move, split, ripple, lock, hide, context menu — is unchanged.

---

## 7. Keyboard and accessibility

- Sub-tabs: a roving `tablist` (←/→, Home/End).
- Grid: one tab stop, arrows move by one tile (and by a row with ↑/↓ in the square grids; the
  Photos/Videos masonry keeps its current linear model), Home/End, **Enter adds**, **F** toggles
  favourite, **Escape** clears the search. `/` focuses the search only while focus is inside the
  panel.
- Accessible names: "Grinning face, sticker", "Rounded rectangle, yellow outline, shape". Counts
  are announced politely ("48 stickers").
- `prefers-reduced-motion`: animated tiles do not autoplay; scrubbing stays (it is user-driven).
- Focus rings, contrast and hit targets follow the existing tokens; tiles are ≥ 44 px targets at the
  minimum rail width.

---

## 8. States and copy

| Situation                                                 | What the panel says                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| No match                                                  | "Nothing matched “{query}”. Try a simpler word — “fire”, “party”, “check”."              |
| Sticker could not be added — disk full                    | "Couldn't add this sticker: there isn't enough disk space."                              |
| Sticker could not be added — file missing in the install  | "This sticker's file is missing from this install of FramePilot. Reinstalling fixes it." |
| No project open / unsaved browser project (browser build) | Sub-tab absent rather than broken (§1)                                                   |
| Animated sticker not yet downloaded (EL10)                | Tile shows a download glyph; click downloads then adds; progress on the tile; Cancel     |
| Animated sticker needs a credit (EL10)                    | "Credit required" badge; tooltip names the credit line; the Credits view lists it        |
| Photos/Videos                                             | Every existing Stock message, unchanged except "Stock" → "photos and videos"             |

Library credit lines (footer of each sub-tab):

- Photos / Videos: "Photos and videos from **Pexels**" (the link the Pexels API guidelines require).
- Stickers: "Stickers: Fluent Emoji by Microsoft (MIT)" (+ "Animated: Noto Emoji Animation by
  Google (CC BY 4.0)" once EL10 ships).
- Shapes: none (first-party).

Settings: the **Stock media** group becomes **Photos & videos (Pexels)** — "Your Pexels key powers
Elements → Photos and Videos. Only the words you search for leave your computer." The key field and
quota readout are unchanged.

---

## 9. Performance targets (measured in EL4a, EL6b and EL12)

| Interaction                                                         | Budget                                        |
| ------------------------------------------------------------------- | --------------------------------------------- |
| Open Elements → first tiles painted (Stickers, warm)                | ≤ 100 ms                                      |
| Search keystroke → grid updated (1,595 stickers)                    | ≤ 16 ms                                       |
| Scroll the full sticker grid                                        | no dropped frames at 60 Hz on an M-series Mac |
| Click a sticker → clip on the timeline (desktop, file copy + patch) | ≤ 300 ms                                      |
| Click a shape → clip on the timeline                                | ≤ 50 ms                                       |
| Monitor playback with 20 element layers over 4K footage             | within the PX5 budgets (≤ 1% dropped frames)  |

**Last updated:** 2026-09-26
