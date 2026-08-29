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

## P8.3 — Selection, drag/drop, context menus, shortcuts — `[ ]`

Standardize on the model professional NLEs use: click selects, shift-click extends,
cmd-click toggles, marquee in timeline and bin, drag from bin to timeline with insert/
overwrite modifier, right-click menus mirror the shortcut list, Esc clears, Delete vs
ripple-delete distinct, undo/redo everywhere including the AI run. Fix the root model in
the store, not per component.
**Done when:** `timeline-interaction`, `timeline-marquee` e2e extended and green; a
shortcut list test asserts every menu item's shortcut works.

## P8.4 — States: loading, empty, error, progress, destructive confirms — `[ ]`

Every long operation has a skeleton or progress with cancel; every empty panel says what
to do next; every destructive action (delete track, clear timeline, overwrite export)
confirms or is undoable; errors never only toast.
**Done when:** a state matrix per panel is in the report and each cell is implemented.

## P8.5 — Focus, keyboard, accessibility, resizing — `[ ]`

Focus management for dialogs/menus, roving tabindex in lists, ARIA on custom controls,
reduced-motion respected, panels resizable with persisted sizes (view-prefs hook),
no horizontal page scroll at 1280 px.
**Done when:** axe passes on the main screens in e2e; keyboard-only montage journey works.

## P8.6 — Close — `[ ]`

`08-after.md` with before/after screenshots per fixed finding; CHANGELOG; guide updates.

## Discovered

