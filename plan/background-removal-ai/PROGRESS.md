# Progress (resume state)

Read this first after a context reset. Updated after every commit.

- **PR:** #124, branch `plan/background-removal-ai`, worktree `../FramePilot-background-removal`. One PR; commits prefixed with task ids; no attribution trailers; no `git add -A`, no `git stash`.
- **Verification:** targeted test files locally; full suites run in CI on the PR head SHA.
- **Memory rule (2026-09-16 incident: >70 GB, machine shut down):** Playwright, the PX4 oracle and engine-frame generation run ONLY in CI (read artifacts via `gh run download`). Local heavy jobs (BR0 models) one at a time, 1 worker, RSS watchdog ≈ 10 GB. Vitest single file, no file parallelism.

## Current

- PX2 — N-layer WebGL compositor until the oracle passes (agent)
- MK2 golden fix — codec-independent mask goldens (render-debugger)
- BR3 — Smart Mask worker scaffold + pipeline with injected backend (agent)

## Done

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

- Run 35174495193 (3f4c2029): ai-sdk repeated-failure.test.ts v21 mask fixture → fixed 41af6255; Python test_mask_render_golden.py 10 cases block-mean drift 1.2–4.3 on ubuntu (codec, not mask) → MK2 agent making goldens codec-independent

- Frequent pushes cancel long CI jobs (concurrency cancel-in-progress); a full green run needs a quiet window. Vector jobs green on 9fcb2496 (macOS + Windows).

- 2faef783: ai-sdk typecheck (AddMaskOp `shape`/`keyframes` readers) — fix expected in 5154492b; re-check
- Note: the Claude Code process restarted twice; agents resumed via SendMessage, their on-disk work survived

## Gate numbers

- PX4 oracle (CI run 35172331641): 43/48 cases pass, all on the layer compositor; remaining: mask stack (MK3), matte row (needs synthetic artifact → then BR5), 3 text rows PSNR 37.0–39.8 dB (glyph hinting; fix = sidecar Pillow text raster on desktop, gate unchanged). Compositor colour error 0/255 on all four encodings

- BR0 (BR0-FINDINGS.md): SAM CPU fp32 ✓ 0.99954; SAM fp16s ✗ 0.99832 → fp32; SAM CoreML disabled (decoder build error, 8.4 GB memory attention); BiRefNet CPU @768² fp32 ✓ (mean 0.0007/255) fp16s ✓ (mean 0.0047/255, max 0.108/255); @2048² not measured (12 GB > budget, MO-13); pilot mean IoU 0.006–0.967 ✗ (pipeline bugs → BR3.15); recall/review load NOT demonstrated (100%/100%); pack ≈ 1.47 GB (fp32 SAM); 1080p30 ≈ 520 compute-s/footage-s at 1024² CPU, ≈ 1,210 at 2048²; FFV1 1080p30 matte 23.2 + fg 81.4 MiB/min

- MK2 ✓: coverage vs 256× supersample max 0.0023 (≤1/255) on all 36 cases incl. self-crossing; vs exact clipping 2.3e-5; distance feather straight 0 / circle 0.00133 / per-vertex 0; path interpolation ≤1e-6; legacy migration 15/15 byte-identical at every 30 fps frame (migrated animated masks carry per-frame keyframes); vectors byte-equal macOS arm64 + Windows x64 + Linux
- BR0 SAM 2.1 ONNX CPU fp32 min per-frame IoU 0.99954 ✓; fp16-stored 0.99832 ✗ → SAM ships fp32 by rule; CoreML: decoder module fails to build (EP disabled for it), image encoder 422 s cold prepare
- PX4 baseline (CI run 35140382484): 43 cases/184 samples, 1 passes; 25 renderer: DOM; 17 WebCodecs fail (pixels 17, pts 9, sentinel 7)
- PX0.3 colour (SwiftShader): BT.601 limited max err 2/255 canvas2d & WebGL (see PX0-INVENTORY for all four encodings)
- Memory: SAM parity run reached 16 GB footprint (killed 2026-09-17); BR0 bounding it
