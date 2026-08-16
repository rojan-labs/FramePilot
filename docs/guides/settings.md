# Settings control room

FramePilot settings are device preferences and service configuration. They do
not edit the current project or bypass the typed timeline-patch path. Changes
save automatically on the current device; **Reset to defaults** restores editor
preferences without deleting projects, media, AI keys, or learned workflows.

Open Settings from the application bar or press `⌘,`. The dialog restores focus
to the control that opened it, traps keyboard focus while open, closes with
Escape, and supports Arrow keys plus Home/End between its section tabs.

## Compact desktop layout

The desktop Settings surface is a compact editor utility with the restrained,
low-elevation pattern used by tools such as Notion, Linear, and Cursor. The
visual hierarchy is intentionally quiet: a small title lockup, grouped navigation
on the left, a readiness summary at the bottom of the rail, and flat bordered
setting groups in the main pane.

The active navigation item uses a neutral surface instead of an accent-colored
selection. Settings groups use subtle one-pixel structure, modest corner radii,
compact rows, neutral segmented controls, and low-profile switches. Accent color
stays reserved for focus, status, and product actions. The visual language uses
FramePilot's shared light/dark design tokens rather than a Settings-specific
palette.

Settings-specific layout remains in `apps/web-editor/src/settings-dialog.css`.
Cross-surface readability, hit-target, density, and focus rules live in
`apps/web-editor/src/editor-foundation.css`, while shared values live in
`packages/ui/src/tokens.css`. Settings consumes the shared `Switch` and
`SegmentedControl` primitives from `@framepilot/ui`, so their keyboard semantics
and state behavior cannot drift from future preference surfaces.

Dense UI text keeps the shared 11px ordinary-interface floor. Compact density
reduces spacing and control chrome while preserving readable typography instead
of lowering the application's root font size. Switches retain at least a 24px
interaction target even though the visible thumb remains small.

The compact shell keeps the timeline and surrounding editor context recognizable
behind the modal while still leaving enough room for AI provider fields and
editing defaults. The user's **Interface density** preference continues to
control the main editor as before.

On wider displays, the short **Editing** and **Playback** groups can sit side by
side. Long sections such as **AI**, **Memory**, and **Shortcuts** remain vertically
scrollable within the content pane. At tablet-sized widths the rail becomes a
horizontal tab strip; the readiness summary is hidden to preserve room for the
actual controls. No preference or service option is removed by the responsive
layout.

## Sections

- **Display** controls System/Light/Dark theme, timecode versus seconds, and
  comfortable versus compact workspace density.
- **Editing** controls timeline snapping, clip thumbnails, playhead following,
  and the default duration for new overlays.
- **Playback** controls loop, composition-grid and safe-area defaults, plus reduced
  motion. The program monitor uses the product preview path automatically, so
  preview-engine selection is not exposed as a preference.
- **AI** configures the active reasoning provider and each provider's key/model
  fields. It also configures local or TwelveLabs speech-to-text, TwelveLabs media
  understanding, project preparation status, and the optional AI usage-details
  diagnostic.
- **Memory** stores cross-project audience, brand, caption, pacing, and platform
  preferences, plus saved workflow recipes. Project memory can override these
  defaults for an individual edit.
- **Shortcuts** is the searchable view of the same canonical shortcut registry
  used by the editor, so the help surface cannot drift from actual commands.

## Readiness rail

The desktop layout keeps three compact signals visible while navigating:

- **Preferences** confirms that settings are local to the device.
- **AI provider** reports the active provider or directs the user to set one up.
- **Footage** reports whether a project is open.

These are informational only. They do not add a second source of truth for AI or
project state.

## Privacy and safety

Provider keys are stored through the existing AI configuration boundary and are
never displayed back by the desktop main process. Local transcription stays on
this device. Configuring TwelveLabs allows selected media to be sent to its hosted
service for transcription or semantic media understanding and may use provider
credits. See the [Media Intelligence guide](./media-intelligence.md) for the
service-specific behavior.
