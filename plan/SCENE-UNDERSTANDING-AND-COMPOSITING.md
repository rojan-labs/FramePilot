# Scene Understanding & Advanced Compositing — End-to-End Plan

> **Sub-plan of [`plan/PLAN.md`](./PLAN.md).** Read `AGENTS.md` and `CLAUDE.md` first.
> Status: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
> **Created:** 2026-07-31 · **Owner:** unassigned · **Schema range reserved:** v16 → v20

**One sentence:** build a single per-asset understanding of *what is in the shot, where
it is, when, and in front of what* — persist it outside the project file, and let one
mask/depth/track evaluator drive depth-aware text, clone compositing, background
replacement, object removal, motion graphics and auto B-roll identically in preview and
export.

This document is **audit → architecture → phases → UI spec → AI SDK surface → QA**. Nothing
in Phase P3+ may start before P1 and P2 land, because every downstream feature composites
layers and masks that the preview cannot currently draw at all.

**Every capability here is reachable from the AI SDK (`packages/ai-sdk`) — and therefore
from Agent mode and from external agents over MCP — on the same day it is reachable from
the UI.** §6 specifies that surface, and §6.8's Definition-of-Done additions apply to every
phase, so the AI layer cannot lag behind the UI.

---

## 0. Audit — what exists today

Evidence-based, from reading the code on 2026-07-31 at `6c32e64`. Each claim cites a
file so it can be re-checked rather than trusted.

### 0.1 What already works and must be reused, not rebuilt

| Area | Where | Verdict |
|---|---|---|
| Typed reversible operation engine (`apply` + `invert` + validate before apply) | `packages/editor-core/src/operations.ts`, `patch.ts`, `validator.ts` | **Reuse as-is.** Every new compositing capability becomes ops here. This is the strongest asset in the repo. |
| Schema + migrations + Zod↔Pydantic mirror | `packages/timeline-schema/src/index.ts` (v15), `migrations.ts` | **Reuse.** The additive-optional-field discipline (see the `effectLayers` note, `index.ts:800`) is exactly the pattern the new fields must follow. |
| Keyframe engine with bezier handles, TS + Python mirrors | `editor-core/src/keyframes.ts`, `engine/python/framepilot_engine/effects/keyframes.py` | **Reuse.** Already supports `linear/ease-in/ease-out/ease-in-out/hold/bezier` + custom handles (v14, ADR 0089). Covers most of the brief's interpolation list. |
| Effect layers as first-class timeline layers | schema v13, ADR 0088; `effect-catalog.ts`, `render/frame_effects/`, `preview/effects/gl-effect-chain.ts` | **Reuse the *pattern*.** 41 render kinds with a Python pass **and** a GLSL twin, plus 350 structural parity tests. This is the proven template for "one spec, two runtimes, provable parity" and the mask stack must copy it. |
| Shape-mask rasterizer with animated params | `engine/python/framepilot_engine/render/masks.py`, `compiler.py:_attach_mask` | **Reuse and extend.** Rect/ellipse/polygon, feather, opacity, invert, keyframed — but export-only (see 0.2). |
| Python multi-layer picture compositing with blend modes | `render/compiler.py` (`_blend_layer_over`, schema v8 / ADR 0048) | **Reuse.** The *export* already stacks picture layers. The preview does not. |
| Media understanding backend (embeddings, visual search, TwelveLabs) | `engine/python/framepilot_engine/brain/*`, `visual_indexing.py` | **Reuse for semantics** (B-roll relevance, "the mountain"), **not for geometry.** It returns descriptions and similarity, never per-frame masks. |
| Honest unavailable-tool posture | `tool-registry.ts:2016` — `generate_mask` is registered as **unavailable** rather than faked | **Keep this discipline.** It is why "AI silently claims success" is currently *not* a bug in the mask path — the tool refuses. Every new capability must keep the same fail-closed default. |
| Design token system, single accent, light+dark | `packages/ui/src/tokens.css`, `DESIGN_SYSTEM.md` | **Extend, never fork.** New compositing UI adds tokens under existing names/ramps. |

### 0.2 What is broken, missing, or a lie the UI tells

Ordered by user impact. These are the findings the plan is built to close.

1. **The preview is a single-picture-layer engine. The export is not.**
   `apps/web-editor/src/editor/selectors.ts:376-393` flattens picture clips from **every**
   track into one time-ordered `PictureSegment[]`, sorted by `start`, with gaps filled.
   Two overlapping picture clips on two layers cannot both be shown — the second simply
   overwrites time. Meanwhile `render/compiler.py` composites them with blend modes.
   **Consequence:** clone effects, background replacement, B-roll-behind-subject and
   layered motion graphics are *unpreviewable today*, and any of them would export
   differently from what the user saw. This is the #1 blocker and P1 exists only to fix it.

2. **Masks never appear in the preview at all.** `_attach_mask` (compiler.py:581) composes
   geometric mask × opacity × transition × wipe into one alpha at export. The WebCodecs
   engine has no mask stage — the only `mask` hits in
   `preview/engine/webcodecs-preview-engine.ts` are comments about the *crop* clip-path.
   A user adds a mask, sees nothing change, exports, and the picture is cut out.

3. **The mask UI is a fire-and-forget button.** `components/Inspector.tsx:118-246` offers
   shape / feather / opacity and an **Add mask** button that calls `addMaskPatch`. There is
   no bounds control, no polygon points, no invert, no way to *see* or *edit* or *delete*
   an existing mask, no on-canvas handles, no keyframes. The Inspector section exists
   (`inspector/registry.ts:133`) so the feature *looks* shipped.

4. **Segmentation and tracking are `NotImplementedError` stubs.**
   `masking/mask.py` — `rectangle_mask`, `ellipse_mask`, `polygon_mask`, `subject_mask`,
   `text_behind_object` all raise "Phase 5". `tracking/tracker.py` — `track_object`,
   `track_face` likewise. There is **no** segmentation, **no** detection, **no** depth,
   **no** pose/gesture anywhere in the codebase.

5. **`track_object` writes a track nothing reads.** `operations.ts:1326` persists an
   `object_track` effect with per-frame bbox keyframes. `effects/tracking.py:tracked_box_at`
   can read it. The render compiler never calls it. A grep for `object_track` outside
   tests returns exactly those two files. It is a data structure with no consumer.

6. **There is nowhere to persist scene understanding.** `ProjectSchema` (index.ts:940)
   has `assets / folders / timeline / transcript / markers / aiMemory / history`. No scene
   objects, no mattes, no tracks, no confidence, no analysis provenance. `aiMemory` is an
   untyped `z.record`. **Every requirement under "Project Persistence" in the brief is
   currently unsatisfiable.**

7. **No matte/alpha media type.** `AssetSchema.kind` is `'video' | 'audio' | 'image'`.
   A per-frame alpha sequence has nowhere to live as a first-class, cacheable asset.

8. **`duplicate_clip` does not exist.** Ops include `duplicate_layer` and
   `duplicate_effect_layer`; `'duplicate_clip'` appears only as an error/label string
   (`operations.ts:677, 1158`). The clone workflow's step 2 has no typed operation and no
   AI tool. There is also no keyboard shortcut and no preview/context-menu entry point.

9. **Transform is keyframes-only and incomplete.** Position/scale/rotation/opacity live
   as clip `keyframes` (`preview/picture-transform.ts`), with no static transform value,
   **no anchor point**, no per-clip blur or drop shadow, and `crop` is a static rect
   (`ClipSchema.crop`) that cannot be keyframed. The brief requires anchor point,
   perspective, blur, shadow and crop keyframes.

10. **Depth is track order and nothing else.** There is no way to express "in front of the
    body but behind the hand", and no way for depth order to change mid-shot.

11. **The timeline shows none of it.** `TimelineView.tsx` (3,013 lines) draws clip lanes,
    an effect lane, and transitions. There is no keyframe lane, no mask lane, no tracking
    range, no confidence band, no per-clip expand/collapse disclosure.

12. **No inpainting, no background replacement, no gesture recognition, no auto B-roll
    placement.** `map_footage` / `search_visual` can *find* relevant media; nothing places
    it behind a subject.

### 0.3 Where AI edits currently fail to reach the timeline

The orchestration layer is comparatively mature (ADR 0083 fails closed on empty planned
mutations; ADR 0087 requires a reconciled plan for success). The compositing-specific
risk is different and narrower:

- `generate_mask` / `detect_faces` are **declared unavailable** — the model is told they
  cannot run. That is correct today and must stay correct until P3 actually lands.
  **Rule for this plan: a tool moves out of `unavailableTools` in the same commit that
  makes it real, never earlier.**
- `add_mask` and `track_object` *do* apply and *do* validate — so an agent can honestly
  report "mask added" while the preview shows nothing and (for `track_object`) the render
  ignores it. This is the one live "silent success" in the compositing surface, and it is
  closed by P2 (preview mask parity) and P3 (a consumer for tracks).

---

## 1. Architecture

Five decisions carry the whole system. Each gets an ADR before code.

### A1 — Scene Graph lives in a **global**, content-addressed analysis cache

Per-frame masks and tracks for a 10-minute 4K clip are megabytes to gigabytes. They cannot
go in the project JSON (parse cost, undo snapshots, diff noise, git).

They also should not live *inside the project folder*. Premiere's three-tier separation is
the right precedent: a small **project file**, a **global Media Cache** keyed to the media
and shared across every project, and disposable **preview files**. Keying globally means
importing the same footage into a second project reuses the first project's analysis —
which is the single most common way a per-project cache wastes a user's time and GPU.

```
~/Library/Application Support/FramePilot/analysis/     # user-relocatable (A1.2)
  <assetContentHash>/
    scene.json          # SceneGraph: objects, classes, spans, relations, confidence
    mattes/<objectId>/  # alpha media, per quality tier (see A2)
    tracks/<objectId>.track.json
    meta.json           # analyser versions, tiers completed, invalidation keys
```

The project file stores only **references**: `assetContentHash` and the analyser version
each stored result was produced by. Keying on the **content hash of the source media** (not
the path) means: reopening the project reuses everything; proxy regeneration invalidates
nothing (the proxy is derived; the hash is of the original); moving or renaming the file
invalidates nothing; *changing* the media does; and a second project gets the analysis free.

Invalidation is per-region, not global: `meta.json` records completed `(objectId, frameRange,
tier)` triples. An edit that trims a clip invalidates nothing (the analysis is per-*asset*,
not per-clip). Re-analysis is requested only for ranges never analysed.

**The cache is a bounded, user-managed resource — not an unbounded pile.** This is where
CapCut is weakest (users routinely discover tens of GB with no story) and where Premiere is
strongest (Preferences → Media Cache: location, size cap, auto-delete policy). Mattes are
far larger per hour of footage than peak files, so this matters more for us, not less.

- [ ] **A1.1** LRU eviction: evict `final`-tier mattes first, **retain `draft` tiers** — a
      draft matte is small and makes a re-open instantly usable while `final` re-renders.
      Never evict user-authored data (spline roto, locked ranges, corrections); those are
      project data that happen to live nearby, and are separated in the layout so eviction
      cannot reach them.
- [ ] **A1.2** Settings surface: cache location (relocatable to another volume — editors
      keep scratch on fast external storage), size cap with a sensible default,
      auto-delete policy, current size, and a **Clear cache** action that states what it
      will remove and what will need recomputing.
- [ ] **A1.3** A project can be archived with its analysis (copy-in) for handoff, and
      opening an archived project re-registers it into the global cache rather than
      running as a second parallel store.

**ADR 0091 — Global content-addressed analysis cache: layout, keying, eviction, relocation.**

### A2 — Mattes are media, and preview and export read the *same* matte file

The only way to guarantee "no preview/export mismatch on mask boundaries" is to stop
computing the boundary twice. Segmentation runs **once**, in Python, and is baked into an
alpha media file. Both runtimes decode that file.

- Format: single-channel video (VP9/AV1 grayscale, or H.264 yuv420 luma-only) at source
  resolution, plus a low-res tier for scrubbing. Falls back to a per-frame RLE bitmap pack
  for very short ranges.
- Tiers: `draft` (¼ res, fast model, available in seconds) → `final` (full res, refined
  edges). **Tier is a quality axis only — it may change edge softness, never geometry,
  never timing, never which object is masked.** That is the precise reading of the brief's
  "higher-quality export may improve edge quality, but must not alter the creative result."
- New `AssetSchema.kind: 'matte'`, marked engine-derived and never shown in the media bin.

**ADR 0092 — Matte assets: one segmentation result, two runtimes.**

### A3 — One mask stack spec, three evaluators, provable parity

Copy the ADR 0088 playbook exactly, because it already worked for 41 effect kinds.

A clip carries an ordered **mask stack**. Each entry is a *source* combined into the
accumulator by a *boolean mode*:

| Source | Data |
|---|---|
| `shape` | rectangle / ellipse / polygon (today's `MaskSpec`, extended with rotation + per-corner radius) |
| `spline` | bezier roto path, per-point keyframable |
| `matte` | reference to a matte asset + objectId (A2) |
| `luma` / `chroma` | derived from the clip's own pixels |

Each entry has `mode: 'add' | 'subtract' | 'intersect'`, `invert`, `feather`, `expand`
(positive = dilate, negative = erode), `opacity`, and its own keyframes. The stack
evaluates to one alpha buffer.

Three implementations, one spec:
1. **TS** — `packages/editor-core/src/masks/` — pure evaluator producing a mask *description*
   at time `t` (geometry resolved, no rasterization). 100% coverage required.
2. **Python** — `render/masks.py` extended — rasterizes for export.
3. **GLSL** — `preview/masks/` — rasterizes for the preview.

Parity is enforced by the same two-layer strategy the effect catalog uses: structural
parity tests (same spec → same resolved params in both languages) plus golden-media tests
on a real GL context.

**ADR 0093 — Mask stack schema v16 and the three-runtime parity contract.**

### A4 — Depth is an explicit, editable, keyframable ordering — never inferred at render

The scene graph proposes a depth ordering; it does not enforce one. The clip stores a
`compositeStack`: an ordered list of participants (`picture`, matte-derived object layers,
overlay/graphic ids). Reordering is a typed op. A `depthIndex` property is keyframable with
`hold` interpolation, which is how "text moves from behind to in front" and "the graphic
temporarily changes depth" are expressed without any new machinery.

"Text behind the mountain" therefore compiles to plain, inspectable layers:
`picture → text overlay → matte-of-mountain layer (source = picture, masked to the mountain)`.
Nothing magical, fully editable, and it renders through the *existing* composite path.

**ADR 0094 — Explicit composite stacks and keyframable depth ordering.**

### A5 — Analysis is a cancellable, resumable, progressive sidecar job — never in the browser

Analysis runs in the Python sidecar as jobs on the existing queue (`render/queue.py`
pattern). Contract:

- **Scoped:** a job names `(assetHash, frameRange, capability, tier)`. Nothing analyses an
  asset that has no clip on the timeline. The visible/selected range is prioritised.
- **Progressive:** `draft` tier streams results as it completes ranges; `final` upgrades
  them in place. The editor is usable the whole time.
- **Cancellable and resumable:** cancel writes partial results to the cache; a resumed job
  skips completed ranges.
- **Never blocking:** the editor never waits. Progress is UI state, not a modal.
- **Fail-closed:** a failed range is recorded as failed with a reason, and the affected
  timeline range is marked uncertain rather than filled with a guess.

**ADR 0095 — Scene analysis job protocol: scoped, tiered, resumable, fail-closed.**

### A6 — Dependency and licence gate (blocking, do this first)

Every model below is a *candidate*, not a decision. **No dependency is added without the
maintainer's approval and `pnpm license:scan`** (CLAUDE.md §5). Several strong candidates
are non-commercial or copyleft and are called out so nobody discovers it late.

| Capability | Candidates | Licence note |
|---|---|---|
| Promptable video segmentation + memory | SAM 2 / SAM 2.1 | Apache-2.0 code and weights — **preferred** |
| Fine matting (hair) | BiRefNet (MIT), MODNet | RVM is **GPL-3 — reject** |
| Open-vocabulary detection ("mountain", "product") | Grounding DINO, RT-DETR | **YOLOv8/v11 are AGPL-3 — reject** |
| Semantic regions (sky/ground/wall/water) | Mask2Former / OneFormer ADE20K | check per-checkpoint; some SegFormer weights are non-commercial |
| Monocular depth | Depth Anything V2 **small/base** | large is **CC-BY-NC — reject** |
| Pose / hands / gesture | MediaPipe Tasks | Apache-2.0 |
| Video inpainting | LaMa (Apache-2.0) + temporal wrapper | ProPainter / E2FGVI are **non-commercial — reject** |

#### App size: the measured baseline and the budget

Measured from `apps/desktop/release/` on 2026-07-31 (arm64, unsigned local build):

| | Size |
|---|---|
| Installed `.app` | **521 MB** |
| DMG | **205 MB** |
| ├ Electron Frameworks | 230 MB |
| ├ `Resources/engine` (PyInstaller) | 241 MB — **cv2 118 MB**, imageio_ffmpeg 47 MB, ffprobe 17 MB, engine 12 MB |
| └ `app.asar` | 48 MB |

DMG compression is ~2.5×, but **model weights compress at ~1.05×**, so anything bundled
adds to the download almost 1:1.

New code is negligible (`app.asar` +4–6 MB, engine +2–3 MB). Two levers dominate:

- **Runtime.** ONNX Runtime with the CoreML EP ≈ **+35 MB**. PyTorch + torchvision ≈
  **+250–400 MB**. *Decision: require ONNX-exported models.* This is the cheapest large
  saving available and it must be a constraint on model selection, not an afterthought.
- **Weights.** FP16 ONNX, rough per-model: SAM 2.1 tiny ~80 MB · Depth Anything V2 small
  ~50 MB · MediaPipe pose+hands ~25 MB · matting (MODNet-class) ~25 MB · semantic regions
  (Mask2Former swin-tiny) ~100 MB · detection (RT-DETR ~65 MB / Grounding DINO ~340 MB) ·
  LaMa ~55 MB. **BiRefNet is ~220M params → ~440 MB in fp16**: best-in-class hair matting,
  too big to bundle — download-only if adopted at all.

| Scenario | Installed | DMG | First-run download |
|---|---|---|---|
| **A. Runtime only, weights on demand** — *chosen default* | ~565 MB | ~225 MB | 80 MB per feature, ~1 GB for everything |
| B. Bundle an offline tier (SAM2-tiny + depth + MediaPipe) | ~710 MB | ~300 MB | optional extras |
| C. Bundle everything | ~1.4–1.7 GB | ~600–750 MB | none |

Two multipliers to watch: a **universal binary** roughly doubles both Electron Frameworks
and the engine bundle (**+~400 MB installed**) — prefer arm64 plus a separate x64 artifact;
and **cv2 at 118 MB is the fattest single item in the engine today**, where a slimmed
OpenCV build plausibly recovers 60–80 MB, offsetting two bundled models for free.

For reference: CapCut ships a few hundred MB and downloads nearly everything per-feature;
Premiere runs to several GB and does not optimise for size at all because Creative Cloud
absorbs the install. FramePilot's positioning sits with CapCut, which is why A is the default.

#### Model distribution — per-feature fetch, never per-app

Copy CapCut's mechanic, because it is the reason nobody minds their downloads: the fetch is
scoped to the *one thing the user just clicked*, and it reads as the feature starting rather
than as a blocker.

- [ ] **A6.4** **Per-feature model packs.** Clicking "Place Behind" fetches SAM2-tiny
      (~80 MB) and nothing else. No feature triggers a download for a capability it does
      not itself need.
- [ ] **A6.5** **The capability manifest gains a `fetchable` state** (extends P0.4). A
      capability is `available` / `fetchable(sizeBytes)` / `unavailable`. `fetchable`
      renders as **"Analyse (downloads 80 MB)"** — honest, sized, and one click — rather
      than a hidden feature or a dead button. `ToolSpec.available` stays **false** for
      `fetchable`: the AI must not silently trigger an 80 MB download mid-run; it offers,
      the user consents (see §6.2).
- [ ] **A6.6** **Downloads are jobs** (A5/§6.3): progress in the status-bar job chip,
      cancellable, resumable, integrity-verified (checksum + signature), and atomic —
      a half-downloaded model is never registered as present.
- [ ] **A6.7** **Offline and locked-down environments:** an air-gapped install path
      (side-load a model pack directory) and a clear offline state. A6.3's no-model
      degradation still holds — manual masking, roto, tracking, duplicate and depth
      ordering never require a download.
- [ ] **A6.8** **Cloud offload is a deliberate decision, not a drift.** CapCut and Adobe
      both send heavy work to servers. FramePilot is desktop-first with on-disk media
      (CLAUDE.md), so shipping frames off-device changes the privacy story materially.
      Default: **local only.** If a hosted backend is ever added it follows the existing
      optional-backend pattern (opt-in, keyed, clearly labelled in-product), the same
      posture `TWELVELABS_API_KEY` already takes (ADR 0070).

- [ ] **A6.1** Licence-scan every candidate, produce a decision table, get maintainer sign-off.
- [ ] **A6.2** Decide execution: bundled local weights vs. optional download vs. hosted
      (mirroring the existing `TWELVELABS_API_KEY` optional-backend pattern, ADR 0070).
      Record env vars in `.env.example` **and** `turbo.json` `globalEnv` in the same change.
- [ ] **A6.3** Define the no-model degradation path: shape + spline masks and manual
      tracking must work with zero models installed. The product is never bricked by a
      missing weight file.

---

## 2. Schema evolution

Additive-optional throughout, following the `effectLayers` precedent. One migration per
version, each with a doc, tests, and a Pydantic mirror.

| Version | Adds | Unblocks |
|---|---|---|
| **v16** | `Clip.maskStack` (A3); `Asset.kind: 'matte'`; `MatteRef` | masks that preview, roto, boolean stacks |
| **v17** | `Clip.transform` (static position/scale/rotation/anchor/opacity/blur/shadow), `crop` keyframable, `Clip.sceneRef` | full transform parity with the brief; clip↔scene binding |
| **v18** | `Clip.compositeStack` + keyframable `depthIndex` (A4) | text behind objects, depth changes over time |
| **v19** | `Clip.attachment` (graphic bound to a tracked point/object) | motion graphics that follow a face/hand/product |
| **v20** | `Project.sceneRefs[]` (sidecar pointers + analyser versions + confidence summary) | persistence across reopen without reanalysis |

Guard rails for every one of them:
- Absent field ≡ today's behaviour, byte-identical round-trip for older projects.
- Never read a new optional field directly — add a sanctioned accessor (`maskStackOf`,
  `compositeStackOf`) the way `effectLayersOf` works.
- `SCHEMA_VERSION` bump + Python mirror + drift test in the same commit.

---

## 3. Phases

### P0 — Foundations and honesty `[ ]`

- [ ] **P0.1** Write ADRs 0091–0095 (§1). No code until they are merged.
- [ ] **P0.2** Complete the A6 licence gate and record the decision table in `docs/`.
- [ ] **P0.3** Assemble the difficult-footage fixture set (§6.1) — this gates every phase's
      Definition of Done, so it exists before Phase 1.
- [ ] **P0.4** Add a **capability manifest**: one typed source of truth for whether each
      compositing capability is `available` / `fetchable(sizeBytes)` / `unavailable` in
      this build (models present or downloadable, GPU present, sidecar reachable). The AI
      tool registry, the Inspector, and the command palette all read it — so an
      unavailable capability is *invisible* rather than a dead button, and a `fetchable`
      one is an honest sized offer (A6.5). Extends the existing `unavailableTools` posture.
- [ ] **P0.5** Add a regression test asserting `generate_mask`/`detect_faces` remain in
      `unavailableTools` until their phase lands — a tripwire against premature exposure.

### P1 — Multi-layer picture compositing in the preview `[ ]` **(hard blocker)**

Everything downstream is unpreviewable until this lands. Nothing else in this plan may
start in parallel except P0 and the P2 schema work.

- [ ] **P1.1** Replace `pictureSegments` (`selectors.ts:372`) with a **layered picture
      model**: `PictureLayer[]`, ordered back-to-front by track z-order, each with its own
      segment list. Keep the existing single-layer output as the degenerate one-layer case
      so nothing regresses.
- [ ] **P1.2** Extend `WebCodecsPreviewEngine` to hold **N decoder sets** and composite
      back-to-front per frame, applying each layer's transform, crop, opacity, blend mode
      and (after P2) mask. Blend modes must match `_blend_layer_over` exactly.
- [ ] **P1.3** Decoder budget: cap simultaneous decoders, prioritise the topmost visible
      layers, degrade lower layers to their last decoded frame rather than stalling the
      clock. Playback must not drop below the current single-layer performance for
      single-layer projects — assert this with a perf test.
- [ ] **P1.4** Parity test: a 3-layer project with overlapping picture clips, blend modes
      and opacity → preview frame vs. exported frame within a pixel tolerance, on desktop-
      scale media.
- [ ] **P1.5** Timeline + Inspector already model layers; verify z-order display matches
      composite order and fix the direction if it does not.

**DoD:** two overlapping picture clips on two layers show *both* in the preview, in the
same order and with the same blend result as the export.

### P2 — Mask stack v2: real masks, previewed, editable `[ ]`

- [ ] **P2.1** Schema v16 (§2) + migration + Pydantic mirror + drift test.
- [ ] **P2.2** TS evaluator `editor-core/src/masks/` — stack resolution, boolean modes,
      feather/expand/opacity/invert, keyframe evaluation. 100% coverage.
- [ ] **P2.3** Python rasterizer — extend `render/masks.py` to the full stack; keep the
      cheap static-mask path.
- [ ] **P2.4** GLSL rasterizer + preview mask stage, wired into P1's per-layer composite.
- [ ] **P2.5** Structural parity tests (TS↔Python) + golden-media parity on a real GL
      context. Mirrors the effect-catalog parity strategy.
- [ ] **P2.6** Reversible ops: `add_mask_entry`, `update_mask_entry`, `remove_mask_entry`,
      `reorder_mask_stack`, `set_mask_keyframes`. Each with `invert`, each validated.
      Deprecate the old single-`add_mask` shape behind a migration.
- [ ] **P2.7** **On-canvas mask editor** (§5.3): drag handles, bezier point editing,
      add/remove point, feather ring, rotation handle. Every handle ≥ 24px hit target
      with a ≥ 44px touch expansion.
- [ ] **P2.8** Inspector "Mask" section rebuilt (§5.4) — list the stack, not one shape;
      per-entry mode/feather/expand/opacity/invert; keyframe diamonds per property.
- [ ] **P2.9** Timeline mask lane (§5.5) with mask keyframes visible and draggable.
- [ ] **P2.10** e2e: add mask → see it in preview → keyframe it → undo → redo → save →
      reopen → export → exported frame matches the preview frame.

**DoD:** a mask the user draws is visible in the preview within one frame, survives
reopen, and exports identically.

### P3 — Scene understanding service `[ ]`

- [ ] **P3.1** `SceneGraph` model (Pydantic + Zod mirror): objects with stable ids, class
      labels from the brief's taxonomy (person / face / hair / hand / arm / body / clothing /
      product / vehicle / building / mountain / hill / tree / plant / furniture / screen /
      sky / ground / wall / window / water / shadow / reflection), per-object spans
      (enter/exit), motion summary (static / panning / approaching), visible-size curve,
      occlusion relations, suitability flags (`goodForText`, `goodForGraphics`,
      `doNotCover`), and per-range confidence.
- [ ] **P3.2** Sidecar store per A1 — write, read, invalidate-by-range, hash keying.
- [ ] **P3.3** Job protocol per A5 — scoped, tiered, cancellable, resumable, progress
      events over the existing sidecar channel.
- [ ] **P3.4** Detection + semantic regions → object identities and classes.
- [ ] **P3.5** Promptable segmentation + propagation (SAM2-class) → per-object mattes,
      written as matte assets (A2). **Temporal stability is a test, not a hope:** measure
      per-frame IoU between consecutive frames and boundary jitter; regressions fail CI.
- [ ] **P3.6** Point/box tracking with confidence, bidirectional, pausable, restartable
      from any frame, with **locked ranges** that automatic passes are forbidden to
      overwrite. **Copy Premiere's mask-tracking control cluster nearly literally** —
      `⏮ ◀◀ ◀ ⏹ ▶ ▶▶ ⏭` (track backward to start / backward / back one frame / stop /
      forward one frame / forward / forward to end), sitting on the mask in the Inspector.
      It is the right model because it treats tracking as **steerable**, not as a job you
      fire and accept: scrub to where it drifted, correct the shape, track onward from
      there. Editors already have the muscle memory; do not invent a new arrangement.
- [ ] **P3.7** Monocular depth → relative ordering proposals; occlusion relations resolved
      per frame.
- [ ] **P3.8** Pose + hands → gesture events (raise hand, point, open hand, present, walk
      in/out, turn, nod) with confidence and an explicit **debounce/hysteresis** rule so
      idle motion does not fire. Gesture events are *suggestions* with timestamps; they
      never auto-apply.
- [ ] **P3.9** Multi-person identity: per-person ids stable across occlusion and
      re-entry; explicit "identity uncertain" ranges rather than a silent id swap.
- [ ] **P3.10** Split / merge / relabel object ops, so a user can correct the machine.
- [ ] **P3.11** Give `object_track` a consumer at last: the render compiler and the preview
      both read tracks through one shared resolver (closes finding 0.2#5).
- [ ] **P3.12** Move `generate_mask` / `detect_faces` out of `unavailableTools` — **in this
      commit, not before** — plus new `analyze_scene`, `segment_object`, `track_object_auto`.

**DoD:** analysis of a 2-minute desktop-scale clip yields a usable draft in < 15s, never
blocks the editor, survives reopen with zero recomputation, and a cancel-then-resume
completes without redoing finished ranges.

### P4 — Text (and anything) behind objects `[ ]`

- [ ] **P4.1** Schema v18 composite stacks + keyframable `depthIndex`.
- [ ] **P4.2** `place_behind_object` op → builds the explicit three-layer stack (A4).
      Deliberately *not* a black box: the user sees the layers it created.
- [ ] **P4.3** Preview + export both composite the stack through the P1/P2 path. No new
      render code path — that is the point of A4.
- [ ] **P4.4** UI: **Place Behind** in the text/graphic Inspector → the preview enters
      object-pick mode → click the object → immediate draft-tier result.
- [ ] **P4.5** Follow modes: fixed in frame / follows camera / follows object / follows
      person, each expressed as ordinary keyframes so the user can edit them.
- [ ] **P4.6** Reveal timing: keyframable, plus optional binding to a gesture event (P3.8).
- [ ] **P4.7** Anti-drift test: on a panning shot, text pinned to a scene point must stay
      within a sub-pixel budget across the shot. Failing that budget fails CI.

**DoD:** "text behind the mountain" works end to end on a moving-camera shot; the text is
still selectable, movable, restyleable, keyframable, and the layers are visible.

### P5 — Clone compositing `[ ]`

Explicitly **layer-based**, not auto-cutout, per the brief.

- [ ] **P5.1** `duplicate_clip` op (closes finding 0.2#8): copies the clip to a target layer
      at a target offset with fully independent identity. **Audio defaults to muted on the
      duplicate**, with a one-click "mix audio" restore and an undo toast explaining it.
- [ ] **P5.2** Entry points: timeline context menu, clip menu, preview context menu,
      `⌘D` shortcut, command palette, AI tool. All five call the same op.
- [ ] **P5.3** Offset controls: drag, exact numeric entry, and snapping to speech, beats,
      gestures, entrances/exits, object interactions — reusing the existing snapping module
      (`preview/snapping.ts`) and beat grid. Snapping toggleable.
- [ ] **P5.4** Per-duplicate independence audit: position, source offset, in/out, speed,
      reverse, freeze, loop, transform, opacity, crop, blur, shadow, audio, mask, keyframes.
      Anything on that list not yet per-clip (blur, shadow, loop) is added in v17.
- [ ] **P5.5** Overlap assistance: propose a split/boundary mask where two performances
      overlap, as an ordinary editable mask stack — never a locked result.
- [ ] **P5.6** Seam cleanup toolkit: feather, edge softness, boundary nudge, exposure match,
      colour match, shadow blend, blur, grain match. Each a normal effect with a preview
      twin, so P1/P2 parity carries it.
- [ ] **P5.7** Seam *detection*: flag exposure/colour deltas and background motion across a
      mask boundary and surface them as timeline confidence marks — a suggestion, not an
      auto-fix.

**DoD:** a three-clone conversation scene built entirely from duplicated clips, masks and
keyframes; each layer independently editable; exports matching the preview.

### P6 — Background replacement `[ ]`

- [ ] **P6.1** `replace_background` builds an explicit stack: replacement layer → subject
      layer masked by the person matte. Sources: video, image, solid, blurred original,
      stylised, transparent.
- [ ] **P6.2** Edge quality: matting refinement pass for hair/fine edges; `final` tier only
      improves edges, never geometry (A2).
- [ ] **P6.3** Controls: refine subject (add/remove regions), restore original background
      areas, edge softness, replacement blur/scale/position/movement, colour and lighting
      match, contact-shadow toggle, background brightness/focus.
- [ ] **P6.4** Camera-motion handling: replacement can be pinned to camera motion so it
      does not feel pasted.

### P7 — Object removal `[ ]`

- [ ] **P7.1** Removal region = an ordinary mask stack (reuse, do not invent).
- [ ] **P7.2** Reconstruction: reference-frame search (the same background seen elsewhere)
      → homography warp → inpainting fill for what no frame ever saw. Prefer real pixels
      over generated ones; generate only what must be generated.
- [ ] **P7.3** Temporal coherence checks that *detect* smearing/ghosting/frozen patches and
      mark those ranges uncertain rather than shipping them silently.
- [ ] **P7.4** User-chosen reference frames when automatic selection is weak, and per-range
      retry from a chosen frame.
- [ ] **P7.5** Honest refusal: when no reference exists and inpainting confidence is below
      threshold, say so on the affected range. Do not fill and hope.

### P8 — Motion graphics and gesture-aware effects `[ ]`

- [ ] **P8.1** Schema v19 `attachment`: bind a graphic to an object, a tracked point, or a
      body landmark, with offset, distance, and orbit parameters — all keyframable.
- [ ] **P8.2** Graphic primitives: title, label, callout, arrow, circle, outline, glow,
      data label, highlight stroke, animated path, hand-drawn stroke. Built on the existing
      overlay painter + effect-catalog pattern so each has a Python twin.
- [ ] **P8.3** Depth interaction: behind / in front / animated transition between them via
      `depthIndex` keyframes (P4 machinery, no new concepts).
- [ ] **P8.4** Wrap-around-body effect = graphic layer + subject-matte layer above it; the
      "wrap" is just correct depth, which is why A4 matters.
- [ ] **P8.5** Gesture triggers from P3.8, surfaced as **suggested** keyframes the user
      accepts, adjusts, or dismisses. Never auto-applied.

### P9 — Automatic B-roll behind the subject `[ ]`

- [ ] **P9.1** Topic segmentation of the transcript → candidate insert windows respecting
      pacing and tone.
- [ ] **P9.2** Relevance ranking over project media using the existing brain
      (`visual_search`, `map_footage`, `find_similar`) — reuse, do not rebuild.
- [ ] **P9.3** Placement: B-roll layer beneath the subject matte, so the speaker stays
      readable; composition-aware so it does not cover a `doNotCover` region or an active
      gesture (P3.1 suitability flags).
- [ ] **P9.4** Review UI: a suggestion strip — accept / reject / replace / retime / reorder,
      with darken, blur, movement, layout, depth, and transition controls per suggestion.
- [ ] **P9.5** Everything lands as ordinary clips on ordinary layers. Rejecting a suggestion
      is a normal delete; accepting is a normal patch.

### P10 — The AI SDK surface `[ ]`

**Full specification in §6.** P10 is not a wrapper bolted on at the end: each feature phase
ships its own tools, skills and honesty tests as part of its Definition of Done (§6.8), and
P10 is the integration, budget and regression work that only makes sense once the surface
is complete.

- [ ] **P10.1** Registry integration pass: capability gating, scoping tags, cost/latency
      hints, concurrency classification for every compositing tool (§6.2, §6.6).
- [ ] **P10.2** Context builder scene digest — token-budgeted and cache-stable (§6.5).
- [ ] **P10.3** Feasibility gate and job protocol wired through the orchestrator (§6.3).
- [ ] **P10.4** Skills pack authored and existing skills reconciled (§6.7).
- [ ] **P10.5** Honesty + parity regression suites (§6.8).
- [ ] **P10.6** MCP surface review: sandbox, permissions, docs (§6.9).

### P11 — QA, performance, and hardening `[ ]`

See §7.

---

## 4. Cross-cutting invariants

Every phase's Definition of Done must re-assert these. They are the plan's real acceptance
criteria.

1. **Preview ≡ export.** Any new visual capability ships with a parity test before it ships
   with UI. If it cannot be previewed, it does not ship.
2. **Every mutation is a typed, validated, invertible op.** No feature writes
   `project.fp.json` directly. Undo/redo works for every step of every workflow.
3. **User corrections are sacred.** Locked ranges and manual edits are never overwritten by
   an automatic pass without explicit confirmation. Automatic results carry provenance
   (`source: 'auto' | 'user'`) so this is checkable, not aspirational.
4. **Fail closed, and say so.** Low confidence surfaces as a marked range and a preserved
   last-good result. Never a silent guess, never a fabricated success.
5. **Persistence is per-asset and content-addressed.** Reopen, restart, proxy regeneration
   and timeline edits never trigger reanalysis. Only changed media does.
6. **The editor never freezes.** Analysis, tracking and inpainting are background jobs with
   progress and cancel. Playback stays smooth throughout.
7. **Desktop is the target** (CLAUDE.md). Performance work is measured against real camera
   files, minutes long — not fixtures.

---

## 5. UI / UX specification

Direction: **CapCut's approachability, Premiere's precision, Linear's restraint.**
CapCut wins the *entry* (one click does something, the hard controls appear as you need
them); Premiere wins the *depth* (lanes, keyframes, numeric entry, everything addressable);
Linear/Notion set the *chrome* (quiet surfaces, content leads, keyboard first). Where
CapCut and Premiere disagree, CapCut wins the default and Premiere wins the ceiling.

Extend `packages/ui/src/tokens.css` — do not fork it. One accent (`--accent` `#3d7eff`),
hierarchy from opacity/weight/size, 4px grid, 120–180ms ease-out motion,
`prefers-reduced-motion` respected, light and dark under the same token names.

> Note on the `/ux-psychology-extractor` skill: it extracts principles from a *source*
> (video, transcript, article), and none was provided. Rather than invent an extraction,
> §5.9 states the established principles this spec is actually applying, so each UI
> decision is traceable to a reason. Point that skill at a real source and I will fold the
> result in.

### 5.1 Diagnosis of the surfaces being changed

Per the top-design-patterns diagnose phase, applied to the three screens this plan touches:

| # | Finding | Evidence | Impact |
|---|---|---|---|
| 1 | The Mask section's one job — "shape the visible region" — cannot be done. It can only *create*, never inspect or edit. | `Inspector.tsx:215-246` | Blocking |
| 2 | Adding a mask is a 4-interaction path (open Inspector → expand section → set 3 controls → Add) and produces **no visible feedback**. | `Inspector.tsx:184` | Blocking |
| 3 | No empty / loading / error / uncertain states exist for any analysis surface, because no analysis exists. | — | High |
| 4 | The preview is a display surface, not an editing surface: nothing in it is clickable. | `WebCodecsPreviewPlayer.tsx` | High |
| 5 | The timeline cannot show keyframes, masks, or tracking ranges, so nothing generated is inspectable. | `TimelineView.tsx` | High |
| 6 | No keyboard path to any compositing action; no palette entries. | — | Medium |
| 7 | The Inspector will not survive 17 more sections without grouping. | `inspector/registry.ts` | Medium |

### 5.2 The Scene panel (new)

A new right-rail tab beside Inspector / AI / Transcript. **This is the signature surface** —
the one thing that makes FramePilot legibly different from a filter stack.

```
┌ Scene ─────────────────────── ⟳ ─┐   ⟳ = re-analyse (subtle, hover-revealed)
│ ▸ analysing 0:12–0:38  ▓▓▓▓░░ 62%│   thin accent progress bar, cancel on hover
├──────────────────────────────────┤
│  ⠿ ▣  Hand              front  ◉ │   ⠿ drag = depth · ◉ visibility · thumbnail chip
│  ⠿ ▣  Person            ·····  ◉ │
│  ⠿ ▣  Building          ·····  ◉ │
│  ⠿ ▣  Mountain          ·····  ⊘ │   ⊘ = low confidence in this range
│  ⠿ ▣  Sky               back   ◉ │
├──────────────────────────────────┤
│  + Select object in preview      │   inline creation, Notion-style
└──────────────────────────────────┘
```

- Rows are 36px, thumbnail chip 28px showing the object's matte over its frame — recognition
  over recall; nobody should have to decode "Object 3".
- Drag to reorder = a `set_depth_order` op with a drop-indicator line and live preview.
- Names are **edit-in-place**: click, type, `Enter` saves, `Esc` reverts.
- Hovering a row highlights that object in the preview (1px accent outline + 6% accent
  fill). Hovering the object in the preview highlights the row. Bidirectional, always.
- The confidence glyph is the *only* place a non-accent colour appears in this panel, so
  uncertainty is impossible to miss (Von Restorff).

### 5.3 The preview becomes an editing surface

- **Object pick mode** — hover paints candidate objects; click selects; `Esc` exits.
  Entered by the Scene panel's `+`, by "Place Behind", or by pressing `O`.
- **Mask handles** — corner/edge handles, rotation handle above the top edge, a feather
  ring dragged inward/outward, bezier points with tangent handles. `Alt`-click adds a
  point, `Alt`-click on a point removes it. Handles are 10px visually with a 24px hit box.
- **Transform handles** — the standard 8 + anchor-point crosshair, `Shift` constrains,
  `Alt` scales from the anchor.
- **Track path overlay** — the tracked point's path as a hairline with keyframe dots;
  weak-confidence stretches drawn dashed.
- **View modes**, one segmented control, no menu: `Result · Original · Mask · Depth ·
  Isolate`. `\` toggles Result/Original for the before/after comparison every editor does
  constantly.
- **Uncertain-range navigation** — `[` / `]` jump to the previous/next uncertain frame.
- **Add a keyframe from the preview** — dragging a transform or mask handle while the
  property is animated writes a keyframe at the playhead, exactly as CapCut and Premiere do.

Performance rule: overlays draw on a separate compositing layer above the video canvas.
Nothing about the pick/handle UI may touch the video canvas or the frame clock — that
isolation was hard-won in the WebCodecs work and must not be undone.

### 5.4 The Inspector, regrouped

The existing `inspector/registry.ts` (`order` + `appliesTo`) is exactly the right
mechanism — this is a re-grouping, not a rewrite.

Sections in order, each hidden unless it applies:
`Transform · Mask · Tracking · Depth & Layers · Scene Object · Background · Removal ·
Graphics · Clone · Edge Cleanup · B-roll · Effects · Speed · Audio · Export Quality`

Rules:
- **Two tiers per section.** Basic controls are always visible; advanced ones live behind a
  one-line "More" disclosure. CapCut's defaults, Premiere's ceiling.
- **A keyframe diamond sits on every animatable property row** — the existing
  `useKeyframeState` five-state diamond is already built for this. Reuse it everywhere.
- **Every numeric field is drag-scrubbable and directly typeable**, `tabular-nums`,
  `Shift` = coarse, `Alt` = fine. This is the single highest-leverage precision affordance
  Premiere has and CapCut lacks.
- **Confidence, when relevant, is a row inside the section it qualifies** — never a
  separate panel. Uncertainty belongs next to the thing that is uncertain.

### 5.5 The timeline

Premiere's expandable track, CapCut's readability.

```
▾ V2  clone-b            ┌───────────────────────┐        ← clip, 40px
   masks                 │ ◆────◆──────────◆     │        ← 14px sub-lane
   tracking              │ ▓▓▓▓▓▓░░░░▓▓▓▓▓▓      │        ← ░ = low confidence
   transform             │ ◆──────◆              │
   effects               │ [ glow ][ blur ]      │
▸ V1  main               └───────────────────────┘        ← collapsed: one 40px row
```

- **Collapsed by default.** A disclosure triangle expands sub-lanes. A project with 40
  effects stays readable because detail is opt-in (progressive disclosure).
- Sub-lanes are 14px; keyframes are 7px diamonds; multi-select with marquee and
  `Shift`-click; drag to retime; `⌘C`/`⌘V` copies keyframes and masks between clips.
- **Effect/analysis ranges** are chips with the effect's own glyph, not coloured bars —
  colour stays reserved for media type and the playhead, per `DESIGN_SYSTEM.md`.
- **Confidence** renders as a hatched band on the tracking lane. Clicking it jumps the
  playhead to the weakest frame.
- **Analysis in progress** shimmers only over the range being analysed — the goal-gradient
  cue that makes waiting legible.
- Layer rows get: rename in place, group, lock, solo, hide, and a colour label.

### 5.6 Progress, waiting, downloads, and the cache

- A **status-bar job chip** — `Analysing 3 clips · 62% · ✕`. Click expands a popover
  listing jobs with per-job cancel. Never a modal, never a blocking overlay.
- Draft results appear as soon as they exist and **refine in place**; the refinement must
  not shift layout or flash (Doherty threshold: something real within 400ms, always).
- Cancel is instant and keeps partial results. A cancelled job says what it completed.

**Model downloads read as the feature starting, not as a gate** (A6.4–A6.6). This is the
whole reason CapCut's per-effect download rings are tolerable while a monolithic first-run
download would not be:

- A `fetchable` capability's button states its size — **"Place behind object (80 MB)"** —
  so the click is informed, never a surprise.
- Clicking it starts the download *and* queues the work behind it. Progress appears on the
  control the user pressed, and in the job chip. The user keeps editing.
- Downloads are resumable and verified; a failed one restores the `fetchable` state with a
  plain-words reason and a Retry, never a half-installed capability.

**Cache management** (A1.1–A1.3), in Settings → Media & Analysis — the surface CapCut never
built and Premiere gets right:

```
Analysis cache          4.2 GB of 20 GB
Location   ~/Library/Application Support/FramePilot/analysis   [ Change… ]
Limit      [ 20 GB ▾ ]   older results are removed automatically
                                                      [ Clear cache… ]
Models     3 installed · 1.1 GB                       [ Manage… ]
```

`Clear cache…` names what it removes and what will need recomputing, and states plainly
that **your masks, roto shapes, tracking corrections and locked ranges are project data
and are never removed** — the distinction that makes the button safe to press.

### 5.7 Keyboard and command palette

Single-key, in context, no text field focused:

| Key | Action | | Key | Action |
|---|---|---|---|---|
| `M` | add mask | | `⌘D` | duplicate clip to layer above |
| `T` | track forward | | `⌘⇧D` | duplicate in place |
| `⇧T` | track backward | | `B` | place behind object |
| `O` | object pick mode | | `\` | toggle original / result |
| `K` | keyframe at playhead | | `[` `]` | prev / next uncertain frame |
| `⌘K` | command palette | | `?` | shortcut sheet |

Every compositing action is reachable from `⌘K`, grouped by category, recents first, with
the shortcut shown beside it. Focus moves into overlays, is trapped, and returns to the
trigger on close.

### 5.8 States, errors, and undo

- **Empty (no analysis):** one line — "Nothing analysed yet" — plus **Analyse this clip**
  and a one-line note on what it will find. No illustration, no "Oops".
- **Empty (analysed, nothing found):** "No objects detected in this range" + **Try a
  different range** + **Select manually**. Different from first-run, deliberately.
- **Loading:** skeleton rows in the Scene panel matching the final row shape, so nothing
  shifts when results land. Spinners only inside buttons.
- **Error:** what failed, in plain words, and a **Retry**. `"Segmentation failed on
  0:12–0:20 — the subject leaves the frame. Retry from 0:14"` — name the fix.
- **Uncertain:** never an error. The last stable result stays on screen, the range is
  marked, and the fix is offered.
- **Destructive actions run immediately with an 8-second Undo toast.** Confirmation dialogs
  are reserved for the genuinely irreversible, and their buttons name the thing
  ("Delete 3 masks", never "OK"). No `window.confirm`, anywhere.

### 5.9 The principles behind these choices

Stated rather than implied, so future changes can argue with them:

- **Jakob's law** — CapCut and Premiere conventions are load-bearing. Handles, lanes,
  diamonds and `⌘D` behave the way editors already expect. Novelty is spent on the Scene
  panel alone.
- **Progressive disclosure / Hick's law** — collapsed lanes, two-tier Inspector sections,
  capability-gated controls. Beginners see few choices; professionals reach all of them.
- **Recognition over recall** — thumbnail chips, named objects, bidirectional
  preview↔panel highlighting.
- **Doherty threshold** — draft tier exists so *something real* appears in under 400ms of
  perceived wait. Optimistic local state for every edit that almost always succeeds.
- **Goal-gradient + Zeigarnik** — visible, ranged, per-clip progress rather than one global
  bar; partial results are kept, so an interrupted job is resumable rather than wasted.
- **Von Restorff** — one accent, so the single non-accent colour (confidence) is the thing
  the eye finds.
- **Miller's law** — Inspector sections chunk ~5–7 controls; more goes behind "More".
- **Fitts's law** — on-canvas handles carry hit boxes far larger than their paint.
- **Peak-end rule** — the export moment gets deliberate care: a real preview of what will
  render, honest reporting of any uncertain range, and no surprises after the wait.
- **Loss aversion** — Undo over confirm, everywhere; user corrections are never silently
  overwritten; locked ranges are respected by machines.

---

## 6. The AI SDK surface

**Every capability in this plan is reachable from `packages/ai-sdk` — and therefore from
Agent mode, from the desktop AI sidebar, and from external agents over MCP — on the same
day it becomes reachable from the UI.** Not a later port: a phase is not done until its
tools, skills and honesty tests exist (§6.8).

The infrastructure for this already exists and is good. This section is mostly about using
it correctly rather than building anything new.

### 6.1 What the existing surface already gives us

| Mechanism | Where | How this plan uses it |
|---|---|---|
| `ToolSpec` with `mutates` / `available` / `kind` / `capabilities` / `permissions` / `cost` / `latency` | `tool-registry.ts:104-148` | Every new tool declares all of them; nothing is derived by accident |
| `buildOps` — mutating tools emit **typed ops**, never raw project mutations | `tool-registry.ts` | Compositing tools reuse the P2/P4/P5 ops. An AI edit and a UI edit produce byte-identical timelines |
| **MCP auto-derivation** — `TOOL_REGISTRY.filter(t => t.available && !t.hostUiOnly)` | `mcp-server/src/tools.ts:85` | External agents get every compositing tool for free, and an unavailable one is automatically hidden. One lever, three consumers |
| TS ↔ Python registry parity tests | `ai_tools/registry.py`, existing parity tests | Same tool surface whether the caller is the browser orchestrator or the sidecar |
| `unavailableTools` — honest refusal | `tool-registry.ts:2016` | The default posture for every capability until it is real |
| Skills loaded on demand (`load_skill`, 21 playbooks) | `packages/ai-sdk/skills/` | Compositing craft is taught, not hardcoded into the system prompt |
| Fail-closed run contracts (ADR 0083 empty-mutation, ADR 0087 objective-complete) | `run-contracts.ts`, `conductor.ts` | Extended to compositing rather than duplicated |
| Memory Store (PRD §8.7) | `memory-store.ts` | Accepted/rejected compositing suggestions learn here — **no parallel store** |

### 6.2 Capability gating: one manifest, three consumers

P0.4's capability manifest becomes the input to `ToolSpec.available`. Because MCP already
filters on `available` and the orchestrator already refuses unavailable tools, a single
truthful answer to "can this build actually segment video?" propagates to the model's tool
list, the MCP descriptor set, and the Inspector's affordances.

Rules:
- `available` is computed from the manifest at registry construction, **not hardcoded**.
- A capability that is present but degraded (no GPU → CPU-only, minutes not seconds)
  stays `available: true` and raises its `latency` hint, so the planner routes around it
  instead of being lied to about it.
- **`fetchable` maps to `available: false`** (A6.5). An agent must never silently trigger
  an 80 MB download mid-run — the user consented to an edit, not to a network transfer.
  Instead the tool's unavailable-reason carries the offer (`"segmentation model not
  installed — 80 MB download"`), so the agent can *say* what it would need and let the
  user accept. This is the same honest-refusal shape `generate_mask` uses today, with an
  actionable next step attached. `ask_user` is the sanctioned way to obtain that consent.
- Manual capabilities (shape masks, spline roto, manual tracking, duplicate, depth order)
  are **always available** — they need no model. The AI can do real compositing work on a
  build with zero weights installed.
- **P0.5's tripwire test generalises:** a test asserts that no tool is `available` unless
  its capability is in the manifest *and* its phase is checked off in this document.

### 6.3 Long-running work: the job-handle contract

Scene analysis, tracking propagation and inpainting take minutes. Today's `action` tools
(`render_preview`, `export_video`) and `analysis` tools assume a call returns a result. A
compositing agent that blocks a run for four minutes is a broken agent.

New `kind: 'job'` (or an equivalent `async: true` flag on `analysis`/`action` — decide in
the ADR):

```
analyze_scene(assetId, range, capabilities[], tier)  →  { jobId, accepted: true, estimateSeconds }
get_job_status(jobId)  →  { state, progress, completedRanges[], failedRanges[], partial }
cancel_job(jobId)      →  { cancelled: true, completedRanges[] }
```

Contract:
- The call returns immediately. The agent continues planning, or tells the user analysis
  started and what it will be able to do when it finishes.
- Partial results are usable: `draft`-tier objects are queryable while `final` is still
  running, so the agent can propose an edit before analysis completes and refine after.
- A failed range is reported as failed with a reason. It is never reported as empty.
- Job events stream through the existing sidecar event channel, so the AI sidebar's live
  activity surface shows analysis progress the same way it shows tool activity.

### 6.4 The tool surface

Grouped by phase. Every mutating tool emits the same typed ops the UI uses.

**Scene understanding (P3)**
| Tool | Kind | Notes |
|---|---|---|
| `analyze_scene` | job | Scoped to asset + range + capabilities + tier |
| `get_job_status` / `cancel_job` | read / action | §6.3 |
| `list_scene_objects` | read | **Compact summary only** — see §6.5 |
| `get_scene_object` | read | One object: spans, motion summary, occlusions, suitability, confidence |
| `segment_object` | job | Promptable: point, box, or class name ("the mountain") |
| `track_object_auto` | job | Direction, range, start frame; respects locked ranges |
| `split_scene_object` / `merge_scene_objects` / `relabel_scene_object` | mutate | The agent can correct the machine, as the user can |
| `list_gesture_events` | read | Timestamped, confidence-scored, never auto-applied |

**Masking (P2)**
`add_mask_entry` · `update_mask_entry` · `remove_mask_entry` · `reorder_mask_stack` ·
`set_mask_keyframes` · `get_mask_stack` — all `mutate`/`read`, all backed by P2.6's ops.
This finally makes "mask the right side of the duplicate" and "track this mask until the
person exits" expressible.

**Depth and layering (P4)**
`place_behind_object` · `set_depth_order` · `get_composite_stack` · `set_depth_keyframes`.
`place_behind_object` is deliberately a *composition* of `add_layer` + `add_mask_entry` +
`set_depth_order` — the agent can see and the user can edit exactly what it built.

**Clone compositing (P5)**
`duplicate_clip` (target layer, offset, audio policy) · `set_clip_offset` ·
`suggest_overlap_masks` · `match_layer_grade` (seam cleanup) · `detect_seams` (read).

**Background, removal, graphics, B-roll (P6–P9)**
`replace_background` · `refine_subject` · `remove_object` · `set_removal_references` ·
`attach_graphic` · `set_attachment` · `suggest_broll` · `apply_broll_suggestion`.

**Transform completeness (P5.4 / v17)**
`set_clip_transform` (static position/scale/rotation/anchor/opacity/blur/shadow) and crop
keyframing, so the brief's full property list is addressable by the model, not just by the
Inspector.

### 6.5 Context discipline — the part most likely to go wrong

A scene graph for one clip is megabytes. Putting per-frame geometry anywhere near the model
would blow the context budget, destroy prompt-cache stability, and teach the model to
reason about numbers it cannot hold.

**Hard rules:**
1. **Per-frame data never enters context.** Not mask geometry, not track points, not
   mattes. The agent refers to objects by **stable id**; the ops resolve the geometry.
2. `list_scene_objects` returns a bounded digest: id, label, span, a one-word motion
   summary, occlusion relations by id, suitability flags, confidence band. Capped at N
   objects by visual prominence, with a truthful `truncated` count.
3. The **context-builder scene block** covers only the selected/visible range and sits in a
   cache-stable position — it must not invalidate the prompt cache on every playhead move.
   Recompute on selection change, not on scrub.
4. Token budget for the scene block is explicit and tested, the same way the existing
   context blocks are budgeted.
5. `describe.ts` gains compositing-aware summaries so the agent can *say* what it built
   ("three layers: your clip, the caption, and the mountain masked from your clip") without
   re-reading the timeline.

### 6.6 Planning, cost and concurrency

- **Cost/latency hints are load-bearing**, not decoration: `list_scene_objects` is cheap,
  `analyze_scene` at final tier is expensive. The planner should prefer reading existing
  analysis over triggering new analysis — cache-first is a planning behaviour, not just a
  storage one.
- **Concurrency classification** (`tool-classification.ts`, `concurrency.ts`): reads are
  concurrency-safe; job submissions are safe; mutations serialise. Analysis jobs against
  *different* assets may run in parallel up to the sidecar's budget.
- **Scoping tags** (`tool-scope.ts`): `capabilities: ['scene-analysis']`,
  `['compositing']`, `['masking']` so scoped descriptor sets can expose a compositing-only
  agent without the whole registry.
- ~~**`wipe-guard.ts` must learn about compositing.**~~ **Dropped (ADR 0166).** The wipe
  guard was removed on 2026-08-30 because it refused legitimate track clears; there is no
  trigger list to extend. A destructive compositing edit is reversible the same way every
  other operation is — through the patch engine's inverse — not through a refusal.

### 6.7 Skills — teaching the craft, not the API

New playbooks in `packages/ai-sdk/skills/`, written by the `editing-skills-expert` agent
and grounded in the *actual* registry and schema:

- `scene-understanding.md` — when to analyse, what tier, how to read confidence, when to
  stop and ask.
- `masking-and-roto.md` — stack order, boolean modes, when a shape beats a matte, feather
  and expand as craft not settings.
- `depth-and-layering.md` — the three-layer text-behind pattern, depth keyframes, why
  explicit layers beat a black box.
- `clone-compositing.md` — the twelve-step CapCut-style workflow from the brief, audio
  policy, seam cleanup order.
- `background-and-removal.md` — reference frames before generation; refusing when
  reconstruction is unsupported.
- `motion-graphics-attachment.md` — attachment points, orbit vs. follow, gesture triggers
  as suggestions.

Reconcile the two existing skills this overlaps: **`broll-and-layering.md`** (currently
describes layering without the mattes to do it properly) and **`keyframe-animation.md`**
(gains mask, depth, and attachment properties).

### 6.8 Honesty and parity — the acceptance gate

Per-phase Definition of Done additions, so the AI surface cannot lag:

- [ ] **AI-DoD-1** Every capability shipped in the phase has a tool in the TS registry, a
      mirror in `ai_tools/registry.py`, and a passing parity test.
- [ ] **AI-DoD-2** A test proves the tool's `buildOps` output produces a timeline
      **deep-equal** to the manual UI path for the same edit. This is the effect-layers
      precedent (schema v13 shipped exactly this proof for seven tools) and it is the
      strongest guarantee that AI edits genuinely reach the timeline.
- [ ] **AI-DoD-3** The phase's tools appear in the MCP descriptor set when available and
      are absent when not — asserted, not assumed.
- [ ] **AI-DoD-4** Honesty regression: for each natural-language phrasing in the brief
      ("put this text behind the mountain", "reveal the text when I raise my hand",
      "create a clone effect from this clip", "offset the second clip by five seconds",
      "mask the right side of the duplicate", "make the left version walk behind the right
      version", "replace the background with this video", "remove the person in the
      background", "add relevant B-roll behind me", "wrap graphics around the presenter",
      "make this label follow the product", "track this mask until the person exits"), a
      success report implies a non-empty, validated, **applied** patch — and a refusal is
      returned when the capability or the required object is genuinely absent.
- [ ] **AI-DoD-5** A test that the agent never reports a completed edit while an analysis
      job it depends on is still running or has failed ranges in the edited span.
- [ ] **AI-DoD-6** Context budget test for the scene block, and a prompt-cache stability
      test (scrubbing the playhead must not invalidate the cache).

### 6.9 MCP and security review

- External agents reach the whole compositing surface automatically through
  `mcp-server/src/tools.ts`. That is the intent — and it widens the attack surface.
- **Blocking review by `security-reviewer` before P3 ships:** matte and scene-sidecar
  paths must stay inside the existing path sandbox; `analyze_scene` must not accept an
  arbitrary filesystem path (asset ids only); job ids must be unguessable and
  session-scoped; cancel must not let one session cancel another's jobs.
- Model download/execution (if A6 chooses local weights) is a new privileged operation and
  needs an explicit IPC surface decision — CLAUDE.md §5 requires asking before broadening
  the IPC surface or the sandbox.
- `packages/mcp-server` docs updated in the same change, per the mcp-engineer's ownership
  of keeping the MCP surface in sync with the canonical registry.

---

## 7. Quality assurance

### 7.1 The difficult-footage fixture set (built in P0, gates every phase)

Static camera · moving camera · handheld shake · zoom · pan · rotation · fast subject
motion · motion blur · hair movement · hand gestures · multiple people · subject overlap ·
occlusion and re-entry · low light · blown highlights · similar fg/bg colour · reflections ·
shadows · transparent regions · focus pulls · vertical and horizontal · 1080p and 4K ·
long (10min+) and very short (< 1s) clips · proxy vs. original.

Keep them small where possible (short representative segments) but include at least two
genuinely desktop-scale files, because per CLAUDE.md performance conclusions from tiny
fixtures are not conclusions.

### 7.2 Test layers

| Layer | Covers | Gate |
|---|---|---|
| Unit (TS) | mask evaluator, depth resolution, ops apply/invert, scene-graph selectors | **100% on core deterministic modules** |
| Unit (Python) | rasterizer, matte I/O, job protocol, invalidation | 100% on the same modules |
| Parity (structural) | TS ↔ Python ↔ GLSL spec resolution | every mask source and effect kind |
| Golden media | rendered frames vs. committed references, real GL context | every visual feature |
| Preview↔export parity | preview frame vs. export frame, pixel tolerance | every visual feature |
| Temporal stability | frame-to-frame IoU, boundary jitter, track drift | thresholds fail CI |
| Persistence | save → close → reopen → restart → proxy regen → export | every phase |
| Undo/redo | every op, including multi-step AI proposals | every phase |
| Performance | playback fps, interaction latency, memory, analysis throughput on desktop-scale media | budgets fail CI |
| **App size** | packaged macOS DMG and installed `.app` | **budget fails CI** — see 7.2.1 |
| **Cache behaviour** | eviction order, relocation, clear-cache scope, archive round-trip | never evicts user-authored data |
| e2e (Playwright) | request → timeline → preview → refine → undo → save → reopen → export | one per feature |
| AI honesty | success report implies applied, validated patch | every compositing tool |

#### 7.2.1 App-size gate

App size triples quietly when nobody watches it. Add a CI check on the packaged macOS
artifacts, with the measured 2026-07-31 baseline (521 MB installed / 205 MB DMG) as the
reference point and Scenario A (§A6) as the target:

- [ ] **Budget:** DMG **≤ 260 MB**, installed `.app` **≤ 620 MB** for the default arm64
      build. Breaching it fails the build with a per-component diff against the last green
      run, so the *cause* is in the failure output, not a scavenger hunt.
- [ ] **Bundled weights are zero by default.** A test asserts no model weights are inside
      the packaged app — the mechanism that keeps Scenario A from silently becoming C.
- [ ] Track `Resources/engine` separately: it is 46% of the app today and cv2 alone is
      118 MB, so a slimmed OpenCV build is tracked as a **size-recovery task**, not a
      vague intention.

### 7.3 The explicit "must never happen" list

Each becomes a named test, not a hope: mask flicker · edge shake · halos · missing body
parts · mask identity swap · text over foreground · track drift · sudden shape change ·
visible cutout edges · background seams · preview/export mismatch · effects lost on reload ·
frozen playback · silent AI failure · unnecessary reanalysis · broken undo · loss on reopen.

---

## 8. Risks and how the plan handles them

| Risk | Handling |
|---|---|
| **Three-runtime mask drift** (TS/Python/GLSL) | One spec, generated param vocabulary, structural + golden parity tests — the ADR 0088 playbook that already held for 41 effect kinds |
| **Licence contamination** from segmentation/inpainting models | A6 gate before any dependency; named rejects recorded up front |
| **Preview performance collapse** under N decoders | P1.3 decoder budget + a perf test asserting single-layer projects do not regress |
| **Cache size** (mattes are big) | Tiered storage, per-object, LRU eviction of `final` tiers with `draft` retained; explicit cache-size UI |
| **Scope** — this is the largest initiative in the repo | Phases are hard-ordered; P1 and P2 deliver standalone value (masks that work) even if P3+ slips |
| **Model quality below "professional"** | Confidence is a first-class product surface, not a failure. Manual roto + manual tracking must be genuinely good, so the product is complete when the model is uncertain |
| **Schema churn** (v16→v20) | One version per phase, additive-optional, sanctioned accessors, migration tests — no phase bumps two versions |

## 9. Out of scope (stated, so it is a decision and not a gap)

- Generative *video* backgrounds (P6 covers supplied and stylised backgrounds; text-to-video
  is a separate initiative).
- 3D camera solve / true 3D scene reconstruction. Depth here is monocular and relative,
  used for ordering — not for 3D placement.
- Real-time full-resolution final-tier segmentation during playback. Draft tier plays;
  final tier is background work.
- Multi-user or collaborative compositing.

---

## 10. Immediate next actions

1. `[ ]` Maintainer decision on the A6 dependency/licence table — **blocks P3, nothing else.**
2. `[ ]` Write ADRs 0091–0095.
3. `[ ]` Build the P0.3 fixture set.
4. `[ ]` Start **P1** — multi-layer picture compositing in the preview. It is the one
   change that unblocks every feature in this document, and it delivers correctness value
   (preview/export parity for blend modes and overlapping layers) even on its own.
