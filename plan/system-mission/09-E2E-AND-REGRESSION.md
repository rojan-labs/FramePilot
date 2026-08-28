# Phase 9 — E2E, failure paths, regression and efficiency gates — `[ ]`

> **Ships:** the journeys in `USE-CASES.md` proven on the desktop host; failure paths
> proven; the editing rubric and efficiency metrics gated in CI.
> **Does not ship:** flaky tests. A test that needs a real provider runs in the nightly
> lane with recorded fallbacks, never in the PR lane.
> **Depends on:** Phases 1–8 (write the specs early; they go green as phases close).
> **Schema/deps:** Playwright already present; **no new dependency** without the gate.
> **Owner agent:** `qa-e2e`.

## P9.0 — Desktop e2e host — `[ ]`

**Touches:** `tests/e2e-desktop/` (new), Playwright `_electron` launcher against the
built desktop app with the sidecar; fixtures from Phase 0; a recorded-provider mode
(`kernel/replay/`) so PR-lane runs need no key. Helpers to read the timeline state through
a test-only IPC (`debug:project`) rather than the DOM.
**Done when:** smoke opens `project-montage` in the desktop app in CI.

## P9.1 — `ai-journey.spec.ts` — `[ ]`

UC-01 → UC-08 → UC-09 → UC-06 → UC-07 in one session: open project, import media, attach
reference video and image, ask for the montage, assert timeline outcome by rubric,
refine, assert the refinement preserved the rest and used fewer calls, third turn relies
on memory, then reference style, then logo overlay, preview plays, export at 1080p,
`ffprobe` the file.
**Done when:** green on the desktop host with recorded provider; nightly with real.

## P9.2 — `failure-paths.spec.ts` — `[ ]`

UC-15 rows: provider 5xx mid-run, tool throw, sidecar kill, invalid media file, 4K
20-minute file (UC-16), cancel mid-run, network offline for stock/music, export encoder
failure, app relaunch mid-run → resume control. Each asserts: nothing half-applied
(project revision unchanged or fully committed), the sidebar failure card, no orphan
processes (`pgrep`).
**Done when:** all rows green.

## P9.3 — Editing regression suite in CI — `[ ]`

`pnpm eval:mission` (P4.4) offline in the PR lane with the committed score floor;
`pnpm eval:mission:real` nightly, publishing `reports/system-mission/mission-score.json`.
**Done when:** a seeded regression fails the PR lane.

## P9.4 — Export tests — `[ ]`

UC-13 matrix (resolution × fps × codec × container, source-capped) against both fixture
projects: `ffprobe` asserts dimensions, fps, codec, container, duration ±1 frame; cancel
test; progress accuracy test; history/reveal test.
**Done when:** matrix green on macOS runner (hardware path) and Linux (software path).

## P9.5 — Efficiency and resource gates — `[ ]`

`mission-baseline.mjs` in the nightly lane publishes tokens/turn, calls/task, context
bytes by tier, repeated-context %, cache %, planning rounds, tool calls, ops per call;
a PR that raises calls/task or tokens/turn on any scenario by > 10% without a rubric
gain fails a check. P6.6 resource test on the desktop lane.
**Done when:** both gates exist and have blocked a seeded regression once.

## P9.6 — Close — `[ ]`

`09-after.md`: journey matrix from `USE-CASES.md` with pass evidence links.

## Discovered

