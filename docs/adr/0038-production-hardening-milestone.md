# ADR 0038 — Production Hardening & UX Refinement Milestone (Phase 15)

- **Status:** Accepted
- **Date:** 2026-07-06
- **Plan:** `plan/PRODUCTION-HARDENING.md` (H1–H22)

## Context

A release-candidate pass across the AI streaming pipeline, preview engine,
timeline, desktop shell, and providers. The mandate was root-cause fixes, not
surface patches; every change carries a documented finding.

## Decisions

### 1. Streaming reasoning is delta-based end to end (H1)

The reasoning sink re-shipped the FULL accumulated text per token — O(n²) IPC
bytes and persisted-log growth — while the sidebar re-folded the whole event log
per token (O(n²) CPU) and dispatched one React update per chunk. We added a
`reasoning_delta` event (mirroring `assistant_delta`: one canonical snapshot per
line, then O(chunk) deltas), refactored `reduceEvents` onto an incremental
`createConversationViewBuilder`, and frame-batch appends (`appendMany` + a rAF
batcher). Tokens paint within a frame at O(new events) cost. Reasoning renders
as streaming markdown; shimmer was removed (the text itself signals activity).

### 2. Interactive transforms use `add_keyframes { replace: true }` (H4)

Interactive controls need "set the transform", but `add_keyframes` was
append-only — duplicate same-time keyframes stacked and the first silently won.
Rather than a new operation (bigger cross-language surface), the op gained a
mirrored optional `replace` flag: an incoming keyframe replaces an existing one
with the same property within ±1ms. Backward compatible; TS and Python apply
identically; invert still restores the prior clip snapshot. The preview now
also RENDERS transform keyframes live (percent-based CSS), which it never did.

### 3. Preview proxies are derived on import, synchronously bounded (H3)

`generate_proxy` existed but had no caller. `/asset-media` gained a `proxy`
flag: proxies land in `.framepilot-derived/<digest>/proxy.mp4` (idempotent
reuse), sources longer than `FRAMEPILOT_PROXY_MAX_DURATION_SECONDS` (default
15 min) skip synchronous derivation — an import must stay bounded; a background
proxy queue for long footage is the recorded follow-up. The preview plays
`previewMediaSrc` (proxy-first); the render engine still reads originals
(render-vs-preview invariant).

### 4. Playback-clock subscribers must do boundary-stable work (H8)

The playhead clock already avoided reducer dispatch, but subscribers did
per-frame O(n) work (whole-transcript re-render per tick; O(all clips)
active-clip scans). Convention now: subscribe via `useSyncExternalStore` with a
BOUNDARY-STABLE snapshot (active word index, active caption id) and query the
memoized `createPlaybackIndex` (O(log n)) — never scan the timeline per frame.

### 5. Canvas orientation is project config, not export config (H5)

`project.resolution` was already the single source the preview, guides, and
render derive from; the milestone added the preset model (aspect-matched, so a
4K 16:9 project reads "16:9") and a monitor-transport Select that writes
through the normal project-change path. No schema change.

### 6. GitHub Models + Copilot as first-class providers (H11)

Both speak OpenAI-compatible `/chat/completions`. Copilot additionally
exchanges the GitHub token for a cached session JWT (`copilot_internal/v2/token`,
IDE client headers, `gho_` direct fallback on 404/401, actionable `ghp_`
rejection). `FetchLike.body` became optional for the header-only GET exchange.
The Settings provider picker moved to the app's own `Select`.

### 7. H18 (website redesign) resolved as "verified current"

Phase 14 (ADR 0036) already shipped the Cursor-inspired site; re-doing it weeks
later would be a large unreviewed rewrite (CLAUDE.md §6). Verified green and
recorded; a future visual refresh should be its own design-first milestone.

## Consequences

- Conversation logs shrink dramatically for long agent runs (O(n) vs O(n²)).
- Old persisted logs replay unchanged (`reasoning_delta` is additive; the
  reducer contract is preserved and equivalence-tested).
- The `replace` keyframe flag is available to AI tools later without schema work.
- Long-source proxy derivation and the CV-gated tools remain explicit follow-ups
  (`plan/PRODUCTION-HARDENING.md`, `reports/desktop-feature-audit.md`).

## Verification

ai-sdk 383 (100% coverage) · editor-core 173 · web-editor 702 · desktop 179 ·
shared-types 19 · engine 478 (pytest) · website 15 + static export — all green,
with typecheck/eslint/ruff/mypy clean per package.
