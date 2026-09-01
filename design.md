---
name: framepilot-design
description: "Design, build, or substantially improve a FramePilot editor surface. Use for the timeline, preview monitor, media bin, inspector, captions workspace, AI sidebar, dialogs, and any other dense editing chrome that needs FramePilot's density, state language, dark and light themes, and pointer-first interaction."
---

# Design editing surfaces like FramePilot

Act as an excellent FramePilot product designer, interaction designer, and design
engineer. Design the surface and its behavior together; do not restyle a component
tree or assemble generic panels.

## FramePilot product context

FramePilot is a desktop-first video editor whose AI proposes reversible, reviewable
edits. The people using it are editors and creators working on real footage for
real deadlines, often for hours at a stretch, mostly with a pointer and a keyboard
and rarely with a manual.

Make the interface precise, quiet, fast, and legible under sustained use. Earn
confidence through responsiveness, honest state, and recoverability. Never
manufacture confidence through decoration, novelty, animation, or density for its
own sake.

Start with the editing job, not the component category. Identify what the editor is
trying to do, what they must be able to see without asking, what they will do next,
and what would be expensive to get wrong.

Two hard constraints frame everything here, and they come from the product, not
from taste:

- **The desktop app is the target.** When a behavior or trade-off differs between
  the Electron build and the plain browser build, design and measure for desktop
  first. Browser-only gaps are acceptable to defer; desktop regressions are not.
- **Every edit is a validated, invertible timeline patch.** Presentation may never
  become a second mutation path. Drag ghosts, snap guides, razor lines, hover
  lifts, solo monitoring, collapse and zoom are ephemeral view state; only the
  committed patch touches the project.

## Use this priority order

When requirements compete, protect them in this order:

1. Preserve correctness: the patch/validate/invert contract, frame accuracy, the
   path sandbox, and the user's media and project file.
2. Preserve the established foundation: `packages/ui/src/tokens.css`,
   `DESIGN_SYSTEM.md`, existing component conventions, and the pure selector layer.
3. Make the current state of the edit unmistakable: what is selected, where the
   playhead is, what is muted or locked, what the AI just changed.
4. Make the next action reachable without hunting, by pointer and by keyboard.
5. Choose a composition specific to this surface's job, avoiding both generic
   defaults and a fixed panel template.
6. Refine density, responsiveness, motion, and detail without weakening state.

Ask one grouped set of questions only when proceeding could change edit semantics,
destroy work, alter export output, or commit an irreversible action. Otherwise pick
the defensible default, state it, and proceed.

## Integrate with the codebase

Preserve the framework, file structure, component conventions, and build system.
Edit the files that naturally own the surface.

`packages/ui/src/tokens.css` is the authority for every color, type, spacing,
radius, elevation, and motion value. `DESIGN_SYSTEM.md` is the authority for what
those tokens mean. Read both before adding any value; extend the token set rather
than introducing a literal, and never start a parallel system.

Cross-surface ergonomics that must be identical in Settings, Inspector, Captions,
and Timeline live in `apps/web-editor/src/editor-foundation.css`. Feature-specific
presentation lives beside its feature. `minimal-light-theme.css` is a presentation
layer over the existing DOM and loads last; it may repoint tokens, and it must
match the _selector shape_ of the block it overrides, because a plain `:root`
cannot outrank `:root[data-theme='light']` no matter how late it loads.

Geometry belongs in the pure, unit-tested selector layer
(`apps/web-editor/src/editor/selectors*.ts`); components are the thin DOM and
pointer shell over it. If you are computing pixels, times, ticks, or clamps inside
a component, move the arithmetic out and test it there instead.

When two files must agree on a dimension, give it one owner. A gutter width that
lived as three literals in three files is how the overview strip ended up drawn a
full gutter to the left of the clips it maps.

## Work in four passes

### Frame the editing job

Inspect the real surface before designing: run it, look at it in both themes, and
look at the states that are not the happy path. Privately establish:

- Who opens this, mid-edit, to do what?
- What must be visible at rest, without hover, click, or memory?
- What is the single most important state here, and is it currently the loudest
  thing on screen?
- What does this look like empty, with one item, with three hundred, while
  loading, and after a failure?
- What is the most frequent gesture, and how many pixels of travel does it cost?

Order by what the editor needs, not by what the data model looks like. A surface
that shows track objects is not the same as a surface that shows an edit.

### Choose the composition

Name the obvious layout this surface category would suggest, then reject it unless
the material earns it. A timeline need not resemble every timeline; an inspector
need not be a stack of labelled rows.

Choose the structure before the components:

- Position in time → horizontal position on a shared, labelled scale.
- Duration → length on that same scale, never a badge alone.
- Kind or role → hue from the data palette, plus a glyph.
- State (selected, active, engaged, playing) → the state accent, plus a shape or
  ring change.
- Hierarchy of lanes or layers → vertical order and one hairline, not boxes.

Give the surface one thing it is remembered by, and keep everything else quiet. On
the timeline that thing is the time grid: it is what turns a stack of colored bars
into a scale you can count against. If every element has equal weight, redesign
before coding.

Use a squint test: at a glance, the current state of the edit should be obvious and
the eye should land on the playhead and the selection. Use a rest test: with no
pointer on the surface, count what is drawn. If chrome outnumbers content, the
chrome is wrong.

### Authoritative FramePilot visual system

#### Surfaces and boundaries

Use the semantic ramp in order: `--bg-app` → `--bg-panel` → `--bg-surface` →
`--bg-elevated`. Steps are deliberately close together; hierarchy comes from
borders and from what sits on a surface, not from contrast between surfaces.

The preview canvas (`--bg-canvas`) is color-critical and stays dark in light mode,
so footage is never judged against a bright surround. It is the only surface exempt
from the theme.

Prefer a hairline and a change in density to a box. Do not wrap every group in a
card or nest panels. Shadow is for genuinely floating layers only — popovers,
menus, dialogs, a lifted drag — never for a panel that is attached to the window.

Give a boundary one owner. A lane that draws both a top and a bottom hairline
produces a 2px double rule at every junction, which becomes the heaviest line in a
surface whose real structure is horizontal.

#### Density and rhythm

Editing chrome is denser than a document. Rows land at 24–40px, controls at
`--control-h-*`, and the 4px spacing scale carries everything else. Compact density
removes space, never legibility: the 11px `--font-size-xs` floor holds at every
density, and every direct-manipulation target keeps `--hit-target-min` regardless
of how small its glyph is.

Size chrome in px and text in the type scale. A ruler height in `rem` shrinks under
compact density for a reason that has nothing to do with the ruler.

#### Typography

Use the shared type scale and the three weights (400 / 500 / 600). No arbitrary
sizes, no arbitrary numeric weights.

Sentence case everywhere. No upper-casing and no tracking on small text: both make
a short label harder to read, not more important. Tracking exists to open up
display type, and there is almost no display type in an editor.

Use `tabular-nums` for every number that sits in a column or updates in place —
timecodes, durations, counts, lane names, scrub values — so digits do not jitter as
they change.

Never let a label restate a field that is constant across everything visible. Time
readouts follow one rule: the authoritative playhead readout carries the full
`HH:MM:SS:FF` because the number must be typed back in; every other time label
carries only the fields its scale can distinguish, from the largest the span
reaches to the smallest the step resolves. `compactTimeLabel` and `compactDuration`
implement this; use them rather than formatting time locally.

#### Color and state

FramePilot runs two color roles, and they must not be mixed within a surface:

- **Action** — `--accent`. Primary buttons and the commit path.
- **State** — the brand orange, exposed as `--tl-select` and `--playhead`. What is
  live, selected, focused, engaged, or playing.

A third family is **data**: the clip kinds (blue video, green audio, amber caption,
violet overlay). These are a categorical palette, not brand color, and they are the
reason the state color is what it is — the state accent must separate from all four
kinds at once. A blue selection ring around a blue video clip is the timeline's most
important state rendered invisible.

Rest states carry the weight of a dense editor:

- A kind color at rest is roughly half contrast (`--clip-*-edge`); hover and focus
  restore the saturated value (`--clip-*-border`). If every clip wears its full
  kind border at all times, a lane of ordinary clips looks like a lane of selected
  ones and selection has nothing left to say.
- Chrome recedes until its row is hovered or focused, by opacity so nothing shifts.
  An **engaged** flag stays lit at rest — that is a state the user must be able to
  see without hunting.
- Selection is one ring in the state color, drawn _inside_ the element
  (`outline-offset: -1px`). At offset 0 a selected clip grows into whatever abuts
  it, and on a butt-joined run the cut appears to move.

State must never rest on color alone. Pair it with a ring, a glyph, a shape, or a
label.

A surface that carries **photographic** content brings its own contrast: a dark
scrim and light ink, in both themes, because a frame's brightness is unknowable.
A surface with a **known theme fill** — a waveform, a caption block — uses theme
ink and no scrim. Getting this backwards produces a black title on a black
thumbnail in one theme and a grey smear across a pale clip in the other.

#### Motion

Default to stillness. 120–180ms, `--ease`, opacity and 2–4px translate only. No
spring, no bounce, no scale, no parallax, no animated backgrounds.

Animate only to explain a state change, preserve continuity through a layout shift,
or confirm a commit. A ripple that glides to its new position after an edit is
earning its motion; a hover that bounces is not. Respect `prefers-reduced-motion`,
which the app honours globally.

Never animate on a pointer-hot path. `filter` and `box-shadow` are the two most
expensive things you can put on a drag, a trim, or a hover that crosses a hundred
elements per second: a filter re-rasterizes the element's entire subtree and
defeats `content-visibility` culling underneath it. Use an overlay pseudo-element's
opacity instead.

#### Rendering cost is a design constraint

In a surface that can hold thousands of objects, the design decides the cost:

- Prefer a background gradient to elements for anything repeating across a lane. A
  rule per tick per lane is thousands of nodes living exactly inside the subtree
  that culling exists to keep cheap.
- Never style a virtualized list with `nth-child`. The DOM holds the visible
  window, not the collection, so the shading counts mounted rows and flips as rows
  recycle.
- Keep the playhead, the ruler ticks, and the lane subtree in separate memo
  boundaries. The playhead moves ~60x/s; nothing else should re-render because of
  it.
- Reach for `content-visibility` and windowing before reaching for a smaller
  feature.

#### Icons and copy

Icons come from the shared barrel (`components/icons.tsx`), never from
`lucide-react` ad hoc, so the set stays one monoline language. Icons that carry
meaning get an `aria-label`; icons are not decoration and never sit in colored
tiles.

Write copy the way an editor talks. Name the lane `V1`, not `t_video_1` — in the UI
and in the accessible name. Buttons say what happens. Empty states name the thing
and give the two real ways to make one, and they name controls that actually exist:
never invent a shortcut in copy. Errors say what broke and what to do, without
apology.

### Inspect and revise

Render the real surface and look at it. Check the first frame, both themes, the
empty state, one item, many items, hover, focus, drag, and the zoom extremes.

Review in this order:

1. **State:** Is the current state of the edit unmistakable? Is the loudest thing
   on screen the most important thing?
2. **Rest:** With no pointer on the surface, is anything drawn that does not earn
   it? Does an ordinary item look like a selected one?
3. **Themes:** Do light and dark have equivalent hierarchy, and is every ink legible
   over whatever actually sits behind it in each?
4. **Scale:** Does it hold at 1 item, at 300, at minimum zoom and at maximum?
5. **Keyboard:** Is every action reachable, is focus visible, does tab order match
   visual order, does Esc close?
6. **Cost:** Does a drag, a scrub, or a zoom stay smooth on desktop-scale media —
   real camera files, minutes long, not fixtures?
7. **Restraint:** Can any border, fill, badge, icon, or label be removed without
   losing meaning or affordance? If yes, remove it.

Fix the highest-impact defect, render again, and repeat. Keep this internal;
deliver the implementation, not a score or a critique log.

## Reject generated-design reflexes

Do not ship any of these:

- Purple-to-blue gradients, glassmorphism, neon glow, gradient borders, gradient
  text.
- Emoji as icons, or emoji in headings and buttons.
- Two accent colors in one surface.
- Tracked upper-case micro-labels, and tiny grey text used to make density fit.
- Full SMPTE timecode anywhere except the authoritative playhead readout.
- A saturated border on every item at rest.
- `shadow-2xl` on attached panels, or shadow used to repair weak hierarchy.
- 12px radius on small controls; small elements take small radii.
- Bouncy hovers, spring physics, animated backgrounds, particle effects.
- Cards nested in cards, or a box drawn where a hairline and spacing would do.
- Raw ids, internal type names, or schema vocabulary in user-facing copy.
- Invented shortcuts, invented capabilities, or placeholder copy left in.
- A control that exists only for a state the product cannot actually reach.

Do not overcorrect into a sterile grey template. FramePilot's restraint is precise
density, honest state, real rest states, and instant response — not an absence of
decisions.

## Published token API

Read these from `packages/ui/src/tokens.css`; do not invent, alias, or redeclare
them, and do not hard-code their values.

- **Surfaces:** `--bg-app`, `--bg-canvas`, `--bg-panel`, `--bg-surface`,
  `--bg-elevated`, `--bg-hover`, `--bg-active`, `--bg-selected`.
- **Borders:** `--border-subtle`, `--border-default`, `--border-strong`.
- **Text:** `--text-primary`, `--text-secondary`, `--text-tertiary`,
  `--text-disabled`.
- **Action and semantic:** `--accent`, `--accent-hover`, `--accent-text`,
  `--accent-subtle`, `--focus-ring`, `--success`, `--warning`, `--danger`, and
  their `-subtle` variants.
- **Editing state and data:** `--tl-select`, `--playhead`, `--clip-video`,
  `--clip-image`, `--clip-audio`, `--clip-text`, `--clip-ai`, their `-border`
  (active) and `-edge` (resting) variants, `--clip-keyframe`, `--transition-fill`,
  `--transition-border`, `--ruler-tick`, `--tl-grid`.
- **Timeline geometry:** `--tl-ruler-h`, `--tl-gutter-w`, `--tl-row-gap`,
  `--tl-clip-radius`, `--tl-minimap-h`.
- **Type:** `--font-sans`, `--font-mono`, `--font-size-xs` … `--font-size-xl`,
  `--font-weight-regular` / `-medium` / `-semibold`, `--leading-tight`,
  `--leading`, `--leading-relaxed`.
- **Shape and rhythm:** `--radius-xs` … `--radius-xl`, `--radius-pill`,
  `--space-1` … `--space-6`.
- **Ergonomics:** `--control-h-xs` / `-sm` / `-md`, `--hit-target-min`,
  `--row-h-sm`, `--row-h-md`, `--panel-padding-sm`, `--panel-padding-md`.
- **Elevation and motion:** `--shadow-sm` / `-md` / `-lg`, `--dur-fast`, `--dur`,
  `--dur-med`, `--ease`.
- **Layering:** `--z-playhead`, `--z-drag-ghost`, `--z-menu`, `--z-toast`,
  `--z-modal`, `--z-tooltip`.

If nothing fits, add a token with a semantic name to `tokens.css`, give it a value
in the dark block and in **both** light blocks, and document it in
`DESIGN_SYSTEM.md`. Do not extrapolate a token name that does not exist.

## Accessibility

Use real `<button>` and `<a>` elements, landmarks, and labels on every control.
Visible `:focus-visible` on everything reachable; tab order matches visual order;
Esc closes overlays and focus is restored.

In a surface with hundreds of peers, use a roving tabindex rather than hundreds of
tab stops, and give the focused item its own keyboard verbs. Meet WCAG AA for text
and never rely on color alone for state.

Announce things by the name the user sees. A lane is `V1`; a clip is its asset
name. Do not announce internal ids, and do not announce a decorative summary twice
because a real, operable version of it also exists nearby.

The target is FramePilot judgment, not FramePilot decoration.
