# Autonomous Editing Phase 0 Evidence and Diagnosis

> **Status:** `[!]` blocked at the runtime evidence gate. Repository inspection is complete. A real desktop Agent-mode baseline over local media has not been executed in this connector session, so this document does not claim that a current runtime root cause has been proven.
>
> **Date:** 2026-08-05
>
> **Scope:** Phase 0 only. No production implementation is authorized by this document.
>
> **Branch:** `plan/autonomous-edit-phase0-diagnosis`

## 1. Evidence boundary

This phase has two kinds of evidence and they must not be mixed.

### Repository-proven findings

The following are confirmed directly from the current branch:

1. The canonical model-facing registry is large and exposes overlapping read, analysis, mutation, verification, discovery, project, action, and interaction tools.
2. The registry exposes `index_media` as a model-facing action even though the requested product behavior is automatic, implicit indexing.
3. The current ASR provider contract still contains `whisper-cli`, `twelvelabs`, `groq`, and `nvidia`, while the required user-facing choices are only Local and TwelveLabs.
4. Timeline and operation contracts predominantly represent time as floating-point seconds. Shared types define `Seconds = number`; operations, validation, keyframe matching, and model-generated operation ids use second-based numeric arithmetic and rounding.
5. The TwelveLabs integration already has a typed SDK-backed client for index creation, upload/index progress, search, image search, indexed native transcription, and Pegasus analysis/summarization.
6. Existing TwelveLabs persistence covers asset/index mappings and some content-hash footage-map reuse. It is not one universal cache for every search, analysis, timestamp query, result shape, failure, and concurrent duplicate request.
7. The AI event stream and sidebar already support typed tool lifecycle events, duration, summaries, errors, virtualization, and an `ask_user` card.
8. Visual payloads obtained by the model are not represented as a dedicated, first-class visual evidence event in the transcript. The current tool-card path mainly renders text summaries and details.
9. `ask_user` renders an `answerSummary` string after completion. The UI has no typed question/answer summary contract that guarantees a human sentence, so a producer can still pass serialized structured data.
10. Accepted historical ADRs describe an older TwelveLabs policy, including optional fallback behavior and older transcription/description limitations. Current code has superseded parts of those decisions. A superseding ADR is required rather than silently contradicting them.

### Runtime evidence still required

The following cannot honestly be claimed from repository inspection alone:

- Which current layer causes the reported unsatisfying edit on the exact 30-second media case.
- Whether the live failure is a no-op, trivial patch, wrong cut point, validation rejection, stale-project apply failure, preview mismatch, render mismatch, weak editing judgment, or a combination.
- Whether existing July and August fixes already removed any historical failure that appears in old plan notes or commit history.
- Whether current TwelveLabs credentials, entitlements, index state, and provider settings reproduce the same behavior on the user's machine.
- Whether Electron host events currently disappear because of a live wiring failure rather than missing event types.

**Rule:** historical bug notes are leads, not proof. Phase 1 cannot begin until the exact current failure is captured on the desktop path.

## 2. Required baseline scenario

Create a durable fixture at a repository-controlled path such as:

`tests/golden/autonomous-edit-30s/`

The fixture must use real camera or screen-recording media, not a synthetic JSON-only timeline. Keep the original media, imported project, provider configuration manifest with secrets redacted, expected intent files, trace output, final project snapshots, preview render, and final render.

### Fixture shape

- Total source duration: 25 to 40 seconds.
- Three to six clips, or one source clip split into several meaningful shots.
- Spoken content with at least two pauses and one sentence that should not be cut mid-word.
- At least one visually identifiable event that can be queried by timestamp.
- Audio present for at least one baseline. Add separate no-audio and image-only edge fixtures later.
- Known frame rate and deterministic ffprobe metadata recorded with the fixture.

### Required intents

Run these as independent clean project copies:

1. `Make this a tight 20-second cut. Keep the clearest explanation and remove dead air.`
2. `Remove the silences and add readable, accurately timed captions.`
3. `Turn this into a 9:16 Reel with a strong hook in the first three seconds.`
4. `Keep only the useful explanation. Do not cut through words or make the audio feel abrupt.`
5. `Make the pacing feel intentional and polished, then verify the final result before finishing.`

### Trace fields

Capture one correlated trace per run:

- run id, turn id, task id, tool call id, patch id, project revision, provider, model, and cache key;
- system contract and selected editing skills by stable version/hash;
- planner output and task DAG;
- every tool name, arguments after sanitization, start/end time, result summary, full result artifact reference, status, retry count, timeout, and cancellation state;
- visual evidence payload metadata and the exact rendered frame/thumbnail used by the model;
- model proposal before assembly;
- typed operations after assembly;
- canonical frame conversion for every timestamp;
- validation result, every issue code, user-facing explanation, and correction attempt;
- apply result, inverse patch, project revision before/after, and idempotency key;
- preview result, render result, critic/verification result, and final timeline snapshot;
- external API call, cost relevance, cache hit/miss, and redacted provider response metadata;
- errors that were recovered, skipped, swallowed, downgraded, or surfaced.

### Failure record format

For each failed intent, record:

| Field | Required content |
| --- | --- |
| Symptom | What the editor sees or hears in playback. |
| Trigger | Exact media, intent, project revision, provider, and condition. |
| First divergence | Earliest point where expected and actual behavior differ. |
| Root cause | The responsible contract or implementation layer, proven by trace. |
| Secondary effects | Later failures caused by the first divergence. |
| Fixed by | Phase and test that closes the failure. |

## 3. Root-cause classification matrix

Every baseline failure must be assigned to one or more of these buckets:

1. **Intent contract:** the system prompt or selected skill does not translate the request into measurable edit goals.
2. **Planning:** the plan omits required analysis, orders work incorrectly, or stops before committed work is complete.
3. **Tool selection:** descriptions overlap, the correct tool is absent, or routing selects a cheaper but insufficient tool.
4. **Tool result quality:** output is too coarse, not timestamped, not frame-aware, lacks provenance, or omits word/shot boundaries.
5. **Time conversion:** source, clip, sequence, frame, and render time are rounded or mapped inconsistently.
6. **Patch construction:** operation arguments are incorrect, stale, duplicated, incomplete, or reference the wrong identity namespace.
7. **Validation:** a valid edit is rejected, an invalid edit passes, or the reason does not reach the model and user.
8. **Apply/invert:** a validated patch does not land atomically, lands on stale state, cannot invert, or is reported as applied when rejected.
9. **Preview/render parity:** the timeline state is correct but preview or render does not represent it.
10. **Editing craft:** the operation is mechanically valid but pacing, hook placement, continuity, caption grouping, or transition choice is poor.
11. **Guard behavior:** a destructive-edit or wipe guard blocks a legitimate request, or permits an unsafe one.
12. **Observability:** the failure exists but the orchestrator trace or sidebar hides the decisive event.

## 4. Confirmed architecture risks to test first

### 4.1 Floating-point seconds are not a frame-precision contract

The current project and operation path uses numeric seconds in many public contracts. The target requires frame-accurate behavior across model output, patch construction, validation, preview, and render.

**Decision for Phase 1:** introduce one canonical internal edit-time contract based on integer frame indices plus an explicit rational frame rate. Convert source seconds, transcript seconds, and provider timestamps at named boundaries with one rounding policy. Do not change the persisted project schema during the first repair slice. If exactness cannot be guaranteed without persisting frame-time values, stop and request approval for a versioned schema migration.

Required properties:

- no implicit float comparison for edit identity;
- no millisecond-derived idempotency keys for frame operations;
- explicit inclusive/exclusive range semantics;
- exact source-to-sequence mapping through trims, speed, reuse, and ripple edits;
- one-frame tolerance only where an external timestamp source is inherently approximate;
- frame/time conversion utilities mirrored and parity-tested in TypeScript and Python.

### 4.2 The model-facing tool surface is too broad

The current registry contains many operation-shaped tools, multiple overlapping project/timeline reads, several discovery tools, separate verification tools, semantic-analysis tools, and explicit indexing. This increases prompt size and creates several plausible routes for the same intent.

The long-term registry should distinguish:

- **model-facing capabilities**, small and task-oriented;
- **internal typed operation builders**, comprehensive and not separately advertised;
- **orchestrator-owned mandatory stages**, such as validation, cache lookup, indexing, verification, apply, and rollback;
- **UI/MCP projections**, generated from the same canonical contracts without exposing internal implementation tools by accident.

### 4.3 Existing cache coverage cannot guarantee no duplicate TwelveLabs billing

Mapping and footage-map reuse are useful but insufficient. Search and analyze calls with identical semantic inputs can still bypass a universal deterministic cache. Concurrent duplicate requests are not proven to collapse into one call.

### 4.4 Provider policy is inconsistent with the requested product

User-facing STT must expose only Local and TwelveLabs. Embeddings must be TwelveLabs-only. Caption generation must not expose a provider concept. These are three separate policies and must not be conflated.

### 4.5 Sidebar visibility is event-rich but evidence-poor

The event model can show that a tool ran. It does not yet guarantee that the actual frame or clip used for a visual conclusion is rendered as a first-class transcript item with timeline navigation and provenance.

## 5. Current tool inventory and disposition

This inventory is derived from the canonical TypeScript registry inspected in Phase 0. Before removal, add a generated inventory/parity test so a registry change cannot leave the Python mirror, MCP projection, tool metadata, prompt cache surface, or UI labels stale.

### Read, mapping, verification, discovery

| Current tool | Recommendation | Reason |
| --- | --- | --- |
| `list_assets` | Merge into `inspect_project` | Asset identity and lightweight metadata belong in one bounded project inspection contract. |
| `get_project_state` | Remove from model prompt | Full-state dumps are costly and overlap targeted inspection. Keep internal/debug access only. |
| `get_timeline` | Merge into `inspect_timeline` | Preserve deep mode behind pagination/range arguments. |
| `get_transcript` | Merge into `inspect_transcript` | Make source-time semantics explicit. |
| `propose_edits` | Keep, rename `plan_edit_candidates` | It is deterministic planning support, not a generic read. |
| `recall_evidence` | Keep | Prevents repeated paid or expensive reads and supports bounded context. |
| `get_timeline_summary` | Merge into `inspect_timeline` | Summary becomes default mode. |
| `get_timeline_map` | Merge into `inspect_timeline` | Mapping is a view of the same canonical timeline contract. |
| `map_time` | Keep as `resolve_time` | Precise source/clip/sequence mapping is a distinct deterministic job. |
| `get_mapped_transcript` | Merge into `inspect_transcript` | Add `timeDomain: source|sequence` and revision provenance. |
| `list_edit_boundaries` | Merge into `inspect_timeline` | Boundaries are deterministic timeline-derived data. |
| `verify_captions` | Internal mandatory verifier | The model should not decide whether to validate captions. |
| `verify_transitions` | Internal mandatory verifier | The model should not decide whether to validate transitions. |
| `get_clips` | Merge into `inspect_timeline` | Range and pagination become arguments. |
| `get_clip` | Merge into `inspect_timeline` | Deep lookup becomes `clipIds` mode. |
| `get_selected_range` | Merge into `inspect_project` | Selection is session context. |
| `load_skill` | Keep | Skills are a stable craft contract. Pin loaded skill version/hash in the trace. |
| `discover_caption_styles` | Merge into `discover_capabilities` | One bounded catalog query with `domain: captions`. |
| `discover_effects` | Merge into `discover_capabilities` | One bounded catalog query with `domain: effects`. |
| `discover_transitions` | Merge into `discover_capabilities` | One bounded catalog query with `domain: transitions`. |

### Timeline and project mutations

| Current tool or family | Recommendation | Reason |
| --- | --- | --- |
| `trim_clip`, `split_clip`, `delete_range`, `delete_clip`, `delete_clips`, `ripple_delete`, `move_clip` | Merge into `propose_timeline_patch` | Retain the discriminated typed operations internally. Remove separate model-routing choices. |
| `add_track`, `remove_track`, `move_track` | Merge into `propose_timeline_patch` | Track operations remain typed and guard-protected. |
| `add_clip`, `add_text_layer`, `add_caption_layer` | Merge into `propose_timeline_patch` | One patch proposal can contain an ordered operation batch and validate atomically. |
| `set_caption_cue`, track/cue caption styling tools, and `auto_emphasize_captions` | Merge into `propose_timeline_patch` | Preserve all caption capabilities and TS/Python render parity. |
| `add_keyframes`, `punch_in`, `set_clip_speed`, `set_clip_crop`, `set_clip_blend_mode` | Merge into `propose_timeline_patch` | These are operation variants, not separate reasoning jobs. |
| `apply_color_grade`, `adjust_audio`, `add_transition`, `add_mask`, `track_object` | Merge into `propose_timeline_patch` | Capability discovery remains separate; mutation is one validated patch contract. |
| `set_track_flags`, track caption style operations | Merge into `propose_timeline_patch` | Keep safety checks and exact inverses. |
| Effect-layer add/update/move/duplicate/bypass/remove tools | Merge into `propose_timeline_patch` | Keep the internal operation family and generated inspector/catalog contracts. |
| `add_asset`, `manage_assets` | Keep behind `propose_project_patch` | Project mutations have different validation and path-sandbox concerns from timeline edits. |
| `add_marker`, `remove_marker` | Merge into `propose_project_patch` or timeline patch according to current ownership | Preserve typed, reversible marker operations. |

### Analysis, action, and interaction

| Current tool | Recommendation | Reason |
| --- | --- | --- |
| `get_frame` | Keep as `sample_frame` | Deterministic rendered visual evidence with timestamp and source provenance. |
| `transcribe` | Keep as `transcribe_media` | Route only to Local or TwelveLabs. Return word-level timestamps and provenance. |
| `analyze_silence` | Keep | Deterministic/local edit signal with frame-aware boundaries. |
| `detect_scenes` | Keep | Required shot-boundary signal. |
| `detect_beats` | Keep | Required rhythm signal when audio exists, honest unavailable otherwise. |
| `search_media` | Merge into `search_footage` | One semantic search contract, backend selected by capability policy. |
| `search_visual` | Merge into `search_footage` | Use modalities and query scope as arguments. |
| `find_similar` | Remove from model surface until TwelveLabs-only embedding semantics are proven | Current non-TwelveLabs routes conflict with policy. Reintroduce as a search mode if supported. |
| `describe_footage` | Merge into `analyze_footage` | Analyze handles open-ended segment/project understanding. |
| `map_footage` | Merge into `analyze_footage` | Time-ordered map is an analysis mode and should reuse the same facade/cache. |
| `index_media` | Remove from model and user surfaces | Replace with internal `ensure_media_understanding`, called automatically. |
| `session_context` | Merge into `inspect_project` | Session/project context should be deterministic and bounded. |
| `render_preview` | Keep | Preview is a distinct external action and evidence source. |
| `export_video` | Keep, gated after verification | Export only after validated and verified state. |
| `ask_user` | Keep | First-class blocking interaction with typed answer summary. |
| `detect_faces`, `generate_mask` | Keep unavailable internally, omit from advertised registry | Do not prompt the model with unavailable capabilities. |

### Proposed model-facing shortlist

1. `inspect_project`
2. `inspect_timeline`
3. `inspect_transcript`
4. `probe_media`
5. `sample_frame`
6. `resolve_time`
7. `search_footage`
8. `analyze_footage`
9. `query_timestamp`
10. `analyze_silence`
11. `detect_scenes`
12. `detect_beats`
13. `plan_edit_candidates`
14. `discover_capabilities`
15. `load_skill`
16. `recall_evidence`
17. `propose_timeline_patch`
18. `propose_project_patch`
19. `render_preview`
20. `export_video`
21. `ask_user`

The following stay orchestrator-internal and are never optional model choices:

- `ensure_media_understanding`
- `ensure_twelvelabs_index`
- cache read/write/single-flight
- patch assembly
- validation
- correction loop
- apply/invert/rollback
- deterministic verification
- run persistence and event emission

## 6. Conflict resolutions

### 6.1 No manual embeddings versus embed tools

**Decision:** embedding/indexing is an internal capability. The user never clicks an embedding action and the model never needs a public `index_media` choice. `search_footage` and `analyze_footage` call `ensure_media_understanding` automatically. If an agent-facing embed contract is retained for internal orchestration tests, it is excluded from the user UI and default model prompt.

### 6.2 Keep current transcription pipeline versus only Local and TwelveLabs

**Current code:** the provider type includes four values.

**Decision:** preserve the working Local (`whisper-cli`) and TwelveLabs indexed-transcript implementations. Remove Groq and NVIDIA from every user-visible selector and new-run provider contract. Migrate persisted Groq/NVIDIA choices to Local, record a one-time plain-language notice, and retain no dead adapters after all callers and fixtures are migrated. Do not reinterpret Pegasus analysis as speech-to-text.

### 6.3 No caption provider

**Decision:** remove only the provider-selection surface and persisted provider preference associated with caption generation. Preserve:

- transcript generation;
- transcript-to-cue segmentation;
- caption tracks and cue editing;
- templates, fonts, styles, auto emphasis, positioning, animation, and safe-area behavior;
- TypeScript schema/catalog and Python renderer parity;
- caption verification and golden render coverage.

For older projects/settings, ignore or remove the persisted caption-provider field during settings migration while preserving caption content. Confirm exact remaining selector/key call sites with a local repository grep before deletion.

### 6.4 TwelveLabs STT versus analyze

**Decision:** treat them as separate capabilities. TwelveLabs speech text comes from the indexed asset/transcription workflow already represented in the installed SDK integration. Pegasus analyze/summarize is semantic understanding. Do not invent a standalone STT endpoint or claim analyze provides word-level transcript timing unless the installed SDK types and real response prove it.

### 6.5 Offline behavior

| Capability | Offline/unconfigured behavior |
| --- | --- |
| Local media probe, frame sample, silence, scene and beat analysis | Available if the local sidecar and media are available. |
| Local transcription | Available. |
| Timeline inspection, patch planning, validation, apply, undo, preview/render | Available according to local engine support. |
| TwelveLabs search/analyze/index/native transcript | Unavailable with a typed reason and recovery action. Never silently replaced by another embedding provider. |
| Semantic visual questions requiring TwelveLabs | Ask for configuration/network recovery, or answer only from deterministic local evidence when the question is locally computable. |
| Cached completed TwelveLabs result | Available offline from persistent cache with `cached: true` provenance. |

### 6.6 Cost and consent

**Decision:** setting a TwelveLabs key includes a one-time cost disclosure. Cloud indexing is automatic after consent, triggered on the first semantic need or Agent run for an unprepared asset. An optional user preference may warm assets after import, but there is no manual embedding button. Every cost-relevant call is visible in the sidebar before/during execution. Completed cache entries do not expire merely because the project closes or the app restarts.

## 7. TwelveLabs facade and cache contract

One typed facade owns index creation, upload, status, native transcript retrieval, search, image search, analyze, summarize, and mapping. No route or tool calls the SDK directly outside the facade.

### Stable identity

- media content hash from file bytes, not path or mtime;
- provider operation;
- normalized query and exact parameters;
- asset/segment time domain;
- index/model/backend identifier;
- facade response schema version;
- preprocessing/version identifiers that affect output.

### Cache key

`sha256(canonical_json({contentHash, operation, params, model, backend, schemaVersion}))`

### Layers

1. in-memory LRU for the active process;
2. persistent project-brain cache for cross-session reuse;
3. per-key single-flight so simultaneous identical requests share one promise/future.

### Result rules

- Completed and deterministic empty results persist until content, parameters, model, backend, or schema version changes.
- Auth/unconfigured states make no provider call.
- Rate-limit entries honor `Retry-After` and prevent immediate repeated billing attempts.
- Network/5xx failures use short negative caching and may retry only after policy expiry.
- Explicit refresh creates a new observable request and does not happen silently.
- Cache payloads include provenance, created time, source operation, model, schema version, and content hash.
- Cache writes are atomic and concurrency-safe.
- UI and logs state `cache hit`, `cache miss`, `single-flight joined`, or `refresh`.

## 8. Orchestration contract

The run loop is:

1. normalize intent into measurable acceptance criteria;
2. inspect project/timeline and load required craft skills;
3. gather deterministic local evidence first;
4. automatically ensure semantic understanding only when needed;
5. plan candidates with citations;
6. propose one typed patch against a known revision;
7. convert every time to canonical frames;
8. validate atomically;
9. on rejection, emit the exact issue to model and user, then retry at most two bounded corrections;
10. apply idempotently or not at all;
11. render/inspect representative evidence;
12. run deterministic verification and critic checks;
13. rollback or propose correction if verification fails;
14. finish only when all committed plan tasks reconcile with the final state.

### Required failure behavior

- No-op/trivial patch against a mutation intent is a failure, not success.
- Partial operation batches do not apply unless the plan explicitly defines independent atomic groups.
- Cancellation rolls back the in-progress atomic group and leaves already committed groups grouped for one-click undo.
- A stale revision causes a visible conflict and re-plan, not false success.
- Every applied patch has a stable idempotency key and stored inverse.
- Guards remain enabled. Any guard change must be narrow, trace-proven, and separately reviewed.

## 9. Definition of a satisfying edit

A baseline result passes only when all applicable checks pass:

- the stated intent is reflected in the final timeline and playback;
- requested duration is within one frame when exact duration is feasible, otherwise the agent explains the nearest valid result before applying;
- no zero-length, negative, orphaned, or unintended overlapping clips;
- no speech cut through a retained word, with edit boundaries aligned to verified word boundaries;
- silence cuts preserve natural speech handles and do not create abrupt audio joins;
- transitions exist only at real boundaries and fit available handles;
- captions correspond to retained speech, do not span invalid cuts, and align to mapped words within one project frame after transcript timing is accepted;
- hook placement, pacing, and caption grouping follow the loaded editing skill and target platform;
- audio continuity is preserved and render validation reports no clipping or missing expected audio;
- preview and final render represent the same operation state;
- every operation is reversible and one Undo restores the pre-run state;
- the same fixed fixture, intent, provider/model configuration, cache state, and seed produce the same patch, or an equivalent patch that passes identical acceptance checks when the provider has no seed contract.

## 10. Sidebar event requirements

Add typed events or attachments for:

- tool queued/running/completed/failed/cancelled;
- cache lookup/hit/miss/join/refresh;
- external call with cost relevance and redacted provider metadata;
- visual evidence with frame/thumbnail URI or safe binary handle, timestamp, source asset/clip, range, backend, confidence, and timeline-jump target;
- validation rejection and correction attempt;
- applied operation summary linked to clip/range and Undo;
- blocking `ask_user` question and typed answer;
- long-running index progress and cancellation;
- terminal run verification.

`ask_user` answer state must store structured internal data and a separately generated, validated human summary, for example: `You chose a fast 20-second cut with captions.` The renderer never displays serialized payloads as fallback copy.

Visual evidence cards must:

- render the actual frame or representative segment thumbnail;
- label timestamp and source;
- seek/select on click;
- show loading, missing, offline, cached, and error states;
- avoid layout shift with reserved dimensions;
- remain virtualizable and memory-bounded;
- expose accessible names and keyboard activation.

## 11. Phase 0 completion gate

Phase 0 may be marked `[x]` only when:

- the desktop fixture and all five intents have been run;
- full traces and final timeline/render artifacts are committed or attached through an approved artifact path;
- each failure has a proven first divergence and root cause;
- the current tool inventory is generated and parity-checked;
- installed TwelveLabs SDK types and the real account capability are confirmed for every proposed facade method;
- provider/caption setting migrations are fully inventoried;
- conflicts above are reviewed;
- the implementation plan references each baseline failure by id.

Until then, implementation remains stopped.
