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

Take `00-ux-findings.md`; keep only *blocks work* and *slows work*; group by root
interaction (e.g. "selection model is inconsistent between bin and timeline" rather than
five symptoms). Each group becomes a task below, added under §"Discovered" with its
UX-nn ids.
**Done when:** every finding is either in a task or explicitly deferred with a reason.

Triage 2026-08-29 (from `00-ux-findings.md`, B/S only; C = cosmetic, deferred below):

| Root interaction | Findings | Lands in |
| --- | --- | --- |
| Export is platform-driven | UX-01 | **closed** by Phase 7 (P7.3 dialog: resolution / fps / quality / codec / format, size estimate) |
| References never reach the model | UX-04 | **closed** by Phase 3 (composer attach → analyzed profile → context block) |
| Sidebar does not reflect project state | UX-02 (static chips), UX-16 (no "knows" strip, no memory view) | P8.2 **Knows** |
| Timeline navigation is inconsistent | UX-05 (empty tracks hidden), UX-06 (wheel does nothing), UX-07 (selection scrolls, playhead does not) | P8.3 "timeline navigation" |
| Clip actions are thin | UX-08 (context menu lacks trim-to-playhead, speed, transition, reveal, disable) | P8.3 "clip context menu" |
| Modal / status surfaces mislead | UX-10 (translucent settings), UX-11 (readiness shows a stored choice, not a working provider) | P8.4 |
| Preview hides the fit | UX-14 (4K landscape in 9:16 cropped silently) | P8.3 "preview fit" |

Deferred as cosmetic (C), with the reason "does not block or slow the raw-footage-to-edit
loop": UX-03 (clipped placeholder), UX-09 (icon-only top bar), UX-12 (1024-wide overflow),
UX-13 (agent header over Inspector — fixed opportunistically if P8.2 touches that header),
UX-15 (truncated filter tabs).

## P8.2 — AI sidebar: knows / doing / changed / needs / failed — `[~]`

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
notice with inline Retry). Remaining: selection/playhead facts in the strip, Doing
(queue/progress from P5.4), grouping the result card by semantic op, the Failed "details"
disclosure for provider/FFmpeg text, and the screenshots for the report.

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
  dialog's text, chrome AND scrim all uniformly faded with the app behind *undimmed* —
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

## P8.5 — Focus, keyboard, accessibility, resizing — `[ ]`

Focus management for dialogs/menus, roving tabindex in lists, ARIA on custom controls,
reduced-motion respected, panels resizable with persisted sizes (view-prefs hook),
no horizontal page scroll at 1280 px.
**Done when:** axe passes on the main screens in e2e; keyboard-only montage journey works.

## P8.6 — Close — `[ ]`

`08-after.md` with before/after screenshots per fixed finding; CHANGELOG; guide updates.

## Discovered

