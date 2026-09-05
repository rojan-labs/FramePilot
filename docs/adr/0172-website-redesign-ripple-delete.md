# ADR 0172 — Website redesign: "Ripple delete" direction and the dustbin intro

- **Status:** Accepted
- **Date:** 2026-09-05
- **Supersedes:** the visual system in ADR 0036 (the site structure, static
  export, Freemius flow and content pipeline from ADR 0036 are unchanged).
- **Relates to:** ADR 0054 (orange brand identity).

## Context

The maintainer asked for an end-to-end redesign of `apps/website` with one
fixed idea for the landing moment: icons for the editors people already use
(Premiere Pro, DaVinci Resolve, CapCut, and peers) appear, every one except
FramePilot is thrown into a dustbin that lives at the bottom-right corner, and
the FramePilot icon flies up to become the navbar logo. The bin, with the
discarded tools in it, stays on screen.

The brief was explicitly a floor, not a storyboard: be creative around it, and
carry the idea through the whole site rather than only the hero.

## Directions considered

1. **The cutting-room floor.** Dark, filmic, near-black surfaces; the discarded
   icons land on a "floor" and the whole site is lit like a grading suite.
   Rejected: dark SaaS marketing is the most templated look in the category,
   and it pulls the site away from the orange-on-paper brand set in ADR 0054.
2. **Ripple delete.** Light, paper-white, typographic. The site behaves like a
   timeline: the intro is a *ripple delete* of the other tools (a playhead
   sweeps the row, each competitor is cut and thrown in the bin, the gap closes,
   FramePilot is promoted to the logo slot). Sections snap in like clips,
   headers carry a thin ruler, the bin is both a dustbin and an editor's "bin".
   **Chosen.**
3. **One window.** The entire landing page is a giant editor window and the
   other tools are dock icons. Rejected: it competes with the existing
   scroll-driven editor story, which already owns the product demonstration.

## Decision

- **Direction 2, executed everywhere.** Editing vocabulary (cut, ripple, in/out
  point, playhead, bin) is the site's visual and copy metaphor across landing,
  pricing, download, blog, docs, changelog, legal, and 404.
- **Brand tokens from the product.** Orange `#f26522`/`#e5670a` family stays the
  single action colour, as ADR 0054 decided. Light paper canvas, ink text,
  Bricolage Grotesque display + Geist text + Geist Mono for timecode-style
  labels. Tokens live in one place (`src/app/globals.css` `@theme`).
- **Animation library: `framer-motion`.** Already in the monorepo
  (`apps/web-editor`, MIT). Chosen for `layoutId`, which lets the FramePilot
  icon in the intro and the navbar logo be one shared element, so the "fly to
  the navbar" is a layout projection with no hand-measured coordinates and no
  layout shift.
- **The intro is a state machine** (`idle → assembling → discarding → landing →
  settled`) owned by one client provider mounted in the root layout. The navbar
  reads the same state, so there is never zero or two logos.
- **No-JS and first-paint correctness.** A tiny inline script in `<head>` marks
  `<html data-intro="pending">` only when this session has not seen the intro
  and reduced motion is off; CSS hides the navbar logo mark only under that
  attribute. Without JavaScript the attribute is never set and the logo is
  simply there. The bin renders only from the client.
- **Once per session.** `sessionStorage` flag, every access wrapped in
  try/catch; if storage is unavailable the intro replays and never throws.
- **Skippable.** Scroll, click, pointer down, or any key jumps to `settled`.
  Under `prefers-reduced-motion: reduce` the settled state renders directly.
- **Competitor icons are stand-ins, not trademarks.** The repo has no licence
  to ship Adobe, Blackmagic, or ByteDance logo assets. Each tool is drawn as an
  inline SVG tile using its characteristic colour and two-letter initials, with
  a visible text label naming the tool. Comparative naming is fine; copying
  the marks is not. If the maintainer later obtains permission, swapping the
  glyphs is a one-file change.

## Consequences

- One new runtime dependency for the website (`framer-motion`), already vetted
  by the licence scan for the editor.
- The website README's design rules are rewritten for the new direction; the
  "landing scroll demo owns the product story" rule survives.
- Old components (`SpotlightCard`, `Reveal`, the section files they replaced)
  are deleted rather than kept alongside the new system.

## Revision 2026-09-05 — splash instead of a hero track; a bin you can read

After reviewing PR #78 the maintainer asked for three changes, all made on the
same branch:

1. **The intro is a splash, not a track in the hero.** The first version laid
   the seven editors on a track above the headline and cut them off one by
   one. It now opens on a full-viewport paper ground: the FramePilot logo sits
   at the centre, the other editors revolve around it on an ellipse (depth from
   scale and dimming), and one by one they are flung off the orbit into the bin
   in the corner. The last one in, the ground fades and the logo flies into the
   navbar slot. Same state machine, same shared `layoutId`, same skip and
   reduced-motion rules. First paint is covered by a CSS-only paper layer under
   `html[data-intro="pending"]`, so the page never flashes before the splash.
2. **The bin shows what is in it.** Four icons at 26–32 px pile above the rim
   and two lie on the floor beside it, for the whole visit; the lid leans back
   once the bin is full. Icons stay stand-ins: `simple-icons` was tried and
   dropped because it carries none of Adobe's, Apple's, or ByteDance's marks,
   so the stand-in glyphs were made more legible instead (Adobe-style letter
   squares, Resolve's coloured orbit, a clapper, a bracket cut, a star).
3. **One line under the nav.** The hero's collapsed-track hairline sat under
   the nav ruler with an empty band between them. The track is gone, and with
   it the second line.
