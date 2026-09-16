# 05 — Inspector UX: Mask tab, background removal, and pack warnings

## Placement

The **Mask tab** becomes the professional mask panel described in
[`10`](./10-PROFESSIONAL-MASKING.md#editing-tools-monitor--inspector) (mask list, per-mask properties,
keyframes, tracking, review). Background removal is its first action row: **[ Remove background ]**,
a preset that adds an AI subject `matte` mask targeting clip alpha. Everything below describes that
row and the states every AI or pack-backed mask tool shares. It appears only for video and image clips.

Components (`apps/web-editor/src/components/inspector/masks/`): `MaskPanel.tsx`, `MaskList.tsx`,
`MaskProperties.tsx`, `MaskTracking.tsx`, `MaskReviewPanel.tsx`, `BackgroundRemovalRow.tsx`, and the
monitor overlay `apps/web-editor/src/components/preview/MaskCanvasTools.tsx`. State lives in
`useMaskTools.ts` + `usePackStatus.ts`. `MaskPackActions.tsx` and the hardcoded `addMaskPatch` are
deleted once their replacements pass. Built from the design system (`Button` variants,
`InspectorSection`, `InspectorRow`, tokens in `styles.css`), with no new colour tokens.

## Pack-backed tools and their warnings

| Tool                                                              | Needs                             | Without it                                                                                 |
| ----------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| Rectangle, Ellipse, Pen, Freehand, Key, all properties, keyframes | Nothing (core)                    | Always available                                                                           |
| Remove background, AI Object, AI Brush                            | **Smart Mask pack**               | Warning + disabled tool, as below                                                          |
| AI Object "auto (main subject)"                                   | Smart Mask + Subject Intelligence | Falls back to "click the subject" with a note; never proposes a second download on its own |
| AI requests naming an object in words ("the red car")             | **Smart Mask Text pack**          | The agent asks the editor to click the object instead                                      |
| Track mask                                                        | **Tracking Lite pack**            | Same warning pattern, naming Tracking Lite                                                 |
| AI masking in the sidebar                                         | Whichever pack the tool needs     | `PackInstallInlineCard` (existing)                                                         |

`usePackStatus(capability)` calls `capabilityPackStatus` on mount and on `onCapabilityPackInstalled`,
so every tool's state updates without restart, whichever surface performed the install. Disabled AI
tools stay **visible** in the monitor toolbar with the same tooltip, so the editor can see the
capability exists.

## State machine

```
            ┌──────── browser build ────────► UNAVAILABLE ("Needs the FramePilot desktop app")
mount ──► CHECKING ──► PACK_MISSING ──install ok──► CHECKING
                  │         │ install fails ──► PACK_MISSING + error
                  ├──► PACK_UNHEALTHY (reason, Reinstall)
                  ├──► UNSUPPORTED_PLATFORM
                  └──► READY ──Remove──► RUNNING ──ok──► NEEDS_REVIEW (flagged > 0) ──all resolved──► VERIFIED
                                  │   └─cancel─► READY          └──────────── ok, flagged = 0 ──────────► VERIFIED
                                  └─ refusal ─► READY + error (typed, with remedy)
NEEDS_REVIEW / VERIFIED ──brush / lock / approve──► (RUNNING for brush, instant for approve/lock) ──► NEEDS_REVIEW | VERIFIED
any applied state ──look controls──► same state (update_mask, undoable)
applied + clip trimmed past coverage ──► STALE ("Update for new range")
applied + artifact missing/mismatch ──► BROKEN ("Recompute" if pack ready, else PACK_MISSING copy)
```

`CHECKING` calls `capabilityPackStatus('subject.matte')` on mount and again whenever
`onCapabilityPackInstalled` fires. Installing from Settings, the AI sidebar card or this section
all update an open Inspector without restart.

## Copy and controls per state

The lead-prompt-engineer and unslop passes finalise the wording. The **content** is fixed here.

**PACK_MISSING** (warning shown before any click):

> ⚠ **Background removal isn't installed.**
> It won't work until you install the Smart Mask pack (**{size} download**, runs entirely on
> this computer; nothing is uploaded). Licences: {spdx list}.
>
> [ Install {size} ] [ Details ]
>
> [ Remove background ] ← visible but **disabled**, `aria-disabled`, tooltip "Install the Background
> Removal pack first"

- The warning is `role="status"` + `aria-live="polite"`, not `role="alert"` (which would announce on
  every clip selection). The disabled button's `aria-describedby` points at it.
- **Install** uses the signed proposal returned with the status (`useProposalInstall`), shows byte
  progress (`onCapabilityPackProgress`), "Verifying…" during the health check, and allows cancel.
  On success the section re-checks and goes to READY with "Installed. You can remove backgrounds now."
- **Install failed:** the typed reason (checksum, disk space, health check) and Retry.
- **Offline / no catalog:** "Can't reach the pack catalog. Check your connection, or install it later
  from Settings → Storage." Remove stays disabled.

**PACK_UNHEALTHY:** "The Smart Mask pack is installed but failed its health check: {reason}."
Offers [Reinstall].

**UNSUPPORTED_PLATFORM:** "Background removal isn't available for this computer yet (needs Apple
Silicon macOS or Windows x64)." No install button.

**READY**

- Subject: `Auto (main subject)` | `Click to pick`. Pick mode on the monitor: click = include,
  Alt-click = exclude, Esc cancels, with an on-canvas hint.
- "Covers this clip plus 2 s of handles."
- An estimate before running: "About {eta} on this computer · {size} on disk". A job estimated at
  over 10 minutes asks for confirmation.
- [ Remove background ] (primary).

**RUNNING:** phase and round (`decode → segment → refine → consensus → self-correct (round n/3) →
matte → foreground → stabilise → verify → encode`), progress bar, elapsed and ETA, and [Cancel]. The
editor stays usable, and a selection change does not lose the job.

**NEEDS_REVIEW** (the precision workflow):

- Header: "**{n} moments need a look**. Everything else was checked automatically." with a count of
  verified frames.
- **Review list:** each flagged range with its reason in plain words ("Edges disagreed", "Subject
  partly hidden", "New shape appeared") and a thumbnail. Clicking seeks the playhead and switches the
  monitor to **Overlay** view (red tint on removed area, flagged pixels outlined).
- Per range: **[Looks right]** → `review_mask` approve (instant). **[Fix]** → the brush tools below.
  **[Next]** jumps to the following range. `J`/`K` step between flagged ranges; `←`/`→` step frames.
- **Brush tools** on the monitor at 100–400% zoom: **Keep** brush, **Remove** brush, **Edge** brush
  (marks a band for matting, for hair), adjustable size and hardness, with a live overlay. [Apply
  fix] saves the stroke as a correction (`matteSaveCorrection`) and re-runs only the affected window.
  The fix propagates to neighbouring frames and the updated flags come back.
- **Lock frame** after fixing: stores the current alpha as a hard constraint that no later run
  may change.
- Undo/redo covers every approve, fix and lock (each is a patch referencing a new artifact or review state).

**VERIFIED:** a "Verified: every frame checked" badge, with the date and pack version on hover. The
review list collapses to "Show checked moments".

**Controls in any applied state:**

- **Enabled**, **Invert** ("Keep background, remove subject").
- **Clean edges** (decontaminate, on by default): "Removes the old background's colour from hair and
  edges."
- **Look** (collapsed by default, labelled "Creative"): Edge shift (Choke ↔ Spread) and Feather,
  both 0 by default. They change the look; they are not how you fix a mistake. Each change is one
  `update_mask` patch on release, and the preview updates live while dragging.
- **View:** Composite | Matte | Overlay | Flagged (preview only).
- **[ Put text behind subject ]**: runs the `add_text_behind_subject` composite op and selects the new
  text clip in the Text tab. The same result is possible by hand (duplicate the clip, remove the
  background on the top copy, put text between).
- If nothing is behind the clip: "Nothing below this clip, so the removed area exports as black. Put
  a clip, image or colour on the track below."
- [ Remove background removal ] (ghost, destructive tone) → `remove_mask`, undoable.

**Export dialog:** if any matte in the timeline is in NEEDS_REVIEW, export shows "{n} background
removal moments haven't been checked" with [Review] and [Export anyway]. It never blocks silently or
hides the count. STALE and BROKEN use the same remedy text in the Inspector and the export dialog.

## Production states (from the audit in [`12`](./12-PARITY-AND-PRODUCTION-AUDIT.md))

- **This build can't download packs** (`catalog_unconfigured`): "Smart Mask can't be installed from this
  build." No install button. Development builds add "Use a locally registered pack". Releases never show this state (RD1 gate).
- **Hardware below minimum:** the warning names the requirement before download ("Needs Apple Silicon
  (Intel Macs aren't supported)" / "Needs 16 GB of memory; this Mac has 8 GB, so it will run slower").
- **Preparing models (first run only):** a progress phase before the first job, never an unexplained wait.
- **Hover highlight:** with AI Object active, the object under the pointer is tinted; click adds it. A
  one-line hint appears the first time.
- **Progressive results:** finished ranges show matted in the monitor while the job continues; unfinished
  ranges show the original picture with a striped "Processing" band on the clip in the timeline and a
  label in the monitor corner, so a partially processed clip is never mistaken for a finished one.
- **Jobs panel:** every running, queued, paused and resumable job across the project, with pause, cancel,
  and "Show clip". A job resumed after restart says so.
- **Media changed (STALE):** "This clip's media changed since the mask was made. Recompute" with an
  estimate.
- **HDR source:** "HDR footage is converted to SDR for masking and export" on HDR clips (P6 limitation),
  never silent.
- **Face identity consent** (only when an AI request needs to tell people apart): "Allow FramePilot to
  recognise faces in this project to tell people apart? Runs on this computer; you can delete it anytime
  in Project settings." [Allow for this project] [Pick faces myself]. Declining never blocks masking; the
  agent then asks the editor to pick.
- **Disk space:** the estimate line turns into a blocking message when free space is short.

## Accessibility and responsiveness

- Keyboard-reachable everywhere: pick mode (arrow-key crosshair, Enter include, Shift+Enter exclude)
  and the review list (J/K). Brush tools accept a pointer; keyboard users get **Looks right**,
  point-based fixes and Lock, so no correction path requires a mouse.
- Progress uses `role="progressbar"`; completion and review counts are announced politely once.
- Sliders show numbers and accept typed input. The section works at the Inspector's minimum width.
- Playwright `getByRole(name)` substring-matches: "Remove background" vs "Remove background
  removal" collide, so e2e uses `exact: true`.

## Tests (BR6)

- `BackgroundRemovalRow.test.tsx` and `MaskPanel.test.tsx`: every state with a fake bridge; the disabled button plus
  warning in PACK_MISSING; the refresh on `onCapabilityPackInstalled`; install progress, failure
  and success; undo back to READY.
- `MaskReviewPanel.test.tsx`: approve, fix and lock transitions; NEEDS_REVIEW → VERIFIED; J/K navigation.
- `MaskCanvasTools.test.tsx`: draw/edit each kind with mouse and keyboard, tangents, vertex insert/delete across path keyframes, nudges, snapping, zoom; each gesture yields exactly one patch on release.
- `useMaskTools.test.ts` / `usePackStatus.test.ts`: the late-progress race, cancel, a stale revision, a selection change
  while running, and a partial-window re-run after a brush fix.
- `Inspector.tabs.test.tsx`: the Mask tab is hidden for audio and text clips; the mask list reorders by drag and keyboard.
