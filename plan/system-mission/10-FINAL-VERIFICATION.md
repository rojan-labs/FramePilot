# Phase 10 — Final verification and report — `[~]`

> **Ships:** the Definition of Done in `PROMPT.md` §17 walked line by line with evidence;
> the engineering report in §18 shape; plan and docs reconciled.
> **Depends on:** Phases 0–9.

## P10.1 — Walk the Definition of Done — `[x]`

For each §17 line: the evidence file/commit that proves it, or "not met" with the reason
and the task that remains. No line is ticked from memory.

Landed 2026-08-29: `docs/reports/system-mission/10-definition-of-done.md`. Four of twelve
lines fully met, eight partly met; every remainder is a blocked measurement, an unstarted
task, or a recorded scope decision.

## P10.2 — Try to break it — `[!]` (needs a human at the desktop app for a day)

One day of adversarial use on the desktop app with the Phase 0 fixtures and one fresh
real project: contradictory instructions, attach-then-remove references mid-run, cancel
everything at once, export while an AI run is placing clips, reopen a project from an
older schema version, fill the disk during export. Every defect found → fix or a
`[ ]` task in the relevant phase's §"Discovered".

`[!]` 2026-08-29: this is a day of hands-on adversarial use and cannot be automated away.
What could be automated stands in for part of it: `failure-paths.spec.ts` covers the
invalid-media, engine-kill and app-close rows, and the cancel row under `MISSION_AI=1`.
Unblocking step: run the desktop app against `tests/fixtures/mission/projects` and the
UC-15/UC-16 list in P9.2, filing each defect into the relevant phase's Discovered section.

## P10.3 — Reconcile plan and docs — `[x]`

README status table, PLAN.md **SYSMISSION** snapshot, `docs/architecture/system-map.md`
current, ADR index, CHANGELOG entries for each user-facing change, guides for
reference media, export, and the sidebar.

Landed 2026-08-29: README status table rewritten with per-phase done/partial/blocked
counts; PLAN.md SYSMISSION snapshot updated; system map carries the intentional host
differences; ADRs 0158/0159 added; CHANGELOG has an entry per user-facing change;
`docs/guides/export.md` documents progress, ETA and history. Residual: a
`docs/guides/reference-media.md` (P3.7) has not been written.

## P10.4 — Final report — `[x]`

`docs/reports/system-mission/final.md`: architecture before · after · root causes ·
structural changes · orchestration numbers before/after · editing quality before/after ·
UI/UX changes · memory fixes · export numbers · validation performed · remaining issues
(or "No known actionable issues remain within the investigated scope.").

Landed 2026-08-29: `docs/reports/full-system-mission-2026-08-29.md`, in the PROMPT.md §18
shape. Six remaining issues are listed, each with what would close it — the scope was not
clean enough to write the "no known actionable issues" line, and saying so is the point.
