# Home screen

FramePilot's home screen is intentionally a quiet launch surface. It keeps the same design tokens as the editor, so switching between light and dark themes does not introduce a separate splash-screen palette.

## Layout

The screen has three stable regions:

1. A compact header with the FramePilot mark and one appearance toggle.
2. Two primary project choices: **New Project** and **Open Project**.
3. A recent-projects list beneath a single divider.

The launch page itself does not scroll. Recent projects own their own bounded vertical scroll area, which keeps the project actions visible even when the user has many recents. Project names and paths truncate with ellipsis rather than widening the window, while the complete path remains available through the row tooltip.

## Theme behavior

The appearance control is a single icon. It resolves the current effective theme, including the `system` preference, and switches directly between light and dark. The choice uses the same persisted editor setting as the application top bar, so the home screen and editor always share one theme preference.

## Recent-project behavior

Recent projects are read from lightweight metadata rather than full project JSON. The list is sorted by most recently opened and bounded to 100 entries. The visual viewport scrolls independently, so a large list cannot push the launch controls off-screen or create horizontal overflow.

In browser mode, **Open Project** remains disabled because filesystem project selection is a desktop capability. Creating projects and opening browser recents continue to work normally.
