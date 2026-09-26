# ADR 0191 — An element is an overlay

- **Status:** Accepted.
- **Date:** 2026-09-26
- **Relates to:** ADR 0189 (a still is a picture layer like any other), ADR 0190 (shapes are drawn
  by the engine), ADR 0169/0170 (picture coverage is a relation), ADR 0139 (sourcing lives in
  main), plan [`plan/elements/`](../../plan/elements/README.md) (EL6a).

## Context

A sticker is a picture file, like a photo, and the product already had two ways to put a picture
file on the timeline: import it as footage, or download it from Pexels as a cutaway. Both are
wrong for a sticker.

- **The cutaway placer** (`domain-tools/picture-layers.ts`) exists for b-roll: it cover-crops the
  picture to the frame and lifts it in front of what it covers. A fire emoji placed that way fills
  the screen.
- **Footage machinery** would treat it as footage: enrolment and visual indexing would spend a
  pass on it, the footage map would list it, "drop duplicate takes" would delete the second copy
  of the same emoji, and coverage checks would call it picture over picture.
- **The file itself** has to come from somewhere the renderer and the agent cannot steer: a path
  from either is a traversal waiting to happen.

## Decision

An element is an image asset whose provenance says so, placed as an overlay, by one builder.

- **Derived, not stored.** `isElementAsset(asset)` is true when `asset.source.provider` is an
  element library (`fluent-emoji`). No schema field, no migration: the provenance record a sourced
  asset already carries is the whole mark. The asset id is deterministic,
  `element_<library>_<item>` (editor-core `elementAssetId`, desktop `sourcedAssetId('element', …)`,
  pinned to each other), so adding the same sticker twice reuses one asset and one file.
- **Main copies the file, by id.** The renderer and the agent send an element id and a project id,
  never a path (`framepilot:elements:materialize`). Main resolves the id in the bundled catalogue,
  checks the file's SHA-256, copies it into the project's media folder through `resolveWithin`
  (temp file, then rename), and answers with the asset or a closed error code. Opening a project
  whose element file went missing copies it back first (`ElementsLibrary.heal`).
- **One placement, `buildAddStickerOps`.** The Stickers tab, a drop from the bin, the agent's
  `add_sticker`, and `add_clip` / `add_clips` / `move_clip` of an element asset all go through it:
  the Elements folder and the asset when the project lacks them, an overlay lane with room, the
  clip, and a base transform that makes the art (not its transparent margin) a third of the frame
  high. It never reaches the cutaway placer.
- **Not footage, anywhere.** Element assets are skipped by the engine's visual worklist and batch
  analysis (by id, the one thing a brain row and the project agree on), exempt from picture
  occupancy, coverage and repeated-take checks, and absent from Footage understanding.
- **Graphics stay on top.** A cutaway that needs a new front layer opens it just in front of the
  front-most picture lane, not at index 0, so it covers footage and stays under stickers, shapes
  and titles.
- **The agent's host tool is desktop-only.** `add_sticker` is `hostUiOnly`: the sticker library
  lives in the desktop install, and the MCP server has no materialiser to copy one.

## Consequences

- A sticker needs nothing new to render: the export, the frame plan and the monitor draw it as the
  still it is (ADR 0189), and three PX4 oracle rows hold the monitor to the export.
- The browser build shows no Stickers tab until EL11 decides whether it can store one.
- The library build (`scripts/elements/build_library.py`) is pinned to an upstream commit and a
  lockfile of hashes, so what ships is reviewable like a dependency.
- Rejected: a `Clip.element` field (a migration for data the provenance already carries), and
  drawing stickers in the engine like shapes (they are raster art, not geometry).

## Amendment — 2026-09-26: the whole library, in the installer (EL6b, MD-E1)

The other 1,344 stickers ship in the desktop installer, not the repository and not the web build.

- **Encoded at packaging.** `apps/desktop` `dist` runs `build:elements`, which encodes them from the
  pinned upstream commit into `elements-packaged/` (electron-builder `extraResources` →
  `<resources>/elements/stickers`), with the licence and a `manifest.json` of what it wrote: the
  library commit and each file's SHA-256 and size. CI (`desktop-build`) and the release job build
  it the same way, cached by the lockfile, and check every catalogued sticker is placeable within
  a 40 MB budget (`check:elements`).
- **Verified against the manifest, not a committed hash.** A lossless WebP's bytes can differ
  between encoder builds, so the catalogue cannot pin the packaged files. Main reads the manifest
  once, ignores a set built for another library commit, and checks a packaged copy's SHA-256
  against its entry, whose file must be the sticker's own (`full/<id>.webp`).
- **Tiles by id, as bytes.** The renderer cannot reach the installer's resources, so packaged tiles
  come over `framepilot:elements:thumbnail`: ids in (at most 96 per request), WebP bytes out, which
  the renderer shows as `blob:` URLs and keeps for the session. An empty request answers only
  whether the set is present, and the Stickers tab lists the whole library only then.
- **The agent sees what the host ships.** `search_elements` includes packaged stickers only when
  the host says the set is present (`packagedStickers`), so the agent never offers a sticker this
  install cannot place.
- Rejected: committing the full set (MD-E2: +40% repository size), fetching it in the web build (a
  network fetch in every web build), and downloading stickers on demand (offline editing would
  lose them).
