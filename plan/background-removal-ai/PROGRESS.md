# Progress (resume state)

Read this first after a context reset. Updated after every commit.

- **PR:** #124, branch `plan/background-removal-ai`, worktree `../FramePilot-background-removal`. One PR; commits prefixed with task ids; no attribution trailers; no `git add -A`, no `git stash`.
- **Verification:** targeted test files locally; full suites run in CI on the PR head SHA.
- **Memory rule (2026-09-16 incident: >70 GB, machine shut down):** Playwright, the PX4 oracle and engine-frame generation run ONLY in CI (read artifacts via `gh run download`). Local heavy jobs (BR0 models) one at a time, 1 worker, RSS watchdog ≈ 10 GB. Vitest single file, no file parallelism.

## Current

Maintainer 2026-09-19: "finish everything; you can run the things on this laptop as well" (local runs allowed, one heavy job at a time, guard: stop if free memory < 25% or swap grows > 1.5 GB).
Running:
Blocked on maintainer only: see MAINTAINER_ONLY_ACTIONS.md (MO-1..MO-20). RD3 last.
Agent rules: single-file tests with `--no-file-parallelism`; local Playwright/model runs one at a time under the guard; poll CI yourself in bounded rounds; explicit `git add`, never stage others' files; no stash, force-push or trailers; don't edit plan files.

## Done

- BR4.12 follow-ups on ae8ef8a5/4c227ec1 (f7b67b06…ed7e6567): F1 fail-closed staging budget; F2 host-owned staging.json + media content fingerprint in the worker's resume fingerprint; F3 worker temp under staging; F4 unreadable dir = breach; F5 adopt only on resume + per-job lock; F6 realpath re-check, no hard links, bounded walk; tracking/detection/segment/embed jobs now have the watchdog. 317 desktop pack tests; E2E.6 passes locally. Open (recorded): no single-instance lock, lock-takeover race, reused-pid false live

- E2E.3/.4/.6/(.7 local) + DOC.1: 16/16 masking e2e pass locally at 46438836. 10 product bugs fixed: tracked-mask blur blurred the whole frame in the preview (monitor never read tracks); re-track dropped constraints; no clip blur effect existed anywhere ("blur a face" impossible); resume failed with staging_exists; re-running Remove background stacked a second matte; pack services refused project-relative media; watchdog counted the worker's own scratch (security change — under review); no STALE after relink; sidebar refused the second of two diffs; a wrong refusal message

- AM2.7 (6568a21b…279d76a5): measured CIELAB colour + SigLIP must agree; new route /masking/crop-colour (MO-20 to confirm)

- BR4.15 (203387ec), BR4.16 (8ac6e2a4), AM2.6 (f4aae974): open-time broken-matte state; hardened matte decode; colour re-rank on real weights + cost fix. CI green run 35409455625

- MK6.4 (9463fef8, 57358449): Apple Silicon monitor now converts YUV→RGB like the export host (was up to 3 levels off on every same-size clip); oracle 297/297 on Metal; baseline keyed by renderer class; CI green run 35397473824. BR2.8 done too: every export decode uses MoviePy's ffmpeg; VFR rows pixel-identical on Metal; CI green run 35403245700

- MK9 (d6d82c20…037832c7): adjustment-lane masks + frame-space clip masks end to end; edge styles outline/glow/shadow (engine numpy + preview shaders, byte-exact vectors); AI `style_cutout_edge` (+5 tokens/request). Follow-up MK9.4: nothing sets `space: 'frame'` on a clip mask yet
- BR6.10–6.12 (4ab1a39d…d1871279): Edge brush end to end, object hover highlight via subject.segment_frame, JobsPanel in the right rail. I gated the hover latency budget behind FRAMEPILOT_RUN_PERF (e88e4a9e) after it timed out under coverage (p95 44.7 ms locally, budget 100 ms)

- PX5.6–PX5.9 (b0de2027…6056250c): key oracle rows, the perf-run hang (dev-server hot reload mid-run), soft-matte alpha tier, the approved `/mattes/monitor-tier` route + host call. Oracle 65/65 (run 35344378923). Note: 09f7eb3d swept in two uncommitted MK8 fixes to layer-compositor.ts / layer-preview-engine.ts — correct code, wrong attribution
- MK8 (75f3991d…71f046a8): split/mirror/gradient, `layer` kind (track matte, text as mask), shape presets, oracle rows + goldens; AI `create_shape_mask` and `mask_with_layer` live. I fixed two CI reds after the agent stopped: `points` renamed to `count` so the vertex-list audit stays strict (059fd942), and create_shape_mask's missing mutation contract (d28c421e)

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

- none open: run 35403245700 at 87547198 green on every job

- Local run on the M1 Pro (maintainer allowed local tests 2026-09-19): build ✓, E2E smoke 99/99 ✓, rendered proofs ✓, oracle 291 ✓ with the sidecar; real-GPU finding turned out to be a colour-converter mismatch between the arm64 export build and the monitor on every same-size clip → fixed in MK6.4 (297/297 on Metal). Also fixed: ffmpeg 8.1 refuses the flat VFR setpts chain (3edf4cd3)

- "Masking end to end" green in run 35381220944 (80cc9bf6) after fixes: E2E.5 was a spec bug (playhead off the clip); E2E.2 found two product bugs — relative media paths resolved against the app cwd so every reopened matte read STALE (971fb714), and a deleted matte showed no BROKEN until export refused (80cc9bf6). E2E.5's keyframed case was a real one-ulp legacy-migration miss → fixed by MK2.5 (legacySpec; MO-19 asks the maintainer to confirm the field)

- none open (run 35351484628 at 6b77de0e: 12/12 green)

- save-budget.perf.test.ts failed once at 252.7 ms vs 250 ms (dispatch run 35332745167); passed on the same commit in the PR run — watch for a flake


- none open (run 35304699655 at 2dde0422: 11/11 green)
- (earlier) none open (run 35285412166 at c46d104d: 11/11 green)
- Tip: `gh workflow run CI --ref plan/background-removal-ai` lands in a different concurrency group than PR pushes, so long jobs aren't cancelled by peers' pushes

- Run 35174495193 (3f4c2029): ai-sdk repeated-failure.test.ts v21 mask fixture → fixed 41af6255; Python test_mask_render_golden.py 10 cases block-mean drift 1.2–4.3 on ubuntu (codec, not mask) → fixed b532e432 (numpy lossless source; testsrc2 differs between ffmpeg 7.1/8.1); CI run 35185364341 Python ✓ vectors ✓, TS + oracle pending

- Frequent pushes cancel long CI jobs (concurrency cancel-in-progress); a full green run needs a quiet window. Vector jobs green on 9fcb2496 (macOS + Windows).

- 2faef783: ai-sdk typecheck (AddMaskOp `shape`/`keyframes` readers) — fix expected in 5154492b; re-check
- Note: the Claude Code process restarted twice; agents resumed via SendMessage, their on-disk work survived

## Gate numbers

- BR7.5 (it14, linux-x64 2048²): stabilisation now helps on 8/10 categories (was hurting on 7) but dtSSD ≥ 30% unreachable; box-as-second-prompt kept; subject-crop pass reverted (worse on calibration). Root cause of the remaining misses: soft ground-truth alpha in motion blur — needs a model outside the decided set → MO-22

- MK7.5/MK7.7 real texture (local darwin-arm64): all 15 rows ✓ (night perspective 0.461 px), drift 0.11 px ✓, confidence recall 28/28 ✓, correction 4/4 ✓ (was 0/5)

- MK7.5 real texture (local darwin-arm64): 14/15 rows ✓ (night perspective CRF28 0.522 px ✗ vs 0.5); drift 0.022 px ✓; confidence recall 92/92 ✓ (was 0%); correction 0/5 ✗; tracking cost now 30–50 ms/720p frame (plane), ~100 ms (shape) — measured, not budgeted

- BR7.4 final (linux-x64 CPU, 2048², scored split; it0 → final): mean IoU 2/10 → 5/10 categories ≥ 0.98 (worst 0.807 → 0.903 crossing) ✗; BF@2px 2/10 → 4/10 ✗; leak 58% → 21% ✗; recall 99.2% → 100% (Wilson low 97.4%) ~; review load 87.5% → 79% ✗; fg ΔE 8.8 → 6.7 ✗; one-click worst 0.50 → 0.856 ✗; hair band SAD/Grad ✓; dtSSD ✗ (stabilisation adds error on 7/10); correction 2/4 ✗; locked frames 4/4 ✓; alignment 320/320 ✓

- AM2.7 colour on REAL weights: held-out 144/144 (neutrals 52/52), 0 unnecessary asks, 0 wrong of 432 ✓; SigLIP alone 109/144. AM5 all gates pass (run 35415319600)

- AM2.6 colour re-rank on REAL SigLIP 2 weights (M1 Pro, 144 generated crops + 3 real): 0 wrong picks on 432 absent-colour requests (held-out set too) ✓; targets resolved 116/144 = 80.6% ✗ for the AM5 accuracy/unnecessary-ask gates — chromatic colours 101/101, neutrals (white/grey/black/silver) 15/43. The synthetic AM5 eval still passes all five gates; the real-weights colour subset does not

- PX5.11 full 3-minute Scale export (ubuntu CI, run 35369857493): 1.322× wall, 1.311× CPU ✓ (gate ≤ 1.5×); no M-series full-row number

- BR7.3 (construction-true pilot, CPU, BiRefNet 1024²): mean IoU 8/10 categories below 0.98 (worst low_light 0.811) ✗; BF@2px 9/10 below 0.95 ✗; leak rate 50% ✗ (≤ 0.5%); error-detection recall 99.1% held out ✗ (≥ 99.5%); review load 87.2% ✗; locked frames bit-identical ✓ (1 sample); frame alignment 320/320 ✓; one-click, correction convergence, band/stabilisation ablations, foreground ΔE: not measured (local memory)
- PX5.4: export ratio 1.32–1.45× on CI 4 s windows ✓ (was 1.56×); full row not measured
- PX5.5: composites per presented frame 1.00 (was 1.50–1.70)
- Oracle 72/72 (run 35366379149)

- Oracle 65/65 at unchanged gates (run 35344378923): incl. key rows (worst 73.66 dB with despill) and MK8 rows
- PX5.9 desktop matte path: load 6–7 → 1–2/601 dropped, both budgets ✓ in 4/4; load 12–18 → dropped > 1% in 3/4 ✗, seek < 100 ms in 8/8 ✓

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
