# Production Hardening & UX Refinement Milestone

> Sub-plan of `plan/PLAN.md`. Status legend matches PLAN.md:
> `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
>
> **Scope:** a comprehensive polish pass across the desktop app, AI orchestration,
> preview/rendering, timeline, startup, and marketing website. Every change ships
> with a root-cause analysis, tests, and docs. No superficial fixes.

**Snapshot (2026-07-06):** ✅ COMPLETE — all 22 items landed or resolved with
rationale; `pnpm verify` green (16/16 tasks + engine 478). Final report with
measured before/after: `reports/production-hardening-report.md` (ADR 0038).
Follow-ups tracked there and in `reports/desktop-feature-audit.md`.

## H1 — AI reasoning streaming `[x]` (2026-07-06)

**Root causes found (2026-07-06):**

1. `Orchestrator.streamAssistant` with the `reasoning` sink re-emits the FULL
   accumulated reasoning text on every token (`emit.reasoning([...prior, text])`),
   and `appendEvent` appends every snapshot — O(n²) transport bytes (desktop IPC)
   and O(n²) persisted-log growth per turn.
2. `AiSidebar` re-runs `reduceEvents` over the entire event log on every streamed
   event — O(n²) CPU per turn; per-token cost grows as the conversation grows,
   which reads as "buffered"/lurching updates.
3. One React dispatch per streamed event — no frame-level coalescing.
4. The streaming reasoning line renders with `ai-shimmer-text` (skeleton-like
   gradient) and as plain text, not markdown.

**Fix (landed 2026-07-06):**

- [x] ai-sdk: add `reasoning_delta` event (mirrors `assistant_delta`); first chunk
      of a step emits one canonical `reasoning` snapshot, subsequent chunks emit
      small deltas. Log and IPC bytes become O(n).
- [x] ai-sdk: refactor `reduceEvents` into an incremental
      `createConversationViewBuilder()` (push/view); `reduceEvents` wraps it.
- [x] web-editor: `appendMany` batch action + rAF frame-batcher in the sidebar
      run loop (≤1 render per frame, tokens never delayed beyond one frame).
- [x] web-editor: incremental `useConversationView` (extends the builder on
      append-only growth; full rebuild on conversation switch/reset).
- [x] EventNode: remove shimmer from reasoning; render reasoning lines as
      streaming markdown (inline spinner marks activity); stable layout.
- [x] Tests: ai-sdk 360 (100% coverage), web-editor 664, desktop 178 — all green.

## H2 — AI sidebar interactions `[x]` (2026-07-06)

- [x] Tools cards collapsed by default; expansion lifted into the sidebar
      (`expandedNodes` by node id) so it survives virtualization unmounts and
      lasts the whole run; animated via a grid-rows `.ai-accordion` (no
      measuring, no layout flicker).
- [x] Proposed Edits: header is the accordion toggle (verdict + op count stay
      visible, Accept/Reject stay reachable while collapsed); detail body
      collapsed by default; invalid edits open expanded so problems show.
- [x] Stop button: pulsing ring removed — static ring with hover/pressed/
      focus-visible states; labeled "Stop agent".
- [x] Settings from the AI sidebar deep-links to Settings → AI
      (`SettingsDialog.initialSection`; topbar still opens Display).

## H3 — Preview engine flicker & performance `[x]` (2026-07-06; background proxy queue tracked as follow-up)

**Findings:** the pooled element pipeline (pre-warm + visible-slot lag +
prepare-on-play, from the prior milestone) already removes cut stalls. Remaining
root causes found: (1) engine `generate_proxy` existed but was NEVER called —
previews always decoded originals; (2) `clipsActiveAt`/`upcomingVideoClips`/
`audibleAudioClipsAt` are O(all clips) and run PER FRAME at 60fps (per-frame CPU
growth on long projects); (3) video→still-image cuts flashed (img painted before
decode); (4) a gap kept the departed frame on screen over the empty state.

- [x] Proxy pipeline end-to-end: `/asset-media` gains `proxy` flag →
      `.framepilot-derived/<digest>/proxy.mp4` (idempotent reuse; sources over
      `FRAMEPILOT_PROXY_MAX_DURATION_SECONDS` skipped synchronously); desktop
      client + shared-types contract + renderer import request it for video;
      preview plays `previewMediaSrc` (proxy-first). Engine renders/export still
      use originals (render-vs-preview invariant).
- [x] `createPlaybackIndex` + `activeClipsAt`/`upcomingVideoFrom`/
      `audibleAudioAt`: built once per timeline, O(log n) per frame; wired into
      PreviewPlayer + PreviewAudioMixer (equivalence-tested vs the originals).
- [x] Image-cut gate: held video frame until the `<img>` decodes (`onLoad`).
- [x] Gap handling: slots hide when no picture clip is under the playhead.
- [ ] Follow-up: background proxy queue for feature-length sources (over the
      sync cap) + retrofit proxies for already-imported assets.

## H4 — Preview transform controls `[x]` (2026-07-06)

- [x] `add_keyframes` gains a mirrored `replace` flag (TS + Python, ±1ms
      same-property/same-time swap) so interactive controls SET the transform
      instead of stacking duplicate keyframes; append-only behavior unchanged
      when absent. Round-trip + parity tested in both engines.
- [x] The preview now RENDERS clip transforms live: keyframed scale/x/y are
      evaluated at the playhead and applied as percent-based CSS transforms to
      the visible slot / image (previously render-only — an H17-class gap).
- [x] Click the stage → selects the picture clip under the playhead; the
      selected clip shows a bounding box + corner handles. Drag repositions
      (canvas-pixel x/y), corners scale proportionally about the clip center
      (the engine's transform model is uniform scale — non-uniform stretch is
      deliberately not offered because the render cannot produce it).
- [x] Gestures live-preview locally and commit ONE validated patch on release
      (`setClipTransformPatch` → validate→apply→record; undoable; a dead click
      commits nothing). Pure gesture math unit-tested.

## H5 — Project orientation / canvas presets `[x]` (2026-07-06)

**Findings:** the canvas was already project config (`project.resolution`) and
every surface already derives from it — preview letterbox, overlays, safe-area
guides, and the engine render — so no schema change was needed; only the model
+ selector were missing.

- [x] `editor/orientation.ts`: presets 16:9 / 9:16 / 1:1 / 4:5 / 21:9 +
      aspect-based matching (a 4K 16:9 project still reads "16:9") + honest
      "Custom WxH" for non-preset canvases; pure `withOrientation` transform.
- [x] Orientation Select in the monitor transport; writes through the normal
      project-change path (autosaved), propagating everywhere by construction.

## H6 — Timeline zoom & thumbnail performance `[x]` (2026-07-06)

**Findings:** Cmd+wheel zoom was already rAF-coalesced (one store update per
frame) and lanes vertically virtualized, but (1) the filmstrip drew a FIXED
8-frame strip regardless of pixel width — at low zoom flex divided a narrow
clip into sub-pixel, invisible frames (the "thumbnails disappear" bug), at high
zoom 8 frames stretched; (2) every placeholder clip's canvas fully repainted on
EVERY ResizeObserver callback during a zoom gesture; (3) no horizontal culling —
off-viewport clips still painted filmstrip images/waveforms.

- [x] `filmstripSlots(widthPx)`: width-adaptive, quantized frame count
      (1..16, ~56px per frame) — a sliver always shows ONE real frame, wide
      clips fill instead of stretching; strip re-renders only when the slot
      count changes.
- [x] Placeholder-canvas repaints rAF-coalesced per clip.
- [x] `content-visibility: auto` on `.clip-block` — off-screen clips skip
      layout/paint of filmstrip/waveform internals (browser-level horizontal
      culling that keeps a11y + find-in-page).

## H7 — Timeline UI to match `artifacts/timeline-mock.html` `[x]` (2026-07-06)

**Findings:** the TIMELINE-REVAMP milestone already rebuilt the timeline against
this mock (clip anatomy v2: 56px lanes + alternation, title-bar/filmstrip/
waveform layers, 12×14 playhead knob, adaptive ruler). Remaining deltas were
token-level and are now aligned:

- [x] Playhead: mock's light `#e8e8ec` marker (was red) with a 1px hairline.
- [x] Ruler: 30px tall, 12px minor ticks, 10.5px major labels (mock values).
- [x] Clip chrome: 5px radius, 1px border (was 4px / 1.5px).

## H8 — No heavy work during playback `[x]` (2026-07-06)

**Findings:** playback advances a clock (no reducer dispatch — already good),
but three clock subscribers did per-frame O(n) work: TranscriptView re-rendered
the WHOLE transcript list every tick (regrouping lines + prefix sums included),
CaptionEditor re-rendered its full cue list every tick, and the preview's
active/upcoming/audible lookups were O(all clips) (fixed under H3).

- [x] TranscriptView: useSyncExternalStore over the clock with the ACTIVE WORD
      INDEX as the snapshot — re-renders only at word boundaries; lines/prefix
      sums memoized per transcript.
- [x] CaptionEditor: same pattern with the active caption-clip id.
- [x] `activeWordIndex` switched to binary search (runs per clock tick).
- [x] H3's `createPlaybackIndex` covers the preview/mixer per-frame lookups.

## H9 — AI orchestration audit `[x]` (2026-07-06)

**Audited:** provider transport (retry/backoff/timeout via ResilientProvider),
orchestrator stream modes + agent loop, desktop stream hub, sidebar run loop,
diff apply paths, conversation persistence.

**Already sound (verified, no change):** Accept commits ONLY through
`applyPatchChecked` (validate against the CURRENT timeline) and reports
`failed` honestly when a stale patch no longer applies — success is never
claimed without a real state change; batch apply stops at the first failure;
the agent loop dedupes by `patchId` (no duplicate execution) and bounds
blast radius per turn/run; run-level throws surface as error+failed events;
the hub distinguishes its timeout from a user Stop; aborts are sender-scoped.

**Defects found + fixed:**

- [x] Conversation autosave/delete failures were UNHANDLED REJECTIONS (silent
      data-loss path) — now caught and logged with context; the in-memory copy
      persists and the next append re-schedules the save.
- [x] `hydrate()` over a broken store rejected unhandled — now degrades to an
      empty start with a logged warning.
- [x] RACE: `stop()` aborted whatever session the CURRENT config resolves to;
      changing provider mid-run orphaned the in-flight stream (Stop broken).
      The sidebar now tracks the session that started the run and aborts THAT.
- [x] (Under H2) a partial desktop bridge degraded conversation persistence to
      browser backends instead of rejecting every call.

## H10 — Local project index `[x]` (2026-07-06)

**Findings:** the Cursor-style index already existed (`project-index.ts`) and
was already what the context builder + name resolver query — the orchestrator
never serializes the raw project (summaries are built over the index, tiered
and token-budgeted). Incremental sync is by construction: per-Track WeakMap
sub-indexes reuse untouched tracks across edits; a deleted asset cannot leave a
stale entry because the fresh snapshot simply no longer contains it.

- [x] `search()` is now RELEVANCE-RANKED (prefix > word boundary > substring;
      stable ties keep track/time order) over clip text + asset names.
- [x] `keyframedClips()` structural query (clip-level or effect-level
      animation), tolerant of pre-parse shapes.
- [x] Coverage back at 100% (ai-sdk 383 tests).

## H11 — GitHub Models + Copilot providers `[x]` (2026-07-06)

- [x] ai-sdk: `GitHubModelsProvider` (models.github.ai/inference, Bearer PAT) +
      `GitHubCopilotProvider` (api.githubcopilot.com with cached session-JWT
      exchange, IDE client headers, `gho_` direct fallback, `ghp_` rejection) —
      both OpenAI-compatible incl. SSE streaming; 100% coverage.
- [x] Wired through the factory (`GITHUB_MODELS_PAT`/`GITHUB_COPILOT_TOKEN`
      env fallbacks), shared-types `AiProviderName`, the desktop config store
      (back-compatible `ai-config.json`), stream-hub allowlist, orchestrator
      construction, and the browser session builder.
- [x] Settings → AI provider picker replaced with the app's own `Select`
      (keyboard/a11y per design system); shows all four real providers.

## H12 — Header refinement `[x]` (2026-07-06)

- [x] Project title absolutely centered in the topbar (immune to left/right
      group width; no layout shift). Save state reduced to the status DOT with
      the label in tooltip/aria; fixed-size across states.

## H13 — Right sidebar defaults to AI tab `[x]` (2026-07-06)

- [x] `rightTab` initial state is `'ai'`; selection does not yank the tab away.

## H14 — Global scrolling polish `[x]` (2026-07-06)

- [x] Content panes (AI stream, settings, transcript, inspector, media bin,
      recents, caption list) get `scroll-behavior: smooth` for programmatic
      jumps + `overscroll-behavior: contain` so nested panes never chain-yank
      their parents. The timeline scrollers get containment ONLY — auto-follow
      writes scrollLeft per frame and `smooth` would rubber-band the playhead.
- [x] Website already ships smooth scrolling with a reduced-motion fallback.

## H15 — Startup experience `[x]` (2026-07-06)

**Findings:** the branded license splash + inline dark pre-CSS paint already
existed; the remaining flicker was the BrowserWindow appearing before the
renderer's first paint (an empty dark window that pops to content), and a hard
splash→shell switch.

- [x] `show: false` + `ready-to-show` → the window appears only with a composed
      first frame.
- [x] 160ms shell fade-in over the identical canvas colour (reduced-motion
      aware) so splash → app reads as one continuous surface.

## H16 — Recent Projects `[x]` (2026-07-06)

- [x] Desktop already served latest-5 sorted via the bridge. Browser now keeps a
      tiny per-project meta (`name`, `openedAt`) so the home screen lists recents
      sorted by last opened WITHOUT parsing full project blobs; metas are touched
      on save and on open. Legacy blobs degrade gracefully.
- [x] Hardened `resolveConversationPersistence` to feature-detect the
      conversations API (a partial bridge degrades to IndexedDB/memory instead
      of rejecting every hydrate).

## H17 — Desktop feature audit report `[x]` (2026-07-06)

- [x] `reports/desktop-feature-audit.md` — full engine-vs-UI matrix with
      priority/effort/order. Top gaps: silence-analysis and scene-detection
      manual UI (both engine-ready, AI-only today); rotate handle; MCP bearer
      wiring; mask preview. Gaps closed this milestone: proxies (H3), live
      transforms + handles (H4), orientation (H5).

## H18 — Website redesign `[x]` (reopened 2026-07-06 — from-scratch redesign)

**History:** first closed as "verified current" (Phase 14 / ADR 0036 had shipped
a Cursor-token port). The maintainer explicitly rejected that resolution and
requested a genuine from-zero redesign, end to end.

**Direction (this pass):** original "cutting room" identity — warm soot-black
surfaces, single ember accent, film/timecode motifs (mono eyebrows, ruler ticks,
grain), Bricolage Grotesque display type over Geist body. Same polish bar as
cursor.com / omnisocials.com but original implementation, assets, and branding.

- [x] New design system in `globals.css` (tokens, type scale, motion, textures)
- [x] Rewrite all marketing chrome + sections (nav, footer, hero, features,
      how-it-works, pricing, FAQ, CTA, mockup) and every sub-page shell
      (pricing, download, blog, docs, changelog, thank-you, legal, 404)
- [x] Rebrand assets (icon, OG image, manifest/theme colors)
- [x] Verify: typecheck, lint, unit tests, `next build` static export green.
      No browser visual pass done (no browser tooling in this session) —
      recommend a manual look before/soon after shipping.

## H19 — Motion design system `[x]` (2026-07-06)

**Findings:** a coherent motion system already existed — tokens
(`--dur-fast`/`--dur`/`--ease`/`--ease-spring`), ~20 purpose-built keyframes
(menus, tooltips, toasts, dialogs, bin, transitions), and a global
prefers-reduced-motion gate.

- [x] Scale formalized + documented at the token block (micro / small surface /
      large surface) and completed with `--dur-med: 240ms` (accordions, drawers,
      resizing — already consumed by the H2 accordion).
- [x] Explicit rule recorded: never animate kill-switch controls (H2's stop
      button) or continuous scrubbing surfaces.

## H20 — File menu Home action `[x]` (2026-07-06)

- [x] File → Home returns to the Recent Projects screen; a dirty project is
      flushed (autosave forced) before leaving, and a failed save blocks the
      navigation with a message. Keyboard nav via the existing Menu component.

## H21 — Documentation updates `[x]` (2026-07-06)

- [x] ADR 0038 (milestone decisions: delta streaming, replace keyframes,
      bounded proxy derivation, boundary-stable clock subscribers, orientation
      as project config, GitHub providers, H18 resolution).
- [x] `CHANGELOG.md` Unreleased: full Added/Changed/Fixed for H1–H20.
- [x] Website changelog: customer-facing 1.2.0 entry
      (`2026-07-06-production-hardening.mdx`); static export verified.

## H22 — Performance validation + final report `[x]` (2026-07-06)

- [x] Micro-benchmarks over real built modules: stream fold 319ms/4k events →
      1.4ms/20k (incremental); reasoning transport 32.2MB → 275KB per 2k-chunk
      line; playhead queries 0.14ms/frame → 0.8µs/frame on 6,000 clips.
- [x] `pnpm verify` green (16/16 turbo tasks + engine pytest 478).
- [x] Final report: `reports/production-hardening-report.md`.
