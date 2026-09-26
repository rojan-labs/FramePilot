# 03 — The content library

"Lots of shapes and stickers loaded up" — this file says exactly what, from where, under which
licence, at what size, and how it gets into the build. Every number marked _measured_ was measured
on 2026-09-26.

---

## 1. Shapes

### 1.1 How a shape is defined

Each catalogue entry is data, in `packages/timeline-schema/schema/shape-catalog.json`, mirrored to
`engine/python/framepilot_engine/render/shape_catalog.json` with a drift test — the pattern caption
templates already use. An entry is:

```jsonc
{
  "id": "rounded-rect", // stable, referenced by ShapeParams.shape; never renamed
  "name": "Rounded rectangle",
  "category": "basic",
  "tags": ["box", "button", "card"],
  "frame": "box", // "box" (x, y, w, h) or "segment" (x1, y1, x2, y2)
  "generator": { "kind": "rect" }, // rect | ellipse | polygon | star | ring | bubble | corners
  // | line | arrow | curved-arrow | path
  "knobs": [
    // shape-specific, bounded, numeric (validator enforces)
    { "name": "cornerRadius", "label": "Corners", "min": 0, "max": 50, "default": 20, "unit": "%" },
  ],
  "defaults": { "aspect": 1.6 }, // box shapes: width / height at insert
  "presets": [
    { "id": "rounded-rect/white", "name": "Rounded box", "fill": "#FFFFFF", "stroke": null },
    {
      "id": "rounded-rect/highlight",
      "name": "Highlight box",
      "fill": null,
      "stroke": "#FFD400",
      "strokeWidth": 0.8,
    },
  ],
}
```

- **`path` generators** carry a normalised path (`d` in a 0–1 box, subset `M L C Q Z` — arcs are
  converted to cubics at build time) for shapes that are drawings rather than formulas (heart,
  cloud, lightning, pin, check, swoosh…).
- **Parametric generators** compute the path from knobs (corner radius, points, inner radius,
  arrow-head size, tail position, curvature). The generator code lives **once**, in the engine
  (`render/shape_geometry.py`), because the engine is the only rasteriser; the frame plans carry
  bounds computed from params, and TypeScript keeps only a small UI path helper for panel tiles,
  deliberately not pinned to the engine (05 §2.1).
- **Style** is not in the geometry: fill (colour with alpha, or none), stroke (colour, width,
  solid/dashed/dotted, or none), and end caps for segment shapes. A preset is a named style.

### 1.2 The catalogue (target: ~105 base shapes, ~200 presets)

**EL4a ships six**, the screen-recording staples, each as a preset of a base shape below:
**highlight box** (rounded rectangle, stroke only), **filled box** (rounded rectangle, solid),
**ellipse**, **marker** (marker highlight — translucent yellow), **arrow** (line arrow, segment) and
**underline** (underline marker, segment). **EL5 ships everything else**, starting with the rows
marked ● (~35 more a screen-recording edit reaches for next), then the rest, numbered badges and
icons.

**Basic (17)** — ● rectangle · ● square · ● rounded rectangle · ● rounded square · ● pill ·
● circle · ● ellipse · semicircle · quarter circle · ● triangle · right triangle · ● diamond ·
pentagon · ● hexagon · octagon · parallelogram · trapezoid.
Presets per shape: _Solid white_, _Solid accent_, _Outline_, _Translucent_ (40% fill).

**Arrows (15)** — ● arrow (line, segment) · ● block arrow (segment) · ● double arrow · ● curved
arrow (curvature knob) · U-turn arrow · circular arrow · ● chevron · double chevron · ● caret
pointer · dotted-tail arrow · ● hand-drawn arrow · elbow arrow · zigzag arrow · ● **cursor
pointer** · arrow head only.
Presets: _White_, _Red_, _Yellow_, _Black with white outline_ (reads on any footage).

**Lines & dividers (10)** — ● line · ● dashed line · ● dotted line · double line · ● thick line ·
wavy line · zigzag line · ● underline swoosh · divider with dot · curly brace.

**Callouts & bubbles (12)** — ● speech bubble (rounded; tail position knob) · speech bubble
(square) · ● oval speech bubble · ● thought bubble · shout bubble · ● tooltip (pointer side knob) ·
callout with leader line · ● pill label · banner ribbon · ● tag · sticky note · chat bubble.

**Highlights & focus (12)** — ● highlight box · ● highlight circle · ● marker highlight
(translucent yellow) · ● underline marker · ● hand-drawn circle · hand-drawn box · ● viewfinder
corners · crosshair · ● spotlight ring · ● click ripple · cursor halo · square brackets.
These are the screen-recording staples; their presets default to high-visibility yellow, red and
white with a thin dark outline so they read on light _and_ dark UIs.

**Stars & badges (13)** — ● 5-point star · 4-point star · 6-point star · 8-point star · ● sparkle ·
● starburst (16) · starburst (24) · ● seal · shield · rosette · ● banner · ribbon corner · ● burst
label ("NEW"-style, EL5 with label).

**Frames & borders (8)** — ● frame · ● rounded frame · ● circle frame · double frame · corner
frame · polaroid frame · phone frame (device mockup ring) · browser frame (title-bar ring).

**Symbols (18)** — ● check · ● check in circle · ● cross · ● cross in circle · ● plus · minus ·
● heart · lightning · moon · sun · cloud · drop · ● location pin · play button · ● warning ·
● info · question · ● star outline.

**Numbers (EL5)** — a shape with a **label**: numbered circle · numbered rounded square · numbered
pill; presets 1–10 in four colours. The label is drawn by the existing title rasteriser inside the
shape's box (one shape + one short label; general text-in-shape templates stay deferred).

**Icons (EL5, optional)** — **Lucide** line icons (ISC; portions MIT from Feather — both notices
included; already a dependency as `lucide-react@0.577.0`, 1,951 modules ≈ 1,600 unique icons).
Converted at build time into the same path format with `stroke` style and round caps, so they reuse
the shape rasteriser: recolourable, any size, no bitmaps. Categories follow Lucide's own tags.

### 1.3 Colour palette for presets

White `#FFFFFF` · Near-black `#111111` · Highlighter yellow `#FFD400` · Attention red `#FF3B30` ·
Link blue `#0A84FF` · Success green `#34C759` · Orange `#FF9500` · Purple `#AF52DE` · Pink
`#FF2D55` · plus the project accent token at insert time. Outline presets pair a light fill with a
dark 1 px-equivalent stroke so a shape stays visible over any footage.

### 1.4 Units (why they are what they are)

- **Box position** — centre `x`, `y` in percent of each frame axis (the title convention).
- **Box size** — `width`, `height` in **percent of the frame height**, the same unit a title's
  `fontSizePercent` uses. One sizing unit for all graphics means a shape and the title inside it
  scale together when the project orientation changes, and a circle stays a circle.
- **Segment endpoints** — `x1, y1, x2, y2` in percent of each axis.
- **Stroke width** — percent of the frame height (0.1–10).

---

## 2. Stickers

### 2.1 Sources and licences

| Library                                                 | Licence                          | Items                                                                                              | Obligation                                                                  | Status                                 |
| ------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| **Microsoft Fluent Emoji** (`microsoft/fluentui-emoji`) | **MIT**                          | **1,595** emoji at `1ffb34c752ec` (2026-08-24) _measured_; 9 groups; 6 skin tones where applicable | Ship the MIT licence text beside the files. **Nothing** in the user's video | **Core — EL6a (curated), EL6b (full)** |
| **Google Noto Animated Emoji**                          | **CC BY 4.0**                    | **881** _measured_ (`noto-emoji-animation/data/api.json`), with popularity rank and category       | Credit in the published work ("Noto Emoji Animation by Google, CC BY 4.0")  | **Optional pack — EL10, MD-E3**        |
| Lucide icons                                            | ISC (+ MIT for Feather portions) | ≈ 1,600                                                                                            | Notices with the app                                                        | Shapes → Icons (EL5)                   |

**Rejected:** OpenMoji (CC BY-SA 4.0 — share-alike on a video is a trap), Twemoji graphics
(CC BY 4.0 on every static sticker — a credit line for a thumbs-up is not a product), Simple Icons
and any brand/social marks (the SVG may be CC0, the trademark is not), GIPHY/Tenor (rights in
user-uploaded content), LottieFiles free animations (licence forbids redistribution as a
collection), anything non-commercial.

### 2.2 Formats and sizes

Upstream Fluent 3D is 256 × 256 PNG. Options, _measured_ on nine representative emoji:

| Option                                                       | Avg / sticker | × 1,595     | Look                      | Sharp up to (1080p)          |
| ------------------------------------------------------------ | ------------- | ----------- | ------------------------- | ---------------------------- |
| 3D PNG as shipped                                            | 31.5 KB       | ≈ 50 MB     | glossy 3D                 | 256 px                       |
| **3D → lossless WebP 256**                                   | **19.6 KB**   | **≈ 31 MB** | glossy 3D, bit-exact      | 256 px (24% of frame height) |
| Color SVG → lossless WebP 512                                | 55.2 KB       | ≈ 88 MB     | flat-shaded colour        | 512 px                       |
| Color SVG → lossy WebP q90 512                               | 14.8 KB       | ≈ 24 MB     | flat-shaded colour, lossy | 512 px                       |
| Thumbnail 144 px (2× a 72 px tile), lossy WebP q80, measured | 4.4 KB        | ≈ 6.9 MB    | grid only                 | —                            |

**Recommendation (MD-E1, MD-E2):** ship **3D lossless WebP 256** (the recognisable CapCut-like
look, bit-exact decode in both runtimes) + **144 px thumbnails** (2× a 72 px tile, for HiDPI), in two steps: a **curated ~200**
and their thumbnails (≈ 5 MB, committed, in every build — EL6a); then
the other ~1,395 with their thumbnails (≈ 33 MB) fetched from the pinned commit when the desktop
app is packaged — never in the web build (EL6b). The default insert size (30% of
frame height = 324 px at 1080p) is a 1.27× enlargement; the Inspector shows "Enlarged beyond its
sharp size" above 1.5× at the export resolution, instead of silently exporting a soft sticker. An
HD pack (Color style at 512) is deferred until someone asks for bigger stickers.

**Skin tones:** EL6a/EL6b ship the default tone only. The five other tones for the ~300 toned emoji add
≈ 30 MB; EL11 decides between bundling them and an on-demand tone pack. **Decided (EL11 review,
2026-09-26): deferred.** Measured: 310 toned emoji × 5 = 1,550 files, ≈ 37 MB with thumbnails —
the packaged set would go from 32.2 MiB to ~70 MB (budget 40 MB) and the installer from 374 to
~409 MiB (budget 400); an on-demand pack needs EL10's download path first.

**Noto Animated (EL10):** 512 × 512 animated WebP, _measured_ 360.6 KB for `1f600` (48 frames RGBA,
loop 0) → ≈ 320 MB for all 881. **Never bundled.** Downloaded per sticker on first use, verified
against a pinned SHA-256, cached per user, copied into the project on add.

### 2.3 Taxonomy

Two layers: the upstream **groups** (always complete) and FramePilot **collections** (curated,
ordered, what the chips show first):

| Collection                                         | Seeds (examples)                                |
| -------------------------------------------------- | ----------------------------------------------- |
| Reactions                                          | 😀 😂 🤣 😍 🤯 😱 🥲 😭 🤔 🙄 😎 🫠 👀 💀 🔥 💯 |
| Celebrate                                          | 🎉 🥳 🎊 🏆 🥇 🎁 ✨ 🎈 🍾                      |
| Hands & gestures                                   | 👍 👎 👏 🙌 👉 👈 👆 👇 ✌️ 🤝 🙏 ✋ 🤞          |
| Hearts                                             | ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💖                   |
| Tech & work                                        | 💻 📱 ⌨️ 🖱️ 📈 📉 📊 💡 ⚙️ 🔒 🔑 📧 📅 🚀 🧠    |
| Arrows & pointers                                  | ⬆️ ➡️ ⬇️ ⬅️ ↗️ 🔝 🔜 ☝️                         |
| Symbols & signs                                    | ✅ ❌ ⚠️ ❗ ❓ 🆕 🆗 🔴 🟢 ⭐                   |
| Money                                              | 💰 💵 💸 🤑 🏦 💳                               |
| Food · Nature · Animals · Travel · Objects · Flags | the upstream groups                             |

Collections live in `scripts/elements/collections.json` (committed, reviewed like copy).

### 2.4 Search index

Per sticker: CLDR name, `keywords` and `glyphAsUtfInEmoticons` from `metadata.json`, the glyph
itself (typing 🔥 finds the fire sticker), collection names. Ranking: exact name → prefix → keyword
→ substring; ties by collection order, then by Noto's popularity rank where the codepoint matches
(metadata only, no artwork). English only; localised CLDR annotations are deferred.

---

## 3. The build pipeline

**One script, zero new dependencies:** `scripts/elements/build_library.py`, run with the engine's
environment (`uv run --project engine/python`), because Pillow already encodes WebP.

1. Read `scripts/elements/fluent.lock.json` — the pinned upstream commit and the SHA-256 of every
   input file (generated on first run, reviewed in the PR like any lockfile).
2. Fetch each `metadata.json` and the default-tone 3D PNG from
   `raw.githubusercontent.com/microsoft/fluentui-emoji/<commit>/…`; refuse any byte that does not
   match its pin. Cache under `~/.cache/framepilot/elements/<commit>/` so reruns are offline.
3. Pad each sticker with a **12% transparent margin** on every side (256 → 318 px canvas) so an
   outline or shadow edge style has room — edge styles draw inside the layer's picture bounds
   (`render/edge_styles.py`) — then encode `full/<id>.webp` (lossless, `method=6`) and
   `thumbs/<id>.webp` (144 px, q80, unpadded). The recorded width/height and "sharp size" are the
   padded canvas and the unpadded art respectively.
4. Emit `sticker-catalog.generated.json` (ids, names, groups, collections, keywords, file, SHA-256 of
   the _encoded_ file, bytes, width, height, licence, licence URL at the pinned commit, attribution,
   source URL) and a size report.
5. Copy the upstream `LICENSE` to `LICENSE-fluent-emoji.txt` next to the sticker files — the way
   every bundled font ships its `OFL-*.txt` / `Apache-*.txt` beside it.

**Where outputs go (MD-E1, MD-E2):**

| Output                                            | Size              | Home                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sticker-catalog.generated.json` — all 1,595      | ≈ 400 KB          | committed — `packages/ai-sdk/src/providers/elements/` (read by the panel, main and the agent; loaded lazily in the renderer); each item marked `bundled` (curated) or `packaged` (desktop installer only)                                                                                  |
| curated ~200: `full/*.webp` + `thumbs/*.webp`     | ≈ 4 MB + ≈ 0.9 MB | committed — `apps/web-editor/public/elements/stickers/` (EL6a; every build has them)                                                                                                                                                                                                       |
| the other ~1,395: `full/*.webp` + `thumbs/*.webp` | ≈ 27 MB + ≈ 6 MB  | **not committed**; fetched and encoded from the pinned commit by the desktop packaging step into electron-builder `extraResources` (EL6b), cached by the lock hash in CI; the renderer loads their tiles over IPC as `blob:` URLs (the Pexels grid's pattern); the web build never fetches |

A test compares the catalogue against the lock (every id has a file, every file its hash): the
curated set in every build, and the packaged set in the desktop packaging job, so a packaged app can
never ship a tile it cannot place. A build without the packaged set (the browser build, a dev tree
that has not fetched it) shows only the curated stickers — never a tile that fails on click.

**Shapes:** `shape-catalog.json` is authored by hand (it is design, not data) and reviewed on an
export-rendered contact sheet, the way caption templates were (CT4).

**Icons (EL5):** `scripts/elements/build_icons.mjs` reads `lucide-react`'s icon nodes (already
installed) and writes their paths into the shape catalogue's `icons` section with SVG arcs and
primitives converted to `M L C Q Z`.

---

## 4. Licence obligations, handled

- The licence text ships **next to the files it covers**: `LICENSE-fluent-emoji.txt` beside the
  stickers, and (EL5) Lucide's ISC/MIT text beside the icon catalogue. A test asserts every bundled
  library has its licence file, as `caption-fonts.test.ts:48` does for each of the 92 font
  families (CT1).
- Every materialised sticker writes `Asset.source` = `{ provider: 'fluent-emoji', remoteId: <id>,
license: 'mit', licenseUrl, attributionRequired: false, attribution: 'Fluent Emoji by Microsoft
(MIT)', sourceUrl, fetchedAt }`. MIT imposes nothing on the video, so it is **not** listed as a
  required credit; the Credits view shows it once under Suggested, grouped (G10).
- Noto animated stickers (EL10) write `attributionRequired: true` with the CC BY 4.0 credit line, so
  the Credits view lists it under **Required** — the path CC-BY music already takes.
- `pnpm license:scan` runs on every phase that touches a manifest, even though no runtime
  dependency is added.

**Last updated:** 2026-09-26
