# Background removal

Cut a subject out of a shot so something else can sit behind it. This is what the editor sees,
what each state means, and which part of the system owns it.

> Related: [Masking](./masking.md) for the overview (limitations, keyboard, troubleshooting,
> hardware, privacy), [Mask tools](./mask-tools.md) for drawing a mask by hand,
> [Mask tracking](./mask-tracking.md) for the review list the two features share,
> [Preview masks](./preview-masks.md) for how a matte reaches the monitor,
> [Media intelligence](./media-intelligence.md) for Capability Packs in general.

## Where it is

Inspector → **Mask** → the first row, on any video or image clip. The row is also the front door
to every pack-backed tool's warnings: what it says about a missing pack is what AI Object, AI
Brush and Track mask say too.

## What it needs

The **Smart Mask** Capability Pack, which runs entirely on this computer. Nothing is uploaded, and
nothing downloads until you approve the exact signed offer the row shows you — its size, its
licences and what it does are all on screen first.

Without the pack, **the button stays visible and disabled**, with the reason attached to it. That
is deliberate: hiding a capability teaches you it does not exist.

## The states, and what each one means

| State                | What you see                                                            | What to do                                      |
| -------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| Checking             | "Checking what this computer can do…"                                   | Wait a moment.                                  |
| Pack missing         | The size, the licences, and **Install**                                 | Install, or carry on without it.                |
| Catalog unreachable  | "Can't reach the pack catalog…"                                         | Check the connection, or install from Settings. |
| Build has no catalog | "Smart Mask can't be installed from this build."                        | Nothing — a release build never shows this.     |
| Unhealthy            | Why the health check failed, and **Reinstall**                          | Reinstall.                                      |
| Unsupported computer | The hardware it would need                                              | Nothing on this machine.                        |
| Browser              | "Background removal needs the FramePilot desktop app."                  | Open the project on the desktop.                |
| Below minimum memory | "Needs 16 GB of memory; this computer has 8 GB, so it will run slower." | It still runs. Expect longer.                   |
| Ready                | Subject, Edges, the estimate, and **Remove background**                 | Run it.                                         |
| Running              | The phase, a progress bar, elapsed time, the ETA, and **Cancel**        | Keep editing; the job survives.                 |
| Needs review         | "_n_ moments need a look", with the list                                | Clear them (below).                             |
| Verified             | A **VERIFIED** badge                                                    | Nothing.                                        |
| Stale or broken      | The engine's own remedy sentence                                        | Run it again; it replaces the old one.          |

## Choosing the subject

- **Auto (main subject)** asks the pack to find it. If it cannot, it asks you to click instead
  rather than guessing.
- **Click to pick** uses the monitor's **AI Object** tool: click what to keep, Alt-click what to
  leave out. Clicking the same spot again takes the pick back; clicking it with the other meaning
  flips it. **AI Brush** is the same thing as a stroke, sampled into evenly spaced points.
- From the keyboard: `O` and `B` choose the tools, arrows move the crosshair, `Enter` keeps,
  `Shift+Enter` leaves out, `Esc` clears.

**Hover highlight (BR6.11).** With **AI Object** armed on desktop and the pack installed, the
object a click would select is tinted in the accent colour as the pointer moves over it — before
you click. Nothing is added to the project by hovering; the click is still what picks. The tint
comes from the pack's `subject.segment_frame`, answered by one warm worker process that keeps the
segmentation model and the frame's image embedding loaded, so moving over the same frame costs a
mask decoder call rather than a model load. The first hover on a new frame pays the image encode
(seconds on the CPU); after that the budget is 100 ms (06). While a background removal, a mask
track or an export is running, hover shows only the ring where the click lands: the warm model
never loads beside a job. The worker process ends after a minute without a hover.

What crosses the process boundary, and what the host checks: the renderer sends the asset id, the
source instant and the pointer as picture fractions — no path. Main resolves the asset from the
project on disk, the frame's pts from its decoded timing, and the pack as a job would. The
worker's mask must name that pts and the preview size main computed itself; it is decoded by the
same strict PNG reader as corrections (size at IHDR, every CRC, no ancillary chunks), and only the
decoded pixels go back to the renderer. Nothing is written to disk.

**Edges** is Sharp or Smooth. It is the edge treatment on the finished cut-out, not an instruction
to the pack — the delivered matte is the precise one either way.

Picking a subject changes nothing in the project. Only a finished run does, as one undoable edit.

## Speed: Fast or Best quality

On a Mac the row has a **Speed** choice (ADR 0182):

- **Fast (minutes)** — the default. Apple's Vision framework finds the subject in every frame;
  FramePilot then removes background objects Vision sometimes grabs with it (a lamp behind your
  hand), steadies still edges, checks every frame and cleans edge colour. Measured: a 50-second
  1080p clip in 7.5 minutes on an M1 Pro. It follows the main subject, or the one you clicked or
  boxed. It ignores exclude clicks.
- **Best quality (can take hours)** — the pack's models (SAM 2.1 + BiRefNet, cross-checked and
  self-corrected). The same clip takes 8–17 hours on the same Mac. Use it for a hero shot with
  hair against a busy background, not for every clip.

Both produce the same kind of matte: brush fixes, locked frames, review, text behind the subject
and export work identically. On Windows there is no Fast engine yet, so there is no choice and
every job is a Best job.

## The estimate

The estimate follows the Speed you chose. Fast uses 10 compute-seconds per second of 1080p30
footage (measured end to end, M1 Pro). For Best, "About 69 minutes on this computer · 100 MB on
disk" comes from the BR0 spike's **measured** CPU
throughput (520 compute-seconds per second of 1080p30 footage) and its storage table. Per-EP
throughput is still open, so a machine with a GPU execution provider may well beat it: an estimate
that finishes early is a kept promise, a hopeful one is not. A job over ten minutes asks you to
confirm first.

## While it runs

The phase is in plain words — reading the footage, finding the subject, refining the edges,
cross-checking the result, correcting itself (round _n_ of 3), building the cut-out, cleaning
colour from the edges, steadying the edges, checking every frame, saving the result. The first run
on a computer also prepares the models, which is why it takes longer than later ones.

**The bar is the whole clip.** With Smart Mask 1.1 the pack reports frames finished out of the
clip's total, so the bar, the percentage and "about N minutes left" describe the job, and the
phase is named beside them. An older pack reports only the step it is on; the row then says
"left in this step" and shows how long the job has run, rather than dressing a step's counter up
as the job's. A step that cannot be counted (loading a model) shows a moving bar, never 0% or 100%.

**The job is not tied to the panel.** Select another clip and it keeps running; come back and the
row reconnects to it. When it finishes it becomes an edit on the right clip whatever you are
looking at.

Finished windows show matted in the monitor while the rest runs, so the timeline draws a striped
band over the part not reached yet — otherwise a half-processed clip looks finished.

### The Jobs tab

On desktop the right rail has a **Jobs** tab beside AI and Inspector (BR6.12). It lists every pack
job in the project — background removals and mask tracks, running, waiting, paused, paused for an
export, or finished — with the clip's media file, the phase, progress and ETA, and **Pause**,
**Resume**, **Cancel** and **Show clip**. Show clip selects the clip, moves the playhead to it and
opens the Inspector, where the job's row is. A job resumed after a restart says so.

**Pause really pauses.** Pausing a running background removal (or starting an export) stops the
worker within seconds and keeps the parts of the clip it has finished; Resume, or the end of the
export, continues from there. The row says "Pausing after this step" for the moment in between.
At most one part of the clip (about a minute of Fast work) is redone.

**Quitting or crashing mid-job.** The job is journaled when it starts. Reopen the project and it
is queued again ("Resumed after restart"); the Smart Mask worker keeps each finished window's
checkpoint in the job's staging folder, and the host adopts that folder for the resumed run
(everything but `windows/` is cleared and the inputs rebuilt), so only the unfinished windows are
computed and the matte is byte-identical to an uninterrupted run (E2E.6). The finished job commits
its matte; **Remove background** then applies it at once as a cache hit. A staging folder left
more than a day is swept, and the job then starts over.

The list is a view over the desktop host's scheduler (`capabilityPackJobs`), so it can never
disagree with what is actually running. The browser build has no pack jobs, so it has no tab.

## Reviewing what it was unsure about

The pipeline checks every frame and flags the moments it could not verify. **VERIFIED** appears
only when nothing is flagged: every frame either passed those checks or was approved by you. It is
never shown because a job merely finished.

For each moment:

- **Looks right** approves it — one undoable edit.
- `J` and `K` step between moments; opening one seeks the playhead and switches the monitor to
  **Overlay**.
- **Keep** and **Remove** brushes paint a fix on the monitor. A stroke is a draft: **Apply fix**
  saves it and re-runs only the window around that moment.
- The **Edge brush** (BR6.10) is for hair, fur and motion blur: paint over an edge that came out
  hard or chewed and **Apply fix**. It does not say what the edge _is_ — it asks the pack to matte
  that band again. The pack adds the painted pixels to its unknown band on that frame and takes the
  matting model's alpha there, so an edge stroke never paints alpha itself, and a stroke across
  plain background leaves the background at 0.
- **Lock this frame** stores the current frame so no later run can change it.
- A second (or third) fix on the **same frame** is layered on the first, in the order applied: a
  later stroke wins where it marks keep, remove or edge, and untouched pixels keep the earlier
  fix. (Before, the second fix on a frame was refused.)

**The correction format.** A fix is an 8-bit grayscale PNG at the artifact's size with exactly four
values: keep = 255, remove = 0, edge = 64, untouched = 128. Keep and remove are hard constraints on
that frame; edge is not a constraint. The renderer rasterises strokes itself (a canvas would
antialias into values the host refuses), the host decodes it with the strict BR4.12 reader (size at
IHDR, every CRC, no ancillary chunks), refuses any other value as `invalid_brush`, and stores the
canonical re-encode by digest; the worker checks the same four values again.

## Putting text behind the subject

With a background removal applied, type the text and press **Put text behind subject**. It
duplicates the clip onto a track in front, moves the matte onto the copy, and puts a text clip
between the two — one operation, one undo. Doing it by hand gives the same result.

If there is nothing below the clip, the row says so: the removed area exports as black until you
put a clip, image or colour behind it.

## Relinked or replaced media

Relinking the clip's asset (Media bin → relink) makes main re-check the matte against the frames it
was made from. Different footage is **STALE**: the bin says the background removal needs
updating, the Inspector row shows the engine's sentence at once (before the relink reaches disk),
and the export refuses it. **Remove background** on a clip that already has one REPLACES it — the
same mask, a new artifact — so the stale one never lingers under the new one (E2E.6).

## Export

The export dialog counts the moments nobody has checked and says so. It never blocks: **Review**
takes you to the clip, and exporting anyway is always allowed. A stale or broken matte shows the
engine's own remedy sentence — the same words the render refusal uses, carried over the wire
rather than paraphrased.

## How precise it is (BR7)

The pack is not at gate. The eval (`workers/smart-mask/eval/run_eval.py`) runs the installed worker
and scores every plan-06 gate; its latest report is `reports/smart-mask/2026-09-18-darwin-arm64.json`
with a contact sheet, and the table with reasons is in `plan/background-removal-ai/BR0-FINDINGS.md`
("BR7.2 / BR7.3"). All of it is judged on construction-true clips until MO-8's human labels exist.
Hover highlight on real weights measured p95 431 ms on the M1 Pro, over the 100 ms budget.

## Where each piece lives

| Piece                                  | Where                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The row and its states                 | `apps/web-editor/src/components/inspector/masks/BackgroundRemovalRow.tsx`                             |
| "Can this computer do it?"             | `.../masks/usePackStatus.ts`                                                                          |
| The shared warning copy                | `.../masks/packToolCopy.ts`, `.../masks/PackToolWarning.tsx`                                          |
| Jobs, progress and outcomes            | `.../masks/matteJobStore.ts`, `.../masks/useMatteJob.tsx`                                             |
| The estimate                           | `.../masks/matteEstimate.ts`                                                                          |
| The review list (shared with tracking) | `.../masks/MaskReviewPanel.tsx`                                                                       |
| Brush fixes → the host's PNG           | `.../masks/matteCorrectionPng.ts`                                                                     |
| AI Object / AI Brush on the monitor    | `apps/web-editor/src/components/preview/MaskCanvasTools.tsx`                                          |
| Hover highlight                        | `.../preview/useSubjectHover.ts`; host `apps/desktop/electron/capability-packs/segment-frame.ts`      |
| The warm worker session                | `packages/capability-packs/src/node/warm-worker.ts`                                                   |
| Export's notice                        | `apps/web-editor/src/editor/matteReview.ts`, `.../ExportDialog.tsx`                                   |
| The Jobs tab                           | `apps/web-editor/src/components/JobsPanel.tsx` (`JobsRail`), mounted in `.../Editor.tsx`              |
| Typed operations                       | `packages/editor-core/src/mask-commands.ts` (`add_matte_mask`, `review_matte`, `text_behind_subject`) |
| The host                               | `apps/desktop/electron/capability-packs/matte*.ts`                                                    |

## Known gaps

- **The Smart Mask pack is not installable yet.** There is no catalog entry, and its accuracy is
  not at gate (BR3.15). Everything above is built against the host contract and tested with a fake
  pack, exactly as BR4 was.
- **Hover highlight** tints only on desktop with the pack installed, and not while a job or export
  runs; AI Brush still shows its ring only.
- **No HDR notice.** Nothing in the schema records a clip's transfer function, so there is no
  honest way to know a clip is HDR without a probe field and a migration.
- **Flag reasons do not survive a reopen.** A flagged range is stored as a time range and nothing
  else, so a reopened project shows "Needs a look" rather than a reason invented to fill the space.
