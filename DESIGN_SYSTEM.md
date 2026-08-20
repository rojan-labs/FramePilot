# DESIGN_SYSTEM.md — FramePilot Editor UI

FramePilot's presentation system is a dense desktop-editor language influenced by
Notion, Cursor, Linear, and professional NLEs. The goal is **precise density**:
compact structure, readable labels, quiet surfaces, strong focus feedback, and one
accent used as punctuation rather than decoration.

## Source of truth

`packages/ui/src/tokens.css` is the **canonical source for token values**. This
document defines the semantic contract and usage rules. Do not duplicate palette
values here and then maintain two competing sources of truth.

Feature styles may own layout geometry that belongs to the interaction itself
(timeline lane height, preview dimensions, drag thresholds, virtualizer estimates).
Shared visual decisions belong to tokens: color, typography, font weights, control
heights, hit targets, spacing, radius, elevation, and motion.

The web editor imports the tokens through `styles.css`. Cross-surface ergonomics
that must apply identically to Settings, Inspector, Captions, and Timeline live in
`apps/web-editor/src/editor-foundation.css`; feature-specific presentation remains
next to the feature.

## Color contract

### Surfaces

Use the semantic surface ramp in order:

`--bg-app` → `--bg-panel` → `--bg-surface` → `--bg-elevated`

The preview canvas is a separate color-critical surface (`--bg-canvas`) and stays
dark in light mode so footage is not judged against a bright surround.

Borders provide most structural separation. Prefer `--border-subtle` for dividers,
`--border-default` for controls and boundaries, and `--border-strong` for hover or
important separation. Panels should not manufacture depth with unrelated shadows.

### Text

`--text-primary` → `--text-secondary` → `--text-tertiary` → `--text-disabled`

Hierarchy comes from opacity, weight, and size. Dark and light modes may use
different opacity values to achieve equivalent perceptual hierarchy and readable
contrast. Light-mode tertiary text is intentionally stronger than the dark value
because dense 11–12px metadata still needs normal-text contrast.

### Accent and semantic colors

`--accent` is reserved for primary actions, focus, current selection, active
editing state, and other high-signal moments. Do not fill large application areas
with it.

Use `--success`, `--warning`, and `--danger` only for their semantic meanings.
State must not rely on color alone; pair color with fill, ring, icon, label, or
shape where the distinction matters.

### Video-editor colors

The timeline uses type-specific clip fills/borders, a dedicated playhead token,
keyframe colors, transition colors, and lane/ruler tokens. These are editor data
signals, not a second application palette.

## Typography

The canonical families are `--font-sans` and `--font-mono`.

The UI scale is:

- `--font-size-xs` — ordinary metadata floor, timecodes, compact labels
- `--font-size-sm` — secondary labels, compact controls
- `--font-size-md` — body and message text
- `--font-size-lg` — emphasis and panel titles
- `--font-size-xl` — major section headings

**11px is the ordinary interface-text floor.** Values below it are reserved for
rare non-essential decorative marks, not labels, hints, status, buttons, timing,
or editable values.

Use `--font-weight-regular`, `--font-weight-medium`, and
`--font-weight-semibold`. Do not use intermediate weights such as 550, 610, or
650 when the system font stack cannot guarantee meaningful interpolation.

Timecodes and changing numeric readouts use tabular figures. Code, JSON, logs,
and precision numeric values may use `--font-mono`.

## Spacing, radius, controls, and density

- Spacing uses `--space-1..6` on the shared 4px scale.
- Shape uses `--radius-xs/sm/md/lg/xl`; pill controls use `--radius-pill`.
- Shared control heights use `--control-h-xs/sm/md`.
- **Interactive editor targets must be at least `--hit-target-min` (24px).** A
  glyph may remain 12–16px inside that hit box.
- Common row and panel density uses `--row-h-sm/md` and
  `--panel-padding-sm/md` where a cross-surface value is appropriate.

Compact density removes whitespace. It does **not** shrink the root typography.
Use density-specific spacing/control tokens rather than lowering readable text.

## Motion

The raw motion scale is `--dur-fast`, `--dur`, `--dur-med`, `--ease`, and
`--ease-spring`. Semantic aliases are:

- `--motion-hover` — hover/focus/selection feedback
- `--motion-disclosure` — accordion, popover, and reveal transitions
- `--motion-layout` — deliberate layout changes such as rail collapse

Prefer opacity and transform for animated presentation. Continuous timeline and
preview movement must stay imperative/performance-aware rather than becoming
layout animation. Every motion path must remain correct under
`prefers-reduced-motion` and FramePilot's explicit reduced-motion preference.

## Shared primitives

### `@framepilot/ui`

- **`Button`** — primary, secondary, ghost, danger, and icon variants; shared
  loading/busy semantics.
- **`Input`** — token-driven text field with optional leading icon.
- **`Switch`** — the canonical accessible binary preference control. Feature
  components own label/hint layout, while Switch owns `role="switch"`, checked
  state, and interaction semantics.

  **Which on/off control to reach for.** The app has exactly three, and the choice
  is decided by what the control does, not by where it sits:

  | Use                             | When                                                                                 | Example                                                   |
  | ------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
  | `Switch`                        | A preference that takes effect the moment it changes                                 | "Plan first", "Keep inside safe area", every Settings row |
  | `Checkbox` (web-editor)         | Selecting items, or a form field applied later                                       | Selecting caption rows                                    |
  | Icon button with `aria-pressed` | A tool state in a dense toolbar, where a pill would not fit and an icon reads faster | Snapping, ripple-on-delete                                |

  Never a bare `<input type="checkbox">`: the `Checkbox` primitive keeps a real
  input for keyboard and screen readers but hides it behind a token-styled box, so
  the app never shows the browser's own control. There is deliberately no global
  `accent-color` rule for checkboxes — one existed, and it quietly made a native
  checkbox look almost-right, which is how two of them shipped.

- **`SegmentedControl`** — the canonical immediately-applied single-choice group
  for compact preferences.
- **`WorkspaceShell`** — shared resizable editor workspace behavior.

### Web-editor primitives

`Select`, `Tooltip`, `Menu`, and other editor-owned primitives remain in
`apps/web-editor/src/components` where they currently depend on editor icon and
popover conventions. They are the canonical implementations for the web editor.
Promote them into `@framepilot/ui` only when package boundaries can remain clean;
do not create a second implementation meanwhile.

`Select` is preferred when a panel needs FramePilot's portal positioning,
keyboard behavior, icons, hints, or stable cross-platform presentation. Native
select remains acceptable only where native behavior is deliberately preferred.

## Interaction and accessibility conventions

- Every icon-only action has an accessible name. Use the styled Tooltip for
  unfamiliar actions rather than relying on `title` alone.
- Focus-visible treatment must remain obvious in both themes.
- Hover-only chrome must also appear on keyboard focus when the action would
  otherwise be unreachable or invisible.
- Selected/current/animated states use more than hue alone where the distinction
  affects editing decisions.
- Dense precision controls keep compact glyphs inside at least 24px targets.
- Scrollable panels contain overscroll and avoid forcing page-level scrolling.
- Long lists that can scale with project size remain virtualized or otherwise
  bounded by the relevant performance contract.

## Styling ownership

1. `packages/ui/src/tokens.css` owns shared visual values.
2. `apps/web-editor/src/editor-foundation.css` owns cross-surface ergonomics.
3. Feature stylesheets own feature layout and presentation.
4. `apps/web-editor/src/styles.css` remains the legacy/global editor sheet while
   existing sections are extracted incrementally. New feature styling must not
   add another unrelated section there.

When touching a legacy global block, prefer moving the affected feature into its
own stylesheet if that can be done as a focused, verified change. Avoid a broad
rewrite solely to chase file organization.

## Product conventions

- One accent. Use it sparingly.
- Panels are flat and border-led; floating layers get elevation.
- Save state is quiet text plus a status indicator, not a decorative pill.
- The program picture remains the visual hero of the center stage.
- Timeline state stays legible at a glance without requiring hover.
- Interface density comes from structure and spacing before smaller typography.
