# Professional Editor P0–P3 End-to-End Closure

**Status:** `[~]` active
**Started:** 2026-08-13
**Branch:** `codex/professional-editor-control-plane`
**Product decisions:** Apple Silicon macOS + Windows x64 first; local-first hybrid;
heavy capabilities download on demand; project dependencies are immutable and version-pinned.

## 1. Completion contract

The original P0–P3 vision is complete only when a professional operation can travel through this
entire path on a shipped desktop build:

```text
live editor interaction
  → deterministic referent resolution
  → semantic EditorCommand
  → validated reversible patch
  → one durable execution lifecycle
  → deterministic render/evidence acquisition
  → objective technical + perceptual review
  → commit or one bounded repair
  → save/reload/replay/undo
  → cross-host transport proof
```

Passing unit tests for one layer, storing plausible metadata, or demonstrating a hand-authored
fixture does not satisfy this contract. Each advertised capability needs an outcome-driven eval
that traverses its production controller and fails a plausible wrong result.

## 2. Product and packaging boundaries

### 2.1 Base desktop application

The installer keeps the pieces required to open, edit, preview, render, validate, and recover every
project without contacting a service:

- Electron shell, web editor, schemas, patch authority, command compilers, and orchestration runtime.
- Frozen deterministic Python render engine, FFmpeg, ffprobe, scopes, waveform, scene/beat analysis,
  and non-ML mask/keyframe evaluation.
- Capability-pack catalog client, verifier, installer, storage index, health checks, and pack-worker
  launcher.
- Cloud-provider connectors, because connector code is small and credentials remain opt-in.

The on-demand system itself may add at most **10 MiB compressed** to the base installer. No model,
ML runtime, sample media, or optional effect payload may enter `extraResources` or the ASAR.

### 2.2 On-demand capability packs

| Pack family          | First packs                                                           | Why optional                                             |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Speech               | Whisper runtime; multilingual model variants                          | 150 MiB–1.5 GiB weights/runtime                          |
| Tracking Lite        | Point, region, and planar tracker worker                              | Native CV runtime; platform-specific                     |
| Subject Intelligence | Face/object detection and segmentation                                | ONNX runtime plus large model weights                    |
| Audio Intelligence   | Dialogue isolation, denoise, source separation                        | Large inference models; not required for ordinary mixing |
| Creative Assets      | Effects, templates, LUT collections, fonts with redistribution rights | Catalog grows independently of the app                   |

P0–P3 closure requires Speech, Tracking Lite, and Subject Intelligence. Audio Intelligence and
Creative Assets use the same platform but remain later professional-capability work unless an eval
in the original P0–P3 roster requires them.

### 2.3 Local-first hybrid

- Editing, rendering, project reopen, and export never require cloud access.
- Local packs are the default for speech, tracking, segmentation, and perceptual evidence where the
  machine supports them.
- A cloud implementation may satisfy the same capability contract when the user explicitly enables
  it; media-egress facts are shown before execution and recorded in evidence lineage.
- Cloud cannot be the only way to reopen or render a project. Analysis results used by the edit are
  baked into typed project operations; the provider is provenance, not a hidden runtime dependency.

## 3. Capability-pack architecture

### 3.1 Signed catalog and immutable pack identity

Every catalog record is versioned and names:

- `id`, semantic `version`, capability IDs, display name, description, and release channel;
- supported OS/architecture/GPU requirements and minimum/maximum app/engine protocol versions;
- exact compressed/unpacked sizes and required free-space multiplier;
- SPDX license, redistribution policy, source-notice URL, privacy behavior, and cloud alternative;
- artifact URL, SHA-256 digest, entrypoint, health-check protocol, and file allowlist;
- dependencies and conflicts using exact or bounded semantic versions.

The remote catalog is signed with an offline Ed25519 release key. The app embeds only public keys
and supports key rotation through a cross-signed keyring. Artifact integrity is independently
verified with SHA-256. Built-in catalog records are trusted through the signed application bundle
but still require artifact hashes.

The logical release identity is `(id, version, release digest)` and is what a project pins. The
signed release maps that identity to immutable `(platform, architecture, artifact digest)` bytes.
Fixes publish a new version; they never replace bytes behind an old digest.

### 3.2 Install transaction

```text
inspect requirement
  → explicit user approval (size/license/privacy)
  → reserve disk budget
  → resumable .partial download
  → length + SHA-256 verification
  → sandboxed extraction to staging
  → file allowlist / traversal / symlink / expansion-ratio checks
  → platform signature and executable policy check
  → worker protocol health check
  → atomic rename into immutable version directory
  → atomic storage-index commit
```

Cancellation and crashes leave no installed state. Concurrent requests for the same identity share
one download. Retries use ETag/Range only when the server proves the partial bytes still belong to
the same artifact. A failed health check quarantines the staged pack with a typed diagnostic.

### 3.3 Storage and project pinning

- Packs install under Electron `userData/capability-packs/<id>/<version>/<platform-arch>/`, never
  inside a project and never inside the application bundle.
- The index tracks installed bytes, last use, health, project pins, in-flight leases, acquisition
  source, catalog digest, and license receipt.
- A project stores exact capability dependencies in schema v19. Analysis-only packs also record
  provenance on their generated track/mask result, but rendering uses the baked deterministic data.
- Active projects pin pack identities. A pinned or leased pack cannot be evicted.
- Versions install side by side. Updating the app or catalog never rewrites a project's pin.
- Removing a pack is two phase: mark pending removal, refuse new leases, then delete after all worker
  processes exit. User-directed deletion reports every affected project first.
- Storage Manager supports install/update/remove, disk totals, per-project usage, health repair,
  custom storage location, and safe cleanup of unpinned least-recently-used packs.
- Opening a project with a missing dependency offers **Download**, **Locate Existing**, **Cloud
  Alternative**, or **Open Degraded**. It never downloads silently.
- “Collect project” includes redistributable packs; for restricted packs it includes the exact
  manifest/acquisition receipt and downloads the same identity on the destination machine.

### 3.4 Worker boundary

Heavy native packs execute as isolated workers rather than importing optional libraries into the
frozen render engine. Workers speak a versioned length-bounded JSON protocol over stdio or a local
authenticated socket:

- handshake: identity, protocol version, capabilities, hardware backend, model digests;
- request: project-local media handles, bounded frame/range, parameters, revision, cancellation ID;
- progress: phase, completed/total work, bounded diagnostic;
- result: typed tracking/detection/segmentation evidence plus provenance;
- terminal: completed, cancelled, unavailable, or typed failure.

The desktop host resolves and sandbox-checks media paths. Workers never receive project-file write
authority, provider secrets unrelated to their job, or an arbitrary command/shell surface.

## 4. Closure workstream

### C0 — Truthful inventory and stable contracts `[x]`

- [x] Audit current P0–P3 claims and downgrade incomplete gates.
- [x] Establish the recommended platform, execution, download, and pinning policy.
- [x] Define versioned pack catalog/install/storage/worker contracts and error taxonomy.
- [x] Add schema v19 project dependency pins with TS/Python parity and migration 18→19.
- [x] Generate a single capability-to-pack dependency manifest from the capability registry.

Gate: the catalog, project schema, IPC, worker protocol, docs, and eval roster fail drift together.

### C1 — Production-grade on-demand platform `[ ]`

- [x] Implement offline-root Ed25519 catalog verification, time-bounded non-transitive delegated
      signing keys, root-signed rotation/revocation, future-date defense, and durable rollback state.
- [x] Implement explicit-approval, content-addressed HTTPS download with safe ETag/Range resume,
      cancellation, in-process deduplication, disk-space refusal, length checks, and SHA-256
      verification.
- [x] Implement disposable raw/ZIP extraction staging with an exact signed file allowlist, path and
      symlink rejection, duplicate/file-count/size/expansion bounds, no-overwrite writes, and
      cancellation/failure cleanup.
- [x] Bind every signed artifact to an exact macOS Team ID or Windows certificate SHA-256; verify
      OS trust and require a bounded, identity/capability-exact worker protocol health handshake.
- [x] Implement atomic receipt/directory/index installation, trust/health quarantine, cancellation
      cleanup, abandoned-staging cleanup, interrupted-index recovery with re-verification, and
      cross-process artifact/index locks.
- [x] Implement the crash-safe immutable storage authority: atomic index commits, process leases,
      project pins, side-by-side identities, corrupt-index quarantine, and two-phase removal.
- [x] Add exact state/per-project disk accounting, affected-project/lease removal impact, and
      quarantined-first then LRU eviction proposals with exact explicit approval and live rechecks.
- [x] Add user-selected custom storage roots, transactional relocation, and relocation recovery.
- [x] Add validated desktop IPC/preload APIs for main-verified proposals, exact approvals,
      cancellable installs/progress, storage state, cleanup planning, and cleanup execution; ship a
      non-cosmetic Settings → Storage workflow for accounting, blockers, progress, review, and exact
      removal.
- [ ] Connect missing-capability responses to the proposal/approval UI, project-open dependency
      choices (Download / Locate / Cloud / Degraded), and project pin/unpin lifecycle.
  - [x] Reconcile exact logical pins on project open/save/patch and protect matching healthy or
        unhealthy installs from eviction with one atomic per-project index mutation.
  - [x] Gate project open with explicit degraded mode and a signed exact-version review/approval,
        cancellable download, progress, post-install pin, and render-required export refusal.
  - [ ] Add verified local-store adoption (“Locate”), catalog-declared cloud alternatives, and
        capability invocation interception so these choices are offered only when executable.
- [ ] Migrate Whisper model setup onto the common installer without changing ASR behavior.
  - [x] Route packaged-desktop Settings through the signed `framepilot.local-whisper` proposal,
        exact approval, common installer, cancellation, and progress path; never call Python setup.
  - [x] Exclude Whisper from base helper discovery and inject only healthy pack-owned CLI/model
        paths into the sidecar, including restart and custom-root relocation refresh.
  - [ ] Publish and validate the macOS arm64 and Windows x64 Whisper pack artifacts/catalog rows.
- [x] Add offline pack release tooling that derives artifact/SBOM facts, enforces the license and
      immutable-URL gates, refuses false release digests, signs exact Ed25519 catalogs, emits
      digest-addressed CDN publication plans, and creates monotonic signed rollback catalogs.
- [ ] Wire macOS arm64 and Windows x64 worker build/sign/notarize jobs, publish their immutable
      artifacts/catalog rows and SBOMs, and atomically operate the CDN latest pointer/rollback.

Gate: install/cancel/resume/corrupt/recover/update/rollback/pin/evict flows pass integration tests on
both target platforms; the base installer contains zero pack payload and grows by at most 10 MiB.

### C2 — Unified execution durability `[x]`

- [x] Move the host-neutral durable `RunStore` into AI SDK and retain desktop `FileRunStoreIO`.
- [x] Add browser IndexedDB IO with bounded localStorage fallback, quarantine, retention, and
      recovery UI projection.
  - [x] Implement transactional IndexedDB run/snapshot/quarantine stores and a 1M-character-per-run,
        4M-character-total localStorage fallback using the shared RunStore retention/quarantine API.
  - [x] Persist canonical lifecycle events and terminal snapshots for browser edit/recipe/
        planned-edit/agent/auto editing routes without storing an instruction to reapply a patch.
  - [x] Project recovered/terminal browser runs into the AI sidebar after reload and classify a
        nonterminal record as interrupted before offering any retry.
- [x] Prove edit/recipe/planned-edit/agent/auto lifecycle replay after reload with identical terminal
      state and no duplicate patch application.
  - [x] Prove every browser mutation route writes a terminal snapshot through the same authority,
        clears normally consumed handles, and interrupted recovery emits no diff/patch command.
  - [x] Persist browser patch proposals and accept/reject decisions as idempotent WAL events;
        recovery projects terminal truth without emitting a patch command.
  - [x] Make desktop authoritative patch commits idempotent by persisted patch identity: an exact
        retry returns the existing full project/revision without a write, revision bump, or compact
        patch transport; patch-id reuse with different content is rejected.
  - [x] Prove accepted-patch history/reload and identical browser/desktop terminal projection for
        every route, including a deterministic planned-edit fixture that produces a real proposal.
- [x] Make execution-policy parity explicit for MCP: portable semantic commands where interaction is
      not required; typed `host_ui_only` refusal where it is.

Gate: every mutation route is durable, cancellable, idempotent, review-gated, and replayable on its
declared hosts.

### C3 — Production perceptual reviewer `[~]`

- [x] Add deterministic objective declarations at the compiled typed-operation boundary for
      semantic-only framing, crop, mask, tracking, and transition questions.
- [x] Route those objectives through production `reviewVisionObjectives`; deterministic checks remain
      authoritative and vision can fail but never rescue them.
- [x] Version provider/model/prompt/frame lineage; enforce media-egress consent and bounded frames.
- [~] Add local vision capability via Subject Intelligence pack plus explicit cloud alternatives.
      `createLocalVisionJudge` answers *framing* objectives — `motion-framing` and `crop-framing` —
      from real face detections produced by the Subject Intelligence pack, so the commonest semantic
      objectives confirm on a laptop with no cloud call, no media egress and no per-check billing.
      Its scope is deliberately narrow and enforced: every other objective kind returns
      `cannot_tell`, which settles as unverified and fails the gate that asked, because a detector
      guessing at "does this transition read?" would be inventing a pass. Two asymmetries are
      deliberate — a detected face running off the frame edge is a real `fail`, but finding *nobody*
      is `cannot_tell` rather than `fail` (B-roll is not a failed edit), and person boxes are ignored
      because they legitimately run off the bottom of frame in most medium shots. The judge now
      receives the request id so it routes on the objective kind rather than pattern-matching the
      wording of the question. **Still open**: desktop wiring of the detector callback to the
      installed pack, and the explicit cloud alternative's selection UI.
- [x] Prove unavailable/malformed/cannot-tell/cancelled reviewers keep the edit unverified and never
      auto-commit. Unavailable, malformed, `cannot_tell`, a thrown reviewer and an unacquirable frame
      were already proven to settle as unverified. Cancellation was a real hole: the reviewer took no
      signal, so a judge already in flight when the user stopped the run still returned `pass` and
      still counted. It now refuses both before dispatch and again after the verdict arrives, and the
      orchestrator passes its run signal through. The gate itself is asserted, not just the report —
      a cancelled review fails the critic that guards auto-commit.

Gate: normal editor runs demonstrably watch semantic objectives, and negative fixtures fail for the
intended visual reason.

### C4 — Automatic tracking and tracked consumers `[~]`

- [~] Tracking Lite pack: point, bounded-region, and planar tracking with confidence/occlusion.
  Worker implemented in `workers/tracking-lite/` as a separate artifact project (LK point flow,
  CSRT region with appearance-measured confidence, homography planar with inlier/error
  confidence), with the frozen JSON-line protocol, verified health identity, one-thread/fixed-seed
  determinism, self-disabled networking, bounded progress, cancellation, and a bounded
  freeze-then-`target_lost` occlusion policy. 61 unit tests run against an injectable scripted
  backend with wrong-trajectory negative controls. Supply chain landed: exact `uv.lock`
  (opencv-contrib-python-headless 5.0.0.93 + numpy 2.5.2 with wheel digests), build manifest,
  generated `LICENSES.md`/CycloneDX SBOM with a drift check, and a separate pack CI workflow.
  Decoded-media pixel proof passes on real encoded video: point/region/planar recover a known
  trajectory within 8 px, mirrored trajectories fail, results are byte-identical across runs, and a
  vanished subject is reported lost rather than invented. **Still open**: per-platform self-contained
  runtime, signing/notarization, catalog publication, and desktop invocation.
- [x] Subject Intelligence pack: face/object detection and segmentation masks. Implemented in
      `workers/subject-intelligence/` as a second standalone artifact project. **Model decision
      (made 2026-08-14):** YuNet (MIT) for faces, YOLOX-S (Apache-2.0) for people and objects,
      PPHumanSeg (Apache-2.0) for segmentation. The mainstream default — YOLOv8/YOLO11 via
      Ultralytics — was rejected because it is **AGPL-3.0**, which is wrong for a shipped desktop
      product; that rejection is now enforced, not just recorded, because the SBOM check fails if
      any pinned weight carries a non-permissive licence. All three run on OpenCV's `dnn` module,
      so the pack adds **no second ML runtime** (no ONNX Runtime, PyTorch or PaddlePaddle) and
      reuses a native dependency already audited for Tracking Lite. Total weights ~42 MiB against
      a 150 MiB–1.5 GiB budget. Weights are never committed: `pack/models.lock.toml` pins each to
      an immutable upstream commit plus sha256, `tools/fetch_models.py` verifies on download, the
      worker re-hashes every file before loading it, and the digests are reported in the handshake
      and in every result for evidence lineage. Honesty policy carried over from Tracking Lite:
      finding nothing returns nothing, a point prompt resolves against a real person detection
      rather than a guessed rectangle, and an empty or near-empty mask is `target_lost`. 84 unit
      tests against an injectable scripted backend plus 9 real-inference proofs on a pinned
      photograph, including a mis-registration control. **Desktop invocation landed 2026-08-23**:
      `detect_subjects` (agent evidence tool) and silhouette-follow masks run this worker through
      the shared media-intelligence authority, with `FRAMEPILOT_CAPABILITY_PACK_ROOT` provisioned
      to the installed model directory. **Still open**: per-platform runtime, signing/notarization,
      catalog publication.
- [x] Dev-only local pack registration (2026-08-23): `framepilot-pack register-local` seeds the
  store from a locally built worker without any catalog — gated behind
  `FRAMEPILOT_DEV_PACK_REGISTRATION=1`, running the exact isolated health check a signed install
  runs, staging a content-digested copy under the canonical layout, and writing an acquisition
  receipt that names itself dev so audits can tell it from a catalog install.
- [x] Agent-side desktop invocation (2026-08-23): `track_subject_automatically` reaches the real
  worker end to end — registry entry with a transcribe-style never-cached host contract,
  orchestrator post-processing that compiles the validated measurement into the same reversible
  `track_object` patch as the manual path, and a desktop executor composing beside the sidecar
  executor in the single `HostToolExecutor` slot.
- [x] Freeze the revision-bound isolated worker request/progress/result/failure protocol for point,
      region, planar, detection, and segmentation jobs with bounded normalized geometry and output.
- [x] Implement the one-shot worker process client with realpath sandbox enforcement, minimal
      environment, bounded JSON/stderr, exact request/revision/capability matching, timeout, and
      cancellation.
- [~] Desktop tracking authority: `apps/desktop/electron/capability-packs/tracking.ts` resolves the
  newest healthy installed release, refuses quarantined/pending-removal/unhealthy packs as
  `pack_unhealthy` rather than "missing", rejects a stale project revision before any work, verifies
  the signed entrypoint exists inside the installed root, holds a storage lease across the whole
  worker lifetime and releases it even on crash/cancel, maps worker errors to typed outcomes keeping
  `target_lost` visible, and returns an install proposal instead of a fake track when no pack is
  installed. **Generalized into the media-intelligence authority (2026-08-23)**: capability→pack
  bindings route tracking capabilities to Tracking Lite and detect/segment to Subject Intelligence,
  provisioning `FRAMEPILOT_CAPABILITY_PACK_ROOT` for weights-backed packs via the worker client's
  audited `extraEnvironment` channel. Consumed by BOTH the agent executor and the renderer IPC.
- [~] Resolver/controller contracts for point/object/face/region/planar/segmentation targets.
  `automatic-tracking-controller.ts` resolves point/region/planar/silhouette targets into exact pack
  request plans, and `resolveSubjectDetectionObjective` covers whole-frame detection: geometry always
  comes from a mask the editor drew (never a model-guessed box), the range is the clip's own source
  range, and unresolved targets, wrong mask shapes, out-of-frame bounds, non-video clips and
  over-long ranges are typed refusals. **Face/object detection is consumed by `detect_subjects`;
  silhouette segmentation feeds the same reversible edit path** (2026-08-23). **Still open**: free
  segmentation prompts without a drawn mask, which need a bitmap-mask timeline representation.
- [~] Deterministic track smoothing, gap/occlusion policy, confidence thresholds, correction limits,
  and exact reversible operations. `packages/editor-core/src/track-samples.ts` converts worker
  samples host-side: occluded/low-confidence measurements never steer the track, bounded gaps are
  bridged by straight-line interpolation while a gap past the limit is rejected rather than
  invented, a centred moving average removes jitter, per-frame correction is clamped, and every
  keyframe stays in frame and inside the clip. 15 tests. `apply_tracked_mask` in `tracking-commands.ts` compiles those
  keyframes into a validated, exactly invertible `track_object` patch recording the measuring pack's
  identity as provenance, with apply/invert/save-reload/determinism coverage and typed refusal when
  the policy rejects the track. The validated IPC path now carries samples from the desktop
  authority to the renderer: the intent names an asset id, never a path, main re-reads the project
  and stamps its own revision, and cancellation is addressable by request id. **Still open**:
  controller/resolver targets for automatic tracking.
- [~] Consumers: transform follow, local color mask, graphics attachment, and automatic reframe.
  `track-follow.ts` plans transform-follow points for the existing `animate_clip_property` compiler —
  no new operation and no schema change, so a followed overlay validates, inverts, saves, reloads and
  renders through already-proven paths. Follow is relative to the first tracked frame so the editor's
  placement is preserved, normalized motion is converted with the real output resolution, and
  occluded frames are skipped rather than animated from a held box. 10 tests. `track-reframe.ts` adds automatic reframe, deriving cover
  scale and pan from the render compiler's own `base_scale`/`position_at` formula rather than an
  approximation, clamping pan so it can never expose empty frame, damping jitter into a steady move,
  and skipping occluded frames. 12 tests. Graphics attachment is transform follow applied to a
  graphics clip, and a tracked local colour mask is the mask keyframed by `apply_tracked_mask`, so
  both ride the same proven paths. **Still open**: preview/render parity proof for generated tracks.
- [x] Preview/render parity for generated masks and tracks; no metadata-only success claims.
      `engine/python/tests/test_render_track_parity.py` renders the real compositor and measures the
      overlay's pixel centroid: a generated track must move the picture by the distance it asked for, a
      mirrored trajectory and a no-movement reading must both fail the same measurement, a clip with no
      keyframes must not move, and mid-track frames must land continuously between the ends.

Gate: real decoded moving subjects produce pixel-verified tracks, plausible wrong trajectories fail,
all consumers apply/invert exactly, and missing packs yield an install proposal rather than a fake
track.

### C5 — Professional semantic eval closure `[ ]`

- [~] Replace the fixtures' fake media paths with shared content-coded synthetic media.
  `packages/ai-sdk/src/professional-eval-media.ts` generates real, cached, deterministic media whose
  content is known by formula: a block moving at an exact px/s, separated colour bands, and a tone
  that steps level at known seconds. Verified from decoded pixels, and it reports ffmpeg absence as
  unavailable rather than letting a row score without rendering. The eval bridge now stages that same content coding for every case
  asset — separated colour bands plus a block whose position is a formula in `t` — replacing the flat
  colour fills that made pixel measurement impossible, and the opt-in rendered scorecard still passes
  every row against the new media. **Still open**: the per-domain pixel proofs that consume this
  structure.
- [ ] Create a controller intent/property/variant roster independent of the capability count.
- [~] Add motion pixel proofs for x/y/scale/rotation/opacity, continuation, easing, and cover bounds.
  `test_render_track_parity.py` now proves position (travel distance and continuity), scale (rendered
  area) and opacity (the clip genuinely dissolving) from decoded pixels, each with a negative control
  — a mirrored trajectory, a no-movement reading, and a shrink that must not read as a grow.
  Rotation is proven by shape rather than extent, because the compiler rotates with `expand=False`
  and a turned rectangle cannot grow its box; easing is proven at the quarter point, because easing
  is a claim about the middle of a move and endpoint-only checks cannot see it. **Still open**:
  cover-bounds proofs.
- [~] Add color proofs for all properties, match-reference, grouping, skin preservation, and scope
  isolation from caption burn-in. Exposure and saturation are now proven from rendered pixels with a
  darkening negative control and an identity control. A fixture constraint is documented in place: a
  channel-scaling grade such as temperature cannot be measured on a pure-green patch, because
  scaling zero leaves zero — a test written against it would read 'the grade did nothing' for a
  working grade. Scope isolation is now proven too: a graded clip must leave a background layer's
  pixels untouched, sampled in a corner the graded overlay never covers, so "the grade worked" cannot
  be satisfied by a grade that leaked across layers. **Still open**: match-reference, grouping and
  skin preservation.
- [ ] Add tracking/mask pixel proofs and wrong-trajectory/wrong-subject controls.
- [~] Add audio proofs for fade-out, normalization, role ducking, EQ, compression, automation, and
  long-window loudness/discontinuity behavior. `test_render_audio_parity.py` exports through the real
  pipeline, decodes the result and measures RMS: a fade-out must genuinely quieten the exported
  samples, and a clip without one must not read as fading. Writing it surfaced that fades live on an
  `audio_gain` effect's params, not as a clip field — a plausible `fadeOut` on the clip is silently
  ignored. Gain and normalization are proven the same way: a cut must move the measured level down
  rather than merely differ, and normalization must lift a −18 dB source, with a control proving the
  lift comes from normalization and not from re-exporting. **Still open**: ducking, EQ, compression,
  automation and long-window loudness proofs.
- [ ] Add multi-target linked A/V and group batch apply/invert/save/reload/cross-host cases.
- [x] Require `verified === registered` in release CI. The rendered scorecard now asserts that every
      capability the product reports as _available_ was rendered and verified, and that any exempt row is
      openly unsupported with a stated reason — closing the escape hatch from both sides. The assertion
      immediately found the one real gap: `tracking_mask.automatic_subject_track`, honestly unsupported
      pending the Subject Intelligence pack.
- [ ] Exercise real host adapters and durable accepted-patch history, not JSON round-trip alone.

Gate: every advertised operation and intent variant has a production-path positive case and at least
one plausible negative control; `verified === registered` is required in release CI.

### C6 — Release closure `[ ]`

- [ ] Apple Silicon macOS signed/notarized installer and pack-worker verification.
- [ ] Windows x64 signed installer and pack-worker verification.
- [ ] Clean-machine install, offline edit/render, on-demand pack install, project transfer, missing-pack
      recovery, update/rollback, and uninstall tests.
- [~] Full `pnpm verify`, pack security suite, SBOM/license scan, installer size budget, and 33-row-plus
      semantic roster gate green in CI. Typecheck/lint/coverage, the engine suite, the license scan,
      e2e/visual and the rendered professional evals already run as CI jobs; the pack suites run in
      their own workflows with SBOM drift checks. The gap was the installer budget, now closed by
      `scripts/check-installer-budget.mjs`, which fails the release build if a Capability Pack
      payload (ONNX weights, OpenCV, a pack worker binary) is found inside the base installer or an
      installer exceeds its size budget — ADR 0114's line, checked mechanically because a leak is
      otherwise silent. **Still open**: running the whole set against a real signed release build.
- [~] Docs, ADRs, changelog, capability scorecard, support runbook, and disaster rollback current.
      `docs/runbooks/distribution.md` covers the two trust surfaces users depend on after purchase —
      the desktop update feed and the pack catalog — with feed host setup, the root key ceremony and
      its rules, publishing order, rollback semantics for both channels, and an incident table. It
      records why update rollback is roll-*forward* only (clients that already updated will not
      downgrade, so republishing an old version silently strands them) while pack rollback is real
      (a catalog is a statement, not a push, and can never mutate bytes already on disk), and why
      the installer payload check exists (PyInstaller absorbs the build venv, not the lockfile).
      **Still open**: the capability scorecard needs regenerating against a signed release build,
      and the docs section listing unmet preconditions should shrink as they are met.

Gate: no incomplete `[~]` P0–P3 item remains in this plan or the original control-plane plan, and a
clean release build proves the end-to-end completion contract on both target platforms.

## 5. Failure and rollback rules

- A catalog outage never blocks installed capabilities or core editing/rendering.
- A delisted pack remains usable by projects that already possess it; the catalog can revoke future
  acquisition but cannot mutate local bytes.
- Security revocation is explicit, signed, and reports affected projects. It disables execution but
  preserves project data and offers a compatible replacement or degraded open.
- A pack update is side-by-side and reversible until no project or rollback lease pins the old one.
- Pack-worker crashes fail one analysis job, never the render engine or Electron main process.
- Capability-pack schema and protocol additions are backward compatible within a major version;
  incompatible changes publish a new protocol/pack major and retain the old launcher while pinned.

## 6. Metrics

- Base installer size and delta from the pre-pack baseline.
- Catalog/download/checksum/install/health-check latency and failure reason.
- Bytes installed, pinned, reclaimable, and quarantined.
- Pack crash rate, cancellation latency, and protocol mismatch rate.
- Resolver ambiguity/staleness, compile rejection, review failure/repair, and semantic eval pass rate.
- Project reopen success with exact pack identity, offline render success, and transfer recovery rate.
