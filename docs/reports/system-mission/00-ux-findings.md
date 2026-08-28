# UX walkthrough findings — desktop host, real media (P0.6)

Captured 2026-08-29 by `tests/e2e-desktop/specs/ux-walkthrough.spec.ts` on `mission-montage`
(5 real camera clips, 9 assets). Screenshots in `docs/reports/system-mission/ux/`. Severity:
**B** blocks work · **S** slows work · **C** cosmetic. Cross-checked against `UI_AUDIT.md`
and `docs/reports/ui-system-audit-closure.md`; closed items are not re-raised. Nothing is
fixed here — Phase 8 triages (P8.1).

| ID | Surface | Finding | What a professional tool does | Sev | Shot |
| --- | --- | --- | --- | --- | --- |
| UX-01 | Export | Preset is a platform name ("Instagram Reels (9:16)"); resolution/fps/codec are read-only under it. No quality tier, fps, codec, container, size estimate or output location. | CapCut/Premiere: resolution + fps + quality + codec + format, estimated size, destination. | **B** (mission scope) | 07 |
| UX-02 | AI sidebar | Suggestion chips are static: "Remove the silent gaps" and "Add captions from the transcript" on a project with no transcript; "Mute the music track" with no music placed. | Suggestions derive from project state (Cursor/Notion: contextual prompts). | S | 01 |
| UX-03 | AI sidebar | Composer placeholder is clipped mid-sentence ("Message FramePilot… (/ for") at both 1440 and 1024 widths. | Placeholder fits or truncates with ellipsis at a word boundary. | C | 01, 11 |
| UX-04 | AI sidebar | Attachment "+" exists but the only visible affordance is a plus glyph; nothing says video/image references are accepted, and (verified in code) attached chips never reach the model. | Attachment tiles with thumbnails and role; drag-and-drop target. | **B** (Phase 3) | 01 |
| UX-05 | Timeline | Only the picture track row renders; the project's empty `audio_1` track is not shown, so there is no visible drop target for music. Users must discover "Add track". | Empty tracks are visible rows with a drop target. | S | 01 |
| UX-06 | Timeline | Mouse wheel over the timeline neither zooms nor scrolls the ruler (viewport identical before/after 8 wheel steps); zoom is only the slider/±. | Wheel scrolls; ⌘/Ctrl+wheel or Alt+wheel zooms around the cursor. | S | 07 vs 10 |
| UX-07 | Timeline | Selecting a clip auto-scrolled the view to 0:38 while the playhead stayed at 0:00 — selection and viewport are coupled, playhead is not. | Selection never scrolls the view unless the clip is off-screen; playhead follows on seek. | S | 02 |
| UX-08 | Clip context menu | Menu offers Split / Duplicate / Delete / Ripple delete / Ask AI. Missing: Copy/Paste, Trim start/end to playhead, Speed/Duration, Add transition, Reveal in bin, Disable clip. | Premiere/Resolve/CapCut expose these on right-click. | S | 03 |
| UX-09 | Top bar | Nine icon-only controls (loop, grid, fullscreen, expand, map, captions, history, shortcuts, settings, theme) with no visible labels; discoverability relies on tooltips. | Group into labelled menus or show labels at ≥1280px. | C | 01 |
| UX-10 | Settings | Modal is translucent: the preview frame bleeds through the settings text (theme rows read over a moving image). | Opaque surface or heavier scrim behind modal content. | S | 08 |
| UX-11 | Settings | Readiness panel reports "AI provider: NVIDIA NIM" while `.env` selects DeepSeek and that key returns 410 — readiness shows a stored choice, not whether a provider actually answers. | Readiness = last successful call / key validated. | S | 08 |
| UX-12 | Narrow (1024) | Top bar drops aspect + fit controls without a menu to reach them; timeline toolbar wraps to two rows and pushes the ruler down. | Overflow menu ("…") keeps controls reachable. | C | 11 |
| UX-13 | Inspector | Empty state is clear ("Choose a clip, transition, text layer, or effect"), but the AI tab's agent header (Agent / Plan first) stays rendered above the Inspector's content when switching tabs (04-inspector shows both). | Tab content is exclusive. | C | 04 |
| UX-14 | Preview | A 4K landscape source in a 9:16 sequence shows as a full-frame vertical crop with no indication that it is being fitted/cropped; no safe-area or crop handles. | Fit/Fill toggle and a visible frame boundary. | S | 01 |
| UX-15 | Assets | Filter tabs truncate ("Vid…", "Au…", "Ima…") at the default panel width. | Icons or full labels with a wider min-width. | C | 01 |
| UX-16 | AI sidebar | Context chips ("Current Timeline", "Project", "Open Assets (9)") are removable but there is no way to add a reference or remembered decision, and nothing shows what the AI remembered from previous turns. | "Knows" strip with references + decisions (P8.2). | S | 01 |

Not captured on this pass (no scripted path yet): drag-and-drop from bin to timeline,
multi-select/marquee, keyboard-only editing, loading/progress states during an AI run and
during export, error states. Phase 8 P8.4 covers the state matrix; Phase 9 journeys cover
the rest.
