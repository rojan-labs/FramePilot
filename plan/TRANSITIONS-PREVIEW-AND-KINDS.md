# Transitions: live preview rendering + wipe/slide kinds

> Status: [x] DONE — started 2026-07-17, completed 2026-07-17 (ADR 0061).
> Owner: Claude Code session. Parent: `plan/PLAN.md` Phase 6 (transitions) /
> TIMELINE-REVAMP M3 (transitions UX).

## Why

Transitions ship end-to-end today (op + validator + render engine + pills +
AI/MCP tools, ADR 0021) **except the live preview**: neither the WebCodecs
canvas engine nor the DOM `PreviewPlayer` applies the transition envelope, so
editors only see fades/pushes after an export or sidecar render. This plan
closes that gap desktop-first, and rounds out the kind set with `wipe` and
`slide` (the two standard kinds we lack — `push` only slides from the right).

Context: OpenCut (commit `6fdb1559`) was checked as a parity reference — it has
**no** transition implementation (roadmap item only), so parity is already
exceeded; this plan is driven by our own gap analysis.

## Invariants

- The Python engine (`render/transitions.py`) stays the source of truth for
  envelope semantics; the TS mirror must produce the same values (same
  constants, same linear progress) and is locked by unit tests.
- Transition storage is unchanged: one `transition` effect on the incoming
  clip, id `${toClipId}__transition`, params `{ kind, durationSeconds,
  fromClipId }`. **No timeline-schema change, no migration** — kinds live in
  op-type unions (editor-core + Pydantic), not in the Zod schema.
- `transition_overlap` validation is kind-agnostic and needs no change.

## Tasks

- [x] **K1 — editor-core kinds**: extend `AddTransitionOp.kind` union with
  `'wipe' | 'slide'`; op tests.
- [x] **K2 — Python engine kinds**: `AddTransition.kind` Literal + envelope
  math (`wipe_fraction_at` — alpha reveal left→right; `slide` = offset from
  bottom, reusing `offset_at` with direction) + compiler application
  (wipe = time-varying spatial alpha mask; slide = geometry path) + tests,
  100% cov on `render/transitions.py`.
- [x] **P1 — TS envelope mirror**: pure module
  `apps/web-editor/src/preview/transition-envelope.ts` covering all kinds
  (fade/cross-dissolve opacity, zoom scale, push/slide offset, blur radius,
  wipe fraction); unit tests pin values against the Python constants.
- [x] **P2 — WebCodecs canvas preview**: thread the incoming clip's transition
  through `clipCompositing`/`EngineSegment`; during draw apply
  `globalAlpha` ramp, extra scale/offset, `ctx.filter` blur, and a wipe
  clip-rect for the first `durationSeconds` of the segment. Transitions must
  NOT flip `canvasPreviewEligible` to false.
- [x] **P3 — DOM PreviewPlayer**: playhead-driven style ramp on the visible
  pool slot (opacity / transform / filter / `mask-image` gradient for wipe)
  driven by the same TS envelope module; stills skip transitions.
- [x] **T1 — tools + UI**: ai-sdk `add_transition` enum (+ dist rebuild),
  engine ai_tools schema if kind-enumerated, mcp-server schema,
  `TransitionPicker` entries for wipe/slide; `cut-and-transition-grammar`
  skill documents wipe/slide vocabulary + durations.
- [x] **V1 — verify + docs**: `pnpm verify` green (exit 0), `pnpm engine:test`
  1018 pass, engine lint/typecheck clean, editor-core + web-editor coverage
  gates pass, 100% cov on `render/transitions.py`; ADR 0061 + CHANGELOG;
  PLAN.md Phase 6 entry ticked.

## HANDOFF — historical (resolved 2026-07-17; all items below are complete)

Done and test-verified:

- **K1 done** — `AddTransitionOp.kind` union extended with `'wipe' | 'slide'`
  (`packages/editor-core/src/operations.ts:156`), round-trip test added
  (`operations.test.ts`, 99/99 pass). editor-core dist rebuilt.
- **K2 done** — Python: kind `Literal`s extended in
  `engine/python/framepilot_engine/timeline/operations.py:173` and
  `ai_tools/registry.py:178`. `render/transitions.py`: `slide` joined
  `affects_geometry`; `offset_at` now takes `(tr, t, frame_width,
  frame_height)` (push from right, slide from below); new `affects_wipe`,
  `wipe_progress_at`, `wipe_alpha(x_frac, p)`, `wipe_edge(p)`,
  `WIPE_SOFTNESS = 0.05` (soft left→right reveal, edge overshoots to
  `p*(1+softness)`). `render/compiler.py`: `_place_video_clip` passes
  `target_h`; `_attach_mask` composes the wipe as a vectorized per-column
  alpha row (numpy mirror of `wipe_alpha`) into the combined mask; wipe added
  to `nothing_to_mask` / `time_varying` guards. Tests: `test_transitions.py`
  (11 pass, incl. slide/wipe), `test_render_compiler.py` — `slide` added to
  the eases-in parametrize + new `test_compile_wipe_transition_reveals_left_first`
  (6/6 transition tests pass).
- **P1 done** — `apps/web-editor/src/preview/transition-envelope.ts`: pure TS
  mirror (same constants: ZOOM_FROM 1.6, PUSH/SLIDE_FRACTION 1.0,
  BLUR_FRACTION 0.04, WIPE_SOFTNESS 0.05) with `transitionFromClip`,
  `transitionProgress`, `affects*`, `transitionActiveAt`, `opacityAt`,
  `scaleAt`, `offsetAt(w,h)`, `blurRadiusAt`, `wipeProgressAt`, `wipeEdge`,
  `wipeAlpha`. `transition-envelope.test.ts` 10/10 pass.
- **P2 done** — WebCodecs canvas path renders transitions:
  `ClipCompositing` gained `transition: TransitionEnvelope | null`
  (`editor/selectors.ts`, populated by `clipCompositing`; deliberately NOT in
  `isIdentityCompositing` — activity is checked per frame). Engine
  `drawSource` (webcodecs-preview-engine.ts) applies globalAlpha
  (fade/dissolve), extra scale (zoom), canvas-px offset (push/slide), blur via
  `ctx.filter` (combined with grade filter), and a new `applyWipeMask`
  (destination-out gradient band = complement of `wipe_alpha`) after the
  picture draws, before overlays. Cheap identity path preserved when no
  envelope is ramping. `WebCodecsPreviewPlayer.tsx` strips `transition` from
  image segments (export parity: the compiler defers transitions on stills).
  `compositingSignature` already JSON-covers the new field → in-place refresh
  works. Repo TS typecheck green after `pnpm --filter @framepilot/editor-core
  build && pnpm --filter @framepilot/ai-sdk build` (dist-consumption rule).
- **T1 partially done** — ai-sdk `add_transition` z.enum extended (+ dist
  rebuilt; MCP server auto-derives from TOOL_REGISTRY, no change needed);
  web-editor `TransitionKind` union (patch-builders.ts), Inspector
  `TRANSITION_KINDS`, EffectsPanel `TRANSITIONS` catalogue (feeds
  TransitionPicker) all have wipe/slide.

Remaining (all completed in the follow-up session — kept for history):

1. **P3 — DOM PreviewPlayer** (`components/PreviewPlayer.tsx`), DONE:
   envelope imports were just added (aliased `transitionOffsetAt` /
   `transitionOpacityAt` / `transitionScaleAt`). Still to write, near the
   grade/crop/blend derivations (~line 640, after `clipTime` at ~line 598):
   derive `transition = videoClip && !isImageClip ? transitionFromClip(videoClip) : null`,
   gate with `transitionActiveAt(tr, clipTime)`; then in the visible slot's
   style (~line 726): multiply the `opacity: 1` branch by
   `transitionOpacityAt`; compose transform as
   `[envTranslate, cssTransform, envScale]` where env offsets come from
   `transitionOffsetAt(tr, clipTime, 100, 100)` used as PERCENT translate
   (element fills the frame box); append `blur(px)` (radius from
   `blurRadiusAt` with `min(resolution.w,h)`, fallback 720) to `gradeFilter`;
   wipe via `maskImage`/`WebkitMaskImage: linear-gradient(to right, black
   ${(wipeEdge(p)-WIPE_SOFTNESS)*100}%, transparent ${wipeEdge(p)*100}%)`.
   Do NOT touch the still-`<img>` branch (stills skip transitions).
2. **Skill docs**: `packages/ai-sdk/skills/cut-and-transition-grammar.md`
   still documents only the old five kinds — add wipe/slide vocabulary lines +
   duration taste, then `pnpm --filter @framepilot/ai-sdk build` (regenerates
   `skills/generated.ts` + engine `skills_generated.py`).
3. **V1 — verify + docs**: `pnpm verify` (note: prettier `format:check` is
   baseline-red on main — only format your own files; desktop typecheck
   excludes tests; rtk vitest parser flaky → `rtk proxy npx vitest run
   --reporter=basic`), `pnpm engine:test` via `uv run` (expect 954+ green;
   any red is ours), engine lint/typecheck (check the widened Literal lines
   for >88-char ruff violations). Update `docs/` (transitions guide/ADR if
   warranted), `CHANGELOG.md`, tick tasks here and reconcile `plan/PLAN.md`
   (a `[~]` entry was added at the end of the Phase 6 transitions block).
4. Optional follow-up: `panels.test.tsx` / selectors tests may want cases for
   the new picker entries and `clipCompositing().transition`.

Context worth keeping: OpenCut (pinned commit and latest main) has NO
transition implementation — parity was a false premise; this plan is our own
gap analysis. Validation (`transition_overlap`) is kind-agnostic — no changes
needed there. No timeline-schema/Zod change and no migration: kinds live only
in op unions and the effect's freeform params.

## Definition of Done

Scrubbing/playing across a cut with any transition kind shows the same
envelope the export produces (fade-from-black on sequential clips matches the
MoviePy composite over black); all kinds addable from the picker, the AI tool,
and MCP; both test suites green.
