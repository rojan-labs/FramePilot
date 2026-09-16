# 05 — Inspector UX: Mask tab → Background

## Placement

A new **Background** section at the top of the existing **Mask** tab
(`INSPECTOR_TABS` id `mask`, `SECTION_TABS` gets `background: 'mask'`). It sits above the
shape-mask controls and `MaskPackActions`, because background removal is the first thing most
editors look for there. It appears only for video and image clips, like the mask section.

Component: `apps/web-editor/src/components/inspector/BackgroundRemovalSection.tsx`, with state in
`useBackgroundRemoval.ts`. Built from the design system (`Button` variants,
`InspectorSection`, `InspectorRow`, tokens in `styles.css`). No new colour tokens; warning uses the
existing warning tone.

## State machine

```
            ┌──────────── browser build ───────────► UNAVAILABLE ("Needs the FramePilot desktop app")
mount ──► CHECKING ──► PACK_MISSING ──install ok──► CHECKING
                  │         │ install fails ──► PACK_MISSING + error
                  ├──► PACK_UNHEALTHY (reason, Reinstall)
                  ├──► UNSUPPORTED_PLATFORM
                  └──► READY ──Remove──► RUNNING ──ok──► APPLIED ◄──── undo/redo re-derives
                                  │   └─cancel─► READY
                                  └─ refusal ─► READY + error (typed, with remedy)
APPLIED ──Refine / Invert / Disable──► APPLIED (update_matte, undoable)
APPLIED ──Add correction──► CORRECTING ──Update──► RUNNING
APPLIED + clip trimmed past coverage ──► STALE ("Update for new range")
APPLIED + artifact missing/mismatch ──► BROKEN ("Recompute" if pack ready, else PACK_MISSING copy)
```

`CHECKING` calls `capabilityPackStatus('subject.matte')` on mount and again whenever
`onCapabilityPackInstalled` fires. So installing from Settings, from the AI sidebar card, or from
this section all update an open Inspector without restart.

## Copy and controls per state

The lead-prompt-engineer / unslop pass finalises the wording. The **content** is fixed here.

**PACK_MISSING** (the warning the user asked for):

> ⚠ **Background removal isn't installed.**
> It won't work until you install the Background Removal pack (**{size} download**, runs
> entirely on this computer; nothing is uploaded). Licences: {spdx list}.
>
> [ Install {size} ] [ Details ]
>
> [ Remove background ]  ← visible but **disabled**, `aria-disabled`, tooltip "Install the
> Background Removal pack first"

- `role="alert"` is **not** used on mount (it would announce on every clip selection). The warning
  is a `role="status"` region with `aria-live="polite"`, and the disabled button's
  `aria-describedby` points at it.
- **Install** uses the signed proposal returned with the status (`useProposalInstall`), shows
  byte progress from `onCapabilityPackProgress` and "Verifying…" during the health check, and
  allows cancel. On success the section re-checks, goes to READY, and shows a brief
  "Installed. You can remove backgrounds now." status.
- **Install failed**: the typed reason (checksum, disk space, health check) plus a Retry.
- **No catalog / offline**: "Can't reach the pack catalog. Check your connection, or install it
  later from Settings → Storage." The Remove button stays disabled.

**PACK_UNHEALTHY**: "The Background Removal pack is installed but failed its health check:
{reason}." Offers [Reinstall].

**UNSUPPORTED_PLATFORM**: "Background removal isn't available for this computer yet (needs
Apple Silicon macOS or Windows x64)." No install button.

**READY**:

- Subject: `Auto (main subject)` | `Click to pick` (the monitor enters a pick mode; left-click
  = include point, Alt-click = exclude, Esc cancels, and an on-canvas hint says so).
- Coverage note: "Covers this clip plus 2 s of handles."
- An estimate before the run: "About {eta} on this computer · {matteSize} on disk." A long job
  (> 10 min estimated) asks for confirmation first.
- [ Remove background ] (primary).

**RUNNING**: phase + progress bar (`decode → segment → refine → matte → stabilise → encode`),
elapsed and ETA, and [Cancel]. The editor stays usable. The job is keyed by `requestId`, so
switching the selection does not lose it; re-selecting the clip shows its progress again.

**APPLIED**:

- Toggle **Enabled**; **Invert** ("Keep background, remove subject").
- **Edge**: shift slider (Choke ↔ Spread), **Feather** slider. Each change is one
  `update_matte` patch on release, and the preview updates live while dragging.
- **View**: Composite | Matte (white on black) | Overlay (red tint on removed area). The view
  is preview-only state and never enters the project.
- **Needs review**: a list of `lowConfidence` ranges as clickable timecodes that seek the
  playhead. It is hidden when empty.
- **Fix a frame**: seek to a frame → [Add correction] → pick mode → [Update]. Re-runs with the
  added prompts. The previous artifact stays referenced for undo.
- If nothing is behind the clip: an inline hint, "Nothing below this clip, so the removed area
  exports as black. Put a clip, image or colour on the track below."
- [ Remove background removal ] (ghost, destructive tone) → `remove_matte`, undoable.

**STALE** / **BROKEN**: see the state machine. Export validation surfaces the same issue with
the same remedy text, so the Inspector and the export dialog never disagree.

## Accessibility and responsiveness

- Every control is reachable by keyboard, including pick mode (arrow keys move a crosshair,
  Enter includes, Shift+Enter excludes).
- Progress uses `role="progressbar"` with `aria-valuenow`. Completion is announced politely once.
- Sliders show numeric values and accept typed input.
- The section works at the Inspector's minimum rail width. Buttons wrap and nothing clips.
- Playwright role-name matching is substring-based. New aria-labels such as "Remove background"
  and "Remove background removal" collide under `getByRole(name)`, so e2e uses `exact: true`
  (memory: `playwright-vs-rtl-role-name-matching`).

## Tests (BR6)

- `BackgroundRemovalSection.test.tsx`: every state above, rendered with a fake bridge; the
  disabled button plus warning in PACK_MISSING; the refresh on `onCapabilityPackInstalled`;
  install progress, failure and success transitions; undo returning to READY.
- `useBackgroundRemoval.test.ts`: the late-progress race (subscribe before run), cancel, a
  stale revision, and a selection change while running.
- `Inspector.tabs.test.tsx`: the section maps to the Mask tab and is hidden for audio and text clips.
