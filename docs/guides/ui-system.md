# Editor presentation system

FramePilot's UI is a dense desktop editing surface. The presentation system is
built to keep that density readable and predictable across the timeline,
Inspector, Captions, Settings, AI, media browser, and floating editor chrome.

## Ownership

The presentation layer has three explicit levels:

1. `packages/ui/src/tokens.css` owns shared visual values. It is the canonical
   source for colors, typography, weights, spacing, radii, control sizes, hit
   targets, elevation, motion, and z-index values.
2. `apps/web-editor/src/editor-foundation.css` owns cross-surface ergonomic
   invariants that must remain the same in dense editor panels. Examples are the
   11px ordinary text floor, 24px precision hit targets, compact-density behavior,
   and common focus treatment.
3. Feature stylesheets own feature layout and feature-specific presentation.
   Timeline geometry, caption layout, Inspector rows, Settings layout, and similar
   concerns remain beside the feature.

`apps/web-editor/src/styles.css` still contains legacy/global editor presentation.
Do not add a new unrelated feature block there. When a touched legacy block can be
extracted safely as a focused change, move it beside the feature rather than
creating another competing selector layer.

## Readable density

FramePilot gets density from structure, spacing, and disclosure before reducing
text size. Ordinary UI text must not drop below `--font-size-xs` (11px). Use the
shared 400/500/600 weight tokens rather than intermediate system-font weights.

Compact mode tightens spacing and control dimensions but keeps the root type size
readable. A panel should therefore remain visually denser without making labels,
hints, or numeric values smaller.

## Interaction targets

A small icon does not require a small hit box. Precision controls use
`--hit-target-min` (24px) as the minimum interactive target. Timeline flags,
keyframe actions, Inspector reset controls, switches, and similar dense actions
can keep 12–16px glyphs inside that target.

Hover-only controls must also become available through keyboard focus. Focus
rings use the shared focus token and must remain visible in both light and dark
modes.

## Shared controls

`@framepilot/ui` owns reusable Button, Input, Switch, and SegmentedControl
presentation and semantics. These primitives import their own token-driven
baseline styles, so another host does not need the web editor's global stylesheet
to make them usable.

The web editor's existing `Select` and `Tooltip` remain the canonical editor
implementations for dropdowns and hints. `Select` portals its list to the document
body, clamps to the viewport, and supplies keyboard navigation. Caption font
selection uses this same control rather than a native dropdown, so Caption
controls behave consistently with Settings and Inspector dropdowns.

## Light theme

Light and dark themes share semantic token names, not identical alpha values.
Tertiary and disabled text are deliberately stronger in light mode because dense
11–12px editor metadata must remain legible on bright surfaces.

The program canvas remains dark in either theme because it is a color-critical
surround for footage rather than ordinary application chrome.

## Motion

Use shared motion tokens for hover, disclosure, and layout transitions. Continuous
preview/timeline movement stays on the existing performance-aware paths and should
not be converted into layout animation.

All presentation must remain correct when either the operating system or the
FramePilot preference requests reduced motion.

## Adding or changing UI

Before adding a new value, ask which layer owns it:

- reusable visual decision → add/reuse a token;
- cross-surface ergonomic invariant → editor foundation;
- feature geometry or layout → feature stylesheet;
- reusable control behavior → shared primitive;
- one-off interaction geometry tied to an algorithm → keep near that feature.

Do not duplicate existing Button/Input/Switch/Segmented/Select/Tooltip behavior
inside a feature component. Feature components should compose those controls and
own what the action means, not how the control behaves.
