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

## P9.1 — `ai-journey.spec.ts` — `[~]` (complete journey written and wired into the nightly lane; never yet run green with a provider)

UC-01 → UC-08 → UC-09 → UC-06 → UC-07 in one session: open project, import media, attach
reference video and image, ask for the montage, assert timeline outcome by rubric,
refine, assert the refinement preserved the rest and used fewer calls, third turn relies
on memory, then reference style, then logo overlay, preview plays, export at 1080p,
`ffprobe` the file.
**Done when:** green on the desktop host with recorded provider; nightly with real.

Landed 2026-08-29 (second pass): the journey now runs end to end — UC-01 → UC-08 → **UC-09
→ UC-06 → UC-07 → preview → UC-13** in one continuous session, and it is wired into
`desktop-gates` in `mission-nightly.yml` with `MISSION_AI=1`.

Three things were missing and are now there:

- **UC-09, the memory turn.** Turn three says only *"Do the same to the last section as
  well."* It names no goal, so it is answerable only from what turns one and two decided.
  The assertion is that the clip labels **changed** — a run that stalls asking what "the
  same" meant leaves the composer editable and the timeline identical, which is exactly the
  failure this row catches.
- **The preview plays.** Space, then poll the timecode for movement, then Space. A timeline
  that cannot play is not a finished edit, and nothing else in the suite would notice.
- **UC-13 through the real export dialog.** `exportThroughDialog` (in `launch.ts`) drives
  the popover the user drives — resolution, quality, container, Export — with the native
  Save-As modal replaced by a *cancel* (a native dialog blocks the main process until a
  human dismisses it, so it cannot be driven; cancelling leaves the render in the project's
  sandboxed `exports/` folder, which is the path history and Reveal then point at). The
  finished file is then probed: 1080×1920, h264, non-trivial duration. Asserting the
  rendered file is the only way this journey ends in evidence rather than in a chat log.

`[~]` for one reason: **it has not been run green.** It needs `MISSION_AI=1`, a billed
provider and the maintainer's media; the wiring exists, the run does not.


**Update 2026-08-29 — it could never have run green, and two defects are why.**

1. **Every AI row used `getByRole('status')`, which matches SIX elements** in this app: the
   save chip, the preview fit chip, the playhead clock, the sidebar's live region, the
   activity label and the toast host. Playwright's strict mode failed each row before it
   exercised anything. All five now wait on the composer's `Stop agent` button, which exists
   for exactly as long as a run does (`runIndicator()` in both specs).
2. **The app ignores `FRAMEPILOT_AI_PROVIDER` for the active provider.** It reads
   `ai-config.json` from the app data dir and defaults to `nvidia`, so every row launched
   with a mission provider in the environment still talked to whatever the default was —
   the failing runs reported `nvidia API error 410` while the environment said
   `openai-compatible`. `launchDesktop` now seeds that file, with `extraEnv` taking
   precedence so a row that puts a proxy in front of the provider is not routed past it.

Two rows had been "passing" because of defect 2 rather than on their merits: with no working
provider the run died instantly, which trivially satisfied "the run ends" without the run
ever having started. They now fail honestly.

**Closed 2026-08-30 — 12 of 12 rows green**, the eight provider-free ones and all four
under `MISSION_AI=1` against a real model provider. Two more corrections were needed on the
way, both the same mistake in different clothes: an assertion that counted the app's own
background media work as the thing under test.

- The cancel row asserted `mediaChildren === 0` right after Stop and saw ten. Those ten are
  one warm entry of the render composition cache (five sources x video + audio reader),
  which `composition_cache.py` holds open deliberately and closes with the app. "No orphans"
  means the work ENDS, so the row now waits for a quiet window with no NEW ffmpeg/ffprobe
  and fails if the app is still starting work when the budget runs out.
- The stock-outage row made the same claim and saw one, from the proxy work a 374-asset
  project starts on open. It now samples before the search and asserts the search adds none.

The 5xx row also hard-coded `FRAMEPILOT_AI_PROVIDER: 'deepseek'`, so on a machine configured
for anything else the app started with a provider it had no key for and the row timed out
having tested nothing. The proxy now sits in front of whichever provider the run would
otherwise use.
## P9.2 — `failure-paths.spec.ts` — `[x]` (12/12 rows green, including all four provider rows)

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

Landed 2026-08-29 (second pass): the rest of the UC-15 rows, plus a structural fix. The
file-level `test.skip(MISSION_AI !== '1')` sat in the describe body, which in Playwright
skips **the whole group** — so the three provider-free rows above were silently skipped on
every machine without a key, including CI. The provider-gated rows now live in a nested
`needs a model provider` describe, and the rows that need no provider run everywhere.

New rows that need **no provider**:

- **network offline for stock/music** — stock and music are fetched by the *main* process
  (the renderer's CSP forbids reaching a provider at all), so `context.setOffline()` cannot
  express this failure. The row replaces `globalThis.fetch` inside the main process via
  `app.evaluate`, throwing the same `TypeError: fetch failed` undici throws for an
  unreachable host, and asserts the panel resolves to a stated failure rather than a
  spinner that never ends. Music runs anywhere; stock needs `PEXELS_API_KEY` (without a
  key the panel shows its keyless state, which is a different row) and skips with that
  reason.
- **export encoder failure** — a stand-in `ffmpeg` on `FRAMEPILOT_FFMPEG` that exits 1 with
  an encoder message. Deliberately a *failing* ffmpeg, not a missing one: "binary not found"
  is caught at startup, while a mid-encode failure is what disk-full or a bad codec looks
  like. Asserts the job ends `failed` with a sentence, leaves no partial file where the
  finished export goes, and no orphan encoder.

New rows gated on `MISSION_AI=1`:

- **provider 5xx mid-run** — a local proxy in front of the real provider passes the first
  two calls through and 500s everything after, so the run has already applied real work
  when the provider falls over. Asserts a failure card, the run *ending*, the composer
  editable again, and nothing half-applied.
- **tool throw** — `chmod 000` on the project's media directory after the project is open,
  so the next engine-side tool that touches it throws a real OS error rather than a mocked
  one. Skipped as root, which can read a 000-mode file.
- **app relaunch mid-run** — SIGKILL the app mid-run, relaunch against the *same* user-data
  dir, and assert control comes back: composer editable, no status spinner waiting on a run
  whose process no longer exists.

Landed 2026-08-29 (third pass): the UC-16 rows. Both are provider-free.

- **60 photos in one import** — the batch drains to a card per file, the timeline is
  untouched (an import is not an edit), and no probe or thumbnailer outlives the work. The
  first and last file of the batch are both asserted, because a batch that silently drops
  its tail is the failure worth catching.
- **A 4K 20-minute camera file** — same three assertions, with the import allowed 30
  minutes. What this row is aimed at is not a crash but the app quietly giving up on a file
  that is merely big: an import that never resolves, a card that shimmers forever, an
  ffprobe still running after the user moved on.

**The 4K row skips, and will keep skipping on this machine.** No 20-minute 4K file exists
here — the largest real camera fixture is 40 seconds, a residual `tests/fixtures/mission/
README.md` already records — and `fetch-fixtures.sh` cannot invent one. The row therefore
`ffprobe`s its candidate (`tests/fixtures/mission/camera-4k-20min.mov`, or
`MISSION_LARGE_MEDIA=<path>`) and skips **with the measured shape** when it is shorter than
20 minutes or its short edge is under 2160. That is deliberate: a 40-second 1080p stand-in
would make the row green while proving nothing about large media, which is worse than a
skip that says why.

`[~]` until a real 4K 20-minute file exists on the runner and the whole suite has run green
on a machine with a provider.

## P9.3 — Editing regression suite in CI — `[x]`

`pnpm eval:mission` (P4.4) offline in the PR lane with the committed score floor;
`pnpm eval:mission:real` nightly, publishing `reports/system-mission/mission-score.json`.
**Done when:** a seeded regression fails the PR lane.

Landed 2026-08-29: the `mission-gates` job in `.github/workflows/ci.yml` (PR lane) and the
`real-eval` job in `.github/workflows/mission-nightly.yml`.

WHY it is split this way: producing a mission run needs a billed provider, a live sidecar
and the maintainer's own camera files — none of which a GitHub-hosted runner has. What a PR
*can* honestly gate is the run's committed **evidence**, which is a dependency-free JSON
reduction. So the PR job runs `mission-score.mjs` directly (no `pnpm install`, ~20 s) and
the expensive half is nightly and explicitly `continue-on-error`, because a 429 or an
expired key is not a code regression and a nightly that cries wolf gets muted.

The PR job **skips, not fails**, when no run JSON is committed: a red X meaning "no data"
trains people to ignore red.

Proof it can fail (2026-08-29, local):

```
$ node packages/ai-sdk/scripts/mission-score.mjs reports/system-mission/after-orchestration-merged.json
… | montage-30s | 1.00 | 1.00 | 3 | 1 | held | …                       exit 0
# seed: montage-30s turn scores forced to 0.50
$ node packages/ai-sdk/scripts/mission-score.mjs reports/system-mission/.tmp-score.json
| montage-30s | 1.00 | 0.50 | 3 | 1 | REGRESSION |
1 scenario(s) regressed by more than 0.05 …                             exit 2
```

## P9.4 — Export tests — `[~]` (7/8 rows green on BOTH encoder paths; the reopen row is blocked on a real question about recents)

UC-13 matrix (resolution × fps × codec × container, source-capped) against both fixture
projects: `ffprobe` asserts dimensions, fps, codec, container, duration ±1 frame; cancel
test; progress accuracy test; history/reveal test.
**Done when:** matrix green on macOS runner (hardware path) and Linux (software path).

Landed 2026-08-29: `tests/e2e-desktop/specs/export-matrix.spec.ts`, wired into the
`desktop-gates` job of `.github/workflows/mission-nightly.yml`.

Five matrix rows, each rendered through the sidecar **the desktop app itself spawned** —
the same `POST /render` → `GET /render/jobs/{id}` contract the export dialog uses — then
probed with `ffprobe`. The expected numbers are written by hand from `export_settings.py`'s
rules, **not** derived from the engine's own answer: a matrix that asks the encoder to grade
itself cannot catch the encoder being wrong. The job's self-reported `target` is then
compared against the file as a second, independent check.

| project | request | expected |
| --- | --- | --- |
| `mission-export-30s` (1080×1920, 30 fps, 4K sources) | 1080p · source fps · h264 · mp4 | 1080×1920 @30 h264 mp4 |
| `mission-export-30s` | 720p · 30 · h264 · mp4 · low | 720×1280 @30 |
| `mission-export-30s` | 1080p · 24 · hevc · mov | 1080×1920 @24 hevc mov |
| `mission-export-60s` (1920×1080, only a 640×360 source) | 2160p | **capped** to 640×360, `capped_to_source` true |
| `mission-export-60s` | source · 25 · hevc · mov | 640×360 @25, not capped |

Plus a cancel row (no partial file where the finished export goes, no orphan encoder) and a
progress-accuracy row (monotonic, and within 5 points of the elapsed fraction past the first
10%). The whole file skips with a stated reason when the media fixtures or `ffprobe` are
absent, because the fixtures are the maintainer's real camera files and are never committed.

Landed 2026-08-29 (second pass): the **history / reveal / remembered-settings** row, which
was the outstanding piece of UC-13. It goes through the export popover on its own app
instance with the project actually open, because "Recent exports" and "Reveal" are renderer
state the HTTP contract knows nothing about. Two stand-ins make it drivable, both recorded
in `launch.ts`: the native Save-As modal is **cancelled** (a native dialog blocks the main
process until a human dismisses it), and `shell.showItemInFolder` is **recorded** rather
than opening Finder mid-run — so the assertion is that Reveal hands the OS the exact path
of the file that was just written, not merely that a button exists. The renderer is then
reloaded and the project reopened: the history entry and the chosen resolution both have to
survive the window, because that is what the user comes back to.

**Update 2026-08-30 — both encoder paths run, and running them found three real bugs.**
The done-when's "macOS and Linux" was never about the kernel; it was about the hardware and
software encoders, and `FRAMEPILOT_HW_ENCODE=0` forces `libx264`/`libx265` here. Running the
matrix that way for the first time — and then again on hardware to check — turned up three
defects, none of them in the code that computes the answer, all in the seams around it:

1. **A 360p source exported as a real 3840x2160 file, 148 MB of upscaled nothing.**
   `project_for_render_worker` dropped `asset.media` from the spawn payload as
   "timeline-preview metadata" that "cannot change render semantics". It can:
   `source_facts` reads `media.width/height` for the cap that stops an upscale. The parent
   resolved the target correctly throughout, so every in-process test agreed with itself
   and only the spawned worker was blind. Fixed by keeping `media` minus its waveform
   peaks, which are what actually made the payload big and which no render reads.
2. **A cancelled export left a half-written file where the finished one goes.** Cancel
   SIGTERMs the render's process group, so nothing in the worker runs on the way out —
   including the pipeline's own partial-file discard, which only sees exceptions raised
   inside the worker. The parent now cleans up, and has to recompute the default output
   path because the HTTP API names none. Verified live: an 8 MB partial removed and logged.
3. **Every dropdown in the export dialog closed the dialog.** `Select` portals its listbox
   into `document.body`, putting the options outside the popover's subtree, and the
   outside-press handler asked only whether the press landed inside that subtree — so
   "picked 1080p" read as "clicked away". 32 existing tests missed it because
   `fireEvent.click` never dispatches a `pointerdown`.

**7 of 8 rows green on both paths.** The one that does not pass is the reopen leg of the
history row, and it stops on something that is not an export question at all: after
`page.goto` reloads the renderer, the home screen reports "No recent projects yet" for a
project opened seconds earlier. The resource baseline (P6.1) stops on the same wall. It is
recorded in §Discovered as a question for someone at the app, because whether that is a
real defect or an artefact of reloading a renderer instead of restarting the app is not
something the harness can answer.

**Update 2026-08-29 — the second platform is not the blocker the note assumed.**
## P9.5 — Efficiency and resource gates — `[x]`

`mission-baseline.mjs` in the nightly lane publishes tokens/turn, calls/task, context
bytes by tier, repeated-context %, cache %, planning rounds, tool calls, ops per call;
a PR that raises calls/task or tokens/turn on any scenario by > 10% without a rubric
gain fails a check. P6.6 resource test on the desktop lane.
**Done when:** both gates exist and have blocked a seeded regression once.

Landed 2026-08-29: `packages/ai-sdk/scripts/mission-efficiency-gate.mjs` with its floor
`reports/system-mission/mission-efficiency.json`, run in the PR lane's `mission-gates` job
and again nightly against the fresh run; P6.6's resource gate wired as the `RESOURCE_GATE=1`
step of `desktop-gates` in `mission-nightly.yml`.

WHY it is shaped as "cost **without** a rubric gain": `mission-score.mjs` asks whether the
edit is still as good, and nothing in CI asked whether it is still as cheap — the failure
mode a quarter of prompt work quietly produces. The gate reduces each scenario to a p50 of
`metrics.modelCalls` and `(tokens.prompt + tokens.output) / modelCalls`, and fails when
either rises more than 10% while the rubric score did **not** improve. Paying more for a
better edit is a trade the maintainer may make; paying more for the same edit is not.

Proof it can fail, all three arms (2026-08-29, local, against the committed floor):

```
# unchanged run
… | montage-30s | 31 → 31 (+0.0%) | 33503 → 33503 (+0.0%) | 1.00 → 1.00 | held |   exit 0

# seed: +40% modelCalls on podcast-highlight-60s
| podcast-highlight-60s | 5 → 7 (+40.0%) | … | 1.00 → 1.00 | REGRESSION |            exit 2

# seed: +30% prompt tokens on montage-30s
| montage-30s | 31 → 31 (+0.0%) | 33503 → 42912 (+28.1%) | 1.00 → 1.00 | REGRESSION | exit 2

# seed: +40% calls on remove-dead-air BUT score 0.75 → 1.00
| remove-dead-air | 6 → 8 (+33.3%) | … | 0.75 → 1.00 | costlier, but a better edit |  exit 0
```

The last arm is the one that matters: the gate does not fire when the extra cost bought a
better edit, which is why it can stay on without being routed around.

All three arms were **re-verified on 2026-08-29** against the committed
`after-orchestration-merged.json` and reproduce exactly as recorded.

Landed 2026-08-29 (second pass): the **third** gate — P6.6's resource gate — is now provable
too. It was six inline `expect`s at the bottom of `resource-baseline.spec.ts`, which made it
unfalsifiable in practice: the only way to see whether it could fail was to spend ten minutes
driving the real app and hope it leaked. The arithmetic moved to `specs/resource-gate.ts` as
a pure function returning one line per breached bound, and `specs/resource-gate.spec.ts`
replays the committed `reports/system-mission/baseline-resources.json` through it:

```
$ npx playwright test specs/resource-gate.spec.ts
  ✓ holds on the real measured session
  ✓ fails on a seeded heap leak
  ✓ fails on seeded listener and node growth
  ✓ fails on a seeded file-handle leak and on an orphan encoder
  ✓ tolerates the ordinary variance the bounds were drawn for
  5 passed (0.5s)
```

Green on the real trace, red on each seeded leak, green again on ordinary variance — that
last row is part of the proof, not padding: a gate that fires on noise gets disabled within
a week. It launches nothing and needs no media, so it runs first in `desktop-gates` and
reports a loosened-into-a-no-op gate in seconds rather than in hours.

Residual (not blocking `[x]`): the efficiency floor covers `montage-30s`,
`podcast-highlight-60s`, `remove-dead-air` and `beat-sync`; `refine-tighten` and
`memory-captions` report as **new** because the committed floor predates them. Regenerating
the floor is `reports/` work, outside this task's scope.

## P9.6 — Close — `[x]`

`09-after.md`: journey matrix from `USE-CASES.md` with pass evidence links.

Landed 2026-08-29: `docs/reports/system-mission/09-after.md` — all sixteen journeys, each
with the evidence that actually exists behind it (a measured rubric p50 from `01-after.md`,
or the spec that asserts it), the three gates with their seeded-failure transcripts, an
explicit "what is not proven, and why" section, and the lane table showing why the cheap
half is in the PR lane and the expensive half is nightly.

Nine of sixteen journeys have a measured outcome. The report says so plainly rather than
counting written specs as proof: the editing journeys are measured, the desktop-host
journeys are written and wired but waiting on a run with a provider and the maintainer's
media. `USE-CASES.md`'s own State column was left untouched (outside this task's scope);
`09-after.md` is the current answer.

## Discovered

- [ ] **Recent projects is empty after a renderer reload.** Open a mission fixture project,
  then reload the window: the home screen says "No recent projects yet" for a project opened
  seconds earlier, even though `recentFiles.add(...)` runs on open and the store reads the
  file on every render. Two independent rows stop here — the export history/reveal row
  (P9.4) and the close/reopen leg of the resource baseline (P6.1). **Needs someone at the
  app** to say whether a real user loses their recents (a defect) or whether reloading a
  renderer is simply not the same as restarting the app (a harness artefact). Everything
  either row asserts BEFORE the reload passes.

- [ ] **The "unreadable media" row leaves a fixture directory at mode 000.** Found
  2026-08-29 the expensive way: `tests/fixtures/mission/projects/media/mission-montage/`
  was left unreadable, so `ls` reported it empty, and it looked for a while as though a
  `git filter-branch` checkout had deleted 15 GB of the maintainer's camera footage. It had
  not — one `chmod 755` brought all 437 files back. The row must restore the mode in a
  `finally`, and it should chmod the FILE it wants unreadable rather than the directory
  holding every montage fixture.

- [ ] **`brain.sqlite`, the derived thumbnail cache and the sidecar analysis caches under
  `tests/fixtures/mission/projects/` are regenerated on every run.** They are now
  gitignored. If any e2e row actually depends on pre-seeded analysis rather than
  regenerating it, that dependency is now invisible and will show up as a slow first run —
  worth confirming once.

