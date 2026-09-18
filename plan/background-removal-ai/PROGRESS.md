# Progress (resume state)

Read this first after a context reset. Updated after every commit.

- **PR:** #124, branch `plan/background-removal-ai`, worktree `../FramePilot-background-removal`. One PR; commits prefixed with task ids; no attribution trailers; no `git add -A`, no `git stash`.
- **Verification:** targeted test files locally; full suites run in CI on the PR head SHA.
- **Memory rule (2026-09-16 incident: >70 GB, machine shut down):** Playwright, the PX4 oracle and engine-frame generation run ONLY in CI (read artifacts via `gh run download`). Local heavy jobs (BR0 models) one at a time, 1 worker, RSS watchdog ≈ 10 GB. Vitest single file, no file parallelism.

## Current

**Resumed 2026-09-18 01:59.** Fresh agents (maintainer: don't resume old ones): (1) finish PX5.3 from the uncommitted GPU matte pass on disk; AM verification + AM4 + AM1.6 + AM5 harness done; AM2.5 done: all AM5 gates pass. PX5.3 done in code (desktop tier trigger → MO-17). Next: MK8 (analytic kinds, track matte, presets — also unblocks AM2.4's two tools), BR6.10–6.12, AM2.6. PX5.1/5.2 done: matte rows miss. MK5, MK6 done; MK7 done bar MK7.6 (MO-14). BR5 and MK4 done; CI green at c46d104d (run 35285412166, 11/11 jobs) (pointer-to-paint budget, MK flag, schema v22/v23 verdict, CI reds). Perf tests now gated behind `FRAMEPILOT_RUN_PERF=1` (4038be4b) after they starved the coverage run and timed out an unrelated editor-core test.
On resume, read ONLY this file first, then the specific plan file for the task you start. Don't re-read 00–12 wholesale.

1. CI: `gh run list --branch plan/background-removal-ai --workflow CI -L 3`. Runs 35245865537 (6ec24d91), 35245714147 and 35245248405 were in flight. Fix any red before new work.
2. MK4 (canvas tools + mask panel) was mid-task: MK4.1–MK4.6 commits landed (e19901d0 deleted addMaskPatch; 8670a499 Playwright flows; 547d065d save budget 172 ms / 13.4 MB ✓; 1c6a3a65 parse 29 ms). The agent was "fixing the migration test expectations and making the budget run uninstrumented in CI". Its docs commit 03007ebf mentions **schema v23**. Verify whether MK4 bumped the schema (migration + Pydantic twin + drift tests), check the CI result, and finish MK4 (pointer-to-paint budget number into MK4-BUDGETS.md, the MK feature flag). Then tick MK4.
3. BR5 (matte in the preview) was **stopped by the maintainer** mid-run. Commits: BR5.1 (933ffcac, a3785556), BR5.2 Flagged view (e7bcb01d). Read the CI oracle result for its head before continuing; the matte row must pass the unchanged gates; record the proxy decision (VP9 vs lossless).
4. BR3.15 done (c1140aee): the numbers are in BR0-FINDINGS.md and under Gate numbers below. The calibration split misses `similar_colour` and `twin_distractor` (watchdog aborts), so re-run those two when memory allows (start rule: `memory_pressure -Q` free ≥ 40%).

Next after those: MK5 (effect-target masks), MK6 (key), MK7 (tracking) → BR6 (UI + review) → AM1–AM5; PX5 perf; MK8/MK9; RD2 remainder; E2E + DOC.1.
Agent rules to paste into every prompt: single-file tests with `--no-file-parallelism`; no local Playwright or oracle (CI only; poll CI yourself in bounded rounds, never end a turn "waiting"); watchdog for model runs; explicit `git add`; no stash, force-push or trailers; don't edit plan files.

## Done

- PX5.3 (f0addf60…791a8422, ADR 0181): GPU matte pass, separate matte decode workers, host-derived monitor tier, index-only matte open (was reading 149 MB per 4K matte). Found and fixed: key drawn with the wrong GPU program in the monitor since MK6.1; the pointer regression was BR6.6 subscribing Editor/Inspector to the whole mask-tools store (work p95 back to 9.0 ms)

- AM1–AM4 + RD2.1 (4e99f000…014f7e18): verified by a second agent, which fixed five problems — a masked grade wrote to a second, never-rendered grade; the model saw a `verified` field; the kill switch leaked into Cmd+K/suggestions and did nothing in the browser build; MANUAL_TESTING still pointed at `generate_mask`; an unused parameter broke tsc. Masking skill (284/300 chars) +115 tokens per request with masking on, zero without masks. Open: AM1.6 geometry-source loophole; MO-16 face grouping without consent

- PX5.1/PX5.2 (8a87dac9…837fe985): compositor telemetry, generated 4K Scale fixture, `preview-perf` CI job (invariants only; ~15 min per run), export optimisation (`decontaminate` inside the edge-band box: 227 → 65 ms per 4K frame, byte-identical, 38 equality cases)

- BR6 (3a45148d…2dde0422): background-removal row with every pack state and its copy, AI Object + AI Brush, progress with phases/ETA/cancel, review panel shared with tracking, text behind subject, export notice, processing bands. **CI green, run 35304699655.** Found a real product bug: the sticky inspector statusbar covered the bottom of its own scroll port, so controls scrolled flush to it were unclickable for anyone

- MK5 + MK6 (c6a8092a…71bbbcf7): "Add mask" on every effect row (one op, no invented bounds), adjustment-lane mask rendering (twin evaluators, byte-exact), the `key` kind (HSL/RGB/luma/3D, despill after attach, shadow retention), the finesse chain shared by key and matte, key gates on a real GPU. Caught a shader bug (R8UI sampled as sampler2D) that corrupted whole frames

- MK7.1–MK7.5 (ea98df93…d3dfa2aa): transform-track artifact (48 parity cases byte-equal TS↔Python), 4 methods incl. perspective + per-vertex, reverse/one-frame/to-edge, review + constraints, tracking panel with feature points and exclusion regions. Note: an agent used `git push --force-with-lease` once to fix a commit message (against the rules; no content lost)

- MK4 (…c46d104d): canvas tools, mask panel, keyframe lane, presets (**schema v23**, migration + Pydantic twin + drift), addMaskPatch deleted, Playwright flows, mask-tools flag, MANUAL_TESTING §16. Found and fixed a layout thrash (getBoundingClientRect per pointer move)

- BR5 (6c56ef91…31ae9ff2): matte in the preview. Cause of the 8 red rows: CI ffmpeg writes FFV1 in a VFW-wrapped Matroska header the preview demuxer rejected. **59/59 oracle cases pass, baseline empty.** Preview decodes lossless FFV1 masters (540p VP9 measured 32.44 dB / 98.34% — below gates). Progressive: unprocessed ranges say "Processing background removal", never a wrong picture

- **CI fully green** at 2bd1511e (run 35213883104): TS, Python, vectors mac/win, oracle, E2E smoke, visual, desktop build, professional ops
- MK3 (c6f9e4b3…2bd1511e): TS rasteriser byte-equal (108 rasters × 3 platforms), mask-stack compositor pass, clip-mask.ts deleted, mask views, 5 mask oracle rows PSNR inf; engine fix: static expansionPx/edgeShiftPx ignored at export; smoke fix: compositor transport length/paused seek

- Web-editor v21-mask test fixes (95220dde, 3a294134); product bug fixed: Add mask on unmeasured media silently did nothing → Inspector now shows "Measure this media first"

- PX2 + PX3 (… 400c8b52): layer compositor, exact effect ports, sidecar Pillow text raster ("Preview text approximate" fallback), VFR pts, rotated-anamorphic export fix, decoder pool, range-read demux, load shedding, gates removed behind flag, browser "Preview unavailable", ADR 0180. Oracle 46/48
- BR3.1–BR3.14 (7183d9a0…df52f3ca): Smart Mask worker, CI workflow, release list; BR3.15 running

- BR4.12 post-approval (b8aa5615…4960a9a1): ADR/03/P17 wording, health-check group kill, inode/mtime pin, wider Clean scan, ffprobe whitelists, 503 retry + sized deadline, missing record → STALE, security runbook. Remaining condition: CI green on head

- BR4.12 fixes (9ba7df01…47d572c1): process-group kill + nlink recheck, footprint/stall/staging watchdog, real-dir chain, folder-wide references, route semaphore/deadline + ffmpeg protocol/format whitelists, L1–L6, fuzz corpus + harnesses (213 desktop tests), ADR 0114 accepted-risk amendment

- BR4.9/4.11/4.13/4.14 (999ff604…91076959): sidecar frame hashes + locked-frame compare, relink_asset op + STALE, job scheduler + JobsPanel + resume + quit prompt, job reports + diagnostic bundle

- BR4.1–BR4.7, BR4.10 (f2551123…fee3c439): protocol, staging + host verification, matte job lifecycle, status/installed/matte/correction/storage IPC, auto prompt, storage clean, open-time validation, disk preflight. Fake worker. Fixed MK1 fixture regression in automatic-tracking-executor.test.ts (6a4a390f, 11/11)

- BR2.5–BR2.7 (8dc28312, 4bf845c6, df5c5e25) + mypy fix a404c99a: VFR decode by pts, display-space mattes, deterministic resample; follow-ups PX2.10/PX2.11; pts probe cost on multi-GB files unmeasured (PX5)

- BR2.1–BR2.4 (38bde7a3…44b990e1): matte reader, stack integration (decontaminate, edge shift, edgeMode sharp = clean 0.25/0.75), typed refusals, alignment 100%, 6 goldens; frames.json format defined for BR3.2

- PX2 in flight: RD2.1 flag (2c6f1e3f); PX2.1 sync paused frames (23cf2f39); PX2.2 frame-effect ports (a30404b2); PX2.3 burned captions in track order (262d0ea4); PX2.5 speed audio (4a171c0c); PX2.6 range-read demux (a41a4631); PX2.8 load shedding (98fbaab6); PX2.9 display-size fit (15f83692)
- BR0 in flight: ADR 0179 (89b848ef); BR0.3 box-prompt consensus (94b4faa7); BR0.4 verify prototype (344c3377); CoreML memory attention 8.4 GB footprint (0565c15c)

- PX4 (74a464ad…020406db): CI-only oracle, baseline, PX0.3 colour; lint fix 26e954c5

- MK1.9 (46330963…0c5561ee): probe records PAR + rotation; masks measured in display space everywhere. Follow-up PX2.9: clip fit/crop placement still uses coded size

- MK2 fixes (e3b4d535, 9fcb2496, b0c7fbaf, 559c0adc): 256× reference, exact nonzero coverage at crossings, per-frame legacy resample
- MK2 (622e760f…242d352f): exact rasteriser, mask_stack.py, 33 vector cases × 3 res byte-exact, 15 render goldens, CI vectors on macOS (green) + Windows (1 red: libm table regen test)
- PX1.2 follow-up (622e760f): frame plan reads v22 mask stack

- MK1.1–MK1.7 (5f692689 … 80d28e08): v22 stack, migration + backup, 38 op round trips, validator, split keyframe fix, ADR 0178. Interim engine/preview render one alpha rect/ellipse/polygon; the rest refused with typed reasons until MK2. Follow-ups: MK1.9 PAR/rotation probe; `use_track` for text → MK7.6
- PX4.1 (74a464ad), PX4.2 (79fd67cc); BR0.1 (b82f2a8d), BR0.2 harness (90d31c37), BR0.3 helpers (cba6a64f)

- PX1 (13555c1b, ad4cb4e2, 95461921): frame plan both sides, 43 parity cases
- PX0.1/.2/.4 (c186e774, 6663c4df, eb8c3dc2): 18/43 rows WebCodecs, 25 DOM; any text clip → DOM player; speedRamp admitted to canvas but not followed

- RD0.1 (9fd09d00): competitor re-check, `12` §E
- Setup: PR retitled and marked ready; `PROGRESS.md` and `MAINTAINER_ONLY_ACTIONS.md` created.

## Blocked (maintainer-only, see `MAINTAINER_ONLY_ACTIONS.md`)

- RD1.1–RD1.2, RD1.5–RD1.6, RD2.3–RD2.4, RD3 (MO-1..MO-7, MO-10)
- BR7.1 labels (MO-8); win32-x64 evidence (MO-9)
- BiRefNet_HR-matting training-data licence sign-off (MO-11) — BR0.5 open finding
- Smart Mask hardware floor (MO-12) and ≥ 32 GB Mac for 2048² runs (MO-13)

## Next

PX0 → PX1 → PX4 → PX2; MK1 → MK2; BR0; RD0.

## CI reds

- save-budget.perf.test.ts failed once at 252.7 ms vs 250 ms (dispatch run 35332745167); passed on the same commit in the PR run — watch for a flake


- none open (run 35304699655 at 2dde0422: 11/11 green)
- (earlier) none open (run 35285412166 at c46d104d: 11/11 green)
- Tip: `gh workflow run CI --ref plan/background-removal-ai` lands in a different concurrency group than PR pushes, so long jobs aren't cancelled by peers' pushes

- Run 35174495193 (3f4c2029): ai-sdk repeated-failure.test.ts v21 mask fixture → fixed 41af6255; Python test_mask_render_golden.py 10 cases block-mean drift 1.2–4.3 on ubuntu (codec, not mask) → fixed b532e432 (numpy lossless source; testsrc2 differs between ffmpeg 7.1/8.1); CI run 35185364341 Python ✓ vectors ✓, TS + oracle pending

- Frequent pushes cancel long CI jobs (concurrency cancel-in-progress); a full green run needs a quiet window. Vector jobs green on 9fcb2496 (macOS + Windows).

- 2faef783: ai-sdk typecheck (AddMaskOp `shape`/`keyframes` readers) — fix expected in 5154492b; re-check
- Note: the Claude Code process restarted twice; agents resumed via SendMessage, their on-disk work survived

## Gate numbers

- PX5.3 (M1 Pro, Chrome/Metal, scale/proxy): with the monitor tier 1/601 dropped (0.17%) ✓, seek p95 49.9–52.5 ms ✓, no main-thread matte work in playback; masters only: seek 90.6 ms ✓ but 8.4% dropped ✗ (the desktop can't make the tier until MO-17). Oracle 59/59 (runs 35324781183, 35329323404)

- AM5 after AM2.5 (run 35334744723, 1.1 packs): target accuracy 37/37 = 100% ✓, unnecessary asks 0% ✓, ambiguous asks 21/21 ✓, confident-wrong 0 ✓, invented geometry 0 ✓, adversarial 10/10. Replayed as 1.0 packs: no wrong picks, objects ask. Colour path proven only on synthetic vectors (AM2.6)

- AM5 (run 35329323404, 92 requests): ambiguous asks 21/21 ✓, confident-wrong 0 ✓, invented geometry 0 ✓, needs_click on out-of-vocabulary 22/22, face picker 7/7, adversarial 10/10. **Target accuracy 25/37 = 67.6% ✗ (≥ 99%), unnecessary asks 12/37 = 32% ✗ (≤ 3%)** — all 12 misses ask safely; 11 are objects reported as generic "object", 1 needs colour

- PX5 (M1 Pro, Chrome/Metal, 20 s runs, monitor on 540p proxies): playback 4 layers + text 0.17% dropped ✓; + animated 200-vertex path ✓; + key with full finesse ✓; seek 36–56 ms ✓; decoders ≤ 6 ✓. **With a 4K matte: 600/601 frames dropped ✗, seek 617 ms p95 ✗** (CPU float64 matte maths 452 ms/composite + TS FFV1 decode 101 ms/frame). Export with masks + 4K matte 1.49× local / 1.56× CI vs gate 1.5× ✗ narrowly (was 1.98×), measured on a 4–6 s window only. Picture cache peaks 401–676 MB vs nominal 384 MB (pinned decode-ahead frames). Not measured: other hardware, packaged Electron + fp-media://, camera footage, cold storage, full 3-min export

- MK6 key parity (run 35300279316, real GPU): ≤ 1/255 on 1296 values, all four encodings ✓; CPU twin exact 0/255
- MK5 oracle (run 35295665259): 249/249 checks; effect-kinds-masked min PSNR 68.52 dB, max channel error 2/255, 100% within tolerance
- Open, written down not implied: preview key finesse morphology capped at 16 px (export uncapped); no playback budget yet for a key's finesse chain (PX5)

- MK7 tracking (pack run 35294557292, both platforms): planar/translation median 0.0204 px, similarity 0.0771, perspective 0.0698 (gates ≤0.25 median / ≤1 p95 / ≤2 max) ✓; drift 2e-13 px per 300 frames ✓; recall 100% **by refusal** (`target_lost`), so the confidence number's own recall is unevidenced; real-clip row and the ≥95% correction rate open

- MK4.6: save 162.5 ms / 13.4 MB ✓ (gate 250 ms). Pointer: monitor work p95 6.3 ms ✓ vs 16 ms; end-to-end 19.3–22.0 ms including 12–15 ms Playwright CDP injection — **not a product number, not gated**; confirm on real hardware in the beta (MO-7)

- PX4 oracle run 35281873504: **59/59 cases pass**; 7 of 8 matte rows bit-identical, matte-text-behind-subject 53.68 dB; baseline `cases` empty (only colour.bt709-limited webgl, the harness's non-compositor path)

- BR3.15 (scored split, construction-true, CPU, BiRefNet 768²): mean IoU 0.938, 5th pct 0.785, BF@2px 0.780, 71.9% of frames wrong by the 06 rule. Recall on held-out 96.5% ✗ (gate ≥ 99.5%); review load gate ✗. Job peak 4.2–4.5 GB. Weak categories: low_light 0.81, leave_reenter 0.87, crossing 0.89
- MK4.6 save budget ✓ 172 ms / 13.4 MB (1,000 path keyframes × 200 vertices); pointer-to-paint number pending

- PX4 oracle (CI run 35213883104): 51/52 pass (only matte row → BR5)
- (earlier) PX4 oracle (CI run 35188154157): 46/48 pass; mask-shapes 10.21 dB (MK3), matte row 14.61 dB (BR5)
- (earlier) PX4 oracle (CI run 35172331641): 43/48 cases pass, all on the layer compositor; remaining: mask stack (MK3), matte row (needs synthetic artifact → then BR5), 3 text rows PSNR 37.0–39.8 dB (glyph hinting; fix = sidecar Pillow text raster on desktop, gate unchanged). Compositor colour error 0/255 on all four encodings

- BR0 (BR0-FINDINGS.md): SAM CPU fp32 ✓ 0.99954; SAM fp16s ✗ 0.99832 → fp32; SAM CoreML disabled (decoder build error, 8.4 GB memory attention); BiRefNet CPU @768² fp32 ✓ (mean 0.0007/255) fp16s ✓ (mean 0.0047/255, max 0.108/255); @2048² not measured (12 GB > budget, MO-13); pilot mean IoU 0.006–0.967 ✗ (pipeline bugs → BR3.15); recall/review load NOT demonstrated (100%/100%); pack ≈ 1.47 GB (fp32 SAM); 1080p30 ≈ 520 compute-s/footage-s at 1024² CPU, ≈ 1,210 at 2048²; FFV1 1080p30 matte 23.2 + fg 81.4 MiB/min

- MK2 ✓: coverage vs 256× supersample max 0.0023 (≤1/255) on all 36 cases incl. self-crossing; vs exact clipping 2.3e-5; distance feather straight 0 / circle 0.00133 / per-vertex 0; path interpolation ≤1e-6; legacy migration 15/15 byte-identical at every 30 fps frame (migrated animated masks carry per-frame keyframes); vectors byte-equal macOS arm64 + Windows x64 + Linux
- BR0 SAM 2.1 ONNX CPU fp32 min per-frame IoU 0.99954 ✓; fp16-stored 0.99832 ✗ → SAM ships fp32 by rule; CoreML: decoder module fails to build (EP disabled for it), image encoder 422 s cold prepare
- PX4 baseline (CI run 35140382484): 43 cases/184 samples, 1 passes; 25 renderer: DOM; 17 WebCodecs fail (pixels 17, pts 9, sentinel 7)
- PX0.3 colour (SwiftShader): BT.601 limited max err 2/255 canvas2d & WebGL (see PX0-INVENTORY for all four encodings)
- Memory: SAM parity run reached 16 GB footprint (killed 2026-09-17); BR0 bounding it
