# Home screen

FramePilot's home screen is intentionally a quiet launch surface. It keeps the same design tokens as the editor, so switching between light and dark themes does not introduce a separate splash-screen palette.

## Layout

The screen has three stable regions:

1. A compact header with the FramePilot mark and one appearance toggle.
2. Two primary project choices: **New Project** and **Open Project**.
3. A project list beneath a single divider.

The launch page itself does not scroll. The project list owns its own bounded vertical scroll area, which keeps the project actions visible even when the user has many projects. The **Load more** control and its "Showing N of M" count sit below that scroll area, so they stay reachable without scrolling the list to its end. Project names and paths truncate with ellipsis rather than widening the window, while the complete path remains available through the row tooltip.

## Theme behavior

The appearance control is a single icon. It resolves the current effective theme, including the `system` preference, and switches directly between light and dark. The choice uses the same persisted editor setting as the application top bar, so the home screen and editor always share one theme preference.

## Project list behavior

On desktop the list, headed **Projects**, holds every project in the FramePilot Projects folder (`FRAMEPILOT_PROJECTS_ROOT`, by default `~/Documents/FramePilot Projects`), not only the recently opened ones. That includes projects copied into the folder and projects that were never opened on this machine.

- **Order:** recently opened projects first, in the order the recents list keeps them, then every other project by when its file last changed, newest first. The date beside an entry is when it was last opened (recents) or last changed (the rest); hovering the date says which.
- **Paging:** the first 10 load with the screen. **Load more** appends the next 10 and disappears once every project is shown.
- **What counts as a project:** `*.fp.json` files at the top level of the folder. Pre-migration backups (`<project>.v<N>.backup.fp.json`), hidden files such as `.framepilot-active.json`, subfolders (`media/`, `exports/`, `.framepilot-derived/`) and symlinks that lead outside the folder are left out. A recently opened project whose file is gone, or that lies outside the folder, is left out too: opening from the home screen is sandboxed to the folder, so such an entry could not be opened from here anyway.
- **Names:** a recent project shows the name stored with the recents entry. For any other project, main reads only the first 64 KiB of the file, and only for the entries on the page being returned, and takes the top-level `name`. If that fails, the entry shows its file name without `.fp.json`. Project files run to several MB, so the list never parses a whole project.
- **Opening** an entry works exactly as opening a recent project did: it goes through the same sandboxed open.

The renderer asks main for one page at a time over the read-only `framepilot:project:list` channel (`listProjects({ offset, limit })` on the bridge). Main validates the request, since the renderer is untrusted: `offset` must be a whole number of 0 or more and `limit` one of 1 or more, capped at 50. A missing or unreadable folder lists nothing rather than failing, and main never creates the folder to list it. The listing lives in `apps/desktop/electron/projects/project-list.ts` (logic) and `project-list-io.ts` (sandboxed file access).

A desktop app whose preload does not have `listProjects` yet (a development build not restarted since the change), or whose listing fails, falls back to the recently opened list under the heading **Recent projects**, bounded to 100 entries, so the screen is never blank.

In browser mode, **Open Project** remains disabled because filesystem project selection is a desktop capability. Creating projects and opening browser recents continue to work normally.
