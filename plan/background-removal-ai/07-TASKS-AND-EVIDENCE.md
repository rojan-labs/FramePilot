# 07 — Tasks and evidence

Each phase is its own PR with one goal (CLAUDE.md: don't bundle subsystems). Mark `[~]` when
starting and `[x]` only when the phase's DoD evidence exists. Commits carry no attribution trailers.

## BR0 — Spike: models, ONNX, licences, throughput `[ ]`

- [ ] BR0.1 Export SAM 2.1 (Hiera-S and B+) video components to ONNX; parity against PyTorch on 3 clips
- [ ] BR0.2 Run on CoreML EP (darwin-arm64) and DirectML EP (win32-x64); record ops that fall back to CPU
- [ ] BR0.3 BiRefNet ONNX at 1024² crop; fused-refinement prototype
- [ ] BR0.4 Matting: ViTMatte vs classical closed-form on the hair category; licence and training-data verdict
- [ ] BR0.5 Throughput table (1080p30, 4K30 × EP) and memory peak; pack size; FFV1 matte size per minute
- [ ] BR0.6 Fallback pipeline (keyframe SAM + BiRefNet + flow) measured if BR0.1/0.2 fail
- [ ] BR0.7 `BR0-FINDINGS.md` + **MD-2 decision recorded** (+ ADR draft `docs/adr/0178-background-removal-pack.md`)

**DoD:** numbers in the findings doc; the maintainer approves the model set, or the plan is revised.

## BR1 — Schema v22 + operations `[ ]` (needs MD-1)

- [ ] BR1.1 `MatteEffectSchema` + Pydantic twin + parity test
- [ ] BR1.2 Migration v21→v22 + round-trip test; fixtures import `SCHEMA_VERSION`
- [ ] BR1.3 Ops `apply_matte` / `update_matte` / `remove_matte` (or reuse generic effect ops) with `apply`+`invert` round-trip tests
- [ ] BR1.4 Validator rules: one per clip, clip kind, coverage (`matte_out_of_coverage` with a stable message and remedy), trim/split/ripple keep the matte valid inside coverage
- [ ] BR1.5 `pnpm schema:generate` + drift tests; ADR for the schema change; docs/api update

**DoD:** editor-core and timeline-schema tests for the touched files pass; CI green on the PR.

## BR2 — Engine render `[ ]`

- [ ] BR2.1 `render/mattes.py` `MatteReader` (pts lookup, sequential cursor, LRU)
- [ ] BR2.2 Pipeline order in `compiler.py`: crop → matte → shape mask → opacity → transform
- [ ] BR2.3 Edge shift / feather with constants mirrored from TS + parity test
- [ ] BR2.4 Typed pre-render refusals (missing, digest, coverage, dimensions)
- [ ] BR2.5 Fixtures: synthetic mattes, VFR, edit list, speed-ramped clip; render golden on a two-track timeline

**DoD:** engine tests for the new modules pass; golden updated in the same PR (plan rule "no render change without a golden update").

## BR3 — Worker pack `[ ]` (after BR0; can run parallel with BR1–BR2)

- [ ] BR3.1 Scaffold `workers/background-removal` mirroring `subject-intelligence` (manifest, lock, SBOM, LICENSES, sandbox, protocol, policy, runtime)
- [ ] BR3.2 Decode with pts (PyAV/ffmpeg); `frames.json`
- [ ] BR3.3 Segment (SAM 2.1 propagation, windowed with overlap), prompts, corrections
- [ ] BR3.4 Refine (BiRefNet crop, guided fusion), matting on the band, temporal stabilisation
- [ ] BR3.5 Confidence scoring and `lowConfidence` ranges
- [ ] BR3.6 Encode FFV1 gray master + VP9 gray preview; enforce the byte ceiling; write only declared names
- [ ] BR3.7 Unit tests with an injected backend; `decoded_media` tests with real weights
- [ ] BR3.8 `scripts/dev-register-background-removal.sh` + entry in `dev-register-all-packs.sh`; health check passes via `register-local`
- [ ] BR3.9 `pnpm license:scan` + hand-reviewed `LICENSES.md`; SBOM `--check`

**DoD:** the pack registers locally, passes its health check, and produces a verified artifact on a real 1-min 1080p clip.

## BR4 — Protocol + desktop host `[ ]` (needs MD-3, MD-4)

- [ ] BR4.1 `subject.matte` request/progress/result/failure schemas + protocol tests (additive-union negotiation)
- [ ] BR4.2 Output handle + staging directory + host verification + atomic rename + orphan sweep
- [ ] BR4.3 `capability-packs/matte.ts` job lifecycle, cancel, stale revision, cache hit
- [ ] BR4.4 Generic `capabilityPackStatus` + `onCapabilityPackInstalled` IPC, preload and shared-types
- [ ] BR4.5 Auto prompt via `subject.detect`, and `needs_prompt` when that pack is absent
- [ ] BR4.6 Storage manager: per-project matte bytes, referenced-set protection, "Clean unused mattes"
- [ ] BR4.7 Project media validation: matte files + digests
- [ ] BR4.8 **security-reviewer** pass on the sandbox broadening; findings fixed or recorded

**DoD:** desktop capability-pack tests for the new files pass; the security review is recorded in the PR.

## BR5 — Preview `[ ]`

- [ ] BR5.1 `clip-matte.ts` pts resolution + decode session for `preview.webm`
- [ ] BR5.2 GL luma→alpha, edge shift and feather passes mirroring the engine
- [ ] BR5.3 BR5a: a matted clip with no overlap is eligible and composited
- [ ] BR5.4 BR5b: a two-layer relation (matted front, opaque back) in `canvasPreviewEligible` + simultaneous decode
- [ ] BR5.5 Matte / Overlay view modes (preview-only state)
- [ ] BR5.6 Parity test against the engine on 5 timestamps; perf check on a 4K 3-min clip (no dropped-frame regression vs an unmatted clip beyond the budget the performance-monitor sets)

**DoD:** the parity test passes; the perf evidence is attached to the PR.

## BR6 — Inspector UX `[ ]`

- [ ] BR6.1 `BackgroundRemovalSection` + `useBackgroundRemoval`, in the Mask tab
- [ ] BR6.2 PACK_MISSING warning with a disabled action + install flow + refresh without restart
- [ ] BR6.3 PACK_UNHEALTHY / UNSUPPORTED_PLATFORM / browser UNAVAILABLE states
- [ ] BR6.4 Auto and click prompts; monitor pick mode (mouse + keyboard)
- [ ] BR6.5 Running progress / ETA / cancel; selection-change survival
- [ ] BR6.6 Applied controls (enable, invert, edge, feather, view, needs-review list, remove); each an undoable patch
- [ ] BR6.7 Corrections → re-run; STALE and BROKEN states matching export validation text
- [ ] BR6.8 Component tests for every state; copy pass (lead-prompt-engineer + unslop); a11y check

**DoD:** component tests pass; screenshots of every state are in the PR.

## BR7 — Precision eval + end-to-end `[ ]`

- [ ] BR7.1 Fixture set + human-labelled keyframes (labels marked human-verified)
- [ ] BR7.2 `eval/run_eval.py` against the installed entrypoint; reports committed for darwin-arm64 and win32-x64
- [ ] BR7.3 All gates in `06` pass, or the plan returns to the maintainer with the numbers
- [ ] BR7.4 Desktop Playwright e2e: pack absent → warning visible and action disabled → install (local registration fixture) → no restart → remove background on a real clip → preview shows the cut-out over the lower clip → export → frame check of the exported pixels → undo removes it
- [ ] BR7.5 Reopen e2e: project with a matte reopens and exports with the pack **uninstalled**; with the matte deleted, the clip shows BROKEN and export refuses with the remedy
- [ ] BR7.6 `docs/guides/background-removal.md`, `CHANGELOG.md`, `MANUAL_TESTING.md` section, public changelog (changelog-maintainer)

**DoD:** eval reports + e2e green in CI on the PR head SHA; `plan/PLAN.md` phase checked.

## BR8 — (Optional, after BR7) AI tool `[ ]`

- [ ] BR8.1 `remove_background` tool in the right `domain-tools/` domain (tool-domains shape test), calling the same host job and emitting `apply_matte`; `pack_missing` reuses `PackInstallInlineCard`
- [ ] BR8.2 Token-golden regeneration (3 commands) and review of the measured delta

Only if the maintainer wants the agent to use it. The Inspector feature is complete without BR8.
