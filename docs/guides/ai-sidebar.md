# The AI sidebar

The AI sidebar is FramePilot's Cursor-class, streaming assistant. It lives in the
right rail of the editor (the **AI** tab) and turns natural-language requests into
**reviewable, reversible** timeline edits. Everything it does streams live as an
append-only event log, persists across restarts, and can be interrupted — and no
edit ever touches your timeline until you accept it.

> Architecture and rationale live in
> [ADR 0033](../adr/0033-streaming-ai-sidebar-architecture.md) and the execution
> plan in [`plan/AI-SIDEBAR.md`](../../plan/AI-SIDEBAR.md). The plan-approval
> gate and mid-run steering below are covered by
> [ADR 0051](../adr/0051-plan-approval-gate-and-mid-run-steering.md), and the
> step-local activity treatment is recorded in
> [ADR 0072](../adr/0072-step-local-agent-activity-events.md), and objective/context
> continuity in [ADR 0087](../adr/0087-objective-complete-agent-runs-and-stable-chat-surface.md). This guide
> is the user-facing how-to.

## Modes

A segmented control at the top switches how the assistant behaves:

| Mode      | What it does                                                                |
| --------- | --------------------------------------------------------------------------- |
| **Agent** | Runs a multi-step plan: reasons, calls tools, and proposes a combined edit. |
| **Chat**  | Answers questions about the project as text — never proposes an edit.       |
| **Edit**  | One focused edit for one request — streams a single reviewable diff.        |

## What you see while it works

Each turn streams in place — nothing freezes, nothing duplicates:

- **Your message** — a quiet card at the top of the turn.
- **The agent's narration** — mid-run text streams as chat messages _interleaved with
  the tool cards_, in the order it happened (Cursor-style), so you read the run as a
  conversation: "Cutting the silent gaps now…" → the trim cards → "Adding captions…".
- **Thinking** — each agent step gets its own shimmer before that step's narration
  and tool cards, then settles into a real **"Thought for Ns"** measured from the
  event log (never a fake spinner). A subtle activity rail keeps the sequence easy to
  scan without making every step a card.
- **Plan checklist / to-dos** — the actual scheduler task list stays docked directly below
  the AI header instead of scrolling away with tool activity. Every new run starts with
  this accordion collapsed. Its compact view shows the most recently active task and the
  settled-task count; open it to see all concurrent and completed tasks. Agent-mode plan
  ledgers use the same recent-first disclosure when no scheduler task list is present, so
  the header never shows two competing checklists. Both controls are keyboard-operable and
  announce their expanded state to assistive technology.
- **Tool cards** — one per tool call (Read Timeline, Find Silence, Detect Beats, Trim
  Clip, …), titled by what they do, with a compact arguments line, live elapsed time
  while running, and an expandable detail (input · summary · result · affected
  clips/tracks/files · logs · warnings). **Analysis tools run for real** against the
  local engine and their results feed the model's next step; with no engine connected
  they fail honestly. Stopping mid-analysis marks the card **Stopped** — never a
  checkmark. Tools that aren't available yet render as **gated**, not faked.
- **A completion report** — a run that applied edits closes with a markdown summary of
  what changed, what was skipped, and why.
- **Reference chips** — clickable `clip`, `track`, and file references (shown by name)
  that reveal the item in the editor.
- **A single progress bar** that names the current phase ("Trimming Intro.mp4",
  "Rendering preview") and advances in place — not a stack of stale bars.
- **A diff card** — the proposed edit (see below).

An animated activity line above the composer tracks the live phase (thinking, running a
tool, editing, or verifying) beside the controls used to stop or steer it. The header stays
quiet. The stream auto-scrolls while streaming; scroll up and a **Jump to latest** button
appears.

### Approving a large plan before it runs

With **Plan first** on, most drafted plans just start running step by step, as
described above. But if the drafted plan has **more than 3 steps**, the run
pauses before any step executes and shows a plan-approval card with the full
numbered plan and three choices:

- **Approve** — runs the plan exactly as drafted.
- **Edit request** — cancels the run (nothing was touched) and puts your
  original prompt back in the composer so you can refine it before trying
  again. This is not a full plan editor — it deliberately hands you back the
  request, not a per-step editing UI.
- **Cancel** — stops outright; nothing was touched, and nothing is
  repopulated.

Everyday, small requests never see this — the threshold exists to put a
second look in front of unusually large, multi-step runs before they touch
your timeline. **Browser only for now**: the desktop app's AI runs travel over
IPC, which can't yet carry a live approve/cancel decision back to a paused
run, so desktop runs plans of any size un-gated until that parity lands.

### Steering a run while it's in progress

While an Agent-mode run is streaming, a small input appears next to the
running task view where you can type extra guidance and send it — separate
from **Stop** (which ends the run) and from waiting for it to finish and
starting a new turn. Your message shows as **queued** until the agent reaches
its next per-turn checkpoint (the same point where it already checks for a
Stop request), at which point it folds your note into that step as an
explicit instruction and confirms it in the conversation ("Steering applied:
..."), clearing the queued note. If you send a message mid-tool-call, it
waits for that call and its turn to finish first — this is a next-checkpoint
nudge, not an instant mid-step redirect. **Browser only for now**, same IPC
limitation as plan approval above.

## Reviewing and applying edits

Every generated edit arrives as a **diff card** — "Proposed edit", the reason, the
affected operations, and a before → after change list. You are always in control:

- **Accept** — commits the patch through the same validated `apply → record` path as
  manual edits, so the global **Undo** reverts it.
- **Reject** — discards it and records the rejection as a learning signal.
- **Jump to timeline** — selects the affected clip.
- **Apply all** — when several diffs are pending, applies them in order (it stops and
  surfaces the first one that fails to validate; it never half-applies a patch).

### Previewing a proposed edit before you accept it

When a diff card has a computed before/after timeline (most edits do — a few
degenerate patches don't), a **Show preview** toggle expands an **AI review player**
so you can watch the change instead of just reading the op summary. It plays the
real `PreviewPlayer` (the same HTML-video preview the live editor uses, never a
separate render) against a read-only snapshot of either the _before_ or _after_
timeline, so Accept/Reject remain the only things that can touch your actual project.

A layout switch in the toolbar picks how you compare:

- **Hold to compare** (default) — press and hold the **Hold for before** button
  (or the `b` key) to see the original at the same playhead position; release
  to spring back to _after_. A persistent **Before/After** pill always shows
  which one you're looking at.
- **Side by side** — mounts both the _before_ and _after_ previews at once, each
  labeled directly, so you can play or scrub them together instead of toggling.
  They always show the same instant; only the _after_ panel plays audio, so the
  two don't talk over each other. (A wipe/split-line compare — one frame, a
  draggable divider — is a planned follow-up, not built yet.)
- **Scrubber ticks** mark exactly where the edit touched the timeline, and the
  player auto-seeks to the first changed region on mount so you don't have to hunt
  for what changed.
- An **"Approximate"** badge appears when the clip at your current playhead has a
  different before/after duration, and a warning badge would flag any changed
  region this player can't show 1:1 — so the preview never implies more precision
  than it has. Diffs without a computed before/after keep the disabled "Preview"
  stub instead of a misleading toggle.

## Interrupting a run

While a run is streaming, the send button becomes **Stop** — it aborts the run
(cancelling the upstream request) and marks the turn _cancelled_. Once stopped or
failed, **Retry** re-runs the last turn. The composer never locks, so you can keep
typing.

A failed run always says what happened, in the thread: either the specific error (a provider
that dropped the request is retried automatically first, and only reported once retries are
exhausted) or, when the run finished but could not verify its own work, a notice that nothing
was applied and the timeline is unchanged. A failed run carries no usage chip — a dropped
request reports no cost, and a zero there would read as the deterministic "Instant · no AI
needed" path.

## The composer

The docked composer is a single input well:

- **Slash commands** — type `/` for the FramePilot command palette (`/create-short`,
  `/remove-silence`, `/add-captions`, …), filtered as you type.
- **Quick actions** (the **+** menu) — one tap pre-fills a prompt (Improve Edit,
  Create B-roll, Fix Audio, Generate Titles, Make Viral, Trim Silence, Animate
  Captions).
- **Attachments** — paste or drop an image/file; it becomes a chip threaded into the
  request.
- **Pin context with `@`** — type `@` followed by a few letters to search your
  timeline clips and media-bin assets; picking one pins it as its own removable
  chip, in addition to (not instead of) the "Selected" chip from a live timeline
  selection. Pin as many as you like. (Pinning a raw time range, a marker, or a
  whole track by name isn't supported yet — only individual clips and assets.)
- **Context panel** — the chips above the input (Current Timeline, Selected Clips,
  Current Project, Open Assets, Referenced Files, plus any clips/assets you've
  pinned with `@`) are the context the assistant sees. Remove any chip to
  exclude it — a removed chip stays out of context for that turn even if the
  underlying selection or pin is still "live" in the editor.
- **Context ring** — the small circle immediately left of Send/Stop shows how much of
  the primary request for your latest message occupies in the model's configured context
  window. Hover it
  (or focus it with the keyboard) for exact `used / total` and remaining tokens. It
  appears as an estimate as soon as a call starts, then updates to the
  provider-reported input count for that same request. Internal classification, planning,
  tool, and repair calls do not replace the displayed request, so the figure remains stable
  throughout the turn. This is request context, not cumulative billing; the separate usage
  chip remains the run-cost view.

Press **Enter** to send, **Shift+Enter** for a newline.

## Conversations, history & search

Opening **Inspector** or **Transcript** does not stop or detach an AI run. Return to the AI
tab and the same active conversation, draft, scroll position, and live activity are still
there.

- **New chat** (**+**) starts a fresh conversation; **History** (the clock icon)
  opens the list, grouped Today / Yesterday / Previous 7 / 30 / Older.
- Each row supports **Rename · Duplicate · Delete · Pin · Favorite · Export**
  (markdown/JSON).
- The search box does an **instant global search** across titles, message text, tool
  output, edit summaries, and asset names, with match highlighting.

Conversations are stored **outside** `project.fp.json` — as JSON files on desktop and
in IndexedDB in the browser — so they restore instantly on reload (events, scroll
position, and your draft) and never bloat the project file. Every conversation carries
the ID of the project that owns it; History lists and loads only that project's records.
Older records that predate project ownership stay hidden rather than being guessed into
the wrong project.

## Choosing a model and setting API keys

Open **Settings → AI** (⌘, then the **AI** tab) to choose the active provider —
Claude (Anthropic), NVIDIA NIM, or the offline mock — and to enter each provider's
**API key** and **model**. The sidebar header shows a compact **active-model badge**;
click it to jump straight to Settings → AI.

Keys are stored locally on your machine — a plaintext `ai-config.json` in the app data
folder on desktop, or `localStorage` in the browser build — and are sent only to the
provider you pick, never to FramePilot. On desktop the key is **write-only across the
bridge**: the Settings panel saves it into the main process, which never returns it to
the UI (only the provider name/model and a "key saved" flag come back). A provider with
no key shows **"No key"** until you add one. Environment variables
(`ANTHROPIC_API_KEY`, etc. — see [`ai-providers.md`](./ai-providers.md)) still work as a
fallback when no key has been entered in Settings.

## Memory: cross-project defaults & saved workflows

Open **Settings → Memory** to teach the AI things that follow _you_ across every project,
not just the current file:

- **Editorial defaults** — target audience, brand style, caption style, preferred pacing,
  and favourite export platforms. A new project inherits these; the project's own
  remembered preferences override them field by field, so a per-project choice always wins.
- **Saved workflows** — runs you have saved as reusable recipes. Typing a saved workflow's
  name in the composer replays it instantly, with **no model call** — the system gets
  cheaper and more predictable the more you teach it. The Memory panel lists your saved
  workflows and lets you delete any of them.

To **save** one, run a command and pick **Save as recipe** from the sidebar's overflow
(⋯) menu, then give it a name. Only commands that map to a built-in recipe (e.g. "remove
the silences", "add captions", "export for Reels") can be saved this way — a request that
needed the full planner has no fixed replay yet, and the sidebar tells you so rather than
saving something that wouldn't reproduce.

Memory holds no secrets, so it is stored in `localStorage` (which the desktop app keeps
per-machine) — there is no separate config file and nothing crosses a network. On desktop
these defaults are threaded into the model context in the main process, exactly like the
browser build.

## Offline / mock provider

With no API key configured, the sidebar runs on a **deterministic mock provider**:
the whole experience — streaming, tools, diffs, accept/undo — works fully offline.
This is also what the E2E suite exercises. Configure a real provider per
[`ai-providers.md`](./ai-providers.md).

## Accessibility

The sidebar is fully keyboard-navigable: a labelled landmark region, a mode
`tablist`, an `aria-live` conversation stream, `progressbar` roles on progress,
accessible names on every icon control, visible focus rings, and full
`prefers-reduced-motion` support (all motion is opacity/transform only).
