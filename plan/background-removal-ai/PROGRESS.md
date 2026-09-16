# Progress (resume state)

Read this first after a context reset. Updated after every commit.

- **PR:** #124, branch `plan/background-removal-ai`, worktree `../FramePilot-background-removal`. One PR; commits prefixed with task ids; no attribution trailers; no `git add -A`, no `git stash`.
- **Verification:** targeted test files locally; full suites run in CI on the PR head SHA.
- **Memory rule (2026-09-16 incident: >70 GB, machine shut down):** Playwright, the PX4 oracle and engine-frame generation run ONLY in CI (read artifacts via `gh run download`). Local heavy jobs (BR0 models) one at a time, 1 worker, RSS watchdog ≈ 10 GB. Vitest single file, no file parallelism.

## Current

- PX4 — pixel oracle harness (qa-e2e agent), incl. PX0.3 colour measurement and PX0 screenshots
- BR0 — ONNX exports, per-EP parity, verify-stage recall, sizes (general-purpose agent)

## Done

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

## Next

PX0 → PX1 → PX4 → PX2; MK1 → MK2; BR0; RD0.

## CI reds

- Frequent pushes cancel long CI jobs (concurrency cancel-in-progress); a full green run needs a quiet window. Vector jobs green on 9fcb2496 (macOS + Windows).

- 2faef783: ai-sdk typecheck (AddMaskOp `shape`/`keyframes` readers) — fix expected in 5154492b; re-check
- Note: the Claude Code process restarted twice; agents resumed via SendMessage, their on-disk work survived

## Gate numbers

- MK2 ✓: coverage vs 256× supersample max 0.0023 (≤1/255) on all 36 cases incl. self-crossing; vs exact clipping 2.3e-5; distance feather straight 0 / circle 0.00133 / per-vertex 0; path interpolation ≤1e-6; legacy migration 15/15 byte-identical at every 30 fps frame (migrated animated masks carry per-frame keyframes); vectors byte-equal macOS arm64 + Windows x64 + Linux
- BR0 SAM 2.1 ONNX CPU fp32 min per-frame IoU 0.99954 ✓; fp16-stored 0.99832 ✗ → SAM ships fp32 by rule; CoreML: decoder module fails to build (EP disabled for it), image encoder 422 s cold prepare
- PX4 baseline (CI run 35140382484): 43 cases/184 samples, 1 passes; 25 renderer: DOM; 17 WebCodecs fail (pixels 17, pts 9, sentinel 7)
- PX0.3 colour (SwiftShader): BT.601 limited max err 2/255 canvas2d & WebGL (see PX0-INVENTORY for all four encodings)
- Memory: SAM parity run reached 16 GB footprint (killed 2026-09-17); BR0 bounding it
