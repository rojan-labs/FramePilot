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

   | Kind (class)             | Dark                                    | Light                                  |
   | ------------------------ | --------------------------------------- | -------------------------------------- |
   | video `is-video`         | `#103a43` · `#1c5a66` · wave `#2db3c6`  | `#d3ebef` · `#2e8a99` · wave `#1b8fa3` |
   | image `is-image`         | `#0c2e35` · `#1c5a66` (thumbnail fills) | `#dcecee` · `#3f8b93`                  |
   | audio `is-audio`         | `#233e6e` · `#3a5a96` · wave `#6f9ae6`  | `#dbe4f6` · `#4a6fb3` · wave `#3f69c0` |
   | text `is-overlay`        | `#9a5a2c` · `#c07a3d`                   | `#f3dccb` · `#b4672f`                  |
   | caption `is-caption`     | `#5a3820` · `#8f6038`, bar `#3d2615`    | `#e6d0b9` · `#8a5a30`, bar `#d4b597`   |
   | shape `is-graphic`       | `#a23b3b` · `#cf5a5a`                   | `#f4d3d3` · `#c04a4a`                  |
   | effect layer `.fx-layer` | `#5e4486` · `#7d5fae`                   | `#e4dbf2` · `#7d5fae`                  |

   Captions use a deeper, duller step of the text hue and a solid name bar, while text clips
   have no bar. The two stay apart and still read as one family. The first planned step
   (`#7a4a26`) was too close to the text body to tell apart in the browser.
   Markers are a 7×9 amber pennant on the ruler, with a line through the lanes at about 35%
   strength, so a marker is not mistaken for a second playhead.

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

   The `--tl-gutter-w` token grows to 200 px to fit the header cluster. It is a CSS-only token:
   no TypeScript mirrors it, and the overview strip already reads it. See the amendment below
   for why 200 px and not the 178 px first planned.

## Amendment (2026-10-02, during implementation)

- **The gutter is 200 px.** `editor-foundation.css` had already widened it to 174 px, not the
  156 px in `tokens.css`, and that row had no slack left. Each control in the cluster has a
  24 px hit box, and no hit box may shrink. The cluster is collapse, glyph, lane name,
  hide/mute/lock/solo and `⋯`, so it needs 200 px.
- **Focus rings inside `section.timeline` stay off.** This follows the maintainer's 2026-09-30
  decision (commit `db986002`), which covers the header controls as well as the lanes. Inside
  the timeline, keyboard position is shown by selection, and the roving clip focus moves with
  the arrow keys. The toolbar sits outside the timeline section, so it shows the blue ring.
  Turning the rings back on in the timeline is one rule in `timeline-skin.css`. That is the
  maintainer's call to make, and this change does not reverse it.
- **Name bars are solid.** The bar sits over the picture, so the mock's 32% black is mixed into
  the body colour ahead of time instead of drawn translucent. A frame under the bar would
  otherwise change the bar's contrast from clip to clip.

## Consequences

- Restyling the timeline means editing one scoped file, not three files fighting in the cascade.
- The `timeline.png` visual baseline (`tests/e2e/specs/visual.spec.ts`) is regenerated with
  this change, deliberately.
- Canvas placeholders (`ClipFilmstrip`) carry a hard-coded navy grade, which becomes the teal
  grade in the same change. Painted colours are the one place a token re-point cannot reach.
- The orange aliases stay in `minimal-light-theme.css` for any chrome outside the dock. Inside
  the dock the skin wins by inheritance.
