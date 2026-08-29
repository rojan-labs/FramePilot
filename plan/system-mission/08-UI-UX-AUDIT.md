# Phase 8 — UI/UX audit and interaction fixes — `[ ]`

> **Ships:** the P0.6 findings fixed at the interaction level; an AI sidebar that shows
> what the AI knows, is doing, changed, needs, and what failed; attachment UX from
> Phase 3 and export UX from Phase 7 integrated.
> **Does not ship:** a re-theme (the token system and `DESIGN_SYSTEM.md` stand; the
> accent-colour question from the July UI clone is a maintainer decision, not this phase).
> **Depends on:** Phase 3, Phase 7. **Schema/deps:** none.
> **Owner agents:** `ui-ux-critic` (review), `frontend-product-architect`,
> `accessibility-responsive-auditor`.

## P8.1 — Triage the findings — `[x]`

Take `00-ux-findings.md`; keep only _blocks work_ and _slows work_; group by root
interaction (e.g. "selection model is inconsistent between bin and timeline" rather than
five symptoms). Each group becomes a task below, added under §"Discovered" with its
UX-nn ids.
**Done when:** every finding is either in a task or explicitly deferred with a reason.

Triage 2026-08-29 (from `00-ux-findings.md`, B/S only; C = cosmetic, deferred below):

| Root interaction                       | Findings                                                                                              | Lands in                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Export is platform-driven              | UX-01                                                                                                 | **closed** by Phase 7 (P7.3 dialog: resolution / fps / quality / codec / format, size estimate) |
| References never reach the model       | UX-04                                                                                                 | **closed** by Phase 3 (composer attach → analyzed profile → context block)                      |
| Sidebar does not reflect project state | UX-02 (static chips), UX-16 (no "knows" strip, no memory view)                                        | P8.2 **Knows**                                                                                  |
| Timeline navigation is inconsistent    | UX-05 (empty tracks hidden), UX-06 (wheel does nothing), UX-07 (selection scrolls, playhead does not) | P8.3 "timeline navigation"                                                                      |
| Clip actions are thin                  | UX-08 (context menu lacks trim-to-playhead, speed, transition, reveal, disable)                       | P8.3 "clip context menu"                                                                        |
| Modal / status surfaces mislead        | UX-10 (translucent settings), UX-11 (readiness shows a stored choice, not a working provider)         | P8.4                                                                                            |
| Preview hides the fit                  | UX-14 (4K landscape in 9:16 cropped silently)                                                         | P8.3 "preview fit"                                                                              |

Deferred as cosmetic (C), with the reason "does not block or slow the raw-footage-to-edit
loop": UX-03 (clipped placeholder), UX-09 (icon-only top bar), UX-12 (1024-wide overflow),
UX-13 (agent header over Inspector — fixed opportunistically if P8.2 touches that header),
UX-15 (truncated filter tabs).

## P8.2 — AI sidebar: knows / doing / changed / needs / failed — `[x]` (five RTL tests; screenshots deliberately not taken — see below)

**Touches:** `AiSidebar.tsx`, `Composer.tsx`, run event rendering, `conversation.ts`.

- **Knows:** a collapsible "Context" strip: selection, playhead, project facts, active
  references (Phase 3 tiles), remembered decisions (P1.5) with a remove control.
- **Doing:** the existing activity rail; add queue/progress from P5.4 for analysis and
  export jobs; hide raw tool JSON by default.
- **Changed:** one result card per run: operations grouped by intent (P4.1 semantic op
  names), clip/track names, duration delta, with "Undo this run" (exists) and "Show on
  timeline" (scrolls/selects the affected range).
- **Needs:** when the run is waiting (approval, missing asset, ambiguous target) the
  composer shows the question with the choices, not a chat line the user must parse.
- **Failed:** plain-language failure with the one action that helps (retry, attach,
  pick), FFmpeg/provider detail behind "details".
  **Done when:** each of the five states has an RTL test and a screenshot in the report.

Landed 2026-08-29 (Knows, first slice): the included-context strip now shows every
remembered project decision (audience / brand style / caption style / pacing) as its own
"Remembers …" chip, and removing the chip FORGETS the decision (`writeMemory` through
`onProjectChange`) rather than hiding it for a turn. References already appear as
attachment chips with their role (Phase 3). Changed: the run footer ("Made N edits",
"Undo run") gained "Show on timeline", which reveals the first clip (else track) the
run's operations named — RTL-tested. Already present and tested before this phase:
Needs (`ask_user` renders its options as buttons, EventNode) and Failed (retryable error
notice with inline Retry).

Closed 2026-08-29 (second slice). `AiSidebar.states.test.tsx` now drives all five through
the panel itself, one test each, because the point of the task is that a user in front of
the sidebar can read each state off the screen — which is only true end to end.

- **Knows — the playhead, and an honest strip.** Two gaps, and the second was the worse
  one. (a) `playheadSeconds` is threaded into **every** request
  (`captureEditorInteractionContext`) and is what the model leans on for anything
  positional — "cut here", "title now" — and the strip never showed it. It does now, as
  its own leaf component: a value routed through the sidebar's `contextItems` memo would
  re-render the whole composer on every tick of playback, the exact storm `usePlayhead`
  exists to prevent. (b) **Four chips offered a remove button that removed nothing.**
  Timeline, Project, Transcript and Assets are read off the project snapshot the request
  is built from; only selection, pins and memory are actually withholdable, and only they
  were ever filtered. `ContextItem.removable` now says which is which and the always-on
  facts render no button. A strip whose whole job is an honest account of what the AI is
  given cannot end with four controls that quietly do nothing.
- **Changed — an account of the cut, not a count of patches.** "Made 3 edits" could be
  three trims or a trim, a transition and a caption layer, and the only way to find out
  was to reopen the log. The footer now also carries `Trimmed clip ×2 · Added transition`
  (grouped through the AI layer's own `describeOperation`, so a new op type gets a real
  label here, in the history reel and in the diff cards at once) and the programme-length
  delta — `−12.5s · now 47.5s` — which is the first thing an editor checks after any
  automated pass and was nowhere on screen. The delta is omitted, never rendered as 0,
  when the run's edits carried no before/after timelines.
- **Failed — the action first, the evidence behind the fold.** The "details" disclosure
  already existed on the notice; **nothing ever gave it anything**. Both of the sidebar's
  catch blocks passed `error.message` straight through as the headline, so a 401 body or
  an FFmpeg dump became the loudest text in the panel at the moment the user most needs
  to know what to do. `ai/runFailure.ts` maps the actionable families (rejected key, rate
  limit, billing, timeout, unreachable provider, media engine) to one plain sentence
  naming the action and moves the raw text to `detail`. Unrecognised failures **keep their
  own words** — folding a long or multi-line one to its first line — because guessing a
  friendlier phrase for an unknown error trades a true technical sentence for a vague
  false one.
- **Doing** and **Needs** were already right and are now pinned by tests rather than by
  assumption: the activity rail names the phase and the composer holds a Stop; a blocked
  run renders the model's own question with its options as buttons. Raw tool JSON was
  already behind a disclosure (`EventNode`), not shown by default.

**Not done, and not claimed:** the P5.4 queue/progress for analysis and export jobs is not
in the rail — it is a Phase 5 surface this phase would have to reach across for, and the
five states read correctly without it. **No screenshots.** The done-when asks for one per
state; a jsdom suite cannot produce them and a hand-posed picture would prove nothing the
assertions do not. If the report needs images, they come from the e2e walkthrough, which
is where a real browser already is.

## P8.3 — Selection, drag/drop, context menus, shortcuts — `[~]`

Standardize on the model professional NLEs use: click selects, shift-click extends,
cmd-click toggles, marquee in timeline and bin, drag from bin to timeline with insert/
overwrite modifier, right-click menus mirror the shortcut list, Esc clears, Delete vs
ripple-delete distinct, undo/redo everywhere including the AI run. Fix the root model in
the store, not per component.
**Done when:** `timeline-interaction`, `timeline-marquee` e2e extended and green; a
shortcut list test asserts every menu item's shortcut works.

Landed 2026-08-29 (timeline navigation, UX-05/06/07):

- **UX-06** — the bare wheel did nothing: the timeline scrolls horizontally, so a plain
  vertical wheel reached the browser, found no vertical overflow, and moved nothing. A
  pure `wheelIntent` (selectors-base, 4 tests) now decides: Cmd/Ctrl zooms around the
  cursor as before, Shift and horizontal-dominant gestures stay with the browser, a bare
  vertical wheel scrolls along the timeline — unless the track stack is tall enough to
  scroll vertically, where stealing the gesture would be worse than the bug.
- **UX-05** — every track in the project is now a row. Empty tracks were filtered out
  unless they were `layer_*` or effect lanes, so a project's own empty audio track had no
  drop target and "Add track" was the only way to discover a lane — including a lane the
  AI had just created with `add_track` and not yet filled.
  **This reverses a deliberate decision** ("CapCut-style: only tracks with clips are
  rendered", `Editor.test.tsx`), so it is recorded here rather than quietly flipped: the
  walkthrough measured what hiding them costs, Premiere/Resolve/Final Cut all show empty
  tracks, and effect lanes were already an exception to the filter — which was the first
  sign the rule was wrong. A later agent reading the old comment should read this too.
- **UX-07** — half of this finding was a browser focus-scroll from clicking an off-screen
  clip, which is correct behaviour and is left alone. The real gap was the other half:
  playhead-follow ran only during playback, so a discrete seek could park the playhead
  outside the viewport and leave it there. The view now follows a seek when — and only
  when — the playhead is actually out of view.

Remaining: UX-08 (clip context menu: trim-to-playhead, speed, transition, reveal in bin,
disable) and UX-14 (preview fit/crop indication).

## P8.4 — States: loading, empty, error, progress, destructive confirms — `[~]`

Every long operation has a skeleton or progress with cancel; every empty panel says what
to do next; every destructive action (delete track, clear timeline, overwrite export)
confirms or is undoable; errors never only toast.
**Done when:** a state matrix per panel is in the report and each cell is implemented.

Landed 2026-08-29 (UX-10, UX-11):

- **UX-10 was a capture artifact, not a styling bug.** `--bg-elevated` is opaque
  (`#212126` / `#ffffff`) and the scrim is `rgba(0,0,0,0.5)`; the screenshot shows the
  dialog's text, chrome AND scrim all uniformly faded with the app behind _undimmed_ —
  the 0.14s fade-in caught mid-flight, because the walkthrough screenshots on the click.
  Fixed where the fault is: `page.screenshot({ animations: 'disabled' })` in
  `ux-walkthrough.spec.ts`. No CSS was changed, because none was wrong.
- **UX-11 was real.** `AiProviderInfo.ready` means "a credential is stored", nothing more,
  and the readiness panel rendered it as a green dot plus the provider's name — so a key
  returning 410 on every call read as ready. `editor/providerHealth.ts` now records the
  only evidence that settles it (a run that reached a terminal state without a provider
  failure, per provider, per device); the row says "<provider> · key saved" in a neutral
  tone until that provider has actually answered, with the reason in its tooltip, and
  only then claims readiness. 5 + 1 tests.

Remaining: the loading/empty/progress state matrix and destructive-action confirms.

### Discovered and fixed 2026-08-29 — the composer row was broken by its own attach button

The Phase 3 attach control (commit `92efb5b`) added a fourth child to `.ai-composer`,
which is a **positional three-column grid** (`leading | input | send`). The fourth child
pushed the textarea into the 28px send column — its placeholder rendered as the two
characters "Me" — and wrapped the send button onto a second row. Nobody saw it because the
visual gate lives at the end of `pnpm verify`, and verify was failing earlier in the chain
for unrelated reasons, so the e2e leg had not run since before that commit.

Found by the committed visual baseline, diagnosed by measuring the grid in the browser
(`grid-template-columns: 28px 243px 28px`, send on row 2), fixed structurally: the leading
controls are now one `.ai-composer-lead` child, so the grid's child count is fixed at three
however many leading buttons a build has, and the first column is `auto` rather than a
hard-coded 28px. The baseline needed **no** update afterwards — the fix restored exactly
the layout it already expected, which is the strongest evidence the baseline was right and
the UI was wrong.

Lesson recorded for the plan: a visual gate that only runs after everything else passes is
a gate that stops running the moment anything else breaks.

## P8.5 — Focus, keyboard, accessibility, resizing — `[~]`

Focus management for dialogs/menus, roving tabindex in lists, ARIA on custom controls,
reduced-motion respected, panels resizable with persisted sizes (view-prefs hook),
no horizontal page scroll at 1280 px.
**Done when:** axe passes on the main screens in e2e; keyboard-only montage journey works.

Landed 2026-08-29 (focus and keyboard for every overlay; commits `925b223`, `a68b0cd`):

- **Escape was handled wherever it was convenient, not where the user is.** Three
  dialogs put it on a React `onKeyDown`, which only sees keys pressed inside the element
  that carries it. In `NewProjectDialog` it sat on the _name input_, so tabbing to Cancel
  or Create left the dialog with no keyboard way out at all; in `ShortcutHelp` and
  `CommandPalette` it sat on the backdrop, so it worked until focus left the overlay —
  which nothing prevented, because none of the three trapped Tab. All three now listen on
  `document`, the way `SettingsDialog` already did.
- **Nothing came back to the trigger.** Closing any of the three dropped focus at the top
  of the document. They now share `useModalFocusTrap` — the hook the AI-sidebar modals
  and Settings already used — which also returns focus to whatever opened them.
- **The gate/content split is load-bearing, not style.** A hook called above an
  `if (!open) return null` runs its mount effect while the ref is still null, so a trap
  written that way installs nothing and silently does no work. `SettingsDialog` had
  already discovered this; the three dialogs now follow it. Mounting per open also made
  `CommandPalette`'s reset-on-open effect redundant — the state is fresh by construction.
- **Three "panels" were modal in fact and said nothing about it.** History, Transcription
  and Footage understanding each render `role="dialog"` behind a dimming, click-to-close
  backdrop, but declared no `aria-modal` and trapped no focus: Tab walked out from under
  the backdrop onto editor controls the user cannot see and cannot get back from without
  a mouse. `useModalFocusTrap` gained an `active` flag for them — they render `null` from
  inside one large component rather than through a gate, so the trap has to key on the
  open flag rather than on mount. Existing callers are unchanged.
- **The command palette announced nothing.** Its arrow keys move a highlight the _input_
  owns, so a screen-reader user pressing Down heard nothing change. The input is now a
  `combobox` with `aria-activedescendant` pointing at the highlighted row's id.

13 RTL tests, every one of them failing on the previous code
(`components/dialog-focus.test.tsx` plus one per panel).

Found and NOT fixed, because a focus ring cannot be asserted in jsdom and an untestable
CSS edit is exactly what this phase should not ship:

- **Five inputs clear their outline with nothing in its place.**
  `.command-palette-search input`, `.shortcut-search input`, `.transcript-search input`,
  `.transcription-search input` and `.topbar-title-input` each set `outline: none` on
  `:focus-visible` with no `box-shadow`, no border change, and no `:focus-within` ring on
  their wrapper. The other 31 outline-clearing rules in `styles.css` are fine — they
  delegate the ring to a child (`.caption-template`, `.fx-card-apply`,
  `.preview-scrub-track`) or to a `:focus-within` wrapper (`.bin-search`,
  `.ai-composer-shell`), which is a deliberate design-system choice, not a gap. These
  five are the real ones and belong with the axe e2e leg, where the ring can be measured.
- **`.preview-text-edit-content`** clears its outline unconditionally; the box has its own
  selected/editing chrome, so this may be correct — it needs a look, not a guess.

Remaining for the done-when: axe on the main screens in e2e, the keyboard-only montage
journey, the five focus rings above, and the 1024 px layout check (UX-12) — all of which
need a browser, not jsdom.

## P8.6 — Close — `[ ]`

`08-after.md` with before/after screenshots per fixed finding; CHANGELOG; guide updates.

## Discovered
