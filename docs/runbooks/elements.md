# Runbook: Elements (photos, videos, shapes, stickers)

What to check when an editor reports a problem with the Elements tab, a sticker, a shape or the
assistant's placement of one. How the features work: [../guides/elements.md](../guides/elements.md).
Decisions: ADR 0190 (shapes are drawn by the engine), ADR 0191 (an element is an overlay, with its
amendments), ADR 0192 (loops are keyframes). Plan: `plan/elements/`.

---

## Where things live

| What                          | Where                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 251 curated stickers      | inside the renderer, `renderer/elements/stickers/{full,thumbs}` (every build; from `apps/web-editor/public/elements/stickers`)                            |
| The other 1,344 stickers      | desktop installer only, `<resources>/elements/stickers` with a `manifest.json` of each file's SHA-256 (`build:elements`, checked by `check:elements`)     |
| A sticker used in a project   | copied into the project folder, `media/<projectId>/elements/fluent3d/<id>.webp`, and into the bin's **Elements** folder; the asset records its provenance |
| A shape                       | no file: a clip whose params the engine draws (`shape_raster.py`); the monitor shows the same raster                                                      |
| Photos and videos from Pexels | downloaded by the desktop main process into the project's media, as before the rename (ADR 0139)                                                          |

## Symptoms

| Symptom                                                                   | Cause                                                                                                                     | Fix                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This sticker's file is missing from this install"                        | a damaged or partial install: a packaged file is absent or fails its manifest hash                                        | reinstall FramePilot; the packaged set is hash-checked on every read                                                                                     |
| The Stickers tab lists only 251 stickers                                  | a development build without the packaged set, or a set built for another library                                          | run `pnpm --filter @framepilot/desktop build:elements`; a set whose manifest names another library commit is ignored                                     |
| A sticker shows as missing media in an older project                      | its file was deleted outside the app                                                                                      | reopen the project: auto-heal copies it back from the app before anything reads it; otherwise relink                                                     |
| A sticker looks soft in the export                                        | it is drawn past 1.5× its 256 px art (the Inspector says "Enlarged beyond its sharp size")                                | make it smaller; a sticker added without a size is already as big as it stays sharp (about a fifth of a vertical frame)                                  |
| No Elements tab in the browser version                                    | Elements is desktop only (decided in EL11: the browser build has no engine to draw shapes and no store for sticker files) | use the desktop app                                                                                                                                      |
| A looped sticker stops moving before its clip ends                        | the clip was lengthened after the loop was set; a loop is keyframes (ADR 0192)                                            | Inspector → Animation → **Re-apply**; the assistant's review notes it too                                                                                |
| Photos/Videos say "Add your Pexels key" or show quota messages            | unchanged Pexels behaviour                                                                                                | Settings → AI → Photos & videos                                                                                                                          |
| "Update FramePilot to open this project"                                  | a project with shapes (format 25 or later) opened in an older build                                                       | update                                                                                                                                                   |
| The assistant refused to move a sticker or shape "outside the frame"      | the edit would have left it off the picture for its whole span (`element_off_frame`)                                      | expected: it would export as nothing; ask for a place inside the frame                                                                                   |
| The assistant's review warns about an element over a face or the captions | an advisory from the critic's element checks (ADR 0191 amendment)                                                         | move the sticker, or leave a callout where it points and move the captions (`set_track_caption_style`)                                                   |
| Another AI app over MCP cannot add a sticker                              | the MCP server has no way to copy a sticker into a project (deferred, 11 §2)                                              | add the sticker in the FramePilot app; over MCP, draw a shape or an icon                                                                                 |
| Animated sticker will not download (EL10, when it ships)                  | offline or a blocked host                                                                                                 | retry online; stickers already downloaded keep working                                                                                                   |
| Export slower with many elements                                          | per-frame compositing                                                                                                     | budget 1.3× with 20 elements (logged in CI by the PX5 export ratio, measured on real footage in run D); trim or remove elements the moment does not need |

## Logs to ask for

Desktop main: `desktop:elements` (materialise, packaged set, heal, thumbnails — each failure logs
its code: `unknown_element`, `library_missing`, `integrity_failed`, `disk_full`, `io_failed`).
Renderer: `web-editor:sticker-tiles` (packaged tiles), `web-editor:element-animation`. The agent:
`ai-sdk:assemble` (an off-frame refusal names the clip). The engine: the
`framepilot_engine.render.compiler` logger, and render validation, whose messages name the
element's clip.

## Before a release

`desktop-build` in CI encodes the packaged set and runs `check:elements` (every catalogued sticker
placeable from the manifest, the licence beside it, within 40 MB). The release workflow does the
same per platform, then decodes a shipped sticker with the frozen engine (WebP with alpha) and
checks the installer carries no Capability Pack payload.
