# Phase 9 — E2E, failure paths, regression and efficiency gates — `[~]`

> **Ships:** the journeys in `USE-CASES.md` proven on the desktop host; failure paths
> proven; the editing rubric and efficiency metrics gated in CI.
> **Does not ship:** flaky tests. A test that needs a real provider runs in the nightly
> lane with recorded fallbacks, never in the PR lane.
> **Depends on:** Phases 1–8 (write the specs early; they go green as phases close).
> **Schema/deps:** Playwright already present; **no new dependency** without the gate.
> **Owner agent:** `qa-e2e`.

## P9.0 — Desktop e2e host — `[x]` (Playwright `_electron` launcher, smoke, resource + UX specs; recorded-provider mode not yet)

**Touches:** `tests/e2e-desktop/` (new), Playwright `_electron` launcher against the
built desktop app with the sidecar; fixtures from Phase 0; a recorded-provider mode
(`kernel/replay/`) so PR-lane runs need no key. Helpers to read the timeline state through
a test-only IPC (`debug:project`) rather than the DOM.
**Done when:** smoke opens `project-montage` in the desktop app in CI.

## P9.1 — `ai-journey.spec.ts` — `[~]` (written; runs with MISSION_AI=1 against the real bridge)

UC-01 → UC-08 → UC-09 → UC-06 → UC-07 in one session: open project, import media, attach
reference video and image, ask for the montage, assert timeline outcome by rubric,
refine, assert the refinement preserved the rest and used fewer calls, third turn relies
on memory, then reference style, then logo overlay, preview plays, export at 1080p,
`ffprobe` the file.
**Done when:** green on the desktop host with recorded provider; nightly with real.

## P9.2 — `failure-paths.spec.ts` — `[~]` (written; three rows run anywhere, the model-driven rows need MISSION_AI=1)

UC-15 rows: provider 5xx mid-run, tool throw, sidecar kill, invalid media file, 4K
20-minute file (UC-16), cancel mid-run, network offline for stock/music, export encoder
failure, app relaunch mid-run → resume control. Each asserts: nothing half-applied
(project revision unchanged or fully committed), the sidebar failure card, no orphan
processes (`pgrep`).
**Done when:** all rows green.

Landed 2026-08-29: `tests/e2e-desktop/specs/failure-paths.spec.ts`. Every row asserts the
same three things — nothing half-applied, the app says what happened, no orphan
processes. Rows that need no provider and run on any machine that can launch the app:

- **invalid media file** — a file with a video extension and no video in it (a truncated
  download, a renamed document) must be refused *with a visible reason* and must not
  change the edit. A silent no-op is what this row exists to catch.
- **engine killed mid-session** — SIGKILL the sidecar; P5.5's manager must bring exactly
  one back (a restart that leaves the old one behind is a leak) and the edit must survive.
- **app close** — every child process exits with the app, engine and ffmpeg alike.

Gated on `MISSION_AI=1`: cancel-mid-run. Still to write: provider 5xx mid-run, tool throw,
4K 20-minute file (UC-16), network offline for stock/music, export encoder failure, and
app relaunch mid-run → resume control. `[~]` until those rows exist and the suite has run
green on a machine with a provider.

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

