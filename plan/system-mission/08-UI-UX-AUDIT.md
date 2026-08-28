# Phase 8 — UI/UX audit and interaction fixes — `[ ]`

> **Ships:** the P0.6 findings fixed at the interaction level; an AI sidebar that shows
> what the AI knows, is doing, changed, needs, and what failed; attachment UX from
> Phase 3 and export UX from Phase 7 integrated.
> **Does not ship:** a re-theme (the token system and `DESIGN_SYSTEM.md` stand; the
> accent-colour question from the July UI clone is a maintainer decision, not this phase).
> **Depends on:** Phase 3, Phase 7. **Schema/deps:** none.
> **Owner agents:** `ui-ux-critic` (review), `frontend-product-architect`,
> `accessibility-responsive-auditor`.

## P8.1 — Triage the findings — `[ ]`

Take `00-ux-findings.md`; keep only *blocks work* and *slows work*; group by root
interaction (e.g. "selection model is inconsistent between bin and timeline" rather than
five symptoms). Each group becomes a task below, added under §"Discovered" with its
UX-nn ids.
**Done when:** every finding is either in a task or explicitly deferred with a reason.

## P8.2 — AI sidebar: knows / doing / changed / needs / failed — `[ ]`

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

