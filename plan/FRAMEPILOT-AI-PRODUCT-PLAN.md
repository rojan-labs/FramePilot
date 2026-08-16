# FramePilot — AI Video Editor: End-to-End Product Plan

> **Status:** **Horizon 0 shipped (2026-07-10)**, **Horizon 1 shipped (2026-07-11)** — H1.1
> through H1.7 all complete (see each H1.x entry below and `plan/PLAN.md` for full
> breakdowns); Horizon 2 not yet started. The **master product roadmap** for making
> FramePilot the best AI video editor *for video editors*. Written from the editor's point of
> view, for the **end product** — not an MVP. It covers everything we must build: new
> **capabilities**, new **tools**, **AI-model integrations** (perception + generation), schema
> evolution, and a **rewritten, best-in-class editor UI** — end to end from raw footage to a
> published short.
>
> **Two decisions baked into this revision:**
> - **AI does the hard perception & generation, not us.** Transcription, vision/content
>   understanding, background removal, voiceover, and generative b-roll are delivered by
>   **AI models** (hosted APIs + optional local models), behind one provider abstraction — we do
>   **not** build our own CV/ML/generative stack. Our job is to *sample media → call the model →
>   turn the result into validated, reversible edits*, honestly and cheaply.
> - **The UI gets rewritten.** The editor surface is upgraded to a genuinely usable, beautiful,
>   pro-grade UI — a dedicated workstream (**WS-J**) referencing **DaVinci Resolve**, **Adobe
>   Premiere Pro**, and **CapCut**.
>
> **Out of scope for now (explicit):** an owned/bundled **music catalog** (users import their own
> audio; beat-sync and ducking still work on it) and **collaboration/sharing** (single-user for
> now).
>
> **Relationship to other plans.** The orchestration maturity work is **Workstream A**; its
> task-level detail lives in [`AGENT-NATIVE-COMPLETION-PLAN.md`](./AGENT-NATIVE-COMPLETION-PLAN.md).
> This document is the product superset.
>
> **Audience:** anyone picking up a piece of the product. Every capability is tagged with what it
> needs — `[model]` `[engine]` `[schema+migration]` `[editor-core op]` `[AI tool]` `[UI]` `[pkg]` —
> and honors the build order (the media/model integration ships *before* the AI behavior that
> calls it).

---

## 1. Product thesis & north star

**Who we serve — priority order.** (1) **Short-form creators** (Reels/TikTok/Shorts/LinkedIn):
talking-head + b-roll + captions + music, tight pacing, platform-native. (2) **Repurposers**:
long recording (podcast/webinar/stream) → many shorts. (3) **Long-form creators** (YouTube,
courses): silence-cutting, chaptering, pacing. Designed for (1) first; generalizes up.

**The thesis (the product's spine):**

> **Automate the mechanical, co-pilot the creative — and let the editor judge everything by
> watching.** The tedious work editors hate (transcribe, remove silence, caption, sync to beat,
> normalize audio, reframe, export-to-spec) is **instant, deterministic, and free** (no model
> call). The creative work (story, hook, pacing, b-roll, montage, emphasis) is **proposed by an
> AI that understands the footage**, and the **editor decides by previewing** — never a machine
> grading taste. Taste stays human; grunt work stays automatic.

**North star experience.** Drop in raw footage → an AI model has already transcribed it, and the
engine has found the silences, scenes, and beats → the editor says or points at what they want in
plain creative language → **watches** the AI's proposal (and alternatives) land on a beautiful
timeline → refines by pointing at moments → exports platform-native in one step. From raw file to
publishable short faster than any tool, with an AI that actually knows what's *in* the video, in a
UI that feels as good as Premiere/Resolve and as approachable as CapCut.

**Competitive frame.** Descript (transcript-first editing) · Opus Clip / Vizard (long→short) ·
CapCut (creator effects + animated captions + approachable UX) · Runway / Pika / ElevenLabs
(generative). Today a creator stitches 3–4 tools; FramePilot unifies them as **one agent-native
editor on a deterministic, reversible engine**, with perception & generation supplied by AI
models.

---

## 2. Current foundation — the honest snapshot (2026-07-10 full re-audit)

The **deterministic spine is genuinely strong**; the **media-intelligence and creative-primitive
surface is thin**; there are **honesty gaps** where edits exist but don't render; and the **UI is
functional but not yet pro-grade**.

| Layer | State | Notes |
|---|---|---|
| **Patch engine** (`editor-core`) | ✅ Strong | 20 typed ops, apply/**invert**/validate/diff, transactional, undo/redo, forward-only migrations |
| **Timeline schema** (v4) | ✅ Solid base | video/audio/caption/overlay tracks, clips **with source in/out**, keyframes, free-form effects, transforms (scale/x/y/rotation/opacity), masks, transitions, audio gain/fade/duck/normalize, color grade, word-level transcript, assets/folders |
| **Render engine** (MoviePy) | ✅ Real | compositing, transforms, 6 transitions, masks, parametric color grade, per-clip audio mix + master LUFS/denoise/limiter, **caption burn-in**, validation, 3 export presets |
| **Analysis** | ◑ 3 real | `analyze_silence`, `detect_scenes` (cuts), `detect_beats` — ffmpeg. **No ASR, no vision, no classification.** |
| **AI kernel** | ◑ Spine lit | recipe path (0-model, 6 recipes) live; planner path live-but-gated; sequential agent loop; thin semantic index; memory store; multi-provider incl. Ollama; MCP (single-shot) |
| **UI** (`web-editor` / `ui`) | ◑ Functional | timeline, preview player, media bin, AI sidebar exist and work; not yet pro-grade ergonomics/polish; several panels minimal |
| **Render queue** | ◑ Built, dark | async job queue exists but `/render` runs synchronously |

**Honesty gaps to close (from the audit):**
- **No transcription** — `transcript` is populated *externally*; nothing produces it. Captions,
  footage search, filler-cut, hooks all depend on it. **Biggest foundational hole.**
- **Text/title overlays don't render** — ops exist and validate, but the compiler *skips* `text`
  clips (`render/compiler.py:584`). An AI title edit "applies" but never appears.
- **Captions are baseline-only** (fixed white box) — not animated word-highlight captions.
- **LUT effect silently no-ops** — accepted/stored but not rendered (`compiler.py:419`).
- **Absent primitives:** speed/time-remap, crop, blend modes, auto-reframe, stickers/emoji/GIF,
  markers/chapters, templates, nested sequences.
- **Absent intelligence:** everything that needs a model — ASR, vision (faces/subjects/objects/
  scenes/emotion), segmentation, filler-word detection.
- **No generative media:** TTS, image/b-roll gen, background removal, upscaling.

**Principle that follows:** before more AI *behavior*, (a) close the honesty gaps, (b) give the AI
its **senses via models**, and (c) make the **UI worthy of the engine**. The kernel can't cut to a
reaction it can't perceive, and a great engine behind a mediocre UI still loses the editor.

---

## 3. Principles & invariants (every task obeys these)

Inherited (AGENTS.md / ADR 0044), non-negotiable:
1. **Build order:** media/model integration → validated render → AI tool → agent behavior. The
   capability's *input* (a model result, an engine render) ships and is tested before the AI that
   uses it. **Never fake a detection, transcription, or generation.**
2. **AI emits patches only** — validated, **invertible** `editor-core` ops via the single
   `operationsForCall` trust boundary. Model outputs (a transcript, a detected box, a generated
   asset) become *data or assets*, then *validated ops* — never raw project mutation.
3. **No schema change without a migration + doc + tests.** (§8 sequences them.)
4. **Render vs. preview wall is absolute** — MoviePy renders; the UI previews with HTML/canvas/proxy.
5. **One policy across in-app surfaces** (browser + desktop, same kernel). MCP stays single-shot.
6. **Honesty** — no fabricated success; no edit that "applies" but doesn't render; a gated
   capability *looks* gated. **Model-backed features are availability-, cost-, and consent-gated:**
   if the model is unavailable/offline/over-budget, say so — never fabricate its output.

The editor lens (where it conflicts with a coder-tool instinct, it wins):
7. **Preview-first** — judge by watching (before ↔ after player), not by reading ops.
8. **Taste stays human** — verification checks technical safety, never aesthetics.
9. **Hide the machinery** — no "DAG/recipe/planner/tokens/model-ids" in the UI; speak edits; show
   usage in plan terms.
10. **End-to-end or it doesn't ship** — `[schema]`→`[engine/model]`→`[op+invert+validate]`→
    `[tool]`→`[UI/preview]`→tests. A half-wired capability (today's text overlays, LUT) is a bug.
11. **Model results are cached and consented** — perception/generation calls are content-hash
    cached; generated media is labeled with provenance; anything sent to a hosted model is
    disclosed, and a local/offline model is offered where one exists.

---

## 4. Capability map — the full gap analysis

`✅` live · `◑` partial/gated · `❌` absent. "Delivered by" says model vs engine vs UI.

| # | Capability | Today | Delivered by | WS / Horizon |
|---|---|---|---|---|
| C1 | **Transcription (ASR)** | ✅ (H0.1) | **AI model** (hosted Whisper; optional local) | WS-B / H0 |
| C2 | **Text/title overlay rendering** | ✅ (H0.2) | engine (compiler) | WS-C / H0 |
| C3 | **Animated / karaoke captions** | ✅ (H1.1) | schema + engine + caption editor UI | WS-C+J / H1 |
| C4 | **Silence / filler / pause cleanup** | ✅ `remove_silence` + `filler_cleanup` (H1.4) | engine + transcript (C1) | WS-C / H0–H1 |
| C5 | **Speed / time-remap / ramps** | ◑ constant-rate shipped (H1.2/H1.2b); ramps/speed-curves deferred (ADR 0046) | schema + engine + op | WS-C / H1 |
| C6 | **Crop / reframe rect** | ✅ (H1.2c/H1.2d) | schema + engine + op | WS-C / H1 |
| C7 | **Auto-reframe (16:9→9:16, subject-aware)** | ❌ | **AI model** (subject detect/track) + reframe op | WS-B+C / H2 |
| C8 | **Blend modes** | ✅ (H1.2e/H1.2f) | schema + compositor | WS-C / H1 |
| C9 | **Stickers / emoji / GIF / shapes** | ❌ | asset kind + overlay render + UI | WS-C / H2 |
| C10 | **Face / subject / object detection + tracking** | ◑ stub | **AI model** (vision/segmentation API) | WS-B / H2 |
| C11 | **Scene/shot classification, emotion, on-screen text, moments** | ❌ | **AI model** (multimodal vision) → semantic index | WS-B / H2 |
| C12 | **Footage content search** | ◑ transcript search v1 (H1.5/J4) | transcript now (C1); visual via model later (C10/11) | WS-B+E / H1→H2 |
| C13 | **Background removal / matting / green-screen** | ❌ | **AI model** (segmentation/matting API) + chroma op | WS-D / H3 |
| C14 | **TTS / AI voiceover** | ❌ | **AI model** (TTS API) → audio asset | WS-D / H3 |
| C15 | **Generative b-roll / image / video** | ❌ | **AI model** (image/video gen API) → asset | WS-D / H3 |
| C16 | **Upscaling / enhancement** | ❌ | **AI model** (enhancement API) | WS-D / H3 |
| C17 | **Music: import + beat-sync + auto-duck** | ◑ duck exists | engine (on **user-imported** audio; no catalog) | WS-C / H2 |
| C18 | **Audio cleanup (denoise/EQ; filler cut)** | ◑ denoise/limiter/single-band EQ+compression (H1.4) + `filler_cleanup` (C4); multiband/buses/auto-SFX deferred (richer audio master spec) | engine + transcript (C1); AI-model denoise optional | WS-B+C / H1 |
| C19 | **Long→short repurposing (auto-clip)** | ❌ | **AI model** (transcript+moments) + clip planner | WS-G / H2 |
| C20 | **Platform-aware export / delivery** | ✅ 5 presets, async queue (H1.3) | engine + async queue | WS-C+I / H1 |
| C21 | **Markers / chapters** | ◑ schema+op+UI done (2026-07-11); auto-chapter pending | schema + op + UI; auto-chapter via C1 | WS-C / H1 |
| C22 | **Templates / brand kit / style memory** | ◑ style presets | schema + UI + learned taste | WS-H / H2 |
| C23 | **Preview-first review + variations (A/B)** | ❌ preview disabled | UI + kernel | WS-E+J / H1 |
| C24 | **Point-react-refine + Cmd+K + context pinning** | ❌ | UI + kernel | WS-E+J / H1 |
| C25 | **Parallel/observable/verified kernel; tiers; recovery** | ◑ | WS-A (AGENT-NATIVE) | WS-A / H0–H1 |
| C26 | **Autonomy: manual/auto/agent, approval, steering, long-horizon** | ◑ | WS-A + WS-F | WS-F / H1–H2 |
| C27 | **Async render queue / scale / cloud render** | ◑ built, dark | engine + infra | WS-I / H1→H3 |
| C28 | **Personalization / learned taste** | ◑ memory store | kernel (accept/reject → signals) | WS-H / H2 |
| C29 | **Offline / local model + engine reachability** | ◑ Ollama | provider wiring + status | WS-A+B / H1 |
| C30 | **Pro-grade editor UI** (timeline/monitors/bin/inspector/color/audio/export) | ◑ functional | **UI rewrite** | **WS-J / H0–H3** |

*(Dropped from earlier drafts per decision: owned music catalog, collaboration/sharing.)*

---

## 5. Workstreams

- **WS-A — Orchestration maturity.** Parallel proposer+DAG kernel, tiers, semantic slices, cost/
  replay/recovery, cross-surface parity, verify. *Detail: `AGENT-NATIVE-COMPLETION-PLAN.md`.*
- **WS-B — Media intelligence via AI models (perception).** The AI's senses — ASR, vision/content
  understanding, subject detection/tracking, moment signals — delivered by **models behind a
  provider abstraction**, not a custom ML stack. Engine side is thin: sample frames/audio → call
  model → cache → feed the semantic index.
- **WS-C — Editing capability surface.** Fill the primitive gaps for a *complete* edit: render
  text/titles, animated captions, speed/ramps, crop, blend modes, stickers, markers,
  beat-sync/duck on imported music, platform export. Each = schema + engine + op + tool + UI.
- **WS-D — Generative studio via AI models.** Create media, not just cut it: TTS, image/b-roll/
  video gen, background removal/matting, upscaling — all **model-backed**, produced as reviewed,
  labeled assets.
- **WS-E — Editor-first AI experience.** Preview-first review, variations, point-react-refine,
  creative vocabulary, footage search, Cmd+K, context pinning.
- **WS-F — Autonomy.** Manual / auto-apply / agent modes, plan approval, mid-run steering,
  long-horizon supervised runs.
- **WS-G — Repurposing & multi-output.** Long→short auto-clipping, batch export, multi-format.
- **WS-H — Personalization & brand.** Brand kit, templates, learned taste from accept/reject.
- **WS-I — Render & scale.** Async render queue, proxy pipeline, performance budgets, optional
  cloud render.
- **WS-J — UI/UX rewrite (the editor surface).** Rebuild the editor into a usable, beautiful,
  pro-grade UI — design system + every panel — referencing **DaVinci Resolve**, **Premiere Pro**,
  and **CapCut**. Spans all horizons.
- **WS-K — Trust, safety, observability, hardening.** Verification, security, e2e, cost/consent
  honesty, offline, docs.

---

## 6. WS-J in depth — the UI/UX rewrite (references: Resolve · Premiere · CapCut)

The engine deserves a UI that matches it. We rewrite the editor surface (`packages/ui` +
`apps/web-editor`, mirrored on desktop) into a coherent, professional, *approachable* product.

**What we borrow from each (deliberately):**
- **DaVinci Resolve** — workspace clarity (page/mode-based layouts), the **inspector** model
  (context-sensitive parametric controls), color tooling (wheels/curves/scopes), dark, dense,
  legible pro aesthetic, keyboard-driven speed.
- **Adobe Premiere Pro** — **timeline ergonomics** (ripple/roll/slip/slide, track targeting,
  snapping, nesting), **source vs program monitors**, **Effect Controls** panel with keyframe
  lanes, robust shortcut system, project/bin organization.
- **CapCut** — *approachability and delight*: one-click effects/transitions, the **animated caption
  editor**, sticker/text pickers, template feel, friendly defaults, motion polish, "it just looks
  fun and easy."

**WS-J deliverables (spread across horizons):**

- **J1 — Design system & shell** `[UI]` `[H0]`: tokens (color/type/space/radius/elevation),
  light/dark, motion (with `prefers-reduced-motion`), a11y (keyboard-first, ARIA, focus), an
  icon set, and a **workspace shell** with resizable/collapsible panels and saved layouts
  (Resolve-style). Rebuild `packages/ui` primitives on this system; kill ad-hoc styling.
  **(shipped 2026-07-10, see H0.4 for the record: token module + light theme + WorkspaceShell
  extraction. Icon set / broader a11y audit / further `packages/ui` primitive migration remain
  open — this pass covered tokens, theme, `Button`/`Input`, and the rail/dock shell only.)**
- **J2 — Timeline rewrite (the heart)** `[UI]` `[H0→H1]`: multi-track with track headers/targeting/
  lock/mute/solo, **ripple/roll/slip/slide + snapping** (Premiere), smooth zoom/scrub, waveforms +
  thumbnails, **keyframe lanes** (Effect-Controls-style), markers, drag-trim with numeric readouts,
  CapCut-grade responsiveness and hit-feel. Performance-budgeted (WS-I).
  **(first slice shipped 2026-07-10, see H0.4 for the record: the timeline's tokenization was
  verified — near-complete already, three magic clip-backing hexes named as local vars — and
  per-track **solo** landed as session-local preview-monitoring state that now actually drives
  playback, not just the header icon. Track targeting/arming, ripple/roll/slip/slide, and the
  keyframe-lane row remain open, deferred to H1.)**
- **J3 — Preview / monitors** `[UI]` `[H1]`: a proper program monitor with transport, safe-area/
  title-safe guides, aspect framing, and a **source vs. program** split for trimming (Premiere);
  a **before ↔ after A-B player** used by AI review (WS-E). HTML/canvas/proxy only (invariant §4).
  **(all four pieces are now shipped, see H1.5/H1.7 in `plan/PLAN.md`: the before↔after
  A-B player (2026-07-10); safe-area/title-safe guides — a program-monitor toolbar toggle
  overlaying action-safe (90%)/title-safe (80%) guide rects, pure CSS, off by default
  (2026-07-11); and the source-vs-program split — a new read-only `SourceMonitor.tsx`
  (deliberately not a `PreviewPlayer` reuse/fork) behind a **Source | Program** tab strip
  in the center stage, with local (non-project) in/out mark-range preview state; insert/
  overwrite-to-timeline from the marked range, three-point editing, and gang/sync remain
  explicitly deferred (2026-07-11). **Side-by-side compare shipped 2026-07-11** — a layout
  toggle on `AiReviewPlayer` mounts both before/after `PreviewPlayer`s live over the same
  `PlayheadClock` (AFTER as write-through master, BEFORE read-follow-only + muted). Wipe
  compare (draggable split-line) remains an explicit, documented follow-up — a small increment
  on top of side-by-side, not built in that slice.)**
- **J4 — Media bin** `[UI]` `[H1]`: grid/list, folders, **search**, hover-scrub, rich metadata,
  drag-to-timeline, and (H1) transcript-based search results (WS-B) surfaced inline. `[x]`
  transcript-based search done 2026-07-11 (footage search v1 — see H1.5 above); list view remains
  open.
- **J5 — Inspector / Effect Controls** `[UI]` `[H1]`: one context-sensitive panel for the selected
  clip's transform / crop / speed / color / audio / captions / effects, each keyframeable
  (Premiere Effect Controls + Resolve Inspector). This is where most manual edits happen.
- **J6 — Animated caption editor** `[UI]` `[H1]`: CapCut-class — pick a style preset, edit words,
  set word-highlight/animation, reposition, preview live. Backs C3.
- **J7 — AI sidebar redesign** `[UI]` `[H0→H2]`: the run HUD, preview-first review queue,
  variations, plan step-list, mid-run steering, context chips, Cmd+K — *detail in
  `AGENT-NATIVE-COMPLETION-PLAN.md` P12*, built on the J1 design system.
- **J8 — Color panel** `[UI]` `[H2]`: Resolve-inspired wheels/curves + scopes (backs the existing
  parametric grade + LUT once wired). Approachable "looks" for creators, deep controls underneath.
- **J9 — Audio mixer** `[UI]` `[H2]`: per-track levels/meters, fades, ducking controls, master
  loudness readout (backs the existing audio engine).
- **J10 — Export dialog** `[UI]` `[H1]`: CapCut-simple platform targets (Reels/TikTok/Shorts/
  YouTube) with the pro options a step deeper; live estimate; async-job progress (WS-I).
- **J11 — Command palette + keyboard** `[UI]` `[H2]`: pro-grade, discoverable shortcuts and a
  fuzzy command palette (Resolve/Premiere speed; VS-Code-style discoverability).
- **J12 — Polish & motion pass** `[UI]` `[H3]`: micro-interactions, empty/loading/onboarding
  states, cross-surface (desktop) parity, full a11y audit.

**WS-J guardrails:** never remove a working affordance while rewriting; every rewritten panel keeps
validate→apply→record for manual edits; desktop renders identically; ship panel-by-panel behind
the design system, not a big-bang rewrite.

---

## 7. The plan by horizon

Horizons are product milestones, not dates. Tasks are grouped by workstream and tagged.

### Horizon 0 — Foundation true · kernel mature · UI groundwork
*Goal: nothing pretends to work; the AI gains hearing (ASR via model); the kernel is parallel/
observable/verified; the UI rewrite's foundation and timeline land.*

- **H0.1 — Transcription via AI model [WS-B]**
  - [x] `[model][pkg]` Add a **speech provider** (2026-07-10): extended `ai-sdk/providers` (not a
        new `@framepilot/ai-media` package) with a small ASR abstraction (`providers/asr-types.ts`)
        parallel to the chat `AiProvider` — **local `whisper-cli`** (default, offline, via the
        engine sidecar) and **hosted Groq** (`whisper-large-v3`, opt-in, sends audio off-device,
        disclosed). Honest-unavailable throughout (missing binary/model/key → typed
        `{ available: false }`, never a fabricated transcript); local results content-hash cached
        (`framepilot_engine.audio.asr.transcribe`).
  - [x] `[engine]` Thin media-prep (2026-07-10): `framepilot_engine/audio/asr.py` extracts mono
        16kHz audio via ffmpeg, shells out to `whisper-cli --output-json-full` with word-timestamp
        flags (`-ml 1 -sow --dtw`), merges whisper.cpp's sub-word BPE tokens into whole words with
        real per-word timestamps (never interpolated), and validates every word against
        `TranscriptWord` before returning. `base.en` model management (explicit
        `POST /asr/setup` / `framepilot setup-asr`, SHA256-verified, gitignored app-data cache) —
        never a silent download. Exposed via `/asr/status`, `/asr/setup`, `/transcribe`
        (`service.py`) and `asr-status`/`setup-asr` (`cli.py`).
  - [x] `[editor-core op]` `set_transcript` (2026-07-10): new reversible project-scoped operation
        (apply/invert/validate, 100% coverage) — the patch primitive `transcribe` writes through,
        never a raw project mutation.
  - [x] `[AI tool]` `transcribe` (2026-07-10, TS + Python mirror): takes an ASR provider's
        already-fetched `words` and turns them into a `set_transcript` patch (mirrors the
        `add_asset` precedent — the provider call is a separate concern from the tool).
        **Follow-up (not yet wired):** auto-run on import so footage arrives pre-transcribed —
        the tool itself works standalone today but nothing calls it automatically yet.
  - [x] `[UI]` Minimal Settings → AI → Providers → **Whisper / Speech-to-text** section
        (2026-07-10): provider dropdown, local model status + "Set up" action, hosted-Groq
        off-device disclosure. The full transcribe-and-review flow (a sidebar action that calls
        the provider, previews the resulting captions, and applies) is a follow-up — this session
        shipped the settings surface only, per scope.
- **H0.2 — Close the honesty gaps [WS-C]**
  - [x] `[engine]` Render **text/title overlays** (2026-07-10): `add_text_overlay` clips (kind
        `text`) used to be skipped in `compile_timeline`'s dispatch loop; the compiler now burns
        them in unconditionally via a new `framepilot_engine/render/text_overlay.py` (reuses
        `render/captions.py`'s wrap logic), so an applied text overlay always renders. See
        `plan/PLAN.md` for the full record.
  - [x] `[engine]` Wire **LUT** rendering (2026-07-10): the parser/applier already existed
        (`render/color.py`) but nothing called it; `_apply_color_grade` now also reads a clip's
        `lut` effect, sandbox-resolves its `path` param against the project dir
        (`safety.resolve_within`, same sandbox asset paths use), parses the `.cube` file, and
        applies it via trilinear interpolation. Missing/invalid/escaping paths raise a typed
        `CompileError`.
  - [x] `[test]` Goldens proving titles + LUTs actually appear (`test_compile_burns_in_text_overlay`,
        `test_compile_applies_lut_from_sandboxed_cube_file` in
        `engine/python/tests/test_render_compiler.py`).
- **H0.3 — Orchestration maturity spine [WS-A]** *(AGENT-NATIVE)*: tier routing (P3.4); semantic
  index ingests real analysis **+ transcript** and slices (P4, now unblocked); parallel "what's
  running" + first-frame shimmer (P8.1/P8.2); cost/replay/recovery in **plan terms not tokens**
  (P7); engine reachability + offline/local path + status chip (P5).
  - [x] `[kernel]` **P3.4 — tier routing, live** (2026-07-10): `ModelEffect`s carry the proposer's
        declared tier; the effect runtime dispatches per-tier once a tier is explicitly configured
        (settings/env), collapsing honestly to the single default provider otherwise — never a
        hard failure, never a silently-constructed unconfigured client. See
        `AGENT-NATIVE-COMPLETION-PLAN.md` P3.4.
  - [x] `[kernel]` **P4 — semantic index real ingestion + slices** (2026-07-10): `shots`/
        `silences`/`beats` populate for real from `detect_scenes`/`analyze_silence`/`detect_beats`,
        translated into timeline time and memoized per (project, analysis-bag); a new `getSlice()`
        lets Planner/EditProposer reason over bounded time-range/layer/kind slices instead of
        whole-index dumps or bare cardinalities. P4.3 (token-delta perf gate) and P4.4 (footage
        search) remain deferred. See P4.
  - [x] `[UI][kernel]` **P5 — engine reachability + offline degradation** (2026-07-10): a documented
        dev env var + no-silent-disable warning, a `probeEngineReachable` health check, Ollama
        surfaced as a clearly-labeled offline **model** option (never substituted for analysis,
        which it cannot run), and an `EngineStatusChip` in the sidebar visible before asking for an
        analysis-dependent recipe. See P5.
  - [x] `[kernel][UI]` **P7 — cost meter, replay, recovery, live** (2026-07-10): every model-effect
        task completion prices real tokens/$ (recipe/host-tool completions still price exactly
        zero, regression-asserted); replay wired as a dev affordance with a determinism-regression
        test; `recoveryFor` now the source of truth for the model-effect failure path. The default
        sidebar shows creator-language usage ("Instant · no AI needed" / a session-usage phrase),
        never raw tokens/$, which stay behind an off-by-default dev/pro toggle. See P7.
  - [x] `[UI]` **P8.1/P8.2 — parallel "what's running" view + shimmer** (2026-07-10): a new
        `TaskRunView` renders `view.tasks` (already fully computed, never rendered) as simultaneous
        cards, confirmed live end to end through `streamPlannedEdit → executePlannedEdit →
        runGraph`; the first status shimmer was already guaranteed within one frame, proven with a
        test rather than duplicated. P8.3–P8.7 remain explicitly deferred. See P8.
- **H0.4 — UI foundation [WS-J]**: design system & workspace shell (J1); **timeline rewrite** begins
  (J2).
  - [x] `[UI]` **J1 — Design tokens + light theme + WorkspaceShell extraction** (2026-07-10):
        `packages/ui/src/tokens.css` is now the single source of truth for every DESIGN_SYSTEM.md
        token (surfaces/borders/text/accent/semantic/clip colors, spacing, radius, type scale,
        elevation, motion, z-index) — a byte-identical extraction of the dark values that used to
        be duplicated directly in `apps/web-editor/src/styles.css`'s `:root` (`styles.css` now
        `@import`s it), plus a net-new **light theme** (same token *names*, new *values*,
        preserving every relationship the dark ramp encodes: surfaces still layer base→elevated,
        text still uses an opacity hierarchy, one accent, flat type-coded clip fills, etc.). Theme
        resolution mirrors the app's existing `data-reduced-motion` override pattern:
        `prefers-color-scheme` decides by default; an explicit `data-theme="light"|"dark"` on
        `<html>` wins either direction. A Settings → Display **Theme** segmented control
        (System/Light/Dark) drives it through `useSettings` (persisted like every other editor
        preference). `Button`/`Input` now depend on the token module directly (a self-import) so
        `packages/ui` no longer implicitly relies on the host app defining the tokens. Separately,
        the rail/dock resizable-panel mechanism — previously hand-rolled across `Editor.tsx` +
        `useRailLayout.ts` — is now `WorkspaceShell` (+ `useRailLayout`/`useDockHeight`) in
        `packages/ui`, with slot props (`left`/`right`/`center`/`dock`) and a pluggable
        persistence-adapter interface (defaults to `localStorage`, matching prior behavior
        exactly — same storage keys). Behavior-preserving by construction and verified: dark-theme
        token values are asserted byte-identical (`packages/ui/src/tokens.test.ts`),
        `Editor.test.tsx`'s 28 DOM/interaction tests and the Playwright e2e suite (26 non-visual
        specs across smoke/timeline/marquee/transcript/captions/transport/preview) pass unchanged
        after the rewiring. No Tailwind/Radix/`react-resizable-panels`/any new dependency added,
        per the advisory's explicit constraint. Icon set, broader a11y audit, and migrating the
        rest of `packages/ui`'s (still mostly placeholder) primitives onto the token system remain
        open follow-ups.
  - [x] `[UI]` **J2 first slice — timeline re-skin verified + per-track solo** (2026-07-10): the
        timeline was audited against `tokens.css`, not blanket-rewritten — `TimelineView.tsx` had
        no inline hex/spacing at all, and `styles.css`'s track/clip/ruler/playhead rules already
        consumed the `--clip-*`/`--track-lane`/`--ruler-tick`/`--playhead` tokens end to end. The
        one genuine gap found: three near-black clip-backing hexes (`.timeline .clip-block`,
        `.clip-block.is-image`, `.clip-filmstrip--skeleton`) were still magic literals — now named
        local custom properties (`--clip-backing`/`-image`/`-skeleton` in `styles.css`'s `:root`,
        byte-identical values, zero visual diff). **Solo** itself (the actual J2 scope item here)
        turned out to already exist as view-only state (`useTrackLayout.ts`'s `soloed` flag +
        `resolveSoloMutedTrackIds`, wired to a `Headphones`-icon header button next to
        mute/lock/hide in `TimelineView.tsx`) — correctly never a schema field, patch, or undo
        entry — but it only drove the timeline header's own "muted by solo" icon; the actual
        preview mixer/monitor still read each track's raw persisted `muted` flag and ignored solo
        entirely (a gap the code's own comments flagged as future work). Closed that gap: a new
        pure `effectiveMutedTrackIds`/`audioBearingTracks` (in `editor/selectors.ts`) folds solo
        over the persisted flags — a soloed track always plays (even if persisted `muted`), every
        other audio-bearing track is silenced (even if not) — and now drives `audibleAudioAt`/
        `audibleAudioClipsAt`, `PreviewAudioMixer`, and `PreviewPlayer`'s `videoMuted`, with
        `Editor.tsx` lifting `useTrackLayout()` once and threading `soloedTrackIds` to both the
        timeline and the preview. (Lifting it also surfaced and fixed a latent perf bug: the
        hook's return value wasn't memoized, so once it fed an outer `useMemo` dependency it broke
        `Editor.perf.test.tsx`'s "no re-render on seek" guarantee — fixed by memoizing `soloedIds`
        and the hook's return on `map`.) Render/export is untouched and still MoviePy-only against
        the real `Track.muted` — solo is preview-only, exactly per invariant 5. **Deferred to H1**
        (unchanged from the J2 description above): ripple/roll/slip/slide edit modes, track
        targeting/arming, and a dedicated keyframe-lane row.

**H0 acceptance (met 2026-07-10, honest scope noted):** footage auto-transcribes (H0.1; auto-run
on import is a tracked follow-up); every edit the AI can make **actually renders** (H0.2); the
kernel dispatches per model tier, reasons over real transcript/analysis slices, prices and can
replay/recover real runs, and shows visibly concurrent work (H0.3 — P3.4/P4/P5/P7/P8.1-8.2 all
shipped; P4.3/P4.4/P7.5/P8.3-8.7 remain deferred to H1 per the source plan's own wave sequencing,
not silently dropped); the new design system (tokens + light theme + `WorkspaceShell`) is in place
and the timeline rewrite has **begun** — re-skinned onto it with one new primitive (track solo,
now wired end to end into preview audio) — with ripple/roll/slip/slide, track targeting/arming,
and a dedicated keyframe-lane row explicitly carried forward as H1's timeline-rewrite body of work.

### Horizon 1 — The complete instant creator editor
*Goal: a creator does a full short-form edit end to end — AI does the grunt work instantly and
free, every proposal judged by watching — in a UI that feels pro and friendly.*

- **H1.1 — Animated captions [WS-C + WS-J/J6]** `[x] shipped 2026-07-10`: `[schema v5]` rich
  caption style (font/color/outline/position/**word-highlight**/animation/presets, per-word timing
  from H0.1) + `[engine]` karaoke renderer + `[op]` `set_caption_style` + the **caption editor UI**
  — `CaptionEditor.tsx`'s template/size/color/position controls now persist to the selected
  caption clip via `set_caption_style` (undoable, no separate Save step), closing schema → op →
  render → UI end to end. See `plan/PLAN.md` H1.1 for the full breakdown.
- **H1.2 — Core primitives [WS-C]**: `[schema v6/op/engine/UI]` **speed/time-remap** (constant
  rate only — ramps/speed-curves remain deferred, ADR 0046); `[schema v7/op/engine/UI]`
  **crop/reframe rect**; `[schema v8/op/engine/UI]` **blend modes**;
  `[schema v9/op/UI]` **markers/chapters** — all four now landed end-to-end (schema, patch-engine
  ops, Python parity, and editor UI): markers/chapters 2026-07-11 (`plan/PLAN.md` H1.2g/H1.2h, ADR
  0049); speed/crop/blend's Inspector UI (the last user-reachability gap the other three left open)
  closed 2026-07-11 (`plan/PLAN.md` H1.2i) with numeric crop controls (an on-canvas crop gizmo is a
  separate, tracked follow-up) and a rough CSS-approximation preview for crop/blend (speed preview
  itself is deferred — see H1.2i for why). Auto-chapter generation from the transcript remains a
  separate, deferred AI-tool follow-up.
- **H1.3 — Platform export & delivery [WS-C/WS-I + J10]** (complete 2026-07-11, `plan/PLAN.md`
  H1.3a+H1.3b): `[engine]` wired the **async render queue** to HTTP (submit + poll + cancel,
  H1.3a) and the desktop/web-editor export dialog now consumes it end to end — live
  queued/running/cancel status (no fake progress bar; the contract has no numeric percentage),
  H1.3b. Export presets are now **creator actions** (Reels/TikTok/Shorts/YouTube, plus Square) with
  aspect + burned captions + a per-platform loudness *default* (-14 LUFS social convention; still
  user-overridable, H1.3b). Reframe-to-aspect (center/scale now, subject-aware in H2) remains a
  separate, not-yet-started follow-up.
- **H1.4 — Transcript-driven cleanup [WS-B/WS-C]** `[x]` shipped 2026-07-11: `[engine]`
  **filler-word / "um" removal** and awkward-pause tightening as a 0-model `filler_cleanup`
  recipe (Descript's move, commit `f04edd4`) and master **EQ/compression** (single-band,
  multiband/buses/auto-SFX still deferred on a richer audio master spec). See `plan/PLAN.md`
  H1.4 (first half) and (second half) for the full breakdown.
- **H1.5 — Editor-first AI experience [WS-E + WS-J/J3,J7]**: **preview-first review** (before↔after
  player as the headline; enable the disabled Preview) · **variations / A-B** · **point-react-
  refine + Cmd+K + context pinning** · **creative vocabulary** · **footage search v1** over
  transcript. *(All cross-ref AGENT-NATIVE P8/P12/P13.)*
  - `[x]` done (2026-07-10, extended 2026-07-11): the **before/after AI-review player** slice —
    thread the already-computed `assembleEdit` before/after Timeline diff (previously discarded)
    through a new `editor-core` `structuredDiffTimeline` helper + `ai-sdk` plumbing into a real
    spring-loaded A/B, scrub-linked `AiReviewPlayer` wired into `DiffCard`'s Accept/Reject
    (web-editor, read-only preview shim). See `plan/PLAN.md` for the tracked task. Safe-area/
    title-safe guides and source-vs-program split shipped 2026-07-11 (H1.7). **Side-by-side
    compare shipped 2026-07-11**: a layout toggle mounts both before/after `PreviewPlayer`s live
    over one shared `PlayheadClock`. **Wipe compare remains an explicit, deferred follow-up** — a
    small increment on top of side-by-side, intentionally not built in this slice.
  - `[x]` done (2026-07-11): **footage search v1 over transcript** — the media bin's search box
    now also matches spoken words (whole-word, phrase-aware) via a new `transcriptSearch.ts`,
    mapping each hit back to its clip/asset and jumping the playhead on click. See `plan/PLAN.md`
    for the tracked task.
  - `[x]` done (2026-07-11): **selection ↔ context loop + creative vocabulary** — the
    editor's live timeline selection now threads into `AiSessionInput.selection` and
    `routeCommand`'s `hasSelection` (making the `direct_edit` route reachable), and the
    composer's context chips are selection-derived (a removable "Selected: N clips, S–Es"
    chip). The router also recognises a first slice of creative phrasing ("punchier",
    "tighten this up", "build energy" → `improve_pacing`) with zero model calls. See
    `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P8.4/P12.7/P13.2 for the full breakdown.
    **Creative-vocabulary investigation closed out (2026-07-11, same day):** the three
    phrases originally left unmapped were re-investigated with zero new model dependency.
    "Match the music" was reclassified as already-correctly-handled (falls through to
    `plan`, which reaches the existing beat-sync montage leaves — never a gap, only a
    doc error). "Let it breathe"/"add some space" and "cut to the reaction"/"hold on her
    face" are confirmed to need capability this codebase genuinely doesn't have yet (a new
    "loosen pacing" recipe; Horizon 2 shot-content understanding, respectively) and stay
    unmapped — not silently dropped, but explicitly tracked as follow-on work, not this
    slice's scope. **Not built here** (separate follow-ups): the Cmd+K keybinding/entry
    point (shipped separately, see H1.5c second half in `plan/PLAN.md`), the "@"
    pin-context picker UI (shipped separately, see the H1.5c third-slice entry below), a
    "loosen pacing" recipe, and Horizon 2 shot-content understanding.
  - `[x]` done (2026-07-11): **Cmd+K + point-react-refine (clip-based)** — a shared
    `CommandPalette` now serves both the global `⌘K`/`Ctrl+K` shortcut and a clip's right-click
    "Ask AI about this clip" item, sending a selection-scoped free-text prompt through the same
    `AiSidebar` request path the composer already uses (no parallel path); no selection shows an
    honest hint + a fallback to the sidebar, never a silent no-op. See
    `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P12.2/P13.3 for the full breakdown. **Not built here**
    (stays open): preview-player point-clicking (scoping to a raw timecode rather than a clip).
    The "@" pin-context picker for multiple pinned refs shipped separately — see the next
    bullet.
  - `[x]` done (2026-07-11): **"@" pin-context picker, narrow slice** — typing `@` in the
    composer opens a searchable dropdown of timeline clips + `project.assets` (mirrors the
    slash-command palette's interaction shape); picking one pins it as its own removable
    context chip, independent of the auto-derived selection chip, and N pins can coexist.
    Threaded into the model context as a new "Pinned context" prompt block
    (`packages/ai-sdk/src/context-builder.ts`), ranked just below the live selection in the
    token-budget priority order. Browser-only for now (same precedent as `selection`/
    `variations`) — desktop IPC threading is a documented P6 follow-up. **Not built here**
    (P8.7's full scope stays open): `@range`/`@marker`/`@track` entity kinds. See
    `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P8.7 and `plan/PLAN.md`'s H1.5c third-slice
    entry for the full breakdown.
  - `[x]` done (2026-07-11): **variations / A-B compare, edit-mode slice** — a new
    opt-in "Show 2 alternatives" toggle (Edit mode only, off by default) runs the same
    request as 2 independent, real model calls and shows a Take A/B switcher on the review
    card that re-points the existing before/after `AiReviewPlayer` at whichever candidate
    is selected; accepting one discards the other (never left pending). Never offered for
    recipe/planned-edit/agent diffs — those are deterministic or already-converged, so
    "variations" would be the identical result twice. The usage chip reflects the REAL
    combined cost of both calls when the toggle is on, never hidden. See
    `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P13.1 for the full breakdown, including what's
    deferred (desktop IPC threading, concurrent candidate calls).
- **H1.6 — Autonomy: planner-primary [WS-F]** *(AGENT-NATIVE P11)*: the parallel planner becomes the
  **primary** agent route; technical verify on every path; plan-approval step-list; mid-run steering.
  - `[x]` done (2026-07-11): **P11.1/P11.2/P11.5/P11.6 (kernel half)** — the
    planner path's `isRecognizedPlan`/`executePlannedEdit` now recognise the UNION of the
    montage shape and every proven `RECIPE_LEAVES` primitive (`PLANNER_LEAVES`, P11.1), so
    more Agent-mode requests compile to the DAG instead of silently falling back; the
    fallback itself now carries an honest, inspectable `reason`/`detail` (P11.2) instead of
    one opaque notice; and the shared `verify` leaf runs the SAME real technical-safety
    `critique()` battery the sequential agent path already runs — not just structural patch
    validity (P11.5) — proven identical across recipe/planner/agent by a new parity test
    (P11.6).
  - `[x]` done (2026-07-11, commit `44df709`): **P11.3/P11.4 (UI half)** — plan-approval
    gating and mid-run steering, completing H1.6. `PlanApprovalCard`
    (`apps/web-editor/src/components/ai/PlanApprovalCard.tsx`) pauses a run before its
    first turn for plans with MORE than `PLAN_APPROVAL_STEP_THRESHOLD` (3) steps, with
    inline Approve / Edit request / Cancel; `SteeringInput`
    (`apps/web-editor/src/components/ai/SteeringInput.tsx`) lets the user queue guidance
    into a running agent, folded at the next per-turn boundary. New kernel module
    `packages/ai-sdk/src/run-controls.ts` (`PlanApprovalGate`/`SteeringQueue`) carries the
    live, non-serialisable resolver/queue outside the pure `Command`/`AgentOptions`
    boundary. **Browser-only** — Electron IPC can't carry the live resolver/queue, an
    explicit documented gap. See `docs/adr/0051-plan-approval-gate-and-mid-run-steering.md`
    and `plan/AGENT-NATIVE-COMPLETION-PLAN.md` P11.3/P11.4 for the full breakdown.
- **H1.7 — UI panels [WS-J]** `[x]` shipped 2026-07-11: preview/monitors (J3 — safe-area/
  title-safe guides `b6ad723`, source-vs-program split `dd45c00`, side-by-side compare
  `946452c`; wipe compare remains an explicit small follow-up), media bin + transcript
  search (J4, H1.5), inspector/Effect Controls (J5, H1.2i), export dialog (J10, H1.3b).
  See `plan/PLAN.md` H1.7 for the full breakdown.

**H1 acceptance — met (2026-07-11):** import a talking-head recording and, entirely by watching AI proposals, produce
a captioned, silence/filler-cut, paced short with animated captions, speed ramps, and platform
export — mechanical steps instant/free, creative steps reviewed — in a timeline/monitor/inspector
UI that feels professional.

### Horizon 2 — The creative co-editor that understands the footage
*Goal: the AI makes **story-level** decisions because a model lets it **see**. Repurposing,
subject-aware reframing, brand, and long-horizon autonomy land.*

- **H2.1 — Vision / content understanding via models [WS-B]**: `[model][engine]` a **vision layer**
  in `@framepilot/ai-media` — sample keyframes → multimodal model → scene/shot classification,
  on-screen text (OCR), **moment signals** (reaction/laugh/emphasis/energy); a
  **detection/segmentation model** (hosted, e.g. SAM-class API) for faces/subjects/objects +
  tracking. Replaces the `available:false` stubs. Availability/cost/consent-gated, cached, never
  faked. `[AI]` ingest into the **semantic index** so the planner reasons about who/what/when.
- **H2.2 — Story-level editing [WS-C/WS-E]**: `[op/engine]` **auto-reframe (16:9→9:16, subject-
  aware)** using detection+tracking (H2.1) + crop/transform (H1.2) — the repurposing keystone;
  story-aware proposals ("cut to the reaction", "b-roll here", "hold on the emphasis"); **footage
  search v2** (visual/semantic via model).
- **H2.3 — Repurposing: long → short [WS-G]**: `[model/AI]` highlight detection (transcript +
  moment signals + pacing) → `[kernel/UI]` **auto-clip pipeline**: one long input → a batch of
  proposed shorts (captioned + reframed + hooked), each previewable and fully editable after.
- **H2.4 — Music (imported) [WS-C]**: beat-sync (extends `detect_beats`) and **auto-duck** dialogue
  on the user's **imported** audio. *(No owned catalog.)*
- **H2.5 — Personalization & brand [WS-H]**: `[AI]` actionable taste memory (accepted-vs-rejected →
  preference signals); `[schema/UI]` **brand kit + templates** (fonts/colors/caption style/intro-
  outro/watermark) that replay across projects.
- **H2.6 — Long-horizon supervised autonomy [WS-F]** *(AGENT-NATIVE Appendix A, now in scope)*:
  "make this a polished 45s reel" runs as one **supervised, budgeted, interruptible arc** across
  segments, pausing for approval on big moves, always resumable.
- **H2.7 — UI [WS-J]**: color panel + scopes (J8), audio mixer (J9), command palette + keyboard
  (J11).

**H2 acceptance:** the AI honors story-level requests by understanding the footage; a 30-min
podcast becomes several captioned, reframed, hooked shorts in one flow; edits carry the creator's
brand; a supervised agent takes a rough cut to a polished short with human approval on big moves;
color/audio/command-palette UI is in.

### Horizon 3 — Generative studio & scale
*Goal: create media (via models), not just arrange it; run at product scale.*

- **H3.1 — Generative media via models [WS-D]** *(strict honesty/consent/labeling)*:
  `[model][pkg][AI tool]` **TTS/voiceover** → audio asset; **generative b-roll / image / video** →
  imported visual asset (the `add_asset` seam anticipates this); **background removal / matting**
  and **chroma key**; **upscaling/enhancement**. Every output is a **reviewed, deletable, labeled**
  asset — nothing auto-commits; provenance (model + prompt + consent) recorded (`schema v13`).
- **H3.2 — Render & scale [WS-I]**: optional **cloud render workers** (the subprocess queue
  generalizes) for heavy/parallel exports; background proxy/derivation queue; performance budgets
  on the parallel path and large projects.
- **H3.3 — Surfaces [WS-J/WS-A]**: full desktop/browser parity for every capability; MCP stays the
  single-shot external surface (by decision).
- **H3.4 — UI polish & motion pass [WS-J/J12]**: micro-interactions, onboarding/empty states, full
  a11y audit, cross-surface polish.

**H3 acceptance:** a creator can generate a voiceover and b-roll, matte out a background, upscale,
and render in the cloud — all model-backed, reviewed, and labeled — inside one polished editor.

---

## 8. New capability infrastructure (AI-model-first)

We do **not** build CV/ML/generative engines. We build **provider abstractions + thin media-prep**,
mirroring the proven `ai-sdk/providers` pattern.

| Piece | Purpose | Horizon | Notes |
|---|---|---|---|
| **`@framepilot/ai-media`** (pkg) | One abstraction over **perception + generation models**: speech (ASR), vision (describe/classify/OCR/moments), detection/segmentation, TTS, image/video gen, matting, upscale | H0→H3 | Multi-provider (hosted + optional local); honest availability; cost + consent + content-hash cache; results become data/assets, then validated ops |
| **Media-prep helpers** (engine) | Sample frames, extract audio, thumbnail keyframes to feed models | H0→H2 | Thin; no ML deps in-repo — the models are hosted/optional-local |
| **Async render workers** (engine/infra) | Scale exports | H3 | Generalizes `render/queue.py` |
| **`packages/ui` rewrite** (WS-J) | Design system + all editor panels | H0→H3 | Resolve/Premiere/CapCut references |

Extend existing packages: `editor-core` (speed/crop/blend/markers/captions/reframe/chroma ops),
`timeline-schema` (§9 migrations), `ai-sdk` (new tools + tiers + semantic ingestion + perception/
generation tool families), `web-editor`/`desktop` (the experience).

**Explicitly dropped (per decision):** owned music catalog (users import audio), collaboration/
sharing service.

**Dependency stance:** hosted models add **API integrations**, not heavy local deps — lighter than
a bundled CV/ML stack, but still gated on maintainer sign-off for **provider strategy, cost model,
and consent/labeling policy** (CLAUDE.md §5). Optional local models (whisper.cpp, a local vision/
matting model) are the offline fallback and *do* carry a packaging decision.

---

## 9. Schema evolution roadmap (each = migration + doc + tests, forward-only)

Current `SCHEMA_VERSION = 4`; additive/stepwise:
- **v5 — Rich caption style** (font/color/outline/position/karaoke/animation/presets). [H1.1]
- **v6 — Speed / time-remap** (decouple source vs timeline duration; speed curve). [H1.2]
- **v7 — Crop rect.** [H1.2]
- **v8 — Blend mode.** [H1.2]
- **v9 — Markers / chapters.** [H1.2]
- **v10 — Sticker/emoji/GIF asset kind + overlay clip type.** [H2/C9]
- **v11 — Perception metadata** (detections/tracks/scene tags) — *kept in a content-hashed sidecar
  index, not the project file, to stay lean; only stable references land in the doc.* [H2.1]
- **v12 — Brand kit / template model.** [H2.5]
- **v13 — Generated-asset provenance** (model, prompt, consent/labeling flags). [H3.1]

Transcript is already modeled — H0.1 only *populates* it (no migration). Keep the project file
lean; heavy model outputs live in the memoized semantic index / sidecar cache.

---

## 10. Definition of Done — the end product

1. **Import → transcribed, analyzed, (H2) understood** by models — no manual prep; never faked when
   a model is unavailable.
2. **Complete edit by watching** — a finished short (animated captions, silence/filler cut, pacing/
   ramps, reframe, imported music, platform export) with mechanical steps instant/free and creative
   steps reviewed via before↔after preview.
3. **The AI understands the footage** — story-level requests work because a model backs them.
4. **Repurposing** — one long recording → multiple platform-native shorts in one supervised flow.
5. **Generative studio** — voiceover, b-roll, matting, upscaling as reviewed, labeled, deletable
   model-made assets; nothing auto-commits.
6. **Every edit renders** exactly as previewed; every capability is end-to-end; nothing pretends to
   work.
7. **Mature, trustworthy engine** — parallel/observable/verified kernel; technical verify on every
   path (taste stays human); graceful degradation; offline where possible; honest usage in plan
   terms; model use disclosed/consented; browser+desktop parity; security-reviewed; `pnpm verify`
   green.
8. **Personal & branded** — accept/reject taste + brand kit shape proposals.
9. **A pro-grade, delightful UI** — timeline/monitors/bin/inspector/color/audio/export rewritten to
   the Resolve/Premiere/CapCut bar: usable, beautiful, keyboard-fast, approachable; every panel
   preserves validate→apply→record and renders identically on desktop.

---

## 11. Sequencing & first moves

**Critical path.** Perception gates the creative AI (can't edit footage a model hasn't described);
the UI gates adoption (a great engine behind a weak UI loses the editor). So: *senses (models) +
UI foundation → primitives + experience → understanding + repurposing → generative + scale.*

| Wave | Focus | Why first |
|---|---|---|
| 1 (H0) | **ASR via model** · close honesty gaps (text render, LUT) · kernel maturity spine · **design system + timeline rewrite** | Give the AI hearing; stop pretending; mature the engine; put the UI on a real foundation |
| 2 (H1) | Animated captions + caption editor · speed/crop/blend/markers · platform export (async queue) · preview-first + variations + Cmd+K · filler-cut · planner-primary autonomy · monitors/bin/inspector/export UI | The complete instant creator editor |
| 3 (H2) | Vision via models · auto-reframe · long→short repurposing · imported-music beat-sync/duck · brand + taste · long-horizon autonomy · color/audio/command-palette UI | The creative co-editor that sees — the moat |
| 4 (H3) | Generative media via models · cloud render · UI polish pass | The studio at scale |

**Start here (highest leverage):**
1. **H0.1 — ASR via an AI-model speech provider.** The keystone sense; unlocks captions, footage
   search, filler-cut, hooks, and H2 repurposing.
2. **H0.2 — close the honesty gaps** (render text overlays; wire LUT) — small, makes the product
   truthful.
3. **H0.4/J1–J2 — design system + timeline rewrite** — the UI foundation everything else is built
   on; start it in parallel with H0.1/H0.3.
4. **H0.3 — kernel maturity spine** (AGENT-NATIVE P3.4/P4/P7/P8), now unblocked by real transcript.

**Decisions to confirm before building (ASK the maintainer — CLAUDE.md §5):**
- **AI-model provider strategy** — which speech/vision/segmentation/TTS/image/video providers;
  hosted vs optional-local; the **cost model** (per §7, usage shown to users in plan terms).
- **Consent & labeling policy** — disclosure for footage sent to hosted models; provenance/
  watermarking for generated media.
- **Optional local models** (whisper.cpp, local vision/matting) — packaging/size decision for the
  offline path.
- **Where perception metadata lives** — lean project file + sidecar index (recommended) vs schema.
- **Cloud render** — infra + business-model scope for H3.

---

> **How to work this plan (CLAUDE.md §1):** mark `[~]` before starting, `[x]` only on a green
> `pnpm verify` with the capability end-to-end (schema→engine/model→op→tool→UI→tests). Ship the
> model/media integration before the AI behavior that calls it; never fake a model result. Rewrite
> the UI panel-by-panel behind the design system, never a big-bang. Keep orchestration detail in
> [`AGENT-NATIVE-COMPLETION-PLAN.md`]. Large sub-areas (ASR, vision, generative, repurposing, the
> UI rewrite) each deserve their own linked sub-plan under `plan/` when picked up.
