# 05 — Inspector UX: Mask tab → Background

## Placement

A new **Background** section at the top of the existing **Mask** tab (`INSPECTOR_TABS` id `mask`;
`SECTION_TABS` gets `background: 'mask'`), above the shape-mask controls and `MaskPackActions`.
It appears only for video and image clips.

Component: `apps/web-editor/src/components/inspector/BackgroundRemovalSection.tsx`, with state in
`useBackgroundRemoval.ts` and the review UI in `MatteReviewPanel.tsx`. Built from the design system
(`Button` variants, `InspectorSection`, `InspectorRow`, tokens in `styles.css`). No new colour
tokens; the warning uses the existing warning tone.

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
any applied state ──look controls──► same state (update_matte, undoable)
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
> It won't work until you install the Background Removal pack (**{size} download**, runs entirely on
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

**PACK_UNHEALTHY:** "The Background Removal pack is installed but failed its health check: {reason}."
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
- Per range: **[Looks right]** → `review_matte` approve (instant). **[Fix]** → the brush tools below.
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
  `update_matte` patch on release, and the preview updates live while dragging.
- **View:** Composite | Matte | Overlay | Flagged (preview only).
- **[ Put text behind subject ]**: runs the `add_text_behind_subject` composite op and selects the new
  text clip in the Text tab. The same result is possible by hand (duplicate the clip, remove the
  background on the top copy, put text between).
- If nothing is behind the clip: "Nothing below this clip, so the removed area exports as black. Put
  a clip, image or colour on the track below."
- [ Remove background removal ] (ghost, destructive tone) → `remove_matte`, undoable.

**Export dialog:** if any matte in the timeline is in NEEDS_REVIEW, export shows "{n} background
removal moments haven't been checked" with [Review] and [Export anyway]. It never blocks silently or
hides the count. STALE and BROKEN use the same remedy text in the Inspector and the export dialog.

## Accessibility and responsiveness

- Keyboard-reachable everywhere: pick mode (arrow-key crosshair, Enter include, Shift+Enter exclude)
  and the review list (J/K). Brush tools accept a pointer; keyboard users get **Looks right**,
  point-based fixes and Lock, so no correction path requires a mouse.
- Progress uses `role="progressbar"`; completion and review counts are announced politely once.
- Sliders show numbers and accept typed input. The section works at the Inspector's minimum width.
- Playwright `getByRole(name)` substring-matches: "Remove background" vs "Remove background
  removal" collide, so e2e uses `exact: true`.

## Tests (BR6)

- `BackgroundRemovalSection.test.tsx`: every state with a fake bridge; the disabled button plus
  warning in PACK_MISSING; the refresh on `onCapabilityPackInstalled`; install progress, failure
  and success; undo back to READY.
- `MatteReviewPanel.test.tsx`: approve, fix and lock transitions; NEEDS_REVIEW → VERIFIED; J/K navigation.
- `useBackgroundRemoval.test.ts`: the late-progress race, cancel, a stale revision, a selection change
  while running, and a partial-window re-run after a brush fix.
- `Inspector.tabs.test.tsx`: the section lives in the Mask tab and is hidden for audio and text clips.
