# Codex Handoff — Professional Editor P0–P3 Closure

**Date:** 2026-08-14

**Repository:** `/Users/rjach/Stuffs/FramePilot`

**Branch:** `codex/professional-editor-control-plane`

**Remote:** `origin/codex/professional-editor-control-plane`

**HEAD when this handoff was written:** `13f957d` (14 slices after `87109f4`)

## 0. What changed on 2026-08-14

C4 automatic tracking is built end to end and C5 has its measurable foundation.

- **Tracking Lite pack is real** (`workers/tracking-lite/`): LK point flow, CSRT region with
  appearance-measured confidence, homography planar. Bounded freeze-then-`target_lost` occlusion
  policy — it never extrapolates motion it did not observe. 61 unit tests with an injectable backend
  (no CV stack needed) plus 9 decoded-media pixel proofs with wrong-trajectory controls.
- **Supply chain**: exact `uv.lock` (opencv-contrib-python-headless 5.0.0.93, numpy 2.5.2 with wheel
  digests), generated `LICENSES.md`/CycloneDX SBOM with a drift check that verifies bundled natives
  against the wheel's own notice, `pack/manifest.toml`, and a separate pack CI workflow.
  **CSRT requires contrib** — verified against real wheels; the main wheel has no `TrackerCSRT`.
  The pack redistributes **LGPL-2.1** binaries; the catalog record must disclose that and a source
  offer before a user approves a download.
- **Desktop authority → IPC → controller → patch**: pack resolution with lease, revision check,
  typed outcomes, install proposal; validated IPC where the renderer names an asset, never a path;
  automatic-tracking resolver; deterministic sample→keyframe policy; `apply_tracked_mask`.
- **Consumers**: transform follow, graphics attachment (follow on a graphics clip), tracked colour
  mask (the mask `apply_tracked_mask` keyframes), automatic reframe derived from the render
  compiler's own `base_scale`/`position_at` formula.
- **Render parity is proven, not claimed**: `engine/python/tests/test_render_track_parity.py`
  measures decoded pixels for position, scale and opacity, each with a negative control.
- **Eval media is content coded**: the bridge stages colour bands plus a block whose position is a
  formula in `t`, replacing flat colour fills that made pixel measurement impossible.
- **Release gate strengthened**: the rendered scorecard requires every _available_ capability to be
  verified, and any exempt row to be openly unsupported with a reason.

Three traps found the hard way, all documented in place: appearance confidence collapsing on
sub-pixel misalignment; a centroid clipped at the frame edge halving measured travel; and `drawbox`
position expressions silently drawing nothing on ffmpeg 8.x — a fixture that fails open.

**Blocked on the user, not on effort:** (1) Subject Intelligence needs a model/licence/size decision
before face/object/segmentation can start; (2) C6 needs signing credentials, publication
infrastructure and clean machines. Everything else in C5 is unblocked — see the closure plan, which
is current.

Read this file first, then read:

1. `AGENTS.md`
2. `plan/PLAN.md`
3. `plan/PROFESSIONAL-EDITOR-P0-P3-CLOSURE.md` — current source of truth
4. `plan/PROFESSIONAL-EDITOR-CONTROL-PLANE.md` — original architecture/history
5. `docs/adr/0114-on-demand-capability-packs.md`
6. `docs/api/capability-packs.md`
7. `docs/api/capability-pack-worker.md`

Do not restart the work or reinterpret green unit tests as end-to-end completion.

## 1. Original objective

The user wants FramePilot's editing agent to operate like a real professional editor, end to end,
through the following original priority stack:

- **P0:** `EditorInteractionContext`, `TargetResolver`, semantic `EditorCommand` / EditIR, and
  deterministic professional edit compilers (roll/slip/slide/insert/overwrite/etc.).
- **P1:** one execution graph for every route, a capability/property registry, domain-owned tools,
  and a temporal/perceptual reviewer that can actually inspect the edit.
- **P2:** professional timeline, motion/keyframe, color, tracking/mask, and audio controllers.
- **P3:** an operation eval suite that proves real capability rather than demos or metadata.

The final acceptance path is:

```text
live editor state
  -> deterministic target resolution
  -> semantic command
  -> validated reversible patch
  -> durable unified run
  -> rendered technical + perceptual evidence
  -> commit or bounded repair
  -> save/reload/replay/undo
  -> cross-host proof
```

The user asked the agent to take senior engineering, product, CEO, and architecture ownership; to
think laterally like an editor; to avoid vague cosmetic UI/architecture; and to create a branch,
commit, and push every completed slice.

### Product decisions made with the user

- Initial platforms: **Apple Silicon macOS** and **Windows x64**.
- Local-first hybrid. Core edit/open/render/export never requires cloud access.
- Heavy ML/CV/model/runtime payloads must work like Premiere/CapCut: **signed on-demand downloads**,
  never bundled into the first installer.
- Projects pin the exact immutable capability-pack identity. Versions install side by side.
- No silent download, update, eviction, or media egress. All require explicit user consent.
- Base app contains the pack catalog/verifier/installer/launcher, not optional payloads.
- Pending user answer: whether the default catalog may include copyleft/restricted components.
  Continue with the recommended **commercially permissive default catalog** unless the user says
  otherwise. Record transitive licenses accurately; OpenCV wheels include LGPL FFmpeg components.

## 2. Non-negotiable repository constraints

The five `AGENTS.md` invariants still govern everything:

1. Never mutate/delete original media.
2. Every AI edit is a typed operation.
3. Validate every operation before apply.
4. Validate every render.
5. AI edits only through registered schema-validated tools that return reversible patches, with
   human control.

Additional constraints:

- Use `apply_patch` for edits.
- Read/update `plan/PLAN.md`, the closure plan, docs, and `CHANGELOG.md` with behavior changes.
- Add migrations for persisted schema changes.
- Test apply **and** invert for operations.
- Never add a dependency without license review.
- Never silently install a large local OpenCV/model dependency merely to run a test. Ask first or
  isolate it in the pack build CI job.
- Keep the frozen MoviePy/FFmpeg render engine separate from the real-time browser preview.
- Use conventional commits and push each completed slice.

## 3. Current Git state and ownership boundary

At handoff creation the branch and remote were aligned at `c777764`.

The worktree has these **unrelated concurrent/user-owned changes**:

```text
 M engine/python/framepilot_engine/render/frame_grab.py
 M engine/python/framepilot_engine/render/pipeline.py
 M engine/python/framepilot_engine/validation/temporal_evidence.py
?? engine/python/framepilot_engine/render/resources.py
?? engine/python/tests/test_render_resources.py
```

These files were not authored by this workstream. Do not stage, modify, revert, or claim them. They
may overlap C5 render evidence, so inspect before touching and coordinate rather than overwriting.

No uncommitted professional-control-plane change existed when this handoff was written.

## 4. Architecture and completed work

The branch is large (82 commits after `main`). Trust the plans and tests over a summary, but the
major completed slices are below.

### P0 interaction, resolution, and professional commands — complete

Important locations:

- `packages/ai-sdk/src/editor-context/interaction-context.ts`
- `packages/ai-sdk/src/editor-context/target-resolver.ts`
- `packages/shared-types/src/ipc.ts`
- `packages/editor-core/src/professional-commands.ts`
- `packages/ai-sdk/src/controllers/timeline-controller.ts`
- `packages/ai-sdk/src/domain-tools/professional-edit.ts`
- `packages/ai-sdk/src/domain-tools/professional-batch.ts`

Implemented:

- Ephemeral revision-stamped editor context with selection, playhead, selected effects/keyframes/
  masks/transitions, source-monitor state, ranges, visible clips, and recent references.
- Pure resolver returning `resolved | ambiguous | unresolved`; no silent tie-breaking.
- Roll, slip, slide, ripple trim, lift, extract, insert, overwrite, replace, J-cut, and L-cut
  semantic compilers.
- Host-authoritative project revision is now threaded into every professional controller. A project
  change fails stale even if timeline revision did not move.
- Multi-command domain tools assemble and validate one combined patch and exact inverse rather than
  compiling unrelated operations against the same stale input.
- Browser/desktop capture and Electron validation of interaction state.

Do not let the model calculate primitive choreography or accept unresolved referents.

### P1 capability registry and domain tools — complete

Important locations:

- `packages/ai-sdk/src/editor-capabilities.ts`
- `packages/ai-sdk/src/editor-capability-pack-dependencies.ts`
- `packages/ai-sdk/src/domain-tools/`
- `packages/ai-sdk/src/tool-registry.ts`

The editor is introspectable by capability/property, with bounds, units, keyframeability,
compiler/verifier/inverse facts, availability, and generated pack dependencies. The monolithic tool
registry was split into timeline, media, motion, color, tracking/mask, audio, captions, graphics,
project, and verification ownership while preserving one public manifest.

### P1 unified execution and durability — complete for declared host policy

Important locations:

- `packages/ai-sdk/src/kernel/editor-run-lifecycle.ts`
- `packages/ai-sdk/src/kernel/editor-run-projection.ts`
- `packages/ai-sdk/src/run-store.ts`
- `packages/ai-sdk/src/orchestrator.ts`
- `apps/desktop/electron/ai/`
- `apps/web-editor/src/editor/browser-run-store.ts`
- `apps/web-editor/src/editor/browser-run-recorder.ts`
- `apps/web-editor/src/editor/ai.ts`
- `packages/mcp-server/src/cross-host-parity.test.ts`

Implemented:

- Shared lifecycle for edit/recipe/planned-edit/agent/auto.
- Desktop WAL and browser IndexedDB with bounded localStorage fallback, quarantine and recovery.
- Interrupted recovery never re-emits a patch.
- Patch proposal accept/reject is persisted idempotently.
- Desktop patch replay is idempotent by patch identity; conflicting reuse is rejected.
- Missing/unavailable temporal review creates only an unverified human-review proposal.
- Auto-commit requires a positive verified disposition; reviewer outage cannot persist an edit.
- Desktop recipe/planned-edit route through main-process authority.
- MCP parity is intentionally scoped: portable explicit commands work, interaction-dependent
  `hostUiOnly` commands return typed refusal.

Recent commits: `cd924fe`, `ae59ded`.

### P2 controllers — deterministic/manual portion implemented

Important locations:

- `packages/ai-sdk/src/controllers/{timeline,motion,color,tracking-mask,audio}-controller.ts`
- `packages/editor-core/src/{professional,motion,color,tracking-mask,audio}-commands.ts`
- `engine/python/framepilot_engine/validation/temporal_evidence.py`
- `engine/python/tests/test_professional_objective_fixtures.py`

Timeline, motion, color, manual existing-mask tracking, and audio semantic controllers exist with
typed reversible patches. Audio includes roles, ducking, EQ, compression, fades/level rides and
loudness evidence. Color includes measured match-reference, camera grouping, skin protection and
caption-isolated scope measurement. Multicam angle groups exist in schema v18.

This does **not** mean original P2 is complete: automatic point/region/planar tracking,
face/object detection, segmentation, and all tracked consumers remain C4.

### Production temporal and semantic reviewer — partially complete

Important locations:

- `packages/ai-sdk/src/temporal-review.ts`
- `packages/ai-sdk/src/temporal-evidence-client.ts`
- `packages/ai-sdk/src/vision-review.ts`
- `packages/ai-sdk/src/vision-objective-planner.ts`
- `packages/ai-sdk/src/vision-evidence-client.ts`
- `packages/ai-sdk/src/vision-judge.ts`
- `packages/ai-sdk/src/orchestrator.ts`
- `apps/desktop/electron/ai/ai-stream.ts`

Commit `531afd8` connected semantic review to normal production runs:

- Semantic objectives are generated only where pixels/meaning are required: motion/framing, crop,
  mask/tracking, and transitions. Generic “looks good” audio/color prompts are intentionally not
  used as objective verification.
- Evidence is acquired from the real `/render/frame` route against the unsaved edited working copy.
- A clamped/wrong moment is rejected; frame dimension is bounded to 512.
- One bounded multimodal provider call returns a strict JSON verdict; no retries.
- Evidence lineage records transport, provider/model, prompt, pack, consent, request, frame and
  decision identities.
- Cloud review is blocked before frame acquisition without explicit timestamped media-egress
  consent. Local review requires an exact pack version.
- `cannot_tell`, malformed response, cancellation, or unavailability stays unverified/failing.
- Deterministic evidence is authoritative; vision cannot rescue a deterministic failure.

Still missing: a real local Subject Intelligence/vision pack and final host integration tests that
prove every failure disposition prevents auto-commit.

### On-demand capability-pack platform — core platform largely complete

Important locations:

- `packages/capability-packs/src/contracts.ts`
- `packages/capability-packs/src/install-contracts.ts`
- `packages/capability-packs/src/node/`
- `apps/desktop/electron/capability-packs/`
- `apps/web-editor/src/components/CapabilityPackDependencyDialog.tsx`
- `apps/web-editor/src/components/CapabilityPackStorageSettings.tsx`
- `packages/timeline-schema/src/` (schema v19 dependency pins)
- `docs/adr/0114-on-demand-capability-packs.md`
- `docs/api/capability-packs.md`

Implemented:

- Offline-root Ed25519 signed catalogs, delegated key rotation/revocation, rollback protection.
- Immutable release and platform artifact identities with SHA-256.
- Explicit approval, resumable HTTPS download, deduplication, free-space/size/hash checks.
- Safe staging/extraction with path/symlink/duplicate/expansion/file-count bounds.
- macOS Team ID / Windows certificate identity verification.
- Exact worker health handshake.
- Atomic install/index commit, quarantine and interrupted recovery.
- Crash-safe storage, project pins, leases, side-by-side versions and two-phase removal.
- Exact accounting, cleanup proposal/recheck, custom storage relocation and recovery.
- Validated Electron IPC/preload surface and real Settings > Storage flow.
- Project-open missing-dependency dialog with Download / Locate / Cloud / Degraded contract; only
  Download and Degraded are substantially wired today.
- Local Whisper routes through the common installer and is excluded from the base engine helper
  discovery; only healthy pack-owned CLI/model paths enter the sidecar.
- Offline release tooling derives artifact/SBOM facts, enforces license and immutable URL policy,
  signs exact catalogs and emits publication/rollback plans.

Still missing: verified Locate adoption, executable catalog cloud alternatives, invocation-time
interception, real signed Whisper artifacts, and platform build/sign/publish jobs.

### Isolated worker protocol and client — complete foundation

Important locations:

- `packages/capability-packs/src/worker-protocol.ts`
- `packages/capability-packs/src/node/worker-client.ts`
- `packages/capability-packs/src/node/worker-health.ts`
- `docs/api/capability-pack-worker.md`

Commits `3c0a79f`, `bf4987d`, and `c777764` implemented:

- Versioned length-bounded JSON Lines protocol for `tracking.point`, `tracking.region`,
  `tracking.planar`, `subject.detect`, and `subject.segment`.
- Host-resolved read-only media handles, frame/source bounds and project revision.
- Normalized in-frame geometry, progress, confidence/occlusion, detections, COCO-style RLE masks,
  backend/model digests and typed failures.
- One-shot process client with `realpath` media sandboxing, no shell, minimal environment/no secrets,
  request/revision/capability matching, bounded stdout/stderr, timeout and cancellation.
- Health-check identity is passed from the signed installer environment and echoed by the already
  verified worker. This avoids the impossible circular requirement to embed the final artifact
  digest inside the artifact before hashing it.

There is no real CV worker artifact yet.

## 5. Current verification evidence

Last known focused results, not a claim that release CI is currently green:

- AI SDK full suite after semantic reviewer: **3113/3113 passed**, one rendered suite skipped by
  environment/opt-in design.
- AI SDK typecheck/lint: green.
- Desktop typecheck/lint and focused AI stream/coordinator tests: green.
- Web editor typecheck/lint: green.
- Capability-pack suite after process client: **99/99 passed**; health-handshake fix tests green.
- Focused editor-core professional/motion/color/tracking/audio compiler suites: **71/71 passed**.
- Focused AI resolver/domain/eval suites: **133/133 passed** at the audit point.
- Focused Python temporal/professional objective suites: **19/19 passed**.
- `git diff --check` was green at the audit point.

Do not quote these as clean-machine, signed-installer, or rendered 33-row proof. Run affected tests
after every edit and the complete gates only at C6.

## 6. What is not finished

### P0 — blocking the original promise

#### A. Build the real Tracking Lite pack (immediate next slice)

Create a separately packaged worker project, suggested location `workers/tracking-lite/`. It must
not be a workspace dependency of Electron or the base Python engine.

Recommended implementation:

- Standalone Python worker, own exact lock and build manifest.
- Target a self-contained CPython runtime per platform; choose and document Python compatibility
  before locking NumPy/OpenCV.
- Region tracking: OpenCV CSRT with appearance/template-derived confidence. Do not map a boolean
  tracker status to fake confidence.
- Point tracking: pyramidal Lucas–Kanade flow with bounded error-derived confidence.
- Planar tracking: ordered feature points + LK + homography, confidence from inlier ratio and flow
  error.
- Determinism: one OpenCV thread, fixed RNG seed, stable output ordering.
- Explicit occlusion/lost-target policy. Never continue a plausible trajectory after loss.
- Constant actual capability roster: point, region, planar.
- Health mode reads trusted identity env set by the installer, refuses capability mismatch, and
  reports actual backend plus empty model digests (Tracking Lite has no weights).
- Runtime reads the request line, emits bounded progress and exactly one typed terminal result or
  failure, and honors cancellation input/signals.
- Network must remain disabled and the worker has no project-write authority.

Current official-package research (recheck before pinning because it is time-sensitive):

- `opencv-contrib-python-headless` PyPI showed `5.0.0.93` on 2026-07-02; macOS arm64 and Windows x64
  wheels were roughly 54–56 MiB before a Python runtime. Project page:
  `https://pypi.org/project/opencv-contrib-python-headless/`.
- NumPy PyPI showed `2.5.1` requiring Python >=3.12. Project page:
  `https://pypi.org/project/numpy/`.

Do not silently install these locally. Pure algorithm/protocol tests can use injected fake frames;
a separate pack CI/build job should install and run real decoded-media tests. Ask the user before a
large local sync.

#### B. Wire Tracking Lite through the desktop authority

- Resolve the exact healthy installed pack through `CapabilityPackDesktopService`.
- Acquire a storage lease for the worker lifetime.
- Resolve and validate media path/revision in desktop main.
- Invoke the signed entrypoint with `runCapabilityPackWorker`.
- Convert worker results through smoothing/gap/confidence policy into a typed controller command and
  exact reversible patch; never mutate the project in the worker.
- If missing, return the exact install proposal instead of pretending tracking exists.
- Prove cancellation, worker crash, stale revision and pack removal/lease interactions.

#### C. Finish automatic tracking semantics and consumers

- Resolver/controller targets: point, bounded region, planar, face, object and segmentation.
- Deterministic smoothing, maximum correction, confidence threshold and gap/occlusion rules.
- Subject Intelligence pack for face/object detection and segmentation.
- Consumers: transform follow, local color mask, attached graphics and automatic reframe.
- Preview/render parity for generated tracks/masks. Metadata-only success is forbidden.

#### D. Finish local semantic vision review

Implement the Subject Intelligence/local vision capability pack and connect it to
`VisionRunReviewControls`. Cloud alternatives remain explicit-consent only. Add host-level tests for
unavailable, malformed, cannot-tell and cancelled review under `auto_commit`; no case may persist the
patch.

#### E. Close P3 with real rendered evidence

Current deterministic scorecard deliberately asserts **33 passed, 0 render-verified** in
`packages/ai-sdk/src/professional-evals.cases.test.ts`. That is honest and incomplete.

Existing fixes to preserve:

- `runProfessionalEvalCase` now acquires against `evidence.persistedProject`, not the pre-edit fixture.
- A one-shot TS-to-Python acquirer exists in
  `packages/ai-sdk/src/professional-eval-node-acquirer.ts` and Python bridge code exists in
  `engine/python/framepilot_engine/validation/professional_eval_bridge.py`.
- The opt-in rendered test requires `verified === total`.

Remaining work:

- Replace fake paths (`hero.mp4`, `music.wav`, etc.) with shared content-coded synthetic media.
- Route every row through the real controller/target resolution path, not hard-coded IDs.
- Define an intent/property/variant roster independent of the capability count.
- Add pixel proofs and plausible negative controls:
  - motion x/y/scale/rotation/opacity, easing, continuation and cover bounds;
  - all color properties, match reference, grouping, skin hold and caption-isolated scopes;
  - actual tracking/mask pixels and wrong target/trajectory;
  - audio fade-out, normalize, role ducking, EQ, compression, automation, long-window loudness and
    discontinuity;
  - multi-target linked A/V and group batch apply/invert/save/reload/cross-host behavior.
- Split scope acquisition from caption-burned visual acquisition. A mixed batch must not contaminate
  scopes with captions.
- Require `verified === registered` in release CI. Missing ffmpeg/uv may report unavailable in
  ordinary local tests, but release mode must fail.

Audit caveat: Python motion evidence currently derives trajectory from stored keyframes rather than
rendered pixels, and tracking-only evidence can render no frames. Do not call those render proofs.

#### F. Finish capability-pack product and release integration

- Locate-existing verified adoption.
- Catalog-declared cloud alternatives that are only offered when executable.
- Invocation-time missing-capability interception.
- Real macOS arm64/Windows x64 Whisper and Tracking Lite artifacts/catalog/SBOM rows.
- Worker build, code-signing/notarization/AuthentiCode and immutable CDN publication/rollback jobs.
- Project transfer/missing-pack/open-degraded/offline recovery tests.
- Enforce base-installer pack-payload absence and <=10 MiB platform overhead.

### P1 — required before merge/release closure

- Fill user-reachable rejection-path tests still absent from the audit (missing clip/track/asset,
  non-adjacent/different tracks, short media, wrong track kind, empty target, unaligned linked cut,
  ambiguous mask/region). Recheck current tests first; some may have landed after the audit.
- Strengthen MCP/cross-host wording and tests so they do not imply interactive professional command
  parity where the contract intentionally returns `host_ui_only`.
- Reconcile stale documentation only after behavior lands; in particular temporal-evidence docs
  previously understated role evidence and overstated vision completion.

### P2 — release hardening

- Clean-machine macOS arm64 and Windows x64 signed installer tests.
- Offline edit/render, on-demand install, transfer, rollback, uninstall and disaster recovery.
- Full typecheck/lint/unit/coverage/e2e/Python ruff+mypy+coverage/license/build/render-fixture gates.
- Release CI must render and validate a real fixture; `--help` is not a render smoke.
- No disabled functional/visual E2E or optional desktop build in the final release gate.

## 7. Risks and traps

- The current unrelated render changes overlap the next rendered-evidence work. Preserve them.
- `runCapabilityPackWorker` leaves stdin open so a cancel line can arrive; a real worker must process
  input concurrently rather than waiting for EOF.
- The existing cancellation unit test may abort before spawn during `realpath`. Add an explicit
  spawned-process cancel test when wiring the real worker.
- The worker environment intentionally omits `HOME` and arbitrary loader variables. A self-contained
  signed executable is preferred; add only explicit, reviewed runtime variables.
- Scope evidence and caption-burned frame evidence cannot share one composition mode.
- Vision is advisory only where deterministic measurement cannot settle the semantic objective; it
  cannot override a failed technical check.
- Do not count schema keyframes or track metadata as proof that the renderer moved/masked pixels.
- Golden fixtures are generated from built `dist`; build the package before regenerating them.
- Never make an unavailable reviewer drop a proposed edit or auto-commit it. It must remain a clear
  unverified review proposal.

## 8. Recommended next-session sequence

1. Read the files listed at the top and run `git status --short`.
2. Confirm the unrelated render-file ownership boundary remains unchanged.
3. Ask/confirm the pending default-catalog license policy if the user has not answered. Proceed
   permissive-only by default.
4. Inspect `worker-protocol.ts`, `worker-client.ts`, `worker-health.ts`, and desktop capability-pack
   service before editing.
5. Add `workers/tracking-lite/` as a separate artifact project with no base-app dependency.
6. Implement and unit-test health/runtime parsing and deterministic tracking behind an injectable
   backend. Do not install OpenCV without consent.
7. Commit and push that self-contained slice.
8. Add the separate platform pack build/test workflow, exact lock, licenses and SBOM; commit/push.
9. Wire desktop invocation/lease/controller patch path with missing-pack proposal and end-to-end
   synthetic moving-subject tests; commit/push.
10. Continue C4 consumers, then C3 local vision, C5 real rendered evals, C1 signed artifacts, and C6
    release proof in that order.

After each slice update `plan/PLAN.md`, `plan/PROFESSIONAL-EDITOR-P0-P3-CLOSURE.md`, docs and
`CHANGELOG.md`. Never mark a checkbox complete without the relevant production-path proof.

## 9. Useful branch landmarks

Recent commits, newest first:

```text
c777764 fix: make worker identity handshake publishable
bf4987d feat: run capability workers safely
3c0a79f feat: define capability worker protocol
531afd8 feat: gate semantic edits on vision review
ae59ded test: close unified execution durability
cd924fe fix: make accepted patch replay idempotent
181fa86 docs: define mcp professional command boundary
d1533aa test: cover browser durable mutation routes
5470321 feat: recover interrupted browser editor runs
700464a feat: persist browser editor run lifecycle
39d4389 feat: add browser durable run storage
00949e1 refactor: move durable run store into ai sdk
4f134e1 feat: add capability pack release tooling
6814193 feat: move local whisper to capability packs
ae57fae feat: reconcile project capability dependencies
```

Use `git log --oneline --reverse main..HEAD` for the full history. Every existing branch commit has
already been pushed. Continue on this branch; do not create a replacement branch unless the user
explicitly asks.
