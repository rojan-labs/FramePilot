# AI Contract Hardening

**Status:** `[x]` Implemented and verified

**Last updated:** 2026-08-08

This sub-plan tracks the closure of the AI/orchestration/tool/engine audit follow-ups.
The verification pass has now run: `pnpm verify` is green (TS typecheck/lint/tests at the
100% coverage gate, and 2437 Python tests), so every item below is marked `[x]`.

## Remaining-audit closure

- [x] **TypeScript ↔ Python tool-schema parity**
  - Python tool input models are tightened at the agent boundary without changing legacy project-file parsing.
  - Schema parity no longer has a known-drift/xfail allowlist.
  - Required fields, strictness, enums, types, and numeric bounds are compared against the generated TypeScript registry fixture.
  - Renderer-backed semantic rules have dedicated TypeScript and Python regression tests.

- [x] **Asset-scoped transcript replacement**
  - `set_transcript` accepts explicit asset scope and infers a single attributed asset when possible.
  - A one-asset transcription preserves every other asset's words.
  - `assetId: null` is an explicit whole-project snapshot used for exact undo.

- [x] **Canonical editor-core semantic authority**
  - `applyPatch`, `applyProjectPatch`, and inverse replay enforce `assertOperationContract`.
  - Locked tracks, invalid ranges, renderer-unsupported keyframes/colors, invalid effect params, audio bounds, tracker geometry, and effect-layer intensity cannot be bypassed by a non-AI caller.

- [x] **Canonical project diffs**
  - `editor-core.diffProject()` covers timeline, assets, folders, markers, and transcript.
  - AI assembly consumes that authority instead of maintaining a second project-diff implementation.

- [x] **Closed clip keyframe contract**
  - Renderer-supported properties are `scale`, `x`, `y`, `rotation`, and `opacity`.
  - Unsupported names fail closed.
  - Scale and opacity use renderer-backed value domains.

- [x] **Renderer-backed audio/color/effect values**
  - Color grade permits only renderer-supported `color_grade` and `lut` operations.
  - Named grade parameters use declared ranges.
  - Audio gain, duck amount, fade curves, and fade duration are bounded.
  - Effect-layer parameters use the existing effect-kind descriptor catalog.

- [x] **Ordered read/edit windows**
  - `get_transcript`, `get_mapped_transcript`, `get_clips`, edit ranges, `apply_effect`, and `punch_in` reject inverted explicit windows.

- [x] **Unambiguous `map_time`**
  - Exactly one of source or sequence time may be requested.
  - `assetId` is valid only with source time.
  - Provider-facing schema advertises the same domain split.

- [x] **First-class tool execution metadata**
  - Tool execution policy is represented as independent execution plane, effect class, permissions, concurrency, state dependency, and cache scope axes.
  - Permission scoping and batching consume the same contract.
  - `transcribe`/`index_media` are host mutations, serial, write-capable, asset-content-dependent, and non-cacheable.
  - `get_frame`, preview, and export declare their project dependency/cache behavior.

- [x] **Transition recovery naming**
  - Model-facing/runtime guidance uses `discover_transitions`, not the removed `list_transitions` name.

## Regression coverage written

Tests cover transition invalid-duration preservation, strict unknown arguments, host cache behavior, autonomous manifest/router contracts, canonical locked-track enforcement, keyframe/color/audio/tracker contracts, multi-asset transcript replacement + undo, marker/transcript project diffs, relational input windows, one-domain `map_time`, tool execution metadata, and Python parity/semantic contracts.

## Verification

- [x] TypeScript unit/integration tests pass (100% coverage gate met in `editor-core` and `ai-sdk`)
- [x] Python engine tests pass (2437 passed, 1 skipped)
- [x] Typecheck/lint pass (`pnpm typecheck`, `pnpm lint`, `ruff check`, `mypy`)
- [x] Schema parity fixture regenerated (normalization v2)
- [x] GitHub Actions pass

### Corrections made during verification

Running the suite surfaced defects the implementation pass could not have seen:

- **Parity was inverted for defaulted arguments.** `add_clip.sourceStart`, `add_track.type`,
  and `add_asset.kind` carry a `.default()` in the TS registry, so omitting them is a legal
  call — but the Python mirror made them required. Zod lists defaulted fields in `required`
  even though `parse({})` succeeds, so the fixture agreed with the wrong answer. `required`
  now means "the caller must supply this" on both sides (normalization v2).
- **Host caching was disabled, not scoped.** Removing the derived idempotency key stopped
  `analyze_silence` and friends caching at all. Keys are now derived per `cacheScope`:
  never for `none`, revision-stamped for `project_revision`, name+args for `asset_content`.
- **Autonomous idempotency never hit.** Scoping the completed-run store by the adapters
  object meant every lookup missed, since callers build adapters per request. It is scoped
  by key + initial revision + request, and bounded.
- **`diffProject` crashed on projects without markers/transcript.** Both fields are
  optional; reading them unguarded took down the review UI.
- **Rejections leaked internal patch ids** into user-facing copy via `PatchError`.
- **The Python autonomous mirror was stale** (v1 vs manifest v2) and hand-maintained; it is
  now generated by `pnpm --filter @framepilot/ai-sdk generate:autonomous-tools`.

### Follow-up worth a product decision

`contrast` is bounded to `-1..1` on both surfaces. The renderer applies
`(rgb - 0.5) * (1 + contrast) + 0.5` and does not clamp, so values above 1 render fine;
the ceiling is a product choice, not a renderer limit. Confirm before it reaches users who
want a harder grade.

See `docs/adr/0107-ai-tool-and-edit-contract-authority.md` for the architecture decision.
