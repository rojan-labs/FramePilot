# ADR 0198 — Timeline revamp: a neutral NLE skin over the existing timeline

- **Status:** Accepted.
- **Date:** 2026-10-02
- **Decided by:** maintainer request (2026-10-02): "take ownership of all the implementations
  related to revamp of UI design of timeline … check the artifact `artifacts/timeline-mock.css`
  `artifacts/timeline-mock.html` and do the design … the redesign should not break any of the
  functionality or any accessibility … just UI/UX redesign".
- **Relates to:** ADR 0028 (token-driven `styles.css`), ADR 0054 (orange state colour), the
  2026-07-18 accent move to blue, plan/PLAN.md "Timeline revamp" (TR1–TR6).
- **Supersedes, for the timeline dock only:** the orange `--tl-select` / `--playhead` aliases in
  `minimal-light-theme.css`, and the "header flags recede at rest" rule in `styles.css`.

## Context

The reference (`artifacts/timeline-mock.html`) is a CapCut-style multi-layer timeline: a
near-black NEUTRAL surface with no blue cast, alternating lane bands, icon-led track headers
with their flags always visible, clips whose picture or waveform fills the whole body under a
thin dark name bar, effects and adjustments as full-width coloured bars, transitions as a
small bow-tie on the cut, speed shown as a badge, a white selection ring and a white playhead
with a shield head, and a 42 px toolbar of 15 px stroke icons where the engaged tool turns blue.

The current timeline already has nearly every one of those PARTS (filmstrip + waveform band,
effect-layer chips, transition pills, keyframe diamonds, per-track flags, ruler, playhead with a
time bubble, overview strip). What differs is the skin: a navy-tinted palette, orange state
colour, controls hidden at rest, a heavier name bar, and pill-shaped transitions. So this is a
re-skin of an existing surface plus a handful of display-only additions. It is not a rebuild.

## Decision

1. **One design layer, scoped to the dock.** `components/timeline/timeline-skin.css` holds the
   whole revamp. It is imported LAST in `main.tsx`, after `minimal-light-theme.css`, following
   the `AiSidebar.polish.css` precedent. Every rule is scoped under `.timeline-dock`, the
   `WorkspaceShell` element that wraps the toolbar and the timeline. Nothing outside the dock
   changes.
2. **Re-point the tokens, then restyle.** The layer redefines the existing timeline tokens
   (`--clip-*`, `--tl-select`, `--playhead`, `--track-lane`, `--ruler-tick`, `--transition-*`)
   on `.timeline-dock` itself. A custom property declared on an element beats one inherited from
   `:root`, whatever the `:root` selector's specificity. So the existing rules pick up the new
   palette through the `var()`s they already use, and the structural overrides stay small.
   `@framepilot/ui/tokens.css` is untouched, so the media bin, inspector and captions keep
   their colours.
3. **Both themes follow the OS/`data-theme` switch.** Dark is the mock, value for value. Light
   is the same structure translated to the existing light chrome (white lanes, warm-grey
   gutter, tinted clip families, near-black selection and playhead). CapCut has no light
   theme, and the editor's light theme is a shipped decision, so the timeline follows it.
   Pinning the dock dark in both themes would be a one-selector change if that is ever wanted.
4. **State colours split by meaning.**
   - White (dark theme) or near-black (light theme) marks what is selected and where "now" is:
     the selection ring and the playhead.
   - Blue (`#3aa0ff` dark, `#1f7ae0` light) marks what a tool is doing: the engaged tool, snap
     guide, marquee, drop indicators and focus ring.
   - The blade line keeps the danger colour.

   The orange state alias from ADR 0054 existed because a blue ring vanished on blue video
   clips. Video clips are now teal and the ring is white, so that collision is gone.
5. **Clip families (dark / light; body · edge · ink):**

   | Kind (class) | Dark | Light |
   | --- | --- | --- |
   | video `is-video` | `#103a43` · `#1c5a66` · wave `#2db3c6` | `#d3ebef` · `#2e8a99` · wave `#1b8fa3` |
   | image `is-image` | `#0c2e35` · `#1c5a66` (thumbnail fills) | `#dcecee` · `#3f8b93` |
   | audio `is-audio` | `#233e6e` · `#3a5a96` · wave `#6f9ae6` | `#dbe4f6` · `#4a6fb3` · wave `#3f69c0` |
   | text `is-overlay` | `#9a5a2c` · `#c07a3d` | `#f3dccb` · `#b4672f` |
   | caption `is-caption` | `#7a4a26` · `#a8693a` | `#f1e2d3` · `#a0602f` |
   | shape `is-graphic` | `#a23b3b` · `#cf5a5a` | `#f4d3d3` · `#c04a4a` |
   | effect layer `.fx-layer` | `#5e4486` · `#7d5fae` | `#e4dbf2` · `#7d5fae` |

   Captions use a darker step of the text hue, so the two stay apart while reading as one family.
6. **Display-only additions.** None of these is a new behaviour:
   - a `⋯` track-options button that opens the EXISTING track context menu, which makes the
     menu reachable from the keyboard and by pointer, not only by right-click;
   - a speed badge (`1.3×`) on clips whose speed is not 1;
   - a bow-tie glyph inside the transition block;
   - a shield-shaped playhead head.

   The track flags show dimmed at rest. The mock shows them, and hidden controls were a
   discoverability cost.
7. **What does not change:**
   - every accessible name, role, `aria-*` and `data-*` hook;
   - the keyboard model (roving tabindex, shortcuts);
   - pointer hit areas: none shrinks below its current size;
   - JS geometry constants (row heights, insets, ruler height, gutter width);
   - every gesture, menu and patch path.

   The `--tl-gutter-w` token grows from 156 px to 178 px to fit the header cluster. It is a
   CSS-only token, and the overview strip already reads it.

## Consequences

- Restyling the timeline means editing one scoped file, not three files fighting in the cascade.
- The `timeline.png` visual baseline (`tests/e2e/specs/visual.spec.ts`) is regenerated with
  this change, deliberately.
- Canvas placeholders (`ClipFilmstrip`) carry a hard-coded navy grade, which becomes the teal
  grade in the same change. Painted colours are the one place a token re-point cannot reach.
- The orange aliases stay in `minimal-light-theme.css` for any chrome outside the dock. Inside
  the dock the skin wins by inheritance.
