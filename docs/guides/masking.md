# Masking in FramePilot

One page for everything masking: what the tools are, how a mask follows a subject, how to check
and fix what the AI was unsure about, what it cannot do yet, the keyboard, what to do when
something refuses, what a computer needs, and what stays private.

The detail lives in the feature guides; this page links to them rather than repeating them:

| Guide                                              | For                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| [Mask tools](./mask-tools.md)                      | Drawing and editing masks by hand, keying a colour, the Inspector panel |
| [Mask tracking](./mask-tracking.md)                | Making a shape follow its subject, the four methods, constraints        |
| [Background removal](./background-removal.md)      | The Smart Mask cut-out, its states, review and fixes, the Jobs tab      |
| [Masks on the program monitor](./preview-masks.md) | How the monitor draws exactly what the export draws                     |
| [AI masking tools](../api/ai-masking.md)           | What the assistant can do with masks, and the rules it cannot break     |

Decisions behind all of it: [ADR 0178](../adr/0178-mask-stack-replaces-mask-effects.md) (the mask
stack), [ADR 0179](../adr/0179-smart-mask-packs.md) (Smart Mask as a pack),
[ADR 0180](../adr/0180-the-program-monitor-composites-every-timeline.md) (one compositor, so the
monitor matches the export), [ADR 0181](../adr/0181-matte-monitor-tier-is-host-derived.md) (the
matte monitor tier), [ADR 0176](../adr/0176-local-perception-ships-as-packs.md) (local models ship
as packs).

## The tools

Select a video or image clip and open **Inspector → Mask**. A clip carries a **stack** of masks,
read top to bottom, each with a blend mode (add, subtract, intersect, …), opacity, invert,
expansion and inner/outer feather.

- **Shapes you draw:** rectangle, ellipse, pen path, freehand (fitted to a smooth path), split,
  mirror band, linear and radial gradient, and preset shapes (heart, star, polygon, speech bubble,
  arrow, rounded frame). [Mask tools](./mask-tools.md).
- **A colour key** (HSL, RGB, luma or a 3D sample), with despill for green and blue screens.
- **Another clip or a whole track as the mask** — a title makes "video inside text".
- **Background removal** — an AI cut-out of the subject, measured on every frame by the Smart Mask
  pack. [Background removal](./background-removal.md).
- **What a mask limits.** A mask either cuts the clip (its alpha) or limits one of the clip's
  **effects**: a grade, a LUT or a **blur**. The Inspector's **Effects** tab has **Add blur**
  (strength is a share of the picture, so it looks the same at every resolution); press **Add
  mask** on the blur's row and draw — that is a face or plate blur. Track the mask and the blur
  stays on the face. One blur per clip; each face is its own mask on it.
- **Edge styles** on a cut-out: outline, glow, drop shadow.
- **Animation.** Every property keys at the playhead; a path keys its whole shape. Mask keyframes
  live on the clip's own media clock, so trims, splits and speed changes never make a mask drift.

Every gesture is one undo step. Masks preview on the program monitor exactly as they export: the
monitor and the export evaluate the same frame plan, checked by a pixel oracle on every mask kind.

## Tracking

**Track this mask** (Mask tab) measures how the picture under a shape moves — position,
position + scale + rotation, perspective, or the shape's own points — forwards, backwards or both
from the frame you drew it on. The result is stored in the project, pinned by digest, and the mask
follows it in the monitor and the export alike. Frames the tracker was unsure about go on the
review list. [Mask tracking](./mask-tracking.md).

A track cannot yet drive a title or an overlay (a title that follows a subject needs a schema
decision, MO-14).

## Reviewing and fixing

Background removal and tracking share one **review list** in the Inspector:

- Every moment the automatic checks could not verify is listed. `J` / `K` step through them;
  opening one seeks there and switches the monitor to **Overlay**.
- **Looks right** approves a moment. **VERIFIED** appears only when nothing is flagged — never just
  because a job finished, and the assistant never says it on your behalf.
- **Fix a cut-out:** paint **Keep**, **Remove** or **Edge** (hair, motion blur) and **Apply fix**; only
  the window around that moment runs again. **Lock this frame** so no later run can change it.
- **Fix a track:** correct the mask on a bad frame, **Lock this frame** (it becomes a constraint), then
  **Re-track from constraints**. The constraints stay with the mask for the next re-track.
- **Mask view** on the monitor (Off, Overlay, Mask only, Checkerboard) shows what the stack keeps; it never reaches the export.

The export dialog counts unchecked moments and offers **Review**; it never blocks the export.

## Long jobs, quitting and moving projects

- Background removals and tracks run as **jobs** (right rail → **Jobs**): one heavy job at a time,
  paused during an export, pausable and cancellable. Selecting another clip does not stop them.
- **If the app quits or crashes mid-job**, the job is remembered. Reopen the project and it resumes
  ("Resumed after restart"), keeping the windows it had already finished instead of starting
  over; the result is identical to an uninterrupted run. Then press **Remove background** again:
  the finished matte applies at once. (A job left more than a day before the project is reopened
  starts over.)
- **Moving a project** (another folder, drive or computer) needs no step of its own: media paths
  are stored relative to the project file, and every matte and track is kept inside the project
  folder under `.framepilot-derived/`. Copy the whole folder. Leave that folder out and the clip
  says what is missing and the export refuses rather than exporting something different.
- **Relinking to different footage** marks a background removal **STALE** ("Media changed since
  background removal ran — run Remove background again."), and the export refuses it. Run it again
  and the new cut-out replaces the stale one.

## Masks from the assistant

Ask in the sidebar: "remove the background", "blur the faces except the host", "darken everything
but the presenter", "put the title behind her", "split screen, keep the left half". The assistant
uses the same packs, operations and review list as the Inspector, and it never gives coordinates:
every mask comes from a detection, a measurement, or numbers you typed.

When the request is unclear it **asks**: thumbnails of the candidates, and you pick. "Everyone
except the host" always shows the face picker — who is who is your call. Face recognition (below)
only changes what the picker can remember. [AI masking tools](../api/ai-masking.md).

### A title behind someone

"Put MOTION behind him" is built as three layers on the shot: the original (background and
sound), the title, and a copy of the shot in front that draws only the person, through the
cut-out. A second title on the same shot goes on the same title layer, for its own moment.

The assistant **measures before it places**: `measure_subject` reads the cut-out on the delivered
frame — top of the head, shoulder line, how much of the width the person covers at each height —
and answers where a given word, at a given size and font, reads as behind them: partly covered,
both ends visible. It centres the word on the person rather than the frame, fits it inside the
title-safe width, and when no size or position works (a tight close-up where the head fills the
frame) it says so and suggests easing a punch-in or putting the title in front instead.

The front copy must actually draw the person. A cut-out switched to **Subtract** (or inverted, or
at zero opacity) in the mask list draws nothing from an empty stack, so the title sits on the
face; the assistant refuses to add a title behind it and says to set the cut-out back to **Add**.

## Keyboard

Focus the monitor canvas (click it, or Tab to it) with the Mask tab open.

| Key                     | Does                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `V`                     | Selection: move masks, points and tangents                         |
| `R` `E` `P` `F`         | Rectangle, Ellipse, Pen, Freehand                                  |
| `S` `M` `G` `H`         | Split, Mirror band, Gradient, Shapes                               |
| `O` `B`                 | AI Object (click to keep, Alt-click to leave out), AI Brush        |
| `T` `X`                 | Tracker feature point, exclude region                              |
| Arrows / Shift+arrows   | Move the crosshair, or nudge the selection 1 px / 10 px            |
| `Space`                 | Place a point or corner at the crosshair (keyboard drawing)        |
| `Enter` / `Shift+Enter` | Close a path; with AI Object, keep / leave out under the crosshair |
| `Esc`                   | Cancel the current drawing                                         |
| `[` `]`                 | Step through a path's points                                       |
| `Delete`                | Remove the selected points, or the mask                            |
| `Alt+↑` / `Alt+↓`       | Reorder the selected mask in the stack                             |
| `J` / `K`               | Previous / next moment in the review list                          |

## Limitations (today)

- **Background removal is not installable yet.** The Smart Mask pack has no catalog entry and no
  signed release (MO-1 to MO-5), and its accuracy is not at the plan's gates (BR3.15, BR7.4). The
  same holds for Tracking Lite and Subject Intelligence releases. Everything is built and tested
  against the pack contracts; the end-to-end tests stand in for the packs (below).
- **A title or overlay cannot follow a track** (MO-14). A mask can reuse another mask's track.
- **The clip blur is a Gaussian blur.** There is no masked mosaic or pixelate yet, and one blur per
  clip.
- **Hover highlight** (AI Object tinting what a click would pick) measured about 431 ms on real
  weights on an M1 Pro, over its 100 ms budget.
- **Flag reasons do not survive a reopen**, and there is **no HDR notice** (both need a schema
  decision, MO-15).
- **Only shape masks can be tracked**; a matte or a key follows its own pixels. You cannot see the
  tracker's own feature points before a run.
- **The browser build** draws masks and previews mattes that exist, but cannot run pack jobs.
- **Windows** is built and tested in CI (including moving a project between macOS and Windows), but a
  packaged app on real Windows hardware has not been exercised (MO-9).

## Troubleshooting

| You see                                                                         | Why                                                                                | Do                                                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| "Background removal isn't installed." (tools disabled)                          | The Smart Mask pack is not on this computer                                        | Install from the offer; nothing downloads until you approve it           |
| "Smart Mask can't be installed from this build."                                | This build has no pack catalog                                                     | Use a release build                                                      |
| "Media changed since background removal ran — run Remove background again."     | The clip was relinked or its file replaced (STALE)                                 | Run Remove background again; it replaces the old one                     |
| "Background removal data is missing / damaged / was changed outside FramePilot" | Files under `.framepilot-derived/mattes` were moved, edited or not copied (BROKEN) | Copy the whole project folder, or run it again                           |
| "Tracking data is missing — track the mask again." / "Mask not previewed yet"   | The track file is missing, or still loading                                        | Wait a moment; if it stays, copy the project folder whole or track again |
| "Tracking data was measured with a different method"                            | The method changed after the track was made                                        | Track again                                                              |
| "Not enough disk space: this needs about …"                                     | The job's output would not fit                                                     | Free space, then **check again**                                         |
| "… needed more memory than this computer can spare and was stopped."            | The job passed its memory limit (the smaller of 60% of memory and 8 GB)            | Close other apps, or use a shorter range                                 |
| "The Smart Mask pack stopped responding and was stopped."                       | No progress for 5 minutes                                                          | Try again                                                                |
| "… was about to fill the disk and was stopped."                                 | The job's folder reached free space minus 1 GB, or its output passed its ceiling   | Free up space and try again                                              |
| "This is the path's only shape. Move the playhead …"                            | Animate on the only keyframe of a path                                             | Move the playhead, press Animate there, then reshape                     |
| "Preview reduced"                                                               | The monitor dropped resolution to keep playing                                     | Nothing: the export is unaffected                                        |
| The assistant asks "Which one did you mean?"                                    | More than one thing matches, or WHO matters                                        | Pick in the sidebar; that is by design                                   |
| A "behind" title sits on top of the person                                      | The front copy's cut-out is set to Subtract, inverted, or switched off             | In the mask list set it back to Add, not inverted                        |
| Masks are missing from the toolbar or the assistant                             | A kill switch is off: `VITE_FRAMEPILOT_MASK_TOOLS`, `FRAMEPILOT_AI_MASKING`        | Unset it (packaged releases keep them off until RD3)                     |

Operators: the job events, failure codes and dashboards are in
[`docs/runbooks/masking-observability.md`](../runbooks/masking-observability.md); the pack
sandbox, watchdog and limits in [`docs/runbooks/capability-pack-security.md`](../runbooks/capability-pack-security.md).

## What a computer needs

Drawing, keying, tracking masks you already have, and exporting any masked project need nothing
beyond FramePilot itself.

Background removal runs the Smart Mask models on the computer. **The supported minimum is not
decided yet (MO-12).** What was measured (BR0.7): about 6–7 GB peak memory per job on the CPU;
the matting model at its trained resolution needs about 12 GB on the CPU; the Core ML video path
reached 16 GB. The app warns below 16 GB of memory today and still runs, slower; the host stops a
job that takes more than 60% of memory (8 GB cap for Smart Mask). The measured CPU speed is about
520 seconds of compute per second of 1080p30 footage, which the estimate line uses — a computer with
a GPU execution provider may well beat it. The same line shows the disk space the cut-out will
take; while it runs the job also needs working space for one window of decoded frames.

## Privacy and face recognition

- **Everything runs on this computer.** Packs are signed, run with no network access and read only
  the project's own media; nothing is uploaded. Each install offer states "Media never leaves this
  computer" before anything downloads.
- **Face recognition is off by default, per project.** "Everyone except the host" always asks you
  to pick the faces. The face picker offers **Turn on for this project** so FramePilot can remember
  who is who in _this_ project; it is stored in the project's own brain, never shared across
  projects, and no model can switch it on. **Delete identity data** removes every stored identity
  and turns it off in one step. Today consent does not yet save you a pick (no shipped pack
  produces an identity for a detection), so the picker asks either way.
- **Unreadable is no consent.** If the engine cannot answer, FramePilot treats it as off.
- The consent wording and privacy text await legal review before release (RD2.3).

## How it is tested

The end-to-end suite (`pnpm --filter @framepilot/e2e test:masking`, the CI job "Masking end to end")
drives the real editor in desktop mode against the real desktop host modules and engine:

| Spec                                           | Proves                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `masking-e2e-background-removal`               | E2E.1: missing pack → install → remove → review, fix, lock → text behind → preview == export → undo          |
| `masking-e2e-reopen`                           | E2E.2: reopen with no packs; a deleted matte shows BROKEN and the export refuses                             |
| `masking-e2e-pro-masking`                      | E2E.3: pen path → animate → perspective track → review, constrain → masked blur → preview == export          |
| `masking-e2e-ai`                               | E2E.4: "blur the faces except the host" (face picker, consent), "put the title behind her" (asks)            |
| `masking-e2e-migration`                        | E2E.5: an older project with masks opens, migrates and exports byte-identically                              |
| `masking-e2e-resume`                           | E2E.6: crash mid-job → relaunch → resume from finished windows, identical output; relink → STALE → recompute |
| `masking-e2e-archive` + CI `masking-archive-*` | E2E.7: a project moves between folders and between macOS and Windows and exports the same                    |
| `masking-e2e-compositing`                      | E2E.8: split, mirror, gradient, track matte, text as mask, adjustment-lane mask, edge styles                 |

What each spec simulates is written in its header (for the release gate, RD3): Electron and
`fp-media://`, signed pack installs, the models inside the pack workers (E2E.6 runs the real Smart
Mask pipeline with scripted models), the tracker's output (E2E.3), and the AI model (E2E.4 uses a
scripted policy; no live model calls). Manual checks for what automation cannot see are in
`MANUAL_TESTING.md` §16.
