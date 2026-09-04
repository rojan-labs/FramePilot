# ADR 0168 — A budget is a setting, not an announcement

- **Status:** Accepted
- **Date:** 2026-09-02
- **Schema:** unchanged (a renderer preference in `framepilot.settings`; no project file,
  no migration). Twelve frozen sessions and the `streamAgent` snapshot were regenerated —
  the diff is one removed notification per session plus the id renumbering it forces.
- **Relates to:** goal.md Workstream D, ADR 0166 (a refused legitimate edit costs more
  than a wipe), GOLDEN-D.1 (the run budget), GOLDEN-D.4 (this), GOLDEN-D.5 (the deadline
  that makes the number true)

## Context

goal.md Workstream D asks that every run be bounded by explicit turn, time and cost
budgets, "surfaced to the user before an expensive operation starts". GOLDEN-D.1 read that
literally: `budgetNotice(config)` was emitted as the second event of every agent run —

> This run may use up to 300 steps, $6.00 and 37 minutes; it stops and reports what it
> applied if it reaches any of them.

and the control that set those numbers lived in the AI panel's options row, under the
composer, next to where a run is started.

Two things were wrong with that shape, and the maintainer named both.

**The sentence is not news.** It restates three numbers that did not change since the last
run, before any work has happened, in a transcript whose whole value is what the run
actually did. Read once it is orientation; read before every run it is noise, and it is
noise in the one surface the user scans to find out what changed about their video.

**The control was in the wrong place.** Docked in the composer's options row, the budget
reads as a property of *this* run — something to reconsider each time — when it is a
standing preference: how much a person is willing to spend on any one request. It was also
invisible in chat and edit mode, which ignore `agentOptions` entirely, so the number
governing every agent run was only visible from one of three modes.

## Decision

The budget is a **setting**. It lives in Settings → AI → "Run budget", stored in the one
editor settings key (`useSettings`: `maxRunUsd`, `maxRunMinutes`), set once and applied to
every agent run. `budgetNotice` and the notification it produced are deleted.

This deliberately supersedes the per-run reading of goal.md D. The requirement is that the
user knows what bounds a run before it starts; a permanent, always-inspectable control
satisfies that better than a line repeated before work that has not begun. What a run
still owes the user is the **reason it stopped**, and `budgetExhausted` says that at the
moment a limit is actually reached — which is when the information is news.

An out-of-range persisted value falls back to the default rather than being clamped: a
number outside the range was never a choice this UI could have written, so it is not
trusted as one. A committed value *is* clamped, so a legitimate choice always survives.

## Consequences

- A run's first event is the `thinking` status. Tests that enumerate a run's opening
  events must not expect a notification; the frozen corpora were regenerated accordingly.
- The two ad-hoc `framepilot.ai.maxUsd` / `.maxMinutes` keys are gone. No migration was
  written: they shipped only on this branch and had no users.
- Desktop and browser share one control, because the desktop renderer *is* the web editor.
- **The setting now makes a promise the engine had to be taught to keep.** GOLDEN-D.1's
  budget was read only at turn boundaries, so a step that never returned was unbounded —
  run `369e8c82` was given 37 minutes and hung for 39 of them past its limit. A number in
  Settings that a run can silently exceed is worse than no number, which is why the
  in-flight deadline (GOLDEN-D.5, `reliability/deadline.ts`) is part of this decision and
  not a follow-up to it.
- Reversible: restoring the notice is one line in `onCommand`. It should not be restored
  without the maintainer, and the comment above that line says so.
