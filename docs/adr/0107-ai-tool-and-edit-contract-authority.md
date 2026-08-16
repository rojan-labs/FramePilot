# 0107. AI tool and edit contract authority

- Status: Accepted
- Date: 2026-08-07

## Context

The AI audit found that correctness was spread across several partially-overlapping
contracts: provider JSON Schema, the TypeScript registry, autonomous-tool routing,
editor-core operations, the Python Pydantic mirror, host execution policy, and the
renderer. A value could therefore be legal at one boundary and meaningless or unsafe at
another. Examples included negative transition durations being repaired by frame
quantization, `transcribe` being treated as a parallel read although it commits project
state, arbitrary clip keyframe property names that the renderer ignores, and a
one-asset transcription replacing the whole project transcript.

The existing `ToolKind` axis (`read`, `mutate`, `analysis`, `action`, ...) is not rich
enough to describe execution semantics. An analysis can mutate state, a host read may
depend on the current project, and an export action must never be memoized.

## Decision

### 1. Tool execution policy is a first-class independent contract

`packages/ai-sdk/src/tool-contract.ts` defines these independent axes:

- execution plane: `in_process | host | human`
- effect class: `pure_read | mutation | action`
- permissions
- concurrency: `parallel | serial`
- state dependency: `none | project_revision | asset_content`
- cache scope: `none | run | project_revision | asset_content`

Scheduling and permission scoping consume that contract rather than maintaining their
own special-case lists. `transcribe` and `index_media` are explicitly host mutations,
serial, write-capable, and non-cacheable. Render/export state dependencies are also
explicit.

### 2. Tool input has structural and semantic layers

The registry remains the structural schema source. `tool-input-contract.ts` adds the
cross-field and renderer-backed invariants JSON scalar constraints cannot express:
ordered windows, one-domain `map_time`, normalized tracker containment, closed clip
keyframe properties, renderer-supported color operations, and bounded audio values.
The installer wraps `parse`, `read`, and `buildOps`, so normal agent calls, autonomous
routing, and MCP share the same input authority.

### 3. Editor-core patch application is the final semantic authority

`assertOperationContract` is enforced by `applyPatch`, `applyProjectPatch`, and inverse
replay. AI/MCP assembly still validates early to return a useful rejected-edit result,
but it is no longer the only place protecting locked tracks, ranges, keyframes, effects,
audio values, tracker geometry, and renderer-supported color operations. Any future
caller that reaches the canonical patch engine receives the same guard.

### 4. Transcript replacement is asset-scoped when attribution identifies one asset

`set_transcript` now supports an explicit `assetId`. A single-asset attributed ASR
payload replaces only that asset's words. `assetId: null` is reserved for an explicit
whole-project replacement and is used by inverse snapshots so undo remains exact.
This prevents transcribing a second camera/audio file from deleting another asset's
transcript.

### 5. Project diffs cover all persistent patch axes

`editor-core.diffProject()` now reports timeline, assets, folders, markers, and
transcript changes. Review/completion code no longer needs an AI-specific marker or
transcript diff implementation.

### 6. Cross-language drift is not an accepted state

The Python mirror installs strict tool-input models without tightening legacy persisted
project models. The schema-parity suite has no known-drift/xfail allowlist: required
fields, enums, strictness, types, and numeric bounds are compared against the generated
TypeScript fixture. Renderer-backed semantic rules have dedicated regression coverage
in both languages.

## Consequences

- Invalid intent fails closed instead of being silently repaired into a different edit.
- UI, AI, MCP, and future patch callers share editor-core semantic safety.
- Transcription ownership is deterministic in multi-asset projects.
- The renderer's actual supported keyframe/color/audio domains become part of the edit
  contract instead of informal documentation.
- New exceptional host tools must declare execution semantics in the canonical tool
  contract metadata rather than adding scheduler or permission special cases.
- Project-file Pydantic models remain backward-compatible; strictness is added at the
  untrusted agent-input boundary, avoiding an unrelated persisted-schema migration.

## Verification and what it changed

The tests were written before they were run. Running them changed the design in four
places, which is worth recording because each is a way this class of hardening goes wrong:

**"Required" is not the same as "has no default."** The Python mirror made
`add_clip.sourceStart`, `add_track.type`, and `add_asset.kind` mandatory, so a call the TS
registry accepts was rejected at the sidecar — the exact cross-surface split this ADR
exists to remove. The parity fixture agreed with the wrong answer because Zod lists a
`.default(x)` field in `required` even though `parse({})` succeeds and fills it in. The
normalization now drops defaulted fields from `required` on both sides (version 2), so
`required` means "the caller must supply this" everywhere. **Accepting a documented default
or a documented legacy spelling is not the same as repairing an invalid value** — the
former is part of the contract, the latter is what this ADR forbids.

**Refusing to cache is not the same as scoping a cache.** The first implementation dropped
the derived idempotency key entirely, which stopped `analyze_silence` and the other
asset-content analyses from caching at all. The key is now derived from the tool's declared
`cacheScope`: absent for `none` (preview, export, transcribe, index), stamped with the
timeline revision for `project_revision` (`get_frame`), and name+arguments for
`asset_content`. An explicit caller key still cannot override a `none` scope.

**Scope must be addressable.** Autonomous idempotency was keyed on the adapters object, but
callers construct adapters per request, so every lookup missed and the feature was silently
dead. It is keyed by caller key + initial revision + request, and bounded.

**A guard that reads optional state must treat it as optional.** `diffProject` read
`project.markers` and `project.transcript` directly; both are optional, so the whole diff —
and the review UI with it — threw for any project without them.

Two smaller corrections: rejections surfaced the internal `PatchError` envelope (patch id
and operation index) in user-facing copy, and the Python autonomous mirror was a
hand-maintained copy that had already gone stale at v1 against a v2 manifest. The former
unwraps to the underlying reason; the latter is now generated by
`pnpm --filter @framepilot/ai-sdk generate:autonomous-tools` and guarded by a drift test.

Verified with `pnpm verify`: TypeScript typecheck/lint/tests at the 100% coverage gate,
2437 Python tests, `ruff` and `mypy` clean.

### Open product question

`contrast` is bounded to `-1..1` on both surfaces. The renderer applies
`(rgb - 0.5) * (1 + contrast) + 0.5` with no clamp, so values above 1 render correctly —
the ceiling is a product choice, not a renderer-backed limit, and it currently refuses a
legitimately strong grade. Confirm or widen it deliberately.
