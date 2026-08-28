# Phase 0 — Baseline and system map — `[~]`

> **Ships:** a number for every claim the later phases will make, produced by
> reproducible commands, plus a current system map. Nothing behavioural changes.
> **Does not ship:** any fix. If you find a defect, log it in §"Discovered" and move on.
> **Depends on:** nothing. **Schema/deps:** none.
> **Output:** `docs/architecture/system-map.md`, `docs/reports/system-mission/00-baseline.md`,
> `reports/system-mission/baseline-*.json`.

Most of the instruments already exist. This phase wires them into one repeatable report
and runs them against desktop-scale media. Where an instrument is missing, build the
smallest one that produces a number, and keep it (later phases re-run it).

## Fixture set (build once, reuse everywhere)

`tests/fixtures/mission/` — **not committed if >5 MB**; a `fetch-fixtures.sh` that
downloads or generates them, with checksums:

- `talk-10min.mp4` — 1080p30 talking head, ≥10 min, speech with silences.
- `event-4k-20min.mp4` — 4K camera file, ≥20 min (UC-16).
- `broll/` — 12 short 4K clips.
- `photos/` — 60 JPEG stills (media-intelligence closure trigger case).
- `music/` — 2 tracks with clear beats, one with tempo change.
- `ref/` — 3 reference videos (fast-cut social, slow cinematic, caption-heavy) and 6
  reference images (logo PNG with alpha, mood image, thumbnail, character, color chart,
  design frame).
- `project-montage.fp.json`, `project-podcast.fp.json` — projects pointing at the above.

## P0.1 — System map — `[x]`

**Touches:** `docs/architecture/system-map.md` (create).
Walk the tree in the order `PROMPT.md` §2 lists and write the map: one section per
boundary, with the concrete module that owns each side and the data shape that crosses
it (request/response types by name). Include the desktop IPC surface
(`apps/desktop/electron/preload.cts` channels), sidecar routes (`service.py` `@app.*`),
and the ai-sdk effect kinds (`kernel/effects.ts`). Mark every place two implementations
of one policy exist (candidate parity defects for Phase 2).
**Done when:** a reader can name the file that owns each arrow in `USE-CASES.md` §A.

## P0.2 — Orchestration and token baseline — `[ ]`

**Reuses:** `scripts/context-benchmark.mjs`, `kernel/cost/run-metrics.ts`,
`baseline-capture.ts`, `eval/foundation-real-eval.ts`, `framepilot.runs.jsonl`.
**Builds:** `packages/ai-sdk/scripts/mission-baseline.mjs` that runs the scenario list
below through `Orchestrator.streamAgent` with the real desktop provider config and
writes one JSON row per run.

Scenarios: UC-01, UC-02, UC-03, UC-05, UC-08 (as a second turn after UC-01), UC-09.
Per run record: model calls, orchestration rounds, input/output/cached tokens per call,
prompt bytes by context tier (from the token manifest), tool calls and repeats (same tool
+ same args), analysis calls that hit cache vs recomputed, wall time, USD, final timeline
outcome hash. Three runs per scenario; report p50 and spread.

Also produce the **call ledger**: for each scenario, a table of every model call with the
question "why does this call exist?" answered in one line, and a column for the Phase 1
candidate (deterministic / cache / parallel / less context / worker / structured state /
keep). This table is Phase 1's input.

**Done when:** `reports/system-mission/baseline-orchestration.json` exists and the ledger
is in the baseline report.

## P0.3 — Editing outcome baseline — `[ ]`

For the same runs: score the timeline outcome with a deterministic rubric per scenario
(clip count in range, total duration, cuts on frame grid, no overlaps, beat proximity
where applicable, no mid-word cuts using transcript words, captions present when asked).
Put the rubric in `packages/ai-sdk/src/eval/mission-rubric.ts` (pure, table-tested) — it
becomes the Phase 4 grader. Record incorrect edits, invalid ops, repeated corrections,
tool/runtime failures per run.
**Done when:** each scenario has a baseline score and a failure list.

## P0.4 — Application resource baseline — `[ ]`

Desktop app, `project-montage` open. Capture at: idle after load; after 10 min of
scrubbing/trim/zoom; after 5 AI turns; during and after export. Instruments:
`process.memoryUsage()` + `process.getProcessMemoryInfo()` behind a dev-only IPC
(`debug:resources`), renderer `performance.measureUserAgentSpecificMemory()` where
available, `ps` for sidecar + FFmpeg/ffprobe children, `lsof -p` for file handles,
count of `URL.createObjectURL` minus `revokeObjectURL` (wrap in dev), listener counts on
the main `ipcMain` and on the sidecar event emitters, active timers via a dev counter.
Script: `apps/desktop/scripts/resource-snapshot.mjs`.
**Done when:** a table of the four checkpoints exists; any monotonic growth is listed as a
Phase 6 lead.

## P0.5 — Export baseline — `[ ]`

Run the export of `project-montage` (≈30 s) and `project-podcast` (≈60 s) at the current
default preset: startup latency (request → first frame encoded), encode wall time,
CPU% and GPU% (`powermetrics`/Activity Monitor sampling on macOS), peak RSS of the
sidecar and of FFmpeg, intermediate files written (bytes), re-encodes of unchanged
assets, progress-report cadence and error vs actual. Also record where FFmpeg is invoked
from (`render/compiler.py`, MoviePy `write_videofile`) and with which codec args.
**Done when:** numbers are in the report and the FFmpeg command line is captured verbatim.

## P0.6 — UI/UX walkthrough — `[ ]`

Screenshots + notes for every surface `PROMPT.md` §14 lists, on the desktop app. For each
finding: surface, what a professional tool does, what FramePilot does, severity
(blocks work / slows work / cosmetic). This is Phase 8's input; do not fix anything here.
Cross-check `UI_AUDIT.md` and `docs/reports/ui-system-audit-closure.md` so closed items
are not re-raised.
**Done when:** `docs/reports/system-mission/00-ux-findings.md` exists, findings numbered
UX-nn.

## P0.7 — Baseline report — `[ ]`

Assemble `docs/reports/system-mission/00-baseline.md`: every number, the command that
produced it, the fixture checksum, and the git SHA. Update the README status table and
the PLAN.md **SYSMISSION** snapshot.

## Discovered

(Add defects found during measurement here as `- [ ] <one line> → phase N`.)
- [ ] `POST /transcribe` on a video with no audio stream returns a 422 whose detail is the raw
      ffmpeg banner + "Output file does not contain any stream" (`talk-1080p-98s.mp4`).
      `/analyze-silence` already answers the same case with `{ranges: [], reason}`; transcribe
      should probe for an audio stream first and return a typed "no audio track" outcome → Phase 5
      (P5.4 error contracts) / Phase 8 (sidebar shows it in plain words).
- [ ] **A run whose every model call fails still reports `completed` and applies an edit.**
      Smoke run with the DeepSeek provider answering `402 Insufficient Balance`: 2 captured
      provider calls at 0 ms / 0 tokens, `errors: []`, final status `completed`, two
      `delete_range` tool calls (one repeated) and one operation applied to the podcast
      project (`reports/system-mission/smoke.json`, label `smoke`, 2026-08-29). The user
      would see "done" with a timeline change that no model reasoned about. → Phase 5 P5.5
      (provider failure must be a typed run failure) and Phase 8 P8.2 (failed state).

